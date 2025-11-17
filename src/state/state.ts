// src/state/state.ts - Obsidian-agnostic state management

import {
  PersistedData,
  PluginSettings,
  IndexedDocState,
  DEFAULT_DATA,
  IndexQueueEntry,
} from "../types";

export class StateManager {
  private data: PersistedData;

  constructor(initialData?: Partial<PersistedData>) {
    const base = structuredClone(DEFAULT_DATA);

    if (initialData) {
      base.version = initialData.version ?? base.version;
      if (initialData.settings) {
        base.settings = { ...base.settings, ...initialData.settings };
      }

      if (initialData.index) {
        if (initialData.index.docs) {
          base.index.docs = {
            ...base.index.docs,
            ...initialData.index.docs,
          };
        }
        if (initialData.index.queue) {
          base.index.queue = [...initialData.index.queue];
        }
      }
    }

    this.data = base;
  }

  getSettings(): PluginSettings {
    return this.data.settings;
  }

  updateSettings(updates: Partial<PluginSettings>): void {
    this.data.settings = { ...this.data.settings, ...updates };
  }

  getDocState(vaultPath: string): IndexedDocState | undefined {
    return this.data.index.docs[vaultPath];
  }

  setDocState(vaultPath: string, state: IndexedDocState): void {
    this.data.index.docs[vaultPath] = state;
  }

  removeDocState(vaultPath: string): void {
    delete this.data.index.docs[vaultPath];
  }

  getAllDocStates(): Record<string, IndexedDocState> {
    return this.data.index.docs;
  }

  clearIndex(): void {
    this.data.index.docs = {};
    this.data.index.queue = [];
  }

  // ===== Persistent queue helpers =====

  getQueueEntries(): IndexQueueEntry[] {
    return [...this.data.index.queue];
  }

  addOrUpdateQueueEntry(entry: IndexQueueEntry): void {
    const filtered = this.data.index.queue.filter(
      (existing) => existing.vaultPath !== entry.vaultPath,
    );
    filtered.push(entry);
    this.data.index.queue = filtered;
  }

  removeQueueEntry(entryId: string): void {
    this.data.index.queue = this.data.index.queue.filter(
      (entry) => entry.id !== entryId,
    );
  }

  removeQueueEntriesByPath(vaultPath: string): number {
    const before = this.data.index.queue.length;
    this.data.index.queue = this.data.index.queue.filter(
      (entry) => entry.vaultPath !== vaultPath,
    );
    return before - this.data.index.queue.length;
  }

  findQueueEntryByPath(vaultPath: string): IndexQueueEntry | undefined {
    return this.data.index.queue.find((entry) => entry.vaultPath === vaultPath);
  }

  findQueueEntryById(id: string): IndexQueueEntry | undefined {
    return this.data.index.queue.find((entry) => entry.id === id);
  }

  updateQueueEntry(entryId: string, updates: Partial<IndexQueueEntry>): void {
    this.data.index.queue = this.data.index.queue.map((entry) =>
      entry.id === entryId ? { ...entry, ...updates } : entry,
    );
  }

  clearQueue(): void {
    this.data.index.queue = [];
  }

  /**
   * Export settings for data.json persistence.
   * Returns only settings and version (synced data).
   */
  exportSettings(): { version: number; settings: PluginSettings } {
    return {
      version: this.data.version,
      settings: structuredClone(this.data.settings),
    };
  }

  /**
   * Export index state for localStorage persistence.
   * Returns only docs and queue (device-specific data).
   */
  exportIndexState(): {
    docs: Record<string, IndexedDocState>;
    queue: IndexQueueEntry[];
  } {
    return {
      docs: structuredClone(this.data.index.docs),
      queue: structuredClone(this.data.index.queue),
    };
  }

  /**
   * Export complete data structure (for backwards compatibility).
   */
  exportData(): PersistedData {
    return structuredClone(this.data);
  }
}
