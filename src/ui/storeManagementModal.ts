// src/ui/storeManagementModal.ts - FileStore management modal

import { App, Modal, Notice, Platform, setIcon } from "obsidian";
import type EzRAGPlugin from "../../main";

interface StoreTableData {
  name: string;
  displayName: string;
  createTime: string;
  updateTime: string;
  activeDocumentsCount: number;
  pendingDocumentsCount: number;
  failedDocumentsCount: number;
  sizeBytes: number;
}

export class StoreManagementModal extends Modal {
  private plugin: EzRAGPlugin;
  private storeData: StoreTableData[] | null = null;
  private tableContainer: HTMLElement | null = null;

  constructor(app: App, plugin: EzRAGPlugin) {
    super(app);
    this.plugin = plugin;
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ezrag-store-management-modal");

    // Header with title and refresh button
    const header = contentEl.createDiv({ cls: "modal-header" });
    header.style.display = "flex";
    header.style.justifyContent = "space-between";
    header.style.alignItems = "center";
    header.style.marginBottom = "1em";

    header.createEl("h2", { text: "Gemini FileStores" });

    const headerActions = header.createDiv({ cls: "modal-header-actions" });
    const refreshBtn = headerActions.createEl("button", {
      text: "Refresh",
      cls: "mod-cta",
    });
    setIcon(refreshBtn, "refresh-cw");
    refreshBtn.addEventListener("click", async () => {
      refreshBtn.disabled = true;
      this.storeData = null; // Clear cache
      await this.renderStoreTable();
      refreshBtn.disabled = false;
    });

    // Description
    contentEl.createDiv({
      text: "FileSearch stores associated with this API key",
      cls: "setting-item-description",
    });

    // Container for table
    this.tableContainer = contentEl.createDiv({
      cls: "ezrag-store-table-container",
    });

    // Initial render
    await this.renderStoreTable();
  }

  /**
   * Fetch store data from Gemini API
   */
  private async fetchStoreData(): Promise<StoreTableData[]> {
    // Use cached data if available
    if (this.storeData) {
      return this.storeData;
    }

    const service =
      this.plugin.storeManager?.["getOrCreateGeminiService"](
        "load Gemini stores",
      );
    if (!service) {
      return [];
    }

    try {
      const stores = await service.listStores();
      this.storeData = stores as StoreTableData[];
      return this.storeData;
    } catch (err) {
      console.error("[EzRAG] Failed to fetch stores:", err);
      new Notice("Failed to load stores. See console for details.");
      return [];
    }
  }

  /**
   * Render the store table
   */
  private async renderStoreTable(): Promise<void> {
    if (!this.tableContainer) return;

    // Clear existing content
    this.tableContainer.empty();

    // Show loading state
    const loadingEl = this.tableContainer.createDiv({
      text: "Loading stores...",
      cls: "setting-item-description",
    });

    // Fetch store data
    const stores = await this.fetchStoreData();
    loadingEl.remove();

    const currentStoreId = this.plugin.stateManager.getSettings().storeName;

    if (stores.length === 0) {
      this.tableContainer.createEl("p", {
        text: "No stores found. Upload a document to create your first store.",
        cls: "setting-item-description",
      });
      return;
    }

    // Create table
    const table = this.tableContainer.createEl("table", {
      cls: "ezrag-store-table",
    });

    // Table header
    const thead = table.createEl("thead");
    const headerRow = thead.createEl("tr");
    headerRow.createEl("th", { text: "Display Name" });
    headerRow.createEl("th", { text: "Active" });
    headerRow.createEl("th", { text: "Pending" });
    headerRow.createEl("th", { text: "Failed" });
    headerRow.createEl("th", { text: "Size" });
    headerRow.createEl("th", { text: "Actions" });

    // Table body
    const tbody = table.createEl("tbody");
    stores.forEach((store) => {
      const row = tbody.createEl("tr");
      const isCurrent = store.name === currentStoreId;

      // Display Name
      row.createEl("td", { text: store.displayName });

      // Active count
      row.createEl("td", {
        text: String(store.activeDocumentsCount || 0),
      });

      // Pending count
      row.createEl("td", {
        text: String(store.pendingDocumentsCount || 0),
      });

      // Failed count
      row.createEl("td", {
        text: String(store.failedDocumentsCount || 0),
      });

      // Size
      row.createEl("td", {
        text: this.formatBytes(store.sizeBytes || 0),
      });

      // Actions cell
      const actionsCell = row.createEl("td", {
        cls: "ezrag-store-actions",
      });

      // Current store indicator/toggle
      const starBtn = actionsCell.createEl("button", {
        cls: "clickable-icon",
        attr: {
          "aria-label": isCurrent ? "Current store" : "Set as current store",
        },
      });
      setIcon(starBtn, isCurrent ? "star" : "star-off");
      starBtn.addEventListener("click", async () => {
        if (!isCurrent) {
          await this.handleSetCurrentStore(store.name, store.displayName);
        }
      });

      // Delete button
      const deleteBtn = actionsCell.createEl("button", {
        cls: "clickable-icon",
        attr: { "aria-label": "Delete store" },
      });
      setIcon(deleteBtn, "trash");
      deleteBtn.addEventListener("click", async () => {
        await this.handleDeleteStore(store.name, store.displayName, isCurrent);
      });
    });

    // Warning if too many stores
    if (stores.length > 20) {
      this.tableContainer.createEl("p", {
        text: "Note: You have more than 20 stores. Consider cleaning up unused stores for better performance.",
        cls: "setting-item-description mod-warning",
      });
    }
  }

