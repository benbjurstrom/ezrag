import { describe, expect, it, vi } from 'vitest';
import { PersistentQueue } from '../src/indexing/persistentQueue';
import { StateManager } from '../src/state/state';
import { ConnectionManager } from '../src/connection/connectionManager';
import { IndexQueueEntry } from '../src/types';

function createEntry(overrides: Partial<IndexQueueEntry> = {}): IndexQueueEntry {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    vaultPath: overrides.vaultPath ?? 'Note.md',
    operation: overrides.operation ?? 'upload',
    enqueuedAt: overrides.enqueuedAt ?? Date.now(),
    attempts: overrides.attempts ?? 0,
    readyAt: overrides.readyAt ?? Date.now(),
    contentHash: overrides.contentHash,
    remoteId: overrides.remoteId,
  };
}

describe('PersistentQueue integration', () => {
  it('processes ready entries when online and API key valid', async () => {
    const stateManager = new StateManager();
    const connectionManager = new ConnectionManager();
    connectionManager.setApiKeyValid(true);

    const processUpload = vi.fn(async () => {});
    const onEntrySuccess = vi.fn();

    const queue = new PersistentQueue({
      stateManager,
      connectionManager,
      maxConcurrency: 2,
      processUpload,
      processDelete: vi.fn(),
      onEntrySuccess,
      onEntryFailure: vi.fn(),
      onStatus: vi.fn(),
      onStateChange: vi.fn(),
    });

    stateManager.addOrUpdateQueueEntry(createEntry({ vaultPath: 'Docs/Note.md' }));

    queue.notifyQueueChanged();
    await queue.waitForIdle();

    expect(processUpload).toHaveBeenCalledTimes(1);
    expect(processUpload).toHaveBeenCalledWith(expect.objectContaining({ vaultPath: 'Docs/Note.md' }));
    expect(onEntrySuccess).toHaveBeenCalledWith(expect.objectContaining({ vaultPath: 'Docs/Note.md' }), true);
    expect(stateManager.getQueueEntries()).toHaveLength(0);

    queue.dispose();
  });

  it('waits until connection is restored before processing entries', async () => {
    const stateManager = new StateManager();
    const connectionManager = new ConnectionManager();

    const processUpload = vi.fn(async () => {});

    const queue = new PersistentQueue({
      stateManager,
      connectionManager,
      maxConcurrency: 1,
      processUpload,
      processDelete: vi.fn(),
      onEntrySuccess: vi.fn(),
      onEntryFailure: vi.fn(),
      onStatus: vi.fn(),
      onStateChange: vi.fn(),
    });

    stateManager.addOrUpdateQueueEntry(createEntry({ vaultPath: 'Blocked.md' }));

    queue.notifyQueueChanged();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(processUpload).not.toHaveBeenCalled();

    connectionManager.setApiKeyValid(true);
    queue.notifyQueueChanged();

    await queue.waitForIdle();
    expect(processUpload).toHaveBeenCalledTimes(1);

    queue.dispose();
  });

  it('honors readyAt delays before running entries', async () => {
    vi.useFakeTimers();
    const stateManager = new StateManager();
    const connectionManager = new ConnectionManager();
    connectionManager.setApiKeyValid(true);

    const processUpload = vi.fn(async () => {});

    const queue = new PersistentQueue({
      stateManager,
      connectionManager,
      maxConcurrency: 1,
      processUpload,
      processDelete: vi.fn(),
      onEntrySuccess: vi.fn(),
      onEntryFailure: vi.fn(),
      onStatus: vi.fn(),
      onStateChange: vi.fn(),
    });

    const now = Date.now();
    stateManager.addOrUpdateQueueEntry(createEntry({ readyAt: now + 5000, vaultPath: 'Delayed.md' }));

    queue.notifyQueueChanged();
    await vi.advanceTimersByTimeAsync(0);
    expect(processUpload).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5000);
    await queue.waitForIdle();
    expect(processUpload).toHaveBeenCalledTimes(1);

    queue.dispose();
    vi.useRealTimers();
  });
});
