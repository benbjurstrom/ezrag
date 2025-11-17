// src/ui/indexingStatusModal.ts - Queue viewer for indexing operations

import { App, Modal, Notice } from "obsidian";
import {
  IndexingController,
  IndexingPhase,
} from "../indexing/indexingController";
import { IndexQueueEntry } from "../types";
import type EzRAGPlugin from "../../main";

export class IndexingStatusModal extends Modal {
  private unsubscribe?: () => void;
  private phaseEl!: HTMLElement;
  private statsEl!: HTMLElement;
  private queueContainer!: HTMLElement;
  private clearQueueButton!: HTMLButtonElement;
  private timer?: number;
  private tableRows: Map<string, HTMLTableRowElement> = new Map();

  constructor(
    app: App,
    private controller: IndexingController,
    private plugin: EzRAGPlugin,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    // Set modal width
    this.modalEl.addClass("ezrag-queue-modal");

    // Use setTitle for proper modal header
    this.setTitle("Indexing Queue");

    // Summary section
    const summaryEl = contentEl.createDiv({ cls: "ezrag-queue-summary" });

    // Header row with phase and clear button
    const headerEl = summaryEl.createEl("div", {
      cls: "ezrag-queue-header",
    });
    this.phaseEl = headerEl.createEl("div", { cls: "ezrag-queue-phase" });
    this.clearQueueButton = headerEl.createEl("button", {
      text: "Clear queue",
      cls: "mod-warning",
    });
    this.clearQueueButton.addEventListener("click", () => {
      if (!this.controller.isActive()) {
        new Notice("Indexing is not active.");
        return;
      }
      this.controller.clearQueue();
      new Notice("Cleared pending indexing jobs");
    });

    this.statsEl = summaryEl.createEl("div", { cls: "ezrag-queue-stats" });

    // Queue table container
    this.queueContainer = contentEl.createDiv({
      cls: "ezrag-queue-table-container",
    });

    this.unsubscribe = this.controller.subscribe(() => {
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
    const phase = this.controller.getSnapshot().phase;
    const active = this.controller.isActive();
    const stats = this.plugin.getIndexStats();

    this.phaseEl.setText(`Phase: ${this.getPhaseLabel(phase, active)}`);
    this.statsEl.setText(
      `Ready: ${stats.ready}/${stats.total} · Pending: ${stats.pending} · Errors: ${stats.error}`,
    );
  }

  /**
   * Rebuild the entire queue table (called when entries change)
   */
  private rebuildQueue(): void {
    if (!this.queueContainer) return;

    const entries = this.plugin.stateManager.getQueueEntries();
    this.queueContainer.empty();
    this.tableRows.clear();

    // Update clear button state
    this.clearQueueButton.disabled = entries.length === 0;

    if (entries.length === 0) {
      this.queueContainer.createEl("p", {
        text: "Queue is empty. Documents will appear here when uploads are throttled or waiting for connectivity.",
        cls: "setting-item-description",
      });
      return;
    }

    // Create table with styling similar to FileStores table
    const table = this.queueContainer.createEl("table", {
      cls: "ezrag-queue-table",
    });
    const thead = table.createEl("thead");
    const headerRow = thead.createEl("tr");
    ["Document", "Status", "Attempts"].forEach((label) => {
      headerRow.createEl("th", { text: label });
    });

    const tbody = table.createEl("tbody");
    const sorted = [...entries].sort((a, b) => {
      const aReady = a.readyAt ?? a.enqueuedAt ?? 0;
      const bReady = b.readyAt ?? b.enqueuedAt ?? 0;
      return aReady - bReady;
    });

    for (const entry of sorted) {
      const row = tbody.createEl("tr");
      const key = `${entry.vaultPath}-${entry.operation}`;
      this.tableRows.set(key, row);

      // Document name (static)
      row.createEl("td", {
        text: entry.vaultPath,
        cls: "ezrag-queue-doc",
      });

      // Consolidated Status (dynamic - updated by timer)
      row.createEl("td", {
        text: this.getConsolidatedStatus(entry),
        cls: "ezrag-queue-status",
        attr: {
          "data-ready-at": String(entry.readyAt ?? entry.enqueuedAt ?? 0),
        },
      });

      // Attempts (dynamic - updated by timer)
      row.createEl("td", {
        text: this.getAttemptsText(entry),
        cls: "ezrag-queue-attempts",
        attr: {
          "data-attempts": String(entry.attempts ?? 0),
          "data-last-attempt": String(entry.lastAttemptAt ?? 0),
        },
      });
    }
  }

  /**
   * Update only time-dependent cells (called every second)
   */
  private updateTimeCells(): void {
    const entries = this.plugin.stateManager.getQueueEntries();

    for (const entry of entries) {
      const key = `${entry.vaultPath}-${entry.operation}`;
      const row = this.tableRows.get(key);
      if (!row) continue;

      // Update consolidated status cell
      const statusCell = row.querySelector(
        ".ezrag-queue-status",
      ) as HTMLElement;
      if (statusCell) {
        statusCell.setText(this.getConsolidatedStatus(entry));
      }

      // Update "Attempts" cell if last attempt time changed
      const attemptsCell = row.querySelector(
        ".ezrag-queue-attempts",
      ) as HTMLElement;
      if (attemptsCell && entry.lastAttemptAt) {
        attemptsCell.setText(this.getAttemptsText(entry));
      }
    }
  }

  private getPhaseLabel(phase: IndexingPhase, active: boolean): string {
    if (!active) {
      return "Inactive";
    }

    switch (phase) {
      case "scanning":
        return "Scanning vault";
      case "indexing":
        return "Indexing";
      case "paused":
        return "Paused";
      default:
        return "Idle";
    }
  }

  private getConsolidatedStatus(entry: IndexQueueEntry): string {
    const now = Date.now();
    const readyAt = entry.readyAt ?? entry.enqueuedAt ?? now;
    const docState = this.plugin.stateManager.getDocState(entry.vaultPath);

    // Check for error state
    if (docState?.status === "error") {
      const errorMsg = docState.errorMessage || "Unknown error";
      // Truncate long error messages
      return errorMsg.length > 50
        ? `Error: ${errorMsg.substring(0, 47)}...`
        : `Error: ${errorMsg}`;
    }

    // Check if waiting for connection
    if (readyAt <= now && !this.plugin.isConnected()) {
      return "Waiting for connection";
    }

    // Handle delete operations
    if (entry.operation === "delete") {
      if (readyAt > now) {
        return `Deleting in ${this.formatDuration(readyAt - now)}`;
      }
      return "Deleting";
    }

    // Handle upload operations
    if (readyAt > now) {
      return `Uploading in ${this.formatDuration(readyAt - now)}`;
    }

    return "Queued";
  }

  private getAttemptsText(entry: IndexQueueEntry): string {
    if (!entry.attempts) {
      return "0";
    }

    const last = entry.lastAttemptAt
      ? ` · last ${this.formatDuration(Date.now() - entry.lastAttemptAt)} ago`
      : "";
    return `${entry.attempts}${last}`;
  }

  private formatDuration(ms: number): string {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes === 0) {
      return `${seconds}s`;
    }
    return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
  }
}
