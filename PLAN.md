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
│  │ (`main.ts`)  │  │      UI      │  │   (future Phase 3) │  │
│  └─────┬──────┘  └──────┬───────┘  └──────────┬─────────┘  │
│        │                │                     │             │
│  ┌─────▼────────────────▼─────────────────────▼─────────┐  │
│  │   Runner Check: isRunner() → Gate all indexing      │  │
│  └──────────────────────┬──────────────────────────────┘  │
│                         │ (if runner = true)               │
│  ┌──────────────────────▼──────────────────────────────┐  │
│  │     Indexing Controller (indexingController.ts)     │  │
│  │  • Lifecycle management (start/stop/pause/resume)   │  │
│  │  • Phase tracking (idle/scanning/indexing/paused)   │  │
│  │  • State persistence coordination                   │  │
│  └──────────────────────┬──────────────────────────────┘  │
│                         │                                  │
│  ┌──────────────────────▼──────────────────────────────┐  │
│  │          Index Manager (indexManager.ts)             │  │
│  │  • Queue management (p-queue)                        │  │
│  │  • Event handling (create/modify/rename/delete)      │  │
│  │  • Startup reconciliation                            │  │
│  │  • Core indexing operations                          │  │
│  └──────────────────────┬──────────────────────────────┘  │
│                         │                                  │
│  ┌──────────────────────▼──────────────────────────────┐  │
│  │         Gemini Service (`geminiService.ts`)           │  │
│  │  • Store discovery/creation                         │  │
│  │  • Document upload/delete (with pagination)         │  │
│  │  • File Search queries                              │  │
│  └──────────────────────┬──────────────────────────────┘  │
│                         │                                  │
│  ┌──────────────────────▼──────────────────────────────┐  │
│  │         State Manager (`state.ts`)                    │  │
│  │  • PersistedData management (synced via vault)     │  │
│  │  • IndexedDocState tracking                         │  │
│  │  • loadData/saveData wrapper                        │  │
│  └─────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│           Runner State (per-machine, non-synced)            │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  RunnerStateManager (`runnerState.ts`)                 │ │
│  │  • Stored in localStorage (browser-native)            │ │
│  │  • Per-vault, per-machine isolation                   │ │
│  │  • isRunner flag + device ID + timestamp              │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│              MCP Server (future Phase 4)                    │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  • Reads .obsidian/plugins/ezrag/data.json             │ │
│  │  • Exposes keywordSearch tool                          │ │
│  │  • Exposes semanticSearch tool (via Gemini)            │ │
│  │  • Shares `geminiService.ts` and `state.ts`                │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### Data Flow

**Indexing Flow (Hot Path - 99% of operations):**
```
User saves note → Vault event → IndexingController.handleFileModified()
                                    ↓
                          Runner check: isRunner()? (via IndexManager)
                                    ↓ YES (runner machine)
                          IndexManager.onFileModified()
                                    ↓
                          Compute content hash
                                    ↓
                          Hash different? → queueIndexJob() with retry logic
                                    ↓
                          Job executes (via p-queue):
                          1. Check if local state has document ID
                          2. If yes: Delete old doc (local state is source of truth)
                          3. If no: Skip delete (new file, no old doc exists)
                          4. Upload new doc with metadata
                          5. Poll until operation.done === true
                          6. Update IndexedDocState
                          7. Schedule state save (debounced, 500ms)
                                    ↓
                          [If error: Retry with exponential backoff (3 attempts)]
                                    ↓ NO (not runner)
                          Ignore event (no indexing)

NOTE: We do NOT check remote for existing documents during hot path.
That would require listing ALL documents (expensive!).
Edge case duplicates are cleaned up by manual Janitor deduplication.
```

