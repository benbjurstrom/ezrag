import { GeminiService } from '../gemini/geminiService';
import { ChunkingConfig } from '../types';
import { GeminiMetadataField } from './documentMetadata';

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

  async replaceDocument(existingDocumentName: string | null | undefined, request: DocumentReplaceRequest): Promise<string> {
    if (existingDocumentName) {
      try {
        await this.gemini.deleteDocument(existingDocumentName);
      } catch (err) {
        console.log(`[IndexManager] Document already deleted or not found: ${existingDocumentName}`);
      }
    }

    console.log(`[IndexManager] Uploading document with displayName: ${request.displayName}`);
    console.log(`[IndexManager] Metadata: ${JSON.stringify(request.metadata, null, 2)}`);

    return this.gemini.uploadDocument({
      storeName: request.storeName,
      content: request.content,
      displayName: request.displayName,
      metadata: request.metadata,
      chunkingConfig: request.chunkingConfig,
      mimeType: request.mimeType ?? 'text/markdown',
    });
  }
}
