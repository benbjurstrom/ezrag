// src/ui/indexingStatusModal.ts - Indexing controls + status

import { App, Modal, Notice } from 'obsidian';
import { ControllerSnapshot, IndexingController, IndexingPhase } from '../indexing/indexingController';

export class IndexingStatusModal extends Modal {
  private snapshot: ControllerSnapshot;
  private unsubscribe?: () => void;
  private phaseEl!: HTMLElement;
  private statsEl!: HTMLElement;
  private pendingEl!: HTMLElement;
  private pauseButton!: HTMLButtonElement;
  private rescanButton!: HTMLButtonElement;
  private clearButton!: HTMLButtonElement;
  private isRunningAction = false;

  constructor(app: App, private controller: IndexingController) {
    super(app);
    this.snapshot = controller.getSnapshot();
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: 'Indexing status' });

    this.phaseEl = contentEl.createEl('p', { cls: 'indexing-phase' });
    this.statsEl = contentEl.createEl('p', { cls: 'indexing-stats' });
    this.pendingEl = contentEl.createEl('p', { cls: 'indexing-pending' });

    const buttonBar = contentEl.createDiv({ cls: 'indexing-button-bar' });
    this.pauseButton = buttonBar.createEl('button');
    this.rescanButton = buttonBar.createEl('button', { text: 'Re-scan vault' });
    this.clearButton = buttonBar.createEl('button', { text: 'Clear queue' });

    this.pauseButton.addEventListener('click', () => this.togglePause());
    this.rescanButton.addEventListener('click', () => this.runRescan());
    this.clearButton.addEventListener('click', () => this.clearQueue());

    this.unsubscribe = this.controller.subscribe((snapshot) => {
      this.snapshot = snapshot;
      this.render();
    });

    this.render();
  }

  onClose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.contentEl.empty();
  }

  private render(): void {
    const { phase, stats } = this.snapshot;
    const active = this.controller.isActive();

    this.phaseEl.setText(`Phase: ${this.getPhaseLabel(phase, active)}`);
    this.statsEl.setText(`Completed: ${stats.completed}/${stats.total} · Failed: ${stats.failed}`);
    this.pendingEl.setText(`Pending jobs: ${stats.pending}`);

    if (!active) {
      this.pauseButton.setText('Indexing inactive');
      this.pauseButton.disabled = true;
    } else if (phase === 'paused') {
      this.pauseButton.setText('Resume indexing');
      this.pauseButton.disabled = false;
    } else {
      this.pauseButton.setText('Pause indexing');
      this.pauseButton.disabled = false;
    }

    this.rescanButton.disabled = !active || this.isRunningAction;
    this.clearButton.disabled = !active || stats.pending === 0 || this.isRunningAction;
  }

  private async togglePause(): Promise<void> {
    if (!this.controller.isActive()) return;
    if (this.controller.isPaused()) {
      this.controller.resume();
    } else {
      this.controller.pause();
    }
    this.render();
  }

  private async runRescan(): Promise<void> {
    if (!this.controller.isActive()) return;
    this.isRunningAction = true;
    this.render();
    try {
      await this.controller.runFullReconcile();
      new Notice('Vault scan started');
    } catch (err) {
      console.error('[EzRAG] Failed to run full reconcile', err);
      new Notice('Failed to start scan. See console for details.');
    } finally {
      this.isRunningAction = false;
      this.render();
    }
  }

  private clearQueue(): void {
    if (!this.controller.isActive()) return;
    this.controller.clearQueue();
    new Notice('Cleared pending indexing jobs');
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
}
