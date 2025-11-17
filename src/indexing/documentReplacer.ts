import { GeminiService } from "../gemini/geminiService";
import { ChunkingConfig } from "../types";
import { GeminiMetadataField } from "./documentMetadata";

export interface DocumentReplaceRequest {
  storeName: string;
  content: string;
  displayName: string;
  metadata: GeminiMetadataField[];
  chunkingConfig: ChunkingConfig;
  mimeType?: string;
}

export class DocumentReplacer {
  constructor(private gemini: GeminiService) {}

  async replaceDocument(
    existingDocumentName: string | null | undefined,
    request: DocumentReplaceRequest,
  ): Promise<string> {
    if (existingDocumentName) {
      try {
        await this.gemini.deleteDocument(existingDocumentName);
      } catch (err) {
        if (!this.isNotFoundError(err)) {
          throw err;
        }
      }
    }

    return this.gemini.uploadDocument({
      storeName: request.storeName,
      content: request.content,
      displayName: request.displayName,
      metadata: request.metadata,
      chunkingConfig: request.chunkingConfig,
      mimeType: request.mimeType ?? "text/markdown",
    });
  }

  private isNotFoundError(err: unknown): boolean {
    const message = (
      err instanceof Error ? err.message : String(err ?? "")
    ).toLowerCase();
    if (!message) return false;
    return message.includes("404") || message.includes("not found");
  }
}
