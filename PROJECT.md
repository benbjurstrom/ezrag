Here’s a structured “big picture” summary you can hand to a junior (or your future self) that explains **what we’re building**, **how it hangs together**, and **why** we made the specific design choices.

---

## 1. Overall Goal

We’re building an Obsidian plugin that:

1. **Indexes selected notes from an Obsidian vault into Google Gemini’s File Search** (a `FileSearchStore`).
2. **Keeps that index in sync over time** as notes are created, edited, renamed, or deleted.
3. **Persists state across Obsidian restarts** so indexing is incremental and efficient.
4. Exposes:

   * **Progress feedback** (e.g. “Indexing 126 of 724 notes”).
   * A **settings UI** for API key and folder selection.
5. Is architected so we can later add:

   * A **“chat with your vault”** screen using Gemini + File Search.
   * A **TypeScript MCP server** that exposes both native Obsidian-style keyword search and semantic search via the File Search index.

---

## 2. Key Constraints & Assumptions

These constraints drive most of the architecture:

1. **Obsidian plugin model**

   * Runs in an Electron/Node-ish environment.
   * Gives us:

     * `this.loadData()/this.saveData()` for persistent JSON.
     * Access to vault files (`vault.getMarkdownFiles()`, `vault.read()`).
     * Events for `create`, `modify`, `delete`, `rename`.
   * Obsidian data should live inside the vault (plugin folder) so it syncs naturally with the vault.

2. **Gemini File Search constraints**

   * You **cannot update a Document in-place**; you must:

     * **Delete** the old document, then
     * **Re-upload** the content as a new document.
   * `Document.name` is an opaque resource string (like `fileSearchStores/…/documents/…`) and is server-assigned when using `uploadToFileSearchStore`.
   * `Document.displayName` is:

     * Human-readable
     * Fully under our control
     * Not required to be unique, but we can make it unique if we want.
   * `customMetadata[]` lets us store key/value pairs for identity, tags, path, etc.

3. **Indexing scale & UX**

   * There may be **hundreds or thousands of notes**.
   * We don’t want to freeze the UI, so indexing must be **queued** and **throttled**.
   * Users need clear **progress indication** and the ability to see what’s going on.

4. **Changes may happen while Obsidian is closed**

   * Files can be modified, renamed, or deleted by external tools / sync clients.
   * On startup, we must **reconcile the vault and the remote index** even if no events fired while the app was running.

---

## 3. High-Level Architecture

We split the system into a few conceptual layers:

1. **Persistent State Layer**

   * Single JSON blob stored via `loadData()/saveData()`.
   * Tracks:

     * Plugin settings (API key, included folders, concurrency, store name).
     * Per-file index state (path, Gemini doc name, hash, tags, status, etc.).

2. **Gemini Integration Layer**

   * A `geminiService` module that wraps:

     * Client initialization (API key).
     * Store discovery/creation by vault name.
     * Document upload (delete + upload semantics).
     * Document listing and deletion.
     * (Later) File Search-based chat helpers.

3. **Indexing Engine**

   * A simple Job Queue (concurrency-limited).
   * The logic that decides:

     * Which files *need* indexing.
     * When to run full scans.
     * How to handle events (modify, rename, delete).

4. **Obsidian Integration / UI**

   * Plugin entry (`main.ts`).
   * Settings tab for configuration.
   * Progress indicators (status bar, optional detailed view).
   * Event wiring to `vault` and `workspace`.

5. **Future Consumers**

   * Chat UI (inside Obsidian).
   * MCP server (outside Obsidian) that reads the same state + calls the same Gemini service.

The idea is: **state** and **Gemini integration** are shared building blocks, while the Obsidian plugin and MCP server are just different front-ends on top of them.

---

## 4. Persistent State Model (and Why)

We maintain a single `PersistedData` structure:

* `version`: for migrations when we change schema/logic.
* `settings`:

  * `apiKey`: user’s Gemini key.
  * `storeName`: name of the FileSearchStore used for this vault.
  * `includeFolders`: optional list of folders to index (empty = whole vault).
  * `maxConcurrentUploads`: throttle level for indexing jobs.
