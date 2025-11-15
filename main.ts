// main.ts - Plugin entry point

import { App, Modal, Platform, Plugin, TFile, Notice } from 'obsidian';
import { StateManager } from './src/state/state';
import { DEFAULT_DATA } from './src/types';
import { GeminiService } from './src/gemini/geminiService';
import { IndexingController, IndexingPhase } from './src/indexing/indexingController';
import { RunnerStateManager } from './src/runner/runnerState';
import { JanitorProgressModal } from './src/ui/janitorProgressModal';
import { EzRAGSettingTab } from './src/ui/settingsTab';
import { IndexingStatusModal } from './src/ui/indexingStatusModal';
import { StoreManager } from './src/store/storeManager';

export default class EzRAGPlugin extends Plugin {
  stateManager!: StateManager;
  runnerManager: RunnerStateManager | null = null; // Only on desktop
  geminiService: GeminiService | null = null;
  indexingController: IndexingController | null = null;
  storeManager: StoreManager | null = null;
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
    if (Platform.isDesktopApp) {
      this.runnerManager = new RunnerStateManager(this.app, this.manifest.id);
    }

    this.storeManager = new StoreManager(this);

    this.indexingController = new IndexingController({
      app: this.app,
      stateManager: this.stateManager,
      persistState: () => this.saveState(),
      onStateChange: () => {
        this.updateStatusBar(this.getStatusBarText());
      }
    });

    // FIRST-RUN ONBOARDING: Check if API key is set
    const settings = this.stateManager.getSettings();
    const isFirstRun = !settings.apiKey;
    if (isFirstRun) {
      this.showFirstRunWelcome();
    }

    // Add settings tab
    this.addSettingTab(new EzRAGSettingTab(this.app, this));

    // Add status bar + subscribe to controller updates
    this.statusBarItem = this.addStatusBarItem();
    this.updateStatusBar(this.getStatusBarText());

    // Register vault events after layout is ready to avoid processing existing files on startup
    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(
        this.app.vault.on('create', (file) => {
          if (file instanceof TFile) {
            this.indexingController?.handleFileCreated(file);
          }
        })
      );

      this.registerEvent(
        this.app.vault.on('modify', (file) => {
          if (file instanceof TFile) {
            this.indexingController?.handleFileModified(file);
          }
        })
      );

      this.registerEvent(
        this.app.vault.on('rename', (file, oldPath) => {
          if (file instanceof TFile) {
            this.indexingController?.handleFileRenamed(file, oldPath);
          }
        })
      );

      this.registerEvent(
        this.app.vault.on('delete', (file) => {
          if (file instanceof TFile) {
            this.indexingController?.handleFileDeleted(file.path);
          }
        })
      );

