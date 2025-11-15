# EzRAG - Obsidian Plugin

**EzRAG** (Easy Retrieval-Augmented Generation) is an Obsidian plugin that indexes your notes using Google Gemini's File Search API, enabling semantic search and AI-powered chat with your vault.

## Features

- **Automatic Indexing**: Keeps your notes synchronized with Gemini's File Search API
- **Semantic Search**: Query your notes using natural language (coming in Phase 3)
- **Smart Change Detection**: Only re-indexes notes when content actually changes
- **Multi-Device Support**: Works across desktop and mobile with designated "runner" machine
- **Incremental Updates**: Efficient indexing that preserves state across restarts
- **MCP Server Integration**: External tools can query your vault (coming in Phase 4)

## Prerequisites

- **Gemini API Key**: Get your free API key from [Google AI Studio](https://ai.google.dev/)
- **Desktop Required for Indexing**: The runner (indexing machine) must be on desktop (Windows, macOS, or Linux)
- **Obsidian Desktop/Mobile**: Plugin works on both, but indexing only runs on the designated desktop runner

## Installation

### Manual Installation (Development)

1. Download or clone this repository
2. Copy the plugin folder to your vault: `VaultFolder/.obsidian/plugins/ezrag/`
3. Make sure the folder contains `manifest.json`, `main.js`, and `styles.css`
4. Restart Obsidian
5. Enable the plugin in Settings → Community Plugins

### From Community Plugins (Coming Soon)

Once published, you can install directly from Obsidian's Community Plugins browser.

## Setup

### First-Time Setup

1. **Get a Gemini API Key**
   - Visit [Google AI Studio](https://ai.google.dev/)
   - Create a new API key
   - Copy the key

2. **Configure the Plugin**
   - Open Obsidian Settings → EzRAG
   - Paste your API key
   - (Desktop only) Enable "This machine is the runner" toggle
   - The plugin will automatically create a FileSearchStore for your vault

3. **Choose Folders to Index (Optional)**
   - By default, EzRAG indexes your entire vault
   - To limit indexing, specify folders in Settings → Included Folders
   - Example: `Projects, Research, Notes`

### Multi-Device Setup

If you use Obsidian on multiple devices (e.g., laptop + desktop):

1. **Install the plugin on all devices**
2. **Set the API key on one device** (it will sync via your vault)
3. **Enable "runner" on ONE device only** (preferably your main desktop)
4. **Other devices** will use the index but won't perform indexing

**Why only one runner?** To prevent duplicate indexing, API overload, and sync conflicts.

## Usage

### Automatic Indexing

Once configured, EzRAG automatically:
- Indexes new notes when created
- Re-indexes notes when modified
- Removes notes from the index when deleted
- Handles file renames gracefully

### Manual Commands

Access these commands via Command Palette (Cmd/Ctrl+P):

- **Rebuild Index**: Clear and re-index all files
- **Run Deduplication**: Find and remove duplicate documents (useful after sync conflicts)
- **Cleanup Orphaned Documents**: Remove indexed files that no longer exist in vault

### Monitoring Progress

- **Status Bar**: Shows indexing progress (bottom-right corner)
- **Settings Tab**: View index statistics (total, ready, pending, errors)

## Settings

### API Configuration

- **Gemini API Key**: Your Google Gemini API key
- **Included Folders**: Limit indexing to specific folders (comma-separated)

### Runner Configuration (Desktop Only)

- **This machine is the runner**: Enable to make this device responsible for indexing
- Only ONE device per vault should be the runner

### Performance Tuning

- **Upload Concurrency**: Number of concurrent uploads (1-5, default: 2)
- **Max Tokens Per Chunk**: Maximum tokens in each chunk (100-1000, default: 400)
- **Max Overlap Tokens**: Overlapping tokens between chunks (0-200, default: 50)

### Store Management

- **View Stats**: See FileSearchStore statistics
- **List All Stores**: View all stores for your API key
- **Delete Store**: Permanently remove the store (cannot be undone!)

## FAQ

### Which files are indexed?

Only Markdown files (`.md`) in included folders are indexed. Attachments, templates, and non-markdown files are ignored.

### How much does it cost?

Google Gemini's File Search API pricing depends on your usage. Check [Google AI Pricing](https://ai.google.dev/pricing) for current rates.

### What happens if I rename a file?

EzRAG automatically deletes the old indexed version and creates a new one with the updated path.

### Can I use this on mobile?

Yes, but mobile devices cannot be the "runner" (indexing machine). Mobile devices can use chat and search features once implemented.

### How do I fix duplicate documents?

Run the **Run Deduplication** command from Settings or the Command Palette. This finds and removes duplicates created by sync conflicts.

### What is a FileSearchStore?

A FileSearchStore is Gemini's container for indexed documents. EzRAG creates one store per vault, named after your vault.

## Troubleshooting

### Indexing not working

1. Check that "This machine is the runner" is enabled (Settings → Runner Configuration)
2. Verify your API key is valid (Settings → API Configuration)
3. Check the console (Cmd/Ctrl+Shift+I) for error messages

### Files not showing in index

1. Ensure files are in included folders (or no folders are specified for "all")
2. Check that files are Markdown (`.md` extension)
3. Run "Rebuild Index" command to force re-indexing

### Sync conflicts creating duplicates

1. Run "Run Deduplication" from Settings
2. Ensure only ONE device is the runner
3. Wait for sync to complete before switching devices

## Roadmap

- **Phase 1** (Current): Core infrastructure and automatic indexing
- **Phase 2**: Enhanced progress tracking and reconciliation
- **Phase 3**: Chat interface for querying notes
- **Phase 4**: MCP server for external tool integration

## Privacy & Data

- Your notes are uploaded to Google's Gemini API for indexing
- Indexed content is stored in your Google account's FileSearchStore
- EzRAG does not collect or transmit any usage data
- You can delete your FileSearchStore at any time from Settings

## Support

- **Issues**: Report bugs on [GitHub Issues](https://github.com/yourusername/ezrag/issues)
- **Feature Requests**: Submit on GitHub Discussions
- **Documentation**: See [ARCHITECTURE.md](./ARCHITECTURE.md) for technical details

## License

MIT License - See LICENSE file for details

## Credits

Built with:
- [Obsidian Plugin API](https://github.com/obsidianmd/obsidian-api)
- [Google Generative AI SDK](https://www.npmjs.com/package/@google/genai)
- [p-queue](https://www.npmjs.com/package/p-queue) for job queue management



