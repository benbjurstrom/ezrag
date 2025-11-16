import PQueue from 'p-queue';
import { ConnectionManager } from '../connection/connectionManager';
import { StateManager } from '../state/state';
import { IndexQueueEntry } from '../types';

export type QueueEntryHandler = (entry: IndexQueueEntry) => Promise<void>;

export interface PersistentQueueOptions {
  stateManager: StateManager;
  connectionManager: ConnectionManager;
  maxConcurrency: number;
  processUpload: QueueEntryHandler;
  processDelete: QueueEntryHandler;
  onEntrySuccess: (entry: IndexQueueEntry, removed: boolean) => void;
  onEntryFailure: (entry: IndexQueueEntry, error: Error | null, removed: boolean) => void;
  onStatus: (status: string) => void;
  onStateChange: () => void;
}

export class PersistentQueue {
  private queue: PQueue;
  private processingEntries = new Set<string>();
  private nextReadyTimer: number | null = null;

  constructor(private options: PersistentQueueOptions) {
    this.queue = new PQueue({ concurrency: options.maxConcurrency });
  }

  notifyQueueChanged(): void {
    this.tryProcessQueue();
  }

  waitForIdle(): Promise<void> {
    return this.queue.onIdle();
  }

  pause(): void {
    this.queue.pause();
  }

  resume(): void {
    this.queue.start();
    this.tryProcessQueue();
  }

  clear(): void {
    this.queue.clear();
    this.processingEntries.clear();
    this.scheduleNextReadyTimer(null);
  }

  dispose(): void {
    this.clear();
  }

  private tryProcessQueue(): void {
    if (this.queue.isPaused) {
      return;
    }

    const entries = this.options.stateManager.getQueueEntries();
    if (entries.length === 0) {
      this.scheduleNextReadyTimer(null);
      return;
    }

    const now = Date.now();
    let nextReadyAt: number | null = null;
    const readyEntries: IndexQueueEntry[] = [];

    for (const entry of entries) {
      const entryReadyAt = entry.readyAt ?? entry.enqueuedAt ?? now;
      if (entryReadyAt > now) {
        if (nextReadyAt === null || entryReadyAt < nextReadyAt) {
          nextReadyAt = entryReadyAt;
        }
        continue;
      }
      readyEntries.push(entry);
    }

    this.scheduleNextReadyTimer(nextReadyAt);

    if (!this.options.connectionManager.isConnected()) {
      return;
    }

    for (const entry of readyEntries) {
      if (this.processingEntries.has(entry.id)) {
        continue;
      }

      this.processingEntries.add(entry.id);
      this.queue
        .add(async () => {
          try {
            await this.processQueueEntry(entry);
          } finally {
            this.processingEntries.delete(entry.id);
          }
        })
        .catch((err: unknown) => {
          console.error('[PersistentQueue] Queue entry crashed', err);
        });
    }
  }

  private scheduleNextReadyTimer(nextReadyAt: number | null): void {
    if (this.nextReadyTimer !== null) {
      window.clearTimeout(this.nextReadyTimer);
      this.nextReadyTimer = null;
    }

    if (!nextReadyAt) {
      return;
    }

    const delay = Math.max(0, nextReadyAt - Date.now());
    this.nextReadyTimer = window.setTimeout(() => {
      this.nextReadyTimer = null;
      this.tryProcessQueue();
    }, delay);
  }

  private async processQueueEntry(entry: IndexQueueEntry): Promise<void> {
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (!this.options.connectionManager.isConnected()) {
        this.recordAttempt(entry, attempt === 0 ? 0 : 1);
        this.options.onStatus('Waiting for connection');
        return;
      }

      try {
        if (entry.operation === 'upload') {
          await this.options.processUpload(entry);
        } else {
          await this.options.processDelete(entry);
        }

        const removed = this.removeQueueEntryIfCurrent(entry);
        this.options.onEntrySuccess(entry, removed);
        return;
      } catch (err) {
        lastError = err as Error;
        this.recordAttempt(entry, 1);

        if (this.isAuthError(err)) {
          this.options.connectionManager.setApiKeyValid(
            false,
            'Gemini rejected the API key. Please verify it in settings.'
          );
          return;
        }

        const isRetryable = this.isRetryableError(err);
        if (!isRetryable || attempt === maxRetries - 1) {
          break;
        }

        const delayMs = Math.pow(2, attempt) * 1000;
        console.log(`Retry ${attempt + 1}/${maxRetries} for ${entry.vaultPath} after ${delayMs}ms`);
        await this.delay(delayMs);
      }
    }

    if (!this.options.connectionManager.isConnected()) {
      this.recordAttempt(entry, 1);
      this.options.onStatus('Waiting for connection');
      return;
    }

    const removed = this.removeQueueEntryIfCurrent(entry);
    this.options.onEntryFailure(entry, lastError, removed);
  }

  private recordAttempt(entry: IndexQueueEntry, increment: number): void {
    if (increment <= 0) {
      return;
    }
    const now = Date.now();
    const attempts = (entry.attempts ?? 0) + increment;
    this.options.stateManager.updateQueueEntry(entry.id, {
      lastAttemptAt: now,
      attempts,
    });
    entry.lastAttemptAt = now;
    entry.attempts = attempts;
    this.options.onStateChange();
  }

  private removeQueueEntryIfCurrent(entry: IndexQueueEntry): boolean {
    const current = this.options.stateManager.findQueueEntryByPath(entry.vaultPath);
    if (current && current.enqueuedAt !== entry.enqueuedAt) {
      return false;
    }
    this.options.stateManager.removeQueueEntry(entry.id);
    return true;
  }

  private isRetryableError(err: any): boolean {
    const message = err?.message?.toLowerCase() || '';
    return (
      message.includes('network') ||
      message.includes('timeout') ||
      message.includes('rate limit') ||
      message.includes('429') ||
      message.includes('503') ||
      message.includes('econnreset') ||
      message.includes('enotfound') ||
      message.includes('failed to fetch') ||
      message.includes('offline')
    );
  }

  private isAuthError(err: any): boolean {
    const message = (err?.message ?? '').toLowerCase();
    if (!message) return false;
    return (
      message.includes('401') ||
      message.includes('403') ||
      message.includes('unauthorized') ||
      message.includes('api key')
    );
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