      void this.refreshIndexingState('startup');
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
    this.indexingController?.dispose();
  }

  // New helper methods will be defined later

  /**
   * Save state to disk
   */
  async saveState(): Promise<void> {
    await this.saveData(this.stateManager.exportData());
  }

  async updateApiKey(value: string): Promise<string> {
    const trimmed = value.trim();
    const current = this.stateManager.getSettings().apiKey;

    if (trimmed === current) {
      return '';
    }

    if (!trimmed) {
      this.stateManager.updateSettings({
        apiKey: '',
        storeName: '',
        storeDisplayName: ''
      });
      this.geminiService = null;
      await this.saveState();
      this.indexingController?.stop();
      this.updateStatusBar(this.getStatusBarText());
      return 'API key cleared. Indexing stopped.';
    }

    this.stateManager.updateSettings({
      apiKey: trimmed,
      storeName: '',
      storeDisplayName: ''
    });
    this.geminiService = new GeminiService(trimmed);
    await this.saveState();

    if (this.runnerManager?.isRunner()) {
      return await this.refreshIndexingState('api-key');
    }

    this.updateStatusBar(this.getStatusBarText());
    return 'API key saved.';
  }

  async handleRunnerStateChange(): Promise<string> {
    return await this.refreshIndexingState('runner');
  }

  openIndexingStatusModal(): void {
    if (!this.indexingController) return;
    new IndexingStatusModal(this.app, this.indexingController).open();
  }

  private async refreshIndexingState(_source: string): Promise<string> {
    if (!Platform.isDesktopApp || !this.runnerManager) {
      this.indexingController?.stop();
      this.updateStatusBar(this.getStatusBarText());
      return 'Indexing is only available on desktop.';
    }

    if (!this.runnerManager.isRunner()) {
      this.indexingController?.stop();
      this.updateStatusBar(this.getStatusBarText());
      return 'Runner disabled. Indexing stopped.';
    }

    const ready = await this.ensureGeminiResources();
    if (!ready || !this.geminiService) {
      this.indexingController?.stop();
      this.updateStatusBar(this.getStatusBarText());
      return 'Runner enabled but waiting for API configuration.';
    }

    if (!this.indexingController) {
      return 'Indexing controller not ready.';
    }

    const result = await this.indexingController.start(this.geminiService);
    this.updateStatusBar(this.getStatusBarText());

    if (result === 'started') {
      return 'Indexing started. Scanning your vault...';
    }

    if (result === 'resumed') {
      return 'Indexing resumed.';
    }

    return 'Indexing already running.';
  }

  private async ensureGeminiResources(): Promise<boolean> {
    const settings = this.stateManager.getSettings();

    if (!settings.apiKey) {
      return false;
    }

    if (!this.geminiService) {
      this.geminiService = new GeminiService(settings.apiKey);
    }

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
      } catch (err) {
        console.error('[EzRAG] Failed to create FileSearchStore:', err);
        new Notice('Failed to create Gemini FileSearchStore. Check API key.');
        return false;
      }
    }

    return true;
  }

  /**
   * Rebuild index
   */
  async rebuildIndex(): Promise<void> {
    const manager = this.indexingController?.getIndexManager();
    if (!manager) {
      new Notice('Index manager not initialized');
      return;
    }

    const confirmed = await this.confirmAction(
      'Rebuild Index',
      'This will clear the local index and re-index all files. Continue?'
    );

    if (confirmed) {
      await manager.rebuildIndex();
      await this.saveState();
      new Notice('Index rebuild started');
    }
  }

  /**
   * Cleanup orphaned documents
   */
  async cleanupOrphans(): Promise<void> {
    const manager = this.indexingController?.getIndexManager();
    if (!manager) {
      new Notice('Index manager not initialized');
      return;
    }

    const confirmed = await this.confirmAction(
      'Cleanup Orphans',
      'This will delete documents from Gemini that no longer exist in your vault. Continue?'
    );

    if (confirmed) {
      try {
        const deleted = await manager.cleanupOrphans();
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
    const manager = this.indexingController?.getIndexManager();
    if (!manager) {
      new Notice('Index manager not initialized');
      return;
    }

    const modal = new JanitorProgressModal(this.app);
    modal.open();

    try {
      const janitor = manager.getJanitor();
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
    if (!Platform.isDesktopApp) {
      return 'Mobile (read-only)';
    }

    if (!this.runnerManager?.isRunner()) {
      return 'Inactive (not runner)';
    }

    if (!this.indexingController || !this.indexingController.isActive()) {
      const hasKey = Boolean(this.stateManager.getSettings().apiKey);
      return hasKey ? 'Runner idle' : 'Awaiting API key';
    }

    const snapshot = this.indexingController.getSnapshot();
    const stats = this.getIndexStats();
    const phaseLabel = this.formatPhaseLabel(snapshot.phase);
    return `${phaseLabel}: ${stats.ready}/${stats.total} ready · ${stats.pending} pending`;
  }

  private formatPhaseLabel(phase: IndexingPhase): string {
    switch (phase) {
      case 'scanning':
        return 'Scanning';
      case 'indexing':
        return 'Indexing';
      case 'paused':
        return 'Paused';
      default:
        return 'Idle';
    }
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
  async confirmAction(title: string, message: string): Promise<boolean> {
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
