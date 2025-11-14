# Implementation Plan: EzRAG Obsidian Plugin

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Module Structure](#3-module-structure)
4. [Data Models](#4-data-models)
5. [Implementation Phases](#5-implementation-phases)
6. [Detailed Component Design](#6-detailed-component-design)
7. [Code Examples](#7-code-examples)
8. [Implementation Caveats & Notes](#8-implementation-caveats--notes)
9. [Testing Strategy](#9-testing-strategy)
10. [Key Implementation Notes](#10-key-implementation-notes)
11. [Key Implementation Clarifications](#11-key-implementation-clarifications)
12. [Obsidian API Best Practices & Implementation Notes](#12-obsidian-api-best-practices--implementation-notes)
13. [Future Enhancements](#13-future-enhancements-post-mvp)
14. [Conclusion](#14-conclusion)

---

## 1. Overview

### Goals
Build an Obsidian plugin that:
1. Indexes selected notes into Google Gemini's File Search API
2. Keeps the index in sync with vault changes (create, edit, rename, delete)
3. Persists state across restarts for incremental indexing
4. Provides a chat interface to query indexed notes
5. Exposes an MCP server for external tools to query notes

### Key Design Principles
- **Vault-centric identity**: Use Obsidian paths as primary identifiers
- **Content-based change detection**: Use hashes to detect real changes
- **Delete-then-recreate semantics**: Work with Gemini's API constraints
- **Metadata-driven mapping**: Store identity in customMetadata, not displayName
- **Separation of concerns**: Keep Gemini/state logic independent of Obsidian APIs
- **Use Obsidian APIs correctly**: Leverage MetadataCache for frontmatter, prevent startup event flooding

---

## 2. Architecture

### High-Level Components

```
┌─────────────────────────────────────────────────────────────┐
│                     Obsidian Plugin                         │
│  ┌────────────┐  ┌──────────────┐  ┌────────────────────┐  │
│  │   Main     │  │   Settings   │  │  Chat Interface    │  │
│  │ (main.ts)  │  │      UI      │  │   (future Phase 3) │  │
│  └─────┬──────┘  └──────┬───────┘  └──────────┬─────────┘  │
│        │                │                     │             │
│  ┌─────▼────────────────▼─────────────────────▼─────────┐  │
│  │   Runner Check: isRunner() → Gate all indexing      │  │
│  └──────────────────────┬──────────────────────────────┘  │
│                         │ (if runner = true)               │
│  ┌──────────────────────▼──────────────────────────────┐  │
│  │          Indexing Engine (IndexManager)              │  │
│  │  • Queue management (p-queue)                        │  │
│  │  • Event handling (create/modify/rename/delete)      │  │
│  │  • Startup reconciliation                            │  │
│  │  • Progress tracking                                 │  │
│  └──────────────────────┬──────────────────────────────┘  │
│                         │                                  │
│  ┌──────────────────────▼──────────────────────────────┐  │
│  │         Gemini Service (geminiService.ts)           │  │
│  │  • Store discovery/creation                         │  │
│  │  • Document upload/delete (with pagination)         │  │
│  │  • File Search queries                              │  │
│  └──────────────────────┬──────────────────────────────┘  │
│                         │                                  │
│  ┌──────────────────────▼──────────────────────────────┐  │
│  │         State Manager (state.ts)                    │  │
│  │  • PersistedData management (synced via vault)     │  │
│  │  • IndexedDocState tracking                         │  │
│  │  • loadData/saveData wrapper                        │  │
│  └─────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│           Runner State (per-machine, non-synced)            │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  RunnerManager (runnerState.ts)                        │ │
│  │  • Stored outside vault (Obsidian config dir)         │ │
│  │  • Per-vault, per-machine isolation                   │ │
│  │  • isRunner flag + device metadata                    │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│              MCP Server (future Phase 4)                    │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  • Reads .obsidian/plugins/ezrag/data.json             │ │
│  │  • Exposes keywordSearch tool                          │ │
│  │  • Exposes semanticSearch tool (via Gemini)            │ │
│  │  • Shares geminiService.ts and state.ts                │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### Data Flow

**Indexing Flow (Hot Path - 99% of operations):**
```
User saves note → Vault event → Runner check: isRunner()?
                                    ↓ YES (runner machine)
                          Compute content hash
                                    ↓
                          Hash different? → Add to queue with retry logic
                                    ↓
                          Job executes:
                          1. Check if local state has document ID
                          2. If yes: Use it (hot path)
                          3. If no: Check remote for existing doc by pathHash (cold path)
                          4. Delete old doc if exists (use documents.get to verify)
                          5. Upload new doc with metadata
                          6. Poll until operation.done === true
                          7. Update IndexedDocState
                          8. Save state (syncs to other devices)
                                    ↓
                          [If error: Retry with exponential backoff (3 attempts)]
                                    ↓ NO (not runner)
                          Ignore event (no indexing)
```

**Janitor Flow (Manual deduplication only):**
```
User clicks "Run Deduplication" in settings → Runner check: isRunner()?
                          ↓ YES (runner machine)
                    Open JanitorProgressModal
                          ↓
                    List ALL documents from Gemini (with pagination)
                          ↓
                    Build Map<PathHash, Doc[]> in memory
                          ↓
                    For each pathHash group:
                      - 1 doc: Verify local state matches
                      - 2+ docs: DUPLICATE DETECTED
                          ↓ Sort by mtime (descending)
                          ↓ Keep newest
                          ↓ Delete older duplicates
                          ↓ Update local state to point to winner
                          ↓ Update progress modal
                          ↓
                    Save state if any changes
                          ↓
                    Show completion notice
                          ↓ NO (not runner)
                    Show error: "Not configured as runner"
```

**Query Flow (Chat):**
```
User query → Chat UI → geminiService.fileSearch()
                              ↓
                    Gemini API with FileSearch tool + metadata filters
                              ↓
                    Response with grounding chunks
                              ↓
                    UI displays answer + citations
```

---

## 3. Module Structure

```
src/
├── main.ts                  # Plugin entry point
├── types.ts                 # Shared TypeScript interfaces
├── runner/
│   └── runnerState.ts      # Per-machine runner configuration (non-synced)
├── state/
│   ├── state.ts            # State management (Obsidian-agnostic)
│   └── stateManager.ts     # Obsidian-specific wrapper
├── gemini/
│   ├── geminiService.ts    # Gemini API wrapper (Obsidian-agnostic)
│   └── types.ts            # Gemini-specific types
├── indexing/
│   ├── indexManager.ts     # Main indexing orchestrator
│   ├── janitor.ts          # Deduplication and sync conflict resolution
│   ├── queue.ts            # Job queue wrapper
│   ├── hashUtils.ts        # Content hashing utilities
│   └── reconciler.ts       # Startup reconciliation
├── ui/
│   ├── settingsTab.ts      # Settings UI
│   ├── statusBar.ts        # Status bar component
│   ├── progressView.ts     # Initial indexing progress view
│   ├── janitorProgressModal.ts  # Deduplication progress UI
│   └── chatView.ts         # Chat interface (Phase 3)
├── mcp/
│   └── server.ts           # MCP server (Phase 4)
└── utils/
    ├── logger.ts           # Logging utility
    └── metadata.ts         # Metadata builder
```

---

## 4. Data Models

### PersistedData (state.ts)

```typescript
export interface PersistedData {
  version: number;
  settings: PluginSettings;
  index: IndexState;
}

export interface PluginSettings {
  apiKey: string;
  storeName: string; // Resource ID of the FileSearchStore
  storeDisplayName: string; // Human-readable name (vault name)
  includeFolders: string[]; // Empty = whole vault
  maxConcurrentUploads: number; // Default: 2
  chunkingConfig: ChunkingConfig; // Global chunking strategy
}

export interface ChunkingConfig {
  maxTokensPerChunk: number; // Default: 400
  maxOverlapTokens: number; // Default: 50
}

export interface IndexState {
  docs: Record<string, IndexedDocState>; // Key: vaultPath
}

export interface IndexedDocState {
  vaultPath: string; // e.g., "Projects/Notes.md"
  geminiDocumentName: string | null; // e.g., "fileSearchStores/.../documents/..." (null if not yet uploaded)
  contentHash: string; // SHA-256 of file content
  pathHash: string; // SHA-256 of vaultPath (stable ID for metadata)
  status: 'pending' | 'ready' | 'error';
  lastLocalMtime: number; // File modification time
  lastIndexedAt: number; // When we last indexed
  tags: string[]; // Extracted from frontmatter
  errorMessage?: string;
}
```

### Gemini Document Metadata

When uploading a document, we'll attach this metadata:

```typescript
interface DocumentMetadata {
  obsidian_vault: string;      // Vault name
  obsidian_path: string;        // Full vault path
  obsidian_path_hash: string;   // Hash of path (stable ID)
  tag: string[];                // Tags from frontmatter (multiple entries)
  obsidian_mtime: number;       // Last modified time
}
```

**Example:**
```json
{
  "customMetadata": [
    { "key": "obsidian_vault", "stringValue": "MyVault" },
    { "key": "obsidian_path", "stringValue": "Projects/Client/Notes.md" },
    { "key": "obsidian_path_hash", "stringValue": "a3f5..." },
    { "key": "tag", "stringValue": "project" },
    { "key": "tag", "stringValue": "client" },
    { "key": "obsidian_mtime", "numericValue": 1699564800 }
  ]
}
```

---

## 5. Implementation Phases

### Phase 1: Core Infrastructure (Week 1)
- [x] Project setup (already done: p-queue, @google/genai, MCP SDK)
- [ ] State management (`state.ts`, `stateManager.ts`)
- [ ] Runner state management (`runnerState.ts`) - **Desktop only**
- [ ] Gemini service (`geminiService.ts`)
- [ ] Hash utilities (`hashUtils.ts`)
- [ ] Basic settings UI (API key input + runner toggle)
- [ ] Store discovery/creation

**Deliverable:** Can create a store, persist basic settings, and configure runner (desktop only)

**IMPORTANT:** Plugin works on both desktop and mobile, but runner (indexing) only available on desktop due to Node.js dependencies in RunnerManager

### Phase 2: Indexing Engine (Week 2)
- [ ] Index manager (`indexManager.ts`)
- [ ] Queue implementation (`queue.ts`)
- [ ] Event handlers (create, modify, rename, delete)
- [ ] Startup reconciliation (`reconciler.ts`)
- [ ] Progress tracking in status bar
- [ ] Manual commands (rebuild index, cleanup orphans)

**Deliverable:** Plugin indexes notes and keeps them in sync

### Phase 3: Chat Interface (Week 3)
- [ ] Chat view UI (`chatView.ts`)
- [ ] Query interface to Gemini FileSearch
- [ ] Citation rendering
- [ ] Chat history management

**Deliverable:** Users can chat with their indexed notes

### Phase 4: MCP Server (Week 4)
- [ ] Standalone MCP server (`mcp/server.ts`)
- [ ] Tool: `keywordSearch` (local file search)
- [ ] Tool: `semanticSearch` (Gemini FileSearch)
- [ ] Resource: `note` (read note content by path)

**Deliverable:** External tools (Claude Code, etc.) can query vault

---

## 6. Detailed Component Design

### 6.1 Hash Utilities (`hashUtils.ts`)

**Desktop-only** - Uses Node.js crypto for synchronous, performant hashing.

Since all hashing is used for indexing operations (which only run on the runner machine, which is desktop-only), we can use Node.js crypto throughout for simplicity and performance.

```typescript
// src/indexing/hashUtils.ts
import * as crypto from 'crypto';

/**
 * Compute SHA-256 hash of content
 *
 * Uses Node.js crypto (synchronous) instead of Web Crypto (async).
 * This is simpler and more performant.
 *
 * Since hashing is only used during indexing (runner-only, desktop-only),
 * we don't need to support mobile/browser environments.
 */
export function computeContentHash(content: string): string {
  return crypto
    .createHash('sha256')
    .update(content)
    .digest('hex');
}

/**
 * Compute SHA-256 hash of path
 */
export function computePathHash(path: string): string {
  return crypto
    .createHash('sha256')
    .update(path)
    .digest('hex');
}
```

**Benefits of Node.js crypto:**
- ✅ **Synchronous**: No async/await needed, simplifies code
- ✅ **Faster**: Native implementation, more efficient
- ✅ **Simpler**: Single import, consistent API
- ✅ **Desktop-only is fine**: Hashing only happens during indexing (runner-only)

**Usage pattern:**
```typescript
// Before (async, Web Crypto)
const hash = await computeContentHash(content); // slow, complex

// After (sync, Node crypto)
const hash = computeContentHash(content); // fast, simple
```

---

### 6.2 State Management (`state.ts`)

**Obsidian-agnostic** - can be used by both plugin and MCP server.

```typescript
// src/state/state.ts

export interface PersistedData {
  version: number;
  settings: PluginSettings;
  index: IndexState;
}

export interface PluginSettings {
  apiKey: string;
  storeName: string;
  storeDisplayName: string;
  includeFolders: string[];
  maxConcurrentUploads: number;
  chunkingConfig: ChunkingConfig;
}

export interface ChunkingConfig {
  maxTokensPerChunk: number;
  maxOverlapTokens: number;
}

export interface IndexState {
  docs: Record<string, IndexedDocState>;
}

export interface IndexedDocState {
  vaultPath: string;
  geminiDocumentName: string | null;
  contentHash: string;
  pathHash: string;
  status: 'pending' | 'ready' | 'error';
  lastLocalMtime: number;
  lastIndexedAt: number;
  tags: string[];
  errorMessage?: string;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  apiKey: '',
  storeName: '',
  storeDisplayName: '',
  includeFolders: [],
  maxConcurrentUploads: 2,
  chunkingConfig: {
    maxTokensPerChunk: 400,
    maxOverlapTokens: 50,
  },
};

export const DEFAULT_DATA: PersistedData = {
  version: 1,
  settings: DEFAULT_SETTINGS,
  index: { docs: {} },
};

export class StateManager {
  private data: PersistedData;

  constructor(initialData?: Partial<PersistedData>) {
    this.data = { ...DEFAULT_DATA, ...initialData };
  }

  getSettings(): PluginSettings {
    return this.data.settings;
  }

  updateSettings(updates: Partial<PluginSettings>): void {
    this.data.settings = { ...this.data.settings, ...updates };
  }

  getDocState(vaultPath: string): IndexedDocState | undefined {
    return this.data.index.docs[vaultPath];
  }

  setDocState(vaultPath: string, state: IndexedDocState): void {
    this.data.index.docs[vaultPath] = state;
  }

  removeDocState(vaultPath: string): void {
    delete this.data.index.docs[vaultPath];
  }

  getAllDocStates(): Record<string, IndexedDocState> {
    return this.data.index.docs;
  }

  clearIndex(): void {
    this.data.index.docs = {};
  }

  exportData(): PersistedData {
    return structuredClone(this.data);
  }
}
```

### 6.3 Gemini Service (`geminiService.ts`)

**Obsidian-agnostic** - can be used by both plugin and MCP server.

```typescript
// src/gemini/geminiService.ts
import { GoogleGenAI } from '@google/genai';

export interface CustomMetadataEntry {
  key: string;
  stringValue?: string;
  numericValue?: number;
}

export interface UploadDocumentParams {
  storeName: string;
  content: string;
  displayName: string;
  metadata: CustomMetadataEntry[];
  mimeType?: string;
  chunkingConfig?: ChunkingConfig;
}

export interface ChunkingConfig {
  maxTokensPerChunk: number;
  maxOverlapTokens: number;
}

export interface FileSearchResult {
  text: string;
  groundingChunks: any[];
}

export class GeminiService {
  private ai: GoogleGenAI;

  constructor(apiKey: string) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  /**
   * Find or create a FileSearchStore by display name
   */
  async getOrCreateStore(displayName: string): Promise<string> {
    // List all stores
    const stores = await this.ai.fileSearchStores.list();

    // Find matching store by displayName
    for await (const store of stores) {
      if (store.displayName === displayName) {
        return store.name!;
      }
    }

    // Create new store if not found
    const newStore = await this.ai.fileSearchStores.create({
      config: { displayName }
    });

    return newStore.name!;
  }

  /**
   * Upload a document to a FileSearchStore
   * Creates a temporary File, converts content to blob
   * NOTE: Upload is considered complete when operation.done === true
   * AND the document state is STATE_ACTIVE (or STATE_FAILED)
   */
  async uploadDocument(params: UploadDocumentParams): Promise<string> {
    const { storeName, content, displayName, metadata, mimeType = 'text/markdown', chunkingConfig } = params;

    // Convert content to a File-like object
    const blob = new Blob([content], { type: mimeType });
    const file = new File([blob], displayName, { type: mimeType });

    // Build config with optional chunking
    const config: any = {
      displayName,
      customMetadata: metadata,
      mimeType,
    };

    if (chunkingConfig) {
      config.chunkingConfig = {
        whiteSpaceConfig: {
          maxTokensPerChunk: chunkingConfig.maxTokensPerChunk,
          maxOverlapTokens: chunkingConfig.maxOverlapTokens,
        }
      };
    }

    // Upload to FileSearchStore
    let operation = await this.ai.fileSearchStores.uploadToFileSearchStore({
      fileSearchStoreName: storeName,
      file,
      config,
    });

    // Poll until complete
    while (!operation.done) {
      await this.delay(3000);
      operation = await this.ai.operations.get({ operation });
    }

    // Extract document name from operation response
    if (operation.response?.['@type']?.includes('Document')) {
      return operation.response.name as string;
    }

    throw new Error('Upload failed: no document name in response');
  }

  /**
   * Delete a document from a FileSearchStore
   */
  async deleteDocument(documentName: string): Promise<void> {
    await this.ai.fileSearchStores.documents.delete({
      name: documentName,
      config: { force: true }
    });
  }

  /**
   * List all documents in a store
   *
   * IMPORTANT: Handles pagination properly. The API has a maximum page size of 20 documents.
   * For vaults with 1,000+ notes, this will make 50+ API calls to fetch all documents.
   *
   * Performance: Fetching 5,000 documents (250 pages) takes ~10-15 seconds.
   * This is still much faster than 5,000 individual documents.get() calls.
   */
  async listDocuments(storeName: string): Promise<any[]> {
    const docs: any[] = [];
    let pageToken: string | undefined = undefined;

    do {
      const response = await this.ai.fileSearchStores.documents.list({
        parent: storeName,
        config: {
          pageSize: 20, // Maximum allowed by API
          pageToken: pageToken
        }
      });

      // Collect documents from this page
      for await (const doc of response) {
        docs.push(doc);
      }

      // Get next page token (if any)
      // Note: SDK may expose nextPageToken differently, adjust as needed
      pageToken = response.nextPageToken;

    } while (pageToken);

    return docs;
  }

  /**
   * Query the FileSearchStore
   */
  async fileSearch(storeName: string, query: string): Promise<FileSearchResult> {
    const response = await this.ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: query,
      config: {
        tools: [
          {
            fileSearch: {
              fileSearchStoreNames: [storeName]
            }
          }
        ]
      }
    });

    const groundingChunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];

    return {
      text: response.text || '',
      groundingChunks
    };
  }

  /**
   * Get FileSearchStore details (including stats)
   */
  async getStore(storeName: string): Promise<any> {
    return await this.ai.fileSearchStores.get({
      name: storeName
    });
  }

  /**
   * List all FileSearchStores for this API key
   */
  async listStores(): Promise<any[]> {
    const stores: any[] = [];
    const response = await this.ai.fileSearchStores.list();

    for await (const store of response) {
      stores.push(store);
    }

    return stores;
  }

  /**
   * Delete a FileSearchStore
   */
  async deleteStore(storeName: string): Promise<void> {
    await this.ai.fileSearchStores.delete({
      name: storeName,
      config: { force: true }
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
```

### 6.4 Index Manager (`indexManager.ts`)

Orchestrates all indexing operations.

```typescript
// src/indexing/indexManager.ts
import PQueue from 'p-queue';
import { StateManager, IndexedDocState, computeContentHash, computePathHash } from '../state/state';
import { GeminiService } from '../gemini/geminiService';
import { App, TFile, Vault } from 'obsidian';

export interface IndexManagerOptions {
  vault: Vault;
  app: App; // For MetadataCache access
  stateManager: StateManager;
  geminiService: GeminiService;
  vaultName: string;
  onProgress?: (current: number, total: number, status: string) => void;
}

export class IndexManager {
  private vault: Vault;
  private app: App;
  private state: StateManager;
  private gemini: GeminiService;
  private vaultName: string;
  private queue: PQueue;
  private janitor: Janitor;
  private onProgress?: (current: number, total: number, status: string) => void;

  private stats = {
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

    this.stats.total = files.length;
    this.stats.completed = 0;
    this.stats.failed = 0;
    this.stats.pending = 0;

    // Scan all files and queue those that need indexing
    // Read and hash once to avoid double-read later
    for (const file of files) {
      try {
        const content = await this.vault.read(file);
        const contentHash = computeContentHash(content); // Synchronous now

        const state = this.state.getDocState(file.path);

        // Determine if indexing is needed
        const needsIndexing = !state ||
                              state.contentHash !== contentHash ||
                              state.status === 'error';

        if (needsIndexing) {
          this.stats.pending++;
          this.queueIndexJob(file, content, contentHash);
        }
      } catch (err) {
        console.error(`Failed to scan ${file.path}:`, err);
      }
    }

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
      const contentHash = computeContentHash(content); // Synchronous now
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
      const contentHash = computeContentHash(content); // Synchronous now

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

    // Queue new path for indexing if in included folders
    if (this.isInIncludedFolders(file)) {
      this.queueIndexJob(file);
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
  }

  /**
   * Manual rebuild: clear index and requeue everything
   */
  async rebuildIndex(): Promise<void> {
    this.state.clearIndex();
    await this.reconcileOnStartup();
  }

  /**
   * Cleanup orphaned documents (exist in Gemini but not in vault)
   */
  async cleanupOrphans(): Promise<void> {
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
          deleted++;
        } catch (err) {
          console.error(`Failed to delete orphan ${doc.name}:`, err);
        }
      }
    }

    return deleted;
  }

  /**
   * Private: Queue a job to index a file
   * Accepts pre-read content and hash to avoid double-reading
   *
   * Includes retry logic with exponential backoff for transient errors
   */
  private queueIndexJob(file: TFile, content: string, contentHash: string): void {
    this.queue.add(async () => {
      const maxRetries = 3;
      let lastError: Error | null = null;

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          await this.indexFile(file, content, contentHash);
          this.stats.completed++;
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
      console.error(`Failed to index ${file.path} after ${maxRetries} attempts:`, lastError);

      // Mark as error in state
      const state = this.state.getDocState(file.path);
      if (state) {
        state.status = 'error';
        state.errorMessage = lastError?.message || 'Unknown error';
        this.state.setDocState(file.path, state);
      }

      this.stats.pending--;
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
    const pathHash = computePathHash(file.path); // Synchronous now
    const settings = this.state.getSettings();

    // Extract tags from frontmatter using MetadataCache
    const tags = this.extractTags(file);

    // Build metadata
    const metadata = [
      { key: 'obsidian_vault', stringValue: this.vaultName },
      { key: 'obsidian_path', stringValue: file.path },
      { key: 'obsidian_path_hash', stringValue: pathHash },
      { key: 'obsidian_mtime', numericValue: file.stat.mtime },
      ...tags.map(tag => ({ key: 'tag', stringValue: tag })),
    ];

    // Check if local state has a document ID
    const existingState = this.state.getDocState(file.path);
    let geminiDocumentName = existingState?.geminiDocumentName;

    // SYNC CONFLICT PREVENTION: If no local ID, check if remote document exists
    if (!geminiDocumentName) {
      geminiDocumentName = await this.janitor.findExistingDocument(pathHash);

      if (geminiDocumentName) {
        // Remote document exists! This is a stale local state situation.
        // Adopt the remote ID instead of creating a duplicate.
        console.log(`[IndexManager] Adopting existing document for ${file.path}: ${geminiDocumentName}`);
      }
    }

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
      this.onProgress(this.stats.completed, this.stats.total, status);
    }
  }
}
```

### 6.4 Settings UI (`settingsTab.ts`)

```typescript
// src/ui/settingsTab.ts
import { App, Platform, PluginSettingTab, Setting } from 'obsidian';
import EzRAGPlugin from '../main';

export class EzRAGSettingTab extends PluginSettingTab {
  plugin: EzRAGPlugin;

  constructor(app: App, plugin: EzRAGPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'EzRAG Settings' });

    // Runner Configuration Section (Desktop only)
    if (Platform.isDesktopApp) {
      containerEl.createEl('h3', { text: 'Runner Configuration' });

      const runnerConfig = this.plugin.runnerManager.getConfig();
      const isRunner = runnerConfig.isRunner;

      new Setting(containerEl)
        .setName('This machine is the runner')
        .setDesc(
          'Enable indexing on this machine. Only ONE machine per vault should be the runner. ' +
          (runnerConfig.deviceName ? `Currently: ${runnerConfig.deviceName}` : '')
        )
        .addToggle(toggle => toggle
          .setValue(isRunner)
          .onChange(async (value) => {
            await this.plugin.runnerManager.setRunner(value);

            // If enabling runner, initialize services
            if (value && this.plugin.stateManager.getSettings().apiKey) {
            await this.plugin.initializeServices();
          }

          // If disabling runner, clear services
          if (!value) {
            this.plugin.indexManager = null;
            this.plugin.geminiService = null;
          }

          // Refresh settings display
          this.display();

          new Notice(
            value
              ? 'This machine is now the runner. Indexing will start automatically.'
              : 'Runner disabled. This machine will no longer index files.'
          );
        })
      );

      // If not runner, show message and hide remaining settings
      if (!isRunner) {
        containerEl.createDiv({
          cls: 'setting-item-description',
          text: 'Indexing controls are hidden because this machine is not the runner. ' +
                'Enable "This machine is the runner" above to access indexing settings.'
        });
        return; // Early return - hide all other settings
      }

      // Separator
      containerEl.createEl('hr');
    } else {
      // Mobile platform - runner not available
      containerEl.createEl('h3', { text: 'Mobile Platform' });
      containerEl.createDiv({
        cls: 'setting-item-description',
        text: 'Indexing is not available on mobile devices. The runner can only be enabled on desktop. ' +
              'You can still use chat and query features once they are implemented.'
      });
      return; // Early return - no indexing settings on mobile
    }

    // API Key Section
    containerEl.createEl('h3', { text: 'API Configuration' });

    new Setting(containerEl)
      .setName('Gemini API Key')
      .setDesc('Your Google Gemini API key (get it from ai.google.dev)')
      .addText(text => text
        .setPlaceholder('Enter your API key')
        .setValue(this.plugin.stateManager.getSettings().apiKey)
        .onChange(async (value) => {
          this.plugin.stateManager.updateSettings({ apiKey: value });
          await this.plugin.saveState();

          // Re-initialize services if runner
          if (isRunner && value) {
            await this.plugin.initializeServices();
          }
        })
      );

    // Included Folders
    new Setting(containerEl)
      .setName('Included Folders')
      .setDesc('Comma-separated list of folders to index (empty = entire vault)')
      .addText(text => text
        .setPlaceholder('e.g., Projects, Notes')
        .setValue(this.plugin.stateManager.getSettings().includeFolders.join(', '))
        .onChange(async (value) => {
          const folders = value.split(',').map(f => f.trim()).filter(Boolean);
          this.plugin.stateManager.updateSettings({ includeFolders: folders });
          await this.plugin.saveState();
        })
      );

    // Concurrency
    new Setting(containerEl)
      .setName('Upload Concurrency')
      .setDesc('Number of concurrent uploads (1-5). Each upload polls until complete.')
      .addSlider(slider => slider
        .setLimits(1, 5, 1)
        .setValue(this.plugin.stateManager.getSettings().maxConcurrentUploads)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.stateManager.updateSettings({ maxConcurrentUploads: value });
          await this.plugin.saveState();
        })
      );

    // Chunking Configuration Section
    containerEl.createEl('h3', { text: 'Chunking Strategy' });

    new Setting(containerEl)
      .setName('Max Tokens Per Chunk')
      .setDesc('Maximum number of tokens in each chunk (100-1000)')
      .addSlider(slider => slider
        .setLimits(100, 1000, 50)
        .setValue(this.plugin.stateManager.getSettings().chunkingConfig.maxTokensPerChunk)
        .setDynamicTooltip()
        .onChange(async (value) => {
          const config = this.plugin.stateManager.getSettings().chunkingConfig;
          this.plugin.stateManager.updateSettings({
            chunkingConfig: { ...config, maxTokensPerChunk: value }
          });
          await this.plugin.saveState();
        })
      );

    new Setting(containerEl)
      .setName('Max Overlap Tokens')
      .setDesc('Number of overlapping tokens between chunks (0-200)')
      .addSlider(slider => slider
        .setLimits(0, 200, 10)
        .setValue(this.plugin.stateManager.getSettings().chunkingConfig.maxOverlapTokens)
        .setDynamicTooltip()
        .onChange(async (value) => {
          const config = this.plugin.stateManager.getSettings().chunkingConfig;
          this.plugin.stateManager.updateSettings({
            chunkingConfig: { ...config, maxOverlapTokens: value }
          });
          await this.plugin.saveState();
        })
      );

    // Manual Commands Section
    containerEl.createEl('h3', { text: 'Manual Actions' });

    // Rebuild Index
    new Setting(containerEl)
      .setName('Rebuild Index')
      .setDesc('Clear local index and re-index all files')
      .addButton(button => button
        .setButtonText('Rebuild')
        .onClick(async () => {
          await this.plugin.rebuildIndex();
        })
      );

    // Run Deduplication (Manual Janitor)
    new Setting(containerEl)
      .setName('Run Deduplication')
      .setDesc('Find and remove duplicate documents created by multi-device sync conflicts')
      .addButton(button => button
        .setButtonText('Run Deduplication')
        .onClick(async () => {
          await this.plugin.runJanitorWithUI();
        })
      );

    // Store Management Section
    containerEl.createEl('h3', { text: 'Store Management' });

    // Current Store Stats
    new Setting(containerEl)
      .setName('Current Store Stats')
      .setDesc('View statistics for the current vault\'s FileSearchStore')
      .addButton(button => button
        .setButtonText('View Stats')
        .onClick(async () => {
          await this.plugin.showStoreStats();
        })
      );

    // List All Stores
    new Setting(containerEl)
      .setName('List All Stores')
      .setDesc('View all FileSearchStores associated with this API key')
      .addButton(button => button
        .setButtonText('List Stores')
        .onClick(async () => {
          await this.plugin.listAllStores();
        })
      );

    // Delete Current Store
    new Setting(containerEl)
      .setName('Delete Current Store')
      .setDesc('Permanently delete the FileSearchStore for this vault (cannot be undone!)')
      .addButton(button => button
        .setButtonText('Delete Store')
        .setWarning()
        .onClick(async () => {
          await this.plugin.deleteCurrentStore();
        })
      );

    // Status Display
    containerEl.createEl('h3', { text: 'Index Status' });

    const stats = this.plugin.getIndexStats();
    const statusEl = containerEl.createDiv({ cls: 'ezrag-status' });
    statusEl.createEl('p', { text: `Total documents: ${stats.total}` });
    statusEl.createEl('p', { text: `Ready: ${stats.ready}` });
    statusEl.createEl('p', { text: `Pending: ${stats.pending}` });
    statusEl.createEl('p', { text: `Error: ${stats.error}` });
  }
}
```

### 6.6 Runner Pattern for Multi-Device Vaults

**Problem:** In multi-device setups (laptop + desktop), we need to designate ONE machine as the "runner" responsible for indexing. Otherwise:
- Multiple devices index simultaneously → API overload
- Multiple devices run Janitor → wasted API calls
- Race conditions when both devices try to index the same file change

**Solution:** Store per-machine, per-vault runner state **outside** the vault (not synced).

#### Why Store Outside Vault

Normal vault files sync via Obsidian Sync / git / Dropbox. We need machine-local state that does **not** sync:

**Storage location:**
```
<obsidian-config-dir>/plugins/ezrag/<vault-hash>/runner.json
```

**Paths by platform:**
- Windows: `%APPDATA%\Obsidian\plugins\ezrag\<vault-hash>\runner.json`
- macOS: `~/Library/Application Support/Obsidian/plugins/ezrag/<vault-hash>/runner.json`
- Linux: `~/.config/Obsidian/plugins/ezrag/<vault-hash>/runner.json`

**Vault isolation:** Hash vault path to create stable directory name per vault.

#### RunnerManager Implementation

```typescript
// src/runner/runnerState.ts
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

export interface RunnerConfig {
  isRunner: boolean;
  lastEnabledAt?: number;
  deviceName?: string; // For user reference (hostname)
}

export class RunnerManager {
  private configPath: string;
  private config: RunnerConfig;

  constructor(pluginId: string, vaultPath: string) {
    this.configPath = this.buildConfigPath(pluginId, vaultPath);
    this.config = { isRunner: false };
  }

  async load(): Promise<void> {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = await fs.promises.readFile(this.configPath, 'utf8');
        this.config = JSON.parse(raw);
      }
    } catch (err) {
      console.error('[RunnerManager] Failed to load config:', err);
      this.config = { isRunner: false };
    }
  }

  async save(): Promise<void> {
    try {
      // Ensure directory exists
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const json = JSON.stringify(this.config, null, 2);
      await fs.promises.writeFile(this.configPath, json, 'utf8');
    } catch (err) {
      console.error('[RunnerManager] Failed to save config:', err);
    }
  }

  isRunner(): boolean {
    return this.config.isRunner;
  }

  async setRunner(value: boolean): Promise<void> {
    this.config.isRunner = value;
    if (value) {
      this.config.lastEnabledAt = Date.now();
      this.config.deviceName = os.hostname();
    }
    await this.save();
  }

  getConfig(): RunnerConfig {
    return { ...this.config };
  }

  private buildConfigPath(pluginId: string, vaultPath: string): string {
    // Get Obsidian config directory by platform
    const platform = process.platform;
    let baseConfigDir: string;

    if (platform === 'win32') {
      baseConfigDir = path.join(
        process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'),
        'Obsidian'
      );
    } else if (platform === 'darwin') {
      baseConfigDir = path.join(
        os.homedir(),
        'Library',
        'Application Support',
        'Obsidian'
      );
    } else {
      // Linux
      baseConfigDir = path.join(
        process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'),
        'Obsidian'
      );
    }

    // Create stable vault-specific key using hash
    const vaultKey = this.hashVaultPath(vaultPath);

    return path.join(baseConfigDir, 'plugins', pluginId, vaultKey, 'runner.json');
  }

  private hashVaultPath(vaultPath: string): string {
    // SHA-256 hash of vault path, take first 16 chars
    return crypto
      .createHash('sha256')
      .update(vaultPath)
      .digest('hex')
      .substring(0, 16);
  }
}
```

#### Runner Behavior

**When runner is enabled:**
- Automatic indexing on file changes
- Manual Janitor available in settings
- Reconciliation on startup

**When runner is disabled:**
- No automatic indexing
- Vault events ignored
- Settings show: "Indexing controls hidden - not the runner"

**User workflow:**
1. Install plugin on both Laptop and Desktop
2. Set API key on both (syncs via vault data)
3. Enable "This machine is the runner" on Laptop only
4. Desktop will index read-only, Laptop does all indexing work

---

### 6.6 Janitor Progress Modal

**Manual deduplication UI** shown when user clicks "Run Deduplication" in settings.

```typescript
// src/ui/janitorProgressModal.ts
import { App, Modal, Notice } from 'obsidian';
import { JanitorStats } from '../indexing/janitor';

export class JanitorProgressModal extends Modal {
  private stats: JanitorStats;
  private phaseEl!: HTMLElement;
  private progressEl!: HTMLElement;
  private statsEl!: HTMLElement;
  private currentActionEl!: HTMLElement;
  private closeButtonEl!: HTMLButtonElement;
  private isDone: boolean = false;

  constructor(app: App) {
    super(app);
    this.stats = {
      totalRemoteDocs: 0,
      duplicatesFound: 0,
      duplicatesDeleted: 0,
      stateUpdated: 0,
      orphansDeleted: 0,
    };
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: 'Deduplication Progress' });

    // Phase indicator
    this.phaseEl = contentEl.createDiv({ cls: 'janitor-phase' });

    // Progress summary
    this.progressEl = contentEl.createDiv({ cls: 'janitor-progress' });

    // Stats display
    this.statsEl = contentEl.createDiv({ cls: 'janitor-stats' });

    // Current action
    this.currentActionEl = contentEl.createDiv({ cls: 'janitor-current' });

    // Close button (disabled until complete)
    const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
    this.closeButtonEl = buttonContainer.createEl('button', { text: 'Close' });
    this.closeButtonEl.disabled = true;
    this.closeButtonEl.addEventListener('click', () => this.close());

    this.render();
  }

  updateStats(stats: Partial<JanitorStats>, currentAction?: string) {
    this.stats = { ...this.stats, ...stats };
    if (currentAction) {
      this.currentActionEl.setText(currentAction);
    }
    this.render();
  }

  markComplete() {
    this.isDone = true;
    this.currentActionEl.setText('');
    this.render();
    this.closeButtonEl.disabled = false;
  }

  markFailed(error: string) {
    this.isDone = true;
    this.phaseEl.setText('Deduplication failed');
    this.currentActionEl.setText(`Error: ${error}`);
    this.closeButtonEl.disabled = false;
  }

  private render() {
    // Phase
    if (!this.isDone) {
      this.phaseEl.setText('Running deduplication...');
    } else {
      this.phaseEl.setText('Deduplication complete!');
    }

    // Progress summary
    this.progressEl.setText(
      `Scanned: ${this.stats.totalRemoteDocs} documents`
    );

    // Stats
    const statsList = [
      `Duplicates found: ${this.stats.duplicatesFound}`,
      `Duplicates deleted: ${this.stats.duplicatesDeleted}`,
      `State updates: ${this.stats.stateUpdated}`,
    ];
    this.statsEl.setText(statsList.join('\n'));
  }

  onClose() {
    this.contentEl.empty();
  }
}
```

---

### 6.7 Initial Indexing Progress View (`progressView.ts`)

**Problem:** For vaults with 1,000+ notes, initial indexing can take hours. The status bar alone is insufficient for such a large operation.

**Solution:** Dedicated modal view that shows detailed progress during initial indexing.

```typescript
// src/ui/progressView.ts
import { App, Modal, Notice } from 'obsidian';

export interface ProgressStats {
  phase: 'scanning' | 'indexing' | 'complete';
  scannedFiles: number;
  totalFiles: number;
  indexedFiles: number;
  filesToIndex: number;
  failedFiles: number;
  currentFile?: string;
  estimatedTimeRemaining?: number; // seconds
}

export class ProgressModal extends Modal {
  private stats: ProgressStats;
  private contentEl: HTMLElement;
  private isPaused: boolean = false;
  private onPause?: () => void;
  private onResume?: () => void;
  private onCancel?: () => void;

  constructor(app: App, options?: {
    onPause?: () => void;
    onResume?: () => void;
    onCancel?: () => void;
  }) {
    super(app);
    this.onPause = options?.onPause;
    this.onResume = options?.onResume;
    this.onCancel = options?.onCancel;

    this.stats = {
      phase: 'scanning',
      scannedFiles: 0,
      totalFiles: 0,
      indexedFiles: 0,
      filesToIndex: 0,
      failedFiles: 0,
    };
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: 'EzRAG Initial Indexing' });

    // Phase indicator
    this.phaseEl = contentEl.createDiv({ cls: 'ezrag-progress-phase' });

    // Progress bar
    this.progressBarEl = contentEl.createDiv({ cls: 'ezrag-progress-bar-container' });
    this.progressBarFillEl = this.progressBarEl.createDiv({ cls: 'ezrag-progress-bar-fill' });

    // Stats display
    this.statsEl = contentEl.createDiv({ cls: 'ezrag-progress-stats' });

    // Current file
    this.currentFileEl = contentEl.createDiv({ cls: 'ezrag-progress-current' });

    // Time estimate
    this.timeEl = contentEl.createDiv({ cls: 'ezrag-progress-time' });

    // Action buttons
    const buttonContainer = contentEl.createDiv({ cls: 'ezrag-progress-buttons' });

    this.pauseButton = buttonContainer.createEl('button', { text: 'Pause' });
    this.pauseButton.addEventListener('click', () => this.togglePause());

    this.cancelButton = buttonContainer.createEl('button', {
      text: 'Cancel',
      cls: 'mod-warning'
    });
    this.cancelButton.addEventListener('click', () => this.cancel());

    this.closeButton = buttonContainer.createEl('button', {
      text: 'Run in Background',
      cls: 'mod-cta'
    });
    this.closeButton.addEventListener('click', () => this.close());

    // Initial render
    this.render();
  }

  updateStats(stats: Partial<ProgressStats>) {
    this.stats = { ...this.stats, ...stats };
    this.render();
  }

  private render() {
    // Phase indicator
    const phaseText = {
      scanning: 'Phase 1: Scanning files...',
      indexing: 'Phase 2: Indexing notes...',
      complete: 'Indexing complete!',
    }[this.stats.phase];
    this.phaseEl.setText(phaseText);

    // Progress bar
    let progress = 0;
    if (this.stats.phase === 'scanning') {
      progress = this.stats.totalFiles > 0
        ? (this.stats.scannedFiles / this.stats.totalFiles) * 100
        : 0;
    } else if (this.stats.phase === 'indexing') {
      progress = this.stats.filesToIndex > 0
        ? (this.stats.indexedFiles / this.stats.filesToIndex) * 100
        : 0;
    } else {
      progress = 100;
    }

    this.progressBarFillEl.style.width = `${progress}%`;

    // Stats display
    if (this.stats.phase === 'scanning') {
      this.statsEl.setText(
        `Scanned: ${this.stats.scannedFiles} / ${this.stats.totalFiles} files`
      );
    } else if (this.stats.phase === 'indexing') {
      this.statsEl.setText(
        `Indexed: ${this.stats.indexedFiles} / ${this.stats.filesToIndex} files\n` +
        `Failed: ${this.stats.failedFiles}`
      );
    } else {
      this.statsEl.setText(
        `Successfully indexed ${this.stats.indexedFiles} files\n` +
        `Failed: ${this.stats.failedFiles}`
      );
    }

    // Current file
    if (this.stats.currentFile) {
      this.currentFileEl.setText(`Current: ${this.stats.currentFile}`);
    } else {
      this.currentFileEl.setText('');
    }

    // Time estimate
    if (this.stats.estimatedTimeRemaining) {
      const minutes = Math.floor(this.stats.estimatedTimeRemaining / 60);
      const seconds = this.stats.estimatedTimeRemaining % 60;
      this.timeEl.setText(
        `Estimated time remaining: ${minutes}m ${seconds}s`
      );
    } else {
      this.timeEl.setText('');
    }

    // Update button states
    if (this.stats.phase === 'complete') {
      this.pauseButton.disabled = true;
      this.cancelButton.disabled = true;
      this.closeButton.setText('Close');
    }
  }

  private togglePause() {
    this.isPaused = !this.isPaused;

    if (this.isPaused) {
      this.pauseButton.setText('Resume');
      if (this.onPause) this.onPause();
    } else {
      this.pauseButton.setText('Pause');
      if (this.onResume) this.onResume();
    }
  }

  private cancel() {
    if (this.onCancel) {
      this.onCancel();
    }
    this.close();
  }

  onClose() {
    this.contentEl.empty();
  }
}
```

**Usage in IndexManager:**

```typescript
// In reconcileOnStartup, detect if this is a large initial index:
async reconcileOnStartup(): Promise<void> {
  const files = this.getIndexableFiles();

  this.stats.total = files.length;
  this.stats.completed = 0;
  this.stats.failed = 0;
  this.stats.pending = 0;

  // Detect if this is a "first run" situation
  const isFirstRun = files.length > 100 &&
                     Object.keys(this.state.getAllDocStates()).length === 0;

  if (isFirstRun && this.onLargeIndexStart) {
    // Notify main plugin to show progress modal
    this.onLargeIndexStart(files.length);
  }

  // ... rest of scanning logic
}
```

### 6.8 Main Plugin (`main.ts`)

```typescript
// src/main.ts
import { App, Modal, Platform, Plugin, TFile, Notice } from 'obsidian';
import { StateManager, DEFAULT_DATA } from './state/state';
import { GeminiService } from './gemini/geminiService';
import { IndexManager } from './indexing/indexManager';
import { RunnerManager } from './runner/runnerState';
import { Janitor } from './indexing/janitor';
import { JanitorProgressModal } from './ui/janitorProgressModal';
import { EzRAGSettingTab } from './ui/settingsTab';

export default class EzRAGPlugin extends Plugin {
  stateManager: StateManager;
  runnerManager: RunnerManager | null = null; // Only on desktop
  geminiService: GeminiService | null = null;
  indexManager: IndexManager | null = null;
  statusBarItem: HTMLElement | null = null;

  async onload() {
    console.log('Loading EzRAG plugin');

    // Load persisted data with proper deep merge for nested objects
    const savedData = await this.loadData();
    if (savedData) {
      // Deep merge nested chunkingConfig
      savedData.settings = {
        ...DEFAULT_DATA.settings,
        ...savedData.settings,
        chunkingConfig: {
          ...DEFAULT_DATA.settings.chunkingConfig,
          ...(savedData.settings?.chunkingConfig || {})
        }
      };
    }
    this.stateManager = new StateManager(savedData || DEFAULT_DATA);

    // Load runner state (per-machine, per-vault, non-synced)
    // ONLY AVAILABLE ON DESKTOP - mobile doesn't support Node.js modules
    if (Platform.isDesktopApp) {
      const vaultPath = this.app.vault.adapter.getBasePath?.() || this.app.vault.getName();
      this.runnerManager = new RunnerManager(this.manifest.id, vaultPath);
      await this.runnerManager.load();
    }

    // FIRST-RUN ONBOARDING: Check if API key is set
    const settings = this.stateManager.getSettings();
    const isFirstRun = !settings.apiKey;

    if (isFirstRun) {
      // Show welcome notice with action button
      this.showFirstRunWelcome();
    } else if (this.runnerManager?.isRunner()) {
      // Only initialize services on the runner machine (desktop only)
      await this.initializeServices();
    }

    // Add settings tab
    this.addSettingTab(new EzRAGSettingTab(this.app, this));

    // Add status bar
    this.statusBarItem = this.addStatusBarItem();
    this.updateStatusBar(this.getStatusBarText());

    // Register vault events after layout is ready to avoid processing existing files on startup
    // ONLY REGISTER IF THIS MACHINE IS THE RUNNER
    this.app.workspace.onLayoutReady(() => {
      if (!this.runnerManager.isRunner()) {
        console.log('[EzRAG] Not the runner machine, skipping vault event registration');
        return;
      }

      this.registerEvent(
        this.app.vault.on('create', (file) => {
          if (file instanceof TFile) {
            this.indexManager?.onFileCreated(file);
          }
        })
      );

      this.registerEvent(
        this.app.vault.on('modify', (file) => {
          if (file instanceof TFile) {
            this.indexManager?.onFileModified(file);
          }
        })
      );

      this.registerEvent(
        this.app.vault.on('rename', (file, oldPath) => {
          if (file instanceof TFile) {
            this.indexManager?.onFileRenamed(file, oldPath);
          }
        })
      );

      this.registerEvent(
        this.app.vault.on('delete', (file) => {
          if (file instanceof TFile) {
            this.indexManager?.onFileDeleted(file.path);
          }
        })
      );

      // Run startup reconciliation after layout is ready (only on runner)
      if (this.indexManager) {
        this.indexManager.reconcileOnStartup();
      }
    });

    // Add commands (only available if runner)
    this.addCommand({
      id: 'rebuild-index',
      name: 'Rebuild Index',
      checkCallback: (checking) => {
        if (!this.runnerManager.isRunner()) return false;
        if (!checking) this.rebuildIndex();
        return true;
      },
    });

    this.addCommand({
      id: 'cleanup-orphans',
      name: 'Cleanup Orphaned Documents',
      checkCallback: (checking) => {
        if (!this.runnerManager.isRunner()) return false;
        if (!checking) this.cleanupOrphans();
        return true;
      },
    });

    this.addCommand({
      id: 'run-janitor',
      name: 'Run Deduplication',
      checkCallback: (checking) => {
        if (!this.runnerManager.isRunner()) return false;
        if (!checking) this.runJanitorWithUI();
        return true;
      },
    });
  }

  /**
   * Show first-run welcome modal
   */
  private showFirstRunWelcome(): void {
    const modal = new FirstRunModal(this.app, () => {
      // Open settings when user clicks the button
      this.app.setting.open();
      this.app.setting.openTabById(this.manifest.id);
    });
    modal.open();
  }

  /**
   * Run Janitor deduplication with progress UI (manual trigger only)
   */
  async runJanitorWithUI(): Promise<void> {
    if (!this.runnerManager.isRunner()) {
      new Notice('This machine is not configured as the runner. Enable it in settings first.');
      return;
    }

    if (!this.indexManager || !this.geminiService) {
      new Notice('Service not initialized. Set API key first.');
      return;
    }

    const modal = new JanitorProgressModal(this.app);
    modal.open();

    try {
      const janitor = new Janitor({
        geminiService: this.geminiService,
        stateManager: this.stateManager,
        storeName: this.stateManager.getSettings().storeName,
        onProgress: (msg) => {
          // Update modal with progress messages
          console.log(`[Janitor] ${msg}`);
          modal.updateStats({}, msg);
        },
      });

      const stats = await janitor.run();

      modal.updateStats(stats);
      modal.markComplete();

      if (stats.duplicatesDeleted > 0 || stats.stateUpdated > 0) {
        await this.saveState();
      }

      new Notice(
        `Deduplication complete: ${stats.duplicatesDeleted} duplicates removed, ` +
        `${stats.stateUpdated} state updates`
      );
    } catch (err) {
      console.error('[EzRAG] Janitor failed:', err);
      modal.markFailed(err.message || 'Unknown error');
      new Notice('Deduplication failed. Check console for details.');
    }
  }

  /**
   * Get status bar text based on current state
   */
  private getStatusBarText(): string {
    const settings = this.stateManager.getSettings();

    if (!settings.apiKey) {
      return 'EzRAG: Setup required';
    }

    if (!this.runnerManager.isRunner()) {
      return 'EzRAG: Not runner';
    }

    return 'EzRAG: Idle';
  }

  async onExternalSettingsChange() {
    // Handle external settings changes (e.g., from sync services)
    const savedData = await this.loadData();
    if (savedData) {
      // Deep merge nested chunkingConfig
      savedData.settings = {
        ...DEFAULT_DATA.settings,
        ...savedData.settings,
        chunkingConfig: {
          ...DEFAULT_DATA.settings.chunkingConfig,
          ...(savedData.settings?.chunkingConfig || {})
        }
      };
      this.stateManager = new StateManager(savedData);

      // Re-initialize services if API key changed
      const settings = this.stateManager.getSettings();
      if (settings.apiKey && this.geminiService) {
        await this.initializeServices();
      }
    }
  }

  async onunload() {
    console.log('Unloading EzRAG plugin');
  }

  async saveState(): Promise<void> {
    await this.saveData(this.stateManager.exportData());
  }

  async initializeServices(): Promise<void> {
    const settings = this.stateManager.getSettings();

    if (!settings.apiKey) {
      new Notice('Please set your Gemini API key in settings');
      return;
    }

    // Initialize Gemini service
    this.geminiService = new GeminiService(settings.apiKey);

    // Get or create store
    const vaultName = this.app.vault.getName();
    const storeName = await this.geminiService.getOrCreateStore(vaultName);

    this.stateManager.updateSettings({
      storeName,
      storeDisplayName: vaultName
    });
    await this.saveState();

    // Initialize index manager
    this.indexManager = new IndexManager({
      vault: this.app.vault,
      app: this.app, // Pass app for MetadataCache access
      stateManager: this.stateManager,
      geminiService: this.geminiService,
      vaultName,
      onProgress: (current, total, status) => {
        this.updateStatusBar(`${status}: ${current}/${total}`);
      },
    });
  }

  async rebuildIndex(): Promise<void> {
    if (!this.indexManager) {
      new Notice('Service not initialized. Set API key first.');
      return;
    }

    new Notice('Rebuilding index...');
    await this.indexManager.rebuildIndex();
    await this.saveState();
    new Notice('Index rebuild complete!');
  }

  async previewOrphans(): Promise<void> {
    if (!this.indexManager || !this.geminiService) {
      new Notice('Service not initialized. Set API key first.');
      return;
    }

    const settings = this.stateManager.getSettings();
    const remoteDocs = await this.geminiService.listDocuments(settings.storeName);
    const orphans: string[] = [];

    for (const doc of remoteDocs) {
      const pathMeta = doc.customMetadata?.find((m: any) => m.key === 'obsidian_path');
      if (!pathMeta) continue;

      const vaultPath = pathMeta.stringValue;
      const file = this.app.vault.getAbstractFileByPath(vaultPath);

      if (!file) {
        orphans.push(vaultPath);
      }
    }

    if (orphans.length === 0) {
      new Notice('No orphaned documents found!');
    } else {
      new Notice(`Found ${orphans.length} orphaned documents:\n${orphans.slice(0, 10).join('\n')}${orphans.length > 10 ? '\n...' : ''}`);
    }
  }

  async cleanupOrphans(): Promise<void> {
    if (!this.indexManager) {
      new Notice('Service not initialized. Set API key first.');
      return;
    }

    new Notice('Cleaning up orphaned documents...');
    const deleted = await this.indexManager.cleanupOrphans();
    await this.saveState();
    new Notice(`Cleanup complete! Deleted ${deleted} orphaned documents.`);
  }

  async showStoreStats(): Promise<void> {
    if (!this.geminiService) {
      new Notice('Service not initialized. Set API key first.');
      return;
    }

    const settings = this.stateManager.getSettings();
    if (!settings.storeName) {
      new Notice('No store configured for this vault.');
      return;
    }

    const store = await this.geminiService.getStore(settings.storeName);

    const statsMessage = `
FileSearchStore: ${store.displayName}

Active Documents: ${store.activeDocumentsCount || 0}
Pending Documents: ${store.pendingDocumentsCount || 0}
Failed Documents: ${store.failedDocumentsCount || 0}
Total Size: ${this.formatBytes(parseInt(store.sizeBytes || '0'))}

Created: ${new Date(store.createTime).toLocaleString()}
Updated: ${new Date(store.updateTime).toLocaleString()}
    `.trim();

    new Notice(statsMessage, 10000);
  }

  async listAllStores(): Promise<void> {
    if (!this.geminiService) {
      new Notice('Service not initialized. Set API key first.');
      return;
    }

    const stores = await this.geminiService.listStores();

    if (stores.length === 0) {
      new Notice('No FileSearchStores found for this API key.');
      return;
    }

    const storesList = stores.map((store, idx) => {
      const active = store.activeDocumentsCount || 0;
      const pending = store.pendingDocumentsCount || 0;
      const failed = store.failedDocumentsCount || 0;
      const size = this.formatBytes(parseInt(store.sizeBytes || '0'));
      return `${idx + 1}. ${store.displayName}\n   Docs: ${active} active, ${pending} pending, ${failed} failed\n   Size: ${size}`;
    }).join('\n\n');

    new Notice(`FileSearchStores (${stores.length} total):\n\n${storesList}`, 15000);
  }

  async deleteCurrentStore(): Promise<void> {
    if (!this.geminiService) {
      new Notice('Service not initialized. Set API key first.');
      return;
    }

    const settings = this.stateManager.getSettings();
    if (!settings.storeName) {
      new Notice('No store configured for this vault.');
      return;
    }

    // Show confirmation modal
    const modal = new ConfirmDeleteModal(
      this.app,
      settings.storeDisplayName,
      async () => {
        new Notice('Deleting FileSearchStore...');
        await this.geminiService!.deleteStore(settings.storeName);

        // Clear local state
        this.stateManager.updateSettings({
          storeName: '',
          storeDisplayName: '',
        });
        this.stateManager.clearIndex();
        await this.saveState();

        new Notice('FileSearchStore deleted successfully!');
      }
    );
    modal.open();
  }

  formatBytes(bytes: number): string {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  }

  getIndexStats() {
    const allStates = this.stateManager.getAllDocStates();
    const stats = {
      total: Object.keys(allStates).length,
      ready: 0,
      pending: 0,
      error: 0,
    };

    for (const state of Object.values(allStates)) {
      stats[state.status]++;
    }

    return stats;
  }

  updateStatusBar(text: string): void {
    // Note: Status bar is not available on mobile
    if (this.statusBarItem) {
      this.statusBarItem.setText(`EzRAG: ${text}`);
    }
  }
}

/**
 * First-run welcome modal
 */
class FirstRunModal extends Modal {
  private onOpenSettings: () => void;

  constructor(app: App, onOpenSettings: () => void) {
    super(app);
    this.onOpenSettings = onOpenSettings;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'Welcome to EzRAG!' });

    contentEl.createEl('p', {
      text: 'EzRAG indexes your Obsidian notes into Google Gemini\'s File Search API, enabling semantic search and chat with your notes.'
    });

    contentEl.createEl('p', {
      text: 'To get started, you need to:'
    });

    const list = contentEl.createEl('ol');
    list.createEl('li', { text: 'Get a Google Gemini API key from ai.google.dev' });
    list.createEl('li', { text: 'Add it to EzRAG settings' });
    list.createEl('li', { text: 'Let EzRAG index your notes' });

    const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });

    const settingsButton = buttonContainer.createEl('button', {
      text: 'Open Settings',
      cls: 'mod-cta'
    });
    settingsButton.addEventListener('click', () => {
      this.close();
      this.onOpenSettings();
    });

    const cancelButton = buttonContainer.createEl('button', { text: 'Later' });
    cancelButton.addEventListener('click', () => this.close());
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

