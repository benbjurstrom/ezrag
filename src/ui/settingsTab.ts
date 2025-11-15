// src/ui/settingsTab.ts - Settings UI

import { App, Platform, PluginSettingTab, Setting, Notice } from 'obsidian';
import type EzRAGPlugin from '../../main';

export class EzRAGSettingTab extends PluginSettingTab {
  plugin: EzRAGPlugin;

  constructor(app: App, plugin: EzRAGPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'EzRAG Settings' });

    // Determine if we're on desktop and if this is the runner
    const isDesktop = Platform.isDesktopApp;
    const isRunner = isDesktop && this.plugin.runnerManager?.isRunner();

    // Runner Configuration Section (Desktop only)
    if (isDesktop) {
      containerEl.createEl('h3', { text: 'Runner Configuration' });

      const runnerState = this.plugin.runnerManager!.getState();

      new Setting(containerEl)
        .setName('This machine is the runner')
        .setDesc(
          'Enable indexing on this machine. Only ONE machine per vault should be the runner. ' +
          (runnerState.deviceId ? `Device ID: ${runnerState.deviceId.substring(0, 8)}...` : '')
        )
        .addToggle(toggle => toggle
          .setValue(runnerState.isRunner)
          .onChange(async (value) => {
            await this.plugin.runnerManager!.setRunner(value);
            const message = await this.plugin.handleRunnerStateChange();

            this.display();

            if (message) {
              new Notice(message);
            }
          })
        );

      // If not runner, show message
      if (!runnerState.isRunner) {
        containerEl.createDiv({
          cls: 'setting-item-description',
          text: 'Indexing controls are hidden because this machine is not the runner. ' +
                'Enable "This machine is the runner" above to access indexing settings.'
        });
      }

      // Separator
      containerEl.createEl('hr');
    } else {
      // Mobile platform - show info message
      containerEl.createEl('h3', { text: 'Mobile Platform' });
      containerEl.createDiv({
        cls: 'setting-item-description',
        text: 'Indexing is not available on mobile devices. The runner can only be enabled on desktop. ' +
              'You can still configure your API key and use chat/query features once they are implemented.'
      });
      containerEl.createEl('hr');
    }

    // API Key Section (ALWAYS VISIBLE ON ALL PLATFORMS)
    containerEl.createEl('h3', { text: 'API Configuration' });

    new Setting(containerEl)
      .setName('Gemini API Key')
      .setDesc('Your Google Gemini API key (get it from ai.google.dev)')
      .addText(text => {
        text
          .setPlaceholder('Enter your API key')
          .setValue(this.plugin.stateManager.getSettings().apiKey);

        text.inputEl.addEventListener('change', async () => {
          const message = await this.plugin.updateApiKey(text.getValue());
          if (message) {
            new Notice(message);
          }
        });
      });

    // INDEXING CONTROLS (Desktop Runner Only)
    if (isRunner) {
      containerEl.createEl('hr');
      containerEl.createEl('h3', { text: 'Indexing Configuration' });

      // Included Folders
      new Setting(containerEl)
        .setName('Included Folders')
        .setDesc('Comma-separated list of folders to index (empty = entire vault)')
        .addText(text => text
          .setPlaceholder('e.g., Projects, Notes')
          .setValue(this.plugin.stateManager.getSettings().includeFolders.join(', '))
          .onChange(async (value) => {
            const folders = value.split(',').map(f => f.trim()).filter(Boolean);
            this.plugin.stateManager.updateSettings({ includeFolders: folders });
            await this.plugin.saveState();
          })
        );

      // Concurrency
      new Setting(containerEl)
        .setName('Upload Concurrency')
        .setDesc('Number of concurrent uploads (1-5). Each upload polls until complete.')
        .addSlider(slider => slider
          .setLimits(1, 5, 1)
          .setValue(this.plugin.stateManager.getSettings().maxConcurrentUploads)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.stateManager.updateSettings({ maxConcurrentUploads: value });
            await this.plugin.saveState();
          })
        );

      // Chunking Configuration Section
      containerEl.createEl('h3', { text: 'Chunking Strategy' });

      new Setting(containerEl)
        .setName('Max Tokens Per Chunk')
        .setDesc('Maximum number of tokens in each chunk (100-1000)')
        .addSlider(slider => slider
          .setLimits(100, 1000, 50)
          .setValue(this.plugin.stateManager.getSettings().chunkingConfig.maxTokensPerChunk)
          .setDynamicTooltip()
          .onChange(async (value) => {
            const config = this.plugin.stateManager.getSettings().chunkingConfig;
            this.plugin.stateManager.updateSettings({
              chunkingConfig: { ...config, maxTokensPerChunk: value }
            });
            await this.plugin.saveState();
          })
        );

      new Setting(containerEl)
        .setName('Max Overlap Tokens')
        .setDesc('Number of overlapping tokens between chunks (0-200)')
        .addSlider(slider => slider
          .setLimits(0, 200, 10)
          .setValue(this.plugin.stateManager.getSettings().chunkingConfig.maxOverlapTokens)
          .setDynamicTooltip()
          .onChange(async (value) => {
            const config = this.plugin.stateManager.getSettings().chunkingConfig;
            this.plugin.stateManager.updateSettings({
              chunkingConfig: { ...config, maxOverlapTokens: value }
            });
            await this.plugin.saveState();
          })
        );

      // Manual Commands Section
      containerEl.createEl('h3', { text: 'Manual Actions' });

      // Rebuild Index
      new Setting(containerEl)
        .setName('Rebuild Index')
        .setDesc('Clear local index and re-index all files')
        .addButton(button => button
          .setButtonText('Rebuild')
          .onClick(async () => {
            await this.plugin.rebuildIndex();
          })
        );

      // Run Deduplication (Manual Janitor)
      new Setting(containerEl)
        .setName('Run Deduplication')
        .setDesc('Find and remove duplicate documents created by multi-device sync conflicts')
        .addButton(button => button
          .setButtonText('Run Deduplication')
          .onClick(async () => {
            await this.plugin.runJanitorWithUI();
          })
        );
    }

    // Store Management Section (Read-only operations visible on all platforms)
    containerEl.createEl('hr');
    containerEl.createEl('h3', { text: 'Store Management' });

    // Current Store Stats (available on all platforms if API key is set)
    new Setting(containerEl)
      .setName('Current Store Stats')
      .setDesc('View statistics for the current vault\'s FileSearchStore')
      .addButton(button => button
        .setButtonText('View Stats')
        .onClick(async () => {
          await this.plugin.storeManager?.showStoreStats();
        })
      );

    // List All Stores (available on all platforms if API key is set)
    new Setting(containerEl)
      .setName('List All Stores')
      .setDesc('View all FileSearchStores associated with this API key')
      .addButton(button => button
        .setButtonText('List Stores')
        .onClick(async () => {
          await this.plugin.storeManager?.listAllStores();
        })
      );

    // Delete Current Store (runner only - destructive operation)
    if (isRunner) {
      new Setting(containerEl)
        .setName('Delete Current Store')
        .setDesc('Permanently delete the FileSearchStore for this vault (cannot be undone!)')
        .addButton(button => button
          .setButtonText('Delete Store')
          .setWarning()
          .onClick(async () => {
            await this.plugin.storeManager?.deleteCurrentStore();
          })
        );
    }

    // Index Status Display (runner only - only relevant for indexing)
    if (isRunner) {
      containerEl.createEl('h3', { text: 'Index Status' });

      const stats = this.plugin.getIndexStats();
      const statusEl = containerEl.createDiv({ cls: 'ezrag-status' });
      statusEl.createEl('p', { text: `Total documents: ${stats.total}` });
      statusEl.createEl('p', { text: `Ready: ${stats.ready}` });
      statusEl.createEl('p', { text: `Pending: ${stats.pending}` });
      statusEl.createEl('p', { text: `Error: ${stats.error}` });

      new Setting(containerEl)
        .setName('Live controls')
        .setDesc('Open the indexing status panel to pause, resume, or rescan')
        .addButton(button => button
          .setButtonText('Open status panel')
          .onClick(() => {
            this.plugin.openIndexingStatusModal();
          })
        );
    }
  }
}
