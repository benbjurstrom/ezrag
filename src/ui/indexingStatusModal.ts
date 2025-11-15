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
  private tableRows: Map<string, HTMLTableRowElement> = new Map();

  constructor(app: App, private controller: IndexingController, private plugin: EzRAGPlugin) {
    super(app);
    this.snapshot = controller.getSnapshot();
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    // Set modal width
    this.modalEl.addClass('ezrag-queue-modal');

    // Use setTitle for proper modal header
    this.setTitle('Indexing Queue');

    // Summary section
    const summaryEl = contentEl.createDiv({ cls: 'ezrag-queue-summary' });
    this.phaseEl = summaryEl.createEl('div', { cls: 'ezrag-queue-phase' });
    this.statsEl = summaryEl.createEl('div', { cls: 'ezrag-queue-stats' });

    // Queue table container
    this.queueContainer = contentEl.createDiv({ cls: 'ezrag-queue-table-container' });

    this.unsubscribe = this.controller.subscribe((snapshot) => {
      this.snapshot = snapshot;
      this.renderSummary();
      this.rebuildQueue();
    });

    this.renderSummary();
    this.rebuildQueue();

    // Update only time-dependent cells every second
    this.timer = window.setInterval(() => this.updateTimeCells(), 1000);
  }

  onClose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.timer) {
      window.clearInterval(this.timer);
      this.timer = undefined;
    }
    this.tableRows.clear();
    this.contentEl.empty();
  }

  private renderSummary(): void {
    const { phase, stats } = this.snapshot;
    const active = this.controller.isActive();

    this.phaseEl.setText(`Phase: ${this.getPhaseLabel(phase, active)}`);
    this.statsEl.setText(`Completed: ${stats.completed}/${Math.max(stats.total, stats.completed)} · Failed: ${stats.failed} · Pending: ${stats.pending}`);
  }

  /**
   * Rebuild the entire queue table (called when entries change)
   */
  private rebuildQueue(): void {
    if (!this.queueContainer) return;

    const entries = this.plugin.stateManager.getQueueEntries();
    this.queueContainer.empty();
    this.tableRows.clear();

    if (entries.length === 0) {
      this.queueContainer.createEl('p', {
        text: 'Queue is empty. Documents will appear here when uploads are throttled or waiting for connectivity.',
        cls: 'setting-item-description'
      });
      return;
    }

    // Create table with styling similar to FileStores table
    const table = this.queueContainer.createEl('table', { cls: 'ezrag-queue-table' });
    const thead = table.createEl('thead');
    const headerRow = thead.createEl('tr');
    ['Document', 'Operation', 'Status', 'Ready In', 'Attempts'].forEach((label) => {
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
      const key = `${entry.vaultPath}-${entry.operation}`;
      this.tableRows.set(key, row);

      // Document name (static)
      row.createEl('td', { text: entry.vaultPath, cls: 'ezrag-queue-doc' });

      // Operation (static)
      row.createEl('td', { text: entry.operation === 'upload' ? 'Upload' : 'Delete' });

      // Status (static)
      row.createEl('td', { text: this.getEntryStatus(entry) });

      // Ready in (dynamic - updated by timer)
      row.createEl('td', {
        text: this.getReadyText(entry),
        cls: 'ezrag-queue-ready',
        attr: { 'data-ready-at': String(entry.readyAt ?? entry.enqueuedAt ?? 0) }
      });

      // Attempts (dynamic - updated by timer)
      row.createEl('td', {
        text: this.getAttemptsText(entry),
        cls: 'ezrag-queue-attempts',
        attr: {
          'data-attempts': String(entry.attempts ?? 0),
          'data-last-attempt': String(entry.lastAttemptAt ?? 0)
        }
      });
    }
  }

  /**
   * Update only time-dependent cells (called every second)
   */
  private updateTimeCells(): void {
    const entries = this.plugin.stateManager.getQueueEntries();
    const now = Date.now();

    for (const entry of entries) {
      const key = `${entry.vaultPath}-${entry.operation}`;
      const row = this.tableRows.get(key);
      if (!row) continue;

      // Update "Ready In" cell
      const readyCell = row.querySelector('.ezrag-queue-ready') as HTMLElement;
      if (readyCell) {
        readyCell.setText(this.getReadyText(entry));
      }

      // Update "Attempts" cell if last attempt time changed
      const attemptsCell = row.querySelector('.ezrag-queue-attempts') as HTMLElement;
      if (attemptsCell && entry.lastAttemptAt) {
        attemptsCell.setText(this.getAttemptsText(entry));
      }
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