/**
 * Confirmation modal for destructive actions
 */
class ConfirmDeleteModal extends Modal {
  private storeName: string;
  private onConfirm: () => Promise<void>;

  constructor(app: App, storeName: string, onConfirm: () => Promise<void>) {
    super(app);
    this.storeName = storeName;
    this.onConfirm = onConfirm;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'Confirm deletion' });
    contentEl.createEl('p', {
      text: `Are you sure you want to permanently delete the FileSearchStore "${this.storeName}"?`
    });
    contentEl.createEl('p', {
      text: 'This action cannot be undone!',
      cls: 'mod-warning'
    });

    const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });

    const cancelButton = buttonContainer.createEl('button', { text: 'Cancel' });
    cancelButton.addEventListener('click', () => this.close());

    const confirmButton = buttonContainer.createEl('button', {
      text: 'Delete',
      cls: 'mod-warning'
    });
    confirmButton.addEventListener('click', async () => {
      this.close();
      await this.onConfirm();
    });
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
```

### 6.5 Janitor Pattern for Deduplication

**Problem:** Multi-device sync can cause duplicate documents when local `data.json` state is stale.

**Scenario:**
1. User modifies `NoteA.md` on Laptop
2. Laptop's `data.json` is stale (no ID found for this file)
3. Laptop uploads a new document → creates `doc-123`
4. Desktop (also with stale `data.json`) does the same → creates `doc-456`
5. Result: Two remote documents for the same note

**Solution:** Background "Janitor" job that periodically deduplicates.

#### Janitor Implementation

```typescript
// src/indexing/janitor.ts
import { GeminiService } from '../gemini/geminiService';
import { StateManager, IndexedDocState } from '../state/state';

