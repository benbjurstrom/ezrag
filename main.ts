// main.ts - Plugin entry point

import { App, Modal, Platform, Plugin, TFile, Notice } from 'obsidian';
import { StateManager } from './src/state/state';
import { DEFAULT_DATA } from './src/types';
import { GeminiService } from './src/gemini/geminiService';
import { IndexManager } from './src/indexing/indexManager';
import { RunnerStateManager } from './src/runner/runnerState';
import { JanitorProgressModal } from './src/ui/janitorProgressModal';
import { EzRAGSettingTab } from './src/ui/settingsTab';

export default class EzRAGPlugin extends Plugin {
  stateManager!: StateManager;
  runnerManager: RunnerStateManager | null = null; // Only on desktop
  geminiService: GeminiService | null = null;
  indexManager: IndexManager | null = null;
  statusBarItem: HTMLElement | null = null;

  async onload() {
    console.log('Loading EzRAG plugin');

    // Load persisted data with proper deep merge for nested objects
    const savedData = await this.loadData();
    if (savedData) {
      // Deep merge nested chunkingConfig
      savedData.settings = {
        ...DEFAULT_DATA.settings,
        ...savedData.settings,
        chunkingConfig: {
          ...DEFAULT_DATA.settings.chunkingConfig,
          ...(savedData.settings?.chunkingConfig || {})
        }
      };
    }
    this.stateManager = new StateManager(savedData || DEFAULT_DATA);

    // Load runner state (per-machine, per-vault, non-synced)
    // ONLY AVAILABLE ON DESKTOP - mobile doesn't support Node.js modules
    if (Platform.isDesktopApp) {
      this.runnerManager = new RunnerStateManager(this.app, this.manifest.id);
    }

    // FIRST-RUN ONBOARDING: Check if API key is set
    const settings = this.stateManager.getSettings();
    const isFirstRun = !settings.apiKey;

    if (isFirstRun) {
      // Show welcome notice with action button
      this.showFirstRunWelcome();
    } else if (this.runnerManager?.isRunner()) {
      // Only initialize services on the runner machine (desktop only)
      await this.initializeServices();
    }

    // Add settings tab
    this.addSettingTab(new EzRAGSettingTab(this.app, this));

    // Add status bar
    this.statusBarItem = this.addStatusBarItem();
    this.updateStatusBar(this.getStatusBarText());

    // Register vault events after layout is ready to avoid processing existing files on startup
    // ONLY REGISTER IF THIS MACHINE IS THE RUNNER
    this.app.workspace.onLayoutReady(() => {
      if (!this.runnerManager?.isRunner()) {
        console.log('[EzRAG] Not the runner machine, skipping vault event registration');
        return;
      }

      this.registerEvent(
        this.app.vault.on('create', (file) => {
          if (file instanceof TFile) {
            this.indexManager?.onFileCreated(file);
          }
        })
      );

      this.registerEvent(
        this.app.vault.on('modify', (file) => {
          if (file instanceof TFile) {
            this.indexManager?.onFileModified(file);
          }
        })
      );

      this.registerEvent(
        this.app.vault.on('rename', (file, oldPath) => {
          if (file instanceof TFile) {
            this.indexManager?.onFileRenamed(file, oldPath);
          }
        })
      );

      this.registerEvent(
        this.app.vault.on('delete', (file) => {
          if (file instanceof TFile) {
            this.indexManager?.onFileDeleted(file.path);
          }
        })
      );

      // Run startup reconciliation after layout is ready (only on runner)
      if (this.indexManager) {
        this.indexManager.reconcileOnStartup();
      }
    });

    // Add commands (only available if runner)
    this.addCommand({
      id: 'rebuild-index',
      name: 'Rebuild Index',
      checkCallback: (checking) => {
        if (!this.runnerManager?.isRunner()) return false;
        if (!checking) this.rebuildIndex();
        return true;
      },
    });

    this.addCommand({
      id: 'cleanup-orphans',
      name: 'Cleanup Orphaned Documents',
      checkCallback: (checking) => {
        if (!this.runnerManager?.isRunner()) return false;
        if (!checking) this.cleanupOrphans();
        return true;
      },
    });

    this.addCommand({
      id: 'run-janitor',
      name: 'Run Deduplication',
      checkCallback: (checking) => {
        if (!this.runnerManager?.isRunner()) return false;
        if (!checking) this.runJanitorWithUI();
        return true;
      },
    });
  }

