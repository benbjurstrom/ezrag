// src/types.ts - Shared TypeScript interfaces

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
  uploadThrottleMs: number; // Delay before uploading modified documents
  mcpServer: MCPServerSettings; // MCP server configuration
}

export interface MCPServerSettings {
  enabled: boolean; // Whether MCP server is enabled
  port: number; // HTTP server port (default: 3000)
}

export interface ChunkingConfig {
  maxTokensPerChunk: number; // Default: 400
  maxOverlapTokens: number; // Default: 50
}

export interface IndexState {
  docs: Record<string, IndexedDocState>; // Key: vaultPath
  queue: IndexQueueEntry[];
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

export type IndexQueueOperation = 'upload' | 'delete';

export interface IndexQueueEntry {
  id: string;
  vaultPath: string;
  operation: IndexQueueOperation;
  /**
   * Last known content hash for uploads. Used to avoid unnecessary work when
   * files are modified again before the queue drains.
   */
  contentHash?: string;
  /** Remote Gemini document name (used for delete jobs) */
  remoteId?: string;
  enqueuedAt: number;
  attempts: number;
  lastAttemptAt?: number;
  readyAt?: number;
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
  uploadThrottleMs: 120000,
  mcpServer: {
    enabled: false,
    port: 42427, // Random high port to avoid common conflicts
  },
};

export const DEFAULT_DATA: PersistedData = {
  version: 1,
  settings: DEFAULT_SETTINGS,
  index: {
    docs: {},
    queue: [],
  },
};

export interface GroundingChunk {
  retrievedContext?: {
    text?: string;
    title?: string;  // Title of the attribution (may be populated from custom metadata)
    uri?: string;    // URI reference (may be populated from custom metadata)
    documentName?: string;  // Full document name (Vertex AI specific)
  };
  web?: {
    uri?: string;
    title?: string;
  };
  [key: string]: any;
}

export interface ChatMessage {
  role: 'user' | 'model';
  text: string;
  groundingChunks?: GroundingChunk[];
  groundingSupports?: any[];
}

export type ChatModel = 'gemini-2.5-flash' | 'gemini-2.5-pro';