export interface JanitorOptions {
  geminiService: GeminiService;
  stateManager: StateManager;
  storeName: string;
  onProgress?: (message: string) => void;
}

export interface JanitorStats {
  totalRemoteDocs: number;
  duplicatesFound: number;
  duplicatesDeleted: number;
  stateUpdated: number;
  orphansDeleted: number;
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
   * Run full deduplication and orphan cleanup
   *
   * Performance: Listing documents requires pagination (20 docs/page max).
   * For 5,000 documents:
   *   - 250 API calls (one per page)
   *   - ~10-15 seconds total
   *   - Much cheaper than 5,000 individual documents.get() calls
   *
   * This overhead is acceptable for periodic background runs (every 30 mins).
   */
  async run(): Promise<JanitorStats> {
    const stats: JanitorStats = {
      totalRemoteDocs: 0,
      duplicatesFound: 0,
      duplicatesDeleted: 0,
      stateUpdated: 0,
      orphansDeleted: 0,
    };

    this.log('Fetching all documents from Gemini...');

    // Fetch all documents from Gemini with pagination
    // NOTE: API returns max 20 docs/page (default 10). For 5,000 docs = 250+ API calls
    // This can take 10-15 seconds for large vaults
    const remoteDocs = await this.gemini.listDocuments(this.storeName);
    stats.totalRemoteDocs = remoteDocs.length;

    this.log(`Found ${remoteDocs.length} remote documents. Building index...`);

    // Build map: PathHash -> DocumentInfo[]
    const pathHashMap = new Map<string, Array<{
      docName: string;
      vaultPath: string;
      pathHash: string;
      mtime: number;
    }>>();

    for (const doc of remoteDocs) {
      // Extract metadata
      const pathHashMeta = doc.customMetadata?.find((m: any) => m.key === 'obsidian_path_hash');
      const vaultPathMeta = doc.customMetadata?.find((m: any) => m.key === 'obsidian_path');
      const mtimeMeta = doc.customMetadata?.find((m: any) => m.key === 'obsidian_mtime');

      if (!pathHashMeta || !vaultPathMeta) {
        // Not an Obsidian document (or missing metadata), skip
        continue;
      }

      const pathHash = pathHashMeta.stringValue!;
      const vaultPath = vaultPathMeta.stringValue!;
      const mtime = mtimeMeta?.numericValue || 0;

      if (!pathHashMap.has(pathHash)) {
        pathHashMap.set(pathHash, []);
      }

      pathHashMap.get(pathHash)!.push({
        docName: doc.name,
        vaultPath,
        pathHash,
        mtime,
      });
    }

    this.log('Checking for duplicates and orphans...');

    // Process each pathHash group
    for (const [pathHash, docs] of pathHashMap) {
      if (docs.length === 1) {
        // No duplicates, check if local state matches
        const doc = docs[0];
        const localState = this.state.getDocState(doc.vaultPath);

        if (localState && localState.geminiDocumentName !== doc.docName) {
          // Local state points to wrong document, update it
          localState.geminiDocumentName = doc.docName;
          this.state.setDocState(doc.vaultPath, localState);
          stats.stateUpdated++;
        }
      } else {
        // DUPLICATES FOUND
        stats.duplicatesFound++;
        this.log(`Found ${docs.length} duplicates for ${docs[0].vaultPath}`);

        // Sort by mtime (descending), keep the newest
        docs.sort((a, b) => b.mtime - a.mtime);
        const winner = docs[0];
        const losers = docs.slice(1);

        this.log(`  Keeping: ${winner.docName} (mtime: ${winner.mtime})`);

        // Delete older duplicates
        for (const loser of losers) {
          try {
            this.log(`  Deleting: ${loser.docName} (mtime: ${loser.mtime})`);
            await this.gemini.deleteDocument(loser.docName);
            stats.duplicatesDeleted++;
          } catch (err) {
            console.error(`Failed to delete duplicate ${loser.docName}:`, err);
          }
        }

        // Update local state to point to winner
        const localState = this.state.getDocState(winner.vaultPath);
        if (localState) {
          localState.geminiDocumentName = winner.docName;
          this.state.setDocState(winner.vaultPath, localState);
          stats.stateUpdated++;
        }
      }
    }

    this.log('Janitor run complete!');
    return stats;
  }

