// src/indexing/indexManager.ts - Main indexing orchestrator

import PQueue from 'p-queue';
import { StateManager } from '../state/state';
import { IndexedDocState, IndexQueueEntry, IndexQueueOperation } from '../types';
import { GeminiService } from '../gemini/geminiService';
import { Janitor } from './janitor';
import { computeContentHash, computePathHash } from './hashUtils';
import { App, TFile, Vault } from 'obsidian';
import { ConnectionManager } from '../connection/connectionManager';

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
  connectionManager: ConnectionManager;
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
  private connectionManager: ConnectionManager;
  private processingEntries = new Set<string>();

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
    this.connectionManager = options.connectionManager;

    const settings = this.state.getSettings();
    this.queue = new PQueue({ concurrency: settings.maxConcurrentUploads });

    // Initialize Janitor
    this.janitor = new Janitor({
      geminiService: this.gemini,
      stateManager: this.state,
      storeName: settings.storeName,
      onProgress: (update) => {
        if (update.message) {
          console.log(`[Janitor] ${update.message}`);
        }
      },
    });

    const pendingEntries = this.state.getQueueEntries().length;
    if (pendingEntries > 0) {
      this.stats.total = pendingEntries;
      this.stats.pending = pendingEntries;
    }
  }

  /**
   * Startup reconciliation: scan all files and queue changed ones
   * Note: Does not wait for queue to finish - jobs run in background
   *
   * @param syncWithRemote - If true, fetches remote documents and reconciles local state
   *                         (used by rebuildIndex to avoid duplicates)
   */
  async reconcileOnStartup(syncWithRemote: boolean = false): Promise<void> {
    const files = this.getIndexableFiles();

    const pendingQueueCount = this.state.getQueueEntries().length;
    this.stats.total = pendingQueueCount;
    this.stats.completed = 0;
    this.stats.failed = 0;
    this.stats.pending = pendingQueueCount;

    console.log(`[IndexManager] Reconciling ${files.length} files...`);
    this.updateProgress('Scanning');
    this.tryProcessQueue();

    // If syncing with remote, fetch all remote docs first
    let remoteDocsByPathHash = new Map<string, any>();
    const shouldSyncRemote = syncWithRemote && this.connectionManager.isConnected();
    if (shouldSyncRemote) {
      console.log('[IndexManager] Fetching remote documents for smart reconciliation...');
      try {
        const settings = this.state.getSettings();
        const remoteDocs = await this.gemini.listDocuments(settings.storeName);

        for (const doc of remoteDocs) {
          const pathHashMeta = doc.customMetadata?.find((m: any) => m.key === 'obsidian_path_hash');
          if (pathHashMeta?.stringValue) {
            remoteDocsByPathHash.set(pathHashMeta.stringValue, doc);
          }
        }
        console.log(`[IndexManager] Found ${remoteDocsByPathHash.size} remote documents`);
      } catch (err) {
        console.error('[IndexManager] Failed to fetch remote docs, proceeding without sync:', err);
      }
    } else if (syncWithRemote && !this.connectionManager.isConnected()) {
      console.warn('[IndexManager] Cannot reconcile with remote while offline. Will resync later.');
    }

    // Scan all files and queue those that need indexing
    // Read and hash once to avoid double-read later
    for (const file of files) {
      try {
        const content = await this.vault.read(file);
        const contentHash = computeContentHash(content);
        const pathHash = computePathHash(file.path);

        const state = this.state.getDocState(file.path);

        // If syncing with remote, check if we can restore state from remote
        if (shouldSyncRemote && !state && remoteDocsByPathHash.has(pathHash)) {
          const remoteDoc = remoteDocsByPathHash.get(pathHash);
          const remoteHashMeta = remoteDoc.customMetadata?.find((m: any) => m.key === 'obsidian_content_hash');
          const remoteHash = remoteHashMeta?.stringValue;

          if (remoteHash === contentHash) {
            // Perfect match! Restore local state without re-uploading
            console.log(`[IndexManager] Restored state for ${file.path} from remote (hash match)`);
            this.state.setDocState(file.path, {
              vaultPath: file.path,
              geminiDocumentName: remoteDoc.name,
              contentHash,
              pathHash,
              status: 'ready',
              lastLocalMtime: file.stat.mtime,
              lastIndexedAt: Date.now(),
              tags: this.extractTags(file),
            });
            continue; // Skip indexing
          } else {
            // Hash mismatch, need to re-index
            console.log(`[IndexManager] Content changed for ${file.path}, will re-index`);
          }
        }

        // Determine if indexing is needed
        const needsIndexing = !state ||
                              state.contentHash !== contentHash ||
                              state.status === 'error';

        if (needsIndexing) {
          this.queueIndexJob(file, contentHash);
        }
      } catch (err) {
        console.error(`Failed to scan ${file.path}:`, err);
      }
    }

    console.log(`[IndexManager] Queue contains ${this.stats.pending} files for indexing`);

    this.updateProgress('Indexing');
    this.tryProcessQueue();
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
      this.queueIndexJob(file, contentHash);
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
        this.queueIndexJob(file, contentHash);
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

    // Drop any pending work for the old path
    this.state.removeQueueEntriesByPath(oldPath);
    this.notifyStateChange();

    const oldState = this.state.getDocState(oldPath);
    if (oldState) {
      if (oldState.geminiDocumentName) {
        this.queueDeleteJob(oldPath, oldState.geminiDocumentName);
      }
      this.state.removeDocState(oldPath);
      this.notifyStateChange();
    }

    // Queue new path for indexing if in included folders
    if (this.isInIncludedFolders(file)) {
      try {
        const content = await this.vault.read(file);
        const contentHash = computeContentHash(content);
        this.queueIndexJob(file, contentHash);
      } catch (err) {
        console.error(`Failed to queue renamed file ${file.path}:`, err);
      }
    }
  }

  /**
   * Handle file deletion
   */
  async onFileDeleted(path: string): Promise<void> {
    // Remove any pending work for this path
    this.state.removeQueueEntriesByPath(path);

    const state = this.state.getDocState(path);
    if (!state) {
      this.notifyStateChange();
      return;
    }

    const remoteId = state.geminiDocumentName;

    // Remove from local state immediately
    this.state.removeDocState(path);
    this.notifyStateChange();

    if (remoteId) {
      this.queueDeleteJob(path, remoteId);
    }
  }

  /**
   * Manual rebuild: clear local state and reconcile with remote
   * Uses smart reconciliation to avoid re-uploading unchanged documents
   */
  async rebuildIndex(): Promise<void> {
    this.state.clearIndex();
    this.notifyStateChange();
    await this.reconcileOnStartup(true); // syncWithRemote = true
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
   * Get Janitor instance for manual remote index cleanup
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
  private queueIndexJob(file: TFile, contentHash: string): void {
    const existingEntry = this.state.findQueueEntryByPath(file.path);
    const entry: IndexQueueEntry = {
      id: existingEntry?.id ?? this.generateQueueEntryId(),
      vaultPath: file.path,
      operation: 'upload',
      contentHash,
      enqueuedAt: existingEntry?.enqueuedAt ?? Date.now(),
      attempts: existingEntry?.attempts ?? 0,
      lastAttemptAt: existingEntry?.lastAttemptAt,
    };

    this.state.addOrUpdateQueueEntry(entry);
    if (!existingEntry) {
      this.stats.total++;
      this.stats.pending++;
    }

    this.markPendingState(file, contentHash);
    this.updateProgress('Queued');
    this.notifyStateChange();
    this.tryProcessQueue();
  }

  private queueDeleteJob(vaultPath: string, remoteId: string): void {
    const existingEntry = this.state.findQueueEntryByPath(vaultPath);
    const entry: IndexQueueEntry = {
      id: existingEntry?.id ?? this.generateQueueEntryId(),
      vaultPath,
      operation: 'delete',
      remoteId,
      enqueuedAt: existingEntry?.enqueuedAt ?? Date.now(),
      attempts: existingEntry?.attempts ?? 0,
      lastAttemptAt: existingEntry?.lastAttemptAt,
    };

    this.state.addOrUpdateQueueEntry(entry);
    if (!existingEntry) {
      this.stats.total++;
      this.stats.pending++;
    }

    this.updateProgress('Queued');
    this.notifyStateChange();
    this.tryProcessQueue();
  }

  private tryProcessQueue(): void {
    if (!this.connectionManager.isConnected() || this.queue.isPaused) {
      return;
    }

    const entries = this.state.getQueueEntries();
    for (const entry of entries) {
      if (this.processingEntries.has(entry.id)) {
        continue;
      }

      this.processingEntries.add(entry.id);
      this.queue
        .add(async () => {
          try {
            await this.processQueueEntry(entry);
          } finally {
            this.processingEntries.delete(entry.id);
          }
        })
        .catch((err) => {
          console.error('[IndexManager] Queue entry crashed', err);
        });
    }
  }

  private async processQueueEntry(entry: IndexQueueEntry): Promise<void> {
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (!this.connectionManager.isConnected()) {
        this.state.updateQueueEntry(entry.id, {
          lastAttemptAt: Date.now(),
          attempts: entry.attempts + attempt,
        });
        this.notifyStateChange();
        this.updateProgress('Waiting for connection');
        return;
      }

      try {
        if (entry.operation === 'upload') {
          await this.processUploadEntry(entry);
        } else {
          await this.processDeleteEntry(entry);
        }

        this.state.removeQueueEntry(entry.id);
        this.stats.completed++;
        this.stats.pending = Math.max(0, this.stats.pending - 1);
        this.updateProgress('Indexing');
        this.notifyStateChange();
        return;
      } catch (err) {
        lastError = err as Error;

        if (this.isAuthError(err)) {
          this.connectionManager.setApiKeyValid(false, 'Gemini rejected the API key. Please verify it in settings.');
          return;
        }

        const isRetryable = this.isRetryableError(err);
        if (!isRetryable || attempt === maxRetries - 1) {
          break;
        }

        const delay = Math.pow(2, attempt) * 1000;
        console.log(`Retry ${attempt + 1}/${maxRetries} for ${entry.vaultPath} after ${delay}ms`);
        await this.delay(delay);
      }
    }

    if (!this.connectionManager.isConnected()) {
      this.state.updateQueueEntry(entry.id, {
        lastAttemptAt: Date.now(),
        attempts: entry.attempts + 1,
      });
      this.notifyStateChange();
      this.updateProgress('Waiting for connection');
      return;
    }

    this.stats.failed++;
    this.stats.pending = Math.max(0, this.stats.pending - 1);

    if (entry.operation === 'upload') {
      this.markDocError(entry.vaultPath, lastError);
    }

    this.state.removeQueueEntry(entry.id);
    this.updateProgress('Indexing');
    this.notifyStateChange();
  }

  private async processUploadEntry(entry: IndexQueueEntry): Promise<void> {
    const abstract = this.vault.getAbstractFileByPath(entry.vaultPath);
    if (!(abstract instanceof TFile)) {
      console.warn(`[IndexManager] File missing while processing queue: ${entry.vaultPath}`);
      this.state.removeDocState(entry.vaultPath);
      this.notifyStateChange();
      return;
    }

    const content = await this.vault.read(abstract);
    const contentHash = computeContentHash(content);
    await this.indexFile(abstract, content, contentHash);
  }

  private async processDeleteEntry(entry: IndexQueueEntry): Promise<void> {
    if (!entry.remoteId) {
      console.warn('[IndexManager] Missing remote ID for delete job, skipping');
      return;
    }

    try {
      await this.gemini.deleteDocument(entry.remoteId);
    } catch (err) {
      if (!this.isNotFoundError(err)) {
        throw err;
      }
      console.log('[IndexManager] Remote document already deleted.');
    }
  }

  private markDocError(vaultPath: string, err: Error | null): void {
    const state = this.state.getDocState(vaultPath);
    if (!state) return;
    state.status = 'error';
    state.errorMessage = err?.message || 'Unknown error';
    this.state.setDocState(vaultPath, state);
    this.notifyStateChange();
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
      message.includes('enotfound') ||
      message.includes('failed to fetch') ||
      message.includes('offline')
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
      { key: 'obsidian_content_hash', stringValue: contentHash },
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
    // Instead, rely on manual Janitor cleanup to remove any edge case duplicates or stale documents.
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

  private generateQueueEntryId(): string {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return crypto.randomUUID();
    }
    return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
  }

  private isAuthError(err: any): boolean {
    const message = (err?.message ?? '').toLowerCase();
    if (!message) return false;
    return (
      message.includes('401') ||
      message.includes('403') ||
      message.includes('unauthorized') ||
      message.includes('api key')
    );
  }

  private isNotFoundError(err: any): boolean {
    const message = (err?.message ?? '').toLowerCase();
    if (!message) return false;
    return message.includes('404') || message.includes('not found');
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
    this.tryProcessQueue();
  }

  clearQueue(): void {
    this.queue.clear();
    this.processingEntries.clear();

    const pendingEntries = this.state.getQueueEntries();
    for (const entry of pendingEntries) {
      if (entry.operation === 'upload') {
        const doc = this.state.getDocState(entry.vaultPath);
        if (doc) {
          doc.status = 'error';
          doc.errorMessage = 'Cleared manually from queue';
          this.state.setDocState(entry.vaultPath, doc);
        }
      }
    }

    this.state.clearQueue();
    this.stats.pending = 0;
    this.updateProgress('Idle');
    this.notifyStateChange();
  }

  dispose(): void {
    this.queue.clear();
    this.processingEntries.clear();
    this.stats = {
      total: 0,
      completed: 0,
      failed: 0,
      pending: 0,
    };
    this.updateProgress('Idle');
  }
}
