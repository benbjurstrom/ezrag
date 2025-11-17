import { App } from "obsidian";
import type { IndexState, IndexedDocState, IndexQueueEntry } from "../types";
import { computeVaultKey } from "../utils/vault";

/**
 * Default empty index state
 */
const DEFAULT_INDEX_STATE: IndexState = {
  docs: {},
  queue: [],
};

/**
 * Manages localStorage persistence for index and queue data.
 *
 * This data is device-specific and should NOT sync across devices because:
 * - Indexing only runs on the designated runner device
 * - Index can be rebuilt from Gemini if lost
 * - Queue is ephemeral working state
 *
 * Pattern follows RunnerStateManager for consistency.
 */
export class IndexStateStorageManager {
  private app: App;
  private pluginId: string;
  private storageKey: string;
  private cachedState: IndexState;

  constructor(app: App, pluginId: string) {
    this.app = app;
    this.pluginId = pluginId;
    this.storageKey = this.buildStorageKey();
    this.cachedState = this.readFromStorage();
  }

  /**
   * Build localStorage key unique to this vault and plugin.
   * Uses the same vault key computation as RunnerStateManager.
   */
  private buildStorageKey(): string {
    const vaultKey = computeVaultKey(this.app);
    return `ezrag.indexState.${this.pluginId}.${vaultKey}`;
  }

  /**
   * Read index state from localStorage.
   * Returns default empty state if not found or on error.
   */
  private readFromStorage(): IndexState {
    if (typeof window === "undefined" || !window.localStorage) {
      return this.deepClone(DEFAULT_INDEX_STATE);
    }

    try {
      const raw = window.localStorage.getItem(this.storageKey);
      if (!raw) {
        return this.deepClone(DEFAULT_INDEX_STATE);
      }

      const parsed = JSON.parse(raw) as IndexState;

      // Validate structure
      if (!this.isValidIndexState(parsed)) {
        console.warn(
          "[IndexStateStorageManager] Invalid data structure in localStorage, using defaults",
        );
        return this.deepClone(DEFAULT_INDEX_STATE);
      }

      return parsed;
    } catch (err) {
      console.error(
        "[IndexStateStorageManager] Failed to read index state from localStorage",
        err,
      );
      return this.deepClone(DEFAULT_INDEX_STATE);
    }
  }

  /**
   * Write index state to localStorage.
   */
  private writeToStorage(state: IndexState): void {
    if (typeof window === "undefined" || !window.localStorage) {
      console.warn("[IndexStateStorageManager] localStorage not available");
      return;
    }

    try {
      window.localStorage.setItem(this.storageKey, JSON.stringify(state));
      this.cachedState = this.deepClone(state);
    } catch (err) {
      console.error(
        "[IndexStateStorageManager] Failed to write index state to localStorage",
        err,
      );
      // Check if quota exceeded
      if (err instanceof DOMException && err.name === "QuotaExceededError") {
        console.error(
          "[IndexStateStorageManager] localStorage quota exceeded! Index data too large.",
        );
      }
    }
  }

  /**
   * Validate that parsed data has the expected structure.
   */
  private isValidIndexState(data: any): data is IndexState {
    if (!data || typeof data !== "object") {
      return false;
    }

    // Check docs structure
    if (!data.docs || typeof data.docs !== "object") {
      return false;
    }

    // Check queue structure
    if (!Array.isArray(data.queue)) {
      return false;
    }

    return true;
  }

  /**
   * Deep clone to avoid reference sharing.
   */
  private deepClone<T>(obj: T): T {
    return JSON.parse(JSON.stringify(obj));
  }

  /**
   * Get current index state (returns a copy to prevent mutation).
   */
  getState(): IndexState {
    return this.deepClone(this.cachedState);
  }

  /**
   * Save index state to localStorage.
   * Updates cache and persists to storage.
   */
  setState(state: IndexState): void {
    this.writeToStorage(state);
  }

  /**
   * Clear all index state from localStorage.
   * Useful for migrations or reset operations.
   */
  clearState(): void {
    if (typeof window === "undefined" || !window.localStorage) {
      return;
    }

    try {
      window.localStorage.removeItem(this.storageKey);
      this.cachedState = this.deepClone(DEFAULT_INDEX_STATE);
    } catch (err) {
      console.error(
        "[IndexStateStorageManager] Failed to clear index state",
        err,
      );
    }
  }

  /**
   * Get storage key (useful for debugging).
   */
  getStorageKey(): string {
    return this.storageKey;
  }
}