  /**
   * Check if a document with this pathHash already exists in Gemini
   * Used during upload to prevent creating duplicates
   *
   * PERFORMANCE WARNING: This fetches ALL documents with pagination.
   * - API returns max 20 docs/page (default 10)
   * - For 5,000 documents = 250+ API calls
   * - Takes 10-15 seconds for large vaults
   * - Only called when local state is missing (cold path, rare)
   *
   * Returns: geminiDocumentName if found, null otherwise
   */
  async findExistingDocument(pathHash: string): Promise<string | null> {
    // Fetch all documents (requires pagination: 20 docs/page max)
    const remoteDocs = await this.gemini.listDocuments(this.storeName);

    for (const doc of remoteDocs) {
      const pathHashMeta = doc.customMetadata?.find((m: any) => m.key === 'obsidian_path_hash');
      if (pathHashMeta?.stringValue === pathHash) {
        return doc.name;
      }
    }

    return null;
  }

  private log(message: string): void {
    if (this.onProgress) {
      this.onProgress(message);
    }
  }
}
```

#### When to Run the Janitor

**Manual trigger only** (via settings button with dedicated progress UI)
- User explicitly runs deduplication when needed
- Shows real-time progress in dedicated modal
- Only available on the designated "runner" machine (see Section 6.5)

#### Integration with IndexManager

The `IndexManager` should check for existing documents before uploading to prevent creating duplicates in the first place:

```typescript
// In indexManager.ts, update indexFile method:

private async indexFile(file: TFile, content: string, contentHash: string): Promise<void> {
  const pathHash = computePathHash(file.path); // Synchronous now
  const settings = this.state.getSettings();

  // Check if local state has a document ID
  const existingState = this.state.getDocState(file.path);
  let geminiDocumentName = existingState?.geminiDocumentName;

  // SYNC CONFLICT PREVENTION: If no local ID, check if remote document exists
  if (!geminiDocumentName) {
    geminiDocumentName = await this.janitor.findExistingDocument(pathHash);

    if (geminiDocumentName) {
      // Remote document exists! This is a stale local state situation.
      // Adopt the remote ID instead of creating a duplicate.
      console.log(`Adopting existing document for ${file.path}: ${geminiDocumentName}`);
    }
  }

  // Delete old document if exists
  if (geminiDocumentName) {
    try {
      await this.gemini.deleteDocument(geminiDocumentName);
    } catch (err) {
      // Document may have been deleted by janitor, ignore
      console.log(`Document already deleted: ${geminiDocumentName}`);
    }
  }

  // Rest of upload logic...
}
```

---

## 7. Code Examples

### Example: Frontmatter Tag Extraction

```typescript
// src/utils/metadata.ts
import { App, TFile } from 'obsidian';

/**
 * Extract tags from file frontmatter using MetadataCache
 *
 * Benefits:
 * - Already cached (no file read needed)
 * - Handles YAML edge cases properly
 * - Automatically updated by Obsidian
 * - Can extract both frontmatter tags and inline #tags
 */
