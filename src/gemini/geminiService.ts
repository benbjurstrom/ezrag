// src/gemini/geminiService.ts - Gemini API wrapper (Obsidian-agnostic)

import { GoogleGenAI } from '@google/genai';
import { ChunkingConfig, ChatModel } from '../types';

export interface CustomMetadataEntry {
  key: string;
  stringValue?: string;
  numericValue?: number;
}

export interface UploadDocumentParams {
  storeName: string;
  content: string;
  displayName: string;
  metadata: CustomMetadataEntry[];
  mimeType?: string;
  chunkingConfig?: ChunkingConfig;
}

export interface FileSearchResult {
  text: string;
  groundingChunks: any[];
  groundingSupports: any[];
}

export class GeminiService {
  private ai: GoogleGenAI;

  constructor(apiKey: string) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  /**
   * Find or create a FileSearchStore by display name
   */
  async getOrCreateStore(displayName: string): Promise<string> {
    // List all stores
    const stores = await this.ai.fileSearchStores.list();

    // Find matching store by displayName
    for await (const store of stores) {
      if (store.displayName === displayName) {
        return store.name!;
      }
    }

    // Create new store if not found
    const newStore = await this.ai.fileSearchStores.create({
      config: { displayName }
    });

    return newStore.name!;
  }

  /**
   * Upload a document to a FileSearchStore
   * Creates a temporary File, converts content to blob
   * NOTE: Upload is considered complete when operation.done === true
   * AND the document state is STATE_ACTIVE (or STATE_FAILED)
   */
  async uploadDocument(params: UploadDocumentParams): Promise<string> {
    const { storeName, content, displayName, metadata, mimeType = 'text/markdown', chunkingConfig } = params;

    // Validate content is not empty (safety check - should be caught earlier)
    const trimmedContent = content.trim();
    if (trimmedContent.length === 0) {
      throw new Error('Cannot upload empty file - content must not be empty');
    }

    // Convert content to a File-like object
    const blob = new Blob([content], { type: mimeType });
    const file = new File([blob], displayName, { type: mimeType });

    // Build config with optional chunking
    const config: any = {
      displayName,
      customMetadata: metadata,
      mimeType,
    };

    if (chunkingConfig) {
      config.chunkingConfig = {
        whiteSpaceConfig: {
          maxTokensPerChunk: chunkingConfig.maxTokensPerChunk,
          maxOverlapTokens: chunkingConfig.maxOverlapTokens,
        }
      };
    }

    let operation = await this.ai.fileSearchStores.uploadToFileSearchStore({
      fileSearchStoreName: storeName,
      file,
      config,
    });

    // Poll until complete
    while (!operation.done) {
      await this.delay(3000);
      operation = await this.ai.operations.get({ operation });
    }

    // Extract document name from operation response
    // Response type: UploadToFileSearchStoreResponse
    // Contains: { documentName: string, mimeType: string, sizeBytes: string }
    const response = operation.response as any;
    if (response?.documentName) {
      return response.documentName as string;
    }

    throw new Error('Upload failed: no document name in response');
  }

  /**
   * Delete a document from a FileSearchStore
   */
  async deleteDocument(documentName: string): Promise<void> {
    await this.ai.fileSearchStores.documents.delete({
      name: documentName,
      config: { force: true }
    });
  }

  /**
   * List all documents in a store
   *
   * IMPORTANT: Handles pagination properly. The API has a maximum page size of 20 documents.
   * For vaults with 1,000+ notes, this will make 50+ API calls to fetch all documents.
   *
   * Performance: Fetching 5,000 documents (250 pages) takes ~10-15 seconds.
   * This is still much faster than 5,000 individual documents.get() calls.
   *
   * API Pagination:
   * - Maximum pageSize: 20 documents per page
   * - Default pageSize: 10 documents per page (if not specified)
   * - Response contains: { documents: [], nextPageToken: string }
   * - Loop continues while nextPageToken is present
   */
  async listDocuments(storeName: string, options?: { onPage?: (info: { pageIndex: number; docs: any[]; nextPageToken?: string }) => void }): Promise<any[]> {
    const allDocs: any[] = [];
    let pageToken: string | undefined = undefined;
    let pageIndex = 0;

    do {
      const response: any = await this.ai.fileSearchStores.documents.list({
        parent: storeName,
        config: {
          pageSize: 20, // Maximum allowed by API
          pageToken: pageToken
        }
      });

      const pageDocs: any[] = [];
      // Collect documents from this page
      // SDK returns an async iterable, iterate through all documents
      for await (const doc of response) {
        allDocs.push(doc);
        pageDocs.push(doc);
      }

      options?.onPage?.({
        pageIndex,
        docs: pageDocs,
        nextPageToken: response.nextPageToken,
      });

      // Get next page token from response
      // If nextPageToken is present, there are more pages to fetch
      pageToken = response.nextPageToken;
      pageIndex++;

    } while (pageToken);

    return allDocs;
  }

  /**
   * Get a single document by name
   */
  async getDocument(documentName: string): Promise<any> {
    return await this.ai.fileSearchStores.documents.get({
      name: documentName
    });
  }

  /**
   * Query the FileSearchStore
   */
  async fileSearch(storeName: string, query: string, model: ChatModel = 'gemini-2.5-flash'): Promise<FileSearchResult> {
    const response = await this.ai.models.generateContent({
      model,
      contents: query,
      config: {
        tools: [
          {
            fileSearch: {
              fileSearchStoreNames: [storeName]
            }
          }
        ]
      }
    });

    const groundingMetadata = response.candidates?.[0]?.groundingMetadata || {};
    const groundingChunks = groundingMetadata.groundingChunks || [];
    const groundingSupports = groundingMetadata.groundingSupports || [];

    return {
      text: response.text || '',
      groundingChunks,
      groundingSupports
    };
  }

  /**
   * Get FileSearchStore details (including stats)
   */
  async getStore(storeName: string): Promise<any> {
    return await this.ai.fileSearchStores.get({
      name: storeName
    });
  }

  /**
   * List all FileSearchStores for this API key
   */
  async listStores(): Promise<any[]> {
    const stores: any[] = [];
    const response = await this.ai.fileSearchStores.list();

    for await (const store of response) {
      stores.push(store);
    }

    return stores;
  }

  /**
   * Delete a FileSearchStore
   */
  async deleteStore(storeName: string): Promise<void> {
    await this.ai.fileSearchStores.delete({
      name: storeName,
      config: { force: true }
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
