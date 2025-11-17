import { PreparedFile } from "./filePreparationService";

export interface GeminiMetadataField {
  key: string;
  stringValue?: string;
  numericValue?: number;
}

export function buildDocumentMetadata(
  prepared: PreparedFile,
): GeminiMetadataField[] {
  const { file, contentHash, pathHash, tags } = prepared;

  const metadata: GeminiMetadataField[] = [
    { key: "obsidian_path", stringValue: file.path },
    { key: "obsidian_path_hash", stringValue: pathHash },
    { key: "obsidian_content_hash", stringValue: contentHash },
  ];

  if (tags.length > 0) {
    metadata.push({ key: "tags", stringValue: tags.join(",") });
  }

  return metadata;
}