**Janitor Flow (Manual deduplication only):**
```
User clicks "Run Deduplication" in settings → Runner check: isRunner()?
                          ↓ YES (runner machine)
                    Open JanitorProgressModal
                          ↓
                    List ALL documents from Gemini (with pagination progress)
                          ↓
                    Build Map<PathHash, Doc[]> in memory
                          ↓
                    For each pathHash group:
                      - Check local state for this path
                      - If local state exists AND matches one doc's geminiDocumentName:
                          → Keep that doc (valid)
                          → Delete all others (duplicates)
                      - If local state doesn't exist OR doesn't match any doc:
                          → Delete ALL docs in group (orphans)
                          ↓
                    Docs without pathHash → orphans (delete all)
                          ↓
                    Delete duplicates with progress (phase: deleting-duplicates)
                          ↓
                    Delete orphans with progress (phase: deleting-orphans)
                          ↓
                    Show completion notice (phase: complete)
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
│   └── runnerState.ts      # Per-machine runner configuration (localStorage-based)
├── state/
│   ├── state.ts            # State management (Obsidian-agnostic)
│   └── stateManager.ts     # Obsidian-specific wrapper
├── gemini/
│   ├── geminiService.ts    # Gemini API wrapper (Obsidian-agnostic)
│   └── types.ts            # Gemini-specific types
├── indexing/
│   ├── indexManager.ts     # Main indexing orchestrator
│   ├── indexingController.ts  # Indexing lifecycle controller (start/stop/pause/resume)
│   ├── janitor.ts          # Deduplication and sync conflict resolution
│   ├── hashUtils.ts        # Content hashing utilities
├── store/
│   └── storeManager.ts     # Store management helpers (stats, list, delete)
├── ui/
│   ├── settingsTab.ts      # Settings UI
│   ├── indexingStatusModal.ts  # Indexing controls + status display (pause/resume/rescan)
│   ├── janitorProgressModal.ts  # Deduplication progress UI
│   └── chatView.ts         # Chat interface (Phase 3)
├── mcp/
│   └── server.ts           # MCP server (Phase 4)
└── utils/
    ├── logger.ts           # Logging utility
    ├── metadata.ts         # Metadata builder
    └── vault.ts            # Vault-specific utilities (vault key generation)
```

---

## 4. Data Models

### PersistedData ([`state.ts`](src/state/state.ts))

**File:** [`src/state/state.ts`](src/state/state.ts) and [`src/types.ts`](src/types.ts)

**Implementation:** See [`src/types.ts`](src/types.ts) for all TypeScript interfaces:
- `PersistedData` - Root data structure
- `PluginSettings` - API key, store name, folders, concurrency, chunking config
- `ChunkingConfig` - Token limits and overlap settings
- `IndexState` - Map of vault paths to document states
- `IndexedDocState` - Document tracking (path, hash, status, tags, etc.)

### Gemini Document Metadata

When uploading a document, we attach metadata with the following structure:
- `obsidian_vault` - Vault name
- `obsidian_path` - Full vault path
- `obsidian_path_hash` - Hash of path (stable ID)
- `obsidian_content_hash` - Hash of content (for smart reconciliation)
- `obsidian_mtime` - Last modified time
- `tag` - Tags from frontmatter (multiple entries allowed)

**Example metadata structure:** See [`src/indexing/indexManager.ts`](src/indexing/indexManager.ts) in the `indexFile()` method for how metadata is built and attached to documents.

---

## 5. Implementation Phases

### Phase 1: Core Infrastructure (Week 1)
- [x] Project setup (already done: p-queue, @google/genai, MCP SDK)
- [x] State management ([`state.ts`](src/state/state.ts))
- [x] Runner state management ([`runnerState.ts`](src/runner/runnerState.ts)) - **localStorage-based, desktop only**
- [x] Vault utilities ([`vault.ts`](src/utils/vault.ts)) - **Vault key generation**
- [x] Gemini service ([`geminiService.ts`](src/gemini/geminiService.ts))
- [x] Hash utilities ([`hashUtils.ts`](src/indexing/hashUtils.ts))
- [x] Basic settings UI (API key input + runner toggle) - [`settingsTab.ts`](src/ui/settingsTab.ts)
- [x] Store discovery/creation - Integrated in [`main.ts`](main.ts) via `ensureGeminiResources()`
- [x] Store management UI - [`storeManager.ts`](src/store/storeManager.ts)

**Deliverable:** ✅ Can create a store, persist basic settings, and configure runner (desktop only)

**IMPORTANT:** Plugin works on both desktop and mobile, but runner (indexing) only available on desktop due to Node.js crypto dependency in hashing utilities

