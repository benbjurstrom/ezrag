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
  geminiDocumentName: string | null; // e.g., "fileSearchStores/.../documents/..." (null if not yet uploaded)
  contentHash: string; // SHA-256 of file content
  pathHash: string; // SHA-256 of vaultPath (stable ID for metadata)
  status: 'pending' | 'ready' | 'error';
  lastLocalMtime: number; // File modification time
  lastIndexedAt: number; // When we last indexed
  tags: string[]; // Extracted from frontmatter
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

export interface GroundingChunk {
  retrievedContext?: {
    text?: string;
  };
  [key: string]: any;
}

export interface ChatMessage {
  role: 'user' | 'model';
  text: string;
  groundingChunks?: GroundingChunk[];
}

export type ChatModel = 'gemini-2.5-flash' | 'gemini-2.5-pro';