  onunload() {
    console.log('Unloading EzRAG plugin');
  }

  /**
   * Initialize Gemini service and IndexManager
   */
  async initializeServices(): Promise<void> {
    const settings = this.stateManager.getSettings();

    if (!settings.apiKey) {
      console.log('[EzRAG] No API key configured, skipping service initialization');
      return;
    }

    // Initialize Gemini service
    this.geminiService = new GeminiService(settings.apiKey);

    // Get or create FileSearchStore
    if (!settings.storeName) {
      const vaultName = this.app.vault.getName();
      const displayName = `ezrag-${vaultName}`;

      try {
        const storeName = await this.geminiService.getOrCreateStore(displayName);
        this.stateManager.updateSettings({
          storeName,
          storeDisplayName: displayName
        });
        await this.saveState();
        console.log('[EzRAG] Created FileSearchStore:', storeName);
      } catch (err) {
        console.error('[EzRAG] Failed to create FileSearchStore:', err);
        new Notice('Failed to create Gemini FileSearchStore. Check API key.');
        return;
      }
    }

    // Initialize IndexManager (only if runner)
    if (this.runnerManager?.isRunner()) {
      this.indexManager = new IndexManager({
        vault: this.app.vault,
        app: this.app,
        stateManager: this.stateManager,
        geminiService: this.geminiService,
        vaultName: this.app.vault.getName(),
        onProgress: (current, total, status) => {
          this.updateStatusBar(`${status}: ${current}/${total}`);
        },
      });

      console.log('[EzRAG] Services initialized (runner mode)');
    }
  }

  /**
   * Save state to disk
   */
  async saveState(): Promise<void> {
    await this.saveData(this.stateManager.exportData());
  }

  /**
   * Rebuild index
   */
  async rebuildIndex(): Promise<void> {
    if (!this.indexManager) {
      new Notice('Index manager not initialized');
      return;
    }

    const confirmed = await this.confirmAction(
      'Rebuild Index',
      'This will clear the local index and re-index all files. Continue?'
    );

    if (confirmed) {
      await this.indexManager.rebuildIndex();
      await this.saveState();
      new Notice('Index rebuild started');
    }
  }

  /**
   * Cleanup orphaned documents
   */
  async cleanupOrphans(): Promise<void> {
    if (!this.indexManager) {
      new Notice('Index manager not initialized');
      return;
    }

    const confirmed = await this.confirmAction(
      'Cleanup Orphans',
      'This will delete documents from Gemini that no longer exist in your vault. Continue?'
    );

    if (confirmed) {
      try {
        const deleted = await this.indexManager.cleanupOrphans();
        await this.saveState();
        new Notice(`Cleanup complete: ${deleted} orphaned documents deleted`);
      } catch (err) {
        console.error('[EzRAG] Cleanup failed:', err);
        new Notice('Cleanup failed. See console for details.');
      }
    }
  }

  /**
   * Run deduplication with UI
   */
  async runJanitorWithUI(): Promise<void> {
    if (!this.indexManager) {
      new Notice('Index manager not initialized');
      return;
    }

    const modal = new JanitorProgressModal(this.app);
    modal.open();

    try {
      const janitor = this.indexManager.getJanitor();
      const stats = await janitor.runDeduplication();

      modal.updateStats(stats);
      modal.markComplete();

      await this.saveState();

      new Notice(
        `Deduplication complete: ${stats.duplicatesDeleted} duplicates removed, ${stats.stateUpdated} state updates`
      );
    } catch (err) {
      console.error('[EzRAG] Deduplication failed:', err);
      modal.markFailed((err as Error).message);
      new Notice('Deduplication failed. See console for details.');
    }
  }