### Phase 2: Indexing Engine (Week 2)
- [x] Index manager ([`indexManager.ts`](src/indexing/indexManager.ts))
- [x] Queue implementation (using p-queue directly in IndexManager)
- [x] Event handlers (create, modify, rename, delete) - Integrated via [`indexingController.ts`](src/indexing/indexingController.ts)
- [x] Startup reconciliation - Implemented in `IndexManager.reconcileOnStartup()`
- [x] Progress tracking in status bar - Real-time updates via `IndexingController`
- [x] Manual commands (rebuild index, cleanup orphans) - Available in settings UI
- [x] Indexing controller lifecycle management - [`indexingController.ts`](src/indexing/indexingController.ts)
- [x] Indexing status modal UI - [`indexingStatusModal.ts`](src/ui/indexingStatusModal.ts) with pause/resume/rescan controls

**Deliverable:** ✅ Plugin indexes notes and keeps them in sync

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

### 6.1 Hash Utilities & Vault Utilities

**Desktop-only** - Uses Node.js crypto for synchronous, performant hashing.

Since all hashing is used for indexing operations (which only run on the runner machine, which is desktop-only), we can use Node.js crypto throughout for simplicity and performance.

**File:** [`src/indexing/hashUtils.ts`](src/indexing/hashUtils.ts)

**Implementation:** See [`src/indexing/hashUtils.ts`](src/indexing/hashUtils.ts) for the complete implementation of `computeContentHash()` and `computePathHash()` functions.

**File:** [`src/utils/vault.ts`](src/utils/vault.ts)

**Implementation:** See [`src/utils/vault.ts`](src/utils/vault.ts) for the `computeVaultKey()` function that generates stable vault identifiers for localStorage keys.

**Benefits of Node.js crypto:**
- ✅ **Synchronous**: No async/await needed, simplifies code
- ✅ **Faster**: Native implementation, more efficient
- ✅ **Simpler**: Single import, consistent API
- ✅ **Desktop-only is fine**: Hashing only happens during indexing (runner-only)

**Usage pattern:** The functions are synchronous (no async/await needed), making them faster and simpler than Web Crypto alternatives.

---

### 6.2 State Management ([`state.ts`](src/state/state.ts))

**Obsidian-agnostic** - can be used by both plugin and MCP server.

**File:** [`src/state/state.ts`](src/state/state.ts) and [`src/types.ts`](src/types.ts)

**Implementation:** See [`src/state/state.ts`](src/state/state.ts) for the `StateManager` class and [`src/types.ts`](src/types.ts) for all TypeScript interfaces (`PersistedData`, `PluginSettings`, `ChunkingConfig`, `IndexState`, `IndexedDocState`).

### 6.3 Gemini Service ([`geminiService.ts`](src/gemini/geminiService.ts))

**Obsidian-agnostic** - can be used by both plugin and MCP server.

**File:** [`src/gemini/geminiService.ts`](src/gemini/geminiService.ts)

**Implementation:** See [`src/gemini/geminiService.ts`](src/gemini/geminiService.ts) for the complete `GeminiService` class implementation, including:
- `getOrCreateStore()` - Find or create FileSearchStore by display name
- `uploadDocument()` - Upload with polling until complete
- `deleteDocument()` - Delete a document
- `listDocuments()` - List all documents with pagination (max 20/page)
- `fileSearch()` - Query FileSearchStore with metadata filters
- `getStore()` - Get store details and stats
- `listStores()` - List all stores for API key
- `deleteStore()` - Delete a FileSearchStore

### 6.4 Index Manager ([`indexManager.ts`](src/indexing/indexManager.ts))

Orchestrates all indexing operations.

**File:** [`src/indexing/indexManager.ts`](src/indexing/indexManager.ts)

**Implementation:** See [`src/indexing/indexManager.ts`](src/indexing/indexManager.ts) for the complete `IndexManager` class, including:
- `reconcileOnStartup(syncWithRemote)` - Scan all files and queue changed ones; optionally sync with remote for smart reconciliation
- `onFileCreated()` - Handle file creation events
- `onFileModified()` - Handle file modification with hash-based change detection
- `onFileRenamed()` - Handle file rename (delete old, index new)
- `onFileDeleted()` - Handle file deletion
- `rebuildIndex()` - Manual rebuild with smart reconciliation (avoids re-uploading unchanged files)
- `cleanupOrphans()` - Remove documents that exist in Gemini but not in vault
- `queueIndexJob()` - Queue with retry logic (exponential backoff)
- `indexFile()` - Core indexing logic (uses local state only, no remote checks)
- `extractTags()` - Extract tags from frontmatter using MetadataCache
- `pause()` / `resume()` / `clearQueue()` - Queue control methods
- `waitForIdle()` - Wait for all queued jobs to complete
- `dispose()` - Cleanup resources

