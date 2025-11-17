import { describe, expect, it } from 'vitest';
import { FilePreparationService } from '../src/indexing/filePreparationService';
import { App, TFile, Vault } from 'obsidian';

function setupFile(content: string, metadata?: any): { service: FilePreparationService; file: TFile; vault: Vault; app: App } {
  const vault = new Vault();
  const app = new App();
  const file = vault.createMarkdownFile('Research/Note.md', content);
  if (metadata) {
    app.metadataCache.setFileCache(file, metadata);
  }
  const service = new FilePreparationService(vault as any, app as any);
  return { service, file, vault, app };
}

describe('FilePreparationService integration', () => {
  it('returns prepared content with derived hashes and tags', async () => {
    const metadata = { frontmatter: { tags: ['research', 'obsidian'] } };
    const { service, file, vault } = setupFile('Hello world', metadata);
    vault.setFileContent(file.path, 'Hello world');

    const result = await service.prepare(file);

    expect(result.type).toBe('prepared');
    if (result.type !== 'prepared') return;

    expect(result.data.content).toBe('Hello world');
    expect(result.data.trimmedContent).toBe('Hello world');
    expect(result.data.tags).toEqual(['research', 'obsidian']);
    expect(result.data.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.data.pathHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('skips empty files after trimming whitespace', async () => {
    const { service, file, vault } = setupFile('   ');
    vault.setFileContent(file.path, '   ');

    const result = await service.prepare(file);
    expect(result).toEqual({ type: 'skip', reason: 'empty' });
  });
});
