# EzRAG - Obsidian Plugin for Semantic Search via Google Gemini

## Quick Start for Developers

**New to this codebase?** Start here:

1. **Read this file** for high-level overview and module guide
2. **Read ARCHITECTURE.md** for detailed design, data models, and implementation notes
3. **Key entry points**:
   - `main.ts` - Plugin lifecycle (start here to understand initialization)
   - `src/indexing/indexingController.ts` - Indexing lifecycle management
   - `src/indexing/indexManager.ts` - Core indexing logic
   - `src/gemini/geminiService.ts` - Gemini API integration

4. **Build and test**:
   ```bash
   npm install
   npm run dev  # Watch mode for development
   ```

5. **Critical concepts** to understand:
   - **Runner pattern**: Only one machine indexes per vault
   - **Hot path optimization**: No remote checks during file changes
   - **Queue persistence**: Uploads survive restarts
   - **Smart reconciliation**: Rebuild doesn't create duplicates

## What is EzRAG?

EzRAG is an Obsidian plugin that indexes your notes into Google Gemini's File Search API, enabling semantic search and AI-powered chat over your vault. Key features:

1. **Automatic Indexing**: Continuously syncs selected notes to Gemini as you edit
2. **Smart Change Detection**: Uses content hashing to avoid redundant uploads
3. **Multi-Device Support**: "Runner" pattern designates one machine to handle indexing
4. **Chat Interface**: Query your notes using natural language
5. **MCP Server** (planned): External tools can query your vault via Model Context Protocol

## How It Works

### The Runner Pattern (Critical Concept)

In multi-device setups (laptop + desktop), **only one machine** (the "runner") handles indexing:

- **Runner machine**: Monitors vault changes, uploads to Gemini, keeps index in sync
- **Non-runner machines**: Can query/chat but don't perform indexing
- **Runner state**: Stored in browser `localStorage` (per-machine, non-synced)
- **Plugin settings**: API key syncs via vault data, but runner status stays local

This prevents race conditions and duplicate documents when the same vault is open on multiple devices.

### Key Architectural Concepts

1. **Vault-centric identity**: Obsidian paths are primary identifiers
2. **Content-based change detection**: SHA-256 hashes detect real changes
3. **Delete-then-recreate**: Work with Gemini's immutable document model
4. **Metadata-driven mapping**: Store identity in Gemini customMetadata
5. **Queue persistence**: Uploads survive restarts/crashes via persisted queue
6. **Throttling**: Configurable debounce prevents rapid-fire uploads

## Environment & tooling

- Node.js: use current LTS (Node 18+ recommended).
- **Package manager: npm** (required - `package.json` defines npm scripts and dependencies).
- **Bundler: esbuild** (required - `esbuild.config.mjs` and build scripts depend on it).
- Types: `obsidian` type definitions + `@google/genai` SDK.
- **Desktop-only indexing**: Uses Node.js `crypto` module (mobile can query but not index)

## Module Guide: Where to Find Things

### Core Entry Points

- **`main.ts`**: Plugin lifecycle, event registration, command setup
  - Creates `IndexingController` and `StoreManager`
  - Registers vault events (after `onLayoutReady()` to prevent startup flooding)
  - Adds runner-only commands (rebuild-index, cleanup-orphans, run-janitor)
  - Status bar updates via controller subscription

### Runner Management

- **`src/runner/runnerState.ts`**: Per-machine runner state (localStorage-based)
  - `RunnerStateManager`: Check/set runner status for this device
  - Storage key: `ezrag.runner.<pluginId>.<vaultKey>` (vault-isolated)
  - Used to gate all indexing operations

### State & Persistence

- **`src/state/state.ts`**: Core state management (Obsidian-agnostic)
  - `StateManager`: Persisted data, indexed document tracking, queue entries
  - Can be reused by MCP server
- **`src/types.ts`**: All TypeScript interfaces
  - `PersistedData`, `PluginSettings`, `IndexState`, `IndexedDocState`, `IndexQueueEntry`

### Indexing Engine

- **`src/indexing/indexingController.ts`**: Lifecycle management
  - Start/stop/pause/resume indexing
  - Phase tracking (idle/scanning/indexing/paused)
  - State persistence coordination (debounced saves)
  - Event delegation to IndexManager

