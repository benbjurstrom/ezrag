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
import { ChatView, CHAT_VIEW_TYPE } from './src/ui/chatView';
import { ConnectionManager, ConnectionState } from './src/connection/connectionManager';

export default class EzRAGPlugin extends Plugin {
  stateManager!: StateManager;
  runnerManager: RunnerStateManager | null = null; // Only on desktop
  geminiService: GeminiService | null = null;
  indexingController: IndexingController | null = null;
  storeManager: StoreManager | null = null;
  connectionManager!: ConnectionManager;
  statusBarItem: HTMLElement | null = null;
  private unsubscribeConnection?: () => void;
  private lastConnectionState: ConnectionState | null = null;
  private pausedByDisconnect = false;
  private lastApiKeyError?: string;

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

    // Initialize connection manager
    this.connectionManager = new ConnectionManager();
    this.lastConnectionState = this.connectionManager.getState();
    this.lastApiKeyError = this.lastConnectionState.apiKeyError;

    // Subscribe to connection changes for auto-pause/resume
    this.unsubscribeConnection = this.connectionManager.subscribe((state) => {
      this.handleConnectionChange(state);
    });

    // Load runner state (per-machine, per-vault, non-synced)
    if (Platform.isDesktopApp) {
      this.runnerManager = new RunnerStateManager(this.app, this.manifest.id);
    }

    this.storeManager = new StoreManager(this);

    // Validate existing API key on startup (async, don't block)
    const existingApiKey = this.stateManager.getSettings().apiKey;
    if (existingApiKey) {
      this.validateApiKeyOnStartup(existingApiKey);
    }

    this.registerView(CHAT_VIEW_TYPE, (leaf) => new ChatView(leaf, this));

    this.indexingController = new IndexingController({
      app: this.app,
      stateManager: this.stateManager,
      persistState: () => this.saveState(),
      onStateChange: () => {
        this.updateStatusBar(this.getStatusBarText());
      },
      connectionManager: this.connectionManager,
    });

    // FIRST-RUN ONBOARDING: Check if API key is set
    const settings = this.stateManager.getSettings();
    const isFirstRun = !settings.apiKey;
    if (isFirstRun) {
      this.showFirstRunWelcome();
    }

    // Add settings tab
    this.addSettingTab(new EzRAGSettingTab(this.app, this));

