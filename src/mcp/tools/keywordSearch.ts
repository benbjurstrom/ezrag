// src/mcp/tools/keywordSearch.ts - Keyword search tool for MCP

import { App, TFile } from "obsidian";

export interface KeywordSearchParams {
  query: string;
  caseSensitive?: boolean;
  includeFolders?: string[];
}

export interface KeywordSearchMatch {
  line: number;
  text: string;
  before: string;
  after: string;
}

export interface KeywordSearchResult {
  path: string;
  matches: KeywordSearchMatch[];
}

/**
 * Search vault files for keyword matches
 * Returns file paths and matching lines with context
 */
export async function keywordSearch(
  app: App,
  params: KeywordSearchParams,
): Promise<KeywordSearchResult[]> {
  const { query, caseSensitive = false, includeFolders = [] } = params;

  if (!query || query.trim().length === 0) {
    throw new Error("Query parameter is required and cannot be empty");
  }

  const results: KeywordSearchResult[] = [];

  // Get all markdown files
  const files = app.vault.getMarkdownFiles();

  // Filter by folders if specified
  const filteredFiles =
    includeFolders.length > 0
      ? files.filter((file) => {
          return includeFolders.some((folder) => {
            const normalizedFolder = folder.trim().replace(/^\/+|\/+$/g, "");
            return (
              file.path.startsWith(normalizedFolder + "/") ||
              file.path === normalizedFolder
            );
          });
        })
      : files;

  // Build search regex
  const flags = caseSensitive ? "g" : "gi";
  let searchRegex: RegExp;
  try {
    searchRegex = new RegExp(query, flags);
  } catch (err) {
    throw new Error(`Invalid search pattern: ${(err as Error).message}`);
  }

  // Search each file
  for (const file of filteredFiles) {
    try {
      const content = await app.vault.cachedRead(file);
      const lines = content.split("\n");
      const matches: KeywordSearchMatch[] = [];

      lines.forEach((line, index) => {
        // Reset regex lastIndex for each line
        searchRegex.lastIndex = 0;

        if (searchRegex.test(line)) {
          const lineNumber = index + 1; // 1-indexed

          // Get context (2 lines before and after)
          const beforeLines = lines.slice(Math.max(0, index - 2), index);
          const afterLines = lines.slice(
            index + 1,
            Math.min(lines.length, index + 3),
          );

          matches.push({
            line: lineNumber,
            text: line,
            before: beforeLines.join("\n"),
            after: afterLines.join("\n"),
          });
        }
      });

      if (matches.length > 0) {
        results.push({
          path: file.path,
          matches,
        });
      }
    } catch (err) {
      console.error(
        `[MCP KeywordSearch] Failed to search file ${file.path}:`,
        err,
      );
      // Continue with other files
    }
  }

  return results;
}
