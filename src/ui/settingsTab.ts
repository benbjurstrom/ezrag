// src/ui/settingsTab.ts - Settings UI

import { App, Platform, PluginSettingTab, Setting, Notice, setIcon } from 'obsidian';
import type EzRAGPlugin from '../../main';

interface StoreTableData {
  name: string;
  displayName: string;
  createTime: string;
  updateTime: string;
  activeDocumentsCount: number;
  pendingDocumentsCount: number;
  failedDocumentsCount: number;
  sizeBytes: number;
}

export class EzRAGSettingTab extends PluginSettingTab {
  plugin: EzRAGPlugin;
  private storeTableContainer: HTMLElement | null = null;

  constructor(app: App, plugin: EzRAGPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  async display(): Promise<void> {
    const { containerEl } = this;
    containerEl.empty();

    // Determine if we're on desktop and if this is the runner
    const isDesktop = Platform.isDesktopApp;
    const isRunner = isDesktop && this.plugin.runnerManager?.isRunner();

    if (!isDesktop) {
      // Mobile platform - show info message
      new Setting(containerEl).setName('Mobile Platform').setHeading();
      containerEl.createDiv({
        cls: 'setting-item-description',
        text: 'Indexing is not available on mobile devices. The runner can only be enabled on desktop. ' +
              'You can still configure your API key and use chat/query features once they are implemented.'
      });
    }

    // API Key Section (ALWAYS VISIBLE ON ALL PLATFORMS)
    new Setting(containerEl).setName('API Configuration').setHeading();

    const connectionState = this.plugin.getConnectionState();

    new Setting(containerEl)
      .setName('Gemini API Key')
      .setDesc('Your Google Gemini API key (get it from ai.google.dev)')
      .addText(text => text
        .setPlaceholder('Enter your API key')
        .setValue(this.plugin.stateManager.getSettings().apiKey)
        .onChange(async (value) => {
          const message = await this.plugin.updateApiKey(value);
          if (message) {
            new Notice(message);
          }
        })
      );

    if (connectionState.apiKeyError) {
      containerEl.createDiv({
        cls: 'setting-item-description mod-warning',
        text: connectionState.apiKeyError,
      });
    }

    // MCP Server Section (visible on all platforms)
    new Setting(containerEl).setName('MCP Server').setHeading();

    const mcpSettings = this.plugin.stateManager.getSettings().mcpServer;
    const mcpStatus = this.plugin.getMCPServerStatus();

    new Setting(containerEl)
      .setName('Enable MCP server')
      .setDesc('Start an MCP server to allow external tools (like Claude Code) to query your notes')
      .addToggle(toggle => toggle
        .setValue(mcpSettings.enabled)
        .onChange(async (value) => {
          await this.plugin.handleMCPServerToggle(value);
          this.display(); // Refresh to show/hide connection info
        })
      );

    if (mcpSettings.enabled) {
      // Show status
      const statusSetting = new Setting(containerEl)
        .setName('Server status')
        .setDesc(mcpStatus.running ? `Running at ${mcpStatus.url}` : 'Stopped');

      if (mcpStatus.running) {
        // Add copy URL button
        statusSetting.addButton(button => button
          .setButtonText('Copy URL')
          .onClick(() => {
            navigator.clipboard.writeText(mcpStatus.url);
            new Notice('MCP server URL copied to clipboard');
          })
        );
      }

      // Port configuration
      new Setting(containerEl)
        .setName('Server port')
        .setDesc('Port for the MCP server (requires restart if server is running)')
        .addText(text => text
          .setPlaceholder('42427')
          .setValue(String(mcpSettings.port))
          .onChange(async (value) => {
            const port = parseInt(value, 10);
            if (!isNaN(port) && port > 0 && port < 65536) {
              await this.plugin.updateMCPServerPort(port);
              this.display(); // Refresh to show new URL
            } else {
              new Notice('Invalid port number. Must be between 1 and 65535.');
            }
          })
        );

      // Connection instructions
      containerEl.createDiv({
        cls: 'setting-item-description',
        text: 'Connect using Claude Code: claude mcp add --transport http ezrag-obsidian ' + mcpStatus.url
      });

      containerEl.createDiv({
        cls: 'setting-item-description',
        text: 'Tools available: keywordSearch (vault search), semanticSearch (RAG search), note:///<path> (read notes)'
      });
    }

    // Store Management Section (Read-only operations visible on all platforms)
    new Setting(containerEl)
      .setName('Gemini FileStores')
      .setDesc('FileSearchStores associated with this API key')
      .setHeading()
      .addExtraButton(button => button
        .setIcon('refresh-cw')
        .setTooltip('Refresh store list')
        .onClick(async () => {
          await this.refreshStoreTable();
        })
      );

    // Container for the store table (will be populated by renderStoreTable)
    const storeTableContainer = containerEl.createDiv({ cls: 'ezrag-store-table-container' });
    this.storeTableContainer = storeTableContainer;

    // Initial table render
    await this.renderStoreTable();

    // Runner Configuration Toggle (Desktop only)
    if (isDesktop && this.plugin.runnerManager) {
      new Setting(containerEl).setName('Document Index').setHeading();

      const runnerManager = this.plugin.runnerManager;
      const runnerState = runnerManager.getState();

      new Setting(containerEl)
        .setName('Use this device as the runner')
        .setDesc('Only one desktop should manage indexing for this vault. Turn this on for exactly one machine.')
        .addToggle(toggle => toggle
          .setValue(runnerState.isRunner)
          .onChange(async (value) => {
            await runnerManager.setRunner(value);
            const message = await this.plugin.handleRunnerStateChange();

            this.display();

            if (message) {
              new Notice(message);
            }
          })
        );

      if (!runnerState.isRunner) {
        containerEl.createDiv({
          cls: 'setting-item-description',
          text: 'Runner controls will appear below once this is enabled.'
        });
      }
    }

    // Index Status (runner only - below runner config)
    if (isRunner) {
      const indexStatusSetting = new Setting(containerEl)
        .setName('Index Status')
        .setDesc('The index tracks which notes have been uploaded to Gemini for search and retrieval.');

      const controller = this.plugin.indexingController;
      if (controller) {
        indexStatusSetting.addButton((button) => {
          const updateLabel = () => {
            button.setButtonText(controller.isPaused() ? 'Resume' : 'Pause');
          };
          updateLabel();
          button.onClick(() => {
            if (!controller.isActive()) {
              new Notice('Indexing is not active.');
              return;
            }
            if (controller.isPaused()) {
              controller.resume();
            } else {
              controller.pause();
            }
            updateLabel();
          });
        });
      }

      indexStatusSetting.addButton(button => button
        .setButtonText('Open queue')
        .onClick(() => {
          this.plugin.openIndexingStatusModal();
        })
      );

      const stats = this.plugin.getIndexStats();

      // Stats cards
      const statsContainer = containerEl.createDiv({ cls: 'ezrag-index-stats-container' });
      const table = statsContainer.createEl('table', { cls: 'ezrag-index-stats-table' });
      const tbody = table.createEl('tbody');
      const row = tbody.createEl('tr');

      // Total indexed
      const totalCell = row.createEl('td');
      totalCell.createEl('div', { text: String(stats.total), cls: 'ezrag-stat-value' });
      totalCell.createEl('div', { text: 'Total', cls: 'ezrag-stat-label' });

      // Ready
      const readyCell = row.createEl('td');
      readyCell.createEl('div', { text: String(stats.ready), cls: 'ezrag-stat-value' });
      readyCell.createEl('div', { text: 'Ready', cls: 'ezrag-stat-label' });

      // Pending
      const pendingCell = row.createEl('td');
      pendingCell.createEl('div', { text: String(stats.pending), cls: 'ezrag-stat-value' });
      pendingCell.createEl('div', { text: 'Pending', cls: 'ezrag-stat-label' });

      // Errors
      const errorCell = row.createEl('td');
      errorCell.createEl('div', { text: String(stats.error), cls: 'ezrag-stat-value' });
      errorCell.createEl('div', { text: 'Errors', cls: 'ezrag-stat-label' });

      if (controller) {
        const controls = new Setting(containerEl)
          .setName('Rescan Notes')
          .setDesc('Scan the vault for new or modified files and queue them for upload.');

        controls.addButton((button) => {
          button.setButtonText('Rescan');
          button.onClick(async () => {
            if (!controller.isActive()) {
              new Notice('Indexing is not active.');
              return;
            }
            button.setDisabled(true);
            try {
              await controller.runFullReconcile();
              new Notice('Vault scan started');
            } catch (err) {
              console.error('[EzRAG] Failed to run full reconcile', err);
              new Notice('Failed to start scan. See console for details.');
            } finally {
              button.setDisabled(false);
            }
          });
        });

          // Rebuild Index
          new Setting(containerEl)
          .setName('Rebuild Index')
          .setDesc('Clear and rebuild the local index from Gemini. Files with matching content are restored without re-upload.')
          .addButton(button => button
            .setButtonText('Rebuild')
            .onClick(async () => {
              await this.plugin.rebuildIndex();
            })
          );

        // Clean Up Remote Index (Manual Janitor)
        new Setting(containerEl)
          .setName('Clean Up Gemini Index')
          .setDesc('Remove outdated document versions and deleted files from Gemini.')
          .addButton(button => button
            .setButtonText('Clean Up')
            .onClick(async () => {
              await this.plugin.runJanitorWithUI();
            })
          );
      }

      // Chunking Configuration Section
      new Setting(containerEl).setName('Document Index Configuration').setHeading();

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

    new Setting(containerEl)
      .setName('Upload throttle')
      .setDesc('Delay before uploading a modified note (seconds). Helps batch rapid edits into a single upload.')
      .addSlider(slider => {
        const currentSeconds = Math.floor((this.plugin.stateManager.getSettings().uploadThrottleMs ?? 0) / 1000);
        slider
          .setLimits(0, 600, 10)
          .setValue(currentSeconds)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.stateManager.updateSettings({ uploadThrottleMs: value * 1000 });
            await this.plugin.saveState();
          });
      });

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
    }
  }

  // ========== Store Table Helper Methods ==========

  /**
   * Fetch store data from Gemini API
   */
  private async fetchStoreData(): Promise<StoreTableData[]> {
    const service = this.plugin.storeManager?.['getOrCreateGeminiService']('load Gemini stores');
    if (!service) {
      return [];
    }

    try {
      const stores = await service.listStores();
      return stores as StoreTableData[];
    } catch (err) {
      console.error('[EzRAG] Failed to fetch stores:', err);
      new Notice('Failed to load stores. See console for details.');
      return [];
    }
  }

  /**
   * Render the store table
   */
  private async renderStoreTable(): Promise<void> {
    if (!this.storeTableContainer) return;

    // Clear existing content
    this.storeTableContainer.empty();

    // Fetch store data
    const stores = await this.fetchStoreData();
    const currentStoreId = this.plugin.stateManager.getSettings().storeName;

    if (stores.length === 0) {
      this.storeTableContainer.createEl('p', {
        text: 'No stores found. Upload a document to create your first store.',
        cls: 'setting-item-description'
      });
      return;
    }

    // Create table
    const table = this.storeTableContainer.createEl('table', { cls: 'ezrag-store-table' });

    // Table header
    const thead = table.createEl('thead');
    const headerRow = thead.createEl('tr');
    headerRow.createEl('th', { text: 'Display Name' });
    headerRow.createEl('th', { text: 'Active' });
    headerRow.createEl('th', { text: 'Pending' });
    headerRow.createEl('th', { text: 'Failed' });
    headerRow.createEl('th', { text: 'Size' });
    headerRow.createEl('th', { text: 'Actions' });

    // Table body
    const tbody = table.createEl('tbody');
    stores.forEach(store => {
      const row = tbody.createEl('tr');
      const isCurrent = store.name === currentStoreId;

      // Display Name
      row.createEl('td', { text: store.displayName });

      // Active count
      row.createEl('td', { text: String(store.activeDocumentsCount || 0) });

      // Pending count
      row.createEl('td', { text: String(store.pendingDocumentsCount || 0) });

      // Failed count
      row.createEl('td', { text: String(store.failedDocumentsCount || 0) });

      // Size
      row.createEl('td', { text: this.formatBytes(store.sizeBytes || 0) });

      // Actions cell
      const actionsCell = row.createEl('td', { cls: 'ezrag-store-actions' });

      // Current store indicator/toggle
      const starBtn = actionsCell.createEl('button', {
        cls: 'clickable-icon',
        attr: { 'aria-label': isCurrent ? 'Current store' : 'Set as current store' }
      });
      setIcon(starBtn, isCurrent ? 'star' : 'star-off');
      starBtn.addEventListener('click', async () => {
        if (!isCurrent) {
          await this.handleSetCurrentStore(store.name, store.displayName);
        }
      });

      // Delete button
      const deleteBtn = actionsCell.createEl('button', {
        cls: 'clickable-icon',
        attr: { 'aria-label': 'Delete store' }
      });
      setIcon(deleteBtn, 'trash');
      deleteBtn.addEventListener('click', async () => {
        await this.handleDeleteStore(store.name, store.displayName, isCurrent);
      });
    });

    // Warning if too many stores
    if (stores.length > 20) {
      this.storeTableContainer.createEl('p', {
        text: 'Note: You have more than 20 stores. Consider cleaning up unused stores for better performance.',
        cls: 'setting-item-description'
      });
    }
  }

  /**
   * Refresh the store table
   */
  private async refreshStoreTable(): Promise<void> {
    await this.renderStoreTable();
  }

  /**
   * Handle deleting a store
   */
  private async handleDeleteStore(storeId: string, storeName: string, isCurrent: boolean): Promise<void> {
    const confirmed = await this.plugin.confirmAction(
      'Delete Store',
      `Are you sure you want to permanently delete "${storeName}"?\n\n` +
      `This will delete all indexed documents in this store and cannot be undone.` +
      (isCurrent ? '\n\nThis is your current store. A new store will be automatically created and set as current after deletion.' : '')
    );

    if (!confirmed) return;

    const service = this.plugin.storeManager?.['getOrCreateGeminiService']('delete a FileSearch store');
    if (!service) return;

    try {
      await service.deleteStore(storeId);

      // If deleting current store, clear settings and create a new one
      if (isCurrent) {
        this.plugin.stateManager.updateSettings({
          storeName: '',
          storeDisplayName: ''
        });
        this.plugin.stateManager.clearIndex();
        await this.plugin.saveState();

        new Notice(`Store "${storeName}" deleted. Creating new store...`);

        // Create new store and set as current
        try {
          await this.plugin.ensureGeminiResources();

          const newStoreName = this.plugin.stateManager.getSettings().storeDisplayName;
          new Notice(`New store "${newStoreName}" created and set as current`);

          // Trigger index rebuild if this is a runner
          if (Platform.isDesktopApp && this.plugin.runnerManager?.isRunner()) {
            await this.plugin.rebuildIndex();
          }
        } catch (err) {
          console.error('[EzRAG] Failed to create new store:', err);
          new Notice('Failed to create new store. See console for details.');
        }
      } else {
        new Notice(`Store "${storeName}" deleted successfully`);
      }

      await this.refreshStoreTable();

      // Re-render entire settings to update other sections
      if (isCurrent) {
        this.display();
      }
    } catch (err) {
      console.error('[EzRAG] Failed to delete store:', err);
      new Notice(`Failed to delete store "${storeName}". See console for details.`);
    }
  }

  /**
   * Handle setting a store as current
   */
  private async handleSetCurrentStore(storeId: string, storeName: string): Promise<void> {
    const currentStoreName = this.plugin.stateManager.getSettings().storeDisplayName;

    const confirmed = await this.plugin.confirmAction(
      'Change Current Store',
      `Set "${storeName}" as your current store?\n\n` +
      (currentStoreName
        ? `This will replace "${currentStoreName}" as your current store. Your local index will be cleared and rebuilt from this store.`
        : `This will set "${storeName}" as your current store and rebuild your local index.`)
    );

    if (!confirmed) return;

    try {
      // Update settings
      this.plugin.stateManager.updateSettings({
        storeName: storeId,
        storeDisplayName: storeName
      });

      // Clear and rebuild index
      this.plugin.stateManager.clearIndex();
      await this.plugin.saveState();

      new Notice(`Current store set to "${storeName}". Rebuilding local index...`);

      // Trigger index rebuild if this is a runner
      if (Platform.isDesktopApp && this.plugin.runnerManager?.isRunner()) {
        await this.plugin.rebuildIndex();
      }

      // Refresh the table to update the star icons
      await this.refreshStoreTable();

      // Re-render entire settings to update other sections
      this.display();
    } catch (err) {
      console.error('[EzRAG] Failed to set current store:', err);
      new Notice(`Failed to set current store. See console for details.`);
    }
  }

  /**
   * Format bytes to human-readable size
   */
  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';

    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  }
}
