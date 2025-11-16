// src/mcp/resources/noteResource.ts - Note resource handler for MCP

import { App, TFile, normalizePath } from 'obsidian';
import { StateManager } from '../../state/state';

export interface NoteResourceContent {
  uri: string;
  mimeType: string;
  text: string;
  metadata?: {
    path: string;
    mtime: number;
    size: number;
    tags?: string[];
    indexed?: boolean;
    lastIndexedAt?: number;
  };
}

/**
 * Read note content and metadata by vault path
 * URI format: note:///<vault-relative-path>
 */
export async function readNoteResource(
  app: App,
  stateManager: StateManager,
  uri: string
): Promise<NoteResourceContent> {
  // Parse URI - expect format: note:///<path>
  const match = uri.match(/^note:\/\/\/(.+)$/);
  if (!match) {
    throw new Error(`Invalid note URI format. Expected: note:///<path>, got: ${uri}`);
  }

  const path = normalizePath(match[1]);

  // Get file
  const file = app.vault.getFileByPath(path);
  if (!file || !(file instanceof TFile)) {
    throw new Error(`Note not found: ${path}`);
  }

  // Read content
  let content: string;
  try {
    content = await app.vault.cachedRead(file);
  } catch (err) {
    throw new Error(`Failed to read note: ${(err as Error).message}`);
  }

  // Extract metadata from cache
  const cache = app.metadataCache.getFileCache(file);
  const tags = cache?.frontmatter?.tags || [];
  const normalizedTags = Array.isArray(tags) ? tags : (tags ? [tags] : []);

  // Get indexing status from state
  const indexedDoc = stateManager.getDocState(path);

  return {
    uri,
    mimeType: 'text/markdown',
    text: content,
    metadata: {
      path: file.path,
      mtime: file.stat.mtime,
      size: file.stat.size,
      tags: normalizedTags,
      indexed: !!indexedDoc && indexedDoc.status === 'ready',
      lastIndexedAt: indexedDoc?.lastIndexedAt
    }
  };
}

/**
 * List all note URIs in the vault
 * Optionally filter by folder
 */
export function listNoteResources(
  app: App,
  includeFolders: string[] = []
): string[] {
  const files = app.vault.getMarkdownFiles();

  const filteredFiles = includeFolders.length > 0
    ? files.filter(file => {
        return includeFolders.some(folder => {
          const normalizedFolder = folder.trim().replace(/^\/+|\/+$/g, '');
          return file.path.startsWith(normalizedFolder + '/') ||
                 file.path === normalizedFolder;
        });
      })
    : files;

  return filteredFiles.map(file => `note:///${file.path}`);
}