export function extractTags(app: App, file: TFile): string[] {
  const cache = app.metadataCache.getFileCache(file);
  if (!cache?.frontmatter?.tags) return [];

  const tags = cache.frontmatter.tags;

  // Tags can be: string | string[] | undefined
  if (typeof tags === 'string') return [tags];
  if (Array.isArray(tags)) return tags;

  return [];
}

/**
 * Extract ALL tags including inline #tags from document body
 * Uses Obsidian's built-in getAllTags utility
 */
export function extractAllTags(app: App, file: TFile): string[] {
  const cache = app.metadataCache.getFileCache(file);
  if (!cache) return [];

  // getAllTags combines frontmatter tags + inline #tags
  const allTags = getAllTags(cache) || [];

  // Remove # prefix if present
  return allTags.map(tag => tag.startsWith('#') ? tag.slice(1) : tag);
}

/**
 * Extract any frontmatter field
 */
export function getFrontmatterField(app: App, file: TFile, field: string): any {
  const cache = app.metadataCache.getFileCache(file);
  return cache?.frontmatter?.[field];
}

/**
 * Modify frontmatter (atomic operation)
 */
export async function updateFrontmatter(
  app: App,
  file: TFile,
  updater: (frontmatter: any) => void
): Promise<void> {
  await app.fileManager.processFrontMatter(file, updater);
}
```

### Example: Query with Metadata Filter

**IMPORTANT:** Metadata filtering is **only available during query operations** (generateContent, documents.query). You **cannot** filter documents by metadata when listing them via `listDocuments()`. To find documents by metadata, you must list all documents and filter them in memory (see Janitor implementation in Section 6.4).

#### Using generateContent API (string metadataFilter)

```typescript
// In chat interface - uses generateContent with fileSearch tool
async function searchWithFilter(query: string, tags?: string[]) {
  const settings = stateManager.getSettings();

  // Build metadata filter (string format for generateContent API)
  let metadataFilter = '';
  if (tags && tags.length > 0) {
    const tagFilters = tags.map(tag => `tag="${tag}"`).join(' OR ');
    metadataFilter = `(${tagFilters})`;
  }

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: query,
    config: {
      tools: [
        {
          fileSearch: {
            fileSearchStoreNames: [settings.storeName],
            metadataFilter,
          }
        }
      ]
    }
  });

  return response;
}
```

#### Using documents.query API (metadataFilters array)

```typescript
// Query a specific document with structured metadataFilters
async function queryDocumentWithFilters(
  documentName: string, 
  query: string, 
  tags?: string[]
) {
  // Build metadataFilters array (structured format for documents.query API)
  const metadataFilters: Array<{
    key: string;
    conditions: Array<{
      stringValue?: string;
      int_value?: number;
      operation: "EQUAL" | "GREATER_EQUAL" | "LESS" | "GREATER" | "LESS_EQUAL";
    }>;
  }> = [];

  if (tags && tags.length > 0) {
    // CRITICAL: Key must include "chunk.custom_metadata." prefix
    // Multiple string values go in same MetadataFilter (OR logic)
    metadataFilters.push({
      key: "chunk.custom_metadata.tag",
      conditions: tags.map(tag => ({
        stringValue: tag,
        operation: "EQUAL"
      }))
    });
  }

  const response = await ai.fileSearchStores.documents.query({
    name: documentName,
    config: {
      query,
      resultsCount: 10,
      metadataFilters: metadataFilters.length > 0 ? metadataFilters : undefined
    }
  });

  return response;
}