#### Smart Reconciliation for Rebuild Index

**Problem**: When users run "Rebuild Index" (e.g., after sync issues or corrupted local state), naively re-indexing would create duplicates in Gemini for every file.

**Solution**: Smart reconciliation compares local files with remote documents using content hashes.

**How it works**:

1. User clicks "Rebuild Index"
2. Local state is cleared (`clearIndex()`)
3. `reconcileOnStartup(syncWithRemote: true)` is called:
   - Fetches all remote documents from Gemini
   - Builds map of `pathHash` → remote document
   - For each local file:
     - Computes `contentHash` and `pathHash`
     - Checks if remote has matching document by `pathHash`
     - If match and `obsidian_content_hash` equals local hash:
       - **Restore local state** without re-uploading ✅
     - If match but hash differs:
       - **Queue for re-index** (content changed)
     - If no match:
       - **Queue for upload** (new file)

**Benefits**:
- ✅ No duplicates created
- ✅ Unchanged files restored instantly (no re-upload)
- ✅ Only changed files re-indexed
- ✅ Perfect for recovering from sync issues or corrupted local state

**Implementation**: See [`src/indexing/indexManager.ts`](src/indexing/indexManager.ts) lines 78-163 for the complete smart reconciliation logic.

### 6.4.1 Indexing Controller ([`indexingController.ts`](src/indexing/indexingController.ts))

Manages indexing lifecycle and state transitions.

**File:** [`src/indexing/indexingController.ts`](src/indexing/indexingController.ts)

**Implementation:** See [`src/indexing/indexingController.ts`](src/indexing/indexingController.ts) for the complete `IndexingController` class, including:
- `start()` - Initialize IndexManager and begin reconciliation
- `pause()` / `resume()` - Control queue execution
- `stop()` - Stop indexing and dispose IndexManager
- `runFullReconcile()` - Trigger manual vault scan while running
- `handleFileCreated()` / `handleFileModified()` / `handleFileRenamed()` / `handleFileDeleted()` - Event handlers that delegate to IndexManager
- `subscribe()` - Subscribe to state updates (used by UI)
- `getSnapshot()` - Get current phase and stats
- `isActive()` / `isPaused()` - State queries

**Phases:**
- `idle` - No indexing activity
- `scanning` - Scanning vault for changes
- `indexing` - Actively processing queue
- `paused` - Queue paused (can resume)

**State Management:**
- Batches state persistence (500ms debounce) to avoid excessive disk writes
- Notifies listeners on phase/stats changes
- Integrates with main plugin for status bar updates

### 6.5 Store Manager ([`storeManager.ts`](src/store/storeManager.ts))

Handles FileSearchStore management operations.

**File:** [`src/store/storeManager.ts`](src/store/storeManager.ts)

**Implementation:** See [`src/store/storeManager.ts`](src/store/storeManager.ts) for the complete `StoreManager` class, including:
- `showStoreStats()` - Display current store statistics (name, ID, timestamps)
- `listAllStores()` - List all FileSearchStores for the API key
- `deleteCurrentStore()` - Delete current store with confirmation (destructive)
- `getOrCreateGeminiService()` - Helper to create temporary GeminiService for non-runner devices

**Usage:** Allows non-runner devices (mobile, desktop non-runner) to view store information even though they can't index.

### 6.6 Settings UI ([`settingsTab.ts`](src/ui/settingsTab.ts))

**File:** [`src/ui/settingsTab.ts`](src/ui/settingsTab.ts)

**Implementation:** See [`src/ui/settingsTab.ts`](src/ui/settingsTab.ts) for the complete `EzRAGSettingTab` class.

#### Settings Visibility Rules

The settings UI adapts based on platform and runner status:

**All Platforms (Desktop + Mobile):**
- ✅ API Configuration
  - Gemini API key input (syncs via vault data)
