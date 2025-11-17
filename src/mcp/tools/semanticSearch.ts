// src/mcp/tools/semanticSearch.ts - Semantic search tool for MCP

import { GeminiService } from '../../gemini/geminiService';
import { ChatModel } from '../../types';

export interface SemanticSearchParams {
  query: string;
  model?: ChatModel;
}

export interface SemanticSearchSource {
  text: string;
  files: string[];
}

export interface SemanticSearchResult {
  answer: string;
  sources: SemanticSearchSource[];
}

/**
 * Perform semantic search using Gemini FileSearch
 * Returns answer and sources with grounding information
 */
export async function semanticSearch(
  geminiService: GeminiService,
  storeName: string,
  params: SemanticSearchParams
): Promise<SemanticSearchResult> {
  const { query, model = 'gemini-2.5-flash' } = params;

  if (!query || query.trim().length === 0) {
    throw new Error('Query parameter is required and cannot be empty');
  }

  if (!storeName) {
    throw new Error('No FileSearch store configured. Please index some notes first.');
  }

  try {
    const result = await geminiService.fileSearch(storeName, query, model);

    // Map grounding supports to sources with file paths
    const sources: SemanticSearchSource[] = [];
    const chunks = result.groundingChunks || [];
    const supports = result.groundingSupports || [];

    for (const support of supports) {
      const segment = support.segment;
      const chunkIndices = support.groundingChunkIndices || [];

      // Map chunk indices to file paths (titles)
      const files: string[] = [];
      for (const index of chunkIndices) {
        if (index >= 0 && index < chunks.length) {
          const chunk = chunks[index];
          const title = chunk.retrievedContext?.title;
          if (title) {
            files.push(title);
          }
        }
      }

      // Only add if we have both segment text and at least one file
      if (segment?.text && files.length > 0) {
        sources.push({
          text: segment.text,
          files
        });
      }
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
