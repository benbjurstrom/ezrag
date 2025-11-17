// src/utils/vault.ts - Vault-specific utilities

import { App } from "obsidian";
import * as crypto from "crypto";

/**
 * Compute a stable, unique key for the current vault.
 * This is used for vault-specific storage keys.
 */
export function computeVaultKey(app: App): string {
  const vaultPath = (app.vault.adapter as any).basePath ?? app.vault.getName();
  return crypto
    .createHash("sha256")
    .update(vaultPath)
    .digest("hex")
    .substring(0, 16);
}
