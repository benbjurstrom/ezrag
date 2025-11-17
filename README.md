# EzRAG – AI-Powered Search for Obsidian Notes

EzRAG turns your Obsidian vault into a [Gemini File Search](https://blog.google/technology/developers/file-search-gemini-api/) index so you can run semantic search, chat over your notes, and expose your vault through MCP tools. Everything stays in your Google account; the plugin simply keeps the index up to date.

<img width="716" height="507" alt="Chat Interface Screenshot" src="https://github.com/user-attachments/assets/4026c1aa-0a9e-43f0-bbb8-31b95e645244" />

## Highlights

- Semantic search + AI chat with inline citations
- Smart runner pattern: one desktop keeps the index in sync, other devices can query
- Built-in MCP server so external agents can query or fetch notes
- Automatic deduplication, queue persistence, and rebuild workflows

## Getting Started

### Requirements

- Google Gemini API key ([get one free](https://aistudio.google.com/))
- Obsidian desktop app for indexing (mobile can query/read-only)

### Install

**Option 1 – BRAT (recommended)**
1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) from Community Plugins.
2. BRAT settings → **Add Beta Plugin** → `https://github.com/yourusername/ezrag`.
3. Enable EzRAG in Community Plugins.

**Option 2 – Manual**
1. Clone into your vault:  
   ```bash
   cd /path/to/vault/.obsidian/plugins
   git clone https://github.com/yourusername/ezrag
   ```
2. Build once:  
   ```bash
   cd ezrag
   npm install
   npm run build
   ```
3. Restart Obsidian and enable EzRAG.

### Configure

1. Settings → **EzRAG** → enter your Gemini API key.
2. On desktop, toggle **This machine is the runner** to let it index.

<img width="826" height="591" alt="Settings Screenshot" src="https://github.com/user-attachments/assets/8d3d2470-b305-4114-91ed-b8778af66e1e" />

## Using EzRAG

### Chat

Open via the ribbon icon or `EzRAG: Open Chat`. Try prompts like:
- “What are my notes about the Johnson project?”
- “Summarize yesterday’s meeting notes.”
- “Find all mentions of machine learning.”

### MCP Server

Enable **Settings → EzRAG → MCP Server** to let tools connect.

Connect from Claude Code:
```bash
claude mcp add --transport http ezrag-obsidian-notes http://localhost:42427/mcp
```

Tools provided:
- `keywordSearch` – keyword/regex search
- `semanticSearch` – Gemini-backed semantic search with citations
- `note:///<path>` – direct note retrieval

## How It Works

### Indexing basics

- Only `.md` files are indexed; changes trigger hashing + re-upload if content changed.
- Runner enforcement prevents multiple machines from uploading the same file.
- Upload queue persists across restarts and surfaces status in the UI.

<img width="881" height="500" alt="Upload Queue Screenshot" src="https://github.com/user-attachments/assets/a1a51b87-2e8a-461a-8f6b-59ef0dea1098" />

### Limits & costs

Gemini File Search pricing ([details](https://ai.google.dev/gemini-api/docs/file-search#pricing)):
- Indexing: ~$0.15 per 1M tokens (storage free; standard model rates for queries)
- Max file size: 100 MB; free tier ≈1 GB total storage (higher tiers up to 1 TB)
- For best performance keep stores under ~20 GB

### Data control

- Documents live in your Google account. Manage/delete stores via **Settings → Manage Stores**.
- No telemetry or note data leaves your machine beyond the Gemini File Search uploads.

## Links

- [Issues](https://github.com/benbjurstrom/ezrag/issues)
- [Discussions](https://github.com/benbjurstrom/ezrag/discussions)
- [License](LICENSE) (MIT)
