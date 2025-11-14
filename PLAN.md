# Implementation Plan: EzRAG Obsidian Plugin

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Module Structure](#3-module-structure)
4. [Data Models](#4-data-models)
5. [Implementation Phases](#5-implementation-phases)
6. [Detailed Component Design](#6-detailed-component-design)
7. [Code Examples](#7-code-examples)
8. [Testing Strategy](#8-testing-strategy)

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
│  │  • Document upload/delete                           │  │
│  │  • File Search queries                              │  │
│  └──────────────────────┬──────────────────────────────┘  │
│                         │                                  │
│  ┌──────────────────────▼──────────────────────────────┐  │
│  │         State Manager (state.ts)                    │  │
│  │  • PersistedData management                         │  │
│  │  • IndexedDocState tracking                         │  │
│  │  • loadData/saveData wrapper                        │  │
│  └─────────────────────────────────────────────────────┘  │
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

**Indexing Flow:**
```
User saves note → Vault event → IndexManager
                                    ↓
                          Compute content hash
                                    ↓
                          Hash different? → Add to queue
                                    ↓
                          Job executes:
                          1. Delete old doc (if exists)
                          2. Upload new doc with metadata
                          3. Update IndexedDocState
                          4. Save state
```

**Query Flow (Chat):**
```
User query → Chat UI → geminiService.fileSearch()
                              ↓
                    Gemini API with FileSearch tool
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
├── state/
│   ├── state.ts            # State management (Obsidian-agnostic)
│   └── stateManager.ts     # Obsidian-specific wrapper
├── gemini/
│   ├── geminiService.ts    # Gemini API wrapper (Obsidian-agnostic)
│   └── types.ts            # Gemini-specific types
├── indexing/
│   ├── indexManager.ts     # Main indexing orchestrator
│   ├── queue.ts            # Job queue wrapper
│   ├── hashUtils.ts        # Content hashing utilities
│   └── reconciler.ts       # Startup reconciliation
├── ui/
│   ├── settingsTab.ts      # Settings UI
│   ├── statusBar.ts        # Status bar component
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
  geminiDocumentName: string; // e.g., "fileSearchStores/.../documents/..."
  contentHash: string; // SHA-256 of file content
  pathHash: string; // SHA-256 of vaultPath (for metadata ID)
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
- [ ] Gemini service (`geminiService.ts`)
- [ ] Hash utilities (`hashUtils.ts`)
- [ ] Basic settings UI (API key input)
- [ ] Store discovery/creation

**Deliverable:** Can create a store and persist basic settings

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

### 6.1 State Management (`state.ts`)

**Obsidian-agnostic** - can be used by both plugin and MCP server.

```typescript
// src/state/state.ts
import { createHash } from 'crypto';

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
}

export interface IndexState {
  docs: Record<string, IndexedDocState>;
}

export interface IndexedDocState {
  vaultPath: string;
  geminiDocumentName: string;
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

export function computeContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function computePathHash(path: string): string {
  return createHash('sha256').update(path).digest('hex');
}

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

### 6.2 Gemini Service (`geminiService.ts`)

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
   */
  async listDocuments(storeName: string): Promise<any[]> {
    const docs: any[] = [];
    const response = await this.ai.fileSearchStores.documents.list({
      parent: storeName,
      config: { pageSize: 100 }
    });

    for await (const doc of response) {
      docs.push(doc);
    }

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

### 6.3 Index Manager (`indexManager.ts`)

Orchestrates all indexing operations.

```typescript
// src/indexing/indexManager.ts
import PQueue from 'p-queue';
import { StateManager, IndexedDocState, computeContentHash, computePathHash } from '../state/state';
import { GeminiService } from '../gemini/geminiService';
import { TFile, Vault } from 'obsidian';

export interface IndexManagerOptions {
  vault: Vault;
  stateManager: StateManager;
  geminiService: GeminiService;
  vaultName: string;
  onProgress?: (current: number, total: number, status: string) => void;
}

export class IndexManager {
  private vault: Vault;
  private state: StateManager;
  private gemini: GeminiService;
  private vaultName: string;
  private queue: PQueue;
  private onProgress?: (current: number, total: number, status: string) => void;

  private stats = {
    total: 0,
    completed: 0,
    failed: 0,
    pending: 0,
  };

  constructor(options: IndexManagerOptions) {
    this.vault = options.vault;
    this.state = options.stateManager;
    this.gemini = options.geminiService;
    this.vaultName = options.vaultName;
    this.onProgress = options.onProgress;

    const settings = this.state.getSettings();
    this.queue = new PQueue({ concurrency: settings.maxConcurrentUploads });
  }

  /**
   * Startup reconciliation: scan all files and queue changed ones
   */
  async reconcileOnStartup(): Promise<void> {
    const files = this.getIndexableFiles();
    const settings = this.state.getSettings();

    this.stats.total = files.length;
    this.stats.completed = 0;
    this.stats.failed = 0;
    this.stats.pending = 0;

    for (const file of files) {
      const shouldIndex = await this.shouldIndexFile(file);
      if (shouldIndex) {
        this.stats.pending++;
        this.queueIndexJob(file);
      }
    }

    await this.queue.onIdle();
    this.updateProgress('Idle');
  }

  /**
   * Handle file creation
   */
  async onFileCreated(file: TFile): Promise<void> {
    if (!this.isMarkdownFile(file) || !this.isInIncludedFolders(file)) {
      return;
    }

    this.queueIndexJob(file);
  }

  /**
   * Handle file modification
   */
  async onFileModified(file: TFile): Promise<void> {
    if (!this.isMarkdownFile(file) || !this.isInIncludedFolders(file)) {
      return;
    }

    const shouldIndex = await this.shouldIndexFile(file);
    if (shouldIndex) {
      this.queueIndexJob(file);
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
   */
  private queueIndexJob(file: TFile): void {
    this.queue.add(async () => {
      try {
        await this.indexFile(file);
        this.stats.completed++;
      } catch (err) {
        this.stats.failed++;
        console.error(`Failed to index ${file.path}:`, err);
      } finally {
        this.stats.pending--;
        this.updateProgress('Indexing');
      }
    });
  }

  /**
   * Private: Index a single file
   */
  private async indexFile(file: TFile): Promise<void> {
    const content = await this.vault.read(file);
    const contentHash = computeContentHash(content);
    const pathHash = computePathHash(file.path);
    const settings = this.state.getSettings();

    // Extract tags from frontmatter
    const tags = this.extractTags(content);

    // Build metadata
    const metadata = [
      { key: 'obsidian_vault', stringValue: this.vaultName },
      { key: 'obsidian_path', stringValue: file.path },
      { key: 'obsidian_path_hash', stringValue: pathHash },
      { key: 'obsidian_mtime', numericValue: file.stat.mtime },
      ...tags.map(tag => ({ key: 'tag', stringValue: tag })),
    ];

    // Delete old document if exists
    const existingState = this.state.getDocState(file.path);
    if (existingState?.geminiDocumentName) {
      try {
        await this.gemini.deleteDocument(existingState.geminiDocumentName);
      } catch (err) {
        // May not exist, ignore
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
   * Private: Determine if file should be indexed
   */
  private async shouldIndexFile(file: TFile): Promise<boolean> {
    const content = await this.vault.read(file);
    const contentHash = computeContentHash(content);

    const state = this.state.getDocState(file.path);

    // No state = new file, index it
    if (!state) return true;

    // Hash changed = content changed, reindex
    if (state.contentHash !== contentHash) return true;

    // Error status = retry
    if (state.status === 'error') return true;

    // Otherwise, skip
    return false;
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
   * Private: Extract tags from frontmatter
   */
  private extractTags(content: string): string[] {
    const tags: string[] = [];

    // Simple frontmatter regex (improve as needed)
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return tags;

    const frontmatter = fmMatch[1];

    // Extract tags field
    const tagsMatch = frontmatter.match(/tags:\s*\[([^\]]+)\]/);
    if (tagsMatch) {
      const tagList = tagsMatch[1].split(',').map(t => t.trim().replace(/['"]/g, ''));
      tags.push(...tagList);
    }

    return tags;
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
import { App, PluginSettingTab, Setting } from 'obsidian';
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

    // API Key
    new Setting(containerEl)
      .setName('Gemini API Key')
      .setDesc('Your Google Gemini API key (get it from ai.google.dev)')
      .addText(text => text
        .setPlaceholder('Enter your API key')
        .setValue(this.plugin.stateManager.getSettings().apiKey)
        .onChange(async (value) => {
          this.plugin.stateManager.updateSettings({ apiKey: value });
          await this.plugin.saveState();
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

    // Cleanup Orphans
    new Setting(containerEl)
      .setName('Cleanup Orphans')
      .setDesc('Remove documents from Gemini that no longer exist in vault')
      .addButton(button => button
        .setButtonText('Preview')
        .onClick(async () => {
          await this.plugin.previewOrphans();
        })
      )
      .addButton(button => button
        .setButtonText('Cleanup')
        .setWarning()
        .onClick(async () => {
          await this.plugin.cleanupOrphans();
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

### 6.5 Main Plugin (`main.ts`)

```typescript
// src/main.ts
import { Plugin, TFile, Notice } from 'obsidian';
import { StateManager, DEFAULT_DATA } from './state/state';
import { GeminiService } from './gemini/geminiService';
import { IndexManager } from './indexing/indexManager';
import { EzRAGSettingTab } from './ui/settingsTab';

export default class EzRAGPlugin extends Plugin {
  stateManager: StateManager;
  geminiService: GeminiService | null = null;
  indexManager: IndexManager | null = null;
  statusBarItem: HTMLElement | null = null;

  async onload() {
    console.log('Loading EzRAG plugin');

    // Load persisted data
    const savedData = await this.loadData();
    this.stateManager = new StateManager(savedData || DEFAULT_DATA);

    // Initialize Gemini service if API key is set
    const settings = this.stateManager.getSettings();
    if (settings.apiKey) {
      await this.initializeServices();
    }

    // Add settings tab
    this.addSettingTab(new EzRAGSettingTab(this.app, this));

    // Add status bar
    this.statusBarItem = this.addStatusBarItem();
    this.updateStatusBar('Idle');

    // Register event handlers
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

    // Add commands
    this.addCommand({
      id: 'rebuild-index',
      name: 'Rebuild Index',
      callback: () => this.rebuildIndex(),
    });

    this.addCommand({
      id: 'cleanup-orphans',
      name: 'Cleanup Orphaned Documents',
      callback: () => this.cleanupOrphans(),
    });

    // Run startup reconciliation
    if (this.indexManager) {
      await this.indexManager.reconcileOnStartup();
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

    // Confirmation modal (simplified for plan)
    const confirmed = confirm(
      `Are you sure you want to permanently delete the FileSearchStore "${settings.storeDisplayName}"?\n\nThis cannot be undone!`
    );

    if (!confirmed) {
      new Notice('Store deletion cancelled.');
      return;
    }

    new Notice('Deleting FileSearchStore...');
    await this.geminiService.deleteStore(settings.storeName);

    // Clear local state
    this.stateManager.updateSettings({
      storeName: '',
      storeDisplayName: '',
    });
    this.stateManager.clearIndex();
    await this.saveState();

    new Notice('FileSearchStore deleted successfully!');
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
    if (this.statusBarItem) {
      this.statusBarItem.setText(`EzRAG: ${text}`);
    }
  }
}
```

---

## 7. Code Examples

### Example: Frontmatter Tag Extraction

```typescript
// src/utils/frontmatter.ts
export function extractFrontmatter(content: string): Record<string, any> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const yaml = match[1];
  const result: Record<string, any> = {};

  // Simple YAML parsing (use a library like js-yaml for production)
  const lines = yaml.split('\n');
  for (const line of lines) {
    const [key, ...valueParts] = line.split(':');
    if (!key) continue;

    let value = valueParts.join(':').trim();

    // Handle arrays
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value.slice(1, -1).split(',').map(v => v.trim().replace(/['"]/g, ''));
    }

    result[key.trim()] = value;
  }

  return result;
}

export function extractTags(content: string): string[] {
  const fm = extractFrontmatter(content);
  const tags = fm.tags || fm.tag || [];

  if (typeof tags === 'string') {
    return [tags];
  }

  if (Array.isArray(tags)) {
    return tags;
  }

  return [];
}
```

### Example: Query with Metadata Filter

```typescript
// In chat interface
async function searchWithFilter(query: string, tags?: string[]) {
  const settings = stateManager.getSettings();

  // Build metadata filter
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

---

## 8. Testing Strategy

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

## 9. Key Implementation Notes

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

## 10. Key Implementation Clarifications

### 10.1 Upload Completion Semantics

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

### 10.2 Chunking Strategy

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

### 10.3 Store Management Tools

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

## 11. Future Enhancements (Post-MVP)

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

## Conclusion

This plan provides a complete blueprint for building EzRAG. The phased approach allows incremental delivery of value:
- **Phase 1**: Basic infrastructure and settings
- **Phase 2**: Full indexing and sync (core value)
- **Phase 3**: In-app chat interface
- **Phase 4**: MCP server for external tools

The architecture maintains separation of concerns, making it easy to reuse code between the Obsidian plugin and standalone MCP server. The state management is vault-local and sync-friendly, and the Gemini integration follows best practices for the File Search API.
