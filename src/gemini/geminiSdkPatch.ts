import type { GoogleGenAI } from "@google/genai";

type UploadConfig = {
  mimeType?: string;
  displayName?: string;
  customMetadata?: unknown;
  chunkingConfig?: unknown;
  httpOptions?: Record<string, unknown>;
};

type PatchedApiClient = {
  uploadFileToFileSearchStore: (
    fileSearchStoreName: string,
    file: File | Blob | string,
    config?: UploadConfig,
  ) => Promise<unknown>;
  fetchUploadUrl: (
    path: string,
    sizeBytes: string,
    mimeType: string,
    fileName: string,
    body: Record<string, unknown>,
    httpOptions?: Record<string, unknown>,
  ) => Promise<string>;
  getFileName: (file: File | Blob | string) => string;
  clientOptions?: {
    uploader?: {
      stat: (
        file: File | Blob | string,
      ) => Promise<{ size: number; type?: string }>;
      uploadToFileSearchStore: (
        file: File | Blob | string,
        uploadUrl: string,
        apiClient: PatchedApiClient,
      ) => Promise<unknown>;
    };
  };
  __ezragUploadPatched?: boolean;
};

type GoogleGenAIWithClient = GoogleGenAI & { apiClient?: PatchedApiClient };

/**
 * The Gemini SDK currently drops the displayName from upload requests.
 * We patch the ApiClient instance at runtime so we do not need every tester
 * to patch node_modules locally.
 */
export function ensureGeminiUploadPatch(ai: GoogleGenAI): void {
  const client = (ai as GoogleGenAIWithClient).apiClient;
  const uploader = client?.clientOptions?.uploader;

  if (!client || !uploader || client.__ezragUploadPatched) {
    return;
  }

  client.uploadFileToFileSearchStore = async function patchedUpload(
    this: PatchedApiClient,
    fileSearchStoreName: string,
    file: File | Blob | string,
    config?: UploadConfig,
  ) {
    const resolvedConfig = config ?? {};
    const fileStat = await uploader.stat(file);
    const sizeBytes = String(fileStat.size);
    const mimeType = resolvedConfig.mimeType ?? fileStat.type;

    if (!mimeType) {
      throw new Error(
        "Cannot determine mimeType. Provide one via config.mimeType.",
      );
    }

    const body: Record<string, unknown> = {};
    if (resolvedConfig.displayName) {
      body.displayName = resolvedConfig.displayName;
    }
    if (resolvedConfig.customMetadata) {
      body.customMetadata = resolvedConfig.customMetadata;
    }
    if (resolvedConfig.chunkingConfig) {
      body.chunkingConfig = resolvedConfig.chunkingConfig;
    }

    const path = `upload/v1beta/${fileSearchStoreName}:uploadToFileSearchStore`;
    const fileName = this.getFileName(file);
    const uploadUrl = await this.fetchUploadUrl(
      path,
      sizeBytes,
      mimeType,
      fileName,
      body,
      resolvedConfig.httpOptions,
    );

    return uploader.uploadToFileSearchStore(file, uploadUrl, this);
  };

  client.__ezragUploadPatched = true;
}
