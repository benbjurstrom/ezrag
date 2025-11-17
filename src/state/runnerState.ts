// src/runner/runnerState.ts - Per-machine runner configuration (non-synced)

import { App } from "obsidian";
import { computeVaultKey } from "../utils/vault";

export interface RunnerState {
  isRunner: boolean;
  deviceId: string;
  lastUpdated: number;
}

const DEFAULT_RUNNER_STATE: RunnerState = {
  isRunner: false,
  deviceId: "",
  lastUpdated: 0,
};

export class RunnerStateManager {
  private readonly app: App;
  private readonly pluginId: string;
  private cachedState: RunnerState = { ...DEFAULT_RUNNER_STATE };
  private readonly storageKey: string;

  constructor(app: App, pluginId: string) {
    this.app = app;
    this.pluginId = pluginId;
    this.storageKey = this.buildStorageKey();
    this.cachedState = this.readFromStorage();
  }

  getState(): RunnerState {
    return { ...this.cachedState };
  }

  isRunner(): boolean {
    return this.cachedState.isRunner;
  }

  async setRunner(enabled: boolean): Promise<void> {
    const next: RunnerState = {
      isRunner: enabled,
      deviceId: this.cachedState.deviceId || this.generateDeviceId(),
      lastUpdated: Date.now(),
    };
    this.cachedState = next;
    this.writeToStorage(next);
  }

  private buildStorageKey(): string {
    const vaultKey = computeVaultKey(this.app);
    return `ezrag.runner.${this.pluginId}.${vaultKey}`;
  }

  private readFromStorage(): RunnerState {
    if (typeof window === "undefined" || !window.localStorage) {
      return { ...DEFAULT_RUNNER_STATE };
    }

    try {
      const raw = window.localStorage.getItem(this.storageKey);
      if (!raw) {
        return { ...DEFAULT_RUNNER_STATE };
      }
      const parsed = JSON.parse(raw) as RunnerState;
      if (!parsed || typeof parsed.isRunner !== "boolean") {
        return { ...DEFAULT_RUNNER_STATE };
      }
      return {
        isRunner: parsed.isRunner,
        deviceId: parsed.deviceId ?? "",
        lastUpdated: parsed.lastUpdated ?? 0,
      };
    } catch (err) {
      console.error("[RunnerStateManager] Failed to read runner state", err);
      return { ...DEFAULT_RUNNER_STATE };
    }
  }

  private writeToStorage(state: RunnerState): void {
    if (typeof window === "undefined" || !window.localStorage) {
      return;
    }

    try {
      window.localStorage.setItem(this.storageKey, JSON.stringify(state));
    } catch (err) {
      console.error("[RunnerStateManager] Failed to persist runner state", err);
    }
  }

  private generateDeviceId(): string {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
      return crypto.randomUUID();
    }

    return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
  }
}
