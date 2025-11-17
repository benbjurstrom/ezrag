import { describe, expect, it, vi } from 'vitest';
import { DocumentReplacer } from '../src/indexing/documentReplacer';
import { ChunkingConfig } from '../src/types';

describe('DocumentReplacer integration', () => {
  const chunkingConfig: ChunkingConfig = {
    maxTokensPerChunk: 400,
    maxOverlapTokens: 50,
  };

  it('deletes an existing document before uploading a new copy', async () => {
    const gemini = {
      deleteDocument: vi.fn().mockResolvedValue(undefined),
      uploadDocument: vi.fn().mockResolvedValue('fileSearchStores/demo/documents/123'),
    } as any;

    const replacer = new DocumentReplacer(gemini);

    const documentName = await replacer.replaceDocument('fileSearchStores/demo/documents/old', {
      storeName: 'fileSearchStores/demo',
      displayName: 'Note.md',
      content: '# Hello',
      metadata: [],
      chunkingConfig,
    });

    expect(gemini.deleteDocument).toHaveBeenCalledWith('fileSearchStores/demo/documents/old');
    expect(gemini.uploadDocument).toHaveBeenCalledWith({
      storeName: 'fileSearchStores/demo',
      content: '# Hello',
      displayName: 'Note.md',
      metadata: [],
      chunkingConfig,
      mimeType: 'text/markdown',
    });
    expect(documentName).toBe('fileSearchStores/demo/documents/123');
  });

  it('skips delete when there is no prior document and allows mime overrides', async () => {
    const gemini = {
      deleteDocument: vi.fn(),
      uploadDocument: vi.fn().mockResolvedValue('doc/new'),
    } as any;

    const replacer = new DocumentReplacer(gemini);
    await replacer.replaceDocument(null, {
      storeName: 'store',
      displayName: 'Binary.bin',
      content: '0101',
      metadata: [],
      mimeType: 'application/octet-stream',
      chunkingConfig,
    });

    expect(gemini.deleteDocument).not.toHaveBeenCalled();
    expect(gemini.uploadDocument).toHaveBeenCalledWith(expect.objectContaining({ mimeType: 'application/octet-stream' }));
  });
});
