import { App, TFile, Vault } from 'obsidian';
import { computeContentHash, computePathHash } from './hashUtils';

export interface PreparedFile {
  file: TFile;
  content: string;
  trimmedContent: string;
  contentHash: string;
  pathHash: string;
  tags: string[];
}

export type PreparationResult =
  | { type: 'prepared'; data: PreparedFile }
  | { type: 'skip'; reason: 'empty' };

export class FilePreparationService {
  constructor(private vault: Vault, private app: App) {}

  async prepare(file: TFile): Promise<PreparationResult> {
    const content = await this.vault.read(file);
    const trimmedContent = content.trim();
    if (trimmedContent.length === 0) {
      return { type: 'skip', reason: 'empty' };
    }

    return {
      type: 'prepared',
      data: {
        file,
        content,
        trimmedContent,
        contentHash: computeContentHash(content),
        pathHash: computePathHash(file.path),
        tags: this.extractTags(file),
      },
    };
  }

  private extractTags(file: TFile): string[] {
    const cache = this.app.metadataCache.getFileCache(file);
    if (!cache?.frontmatter?.tags) return [];

    const tags = cache.frontmatter.tags;
    if (typeof tags === 'string') return [tags];
    if (Array.isArray(tags)) return tags;
    return [];
  }
}
