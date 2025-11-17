// src/ui/janitorProgressModal.ts - Remote index cleanup progress UI

import { App, Modal } from "obsidian";
import { JanitorProgressUpdate, JanitorStats } from "../indexing/janitor";

export class JanitorProgressModal extends Modal {
  private stats: JanitorStats;
  private phaseEl!: HTMLElement;
  private progressLabelEl!: HTMLElement;
  private progressBarFillEl!: HTMLElement;
  private summaryEl!: HTMLElement;
  private currentActionEl!: HTMLElement;
  private closeButtonEl!: HTMLButtonElement;
  private isDone: boolean = false;
  private currentPhase: string = "Preparing…";
  private progressCurrent = 0;
  private progressTotal = 0;

  constructor(app: App) {
    super(app);
    this.stats = {
      totalRemoteDocs: 0,
      totalRemoved: 0,
    };
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "Remote Index Cleanup" });

    // Phase indicator
    this.phaseEl = contentEl.createDiv({
      cls: "janitor-phase",
      text: this.currentPhase,
    });

    // Progress bar
    const progressContainer = contentEl.createDiv({
      cls: "janitor-progress-container",
    });
    const bar = progressContainer.createDiv({
      cls: "janitor-progress-bar",
    });
    this.progressBarFillEl = bar.createDiv({
      cls: "janitor-progress-fill",
    });
    this.progressLabelEl = progressContainer.createDiv({
      cls: "janitor-progress-label",
    });

    // Current action detail
    this.currentActionEl = contentEl.createDiv({ cls: "janitor-current" });

    // Summary (hidden until complete)
    this.summaryEl = contentEl.createDiv({ cls: "janitor-summary" });
    this.summaryEl.style.display = "none";

    // Close button (disabled until complete)
    const buttonContainer = contentEl.createDiv({
      cls: "modal-button-container",
    });
    this.closeButtonEl = buttonContainer.createEl("button", {
      text: "Close",
    });
    this.closeButtonEl.disabled = true;
    this.closeButtonEl.addEventListener("click", () => this.close());

    this.renderProgressBar();
  }

  updateProgress(update: JanitorProgressUpdate) {
    this.currentPhase = this.formatPhase(update.phase);
    this.phaseEl.setText(this.currentPhase);

    // Update current action message (detailed status)
    if (update.message) {
      this.currentActionEl.setText(update.message);
    }

    // Update progress values
    this.progressCurrent = update.current ?? 0;
    this.progressTotal = update.total ?? 0;
    this.renderProgressBar();
  }

  updateStats(stats: Partial<JanitorStats>) {
    this.stats = { ...this.stats, ...stats };
  }

  markComplete() {
    this.isDone = true;
    this.phaseEl.setText("Cleanup complete!");
    this.currentActionEl.style.display = "none";
    this.progressBarFillEl.style.width = "100%";
    this.progressLabelEl.setText("");

    // Show summary
    this.summaryEl.style.display = "block";
    const removed = this.stats.totalRemoved;
    const total = this.stats.totalRemoteDocs;

    if (removed === 0) {
      this.summaryEl.setText(
        `Found ${total} remote document${total === 1 ? "" : "s"}.\nAll documents match the local state.`,
      );
    } else {
      this.summaryEl.setText(
        `Found ${total} remote document${total === 1 ? "" : "s"}.\nRemoved ${removed} ${removed === 1 ? "entry" : "entries"} that didn't match.`,
      );
    }

    this.closeButtonEl.disabled = false;
  }

  markFailed(error: string) {
    this.isDone = true;
    this.phaseEl.setText("Cleanup failed");
    this.currentActionEl.style.display = "block";
    this.currentActionEl.setText(`Error: ${error}`);
    this.summaryEl.style.display = "none";
    this.closeButtonEl.disabled = false;
  }

  private renderProgressBar() {
    if (this.progressTotal && this.progressTotal > 0) {
      // Show determinate progress bar with percentage
      const pct = Math.min(
        100,
        Math.max(0, (this.progressCurrent / this.progressTotal) * 100),
      );
      this.progressBarFillEl.style.width = `${pct}%`;
      this.progressBarFillEl.removeClass("is-indeterminate");
      this.progressLabelEl.setText(
        `${this.progressCurrent} / ${this.progressTotal}`,
      );
    } else {
      // Show indeterminate progress bar
      this.progressBarFillEl.style.width = "30%";
      this.progressBarFillEl.addClass("is-indeterminate");
      this.progressLabelEl.setText("");
    }
  }

  onClose() {
    this.contentEl.empty();
  }

  private formatPhase(phase: JanitorProgressUpdate["phase"]): string {
    switch (phase) {
      case "fetching":
        return "Reading remote documents";
      case "analyzing":
        return "Analyzing metadata";
      case "deleting-duplicates":
        return "Removing stale documents";
      case "deleting-orphans":
        return "Removing stale documents";
      case "complete":
        return "Cleanup complete";
      default:
        return "Processing";
    }
  }
}
