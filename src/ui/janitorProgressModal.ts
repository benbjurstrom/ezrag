// src/ui/janitorProgressModal.ts - Deduplication progress UI

import { App, Modal } from 'obsidian';
import { JanitorStats } from '../indexing/janitor';

export class JanitorProgressModal extends Modal {
  private stats: JanitorStats;
  private phaseEl!: HTMLElement;
  private progressEl!: HTMLElement;
  private statsEl!: HTMLElement;
  private currentActionEl!: HTMLElement;
  private closeButtonEl!: HTMLButtonElement;
  private isDone: boolean = false;

  constructor(app: App) {
    super(app);
    this.stats = {
      totalRemoteDocs: 0,
      duplicatesFound: 0,
      duplicatesDeleted: 0,
      stateUpdated: 0,
      orphansDeleted: 0,
    };
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: 'Deduplication Progress' });

    // Phase indicator
    this.phaseEl = contentEl.createDiv({ cls: 'janitor-phase' });

    // Progress summary
    this.progressEl = contentEl.createDiv({ cls: 'janitor-progress' });

    // Stats display
    this.statsEl = contentEl.createDiv({ cls: 'janitor-stats' });

    // Current action
    this.currentActionEl = contentEl.createDiv({ cls: 'janitor-current' });

    // Close button (disabled until complete)
    const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
    this.closeButtonEl = buttonContainer.createEl('button', { text: 'Close' });
    this.closeButtonEl.disabled = true;
    this.closeButtonEl.addEventListener('click', () => this.close());

    this.render();
  }

  updateStats(stats: Partial<JanitorStats>, currentAction?: string) {
    this.stats = { ...this.stats, ...stats };
    if (currentAction) {
      this.currentActionEl.setText(currentAction);
    }
    this.render();
  }

  markComplete() {
    this.isDone = true;
    this.currentActionEl.setText('');
    this.render();
    this.closeButtonEl.disabled = false;
  }

  markFailed(error: string) {
    this.isDone = true;
    this.phaseEl.setText('Deduplication failed');
    this.currentActionEl.setText(`Error: ${error}`);
    this.closeButtonEl.disabled = false;
  }

  private render() {
    // Phase
    if (!this.isDone) {
      this.phaseEl.setText('Running deduplication...');
    } else {
      this.phaseEl.setText('Deduplication complete!');
    }

    // Progress summary
    this.progressEl.setText(
      `Scanned: ${this.stats.totalRemoteDocs} documents`
    );

    // Stats
    const statsList = [
      `Duplicates found: ${this.stats.duplicatesFound}`,
      `Duplicates deleted: ${this.stats.duplicatesDeleted}`,
      `State updates: ${this.stats.stateUpdated}`,
    ];
    this.statsEl.setText(statsList.join('\n'));
  }

  onClose() {
    this.contentEl.empty();
  }
}