- **`src/indexing/indexManager.ts`**: Core indexing orchestrator
  - Queue management (p-queue with retry logic)
  - Event handlers (create/modify/rename/delete)
  - Startup reconciliation (with smart sync to avoid duplicates)
  - `indexFile()`: Hot path - uses local state only, no remote checks

- **`src/indexing/janitor.ts`**: Deduplication & orphan cleanup
  - Manual deduplication UI (finds duplicate/orphaned documents)
  - Lists all remote docs, compares with local state
  - Runner's local state is source of truth

- **`src/indexing/hashUtils.ts`**: Content & path hashing (Node.js crypto)

### Gemini Integration

- **`src/gemini/geminiService.ts`**: Gemini API wrapper (Obsidian-agnostic)
  - Store discovery/creation
  - Document upload/delete (with polling until complete)
  - File Search queries with metadata filters
  - Pagination support for listing (max 20 docs/page)

- **`src/gemini/types.ts`**: Gemini-specific types

### Store Management

- **`src/store/storeManager.ts`**: FileSearchStore operations
  - View stats, list all stores, delete store
  - Allows non-runner devices to inspect stores

### Connection Management

- **`src/connection/connectionManager.ts`**: Online/offline + API key validation
  - Listens for browser online/offline events
  - Derives `connected` flag (online AND key valid)
  - Pauses indexing when disconnected, auto-resumes when back online

### UI Components

- **`src/ui/settingsTab.ts`**: Settings UI
  - Conditional display based on platform and runner status
  - Desktop runner: Full controls (folders, concurrency, chunking, rebuild, janitor)
  - Non-runner/mobile: API key + read-only store management

- **`src/ui/indexingStatusModal.ts`**: Queue monitor
  - Live view of pending uploads/deletes
  - Shows throttle countdowns, retry attempts, readiness status
  - Real-time updates via controller subscription

- **`src/ui/janitorProgressModal.ts`**: Deduplication progress
  - Phase-based progress (fetching/analyzing/deleting)
  - Shows duplicates/orphans found and deleted

- **`src/ui/chatView.ts`**: Chat interface (query indexed notes)

### Utilities

- **`src/utils/vault.ts`**: Vault-specific utilities
  - `computeVaultKey()`: SHA-256 hash for localStorage keys

- **`src/utils/logger.ts`**: Logging utility
- **`src/utils/metadata.ts`**: Metadata builder for Gemini documents

### Future: MCP Server

- **`src/mcp/server.ts`**: (Planned) Standalone MCP server
  - Will expose `keywordSearch` and `semanticSearch` tools
  - Reuses `StateManager` and `GeminiService`

## Data Flow Quick Reference

**Hot Path (99% of operations):**
```
File saved → Vault event → Runner check → Compute hash →
Hash changed? → Queue upload (delete old + upload new) →
Poll until done → Update state → Debounced persist
```

**Janitor (manual deduplication):**
```
User clicks "Run Deduplication" → List ALL docs from Gemini →
Build pathHash groups → Compare with local state →
Delete duplicates (same path, wrong ID) + orphans (no local state)
```

**Smart Reconciliation (Rebuild Index):**
```
Clear local state → Fetch all remote docs → Match by pathHash + contentHash →
Unchanged files: Restore state (no upload) ✅
Changed files: Queue for re-index
New files: Queue for upload
```

For detailed architecture, data models, and implementation notes, see `ARCHITECTURE.md`.

### Install

```bash
npm install
```

### Dev (watch)

```bash
npm run dev
```

### Production build

```bash
npm run build
```

## Linting

- To use eslint install eslint from terminal: `npm install -g eslint`
- To use eslint to analyze this project use this command: `eslint main.ts`
- eslint will then create a report with suggestions for code improvement by file and line number.
- If your source code is in a folder, such as `src`, you can use eslint with this command to analyze all files in that folder: `eslint ./src/`

## File & folder conventions

EzRAG follows a domain-driven structure with clear separation of concerns:

