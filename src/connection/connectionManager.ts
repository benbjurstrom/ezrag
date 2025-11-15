// src/connection/connectionManager.ts - Connection state management

/**
 * Connection state representing overall connectivity
 */
export interface ConnectionState {
  /** Browser online/offline status */
  online: boolean;
  /** Whether the API key has been validated */
  apiKeyValid: boolean;
  /** Helpful error message if validation failed */
  apiKeyError?: string;
  /** Timestamp of last validation attempt */
  lastValidation?: number;
  /** Derived flag: true only when online AND API key is valid */
  connected: boolean;
}

type ConnectionListener = (state: ConnectionState) => void;

/**
 * Manages connection state (online/offline + API key validity)
 *
 * This is a lightweight state tracker that:
 * - Listens to browser online/offline events
 * - Tracks API key validity (set by main plugin)
 * - Notifies listeners when state changes
 *
 * Does NOT make API calls itself - validation is handled by main plugin.
 */
export class ConnectionManager {
  private state: ConnectionState = {
    online: typeof navigator !== 'undefined' ? navigator.onLine : true,
    apiKeyValid: false,
    connected: false,
  };

  private listeners: ConnectionListener[] = [];
  private onlineHandler: () => void;
  private offlineHandler: () => void;

  constructor() {
    // Bind handlers for cleanup
    this.onlineHandler = () => this.handleOnline();
    this.offlineHandler = () => this.handleOffline();

    this.setupNetworkListeners();
  }

  /**
   * Set up browser online/offline event listeners
   */
  private setupNetworkListeners(): void {
    if (typeof window === 'undefined') return;

    window.addEventListener('online', this.onlineHandler);
    window.addEventListener('offline', this.offlineHandler);
  }

  /**
   * Handle browser online event
   */
  private handleOnline(): void {
    if (!this.state.online) {
      console.log('[EzRAG] Browser detected online');
      this.state.online = true;
      this.recomputeConnected();
      this.notifyListeners();
    }
  }

  /**
   * Handle browser offline event
   */
  private handleOffline(): void {
    if (this.state.online) {
      console.log('[EzRAG] Browser detected offline');
      this.state.online = false;
      this.recomputeConnected();
      this.notifyListeners();
    }
  }

  /**
   * Update API key validity (called by main plugin after validation)
   */
  setApiKeyValid(valid: boolean, error?: string): void {
    if (this.state.apiKeyValid !== valid || this.state.apiKeyError !== error) {
      console.log(`[EzRAG] API key validity changed: ${valid}`);
      this.state.apiKeyValid = valid;
      this.state.apiKeyError = error;
      this.state.lastValidation = Date.now();
      this.recomputeConnected();
      this.notifyListeners();
    }
  }

  /**
   * Check if we're connected (online AND valid API key)
   */
  isConnected(): boolean {
    return this.state.connected;
  }

  /**
   * Get current connection state
   */
  getState(): ConnectionState {
    return { ...this.state };
  }

  /**
   * Subscribe to connection state changes
   * Returns unsubscribe function
   */
  subscribe(listener: ConnectionListener): () => void {
    this.listeners.push(listener);

    // Immediately call with current state
    listener(this.getState());

    // Return unsubscribe function
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index > -1) {
        this.listeners.splice(index, 1);
      }
    };
  }

  /**
   * Notify all listeners of state change
   */
  private notifyListeners(): void {
    const state = this.getState();
    this.listeners.forEach(listener => {
      try {
        listener(state);
      } catch (err) {
        console.error('[EzRAG] Error in connection listener:', err);
      }
    });
  }

  /**
   * Clean up event listeners
   */
  dispose(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.onlineHandler);
      window.removeEventListener('offline', this.offlineHandler);
    }
    this.listeners = [];
  }

  private recomputeConnected(): void {
    this.state.connected = this.state.online && this.state.apiKeyValid;
  }
}