  /**
   * Handle deleting a store
   */
  private async handleDeleteStore(
    storeId: string,
    storeName: string,
    isCurrent: boolean,
  ): Promise<void> {
    const confirmed = await this.plugin.confirmAction(
      "Delete Store",
      `Are you sure you want to permanently delete "${storeName}"?\n\n` +
        `This will delete all indexed documents in this store and cannot be undone.` +
        (isCurrent
          ? "\n\nThis is your current store. A new store will be automatically created and set as current after deletion."
          : ""),
    );

    if (!confirmed) return;

    const service = this.plugin.storeManager?.["getOrCreateGeminiService"](
      "delete a FileSearch store",
    );
    if (!service) return;

    try {
      await service.deleteStore(storeId);

      // If deleting current store, clear settings and create a new one
      if (isCurrent) {
        this.plugin.stateManager.updateSettings({
          storeName: "",
          storeDisplayName: "",
        });
        this.plugin.stateManager.clearIndex();
        await this.plugin.saveState();

        new Notice(`Store "${storeName}" deleted. Creating new store...`);

        // Create new store and set as current
        try {
          await this.plugin.ensureGeminiResources();

          const newStoreName =
            this.plugin.stateManager.getSettings().storeDisplayName;
          new Notice(`New store "${newStoreName}" created and set as current`);

          // Trigger index rebuild if this is a runner
          if (Platform.isDesktopApp && this.plugin.runnerManager?.isRunner()) {
            await this.plugin.rebuildIndex();
          }
        } catch (err) {
          console.error("[EzRAG] Failed to create new store:", err);
          new Notice("Failed to create new store. See console for details.");
        }
      } else {
        new Notice(`Store "${storeName}" deleted successfully`);
      }

      // Refresh table
      this.storeData = null;
      await this.renderStoreTable();
    } catch (err) {
      console.error("[EzRAG] Failed to delete store:", err);
      new Notice(
        `Failed to delete store "${storeName}". See console for details.`,
      );
    }
  }

  /**
   * Handle setting a store as current
   */
  private async handleSetCurrentStore(
    storeId: string,
    storeName: string,
  ): Promise<void> {
    const currentStoreName =
      this.plugin.stateManager.getSettings().storeDisplayName;

    const confirmed = await this.plugin.confirmAction(
      "Change Current Store",
      `Set "${storeName}" as your current store?\n\n` +
        (currentStoreName
          ? `This will replace "${currentStoreName}" as your current store. Your local index will be cleared and rebuilt from this store.`
          : `This will set "${storeName}" as your current store and rebuild your local index.`),
    );

    if (!confirmed) return;

    try {
      // Update settings
      this.plugin.stateManager.updateSettings({
        storeName: storeId,
        storeDisplayName: storeName,
      });

      // Clear and rebuild index
      this.plugin.stateManager.clearIndex();
      await this.plugin.saveState();

      new Notice(
        `Current store set to "${storeName}". Rebuilding local index...`,
      );

      // Trigger index rebuild if this is a runner
      if (Platform.isDesktopApp && this.plugin.runnerManager?.isRunner()) {
        await this.plugin.rebuildIndex();
      }

      // Refresh table to update star icons
      this.storeData = null;
      await this.renderStoreTable();
    } catch (err) {
      console.error("[EzRAG] Failed to set current store:", err);
      new Notice(`Failed to set current store. See console for details.`);
    }
  }

  /**
   * Format bytes to human-readable size
   */
  private formatBytes(bytes: number): string {
    if (bytes === 0) return "0 B";

    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
