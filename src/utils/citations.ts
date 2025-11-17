// src/utils/citations.ts - Shared citation annotation logic

export interface CitationData {
  position: number;
  citationNumbers: number[];
  fileNames: string[];
}

export interface AnnotationResult {
  fileReferences: Map<string, number>;
  citations: CitationData[];
}

/**
 * Extract citation data from grounding supports and chunks
 * This is the core logic shared by both chat and MCP
 */
export function buildCitationData(
  groundingSupports: any[],
  groundingChunks: any[],
): AnnotationResult {
  const fileReferences = new Map<string, number>();

  if (!groundingSupports || groundingSupports.length === 0) {
    return { fileReferences, citations: [] };
  }

  // Step 1: Build file reference map (file path → citation number)
  let refNumber = 1;
  for (const support of groundingSupports) {
    const indices = support.groundingChunkIndices || [];
    for (const index of indices) {
      if (index >= 0 && index < groundingChunks.length) {
        const title = groundingChunks[index]?.retrievedContext?.title;
        if (title && !fileReferences.has(title)) {
          fileReferences.set(title, refNumber++);
        }
      }
    }
  }

  // Step 2: Group citations by position (endIndex)
  const positionMap = new Map<number, Set<number>>();

  for (const support of groundingSupports) {
    const endIndex = support.segment?.endIndex;
    if (endIndex === undefined) continue;

    const indices = support.groundingChunkIndices || [];
    for (const index of indices) {
      if (index >= 0 && index < groundingChunks.length) {
        const title = groundingChunks[index]?.retrievedContext?.title;
        if (title) {
          const refNum = fileReferences.get(title);
          if (refNum) {
            if (!positionMap.has(endIndex)) {
              positionMap.set(endIndex, new Set());
            }
            positionMap.get(endIndex)!.add(refNum);
          }
        }
      }
    }
  }

  // Step 3: Convert to CitationData array
  const citations: CitationData[] = [];
  positionMap.forEach((refNums, position) => {
    const citationNumbers = Array.from(refNums).sort((a, b) => a - b);
    const fileNames = citationNumbers
      .map((num) => {
        for (const [path, refNum] of fileReferences.entries()) {
          if (refNum === num) return path;
        }
        return "";
      })
      .filter(Boolean);

    citations.push({ position, citationNumbers, fileNames });
  });

  return { fileReferences, citations };
}

/**
 * Insert citation markers into text at specified positions
 * Uses a formatter function to allow different output formats (HTML vs markdown)
 */
export function insertCitations(
  text: string,
  citations: CitationData[],
  formatFn: (citationNumbers: number[], fileNames: string[]) => string,
): string {
  const insertions = citations.map((c) => ({
    position: c.position,
    text: formatFn(c.citationNumbers, c.fileNames),
  }));

  // Sort in reverse order to preserve indices
  insertions.sort((a, b) => b.position - a.position);

  let result = text;
  for (const insertion of insertions) {
    result =
      result.slice(0, insertion.position) +
      insertion.text +
      result.slice(insertion.position);
  }
  return result;
}

/**
 * Format citations for chat (HTML placeholders that will be replaced later)
 */
export function formatForChat(
  citationNumbers: number[],
  fileNames: string[],
): string {
  return `{{CITATION:${citationNumbers.join(",")}:${fileNames.join("|")}}}`;
}

/**
 * Format citations for markdown (plain text, no HTML)
 */
export function formatForMarkdown(citationNumbers: number[]): string {
  return `[${citationNumbers.join(",")}]`;
}

/**
 * Build markdown reference list
 */
export function buildReferenceList(
  fileReferences: Map<string, number>,
): string {
  if (fileReferences.size === 0) return "";

  const sortedRefs = Array.from(fileReferences.entries()).sort(
    (a, b) => a[1] - b[1],
  );

  let refs = "\n\n";
  for (const [path, num] of sortedRefs) {
    refs += `${num}. ${path}\n`;
  }
  return refs;
}

/**
 * Complete annotation for markdown (MCP use)
 * Returns markdown text with inline citations and reference list
 */
export function annotateForMarkdown(
  text: string,
  groundingSupports: any[],
  groundingChunks: any[],
): string {
  const { fileReferences, citations } = buildCitationData(
    groundingSupports,
    groundingChunks,
  );

  if (citations.length === 0) {
    return text;
  }

  const annotated = insertCitations(text, citations, (nums) =>
    formatForMarkdown(nums),
  );

  return annotated + buildReferenceList(fileReferences);
}

/**
 * Annotation for chat (returns data for HTML rendering)
 */
export function annotateForChat(
  text: string,
  groundingSupports: any[],
  groundingChunks: any[],
): { annotatedText: string; fileReferences: Map<string, number> } {
  const { fileReferences, citations } = buildCitationData(
    groundingSupports,
    groundingChunks,
  );

  if (citations.length === 0) {
    return { annotatedText: text, fileReferences };
  }

  const annotatedText = insertCitations(text, citations, (nums, files) =>
    formatForChat(nums, files),
  );

  return { annotatedText, fileReferences };
}
