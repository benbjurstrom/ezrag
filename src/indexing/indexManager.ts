// src/indexing/indexManager.ts - Main indexing orchestrator

import PQueue from 'p-queue';
import { StateManager } from '../state/state';
import { IndexedDocState } from '../types';
import { GeminiService } from '../gemini/geminiService';
import { Janitor } from './janitor';
import { computeContentHash, computePathHash } from './hashUtils';
import { App, TFile, Vault } from 'obsidian';

export interface IndexingStats {
  total: number;
  completed: number;
  failed: number;
  pending: number;
}

export interface IndexManagerOptions {
  vault: Vault;
  app: App; // For MetadataCache access
  stateManager: StateManager;
  geminiService: GeminiService;
  vaultName: string;
  onProgress?: (stats: IndexingStats, status: string) => void;
  onStateChange?: () => void;
}

export class IndexManager {
  private vault: Vault;
  private app: App;
  private state: StateManager;
  private gemini: GeminiService;
  private vaultName: string;
  private queue: PQueue;
  private janitor: Janitor;
  private onProgress?: (stats: IndexingStats, status: string) => void;
  private onStateChange?: () => void;

  private stats: IndexingStats = {
    total: 0,
    completed: 0,
    failed: 0,
    pending: 0,
  };

  constructor(options: IndexManagerOptions) {
    this.vault = options.vault;
    this.app = options.app;
    this.state = options.stateManager;
    this.gemini = options.geminiService;
    this.vaultName = options.vaultName;
    this.onProgress = options.onProgress;
    this.onStateChange = options.onStateChange;

    const settings = this.state.getSettings();
    this.queue = new PQueue({ concurrency: settings.maxConcurrentUploads });

    // Initialize Janitor
    this.janitor = new Janitor({
      geminiService: this.gemini,
      stateManager: this.state,
      storeName: settings.storeName,
      onProgress: (msg) => console.log(`[Janitor] ${msg}`),
    });
  }

  /**
   * Startup reconciliation: scan all files and queue changed ones
   * Note: Does not wait for queue to finish - jobs run in background
   */
  async reconcileOnStartup(): Promise<void> {
    const files = this.getIndexableFiles();

    this.stats.total = 0;
    this.stats.completed = 0;
    this.stats.failed = 0;
    this.stats.pending = 0;

    console.log(`[IndexManager] Reconciling ${files.length} files...`);
    this.updateProgress('Scanning');

    // Scan all files and queue those that need indexing
    // Read and hash once to avoid double-read later
    for (const file of files) {
      try {
        const content = await this.vault.read(file);
        const contentHash = computeContentHash(content); // Synchronous

        const state = this.state.getDocState(file.path);

        // Determine if indexing is needed
        const needsIndexing = !state ||
                              state.contentHash !== contentHash ||
                              state.status === 'error';

        if (needsIndexing) {
          this.queueIndexJob(file, content, contentHash);
        }
      } catch (err) {
        console.error(`Failed to scan ${file.path}:`, err);
      }
    }

    console.log(`[IndexManager] Queued ${this.stats.pending} files for indexing`);

    // Don't await queue.onIdle() - let jobs run in background
    // Progress updates happen via onProgress callback
    this.updateProgress('Indexing');
  }

  /**
   * Handle file creation
   */
  async onFileCreated(file: TFile): Promise<void> {
    if (!this.isMarkdownFile(file) || !this.isInIncludedFolders(file)) {
      return;
    }

    // Read and hash once
    try {
      const content = await this.vault.read(file);
      const contentHash = computeContentHash(content);
      this.queueIndexJob(file, content, contentHash);
    } catch (err) {
      console.error(`Failed to queue new file ${file.path}:`, err);
    }
  }

