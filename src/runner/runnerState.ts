// src/runner/runnerState.ts - Per-machine runner configuration (non-synced)

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

export interface RunnerConfig {
  isRunner: boolean;
  lastEnabledAt?: number;
  deviceName?: string; // For user reference (hostname)
}

export class RunnerManager {
  private configPath: string;
  private config: RunnerConfig;

  constructor(pluginId: string, vaultPath: string) {
    this.configPath = this.buildConfigPath(pluginId, vaultPath);
    this.config = { isRunner: false };
  }

  async load(): Promise<void> {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = await fs.promises.readFile(this.configPath, 'utf8');
        this.config = JSON.parse(raw);
      }
    } catch (err) {
      console.error('[RunnerManager] Failed to load config:', err);
      this.config = { isRunner: false };
    }
  }

  async save(): Promise<void> {
    try {
      // Ensure directory exists
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const json = JSON.stringify(this.config, null, 2);
      await fs.promises.writeFile(this.configPath, json, 'utf8');
    } catch (err) {
      console.error('[RunnerManager] Failed to save config:', err);
    }
  }

  isRunner(): boolean {
    return this.config.isRunner;
  }

  async setRunner(value: boolean): Promise<void> {
    this.config.isRunner = value;
    if (value) {
      this.config.lastEnabledAt = Date.now();
      this.config.deviceName = os.hostname();
    }
    await this.save();
  }

  getConfig(): RunnerConfig {
    return { ...this.config };
  }

  private buildConfigPath(pluginId: string, vaultPath: string): string {
    // Get Obsidian config directory by platform
    const platform = process.platform;
    let baseConfigDir: string;

    if (platform === 'win32') {
      baseConfigDir = path.join(
        process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'),
        'Obsidian'
      );
    } else if (platform === 'darwin') {
      baseConfigDir = path.join(
        os.homedir(),
        'Library',
        'Application Support',
        'Obsidian'
      );
    } else {
      // Linux
      baseConfigDir = path.join(
        process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'),
        'Obsidian'
      );
    }

    // Create stable vault-specific key using hash
    const vaultKey = this.hashVaultPath(vaultPath);

    return path.join(baseConfigDir, 'plugins', pluginId, vaultKey, 'runner.json');
  }

  private hashVaultPath(vaultPath: string): string {
    // SHA-256 hash of vault path, take first 16 chars
    return crypto
      .createHash('sha256')
      .update(vaultPath)
      .digest('hex')
      .substring(0, 16);
  }
}
