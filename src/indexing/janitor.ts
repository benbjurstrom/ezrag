// src/indexing/janitor.ts - Deduplication and sync conflict resolution

import { GeminiService, CustomMetadataEntry } from '../gemini/geminiService';
import { StateManager } from '../state/state';

export interface JanitorStats {
  totalRemoteDocs: number;
  duplicatesFound: number;
  duplicatesDeleted: number;
  stateUpdated: number;
  orphansDeleted: number;
}

export interface JanitorOptions {
  geminiService: GeminiService;
  stateManager: StateManager;
  storeName: string;
  onProgress?: (message: string) => void;
}

export class Janitor {
  private gemini: GeminiService;
  private state: StateManager;
  private storeName: string;
  private onProgress?: (message: string) => void;

  constructor(options: JanitorOptions) {
    this.gemini = options.geminiService;
    this.state = options.stateManager;
    this.storeName = options.storeName;
    this.onProgress = options.onProgress;
  }

  /**
   * Find existing document by pathHash
   *
   * WARNING: This is EXPENSIVE - it lists ALL documents from Gemini.
   * Should ONLY be used for debugging or one-off operations, NEVER in hot path.
   * For bulk operations, use runDeduplication() instead which lists once and caches.
   *
   * @deprecated - Removed from hot path. Use manual deduplication instead.
   */
  async findExistingDocument(pathHash: string): Promise<string | null> {
    try {
      const docs = await this.gemini.listDocuments(this.storeName);

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
   * Manual deduplication: Find and remove duplicate documents
   *
   * This is run manually by the user via settings UI.
   * It finds all documents with the same pathHash and keeps only the newest one.
   */
  async runDeduplication(): Promise<JanitorStats> {
    const stats: JanitorStats = {
      totalRemoteDocs: 0,
      duplicatesFound: 0,
      duplicatesDeleted: 0,
      stateUpdated: 0,
      orphansDeleted: 0,
    };

    this.log('Starting deduplication...');

    // Fetch all documents from Gemini
    this.log('Fetching all documents from Gemini...');
    const allDocs = await this.gemini.listDocuments(this.storeName);
    stats.totalRemoteDocs = allDocs.length;
    this.log(`Found ${allDocs.length} documents`);

    // Build map: pathHash -> Document[]
    const docsByPathHash = new Map<string, any[]>();

    for (const doc of allDocs) {
      const pathHash = this.getMetadataValue(doc.customMetadata, 'obsidian_path_hash');
      if (!pathHash) {
        // Not our document (no obsidian_path_hash metadata)
        continue;
      }

      if (!docsByPathHash.has(pathHash)) {
        docsByPathHash.set(pathHash, []);
      }
      docsByPathHash.get(pathHash)!.push(doc);
    }

    // Process each pathHash group
    for (const [pathHash, docs] of docsByPathHash) {
      if (docs.length === 1) {
        // No duplicates, verify local state matches
        const doc = docs[0];
        const vaultPath = this.getMetadataValue(doc.customMetadata, 'obsidian_path');
        const localState = this.state.getDocState(vaultPath);

        // Update local state if it points to a different document
        if (!localState || localState.geminiDocumentName !== doc.name) {
          this.state.setDocState(vaultPath, {
            vaultPath,
            geminiDocumentName: doc.name,
            contentHash: '', // Will be updated on next change
            pathHash,
            status: 'ready',
            lastLocalMtime: this.getMetadataValue(doc.customMetadata, 'obsidian_mtime', 'number') || 0,
            lastIndexedAt: Date.now(),
            tags: [],
          });
          stats.stateUpdated++;
        }
      } else {
        // DUPLICATES FOUND!
        stats.duplicatesFound++;
        this.log(`Found ${docs.length} duplicates for pathHash ${pathHash.substring(0, 8)}...`);

        // Sort by mtime (descending) - keep newest
        docs.sort((a, b) => {
          const aTime = this.getMetadataValue(a.customMetadata, 'obsidian_mtime', 'number') || 0;
          const bTime = this.getMetadataValue(b.customMetadata, 'obsidian_mtime', 'number') || 0;
          return bTime - aTime;
        });

        const winner = docs[0];
        const losers = docs.slice(1);

        // Delete losers
        for (const loser of losers) {
          try {
            await this.gemini.deleteDocument(loser.name);
            stats.duplicatesDeleted++;
            this.log(`Deleted duplicate: ${loser.name}`);
          } catch (err) {
            console.error('[Janitor] Failed to delete duplicate:', err);
          }
        }

        // Update local state to point to winner
        const vaultPath = this.getMetadataValue(winner.customMetadata, 'obsidian_path');
        this.state.setDocState(vaultPath, {
          vaultPath,
          geminiDocumentName: winner.name,
          contentHash: '', // Will be updated on next change
          pathHash,
          status: 'ready',
          lastLocalMtime: this.getMetadataValue(winner.customMetadata, 'obsidian_mtime', 'number') || 0,
          lastIndexedAt: Date.now(),
          tags: [],
        });
        stats.stateUpdated++;
      }
    }

    this.log(`Deduplication complete: ${stats.duplicatesDeleted} duplicates deleted, ${stats.stateUpdated} state updates`);
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

  private log(message: string): void {
    if (this.onProgress) {
      this.onProgress(message);
    }
  }
}
