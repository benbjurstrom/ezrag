// src/indexing/indexingController.ts - Controls indexing lifecycle

import { App, TFile } from "obsidian";
import { IndexManager, IndexingStats } from "./indexManager";
import { StateManager } from "../state/state";
import { GeminiService } from "../gemini/geminiService";
import { ConnectionManager } from "../connection/connectionManager";

export type IndexingPhase = "idle" | "scanning" | "indexing" | "paused";

export interface IndexingControllerOptions {
  app: App;
  stateManager: StateManager;
  persistState: () => Promise<void>;
  onStateChange?: (snapshot: ControllerSnapshot) => void;
  connectionManager: ConnectionManager;
}

export interface ControllerSnapshot {
  phase: IndexingPhase;
  stats: IndexingStats;
}

type SnapshotListener = (snapshot: ControllerSnapshot) => void;

export class IndexingController {
  private indexManager: IndexManager | null = null;
  private readonly app: App;
  private readonly stateManager: StateManager;
  private readonly persistState: () => Promise<void>;
  private readonly listeners = new Set<SnapshotListener>();
  private phase: IndexingPhase = "idle";
  private stats: IndexingStats = {
    total: 0,
    completed: 0,
    failed: 0,
    pending: 0,
  };
  private saveTimeout: number | null = null;
  private disposed = false;
  private onStateChange?: (snapshot: ControllerSnapshot) => void;
  private readonly connectionManager: ConnectionManager;

  constructor(options: IndexingControllerOptions) {
    this.app = options.app;
    this.stateManager = options.stateManager;
    this.persistState = options.persistState;
    this.onStateChange = options.onStateChange;
    this.connectionManager = options.connectionManager;
  }

  /**
   * Subscribe to controller state updates.
   */
  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): ControllerSnapshot {
    return {
      phase: this.phase,
      stats: { ...this.stats },
    };
  }

  isActive(): boolean {
    return this.indexManager !== null;
  }

  isPaused(): boolean {
    return this.phase === "paused";
  }

  getIndexManager(): IndexManager | null {
    return this.indexManager;
  }

  /**
   * Start indexing (or resume if paused).
   */
  async start(
    geminiService: GeminiService,
  ): Promise<"started" | "resumed" | "already-running"> {
    if (this.indexManager) {
      if (this.phase === "paused") {
        this.indexManager.resume();
        this.setPhase("indexing");
        return "resumed";
      }
      return "already-running";
    }

    this.indexManager = new IndexManager({
      vault: this.app.vault,
      app: this.app,
      stateManager: this.stateManager,
      geminiService,
      vaultName: this.app.vault.getName(),
      onProgress: (stats) => this.handleProgress(stats),
      onStateChange: () => this.schedulePersist(),
      connectionManager: this.connectionManager,
    });

    this.stats = this.indexManager.getStats();
    this.setPhase("scanning");
    this.notify();

    await this.indexManager.reconcileOnStartup();
    this.stats = this.indexManager.getStats();
    this.setPhase(this.stats.pending > 0 ? "indexing" : "idle");
    this.notify();

    return "started";
  }

  /**
   * Pause current queue (runner stays enabled).
   */
  pause(): boolean {
    if (!this.indexManager || this.phase === "paused") {
      return false;
    }
    this.indexManager.pause();
    this.setPhase("paused");
    this.notify();
    return true;
  }

  /**
   * Resume queue after pause.
   */
  resume(): boolean {
    if (!this.indexManager || this.phase !== "paused") {
      return false;
    }
    this.indexManager.resume();
    this.setPhase(this.stats.pending > 0 ? "indexing" : "idle");
    this.notify();
    return true;
  }

  /**
   * Stop indexing and clear queue (used when runner disabled).
   */
  stop(): void {
    if (this.indexManager) {
      this.indexManager.dispose();
      this.indexManager = null;
    }
    this.stats = { total: 0, completed: 0, failed: 0, pending: 0 };
    this.setPhase("idle");
    this.notify();
  }

  /**
   * Trigger a manual reconcile while running.
   */
  async runFullReconcile(): Promise<void> {
    if (!this.indexManager) return;
    this.setPhase("scanning");
    this.notify();
    await this.indexManager.reconcileOnStartup();
    this.stats = this.indexManager.getStats();
    this.setPhase(this.stats.pending > 0 ? "indexing" : "idle");
    this.notify();
  }

  /**
   * Event helpers
   */
  handleFileCreated(file: TFile): void {
    if (!this.indexManager || this.phase === "paused") return;
    void this.indexManager.onFileCreated(file);
  }

  handleFileModified(file: TFile): void {
    if (!this.indexManager || this.phase === "paused") return;
    void this.indexManager.onFileModified(file);
  }

  handleFileRenamed(file: TFile, oldPath: string): void {
    if (!this.indexManager || this.phase === "paused") return;
    void this.indexManager.onFileRenamed(file, oldPath);
  }

  handleFileDeleted(path: string): void {
    if (!this.indexManager || this.phase === "paused") return;
    void this.indexManager.onFileDeleted(path);
  }

  clearQueue(): void {
    this.indexManager?.clearQueue();
    this.stats = this.indexManager?.getStats() ?? {
      total: 0,
      completed: 0,
      failed: 0,
      pending: 0,
    };
    if (!this.isPaused()) {
      this.setPhase("idle");
    }
    this.notify();
  }

  dispose(): void {
    this.stop();
    if (this.saveTimeout !== null) {
      window.clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    this.listeners.clear();
    this.disposed = true;
  }

  private handleProgress(stats: IndexingStats): void {
    this.stats = stats;
    if (this.phase !== "paused") {
      if (stats.pending > 0 && this.phase !== "scanning") {
        this.setPhase("indexing");
      } else if (stats.pending === 0 && this.phase === "indexing") {
        this.setPhase("idle");
      }
    }
    this.notify();
  }

  private schedulePersist(): void {
    if (this.saveTimeout !== null || this.disposed) {
      return;
    }
    this.saveTimeout = window.setTimeout(async () => {
      this.saveTimeout = null;
      try {
        await this.persistState();
      } catch (err) {
        console.error("[IndexingController] Failed to persist state", err);
      }
    }, 500);
  }

  private setPhase(phase: IndexingPhase): void {
    this.phase = phase;
  }

  private notify(): void {
    const snapshot = this.getSnapshot();
    if (this.onStateChange) {
      this.onStateChange(snapshot);
    }
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}
