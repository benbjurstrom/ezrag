# EzRAG - AI-Powered Search for Obsidian

Index your Obsidian vault with Google Gemini's File Search API for semantic search and AI chat.

## Features

- **AI Chat Interface** - Ask questions about your notes in natural language
- **Automatic Indexing** - Keeps notes synced with Gemini as you edit
- **MCP Server** - External tools (Claude Code, etc.) can query your vault
- **Multi-Device Safe** - Designate one "runner" machine to prevent conflicts
- **Smart Sync** - Only re-indexes when content actually changes

## Quick Start

1. Get an API key from [Google AI Studio](https://aistudio.google.com/) (same credentials work across [ai.google.dev](https://ai.google.dev/))
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

## FAQ

**Where do I get an API key?**  
Sign in at [Google AI Studio](https://aistudio.google.com/), create a project, and copy the Gemini API key. The same credential works with the REST/SDK endpoints documented on [ai.google.dev](https://ai.google.dev/).

**How much does it cost?**  
File Search follows Gemini pricing ([overview](https://ai.google.dev/pricing); [latest File Search details](https://ai.google.dev/gemini-api/docs/file-search#pricing)):
- Indexing charges are billed at the [embedding rate](https://ai.google.dev/gemini-api/docs/pricing#gemini-embedding) – currently **$0.15 per 1M tokens** processed when EzRAG uploads or updates a note.
- Storage of FileSearch stores is free.
- Query-time embeddings are free; retrieved chunks simply count toward your model’s regular context-token usage.

**What are the File Search limits?**  
From the [Gemini File Search docs](docs/gemini-docs/file-search.md):
- Maximum file size per document: **100 MB**.
- Total FileSearch storage per Google tier: **1 GB (Free)**, **10 GB (Tier 1)**, **100 GB (Tier 2)**, **1 TB (Tier 3)**. Google recommends keeping each store under 20 GB for faster retrievals.
- Backend storage is roughly 3× your source data because embeddings are stored alongside the original text.

**Can I use this on mobile?**  
Plugin works on mobile but can't be the runner (indexing machine). Chat and search work once a desktop runner has indexed your vault.

**Which files are indexed?**  
Only Markdown files (`.md`) in included folders.

**How do I fix duplicates?**  
Run "Clean Up Gemini Index" (Janitor) in settings. Also verify that only one desktop is designated as the runner.

**What is a FileSearchStore?**  
It’s the Gemini container that stores your note embeddings so the model can retrieve relevant chunks. Google’s developer blog has a great overview: [“Introducing File Search for Gemini API”](https://blog.google/technology/developers/file-search-gemini-api/). EzRAG automatically creates one store per vault and manages it via the Manage Stores modal.

## Privacy

- Notes are uploaded to Google's Gemini API for indexing
- Data is stored in your Google account's FileSearch store
- You can delete your store anytime via Settings → Manage Stores
- EzRAG collects no usage data or telemetry

## Support

- [GitHub Issues](https://github.com/yourusername/ezrag/issues)
- [GitHub Discussions](https://github.com/yourusername/ezrag/discussions)

## License

MIT License - See LICENSE file for details