* `index`:

  * `docs: Record<vaultPath, IndexedDocState>` where each entry tracks:

    * `vaultPath`: Obsidian path (e.g. `Projects/Client/Notes.md`).
    * `geminiDocumentName`: remote Document resource name (for deletion).
    * `contentHash`: hash of the note content at the time we indexed it.
    * `pathHash`: hash of the vault path (for metadata identity).
    * `status`: `'pending' | 'ready' | 'error'`.
    * `lastLocalMtime`, `lastIndexedAt`, `tags`, `errorMessage?`.

**Why this design:**

* We key everything by **vault path**, which is the most stable and intuitive identity inside Obsidian.
* We store `geminiDocumentName` as **opaque remote handle** purely for deletion; we never depend on its structure.
* `contentHash` lets us detect **any content change**, regardless of how or when it happened.
* `pathHash` gives us a compact, stable ID for systems that prefer fixed-length identifiers (MCP, external tools), and can be mirrored into Gemini metadata.
* Storing tags and timestamps makes the data **self-describing** and useful for later UI (e.g. last indexed at X).

---

## 5. Gemini File Search Store Strategy

### Store identity

* **Display name of the store** is always the **vault name**.
* On startup:

  * We **list stores by displayName** and try to find one whose `displayName` matches `vault.getName()`.
  * If found, we use its `name` (resource ID).
  * If not, we **create a new store** with `displayName = vault name`.

**Why:**

* Users mentally think in terms of “this vault”, not raw store IDs.
* If they move the vault to another machine, re-running the plugin re-discovers or re-creates the same concept (“the store for this vault”) by human-readable name.
* We still store `storeName` (the resource ID) so we don’t have to re-list every time.

---

## 6. Document Identity & Metadata Strategy

We considered a few options (base64 path as displayName, hashing, etc.). We settled on:

1. **`Document.displayName` should be human-friendly**

   * Recommended: **full Obsidian path** (e.g. `Projects/Client/Notes.md`).

     * Unique enough within a vault.
     * Very readable in the Gemini console or logs.
   * Alternatively we could use just `basename` (filename), but full path avoids name collisions.

2. **True identity lives in `customMetadata`**, not in `name` or `displayName`.
   For each Document we attach metadata such as:

   * `obsidian_vault = <vaultName>`
   * `obsidian_path = <vaultPath>`
   * `obsidian_path_hash = hash(vaultPath)` (optional but recommended)
   * `tag = <tag>` (multiple entries)
   * Maybe `obsidian_folder = top-level folder`.

3. `Document.name` (the resource ID) is:

   * Stored in `IndexedDocState.geminiDocumentName`.
   * Used purely as a handle to delete or reference specific docs.
   * Not part of the “logical identity”; that’s path + vault.

**Why this design:**

* **Separation of concerns:**

  * `displayName` is for humans.
  * `customMetadata` is for programmatic mapping.
  * `Document.name` is for the API.
* We can change the displayName strategy in the future without breaking mapping logic, because **mapping always uses `obsidian_path` / `obsidian_path_hash`.**
* Hashing path in metadata is cheap and gives us a robust ID we can use in future systems (MCP, other tooling) without leaking full paths if we don’t want to.

---

## 7. Indexing Lifecycle & Hashing Strategy

We want to:

* Avoid re-indexing when nothing changed.
* Detect changes made both inside and outside of Obsidian.

### Content hashes

For each file we compute a **content hash** (e.g. SHA-256 of the markdown text). We store it in `contentHash` alongside the rest of the state.

**Decision rule:**

* On a full scan or modify event:

  * If **no state entry** exists → index.
  * Else if `contentHash` **differs from** the newly computed hash → reindex.
  * Else if state is `'error'` → reindex (retry).
  * Else (hash unchanged, status ready) → no Gemini calls.

**Why hashing instead of just mtime:**

* mtime can be unreliable across sync tools, OS differences, or partial edits.
* Hash is a **strong, content-level** indicator; if the hash hasn’t changed, we know the body is identical.
* This makes startup scans efficient: we re-hash and skip most notes without touching Gemini.

---

## 8. Delete-Then-Recreate Indexing semantics

### Steady-state reindexing (happy path)

For a file that needs reindexing:

1. Look up `state = index.docs[vaultPath]`.
2. If `state.geminiDocumentName` is set:

   * Call `deleteDocument(state.geminiDocumentName)`.