```
src/
├── main.ts                  # Plugin entry point (lifecycle only)
├── types.ts                 # Shared TypeScript interfaces
├── runner/
│   └── runnerState.ts      # Per-machine runner state (localStorage)
├── state/
│   └── state.ts            # State management (Obsidian-agnostic)
├── gemini/
│   ├── geminiService.ts    # Gemini API wrapper (Obsidian-agnostic)
│   └── types.ts            # Gemini-specific types
├── indexing/
│   ├── indexingController.ts  # Lifecycle (start/stop/pause)
│   ├── indexManager.ts     # Core orchestrator + queue
│   ├── janitor.ts          # Deduplication + cleanup
│   └── hashUtils.ts        # Content hashing (Node crypto)
├── store/
│   └── storeManager.ts     # Store operations (stats, list, delete)
├── connection/
│   └── connectionManager.ts # Online/offline + API key tracking
├── ui/
│   ├── settingsTab.ts      # Settings UI
│   ├── indexingStatusModal.ts  # Queue monitor
│   ├── janitorProgressModal.ts # Deduplication progress
│   └── chatView.ts         # Chat interface
├── mcp/
│   └── server.ts           # MCP server (planned)
└── utils/
    ├── logger.ts           # Logging
    ├── metadata.ts         # Metadata builder
    └── vault.ts            # Vault utilities (key generation)
```

**Key Principles:**
- **Obsidian-agnostic layers**: `state.ts` and `geminiService.ts` can be reused by MCP server
- **Small main.ts**: Plugin lifecycle only (~400 lines), delegates to controllers
- **Desktop-only modules**: `hashUtils.ts`, `runnerState.ts` use Node.js APIs
- **No build artifacts in git**: `main.js` is generated, not committed

## Manifest rules (`manifest.json`)

- Must include (non-exhaustive):  
  - `id` (plugin ID; for local dev it should match the folder name)  
  - `name`  
  - `version` (Semantic Versioning `x.y.z`)  
  - `minAppVersion`  
  - `description`  
  - `isDesktopOnly` (boolean)  
  - Optional: `author`, `authorUrl`, `fundingUrl` (string or map)
- Never change `id` after release. Treat it as stable API.
- Keep `minAppVersion` accurate when using newer APIs.
- Canonical requirements are coded here: https://github.com/obsidianmd/obsidian-releases/blob/master/.github/workflows/validate-plugin-entry.yml

## Testing

- Manual install for testing: copy `main.js`, `manifest.json`, `styles.css` (if any) to:
  ```
  <Vault>/.obsidian/plugins/<plugin-id>/
  ```
- Reload Obsidian and enable the plugin in **Settings → Community plugins**.

## Commands & settings

- Any user-facing commands should be added via `this.addCommand(...)`.
- If the plugin has configuration, provide a settings tab and sensible defaults.
- Persist settings using `this.loadData()` / `this.saveData()`.
- Use stable command IDs; avoid renaming once released.

## Versioning & releases

- Bump `version` in `manifest.json` (SemVer) and update `versions.json` to map plugin version → minimum app version.
- Create a GitHub release whose tag exactly matches `manifest.json`'s `version`. Do not use a leading `v`.
- Attach `manifest.json`, `main.js`, and `styles.css` (if present) to the release as individual assets.
- After the initial release, follow the process to add/update your plugin in the community catalog as required.

## Security, privacy, and compliance

Follow Obsidian's **Developer Policies** and **Plugin Guidelines**. In particular:

- Default to local/offline operation. Only make network requests when essential to the feature.
- No hidden telemetry. If you collect optional analytics or call third-party services, require explicit opt-in and document clearly in `README.md` and in settings.
- Never execute remote code, fetch and eval scripts, or auto-update plugin code outside of normal releases.
- Minimize scope: read/write only what's necessary inside the vault. Do not access files outside the vault.
- Clearly disclose any external services used, data sent, and risks.
- Respect user privacy. Do not collect vault contents, filenames, or personal information unless absolutely necessary and explicitly consented.
- Avoid deceptive patterns, ads, or spammy notifications.
- Register and clean up all DOM, app, and interval listeners using the provided `register*` helpers so the plugin unloads safely.

## UX & copy guidelines (for UI text, commands, settings)

- Prefer sentence case for headings, buttons, and titles.
- Use clear, action-oriented imperatives in step-by-step copy.
- Use **bold** to indicate literal UI labels. Prefer "select" for interactions.
- Use arrow notation for navigation: **Settings → Community plugins**.
- Keep in-app strings short, consistent, and free of jargon.

## Performance

- Keep startup light. Defer heavy work until needed.
- Avoid long-running tasks during `onload`; use lazy initialization.
- Batch disk access and avoid excessive vault scans.
- Debounce/throttle expensive operations in response to file system events.

## Coding conventions

