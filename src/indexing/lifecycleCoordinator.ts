import { App, Notice, Platform } from 'obsidian';
import { ConnectionManager, ConnectionState } from '../connection/connectionManager';
import { RunnerStateManager } from '../state/runnerState';
import { StateManager } from '../state/state';
import { GeminiService } from '../gemini/geminiService';
import { IndexingController } from './indexingController';

export interface LifecycleCoordinatorOptions {
  app: App;
  stateManager: StateManager;
  runnerManager: RunnerStateManager | null;
  connectionManager: ConnectionManager;
  getGeminiService: () => GeminiService | null;
  getIndexingController: () => IndexingController | null;
  saveState: () => Promise<void>;
  onStatusChange: () => void;
}

export class LifecycleCoordinator {
  private lastConnectionState: ConnectionState;
  private lastApiKeyError?: string;
  private pausedByDisconnect = false;

  constructor(private options: LifecycleCoordinatorOptions) {
    this.lastConnectionState = options.connectionManager.getState();
    this.lastApiKeyError = this.lastConnectionState.apiKeyError;
  }

  requireConnection(action: string): boolean {
    const state = this.options.connectionManager.getState();
    if (state.connected) {
      return true;
    }

    const reason = state.online
      ? (state.apiKeyError ?? 'Gemini API key needs to be validated in settings.')
      : 'No internet connection detected.';

    new Notice(`Cannot ${action}: ${reason}`);
    return false;
  }

  async refreshIndexingState(_source: string): Promise<string> {
    const controller = this.options.getIndexingController();
    if (!Platform.isDesktopApp || !this.options.runnerManager) {
      controller?.stop();
      this.pausedByDisconnect = false;
      this.options.onStatusChange();
      return 'Indexing is only available on desktop.';
    }

    if (!this.options.runnerManager.isRunner()) {
      controller?.stop();
      this.pausedByDisconnect = false;
      this.options.onStatusChange();
      return 'Runner disabled. Indexing stopped.';
    }

    const ready = await this.ensureGeminiResources();
    const service = this.options.getGeminiService();
    if (!ready || !service) {
      controller?.stop();
      this.pausedByDisconnect = false;
      this.options.onStatusChange();
      return 'Runner enabled but waiting for API configuration.';
    }

    if (!controller) {
      return 'Indexing controller not ready.';
    }

    const result = await controller.start(service);
    this.options.onStatusChange();

    if (result === 'started') {
      return 'Indexing started. Scanning your vault...';
    }

    if (result === 'resumed') {
      return 'Indexing resumed.';
    }

    return 'Indexing already running.';
  }

  async ensureGeminiResources(): Promise<boolean> {
    const service = this.options.getGeminiService();
    if (!service) {
      return false;
    }

    const settings = this.options.stateManager.getSettings();
    if (!settings.storeName) {
      if (!this.requireConnection('create a Gemini FileSearch store')) {
        return false;
      }
      const vaultName = this.options.app.vault.getName();
      const displayName = `ezrag-${vaultName}`;

      try {
        const storeName = await service.getOrCreateStore(displayName);
        this.options.stateManager.updateSettings({
          storeName,
          storeDisplayName: displayName,
        });
        await this.options.saveState();
      } catch (err) {
        console.error('[EzRAG] Failed to create FileSearchStore:', err);
        new Notice('Failed to create Gemini FileSearchStore. Check API key.');
        return false;
      }
    }

    return true;
  }

  handleConnectionChange(state: ConnectionState): void {
    const previousConnected = this.lastConnectionState?.connected ?? state.connected;
    const justLost = previousConnected && !state.connected;
    const justRestored = !previousConnected && state.connected;
    this.lastConnectionState = state;

    if (state.apiKeyError && state.apiKeyError !== this.lastApiKeyError) {
      new Notice(`EzRAG: ${state.apiKeyError}`);
    }
    this.lastApiKeyError = state.apiKeyError;

    this.options.onStatusChange();

    const controller = this.options.getIndexingController();
    if (!this.options.runnerManager?.isRunner() || !controller) {
      return;
    }

    const isActive = controller.isActive();
    const isPaused = controller.isPaused();

    if (justLost && isActive && !isPaused) {
      controller.pause();
      this.pausedByDisconnect = true;
      new Notice('EzRAG: Disconnected. Indexing paused.');
    } else if (justRestored) {
      if (this.pausedByDisconnect && isPaused) {
        controller.resume();
        this.pausedByDisconnect = false;
        new Notice('EzRAG: Connection restored. Resuming indexing.');
      } else if (!isActive) {
        void this.refreshIndexingState('connection');
      }
    }
  }
}
