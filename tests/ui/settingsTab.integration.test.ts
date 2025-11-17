import { describe, expect, it, vi } from 'vitest';
import { EzRAGSettingTab } from '../../src/ui/settingsTab';
import { App } from 'obsidian';
import { StateManager } from '../../src/state/state';
import { DEFAULT_SETTINGS } from '../../src/types';

function createPlugin(overrides: { apiKey?: string } = {}) {
  const settings = { ...DEFAULT_SETTINGS, apiKey: overrides.apiKey ?? '' };
  const stateManager = new StateManager({ settings });

  const runnerManager = {
    isRunner: vi.fn().mockReturnValue(false),
    getState: vi.fn().mockReturnValue({ isRunner: false }),
    setRunner: vi.fn().mockResolvedValue(undefined),
  };

  const plugin = {
    stateManager,
    runnerManager,
    getConnectionState: () => ({ apiKeyError: undefined }),
    updateApiKey: vi.fn().mockResolvedValue(undefined),
    getMCPServerStatus: () => ({ running: false, url: 'http://localhost:42427' }),
    handleMCPServerToggle: vi.fn().mockResolvedValue(undefined),
    updateMCPServerPort: vi.fn().mockResolvedValue(undefined),
    handleRunnerStateChange: vi.fn().mockResolvedValue(undefined),
    getIndexStats: () => ({ total: 0, ready: 0, pending: 0, error: 0 }),
    rebuildIndex: vi.fn().mockResolvedValue(undefined),
    runJanitorWithUI: vi.fn().mockResolvedValue(undefined),
    saveState: vi.fn().mockResolvedValue(undefined),
    openIndexingStatusModal: vi.fn(),
    indexingController: undefined,
  };

  return { plugin, stateManager };
}

function findButton(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find(btn => btn.textContent === text);
}

describe('EzRAGSettingTab FileSearch management button', () => {
  it('disables Manage Stores button when API key is missing', async () => {
    const { plugin } = createPlugin({ apiKey: '' });
    const tab = new EzRAGSettingTab(new App() as any, plugin as any);

    await tab.display();

    const button = findButton(tab.containerEl, 'Manage Stores');
    expect(button).toBeDefined();
    expect(button?.disabled).toBe(true);
  });

  it('enables Manage Stores button when API key is set', async () => {
    const { plugin } = createPlugin({ apiKey: 'test-key' });
    const tab = new EzRAGSettingTab(new App() as any, plugin as any);

    await tab.display();

    const button = findButton(tab.containerEl, 'Manage Stores');
    expect(button).toBeDefined();
    expect(button?.disabled).toBe(false);
  });
});