- TypeScript with `"strict": true` preferred.
- **Keep `main.ts` minimal**: Focus only on plugin lifecycle (onload, onunload, addCommand calls). Delegate all feature logic to separate modules.
- **Split large files**: If any file exceeds ~200-300 lines, consider breaking it into smaller, focused modules.
- **Use clear module boundaries**: Each file should have a single, well-defined responsibility.
- Bundle everything into `main.js` (no unbundled runtime deps).
- Avoid Node/Electron APIs if you want mobile compatibility; set `isDesktopOnly` accordingly.
- Prefer `async/await` over promise chains; handle errors gracefully.

## Mobile

- Where feasible, test on iOS and Android.
- Don't assume desktop-only behavior unless `isDesktopOnly` is `true`.
- Avoid large in-memory structures; be mindful of memory and storage constraints.

## Agent do/don't

**Do**
- Add commands with stable IDs (don't rename once released).
- Provide defaults and validation in settings.
- Write idempotent code paths so reload/unload doesn't leak listeners or intervals.
- Use `this.register*` helpers for everything that needs cleanup.

**Don't**
- Introduce network calls without an obvious user-facing reason and documentation.
- Ship features that require cloud services without clear disclosure and explicit opt-in.
- Store or transmit vault contents unless essential and consented.

## Common tasks for EzRAG development

### Adding a new indexing operation

When adding new operations to the indexing pipeline:

1. **Add to IndexManager** (`src/indexing/indexManager.ts`):
   ```ts
   async yourNewOperation(file: TFile) {
     // Check runner status first
     if (!this.runnerManager.isRunner()) return;

     // Queue the operation with retry logic
     await this.queueIndexJob(file.path, async () => {
       // Your operation logic here
     });
   }
   ```

2. **Update IndexingController** if lifecycle management needed
3. **Add UI controls** in `settingsTab.ts` if user-facing

### Accessing Gemini FileSearch API

All Gemini operations go through `GeminiService` (`src/gemini/geminiService.ts`):

```ts
const gemini = new GeminiService(apiKey, logger);

// Upload a document
const docId = await gemini.uploadDocument({
  storeName: "my-store",
  displayName: "Note.md",
  mimeType: "text/plain",
  content: fileContent,
  metadata: { /* custom metadata */ },
  chunkingConfig: { maxTokensPerChunk: 400 }
});

// Query with metadata filters
const results = await gemini.fileSearch(
  storeName,
  "your query",
  [{ key: "tag", stringValue: "important" }]
);
```

### Working with persisted state

State management is centralized in `StateManager` (`src/state/state.ts`):

```ts
// Get indexed document state
const docState = this.stateManager.getDocumentState(filePath);

// Update state
this.stateManager.setDocumentState(filePath, {
  path: filePath,
  contentHash: hash,
  geminiDocumentName: docId,
  status: 'ready',
  lastIndexed: Date.now()
});

// Queue persistence (debounced)
await this.stateManager.persist();
```

### Checking runner status

Always gate indexing operations with runner checks:

```ts
// In any indexing-related code
if (!this.runnerManager.isRunner()) {
  this.logger.debug("Skipping operation - not the runner");
  return;
}

// For UI visibility
if (Platform.isDesktopApp && this.plugin.runnerManager?.isRunner()) {
  // Show runner-only controls
}
```

### Adding UI settings

Settings are conditionally displayed based on platform and runner status:

```ts
// In settingsTab.ts
if (Platform.isDesktopApp && this.plugin.runnerManager?.isRunner()) {
  new Setting(containerEl)
    .setName("Runner-only setting")
    .setDesc("Only visible on desktop runner")
    .addText(text => text
      .setPlaceholder("Enter value")
      .setValue(this.plugin.settings.value)
      .onChange(async (value) => {
        this.plugin.settings.value = value;
        await this.plugin.saveSettings();
      })
    );
}
```

### Registering vault event handlers

**Critical:** Register vault events AFTER layout ready to prevent startup flooding:

```ts
// In main.ts onload()
this.app.workspace.onLayoutReady(() => {
  this.registerEvent(
    this.app.vault.on('modify', (file) => {
      if (file instanceof TFile && file.extension === 'md') {
        this.indexingController?.handleFileModified(file);
      }
    })
  );
});

## Troubleshooting

### General Obsidian Plugin Issues

- Plugin doesn't load: ensure `main.js` and `manifest.json` are at top level of `<Vault>/.obsidian/plugins/ezrag/`
- Build issues: run `npm run build` or `npm run dev` to compile TypeScript
- Commands not appearing: verify `addCommand` runs after `onload` and IDs are unique
- Settings not persisting: ensure `loadData`/`saveData` are awaited

### EzRAG-Specific Issues

**Indexing not working:**
1. Check runner status: Settings → "This machine is the runner" enabled?
2. Check connection: Status bar shows "Connected" or shows API key error?
3. Check queue: Open Queue Monitor from settings to see pending uploads
4. Check console: Look for errors in developer console (Ctrl+Shift+I)

**Duplicate documents in Gemini:**
1. Run deduplication: Settings → "Run Deduplication"
2. Check that only ONE device has runner enabled
3. Verify runner state: Check localStorage key `ezrag.runner.*` in console

**Files not updating after edits:**
1. Check if hash changed: Empty edits won't trigger re-index
2. Check throttle: Default 3s delay before upload (configurable)
3. Check queue readiness: Queue Monitor shows countdown

**API errors (429 rate limit):**
1. Reduce concurrency: Settings → Upload Concurrency (try 1-2)
2. Increase throttle: Settings → Upload Throttle (try 5000ms)
3. Pause indexing temporarily: Settings → Pause button

**State corruption after sync:**
1. Run "Rebuild Index" with smart reconciliation (doesn't duplicate!)
2. Only run from ONE device (the designated runner)
3. If still broken, clear local state and rebuild

**Mobile: "Indexing not available":**
- Expected behavior - mobile can only query/chat, not index
- Ensure desktop runner is indexing your notes
- Check that API key synced via vault data

## Key Implementation Constraints

### Gemini API Limitations

1. **No metadata filtering during listing**: `listDocuments()` doesn't support metadata filters
   - Must fetch ALL documents and filter in memory
   - Janitor uses this approach (see `janitor.ts`)
   - Metadata filters ONLY work in query operations (`generateContent`, `documents.query`)

2. **Documents are immutable**: Can't update in place
   - Always delete-then-recreate for modifications
   - Store document name in state, don't parse it

3. **Upload polling required**: Uploads are async operations
   - Poll `operation.done` until `true`
   - Each upload can take 10-60+ seconds
   - Concurrency limit applies to entire lifecycle (including polling)

4. **Pagination limits**: Max 20 documents per page
   - For 5,000 docs = 250 API calls to list all
   - Takes ~10-15 seconds to fetch all pages
   - Only used by Janitor (manual, not hot path)

### Performance Critical Paths

**Hot path (file modifications):**
- ✅ Uses local state only (no remote lookup)
- ✅ Single hash computation per file
- ✅ Queue-based with retry logic
- ✅ Debounced state persistence (500ms)
- ❌ Never check remote for duplicates (too expensive!)

**Cold path (Janitor, Rebuild):**
- Fetch all remote documents (expensive but rare)
- Build in-memory maps for comparison
- Only run manually when needed

### Mobile vs Desktop

- **Desktop runner**: Full indexing capabilities
  - Uses Node.js `crypto` for hashing
  - Stores runner state in localStorage
  - Can read/write vault files

- **Mobile/Non-runner**: Query-only
  - No access to Node.js APIs
  - Can use chat interface
  - Can view store stats
  - Settings are read-only for indexing controls

### State Management

- **Plugin settings**: Sync via Obsidian vault data (`.obsidian/plugins/ezrag/data.json`)
  - API key, folder config, chunking settings
  - Syncs across all devices via Obsidian Sync/git/etc.

- **Runner state**: Per-machine localStorage (non-synced)
  - `isRunner` flag + device ID
  - Key: `ezrag.runner.<pluginId>.<vaultKey>`
  - Prevents cross-device indexing conflicts

- **Queue persistence**: Inside plugin state (survives restarts)
  - Pending uploads/deletes
  - Retry counters, readyAt timestamps
  - Drained when connection available

## References

### EzRAG Documentation

- **ARCHITECTURE.md**: Detailed architecture, data models, implementation notes
- **src/types.ts**: All TypeScript interfaces
- **src/gemini/geminiService.ts**: Gemini API wrapper examples

### Obsidian Resources

- Obsidian sample plugin: https://github.com/obsidianmd/obsidian-sample-plugin
- API documentation: https://docs.obsidian.md
- Developer policies: https://docs.obsidian.md/Developer+policies
- Plugin guidelines: https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines
- Style guide: https://help.obsidian.md/style-guide
