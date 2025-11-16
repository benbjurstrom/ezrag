import { PreparedFile } from './filePreparationService';

export interface GeminiMetadataField {
  key: string;
  stringValue?: string;
  numericValue?: number;
}

export function buildDocumentMetadata(vaultName: string, prepared: PreparedFile): GeminiMetadataField[] {
  const { file, contentHash, pathHash, tags } = prepared;
  const fileName = `${file.basename}.${file.extension}`;
  const fileDate = new Date(file.stat.mtime).toISOString();

  const metadata: GeminiMetadataField[] = [
    { key: 'obsidian_vault', stringValue: vaultName },
    { key: 'obsidian_path', stringValue: file.path },
    { key: 'obsidian_path_hash', stringValue: pathHash },
    { key: 'obsidian_content_hash', stringValue: contentHash },
    { key: 'obsidian_mtime', numericValue: file.stat.mtime },
    { key: 'uri', stringValue: file.path },
    { key: 'title', stringValue: file.path },
    { key: 'displayName', stringValue: file.path },
    { key: 'fileName', stringValue: fileName },
    { key: 'fileDate', stringValue: fileDate },
    { key: 'sourceUrl', stringValue: file.path },
  ];

  if (tags.length > 0) {
    metadata.push({ key: 'tags', stringValue: tags.join(',') });
  }

  return metadata;
}
