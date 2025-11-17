// src/indexing/indexManager.ts - Main indexing orchestrator

import { App, TFile, Vault } from 'obsidian';
import { StateManager } from '../state/state';
import { IndexedDocState, IndexQueueEntry, IndexQueueOperation } from '../types';
import { GeminiService } from '../gemini/geminiService';
import { Janitor } from './janitor';
import { computePathHash } from './hashUtils';
import { ConnectionManager } from '../connection/connectionManager';
import { FilePreparationService, PreparedFile } from './filePreparationService';
import { buildDocumentMetadata } from './documentMetadata';
import { DocumentReplacer } from './documentReplacer';
import { PersistentQueue } from './persistentQueue';

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
  private janitor: Janitor;
  private onProgress?: (stats: IndexingStats, status: string) => void;
  private onStateChange?: () => void;
  private connectionManager: ConnectionManager;
  private filePreparation: FilePreparationService;
  private documentReplacer: DocumentReplacer;
  private queueManager: PersistentQueue;

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
    this.filePreparation = new FilePreparationService(this.vault, this.app);
    this.documentReplacer = new DocumentReplacer(this.gemini);

    const settings = this.state.getSettings();
    this.queueManager = new PersistentQueue({
      stateManager: this.state,
      connectionManager: this.connectionManager,
      maxConcurrency: settings.maxConcurrentUploads,
      processUpload: (entry) => this.processUploadEntry(entry),
      processDelete: (entry) => this.processDeleteEntry(entry),
      onEntrySuccess: (entry, removed) => {
        this.stats.completed++;
        if (removed) {
          this.stats.pending = Math.max(0, this.stats.pending - 1);
        }
        this.updateProgress('Indexing');
        this.notifyStateChange();
      },
      onEntryFailure: (entry, error, removed) => {
        this.stats.failed++;
        if (removed) {
          this.stats.pending = Math.max(0, this.stats.pending - 1);
        }
        if (entry.operation === 'upload' && removed) {
          this.markDocError(entry.vaultPath, error);
        }
        this.updateProgress('Indexing');
        this.notifyStateChange();
      },
      onStatus: (status) => this.updateProgress(status),
      onStateChange: () => this.notifyStateChange(),
    });

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
    this.queueManager.notifyQueueChanged();

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
        const preparation = await this.filePreparation.prepare(file);
        if (preparation.type === 'skip') {
          this.handleEmptyFile(file.path);
          continue;
        }

        const prepared = preparation.data;
        const { contentHash, pathHash, tags } = prepared;
        const state = this.state.getDocState(file.path);

        if (shouldSyncRemote && !state && remoteDocsByPathHash.has(pathHash)) {
          const remoteDoc = remoteDocsByPathHash.get(pathHash);
          const remoteHashMeta = remoteDoc.customMetadata?.find((m: any) => m.key === 'obsidian_content_hash');
          const remoteHash = remoteHashMeta?.stringValue;

          if (remoteHash === contentHash) {
            console.log(`[IndexManager] Restored state for ${file.path} from remote (hash match)`);
            this.state.setDocState(file.path, {
              vaultPath: file.path,
              geminiDocumentName: remoteDoc.name,
              contentHash,
              pathHash,
              status: 'ready',
              lastLocalMtime: file.stat.mtime,
              lastIndexedAt: Date.now(),
              tags,
            });
            continue;
          } else {
            console.log(`[IndexManager] Content changed for ${file.path}, will re-index`);
          }
        }

        const needsIndexing =
          !state ||
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
    this.queueManager.notifyQueueChanged();
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
      const preparation = await this.filePreparation.prepare(file);
      if (preparation.type === 'skip') {
        this.handleEmptyFile(file.path);
        return;
      }

      this.queueIndexJob(file, preparation.data.contentHash);
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
      const preparation = await this.filePreparation.prepare(file);
      if (preparation.type === 'skip') {
        this.handleEmptyFile(file.path);
        return;
      }
      const contentHash = preparation.data.contentHash;

      const state = this.state.getDocState(file.path);

      // Only queue if content actually changed
      // Apply throttle for modifications to batch rapid edits
      if (!state || state.contentHash !== contentHash || state.status === 'error') {
        this.queueIndexJob(file, contentHash, true);
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
    const removedEntries = this.state.removeQueueEntriesByPath(oldPath);
    if (removedEntries > 0) {
      this.stats.pending = Math.max(0, this.stats.pending - removedEntries);
      this.queueManager.notifyQueueChanged();
    }
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
        const preparation = await this.filePreparation.prepare(file);
        if (preparation.type === 'skip') {
          this.handleEmptyFile(file.path);
          return;
        }
        this.queueIndexJob(file, preparation.data.contentHash);
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
    const removedEntries = this.state.removeQueueEntriesByPath(path);
    if (removedEntries > 0) {
      this.stats.pending = Math.max(0, this.stats.pending - removedEntries);
      this.queueManager.notifyQueueChanged();
    }

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
   * @param file - The file to index
   * @param contentHash - The content hash
   * @param applyThrottle - Whether to apply uploadThrottleMs delay (default: false)
   *                        Only set to true for file modification events to batch rapid edits.
   *                        Bulk operations (reconcile, rebuild) should use false for immediate processing.
   *
   * Includes retry logic with exponential backoff for transient errors
   */
  private queueIndexJob(file: TFile, contentHash: string, applyThrottle: boolean = false): void {
    const existingEntry = this.state.findQueueEntryByPath(file.path);

    // Only apply throttle if explicitly requested (for file modifications)
    // Bulk operations (reconcile, rebuild) should process immediately
    const throttleMs = applyThrottle ? (this.state.getSettings().uploadThrottleMs ?? 0) : 0;
    const readyAt = throttleMs > 0 ? Date.now() + throttleMs : Date.now();
    const entry: IndexQueueEntry = {
      id: existingEntry?.id ?? this.generateQueueEntryId(),
      vaultPath: file.path,
      operation: 'upload',
      contentHash,
      enqueuedAt: Date.now(),
      attempts: 0,
      readyAt,
    };

    this.state.addOrUpdateQueueEntry(entry);
    if (!existingEntry) {
      this.stats.total++;
      this.stats.pending++;
    }

    this.markPendingState(file, contentHash);
    this.updateProgress('Queued');
    this.notifyStateChange();
    this.queueManager.notifyQueueChanged();
  }

  private queueDeleteJob(vaultPath: string, remoteId: string): void {
    const existingEntry = this.state.findQueueEntryByPath(vaultPath);
    const entry: IndexQueueEntry = {
      id: existingEntry?.id ?? this.generateQueueEntryId(),
      vaultPath,
      operation: 'delete',
      remoteId,
      enqueuedAt: Date.now(),
      attempts: 0,
      readyAt: Date.now(),
    };

    this.state.addOrUpdateQueueEntry(entry);
    if (!existingEntry) {
      this.stats.total++;
      this.stats.pending++;
    }

    this.updateProgress('Queued');
    this.notifyStateChange();
    this.queueManager.notifyQueueChanged();
  }

  private async processUploadEntry(entry: IndexQueueEntry): Promise<void> {
    const abstract = this.vault.getAbstractFileByPath(entry.vaultPath);
    if (!(abstract instanceof TFile)) {
      console.warn(`[IndexManager] File missing while processing queue: ${entry.vaultPath}`);
      this.state.removeDocState(entry.vaultPath);
      this.notifyStateChange();
      return;
    }

    const preparation = await this.filePreparation.prepare(abstract);
    if (preparation.type === 'skip') {
      this.handleEmptyFile(abstract.path);
      return;
    }

    await this.indexPreparedFile(preparation.data);
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

  private handleEmptyFile(vaultPath: string): void {
    console.log(`[IndexManager] Skipping empty file: ${vaultPath}`);
    const removedEntries = this.state.removeQueueEntriesByPath(vaultPath);
    if (removedEntries > 0) {
      this.stats.pending = Math.max(0, this.stats.pending - removedEntries);
    }

    const existingState = this.state.getDocState(vaultPath);
    if (existingState?.geminiDocumentName) {
      this.queueDeleteJob(vaultPath, existingState.geminiDocumentName);
    }

    this.state.removeDocState(vaultPath);
    this.notifyStateChange();
    this.queueManager.notifyQueueChanged();
  }

  /**
   * Private: Index a single file
   * Accepts pre-read content and hash to avoid re-reading
   *
   * SYNC CONFLICT PREVENTION: If local state has no ID, checks remote for existing document
   * before creating a new one. This prevents duplicates during multi-device sync.
   */
  private async indexPreparedFile(prepared: PreparedFile): Promise<void> {
    const { file, content, contentHash, pathHash, tags } = prepared;
    const settings = this.state.getSettings();
    const metadata = buildDocumentMetadata(prepared);
    const existingState = this.state.getDocState(file.path);

    const documentName = await this.documentReplacer.replaceDocument(existingState?.geminiDocumentName ?? null, {
      storeName: settings.storeName,
      content,
      displayName: file.path,
      metadata,
      chunkingConfig: settings.chunkingConfig,
      mimeType: 'text/markdown',
    });

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

  private isNotFoundError(err: any): boolean {
    const message = (err?.message ?? '').toLowerCase();
    if (!message) return false;
    return message.includes('404') || message.includes('not found');
  }

  getStats(): IndexingStats {
    return { ...this.stats };
  }

  waitForIdle(): Promise<void> {
    return this.queueManager.waitForIdle();
  }

  pause(): void {
    this.queueManager.pause();
  }

  resume(): void {
    this.queueManager.resume();
  }

  clearQueue(): void {
    this.queueManager.clear();

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
    this.queueManager.dispose();
    this.stats = {
      total: 0,
      completed: 0,
      failed: 0,
      pending: 0,
    };
    this.updateProgress('Idle');
  }
}
