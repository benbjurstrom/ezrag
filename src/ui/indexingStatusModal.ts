// src/ui/indexingStatusModal.ts - Queue viewer for indexing operations

import { App, Modal } from 'obsidian';
import { ControllerSnapshot, IndexingController, IndexingPhase } from '../indexing/indexingController';
import { IndexQueueEntry } from '../types';
import type EzRAGPlugin from '../../main';

export class IndexingStatusModal extends Modal {
  private snapshot: ControllerSnapshot;
  private unsubscribe?: () => void;
  private phaseEl!: HTMLElement;
  private statsEl!: HTMLElement;
  private queueContainer!: HTMLElement;
  private timer?: number;

  constructor(app: App, private controller: IndexingController, private plugin: EzRAGPlugin) {
    super(app);
    this.snapshot = controller.getSnapshot();
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: 'Indexing queue' });

    this.phaseEl = contentEl.createEl('p', { cls: 'indexing-phase' });
    this.statsEl = contentEl.createEl('p', { cls: 'indexing-stats' });

    this.queueContainer = contentEl.createDiv({ cls: 'indexing-queue-container' });

    this.unsubscribe = this.controller.subscribe((snapshot) => {
      this.snapshot = snapshot;
      this.renderSummary();
      this.renderQueue();
    });

    this.renderSummary();
    this.renderQueue();

    this.timer = window.setInterval(() => this.renderQueue(), 1000);
  }

  onClose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.timer) {
      window.clearInterval(this.timer);
      this.timer = undefined;
    }
    this.contentEl.empty();
  }

  private renderSummary(): void {
    const { phase, stats } = this.snapshot;
    const active = this.controller.isActive();

    this.phaseEl.setText(`Phase: ${this.getPhaseLabel(phase, active)}`);
    this.statsEl.setText(`Completed: ${stats.completed}/${Math.max(stats.total, stats.completed)} · Failed: ${stats.failed} · Pending: ${stats.pending}`);
  }

  private renderQueue(): void {
    if (!this.queueContainer) return;

    const entries = this.plugin.stateManager.getQueueEntries();
    this.queueContainer.empty();

    if (entries.length === 0) {
      this.queueContainer.createEl('p', {
        text: 'Queue is empty. Documents will appear here when uploads are throttled or waiting for connectivity.',
        cls: 'setting-item-description'
      });
      return;
    }

    const table = this.queueContainer.createEl('table', { cls: 'indexing-queue-table' });
    const thead = table.createEl('thead');
    const headerRow = thead.createEl('tr');
    ['Document', 'Operation', 'Status', 'Ready in', 'Attempts'].forEach((label) => {
      headerRow.createEl('th', { text: label });
    });

    const tbody = table.createEl('tbody');
    const sorted = [...entries].sort((a, b) => {
      const aReady = a.readyAt ?? a.enqueuedAt ?? 0;
      const bReady = b.readyAt ?? b.enqueuedAt ?? 0;
      return aReady - bReady;
    });

    for (const entry of sorted) {
      const row = tbody.createEl('tr');
      row.createEl('td', { text: entry.vaultPath });
      row.createEl('td', { text: entry.operation === 'upload' ? 'Upload' : 'Delete' });
      row.createEl('td', { text: this.getEntryStatus(entry) });
      row.createEl('td', { text: this.getReadyText(entry) });
      row.createEl('td', { text: this.getAttemptsText(entry) });
    }
  }

  private getPhaseLabel(phase: IndexingPhase, active: boolean): string {
    if (!active) {
      return 'Inactive';
    }

    switch (phase) {
      case 'scanning':
        return 'Scanning vault';
      case 'indexing':
        return 'Indexing';
      case 'paused':
        return 'Paused';
      default:
        return 'Idle';
    }
  }

  private getEntryStatus(entry: IndexQueueEntry): string {
    const docState = this.plugin.stateManager.getDocState(entry.vaultPath);
    if (entry.operation === 'delete') {
      return 'Pending delete';
    }
    if (docState?.status === 'error') {
      return 'Error';
    }
    if (docState?.status === 'ready') {
      return 'Ready';
    }
    return 'Pending';
  }

  private getReadyText(entry: IndexQueueEntry): string {
    const now = Date.now();
    const readyAt = entry.readyAt ?? entry.enqueuedAt ?? now;
    if (readyAt > now) {
      return `in ${this.formatDuration(readyAt - now)}`;
    }
    return this.plugin.isConnected() ? 'Ready' : 'Waiting for connection';
  }

  private getAttemptsText(entry: IndexQueueEntry): string {
    if (!entry.attempts) {
      return '0';
    }

    const last = entry.lastAttemptAt ? ` · last ${this.formatDuration(Date.now() - entry.lastAttemptAt)} ago` : '';
    return `${entry.attempts}${last}`;
  }

  private formatDuration(ms: number): string {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes === 0) {
      return `${seconds}s`;
    }
    return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
  }
}