- ✅ Store Management (Read-only operations)
  - View current store stats
  - List all stores for this API key

**Desktop Only:**
- Runner Configuration
  - Toggle to enable/disable runner status
  - Device ID display
  - Status message when runner is disabled

**Desktop Runner Only (when runner toggle is enabled):**
- ✅ Indexing Configuration
  - Included folders setting
  - Upload concurrency slider
  - Chunking configuration (max tokens, overlap)
- ✅ Manual Actions
  - Rebuild index button
  - Run deduplication button
- ✅ Store Management (Destructive operations)
  - Delete current store button
- ✅ Index Status Display
  - Total/Ready/Pending/Error counts

#### Implementation Notes

- The UI uses `Platform.isDesktopApp` to detect platform
- Runner status is checked via `this.plugin.runnerManager?.isRunner()`
- Store management methods use `getOrCreateGeminiService()` helper to create temporary GeminiService for non-runner devices
- This allows mobile/non-runner devices to view store information even though they can't index

### 6.7 Indexing Status Modal ([`indexingStatusModal.ts`](src/ui/indexingStatusModal.ts))

Real-time indexing status and control panel.

**File:** [`src/ui/indexingStatusModal.ts`](src/ui/indexingStatusModal.ts)

**Implementation:** See [`src/ui/indexingStatusModal.ts`](src/ui/indexingStatusModal.ts) for the complete `IndexingStatusModal` class, including:
- Real-time phase display (scanning/indexing/paused/idle)
- Stats display (completed/total, failed, pending)
- Pause/Resume toggle button
- Re-scan vault button (triggers full reconciliation)
- Clear queue button (removes pending jobs)
- Subscribes to `IndexingController` for live updates

**Usage:** Opened from settings UI "Open status panel" button. Provides user control over indexing operations without disabling the runner.

### 6.8 Runner Pattern for Multi-Device Vaults

**Problem:** In multi-device setups (laptop + desktop), we need to designate ONE machine as the "runner" responsible for indexing. Otherwise:
- Multiple devices index simultaneously → API overload
- Multiple devices run Janitor → wasted API calls
- Race conditions when both devices try to index the same file change

**Solution:** Store per-machine, per-vault runner state in **localStorage** (browser-native, not synced).

#### Why Use localStorage

Normal vault files sync via Obsidian Sync / git / Dropbox. We need machine-local state that does **not** sync:

**Storage mechanism:**
- Uses browser's `window.localStorage` API
- Storage key format: `ezrag.runner.<pluginId>.<vaultKey>`
- Vault key: SHA-256 hash of vault path (first 16 chars)

**Benefits of localStorage:**
- ✅ **Browser-native**: No filesystem dependencies
- ✅ **Synchronous**: Instant read/write, no async needed
- ✅ **Per-origin**: Isolated by Obsidian instance
- ✅ **Vault-isolated**: Hash-based key prevents cross-vault conflicts
- ✅ **Simpler API**: Single read/write, no directory management

**Vault isolation:** Hash vault path using `computeVaultKey()` to create stable key per vault.

#### RunnerStateManager Implementation

**File:** [`src/runner/runnerState.ts`](src/runner/runnerState.ts)

**Implementation:** See [`src/runner/runnerState.ts`](src/runner/runnerState.ts) for the complete `RunnerStateManager` class, including:
- Constructor loads state synchronously from localStorage
- `isRunner()` - Check if this machine is the runner
- `setRunner()` - Enable/disable runner status (async for consistency)
- `getState()` - Get current state snapshot
- `buildStorageKey()` - Build vault-specific localStorage key
- `readFromStorage()` - Read and parse state from localStorage
- `writeToStorage()` - Serialize and save state to localStorage
- `generateDeviceId()` - Create unique device identifier (UUID or timestamp-based)

**Vault utility:** [`src/utils/vault.ts`](src/utils/vault.ts)
- `computeVaultKey()` - Generate stable vault identifier using SHA-256 hash

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

### 6.9 Janitor Progress Modal

**Manual deduplication UI** shown when user clicks "Run Deduplication" in settings.

**File:** [`src/ui/janitorProgressModal.ts`](src/ui/janitorProgressModal.ts)