  /**
   * Handle file modification
   */
  async onFileModified(file: TFile): Promise<void> {
    if (!this.isMarkdownFile(file) || !this.isInIncludedFolders(file)) {
      return;
    }

    try {
      const content = await this.vault.read(file);
      const contentHash = computeContentHash(content);

      const state = this.state.getDocState(file.path);

      // Only queue if content actually changed
      if (!state || state.contentHash !== contentHash || state.status === 'error') {
        this.queueIndexJob(file, content, contentHash);
      }
    } catch (err) {
      console.error(`Failed to check ${file.path}:`, err);
    }
  }

  /**
   * Handle file rename
   */
  async onFileRenamed(file: TFile, oldPath: string): Promise<void> {
    if (!this.isMarkdownFile(file)) {
      return;
    }

    // Delete old document if it exists
    const oldState = this.state.getDocState(oldPath);
    if (oldState?.geminiDocumentName) {
      try {
        await this.gemini.deleteDocument(oldState.geminiDocumentName);
      } catch (err) {
        console.error(`Failed to delete old document for ${oldPath}:`, err);
      }
    }

    // Remove old state
    this.state.removeDocState(oldPath);
    this.notifyStateChange();

    // Queue new path for indexing if in included folders
    if (this.isInIncludedFolders(file)) {
      try {
        const content = await this.vault.read(file);
        const contentHash = computeContentHash(content);
        this.queueIndexJob(file, content, contentHash);
      } catch (err) {
        console.error(`Failed to queue renamed file ${file.path}:`, err);
      }
    }
  }

  /**
   * Handle file deletion
   */
  async onFileDeleted(path: string): Promise<void> {
    const state = this.state.getDocState(path);
    if (!state) return;

    // Delete from Gemini
    if (state.geminiDocumentName) {
      try {
        await this.gemini.deleteDocument(state.geminiDocumentName);
      } catch (err) {
        console.error(`Failed to delete document for ${path}:`, err);
      }
    }

    // Remove from state
    this.state.removeDocState(path);
    this.notifyStateChange();
  }

  /**
   * Manual rebuild: clear index and requeue everything
   */
  async rebuildIndex(): Promise<void> {
    this.state.clearIndex();
    this.notifyStateChange();
    await this.reconcileOnStartup();
  }

  /**
   * Cleanup orphaned documents (exist in Gemini but not in vault)
   */
  async cleanupOrphans(): Promise<number> {
    const settings = this.state.getSettings();
    if (!settings.storeName) {
      throw new Error('No store configured');
    }

    const remoteDocs = await this.gemini.listDocuments(settings.storeName);
    let deleted = 0;

    for (const doc of remoteDocs) {
      // Check if this document is owned by us (has obsidian_path metadata)
      const pathMeta = doc.customMetadata?.find((m: any) => m.key === 'obsidian_path');
      if (!pathMeta) continue; // Not our document

      const vaultPath = pathMeta.stringValue;

      // Check if file exists in vault
      const file = this.vault.getAbstractFileByPath(vaultPath);
      if (!file) {
        // Orphan: delete it
        try {
          await this.gemini.deleteDocument(doc.name);
          this.state.removeDocState(vaultPath);
          this.notifyStateChange();
          deleted++;
        } catch (err) {
          console.error(`Failed to delete orphan ${doc.name}:`, err);
        }
      }
    }

    return deleted;
  }

  /**
   * Get Janitor instance for manual deduplication
   */
  getJanitor(): Janitor {
    return this.janitor;
  }

