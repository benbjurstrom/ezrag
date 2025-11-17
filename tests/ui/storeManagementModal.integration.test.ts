import { beforeEach, describe, expect, it, vi } from "vitest";
import { StoreManagementModal } from "../../src/ui/storeManagementModal";
import { App, Platform } from "obsidian";
import { StateManager } from "../../src/state/state";
import {
  DEFAULT_SETTINGS,
  IndexedDocState,
  IndexQueueEntry,
} from "../../src/types";

interface ModalOptions {
  apiKey?: string;
  docs?: Record<string, IndexedDocState>;
  queue?: IndexQueueEntry[];
  pluginOverrides?: Record<string, any>;
}

function createModal(options: ModalOptions = {}) {
  const stateManager = new StateManager({
    settings: {
      ...DEFAULT_SETTINGS,
      apiKey: options.apiKey ?? "key",
      storeName: "stores/current",
      storeDisplayName: "Current",
    },
    index: {
      docs: options.docs ?? {},
      queue: options.queue ?? [],
    },
  });

  const plugin = {
    stateManager,
    confirmAction: vi.fn().mockResolvedValue(true),
    rebuildIndex: vi.fn().mockResolvedValue(undefined),
    saveState: vi.fn().mockResolvedValue(undefined),
    ensureGeminiResources: vi.fn().mockResolvedValue(undefined),
    runnerManager: { isRunner: () => true },
    ...options.pluginOverrides,
  };

  const modal = new StoreManagementModal(new App() as any, plugin as any);
  return { modal, plugin, stateManager };
}

function createStore(id: string, name: string) {
  const now = new Date().toISOString();
  return {
    name: id,
    displayName: name,
    createTime: now,
    updateTime: now,
    activeDocumentsCount: 2,
    pendingDocumentsCount: 1,
    failedDocumentsCount: 0,
    sizeBytes: 512,
  };
}

beforeEach(() => {
  Platform.isDesktopApp = true;
});

describe("StoreManagementModal rendering", () => {
  it("shows empty message when no stores exist", async () => {
    const { modal } = createModal();
    const container = document.createElement("div");
    (modal as any).tableContainer = container;
    vi.spyOn(modal as any, "fetchStoreData").mockResolvedValue([]);

    await (modal as any).renderStoreTable();

    expect(container.textContent).toContain("No stores found");
  });

  it("renders table rows with action buttons", async () => {
    const { modal } = createModal();
    const container = document.createElement("div");
    (modal as any).tableContainer = container;

    const stores = [
      createStore("stores/current", "Current"),
      createStore("stores/alt", "Alt"),
    ];
    const setSpy = vi
      .spyOn(modal as any, "handleSetCurrentStore")
      .mockResolvedValue(undefined);
    const deleteSpy = vi
      .spyOn(modal as any, "handleDeleteStore")
      .mockResolvedValue(undefined);
    vi.spyOn(modal as any, "fetchStoreData").mockResolvedValue(stores);

    await (modal as any).renderStoreTable();

    const rows = container.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(2);

    const actionButtons = rows[1].querySelectorAll("button");
    expect(actionButtons).toHaveLength(2);

    actionButtons[0].dispatchEvent(new Event("click"));
    actionButtons[1].dispatchEvent(new Event("click"));

    expect(setSpy).toHaveBeenCalledWith("stores/alt", "Alt");
    expect(deleteSpy).toHaveBeenCalledWith("stores/alt", "Alt", false);
  });
});

describe("StoreManagementModal actions", () => {
  it("clears state and rebuilds when setting a new current store", async () => {
    const docs: Record<string, IndexedDocState> = {
      "Note.md": {
        vaultPath: "Note.md",
        geminiDocumentName: "docs/1",
        contentHash: "hash",
        pathHash: "path",
        status: "ready",
        lastLocalMtime: Date.now(),
        lastIndexedAt: Date.now(),
        tags: [],
      },
    };
    const queue: IndexQueueEntry[] = [
      {
        id: "1",
        vaultPath: "Note.md",
        operation: "upload",
        enqueuedAt: Date.now(),
        attempts: 0,
      },
    ];
    const { modal, plugin, stateManager } = createModal({ docs, queue });
    vi.spyOn(modal as any, "renderStoreTable").mockResolvedValue(undefined);

    await (modal as any).handleSetCurrentStore("stores/alt", "Alt");

    expect(plugin.confirmAction).toHaveBeenCalled();
    expect(stateManager.getSettings().storeName).toBe("stores/alt");
    expect(Object.keys(stateManager.getAllDocStates())).toHaveLength(0);
    expect(stateManager.getQueueEntries()).toHaveLength(0);
    expect(plugin.saveState).toHaveBeenCalled();
    expect(plugin.rebuildIndex).toHaveBeenCalled();
  });

  it("deletes a non-current store after confirmation", async () => {
    const deleteStore = vi.fn().mockResolvedValue(undefined);
    const storeManager = {
      getOrCreateGeminiService: vi.fn().mockReturnValue({ deleteStore }),
    };
    const { modal, plugin } = createModal({
      pluginOverrides: { storeManager },
    });
    vi.spyOn(modal as any, "renderStoreTable").mockResolvedValue(undefined);

    await (modal as any).handleDeleteStore("stores/alt", "Alt", false);

    expect(plugin.confirmAction).toHaveBeenCalled();
    expect(deleteStore).toHaveBeenCalledWith("stores/alt");
  });
});