    // Add ribbon icon for chat
    this.addRibbonIcon('message-square', 'Open Chat', () => {
      void this.openChatInterface();
    });

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
      name: 'Clean Up Remote Index',
      checkCallback: (checking) => {
        if (!this.runnerManager?.isRunner()) return false;
        if (!checking) this.runJanitorWithUI();
        return true;
      },
    });

    this.addCommand({
      id: 'open-ezrag-chat',
      name: 'Open Chat Interface',
      callback: () => {
        void this.openChatInterface();
      }
    });
  }

  onunload() {
    console.log('Unloading EzRAG plugin');
    this.unsubscribeConnection?.();
    this.unsubscribeConnection = undefined;
    this.connectionManager?.dispose();
    this.indexingController?.dispose();
    this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE).forEach((leaf) => leaf.detach());
  }

  // New helper methods will be defined later

  /**
   * Save state to disk
   */
  async saveState(): Promise<void> {
    await this.saveData(this.stateManager.exportData());
  }

  /**
   * Ensure we have a GeminiService instance whenever an API key is configured.
   * This is used by the chat interface and store utilities, even on non-runner devices.
   */
  getGeminiService(): GeminiService | null {
    const apiKey = this.stateManager.getSettings().apiKey;
    if (!apiKey) {
      return null;
    }

    if (!this.geminiService) {
      this.geminiService = new GeminiService(apiKey);
    }

    return this.geminiService;
  }

  getConnectionState(): ConnectionState {
    return this.connectionManager.getState();
  }

  requireConnection(action: string): boolean {
    const state = this.connectionManager.getState();
    if (state.connected) {
      return true;
    }

    const reason = state.online
      ? (state.apiKeyError ?? 'Gemini API key needs to be validated in settings.')
      : 'No internet connection detected.';

    new Notice(`Cannot ${action}: ${reason}`);
    return false;
  }

  isConnected(): boolean {
    return this.connectionManager.isConnected();
  }

  /**
   * Validate and update API key
   * Returns validation result with success/error info
   */
  async validateAndUpdateApiKey(value: string): Promise<{ valid: boolean; error?: string; message?: string }> {
    const trimmed = value.trim();
    const current = this.stateManager.getSettings().apiKey;

    // No change
    if (trimmed === current) {
      const isValid = this.connectionManager.getState().apiKeyValid;
      return { valid: isValid };
    }

    // Key cleared
    if (!trimmed) {
      this.stateManager.updateSettings({
        apiKey: '',
        storeName: '',
        storeDisplayName: ''
      });
      this.geminiService = null;
      this.connectionManager.setApiKeyValid(false);
      await this.saveState();
      this.indexingController?.stop();
      this.pausedByDisconnect = false;
      this.updateStatusBar(this.getStatusBarText());
      return { valid: false, message: 'API key cleared' };
    }

    // Save key first (so we can test it)
    this.stateManager.updateSettings({
      apiKey: trimmed,
      storeName: '',
      storeDisplayName: ''
    });
    await this.saveState();

    // Check if online first
    if (!this.connectionManager.getState().online) {
      return { valid: false, error: 'No internet connection. Cannot validate API key.' };
    }

    // Validate by making a lightweight API call
    try {
      const tempService = new GeminiService(trimmed);
      // Try to list stores - this will fail if API key is invalid
      await tempService.listStores();

      // Success - key is valid
      this.geminiService = tempService;
      this.connectionManager.setApiKeyValid(true);

      // If we're the runner, start/refresh indexing
      if (this.runnerManager?.isRunner()) {
        await this.refreshIndexingState('api-key');
      }

      this.updateStatusBar(this.getStatusBarText());
      return { valid: true, message: 'API key validated successfully' };

    } catch (err) {
      console.error('[EzRAG] API key validation failed:', err);
      this.geminiService = null;
      this.indexingController?.stop();
      this.pausedByDisconnect = false;
      this.updateStatusBar(this.getStatusBarText());

      // Distinguish error types
      const errorMsg = err instanceof Error ? err.message : String(err);
      const lower = errorMsg.toLowerCase();
      let friendlyError = `Validation failed: ${errorMsg}`;
      if (errorMsg.includes('401') || errorMsg.includes('403') || lower.includes('api key') || lower.includes('unauthorized')) {
        friendlyError = 'Invalid API key. Please check your key and try again.';
      } else if (lower.includes('network') || lower.includes('fetch')) {
        friendlyError = 'Network error. Please check your internet connection.';
      }

      this.connectionManager.setApiKeyValid(false, friendlyError);
      return { valid: false, error: friendlyError };
    }
  }

  /**
   * Legacy method for backwards compatibility - delegates to validateAndUpdateApiKey
   */
  async updateApiKey(value: string): Promise<string> {
    const result = await this.validateAndUpdateApiKey(value);
    if (result.error) return result.error;
    if (result.message) return result.message;
    return '';
  }

  /**
   * Validate API key on startup (async, doesn't block plugin load)
   */
  private async validateApiKeyOnStartup(apiKey: string): Promise<void> {
    if (!apiKey) return;
    if (!this.connectionManager.getState().online) return;

    try {
      const tempService = new GeminiService(apiKey);
      await tempService.listStores();
      this.connectionManager.setApiKeyValid(true);
      console.log('[EzRAG] Stored API key validated successfully');
    } catch (err) {
      console.error('[EzRAG] Stored API key validation failed:', err);
      this.connectionManager.setApiKeyValid(false, 'Stored API key appears to be invalid.');
      new Notice('EzRAG: Stored API key appears to be invalid. Please update it in settings.');
    }
  }

  /**
   * Handle connection state changes (online/offline, API key validity)
   */
  private handleConnectionChange(state: ConnectionState): void {
    const previousConnected = this.lastConnectionState?.connected ?? state.connected;
    const justLost = previousConnected && !state.connected;
    const justRestored = !previousConnected && state.connected;
    this.lastConnectionState = state;

    if (state.apiKeyError && state.apiKeyError !== this.lastApiKeyError) {
      new Notice(`EzRAG: ${state.apiKeyError}`);
    }
    this.lastApiKeyError = state.apiKeyError;

    // Update status bar whenever connection state changes
    this.updateStatusBar(this.getStatusBarText());

    // Auto-pause/resume indexing based on connection (only if runner)
    if (!this.runnerManager?.isRunner() || !this.indexingController) {
      return;
    }

    const isActive = this.indexingController.isActive();
    const isPaused = this.indexingController.isPaused();

    if (justLost && isActive && !isPaused) {
      console.log('[EzRAG] Connection lost, pausing indexing');
      this.indexingController.pause();
      this.pausedByDisconnect = true;
      new Notice('EzRAG: Disconnected. Indexing paused.');
    } else if (justRestored) {
      console.log('[EzRAG] Connection restored');
      if (this.pausedByDisconnect && isPaused) {
        this.indexingController.resume();
        this.pausedByDisconnect = false;
        new Notice('EzRAG: Connection restored. Resuming indexing.');
      } else if (!isActive) {
        void this.refreshIndexingState('connection');
      }
    }
  }

  async handleRunnerStateChange(): Promise<string> {
    return await this.refreshIndexingState('runner');
  }

  openIndexingStatusModal(): void {
    if (!this.indexingController) return;
    new IndexingStatusModal(this.app, this.indexingController, this).open();
  }

  async openChatInterface(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }

    const rightLeaf = this.app.workspace.getRightLeaf(false);
    const leaf = rightLeaf ?? this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  private async refreshIndexingState(_source: string): Promise<string> {
    if (!Platform.isDesktopApp || !this.runnerManager) {
      this.indexingController?.stop();
      this.pausedByDisconnect = false;
      this.updateStatusBar(this.getStatusBarText());
      return 'Indexing is only available on desktop.';
    }

    if (!this.runnerManager.isRunner()) {
      this.indexingController?.stop();
      this.pausedByDisconnect = false;
      this.updateStatusBar(this.getStatusBarText());
      return 'Runner disabled. Indexing stopped.';
    }

    const ready = await this.ensureGeminiResources();
    if (!ready || !this.geminiService) {
      this.indexingController?.stop();
      this.pausedByDisconnect = false;
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

    const service = this.getGeminiService();
    if (!service) {
      return false;
    }

    if (!settings.storeName) {
      if (!this.requireConnection('create a Gemini FileSearch store')) {
        return false;
      }
      const vaultName = this.app.vault.getName();
      const displayName = `ezrag-${vaultName}`;

      try {
        const storeName = await service.getOrCreateStore(displayName);
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
    if (!this.requireConnection('rebuild the index')) {
      return;
    }
    const manager = this.indexingController?.getIndexManager();
    if (!manager) {
      new Notice('Index manager not initialized');
      return;
    }

    const confirmed = await this.confirmAction(
      'Rebuild Index',
      'This will clear the local state and reconcile with Gemini. Unchanged files will be restored without re-uploading. Continue?'
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
    if (!this.requireConnection('clean up orphans')) {
      return;
    }
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
   * Run remote index cleanup with UI
   */
  async runJanitorWithUI(): Promise<void> {
    if (!this.requireConnection('clean up the remote index')) {
      return;
    }
    const manager = this.indexingController?.getIndexManager();
    if (!manager) {
      new Notice('Index manager not initialized');
      return;
    }

    const modal = new JanitorProgressModal(this.app);
    modal.open();

    try {
      const janitor = manager.getJanitor();
      const stats = await janitor.runDeduplication(update => modal.updateProgress(update));

      modal.updateStats(stats);
      modal.markComplete();

      await this.saveState();

      new Notice(
        `Cleanup complete: ${stats.totalRemoved} stale document${stats.totalRemoved === 1 ? '' : 's'} removed`
      );
    } catch (err) {
      console.error('[EzRAG] Remote index cleanup failed:', err);
      modal.markFailed((err as Error).message);
      new Notice('Remote index cleanup failed. See console for details.');
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