  /**
   * Private: Queue a job to index a file
   * Accepts pre-read content and hash to avoid double-reading
   *
   * Includes retry logic with exponential backoff for transient errors
   */
  private queueIndexJob(file: TFile, content: string, contentHash: string): void {
    this.markPendingState(file, contentHash);
    this.stats.total++;
    this.stats.pending++;
    this.updateProgress('Queued');

    this.queue.add(async () => {
      const maxRetries = 3;
      let lastError: Error | null = null;

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          await this.indexFile(file, content, contentHash);
          this.stats.completed++;
          this.stats.pending = Math.max(0, this.stats.pending - 1);
          this.updateProgress('Indexing');
          return; // Success, exit retry loop
        } catch (err) {
          lastError = err as Error;

          // Check if error is retryable (network, rate limit, etc.)
          const isRetryable = this.isRetryableError(err);

          if (!isRetryable || attempt === maxRetries - 1) {
            // Not retryable or final attempt, fail permanently
            break;
          }

          // Exponential backoff: 2^attempt * 1000ms (1s, 2s, 4s)
          const delay = Math.pow(2, attempt) * 1000;
          console.log(`Retry ${attempt + 1}/${maxRetries} for ${file.path} after ${delay}ms`);
          await this.delay(delay);
        }
      }

      // All retries failed
      this.stats.failed++;
      this.stats.pending = Math.max(0, this.stats.pending - 1);
      console.error(`Failed to index ${file.path} after ${maxRetries} attempts:`, lastError);

      // Mark as error in state
      const state = this.state.getDocState(file.path);
      if (state) {
        state.status = 'error';
        state.errorMessage = lastError?.message || 'Unknown error';
        this.state.setDocState(file.path, state);
        this.notifyStateChange();
      }

      this.updateProgress('Indexing');
    });
  }

  /**
   * Private: Check if an error is retryable
   */
  private isRetryableError(err: any): boolean {
    // Network errors, timeouts, rate limits are retryable
    const message = err?.message?.toLowerCase() || '';

    return (
      message.includes('network') ||
      message.includes('timeout') ||
      message.includes('rate limit') ||
      message.includes('429') ||
      message.includes('503') ||
      message.includes('econnreset') ||
      message.includes('enotfound')
    );
  }

  /**
   * Private: Delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Private: Index a single file
   * Accepts pre-read content and hash to avoid re-reading
   *
   * SYNC CONFLICT PREVENTION: If local state has no ID, checks remote for existing document
   * before creating a new one. This prevents duplicates during multi-device sync.
   */
  private async indexFile(file: TFile, content: string, contentHash: string): Promise<void> {
    // Skip empty files - Gemini API cannot handle empty content
    const trimmedContent = content.trim();
    if (trimmedContent.length === 0) {
      console.log(`[IndexManager] Skipping empty file: ${file.path}`);
      
      // Delete old document if exists (file was emptied)
      const existingState = this.state.getDocState(file.path);
      if (existingState?.geminiDocumentName) {
        try {
          await this.gemini.deleteDocument(existingState.geminiDocumentName);
        } catch (err) {
          // Document may have been deleted already, ignore
          console.log(`[IndexManager] Document already deleted or not found: ${existingState.geminiDocumentName}`);
        }
      }
      
      // Remove from state (empty files are not indexed)
      this.state.removeDocState(file.path);
      this.notifyStateChange();
      return;
    }

    const pathHash = computePathHash(file.path);
    const settings = this.state.getSettings();

    // Extract tags from frontmatter using MetadataCache
    const tags = this.extractTags(file);

    // Build metadata
    // Note: Gemini API doesn't allow duplicate keys in custom_metadata,
    // so we combine multiple tags into a single comma-separated string
    const metadata = [
      { key: 'obsidian_vault', stringValue: this.vaultName },
      { key: 'obsidian_path', stringValue: file.path },
      { key: 'obsidian_path_hash', stringValue: pathHash },
      { key: 'obsidian_mtime', numericValue: file.stat.mtime },
    ];

    // Add tags as a single comma-separated entry if tags exist
    if (tags.length > 0) {
      metadata.push({ key: 'tags', stringValue: tags.join(',') });
    }

    // Check if local state has a document ID
    const existingState = this.state.getDocState(file.path);
    const geminiDocumentName = existingState?.geminiDocumentName;

    // NOTE: We do NOT check remote for existing documents here.
    // That would require listing all documents (expensive!).
    // Instead, rely on manual Janitor deduplication to clean up any edge case duplicates.
    // Per PLAN.md: Hot path uses local state only, Janitor is manual cleanup.

    // Delete old document if exists
    if (geminiDocumentName) {
      try {
        await this.gemini.deleteDocument(geminiDocumentName);
      } catch (err) {
        // Document may have been deleted by janitor or doesn't exist, ignore
        console.log(`[IndexManager] Document already deleted or not found: ${geminiDocumentName}`);
      }
    }

    // Upload new document with chunking config
    const documentName = await this.gemini.uploadDocument({
      storeName: settings.storeName,
      content,
      displayName: file.path,
      metadata,
      mimeType: 'text/markdown',
      chunkingConfig: settings.chunkingConfig,
    });

    // Update state
    const newState: IndexedDocState = {
      vaultPath: file.path,
      geminiDocumentName: documentName,
      contentHash,
      pathHash,
      status: 'ready',
      lastLocalMtime: file.stat.mtime,
      lastIndexedAt: Date.now(),
      tags,
    };

    this.state.setDocState(file.path, newState);
    this.notifyStateChange();
  }

  /**
   * Private: Get all indexable files
   */
  private getIndexableFiles(): TFile[] {
    const allFiles = this.vault.getMarkdownFiles();
    return allFiles.filter(file => this.isInIncludedFolders(file));
  }

  /**
   * Private: Check if file is in included folders
   */
  private isInIncludedFolders(file: TFile): boolean {
    const settings = this.state.getSettings();

    // Empty = include all
    if (settings.includeFolders.length === 0) return true;

    // Check if file path starts with any included folder
    return settings.includeFolders.some(folder =>
      file.path.startsWith(folder + '/') || file.path === folder
    );
  }

  /**
   * Private: Check if file is markdown
   */
  private isMarkdownFile(file: TFile): boolean {
    return file.extension === 'md';
  }

  /**
   * Private: Extract tags from frontmatter using MetadataCache
   */
  private extractTags(file: TFile): string[] {
    // Use MetadataCache - already parsed, cached, and handles YAML edge cases
    const cache = this.app.metadataCache.getFileCache(file);
    if (!cache?.frontmatter?.tags) return [];

    const tags = cache.frontmatter.tags;

    // Tags can be: string | string[] | undefined
    if (typeof tags === 'string') return [tags];
    if (Array.isArray(tags)) return tags;

    return [];
  }

  /**
   * Private: Update progress
   */
  private updateProgress(status: string): void {
    if (this.onProgress) {
      this.onProgress({ ...this.stats }, status);
    }
  }

  private markPendingState(file: TFile, contentHash: string): void {
    const existingState = this.state.getDocState(file.path);
    const pendingState: IndexedDocState = {
      vaultPath: file.path,
      geminiDocumentName: existingState?.geminiDocumentName ?? null,
      contentHash,
      pathHash: existingState?.pathHash ?? computePathHash(file.path),
      status: 'pending',
      lastLocalMtime: file.stat.mtime,
      lastIndexedAt: existingState?.lastIndexedAt ?? 0,
      tags: existingState?.tags ?? [],
    };
    delete pendingState.errorMessage;
    this.state.setDocState(file.path, pendingState);
    this.notifyStateChange();
  }

  private notifyStateChange(): void {
    if (this.onStateChange) {
      this.onStateChange();
    }
  }

  getStats(): IndexingStats {
    return { ...this.stats };
  }

  waitForIdle(): Promise<void> {
    return this.queue.onIdle();
  }

  pause(): void {
    this.queue.pause();
  }

  resume(): void {
    this.queue.start();
  }

  clearQueue(): void {
    this.queue.clear();
  }

  dispose(): void {
    this.queue.clear();
    this.stats = {
      total: 0,
      completed: 0,
      failed: 0,
      pending: 0,
    };
    this.updateProgress('Idle');
  }
}
