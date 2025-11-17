// src/indexing/janitor.ts - Remote index cleanup: remove documents that don't match local state

import { GeminiService, CustomMetadataEntry } from '../gemini/geminiService';
import { StateManager } from '../state/state';

export interface JanitorStats {
  totalRemoteDocs: number;
  totalRemoved: number;
}

export interface JanitorOptions {
  geminiService: GeminiService;
  stateManager: StateManager;
  onProgress?: (update: JanitorProgressUpdate) => void;
}

export type JanitorPhase =
  | 'fetching'
  | 'analyzing'
  | 'deleting-duplicates'
  | 'deleting-orphans'
  | 'complete';

export interface JanitorProgressUpdate {
  phase: JanitorPhase;
  message: string;
  current?: number;
  total?: number;
}

export class Janitor {
  private gemini: GeminiService;
  private state: StateManager;
  private onProgress?: (update: JanitorProgressUpdate) => void;

  constructor(options: JanitorOptions) {
    this.gemini = options.geminiService;
    this.state = options.stateManager;
    this.onProgress = options.onProgress;
  }

  /**
   * Find existing document by pathHash
   *
   * WARNING: This is EXPENSIVE - it lists ALL documents from Gemini.
   * Should ONLY be used for debugging or one-off operations, NEVER in hot path.
   * For bulk operations, use runDeduplication() instead which lists once and caches.
   *
   * @deprecated - Removed from hot path. Use manual cleanup instead.
   */
  async findExistingDocument(pathHash: string): Promise<string | null> {
    try {
      const storeName = this.state.getSettings().storeName;
      const docs = await this.gemini.listDocuments(storeName);

      // Find document with matching obsidian_path_hash
      for (const doc of docs) {
        const pathHashMeta = this.getMetadataValue(doc.customMetadata, 'obsidian_path_hash');
        if (pathHashMeta === pathHash) {
          return doc.name;
        }
      }

      return null;
    } catch (err) {
      console.error('[Janitor] Failed to find existing document:', err);
      return null;
    }
  }

  /**
   * Clean up remote index: Find and remove documents that don't match local state
   *
   * This is run manually by the user via settings UI.
   * Uses local state as source of truth - deletes duplicates, orphans, and stale documents.
   */
  async runDeduplication(onProgress?: (update: JanitorProgressUpdate) => void): Promise<JanitorStats> {
    const stats: JanitorStats = {
      totalRemoteDocs: 0,
      totalRemoved: 0,
    };

    this.reportProgress({
      phase: 'fetching',
      message: 'Preparing cleanup…',
      current: 0,
    }, onProgress);

    const storeName = this.state.getSettings().storeName;
    let documentCount: number | undefined;
    try {
      const store = await this.gemini.getStore(storeName);
      documentCount = (store?.documentCount ?? store?.stats?.documentCount) as number | undefined;
    } catch (err) {
      console.warn('[Janitor] Unable to determine document count', err);
    }
    const expectedPages = documentCount ? Math.max(1, Math.ceil(documentCount / 20)) : undefined;

    // Fetch all documents from Gemini with page progress
    let fetchedPages = 0;
    const allDocs = await this.gemini.listDocuments(storeName, {
      onPage: ({ pageIndex, docs }) => {
        fetchedPages = pageIndex + 1;
        const message = expectedPages
          ? `Reading remote documents (${fetchedPages}/${expectedPages})`
          : `Reading remote documents (page ${fetchedPages})`;
        this.reportProgress(
          {
            phase: 'fetching',
            message,
            current: fetchedPages,
            total: expectedPages,
          },
          onProgress
        );
      },
    });
    stats.totalRemoteDocs = allDocs.length;

    // Build map: pathHash -> Document[]
    const docsByPathHash = new Map<string, any[]>();
    const noPathHashDocs: any[] = [];

    for (const doc of allDocs) {
      const pathHash = this.getMetadataValue(doc.customMetadata, 'obsidian_path_hash');
      if (!pathHash) {
        // No path hash means we can't reconcile - definitely orphan
        noPathHashDocs.push(doc);
        continue;
      }

      if (!docsByPathHash.has(pathHash)) {
        docsByPathHash.set(pathHash, []);
      }
      docsByPathHash.get(pathHash)!.push(doc);
    }

    // Collect documents to delete, using local state as source of truth
    const toDelete: any[] = [];
    let processedGroups = 0;
    const totalGroups = docsByPathHash.size;

    // Process each pathHash group
    for (const [pathHash, docs] of docsByPathHash) {
      processedGroups++;

      // Get vault path from first doc (all docs in group should have same path)
      const vaultPath = this.getMetadataValue(docs[0].customMetadata, 'obsidian_path');
      const localState = vaultPath ? this.state.getDocState(vaultPath) : undefined;

      if (localState && localState.pathHash === pathHash) {
        // Local state exists for this path - find the doc that matches
        const validDoc = docs.find(d => d.name === localState.geminiDocumentName);

        if (validDoc) {
          // This doc matches local state - all others are stale
          const staleOnes = docs.filter(d => d.name !== validDoc.name);
          toDelete.push(...staleOnes);
        } else {
          // Local state exists but doesn't match any doc - all are stale
          toDelete.push(...docs);
        }
      } else {
        // No local state or pathHash mismatch - all are stale
        toDelete.push(...docs);
      }

      // Progress update every 25 groups or at the end
      if (processedGroups % 25 === 0 || processedGroups === totalGroups) {
        this.reportProgress(
          {
            phase: 'analyzing',
            message: `Analyzing remote metadata (${processedGroups}/${totalGroups} groups)`,
            current: processedGroups,
            total: totalGroups,
          },
          onProgress
        );
      }
    }

    // Add docs without pathHash to stale list
    toDelete.push(...noPathHashDocs);

    // Delete all stale documents with progress
    if (toDelete.length > 0) {
      let completed = 0;
      for (const doc of toDelete) {
        completed++;
        this.reportProgress(
          {
            phase: 'deleting-duplicates',
            message: `Removing stale documents (${completed}/${toDelete.length})`,
            current: completed,
            total: toDelete.length,
          },
          onProgress
        );

        try {
          await this.gemini.deleteDocument(doc.name);
          stats.totalRemoved++;
        } catch (err) {
          console.error('[Janitor] Failed to delete stale document:', err);
        }
      }
    }

    this.reportProgress(
      {
        phase: 'complete',
        message: 'Cleanup complete',
        current: 1,
        total: 1,
      },
      onProgress
    );

    return stats;
  }

  /**
   * Extract metadata value from customMetadata array
   */
  private getMetadataValue(metadata: CustomMetadataEntry[] | undefined, key: string, type: 'string' | 'number' = 'string'): any {
    if (!metadata) return null;

    const entry = metadata.find(m => m.key === key);
    if (!entry) return null;

    if (type === 'string') {
      return entry.stringValue || null;
    } else {
      return entry.numericValue || null;
    }
  }

  private reportProgress(update: JanitorProgressUpdate, override?: (update: JanitorProgressUpdate) => void): void {
    override?.(update);
    this.onProgress?.(update);
  }
}
