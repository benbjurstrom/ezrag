// src/state/state.ts - Obsidian-agnostic state management

import { PersistedData, PluginSettings, IndexState, IndexedDocState, DEFAULT_DATA } from '../types';

export class StateManager {
  private data: PersistedData;

  constructor(initialData?: Partial<PersistedData>) {
    this.data = { ...DEFAULT_DATA, ...initialData };
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
  }

  exportData(): PersistedData {
    return structuredClone(this.data);
  }
}
