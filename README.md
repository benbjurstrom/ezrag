# EzRAG - AI-Powered Search for Obsidian

Index your Obsidian vault with Google Gemini's File Search API for semantic search and AI chat.

## Features

- **AI Chat Interface** - Ask questions about your notes in natural language
- **Automatic Indexing** - Keeps notes synced with Gemini as you edit
- **MCP Server** - External tools (Claude Code, etc.) can query your vault
- **Multi-Device Safe** - Designate one "runner" machine to prevent conflicts
- **Smart Sync** - Only re-indexes when content actually changes

## Quick Start

1. Get API key from [Google AI Studio](https://ai.google.dev/)
2. Install plugin: Settings → Community Plugins → Browse → "EzRAG"
3. Configure: Settings → EzRAG
   - Add your API key
   - Enable "This machine is the runner" (desktop only)
4. Plugin automatically creates a FileSearch store and indexes your vault

**Multi-Device Setup:** Install on all devices, but enable "runner" on **one desktop only**. The API key syncs via your vault; other devices use the index without indexing themselves.

## Chat Interface

Open chat via ribbon icon or command palette and ask questions:
- "Summarize my meeting notes from last week"
- "What did I write about machine learning?"
- "Find all references to the Johnson project"

## MCP Server

Enable external tools to query your vault:

1. Settings → MCP Server → Enable
2. Connect from Claude Code or other MCP clients:

```bash
claude mcp add --transport http ezrag-obsidian-notes http://localhost:42427/mcp
```

**Available Tools:**
- `keywordSearch` - Search vault by keyword or regex
- `semanticSearch` - AI-powered semantic search
- `note:///<path>` - Read note contents by path

## Commands

Access via Command Palette (Cmd/Ctrl+P):

- **Rebuild Index** - Force re-index all files (uses smart reconciliation to avoid duplicates)
- **Clean Up Gemini Index** - Remove orphaned or duplicate documents from Gemini
- **Open Queue** - Monitor indexing progress and pending uploads

**Store Management:** Click "Manage Stores" button in settings to view, switch, or delete FileSearch stores.

## Settings Overview

Configure in Settings → EzRAG:

- **Included Folders** - Limit indexing to specific folders (empty = entire vault)
- **Upload Concurrency** - Number of simultaneous uploads (1-5, default: 2)
- **Upload Throttle** - Delay before uploading modified notes (batches rapid edits)
- **Chunking** - Token limits for document chunks (default: 400 tokens, 50 overlap)

## FAQ

**How much does it cost?**
Google Gemini pricing applies. Check [ai.google.dev/pricing](https://ai.google.dev/pricing)

**Can I use this on mobile?**
Plugin works on mobile but can't be the runner (indexing machine). Chat and search work once a desktop runner has indexed your vault.

**Which files are indexed?**
Only Markdown files (`.md`) in included folders.

**How do I fix duplicates?**
Run "Clean Up Gemini Index" command. Ensure only one device is designated as runner.

**What is a FileSearchStore?**
Gemini's container for indexed documents. EzRAG creates one per vault.

## Privacy

- Notes are uploaded to Google's Gemini API for indexing
- Data is stored in your Google account's FileSearch store
- You can delete your store anytime via Settings → Manage Stores
- EzRAG collects no usage data or telemetry

## Development

See [ARCHITECTURE.md](./ARCHITECTURE.md) for technical details.

## Support

- [GitHub Issues](https://github.com/yourusername/ezrag/issues)
- [GitHub Discussions](https://github.com/yourusername/ezrag/discussions)

## License

MIT License - See LICENSE file for details
