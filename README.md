# EzRAG - AI-Powered Search for Obsidian Notes

This plugin adds semantic search and AI chat for your Obsidian vault using Google [Gemini's File Search API](https://blog.google/technology/developers/file-search-gemini-api/). It also provides a built in MCP server so external tools can semantically search your vault.

<img width="716" height="507" alt="Chat Interface Screenshot" src="https://github.com/user-attachments/assets/4026c1aa-0a9e-43f0-bbb8-31b95e645244" />

## Setup

### Requirements
- Google Gemini API key ([Get one free](https://aistudio.google.com/))
- Obsidian desktop app (mobile supported as read-only)

### Installation

Since EzRAG is is still in development and hasn't been submitted to the Obsidian community repository, install manually using one of these methods:

#### Option 1: BRAT (Recommended)
1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) from Community Plugins
2. Open BRAT settings → Add Beta Plugin
3. Enter: `https://github.com/yourusername/ezrag`
4. Enable EzRAG in Community Plugins

#### Option 2: Manual Installation
1. Clone the repository:
```bash
   cd /path/to/vault/.obsidian/plugins
   git clone https://github.com/yourusername/ezrag
```
2. Build the plugin:
```bash
   cd ezrag
   npm install
   npm run build
```
3. Restart Obsidian
4. Enable EzRAG in Settings → Community Plugins

### Configuration

2. **Add API Key**  
   Settings → EzRAG → Enter your Gemini API key

3. **Enable Indexing** (Desktop only)  
   Settings → EzRAG → Toggle "This machine is the runner"

The plugin will automatically create a Gemini FileSearch store and begin indexing your notes.
<img width="826" height="591" alt="Settings Screenshot" src="https://github.com/user-attachments/assets/8d3d2470-b305-4114-91ed-b8778af66e1e" />

## Usage

### Chat Interface
Access via ribbon icon or command palette (`EzRAG: Open Chat`)

Example queries:
- "What are my notes about the Johnson project?"
- "Summarize yesterday's meeting notes"
- "Find all mentions of machine learning"

### MCP Server (External Tools)

Enable external access in Settings → MCP Server

Connect from Claude Code:
```bash
claude mcp add --transport http ezrag-obsidian-notes http://localhost:42427/mcp
```

Available endpoints:
- `keywordSearch` - Keyword/regex search
- `semanticSearch` - AI-powered search
- `note:///<path>` - Direct note access

## Technical Details

### Indexing
- Only `.md` files are indexed
- Changes trigger automatic re-indexing
- Hash-based duplicate prevention

<img width="881" height="500" alt="Upload Queue Screenshot" src="https://github.com/user-attachments/assets/a1a51b87-2e8a-461a-8f6b-59ef0dea1098" />

### Costs
Gemini File Search pricing ([details](https://ai.google.dev/gemini-api/docs/file-search#pricing)):
- **Indexing**: $0.15 per 1M tokens
- **Storage**: Free
- **Queries**: Standard model rates

### Limits
- Max file size: 100 MB
- Storage tiers: 1 GB (Free) to 1 TB (Tier 3)
- Recommended store size: <20 GB for optimal performance

### Data Management
- Notes stored in your Google account's FileSearch store
- Delete anytime via Settings → Manage Stores
- No telemetry collected

## Links

- [Issues](https://github.com/benbjurstrom/ezrag/issues)
- [Discussions](https://github.com/benbjurstrom/ezrag/discussions)
- [License](LICENSE) (MIT)