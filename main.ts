// main.ts - Plugin entry point

import { Modal, Platform, Plugin, TFile, Notice } from 'obsidian';
import { StateManager } from './src/state/state';
import { DEFAULT_DATA } from './src/types';
import { GeminiService } from './src/gemini/geminiService';
import { IndexingController, IndexingPhase } from './src/indexing/indexingController';
import { RunnerStateManager } from './src/runner/runnerState';
import { IndexStateStorageManager } from './src/storage/indexStateStorageManager';
import { JanitorProgressModal } from './src/ui/janitorProgressModal';
import { EzRAGSettingTab } from './src/ui/settingsTab';
import { IndexingStatusModal } from './src/ui/indexingStatusModal';
import { StoreManager } from './src/store/storeManager';
import { ChatView, CHAT_VIEW_TYPE } from './src/ui/chatView';
import { ConnectionManager, ConnectionState } from './src/connection/connectionManager';
import { IndexingLifecycleCoordinator } from './src/lifecycle/indexingLifecycleCoordinator';
import { MCPServer } from './src/mcp/server';

export default class EzRAGPlugin extends Plugin {
  stateManager!: StateManager;
  runnerManager: RunnerStateManager | null = null; // Only on desktop
  indexStateStorage!: IndexStateStorageManager; // localStorage for index/queue
  geminiService: GeminiService | null = null;
  indexingController: IndexingController | null = null;
  storeManager: StoreManager | null = null;
  connectionManager!: ConnectionManager;
  statusBarItem: HTMLElement | null = null;
  mcpServer: MCPServer | null = null;
  private unsubscribeConnection?: () => void;
  private lifecycleCoordinator: IndexingLifecycleCoordinator | null = null;