**Implementation:** See [`src/ui/janitorProgressModal.ts`](src/ui/janitorProgressModal.ts) for the complete `JanitorProgressModal` class, including:
- Real-time progress display
- Stats tracking (duplicates found/deleted, state updates)
- Current action display
- Completion/failure handling

---

### 6.10 Initial Indexing Progress View *(Replaced by IndexingStatusModal)*

**Status:** The planned `progressView.ts` has been replaced by [`indexingStatusModal.ts`](src/ui/indexingStatusModal.ts), which provides:
- ✅ Phase indicators (scanning, indexing, paused, idle)
- ✅ Progress stats (completed/total, failed, pending)
- ✅ Current status display
- ✅ Pause/Resume controls
- ✅ Re-scan vault functionality
- ✅ Clear queue functionality

The IndexingStatusModal is opened on-demand from settings, providing better UX than a persistent progress view. It subscribes to `IndexingController` for real-time updates during both initial indexing and ongoing operations.

### 6.11 Main Plugin ([`main.ts`](main.ts))

**File:** [`main.ts`](main.ts)

**Implementation:** See [`main.ts`](main.ts) for the complete `EzRAGPlugin` class, including:
- `onload()` - Plugin initialization with deep merge for nested settings
  - Creates `IndexingController` instance
  - Creates `StoreManager` instance
  - Registers vault events after `onLayoutReady()` to prevent startup flooding
  - Adds commands (rebuild-index, cleanup-orphans, run-janitor) - runner-only
- `onunload()` - Cleanup (disposes IndexingController)
- `refreshIndexingState()` - Start/stop indexing based on runner status and API key
- `ensureGeminiResources()` - Create GeminiService and FileSearchStore if needed
- `runJanitorWithUI()` - Run deduplication with progress modal
- `rebuildIndex()` - Manual rebuild (with confirmation)
- `cleanupOrphans()` - Remove orphaned documents (with confirmation)
- `updateApiKey()` - Handle API key changes (stops indexing if cleared)
- `handleRunnerStateChange()` - Handle runner toggle (starts/stops indexing)
- `openIndexingStatusModal()` - Open indexing status/controls modal
- `getIndexStats()` - Get index statistics
- `updateStatusBar()` - Update status bar text (real-time via controller subscription)
- `showFirstRunWelcome()` - First-run onboarding notice
- `confirmAction()` - Reusable confirmation modal helper

### 6.12 Janitor Pattern for Deduplication

**Problem:** Multi-device sync or interrupted operations can cause stale or duplicate documents in Gemini that don't match the runner's current local state.

**Key Principle:** The runner's local state is the single source of truth. Any Gemini document that doesn't match local state should be deleted, whether it's a duplicate or orphan.

#### Janitor Implementation

**File:** [`src/indexing/janitor.ts`](src/indexing/janitor.ts)

**Core Algorithm:**
1. Fetch all documents from Gemini (with pagination progress tracking)
2. Group documents by `obsidian_path_hash`
3. For each pathHash group:
   - Check if local state exists for this path
   - If local state exists and `geminiDocumentName` matches one of the docs → that doc is valid, all others are duplicates
   - If local state doesn't exist or doesn't match any doc → all docs are orphans
4. Delete all invalid documents (duplicates + orphans)

**Document Categories:**
- **Duplicates**: Multiple docs share the same pathHash, but only one matches `localState.geminiDocumentName`
- **Orphans**: Docs for paths with no local state, or local state that doesn't match any doc
- **No pathHash**: Docs without `obsidian_path_hash` metadata (definitely orphans)

**Implementation details:** See [`src/indexing/janitor.ts`](src/indexing/janitor.ts) for:
- `runDeduplication()` - Full cleanup with progress callbacks
- `findExistingDocument()` - Check if document exists by pathHash (cold path, rare)
- Phase-based progress reporting (fetching → analyzing → deleting-duplicates → deleting-orphans → complete)
- Per-document deletion with real-time progress updates

#### When to Run the Janitor

**Manual trigger only** (via settings button with dedicated progress UI)
- User explicitly runs deduplication when needed
- Shows real-time progress in `JanitorProgressModal`
- Only available on the designated "runner" machine
- Typically run after multi-device sync issues or interrupted operations

#### Integration with IndexManager

