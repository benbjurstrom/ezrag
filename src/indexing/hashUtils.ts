// src/indexing/hashUtils.ts - Content hashing utilities

import * as crypto from "crypto";

/**
 * Compute SHA-256 hash of content
 *
 * Uses Node.js crypto (synchronous) instead of Web Crypto (async).
 * This is simpler and more performant.
 *
 * Since hashing is only used during indexing (runner-only, desktop-only),
 * we don't need to support mobile/browser environments.
 */
export function computeContentHash(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * Compute SHA-256 hash of path
 */
export function computePathHash(path: string): string {
  return crypto.createHash("sha256").update(path).digest("hex");
}