// Helper function to build tag filters
function buildTagFilters(tags: string[]): Array<{
  key: string;
  conditions: Array<{ stringValue: string; operation: "EQUAL" }>;
}> {
  if (!tags || tags.length === 0) return [];

  return [
    {
      key: "chunk.custom_metadata.tag", // CRITICAL: Must include prefix
      conditions: tags.map(tag => ({
        stringValue: tag,
        operation: "EQUAL"
      }))
    }
  ];
}
```

**Key differences:**
- `generateContent` API: Uses `metadataFilter` (string, simple syntax)
- `documents.query` API: Uses `metadataFilters[]` (array, structured objects)
- **CRITICAL**: For `documents.query`, keys must be prefixed with `"chunk.custom_metadata."`
- String values for same key go in same MetadataFilter (OR logic)
- Multiple MetadataFilters are joined with AND logic

---

## 8. Implementation Caveats & Notes

### 8.1 Mobile Support & Runner Restrictions

**Plugin Architecture:** The plugin works on both desktop and mobile, but **indexing (runner) is desktop-only**.

#### What Works on Mobile

- ✅ Plugin loads successfully
- ✅ Settings UI accessible
- ✅ API key syncs via vault data
- ✅ Future: Chat interface (Phase 3)
- ✅ Future: Query/search features (Phase 3)

#### What's Desktop-Only (Runner)

The **Runner** (indexing engine) requires Node.js modules:

1. **`fs` (File System)**: Reading/writing runner.json outside vault
2. **`path`**: Cross-platform path manipulation
3. **`os`**: Hostname detection and home directory access
4. **`crypto`**: SHA-256 hashing (for content and path hashing)

**Implementation:**
- `RunnerManager` only loads on desktop: `if (Platform.isDesktopApp) { ... }`
- Settings UI hides runner toggle on mobile
- Hash utilities (`hashUtils.ts`) use Node.js crypto (synchronous, fast)

**Manifest configuration:**
```json
{
  "id": "ezrag",
  "name": "EzRAG",
  "version": "1.0.0",
  "minAppVersion": "1.6.0",
  "description": "Index notes into Google Gemini File Search API for semantic search"
}
```

**Note:** NO `isDesktopOnly: true` flag - plugin supports mobile for non-indexing features.

#### Multi-Platform Vault Considerations

**Scenario:** User has vault synced across Desktop + Mobile

1. **Desktop (Laptop)**: Plugin installed, runner enabled → indexes files
2. **Mobile (iPhone)**: Plugin installed → settings show "Indexing not available on mobile"
3. **Desktop (Work PC)**: Plugin installed, runner disabled → can enable if needed

**Key benefits:**
- ✅ API key syncs across all devices via vault data
- ✅ Mobile users can query/chat (Phase 3) even if they can't index
- ✅ Runner state (`.json`) stored outside vault, doesn't sync
- ✅ Each desktop machine has independent runner state

#### Mobile UX

On mobile devices, the settings UI shows:

```
╔═══════════════════════════════════════╗
║ EzRAG Settings                       ║
╠═══════════════════════════════════════╣
║ Mobile Platform                       ║
║ Indexing is not available on mobile  ║
║ devices. The runner can only be      ║
║ enabled on desktop. You can still    ║
║ use chat and query features once     ║
║ they are implemented.                ║
╚═══════════════════════════════════════╝
```

**Decision:** This hybrid approach gives the best of both worlds:
- Desktop power users get full indexing control
- Mobile users can still benefit from query/chat features
- No confusing "plugin not available" errors on mobile

---

### 8.2 Gemini API Limitations

**No metadata filtering during listing:** The Gemini File Search API does **not** support filtering documents by metadata when calling `listDocuments()`. You can only:

1. List **all** documents and examine their metadata in memory
2. Query a single document by name using `documents.get()`
3. Use metadata filters during **query operations** (generateContent, documents.query)

**Impact on Architecture:**

- **Janitor Pattern:** Must fetch all documents and build a Map<PathHash, Doc[]> in memory
- **Sync Conflict Prevention:** When checking if a document exists by pathHash, must list all documents and search in memory
- **Pagination Overhead:** The API limits page size to 20 documents maximum (default 10). For 5,000 documents:
  - Requires 250-500 API calls (depending on page size used)
  - Takes ~10-15 seconds to fetch all pages at max page size (20)
  - Each page returns just metadata stubs (not full content), so responses are small (~1-2 KB each)
- **Cost:** Still much cheaper than making 5,000 individual `documents.get()` calls
- **Tradeoff:** Janitor is manual-only (no automatic runs), so this overhead only occurs when user explicitly triggers deduplication

**Why this matters:** The feedback explicitly clarified this limitation. The plan now correctly uses `listDocuments()` with proper pagination and filters in memory, rather than trying to use non-existent metadata filters during listing.

**Performance Note:** For vaults with 10,000+ documents, listing takes ~30-60 seconds. This is acceptable for manual deduplication runs, but would be problematic if run automatically on a timer.

### 8.3 Gemini SDK Integration

**SDK API Stability:** The `@google/genai` SDK is still evolving. The `geminiService.ts` layer is designed as a thin integration layer that may need adjustments as the SDK stabilizes. Key areas to watch:

- **Store and document listing APIs**: Async iteration patterns may change
- **Upload operation polling**: The `operation.done` flag and response structure
- **Chunking configuration**: The `whiteSpaceConfig` schema may not be finalized

**Recommendation:** Keep `geminiService.ts` isolated and expect to refactor API calls as SDK matures.

### 8.4 Chunking Configuration Scope

The chunking configuration (`maxTokensPerChunk`, `maxOverlapTokens`) is included in Phase 1 but adds complexity early. Consider:

- **Option 1 (current):** Expose in settings from the start
- **Option 2 (leaner MVP):** Hard-code sensible defaults (400/50) and add configuration in Phase 2 after validating with real usage

The architecture supports both—chunking config is already isolated in `uploadDocument()`.

### 8.5 Settings UI Scope

The settings tab includes extensive store management features:
- View current store stats
- List all stores (across all vaults)
- Delete current store
- Preview/cleanup orphans

For a faster v1, consider:
- Keeping only: API key, folders, concurrency, rebuild index
- Moving store management to an "Advanced" collapsible section
- Deferring multi-vault store listing to post-MVP

### 8.6 Cross-Platform Implementation Notes

**Status bar:** The status bar API is a no-op on mobile. The plugin handles this gracefully by:
- Status bar item is created on all platforms
- Updates are no-ops on mobile (Obsidian handles this internally)
- No need for explicit Platform checks

**Crypto API:** Uses Node.js `crypto` module (synchronous, fast) since all hashing is for indexing operations which are desktop-only (runner-only). No need for Web Crypto API.

### 8.7 Tag Extraction Strategy

Current implementation extracts tags from **frontmatter only**:
```typescript
const cache = this.app.metadataCache.getFileCache(file);
const tags = cache?.frontmatter?.tags;
```

If you want to include **inline `#tags`** from document body:
```typescript
import { getAllTags } from 'obsidian';
const allTags = getAllTags(cache) || [];
```

This is a simple toggle—decide based on your indexing use case.

### 8.8 Error Visibility

Files with `status === 'error'` are tracked but not prominently surfaced. Consider adding:
- An "Errors" section in settings showing files with indexing errors
- A count badge: "3 files failed to index" with a link to view details
- Retry button per failed file

The data model already supports this—just needs UI.

### 8.9 IndexManager Scope

The `IndexManager` currently handles:
- Startup reconciliation
- Event handling (create/modify/rename/delete)
- Queue management
- Maintenance (rebuild, cleanup orphans)

If it grows too large, consider extracting maintenance operations to:
- A separate `MaintenanceService`, or
- Top-level plugin methods that call smaller helpers

Not urgent for v1, but watch for bloat.

### 8.10 MCP Canonical ID

For the MCP server (Phase 4), decide on a **canonical document ID** early:

**Option 1: `vaultPath`** (transparent, human-friendly)
```json
{ "id": "Projects/Notes.md", "title": "Notes" }
```

**Option 2: `pathHash`** (opaque, privacy-preserving)
```json
{ "id": "a3f5b2...", "title": "Notes" }
```

The architecture supports both. Document this choice in `mcp/server.ts` and stick to it for consistency.

### 8.11 Chat View Conversation State

When implementing the chat view (Phase 3), decide where conversation state lives:
- **Option 1:** Plugin state (persisted across restarts)
- **Option 2:** In-memory only (ephemeral)
- **Option 3:** LocalStorage-like (per-vault)

Also plan how to:
- Map grounding chunks back to Obsidian files (use `obsidian_path` metadata)
- Handle "open file at citation" links (use `workspace.openLinkText()`)

Don't overstuff `main.ts`—give chat its own module in `ui/chatView.ts`.

---

## 9. Testing Strategy

### Unit Tests

```typescript
// tests/state.test.ts
import { StateManager, computeContentHash } from '../src/state/state';

describe('StateManager', () => {
  it('should initialize with default data', () => {
    const sm = new StateManager();
    expect(sm.getSettings().maxConcurrentUploads).toBe(2);
  });

  it('should compute content hash consistently', () => {
    const content = 'Test content';
    const hash1 = computeContentHash(content);
    const hash2 = computeContentHash(content);
    expect(hash1).toBe(hash2);
  });

  it('should detect content changes via hash', () => {
    const content1 = 'Original';
    const content2 = 'Modified';
    const hash1 = computeContentHash(content1);
    const hash2 = computeContentHash(content2);
    expect(hash1).not.toBe(hash2);
  });
});
```

### Integration Tests

```typescript
// tests/integration/indexing.test.ts
describe('IndexManager Integration', () => {
  it('should index a new file', async () => {
    // Create mock vault, state, gemini service
    const vault = createMockVault();
    const stateManager = new StateManager();
    const gemini = new MockGeminiService();

    const indexManager = new IndexManager({
      vault,
      stateManager,
      geminiService: gemini,
      vaultName: 'TestVault',
    });

    // Create a file
    const file = vault.createFile('test.md', '# Test Note');

    // Trigger indexing
    await indexManager.onFileCreated(file);

    // Wait for queue
    await indexManager.queue.onIdle();

    // Verify state
    const state = stateManager.getDocState('test.md');
    expect(state).toBeDefined();
    expect(state.status).toBe('ready');
  });
});
```

### Manual Testing Checklist

Phase 1:
- [ ] Plugin loads without errors
- [ ] Settings tab displays correctly
- [ ] API key can be saved
- [ ] FileSearchStore is created with vault name

Phase 2:
- [ ] New markdown file triggers indexing
- [ ] Modified file is re-indexed (hash changes)
- [ ] Renamed file: old doc deleted, new doc created
- [ ] Deleted file: Gemini doc deleted, state removed
- [ ] Rebuild index clears state and reindexes all
- [ ] Cleanup orphans removes stale documents
- [ ] Status bar shows progress during indexing
- [ ] Included folders setting works correctly

Phase 3:
- [ ] Chat view opens successfully
- [ ] Query returns relevant results
- [ ] Citations are displayed with file paths
- [ ] Can click citation to open note

Phase 4:
- [ ] MCP server starts successfully
- [ ] keywordSearch tool works
- [ ] semanticSearch tool works
- [ ] Can query from Claude Code

---

## 10. Key Implementation Notes

### Handling Gemini API Constraints

1. **Documents are immutable**: Always delete-then-recreate
2. **Document.name is opaque**: Store it, don't parse it
3. **displayName is not unique**: Use metadata for identity
4. **Operations are async**: Poll until `done === true`

### Performance Optimizations

1. **Hash-based change detection**: Skip unchanged files
2. **Concurrency limit**: Prevent API overload (default: 2)
3. **Queue batching**: Process multiple files efficiently
4. **Incremental sync**: Only index changes, not everything

### Error Handling

1. **Retry on transient errors**: Network issues, rate limits
2. **Mark failed documents**: Set status to 'error' with message
3. **Manual retry**: Via rebuild index or next modify event
4. **Graceful degradation**: Continue indexing other files

### Security Considerations

1. **API key storage**: Use Obsidian's encrypted storage
2. **Metadata privacy**: Don't leak sensitive paths if unwanted
3. **User consent**: Clear description of what gets uploaded
4. **Local-first**: Index is optional, plugin works offline

---

## 11. Key Implementation Clarifications

### 11.1 Upload Completion Semantics

**Question:** When is an upload considered complete for concurrency tracking?

**Answer:** An upload is complete when:
1. The long-running operation's `done` field is `true`
2. The document is in `STATE_ACTIVE` or `STATE_FAILED`

The concurrency limit applies to the **entire upload lifecycle**, including polling:

```typescript
// This entire block counts as "1 concurrent upload"
let operation = await ai.fileSearchStores.uploadToFileSearchStore({...});

while (!operation.done) {
  await delay(3000); // Poll every 3 seconds
  operation = await ai.operations.get({ operation });
}
// NOW it's complete and frees up a concurrency slot
```

With `maxConcurrentUploads: 2`, we have **2 uploads actively polling** at once. Since each upload can take 10-30+ seconds (depending on file size), this prevents API overload while still allowing reasonable throughput.

### 11.2 Chunking Strategy

**Global chunking configuration** is exposed in settings:

- **`maxTokensPerChunk`** (default: 400, range: 100-1000)
  - Controls how large each semantic chunk is
  - Larger chunks = fewer chunks, more context per chunk
  - Smaller chunks = more granular retrieval

- **`maxOverlapTokens`** (default: 50, range: 0-200)
  - Controls overlap between adjacent chunks
  - Prevents information loss at chunk boundaries
  - Higher overlap = better context continuity, larger storage

**Future enhancement:** Per-folder or per-file-size chunking strategies, but for now this is applied globally to all documents.

### 11.3 Polling and Concurrency Model

**Question:** How does concurrency interact with long-running upload operations?

**Answer:** The `maxConcurrentUploads` setting controls **concurrent operations**, not just concurrent upload starts. Each upload job includes polling until completion.

#### How Upload Jobs Work

```typescript
// A single "upload job" includes the entire lifecycle:
async function uploadJob() {
  // 1. Initiate upload
  let operation = await ai.fileSearchStores.uploadToFileSearchStore({...});

  // 2. Poll until complete (can take 10-60+ seconds)
  while (!operation.done) {
    await delay(3000); // Poll every 3 seconds
    operation = await ai.operations.get({ operation });
  }

  // 3. Extract result
  return operation.response.name;
}
```

**With `maxConcurrentUploads: 2`:**
- Two upload jobs can be **actively polling** at the same time
- If Job A is a large file taking 60 seconds to process, one concurrency slot is "occupied" for that entire duration
- Job B can start immediately, but Job C must wait until either A or B completes