  /**
   * Get or create a temporary GeminiService for read-only operations
   * This allows non-runner devices to view store stats and list stores
   */
  private getOrCreateGeminiService(): GeminiService | null {
    // If we already have a service, use it
    if (this.geminiService) {
      return this.geminiService;
    }

    // If no API key, can't create service
    const apiKey = this.stateManager.getSettings().apiKey;
    if (!apiKey) {
      new Notice('Please configure your API key first');
      return null;
    }

    // Create temporary service for this operation
    return new GeminiService(apiKey);
  }

  /**
   * Show store stats
   */
  async showStoreStats(): Promise<void> {
    const service = this.getOrCreateGeminiService();
    if (!service) return;

    const settings = this.stateManager.getSettings();
    if (!settings.storeName) {
      new Notice('No store configured');
      return;
    }

    try {
      const store = await service.getStore(settings.storeName);

      const modal = new Modal(this.app);
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

  /**
   * List all stores
   */
  async listAllStores(): Promise<void> {
    const service = this.getOrCreateGeminiService();
    if (!service) return;

    try {
      const stores = await service.listStores();

      const modal = new Modal(this.app);
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

  /**
   * Delete current store
   */
  async deleteCurrentStore(): Promise<void> {
    const service = this.getOrCreateGeminiService();
    if (!service) return;

    const settings = this.stateManager.getSettings();
    if (!settings.storeName) {
      new Notice('No store configured');
      return;
    }

    const confirmed = await this.confirmAction(
      'Delete Store',
      'This will PERMANENTLY delete the FileSearchStore and all indexed documents. This cannot be undone! Continue?'
    );

    if (confirmed) {
      try {
        await service.deleteStore(settings.storeName);

        // Clear store configuration
        this.stateManager.updateSettings({
          storeName: '',
          storeDisplayName: ''
        });
        this.stateManager.clearIndex();
        await this.saveState();

        new Notice('Store deleted successfully');
      } catch (err) {
        console.error('[EzRAG] Failed to delete store:', err);
        new Notice('Failed to delete store. See console for details.');
      }
    }
  }

  /**
   * Get index statistics
   */
  getIndexStats(): { total: number; ready: number; pending: number; error: number } {
    const allDocs = this.stateManager.getAllDocStates();
    const stats = {
      total: 0,
      ready: 0,
      pending: 0,
      error: 0,
    };

    for (const doc of Object.values(allDocs)) {
      stats.total++;
      if (doc.status === 'ready') stats.ready++;
      else if (doc.status === 'pending') stats.pending++;
      else if (doc.status === 'error') stats.error++;
    }

    return stats;
  }

  /**
   * Update status bar
   */
  private updateStatusBar(text: string): void {
    if (this.statusBarItem) {
      this.statusBarItem.setText(`EzRAG: ${text}`);
    }
  }

  /**
   * Get status bar text
   */
  private getStatusBarText(): string {
    if (!this.runnerManager) {
      return 'Mobile (read-only)';
    }

    if (!this.runnerManager.isRunner()) {
      return 'Inactive (not runner)';
    }

    const stats = this.getIndexStats();
    return `${stats.ready}/${stats.total} indexed`;
  }

  /**
   * Show first-run welcome
   */
  private showFirstRunWelcome(): void {
    new Notice(
      'Welcome to EzRAG! Please configure your Gemini API key in settings.',
      10000
    );
  }

  /**
   * Confirm action with modal
   */
  private async confirmAction(title: string, message: string): Promise<boolean> {
    return new Promise((resolve) => {
      const modal = new Modal(this.app);
      modal.contentEl.createEl('h2', { text: title });
      modal.contentEl.createEl('p', { text: message });

      const buttonContainer = modal.contentEl.createDiv({ cls: 'modal-button-container' });

      const cancelButton = buttonContainer.createEl('button', { text: 'Cancel' });
      cancelButton.addEventListener('click', () => {
        modal.close();
        resolve(false);
      });

      const confirmButton = buttonContainer.createEl('button', {
        text: 'Continue',
        cls: 'mod-warning'
      });
      confirmButton.addEventListener('click', () => {
        modal.close();
        resolve(true);
      });

      modal.open();
    });
  }
}
