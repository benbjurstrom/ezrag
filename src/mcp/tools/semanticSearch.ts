// src/mcp/tools/semanticSearch.ts - Semantic search tool for MCP

import { GeminiService } from '../../gemini/geminiService';
import { ChatModel } from '../../types';

export interface SemanticSearchParams {
  query: string;
  model?: ChatModel;
  limit?: number;
}

export interface SemanticSearchSource {
  path?: string;
  excerpt: string;
  title?: string;
  documentName?: string;
}

export interface SemanticSearchResult {
  answer: string;
  sources: SemanticSearchSource[];
}

/**
 * Extract vault path from grounding chunk metadata
 * Looks for obsidian_path in custom metadata
 */
function extractPathFromChunk(chunk: any): string | undefined {
  try {
    // Try to extract from retrievedContext
    if (chunk.retrievedContext) {
      // Check for uri (may contain path)
      if (chunk.retrievedContext.uri) {
        return chunk.retrievedContext.uri;
      }

      // Check for title (may be set to path)
      if (chunk.retrievedContext.title) {
        return chunk.retrievedContext.title;
      }
    }

    // Gemini may put path in different fields depending on API version
    // This is a best-effort extraction
    return undefined;
  } catch (err) {
    console.error('[MCP SemanticSearch] Failed to extract path from chunk:', err);
    return undefined;
  }
}

/**
 * Perform semantic search using Gemini FileSearch
 * Returns answer and sources with vault paths
 */
export async function semanticSearch(
  geminiService: GeminiService,
  storeName: string,
  params: SemanticSearchParams
): Promise<SemanticSearchResult> {
  const { query, model = 'gemini-2.5-flash', limit = 10 } = params;

  if (!query || query.trim().length === 0) {
    throw new Error('Query parameter is required and cannot be empty');
  }

  if (!storeName) {
    throw new Error('No FileSearch store configured. Please index some notes first.');
  }

  try {
    const result = await geminiService.fileSearch(storeName, query, model);

    // Extract sources from grounding chunks
    const sources: SemanticSearchSource[] = [];
    const chunks = result.groundingChunks || [];

    for (const chunk of chunks.slice(0, limit)) {
      const path = extractPathFromChunk(chunk);
      const excerpt = chunk.retrievedContext?.text || '';
      const title = chunk.retrievedContext?.title;
      const documentName = chunk.retrievedContext?.documentName;

      sources.push({
        path,
        excerpt,
        title,
        documentName
      });
    }

    return {
      answer: result.text,
      sources
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    throw new Error(`Semantic search failed: ${errorMessage}`);
  }
}
