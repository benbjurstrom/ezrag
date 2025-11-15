// src/store/storeManager.ts - Store helpers

import { Modal, Notice } from 'obsidian';
import type EzRAGPlugin from '../../main';
import { GeminiService } from '../gemini/geminiService';

export class StoreManager {
  constructor(private plugin: EzRAGPlugin) {}

  private getOrCreateGeminiService(): GeminiService | null {
    const service = this.plugin.getGeminiService();
    if (!service) {
      new Notice('Please configure your API key first');
      return null;
    }
    return service;
  }

  async showStoreStats(): Promise<void> {
    const service = this.getOrCreateGeminiService();
    if (!service) return;

    const settings = this.plugin.stateManager.getSettings();
    if (!settings.storeName) {
      new Notice('No store configured');
      return;
    }

    try {
      const store = await service.getStore(settings.storeName);

      const modal = new Modal(this.plugin.app);
      modal.contentEl.createEl('h2', { text: 'Store Statistics' });
      modal.contentEl.createEl('p', { text: `Name: ${store.displayName}` });
      modal.contentEl.createEl('p', { text: `ID: ${store.name}` });
      modal.contentEl.createEl('p', { text: `Created: ${new Date(store.createTime).toLocaleString()}` });
      modal.contentEl.createEl('p', { text: `Updated: ${new Date(store.updateTime).toLocaleString()}` });
      modal.open();
    } catch (err) {
      console.error('[EzRAG] Failed to fetch store stats:', err);
      new Notice('Failed to fetch store stats. See console for details.');
    }
  }

  async listAllStores(): Promise<void> {
    const service = this.getOrCreateGeminiService();
    if (!service) return;

    try {
      const stores = await service.listStores();

      const modal = new Modal(this.plugin.app);
      modal.contentEl.createEl('h2', { text: 'All FileSearchStores' });

      if (stores.length === 0) {
        modal.contentEl.createEl('p', { text: 'No stores found' });
      } else {
        const list = modal.contentEl.createEl('ul');
        stores.forEach(store => {
          list.createEl('li', { text: `${store.displayName} (${store.name})` });
        });
      }

      modal.open();
    } catch (err) {
      console.error('[EzRAG] Failed to list stores:', err);
      new Notice('Failed to list stores. See console for details.');
    }
  }

  async deleteCurrentStore(): Promise<void> {
    const service = this.getOrCreateGeminiService();
    if (!service) return;

    const settings = this.plugin.stateManager.getSettings();
    if (!settings.storeName) {
      new Notice('No store configured');
      return;
    }

    const confirmed = await this.plugin.confirmAction(
      'Delete Store',
      'This will PERMANENTLY delete the FileSearchStore and all indexed documents. This cannot be undone! Continue?'
    );

    if (!confirmed) return;

    try {
      await service.deleteStore(settings.storeName);

      this.plugin.stateManager.updateSettings({
        storeName: '',
        storeDisplayName: ''
      });
      this.plugin.stateManager.clearIndex();
      await this.plugin.saveState();

      new Notice('Store deleted successfully');
    } catch (err) {
      console.error('[EzRAG] Failed to delete store:', err);
      new Notice('Failed to delete store. See console for details.');
    }
  }
}