**Performance Implications:**

- **Smaller files** (~10 KB): Upload + poll ~5-10 seconds per file
- **Medium files** (~100 KB): Upload + poll ~15-30 seconds per file
- **Large files** (~1 MB+): Upload + poll ~30-60+ seconds per file

**Why not just increase concurrency to 10?**

- Gemini API has rate limits per API key (not well documented, but conservative is safer)
- Each polling request counts toward rate limits
- With 10 concurrent jobs polling every 3 seconds, that's ~200 requests/minute just for polling
- Risk of hitting 429 rate limit errors and slowing down the entire queue

**Recommended Settings:**

| Vault Size | Concurrent Uploads | Rationale |
|-----------|-------------------|-----------|
| < 500 files | 2 | Default, safe for all users |
| 500-2000 files | 3 | Slightly faster, still conservative |
| 2000+ files | 4-5 | Maximum safe throughput |

**User Control:** The settings UI allows users to adjust concurrency (1-5) with a slider. Power users with large vaults can increase it, but the default of 2 balances speed and API safety.

### 11.4 Store Management Tools

Users need visibility into their remote FileSearchStores. The following tools are provided:

#### Preview Orphans
Lists documents that exist in Gemini but not in the vault (without deleting them yet).

#### Cleanup Orphans
Actually deletes orphaned documents after preview.

#### View Current Store Stats
Shows statistics for the current vault's store:
- Active/Pending/Failed document counts
- Total storage size
- Creation/update timestamps

#### List All Stores
Shows **all FileSearchStores** associated with the API key across all vaults:
- Useful for managing multiple vaults
- Shows document counts and sizes for each store
- Helps identify storage usage

#### Delete Current Store
Permanently deletes the current vault's FileSearchStore:
- Requires confirmation (destructive action)
- Clears local state after deletion
- Use case: Starting fresh or switching vaults

---

## 12. Obsidian API Best Practices & Implementation Notes

This section documents critical Obsidian API best practices based on official documentation review.

### 12.1 Vault Event Handling

**Critical:** Vault `create` events fire for EVERY existing file during plugin startup. To prevent performance issues, register vault event handlers AFTER workspace layout is ready:

```typescript
// ❌ BAD: Fires for all existing files on startup
async onload() {
  this.registerEvent(
    this.app.vault.on('create', (file) => {
      this.processFile(file); // This runs for EVERY file!
    })
  );
}

// ✅ GOOD: Only fires for newly created files
async onload() {
  this.app.workspace.onLayoutReady(() => {
    this.registerEvent(
      this.app.vault.on('create', (file) => {
        this.processFile(file); // Only runs for actual new files
      })
    );
  });
}
```

**Alternative:** Check `layoutReady` flag in each handler:
```typescript
this.registerEvent(
  this.app.vault.on('create', (file) => {
    if (!this.app.workspace.layoutReady) return;
    this.processFile(file);
  })
);
```

**Impact:** Prevents processing thousands of files on startup, dramatically improving load time.

### 12.2 MetadataCache for Frontmatter

**Best Practice:** Always use `MetadataCache` for reading frontmatter instead of manual YAML parsing:

```typescript
// ❌ BAD: Manual regex-based YAML parsing
private extractTags(content: string): string[] {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  const yaml = match[1];
  // ... complex regex parsing ...
}

// ✅ GOOD: Use MetadataCache
private extractTags(file: TFile): string[] {
  const cache = this.app.metadataCache.getFileCache(file);
  if (!cache?.frontmatter?.tags) return [];

  const tags = cache.frontmatter.tags;
  if (typeof tags === 'string') return [tags];
  if (Array.isArray(tags)) return tags;
  return [];
}
```

**Benefits:**
- Already cached (no disk read or parsing needed)
- Handles YAML spec edge cases correctly
- Automatically updated by Obsidian
- Includes position information
- Can extract inline `#tags` from body

**For writing frontmatter:**
```typescript
// ✅ Use FileManager.processFrontMatter for atomic updates
await app.fileManager.processFrontMatter(file, (frontmatter) => {
  frontmatter.tags = ['updated', 'tags'];
  delete frontmatter.oldField;
});
```

### 12.3 Nested Settings Merge

**Important:** `Object.assign()` performs shallow copy. For nested settings objects, manually deep merge to preserve defaults:

```typescript
// ❌ BAD: Loses nested defaults
async loadSettings() {
  this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  // If saved data only has chunkingConfig.maxTokensPerChunk,
  // chunkingConfig.maxOverlapTokens will be LOST!
}

// ✅ GOOD: Deep merge nested objects
async loadSettings() {
  const loaded = await this.loadData();
  this.settings = {
    ...DEFAULT_SETTINGS,
    ...loaded,
    chunkingConfig: {
      ...DEFAULT_SETTINGS.chunkingConfig,
      ...(loaded?.chunkingConfig || {})
    }
  };
}
```

**Impact:** Ensures default values are preserved when new settings fields are added.

### 12.4 File Path Operations

**Performance Critical:**

```typescript
// ❌ BAD: O(n) linear search through all files
const file = this.app.vault.getFiles().find(f => f.path === targetPath);

// ✅ GOOD: O(1) direct lookup
const file = this.app.vault.getFileByPath(targetPath);
```

**Path Normalization:**
```typescript
import { normalizePath } from 'obsidian';

// Always normalize user-provided paths
const cleanPath = normalizePath(userInput);
const file = this.app.vault.getFileByPath(cleanPath);
```

### 12.5 File Reading Strategies

**Choose the right method:**

```typescript
// For displaying content (can use cache)
const content = await this.app.vault.cachedRead(file);

// For modifying content (always fresh from disk)
const content = await this.app.vault.read(file);

// For atomic read-modify-write (PREFERRED)
await this.app.vault.process(file, (data) => {
  return data.replace('old', 'new');
});
```

**Why `process()` is better:**
- Atomic operation (no race conditions)
- Prevents data loss from concurrent modifications
- Handles read-modify-write as single transaction

### 12.6 External Settings Changes

**Best Practice:** Settings can be modified externally (sync services, manual edits). Implement `onExternalSettingsChange()` to handle this:

```typescript
async onExternalSettingsChange() {
  await this.loadSettings();
  // Re-initialize services that depend on settings
  if (this.settings.apiKey) {
    await this.initializeServices();
  }
}
```

### 12.7 Mobile Compatibility

**Limitations:**
- Status bar NOT supported on mobile
- No Node.js APIs (use browser APIs only)
- No regex lookbehind (Safari limitation)

**Solution:**
```typescript
// Check platform
if (Platform.isMobile) {
  // Skip status bar updates
} else {
  this.statusBarItem.setText('Status');
}
```

### 12.8 Security Best Practices

**DOM Safety:**
```typescript
// ❌ BAD: XSS vulnerability
element.innerHTML = userContent;

// ✅ GOOD: Use Obsidian's DOM helpers
element.createEl('div', { text: userContent });
element.createSpan({ text: userContent });
```

**Never use global app:**
```typescript
// ❌ BAD: Using global
window.app.vault.read(file);

// ✅ GOOD: Use plugin instance
this.app.vault.read(file);
```

### 12.9 Resource Cleanup

**Always use `register*` methods for automatic cleanup:**

```typescript
export default class MyPlugin extends Plugin {
  async onload() {
    // Auto-cleanup on unload
    this.registerEvent(this.app.vault.on('modify', handler));
    this.registerInterval(setInterval(work, 1000));
    this.registerDomEvent(element, 'click', handler);

    // Custom cleanup
    this.register(() => {
      // Custom cleanup code
    });
  }

  // No need to manually cleanup - handled automatically
  async onunload() {}
}
```

### 12.10 View Management

**Don't store view references:**
```typescript
// ❌ BAD: Storing view reference
this.myView = workspace.getActiveViewOfType(MyView);

// ✅ GOOD: Always query when needed
const view = workspace.getActiveViewOfType(MyView);
if (view) {
  view.doSomething();
}
```

**Reason:** Users can close/move leaves at any time, making stored references stale.

### 12.11 Performance Optimization

**Keep `onload()` lightweight:**
```typescript
async onload() {
  // Quick synchronous setup
  this.addSettingTab(new MySettingTab(this.app, this));
  this.addCommand({ ... });

  // Defer heavy operations
  this.app.workspace.onLayoutReady(() => {
    this.runExpensiveSetup();
  });
}
```

**Startup checklist:**
- ✅ Settings loading: Fast
- ✅ Event registration: Deferred to `onLayoutReady()`
- ✅ File scanning: Only in startup reconciliation
- ✅ API calls: Only if necessary
- ✅ Build: Use production mode (minified)

---

## 13. Future Enhancements (Post-MVP)

- **Selective indexing**: Right-click menu to exclude specific files
- **Per-folder chunking strategies**: Different chunking configs based on folder or file size
  - Example: Smaller chunks (200 tokens) for technical docs, larger chunks (600 tokens) for narrative notes
  - Could use folder-level settings or auto-detect based on document type
- **Advanced chunking**: Support for semantic chunking (paragraph-aware, heading-aware)
- **Bidirectional links**: Preserve [[wiki links]] in indexed content
- **Image indexing**: Upload embedded images alongside notes
- **Multi-vault support**: Manage multiple vaults in one plugin
- **Real-time chat**: Streaming responses in chat interface
- **Export/Import**: Backup and restore index state
- **Analytics**: Dashboard showing index health, usage stats

---

## 14. Conclusion

This plan provides a complete blueprint for building EzRAG with robust multi-device support. The phased approach allows incremental delivery of value:
- **Phase 1**: Basic infrastructure and settings (including runner pattern)
- **Phase 2**: Full indexing and sync (core value)
- **Phase 3**: In-app chat interface
- **Phase 4**: MCP server for external tools

The architecture maintains separation of concerns, making it easy to reuse code between the Obsidian plugin and standalone MCP server. The state management is vault-local and sync-friendly, and the Gemini integration follows best practices for the File Search API.

**Key strengths of this implementation:**
- ✅ **Cross-platform**: Works on desktop AND mobile (indexing desktop-only, query/chat on all platforms)
- ✅ **Multi-device safe**: Runner pattern prevents conflicts when vault is synced across machines
- ✅ **Deduplication**: Manual Janitor with dedicated UI cleans up sync conflicts
- ✅ **Resilient**: Retry logic with exponential backoff for transient errors
- ✅ **Follows Obsidian best practices**: Leverages MetadataCache, prevents startup event flooding, proper resource cleanup
- ✅ **Performance-optimized**: Synchronous hashing (Node crypto), single read/hash per file, non-blocking startup reconciliation
- ✅ **Desktop-optimized indexing**: Leverages Node.js for reliable per-machine state and fast crypto operations
- ✅ **Robust state management**: Deep merge for nested settings, external settings change handling, atomic operations
- ✅ **Production-ready**: Proper error handling, concurrency limits, graceful degradation, comprehensive UI feedback
- ✅ **Well-documented**: Comprehensive implementation caveats and best practices sections

### Runner Pattern Summary

The **Runner Pattern** is the critical architectural decision for multi-device vaults:

**Problem:** Multiple devices indexing simultaneously causes:
- API overload (multiple uploads for same file)
- Duplicate documents in Gemini
- Race conditions and sync conflicts

**Solution:**
1. **Per-machine runner state** stored outside vault (non-synced):
   - Location: `~/.config/Obsidian/plugins/ezrag/<vault-hash>/runner.json`
   - Contains: `isRunner` flag + device metadata
   - Isolated per vault, per machine

2. **Gated indexing**: Only runner machine processes vault events
   - Non-runner machines: Plugin loaded but inactive
   - Settings UI: Conditional display based on runner status
   - Commands: Only available on runner machine

3. **Manual deduplication**: Janitor cleans up any duplicates created during sync edge cases
   - Triggered manually via settings UI
   - Shows real-time progress in dedicated modal
   - Only available on runner machine

**User Experience:**
- Install plugin on all desktop machines
- API key syncs via vault data (`.obsidian/plugins/ezrag/data.json`)
- Enable runner on ONE machine (e.g., laptop)
- Other machines show read-only status: "Not runner"
- If duplicates occur (rare), run manual deduplication on runner

This plan incorporates extensive feedback and is production-ready for desktop-only deployments with comprehensive multi-device support.