The `IndexManager` does NOT check for existing documents during normal indexing (hot path) - it uses local state only. This prevents expensive `listDocuments()` calls during bulk operations.

Stale documents created from sync edge cases are cleaned up by manual Janitor runs. The next indexing cycle will re-upload any missing documents based on current local state. See [`src/indexing/indexManager.ts`](src/indexing/indexManager.ts) in the `indexFile()` method.

---

## 7. Code Examples

### Example: Frontmatter Tag Extraction

**Implementation:** Tag extraction is implemented directly in `IndexManager.extractTags()` using MetadataCache. See [`src/indexing/indexManager.ts`](src/indexing/indexManager.ts) for the implementation that extracts tags from frontmatter.

### Example: Query with Metadata Filter

**IMPORTANT:** Metadata filtering is **only available during query operations** (generateContent, documents.query). You **cannot** filter documents by metadata when listing them via `listDocuments()`. To find documents by metadata, you must list all documents and filter them in memory (see Janitor implementation in Section 6.5).

**Implementation:** Metadata filtering examples are documented here for reference. The actual implementation will be in Phase 3 (Chat Interface). Key differences:
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

1. **`crypto`**: SHA-256 hashing (for content hashing, path hashing, and vault key generation)
   - Used in [`hashUtils.ts`](src/indexing/hashUtils.ts) for content/path hashing
   - Used in [`vault.ts`](src/utils/vault.ts) for vault key generation

**Implementation:**
- `RunnerStateManager` only loads on desktop: `if (Platform.isDesktopApp) { ... }`
- Settings UI hides runner toggle on mobile
- Hash utilities use Node.js crypto (synchronous, fast)
- Runner state uses browser localStorage (available everywhere, but runner only on desktop)

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
╔════════════════════════════════════════════╗
║ EzRAG Settings                            ║
╠════════════════════════════════════════════╣
║ Mobile Platform                            ║
║ Indexing is not available on mobile       ║
║ devices. The runner can only be enabled   ║
║ on desktop. You can still configure your  ║
║ API key and use chat/query features once  ║
║ they are implemented.                     ║
╠════════════════════════════════════════════╣
║ API Configuration                          ║
║ ┌──────────────────────────────────────┐  ║
║ │ Gemini API Key: [__________________] │  ║
║ └──────────────────────────────────────┘  ║
╠════════════════════════════════════════════╣
║ Store Management                           ║
║ [View Stats] [List Stores]                ║
╚════════════════════════════════════════════╝
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

### 8.9 IndexManager and IndexingController Separation

The indexing logic is split into two layers:

**IndexManager** (`indexManager.ts`):
- Core indexing operations (upload, delete, queue management)
- File event handlers (create/modify/rename/delete)
- Startup reconciliation
- Maintenance (rebuild, cleanup orphans)
- Queue control (pause/resume/clear)

**IndexingController** (`indexingController.ts`):
- Lifecycle management (start/stop indexing)
- Phase tracking (idle/scanning/indexing/paused)
- State persistence coordination (debounced saves)
- Event delegation to IndexManager
- UI subscription system

This separation provides:
- ✅ Clear separation of concerns
- ✅ IndexManager can be used independently (e.g., for MCP server)
- ✅ IndexingController handles Obsidian-specific lifecycle
- ✅ Easier testing of core indexing logic

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

### 8.11 Hot Path Performance: No Remote Checks

**Critical optimization:** The indexing hot path does NOT check Gemini for existing documents before uploading. This would require listing ALL documents via pagination, which is catastrophically expensive:

**Without this optimization (BAD):**
- Initial indexing of 5,000 files
- Each file calls `listDocuments()` = 250 API calls (pagination)
- Total: 5,000 × 250 = **1,250,000 API calls** 😱
- Time: ~10-15 hours just for API calls

**With this optimization (GOOD):**
- Initial indexing of 5,000 files
- Each file: 1 upload = 1 API call
- Total: 5,000 API calls ✅
- Time: ~20-30 minutes (with concurrency=2)

**Tradeoff:**
- Edge case duplicates can occur (e.g., stale local state after sync)
- These are cleaned up by manual Janitor deduplication (one-time cost)
- Janitor lists documents once, finds duplicates, deletes them
- Much better than checking on every single indexing operation

**Implementation:** See `indexManager.ts:350` - local state is the source of truth, no remote lookup.

