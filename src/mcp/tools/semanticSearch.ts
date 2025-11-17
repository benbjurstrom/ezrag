// src/mcp/tools/semanticSearch.ts - Semantic search tool for MCP

import { GeminiService } from "../../gemini/geminiService";
import { ChatModel } from "../../types";
import { annotateForMarkdown } from "../../utils/citations";

export interface SemanticSearchParams {
  query: string;
  model?: ChatModel;
}

/**
 * Perform semantic search using Gemini FileSearch
 * Returns markdown with inline citations and reference list
 */
export async function semanticSearch(
  geminiService: GeminiService,
  storeName: string,
  params: SemanticSearchParams,
): Promise<string> {
  const { query, model = "gemini-2.5-flash" } = params;

  if (!query || query.trim().length === 0) {
    throw new Error("Query parameter is required and cannot be empty");
  }

  if (!storeName) {
    throw new Error(
      "No FileSearch store configured. Please index some notes first.",
    );
  }

  try {
    const result = await geminiService.fileSearch(storeName, query, model);

    // Use shared annotation utility to add citations and references
    return annotateForMarkdown(
      result.text,
      result.groundingSupports || [],
      result.groundingChunks || [],
    );
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    throw new Error(`Semantic search failed: ${errorMessage}`);
  }
}