  async onload() {
    console.log('Loading EzRAG plugin');

    // Initialize localStorage manager for index/queue data (device-specific, non-synced)
    this.indexStateStorage = new IndexStateStorageManager(this.app, this.manifest.id);

    // Load settings from data.json (synced across devices)
    const savedData = await this.loadData();

    // Load index state from localStorage (device-specific, never synced)
    const indexState = this.indexStateStorage.getState();

    // Merge settings from data.json with defaults
    let mergedSettings = DEFAULT_DATA.settings;
    if (savedData?.settings) {
      mergedSettings = {
        ...DEFAULT_DATA.settings,
        ...savedData.settings,
        chunkingConfig: {
          ...DEFAULT_DATA.settings.chunkingConfig,
          ...(savedData.settings.chunkingConfig || {})
        },
        mcpServer: {
          ...DEFAULT_DATA.settings.mcpServer,
          ...(savedData.settings.mcpServer || {})
        }
      };
    }

    // Construct unified state from both sources
    this.stateManager = new StateManager({
      version: savedData?.version ?? DEFAULT_DATA.version,
      settings: mergedSettings,
      index: indexState
    });

    // Initialize connection manager
    this.connectionManager = new ConnectionManager();

    // Subscribe to connection changes for auto-pause/resume
    this.unsubscribeConnection = this.connectionManager.subscribe((state) => {
      this.lifecycleCoordinator?.handleConnectionChange(state);
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

    this.lifecycleCoordinator = new IndexingLifecycleCoordinator({
      app: this.app,
      stateManager: this.stateManager,
      runnerManager: this.runnerManager,
      connectionManager: this.connectionManager,
      getGeminiService: () => this.getGeminiService(),
      getIndexingController: () => this.indexingController,
      saveState: () => this.saveState(),
      onStatusChange: () => {
        this.updateStatusBar(this.getStatusBarText());
      },
    });

    this.lifecycleCoordinator.handleConnectionChange(this.connectionManager.getState());

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
    this.statusBarItem.style.cursor = 'pointer';
    this.statusBarItem.setAttribute('aria-label', 'Click to open queue or settings');
    this.statusBarItem.addEventListener('click', () => {
      if (Platform.isDesktopApp && this.runnerManager?.isRunner()) {
        // Runner is active - open queue modal
        this.openIndexingStatusModal();
      } else {
        // Not runner or mobile - open settings
        this.app.setting.open();
        this.app.setting.openTabById(this.manifest.id);
      }
    });
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

    // Start MCP server if enabled
    const mcpSettings = this.stateManager.getSettings().mcpServer;
    if (mcpSettings.enabled) {
      void this.startMCPServer();
    }
  }

  onunload() {
    console.log('Unloading EzRAG plugin');

    // Stop MCP server if running
    if (this.mcpServer) {
      void this.mcpServer.stop();
    }

    this.unsubscribeConnection?.();
    this.unsubscribeConnection = undefined;
    this.connectionManager?.dispose();
    this.indexingController?.dispose();
    this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE).forEach((leaf) => leaf.detach());
  }

  // New helper methods will be defined later

  /**
   * Save state using dual-persistence:
   * - Settings → data.json (synced across devices)
   * - Index/Queue → localStorage (device-specific, non-synced)
   */
  async saveState(): Promise<void> {
    // Save settings to data.json (synced)
    await this.saveData(this.stateManager.exportSettings());

    // Save index state to localStorage (device-specific)
    this.indexStateStorage.setState(this.stateManager.exportIndexState());
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
    return this.lifecycleCoordinator?.requireConnection(action) ?? this.connectionManager.isConnected();
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

  private async refreshIndexingState(source: string): Promise<string> {
    if (!this.lifecycleCoordinator) {
      return 'Indexing coordinator not ready.';
    }
    return this.lifecycleCoordinator.refreshIndexingState(source);
  }

  async ensureGeminiResources(): Promise<boolean> {
    return this.lifecycleCoordinator?.ensureGeminiResources() ?? false;
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
   * Start MCP server
   */
  async startMCPServer(): Promise<void> {
    if (this.mcpServer) {
      console.log('[EzRAG] MCP server already running');
      return;
    }

    const settings = this.stateManager.getSettings().mcpServer;
    try {
      this.mcpServer = new MCPServer({
        app: this.app,
        stateManager: this.stateManager,
        getGeminiService: () => this.getGeminiService(),
        port: settings.port
      });

      await this.mcpServer.start();
      new Notice(`MCP server started on port ${settings.port}`);
    } catch (err) {
      console.error('[EzRAG] Failed to start MCP server:', err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      new Notice(`Failed to start MCP server: ${errorMessage}`);
      this.mcpServer = null;
    }
  }

  /**
   * Stop MCP server
   */
  async stopMCPServer(): Promise<void> {
    if (!this.mcpServer) {
      return;
    }

    try {
      await this.mcpServer.stop();
      this.mcpServer = null;
      new Notice('MCP server stopped');
    } catch (err) {
      console.error('[EzRAG] Failed to stop MCP server:', err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      new Notice(`Failed to stop MCP server: ${errorMessage}`);
    }
  }

  /**
   * Handle MCP server enable/disable toggle
   */
  async handleMCPServerToggle(enabled: boolean): Promise<void> {
    this.stateManager.updateSettings({
      mcpServer: {
        ...this.stateManager.getSettings().mcpServer,
        enabled
      }
    });
    await this.saveState();

    if (enabled) {
      await this.startMCPServer();
    } else {
      await this.stopMCPServer();
    }
  }

  /**
   * Update MCP server port
   */
  async updateMCPServerPort(port: number): Promise<void> {
    const wasRunning = this.mcpServer !== null;

    // Stop if running
    if (wasRunning) {
      await this.stopMCPServer();
    }

    // Update settings
    this.stateManager.updateSettings({
      mcpServer: {
        ...this.stateManager.getSettings().mcpServer,
        port
      }
    });
    await this.saveState();

    // Restart if was running
    if (wasRunning) {
      await this.startMCPServer();
    }
  }

  /**
   * Get MCP server status
   */
  getMCPServerStatus(): { running: boolean; url: string } {
    if (this.mcpServer) {
      return this.mcpServer.getStatus();
    }
    return { running: false, url: '' };
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