### 8.12 Chat View Conversation State

When implementing the chat view (Phase 3), decide where conversation state lives:
- **Option 1:** Plugin state (persisted across restarts)
- **Option 2:** In-memory only (ephemeral)
- **Option 3:** LocalStorage-like (per-vault)

Also plan how to:
- Map grounding chunks back to Obsidian files (use `obsidian_path` metadata)
- Handle "open file at citation" links (use `workspace.openLinkText()`)

Don't overstuff [`main.ts`](main.ts)—give chat its own module in `ui/chatView.ts` (planned for Phase 3).

### 8.13 State Persistence Optimization

**Debounced State Saves:** The `IndexingController` batches state persistence with a 500ms debounce to avoid excessive disk writes during bulk indexing operations. This prevents:
- Performance degradation from frequent `saveData()` calls
- File system contention
- Obsidian sync conflicts

**Implementation:** See `indexingController.ts:schedulePersist()` - uses `setTimeout` to batch multiple state changes into a single save operation.

### 8.14 Empty File Handling

**Problem:** Gemini API cannot handle empty document content.

**Solution:** `IndexManager.indexFile()` checks for empty files and:
- Skips indexing (doesn't upload empty content)
- Deletes existing document if file was emptied
- Removes from local state

This prevents API errors and keeps state consistent.

### 8.15 Smart Reconciliation Prevents Duplicates

**Problem:** Running "Rebuild Index" would previously create duplicates because it cleared local state and re-uploaded everything.

**Solution:** Smart reconciliation compares local files with remote documents using `obsidian_content_hash` metadata:
- Fetches all remote documents when `syncWithRemote: true`
- Matches local files to remote docs by `pathHash`
- Restores local state for unchanged files (no re-upload)
- Only re-indexes files with changed content

**Performance**: For a 1000-file vault where only 10 files changed:
- **Without smart reconciliation**: 1000 uploads (duplicates everything)
- **With smart reconciliation**: 10 uploads (only changed files)

This makes "Rebuild Index" safe and efficient for recovering from sync issues.

---

## 9. Testing Strategy

### Unit Tests

**Status:** Unit tests are planned but not yet implemented. Test examples would cover:
- StateManager initialization and data management
- Hash computation consistency
- Content change detection

### Integration Tests

**Status:** Integration tests are planned but not yet implemented. Test examples would cover:
- IndexManager file indexing flow
- Event handling (create/modify/rename/delete)
- Queue processing and retry logic

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
- ✅ **Performance-optimized**: Synchronous hashing (Node crypto), single read/hash per file, non-blocking startup reconciliation, debounced state persistence
- ✅ **Desktop-optimized indexing**: Leverages Node.js for reliable per-machine state and fast crypto operations
- ✅ **Robust state management**: Deep merge for nested settings, external settings change handling, atomic operations
- ✅ **Production-ready**: Proper error handling, concurrency limits, graceful degradation, comprehensive UI feedback
- ✅ **Lifecycle management**: IndexingController provides clean start/stop/pause/resume with phase tracking
- ✅ **User control**: IndexingStatusModal provides real-time status and controls without disabling runner
- ✅ **Store management**: StoreManager enables non-runner devices to view store information
- ✅ **Well-documented**: Comprehensive implementation caveats and best practices sections

### Runner Pattern Summary

The **Runner Pattern** is the critical architectural decision for multi-device vaults:

**Problem:** Multiple devices indexing simultaneously causes:
- API overload (multiple uploads for same file)
- Duplicate documents in Gemini
- Race conditions and sync conflicts

**Solution:**
1. **Per-machine runner state** stored in localStorage (browser-native, non-synced):
   - Storage: `window.localStorage` with vault-specific key
   - Key format: `ezrag.runner.<pluginId>.<vaultKey>`
   - Contains: `isRunner` flag + device ID + timestamp
   - Isolated per vault, per machine, per browser instance

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

**Benefits of localStorage approach:**
- ✅ Browser-native, no filesystem dependencies
- ✅ Synchronous read/write, simpler code
- ✅ Automatic per-instance isolation
- ✅ No cross-platform path issues

This plan incorporates extensive feedback and is production-ready for desktop-only deployments with comprehensive multi-device support.