3. Upload new document for the file:

   * `displayName = vaultPath` (human-friendly).
   * `customMetadata` includes `obsidian_path`, `obsidian_vault`, tags, etc.
4. Save returned `Document.name` into `state.geminiDocumentName`.
5. Update `contentHash`, `status = 'ready'`, etc.

No listing involved.

### Delete / rename inside Obsidian

* On **delete**:

  * Use `state.geminiDocumentName` (if present) to delete that doc directly.
  * Remove `index.docs[vaultPath]`.

* On **rename**:

  * Use `state.geminiDocumentName` for `oldPath` to delete the old doc.
  * Move/transform the state entry from `oldPath` → `newPath`.
  * Enqueue indexing for `newPath` (which will upload a new doc and store the new name).

Again, no listing needed here.

### Cleanup / orphan detection

This is where we intentionally **do** list:

1. List all documents in the store.
2. For each:

   * Look at `customMetadata.obsidian_path` / `obsidian_path_hash`.
   * If it points to a path that doesn’t exist in the vault → delete.
   * If there’s no such metadata → assume it’s not “owned” by our plugin and leave it alone.

And optionally:

* Use this same routine to detect “strays” (docs that have our metadata but no local state entry in `index.docs`), and either:

  * Clean them up, or
  * Rebuild `index.docs` from the remote metadata.

---

## 9. Queue & Progress Reporting

### Queue

We use a simple concurrency-limited job queue (our own small class or something like `p-queue`), which:

* Holds a list of async jobs (`() => Promise<void>`).
* Runs up to `maxConcurrentUploads` jobs at a time.
* Continues until empty.

**Why:**

* We don’t want to spike API calls or block the UI with one giant `for/await`.
* Concurrency of 1–3 is usually a good balance between speed and stability.
* Having a queue also gives us the ability to pause/cancel in the future.

### Progress accounting

The plugin tracks:

* `totalToIndex`: how many files we plan to index in the current run.
* `completed`: successfully indexed files.
* `failed`: files that errored.

We surface this in the UI:

* **Status bar item**:

  * Shows states like:

    * `"Gemini Index: idle"`
    * `"Gemini Index: 126 / 724 (pending 10, failed 3)"`.
* (Optional) Detailed view:

  * A side-pane listing files with their status, last indexed time, and error messages.

**Why:**

* Long-running indexing without feedback feels broken.
* Having both a coarse progress bar and a detailed view gives power users insight into what’s happening without overwhelming everyone.

---

## 10. Handling Vault Events (Create / Modify / Rename / Delete)

We listen to Obsidian’s vault events and feed them into the indexing engine.

### Create

* If the new file is:

  * Markdown, and
  * In an included folder
* Then:

  * Read its contents, compute hash.
  * Create/overwrite its `IndexedDocState` with `status = 'pending'`.
  * Enqueue an index job.

### Modify

* When a file is modified:

  * Re-read contents, compute new hash.
  * If hash unchanged & status ready → do nothing.
  * Otherwise:

    * Update state (`contentHash`, `status = 'pending'`, etc.).
    * Enqueue an index job.

### Rename

* When a file is renamed:

  * Old path and new path are different.
  * We:

    1. Delete any Gemini docs whose metadata `obsidian_path = oldPath`.
    2. Update local state:

       * Remove old entry, create new one under `newPath`.
       * Mark as `'pending'`.
    3. Enqueue indexing for the new path.

### Delete

* When a file is deleted inside Obsidian:

  * Delete any Gemini docs whose metadata `obsidian_path = deletedPath`.
  * Remove local state entry.

**Why event-driven as well as startup scanning:**

* **Events catch changes while the app is open** and let us index quickly and incrementally.
* **Startup full scan with hashes** catches changes that happen while Obsidian/plugin was shut down.
* Together, they keep the store in sync with minimal redundant work.

---

## 11. Orphan Document Cleanup

There will be cases where:

* Documents exist in the File Search store that no longer correspond to any file in the vault.
  Examples:

  * File deleted or moved by a sync tool while Obsidian was offline.
  * Old entries from an earlier version of the plugin or from a different system.

We handle this via a **cleanup routine**:

1. List all documents in the FileSearchStore.
2. For each document:

   * Look for metadata `obsidian_path` (and/or `obsidian_path_hash`).
   * If missing → assume it’s not owned by this plugin; leave it alone.
   * If present:

     * Check if the path exists in the vault.
     * If not, delete the document and remove any local state entry.

This can be:

* Exposed as a **manual command** (“Clean up orphaned Gemini documents”).
* Optionally run automatically at startup (but manual is safer initially, to avoid unexpected deletions).

**Why we need this:**

* Guarantees the File Search index doesn’t slowly fill with junk over time.
* Keeps remote state in line with the local reality of the vault.
* Respects the possibility of *other* systems using the same store by only touching docs that have “our” metadata.

---

## 12. Settings & UX Decisions

The plugin exposes a settings tab for:

* **Gemini API key**

  * Required for any indexing/search.
* **Folders to index**

  * Let users limit indexing to specific folders (e.g. only `Knowledge/` and `Projects/`, not their entire vault).
* **Upload concurrency**

  * Allows tuning based on network / rate limits.
* **Rebuild index**

  * Clears local index state and enqueues everything for reindex.

**Why:**

* Make configuration explicit and discoverable.
* Let users control scope (privacy & cost).
* Provide a “panic button” to reset the index if something goes out of sync.

---

## 13. Future Extensions: Chat & MCP

The architecture is intentionally designed to make the following easy later:

### 13.1 “Chat with your docs” view

* A custom Obsidian view that:

  * Uses `this.data.settings.storeName`.
  * Calls a `geminiService.chatWithStore(...)` helper that:

    * Uses the File Search tool with the store.
    * Returns grounded responses.
  * Maps references in Gemini responses back to Obsidian files via:

    * `customMetadata.obsidian_path`, or
    * `displayName` if we set it to full path.

**Why the current design helps:**

* Store name and mapping are already persisted and abstracted away.
* The chat view just becomes another consumer of the same `geminiService`.

### 13.2 TypeScript MCP server

* A standalone MCP server that:

  * Reads `.obsidian/plugins/<plugin-id>/data.json` for:

    * Store name
    * API key
    * Index state (mapping vault paths ↔ documents).
  * Exposes tools like:

    * `obsidian.keywordSearch(query)` — uses local files for string matching.
    * `obsidian.semanticSearch(query, tags?)` — uses the FileSearchStore and metadata filters.

Because we kept:

* `state.ts` free of Obsidian-specific imports.
* `geminiService.ts` free of Obsidian-specific imports.

… the MCP server can reuse those modules with minimal friction. Obsidian and MCP end up sharing a single “source of truth” for index state and integration logic.

---

## 14. Summary of the Big Decisions (and Why)

1. **Use Obsidian’s `loadData/saveData` for persistence**

   * Keeps data vault-local.
   * Syncs with the vault across devices.
   * No extra storage dependency.

2. **Store-level identity = vault name**

   * Easier mental model for users.
   * Simple discovery by displayName.

3. **Document-level identity in metadata, not displayName or name**

   * `obsidian_path`, `obsidian_path_hash`, `obsidian_vault`, `tag`, etc.
   * Robust against future displayName changes and allows multi-system usage.

4. **Human-friendly `displayName` (full path or filename)**

   * Console and debug experience is nicer.
   * Collisions aren’t impactful because mapping uses metadata.

5. **Delete-then-recreate for reindexing**

   * Required by Gemini’s API semantics.
   * Made safe and deterministic via metadata matching.

6. **Content hashes for change detection**

   * Exact, content-based signal for “did this note change?”
   * Works even for changes outside Obsidian while it’s closed.

7. **Concurrency-limited queue for indexing**

   * Prevents UI freeze and API overload.
   * Natural place to implement progress reporting.

8. **Event + startup scanning combo**

   * Events handle live editing.
   * Startup scan with hashes handles offline changes.

9. **Orphan cleanup by metadata**

   * Keeps remote index clean without touching unrelated docs.

10. **Separation of concerns**

    * State, Gemini integration, Obsidian wiring, and future MCP/chat logic are modular.
    * Makes it easy to grow this into a full “vault search platform” over time.

---

If you want, I can take this and refactor it into a formal `ARCHITECTURE.md` outline with numbered sections, “requirements / non-goals / open questions” headers, so it slots directly into a repo.
