// src/ui/settingsTab.ts - Settings UI

import { App, Platform, PluginSettingTab, Setting, Notice } from "obsidian";
import type EzRAGPlugin from "../../main";
import { StoreManagementModal } from "./storeManagementModal";

export class EzRAGSettingTab extends PluginSettingTab {
  plugin: EzRAGPlugin;

  constructor(app: App, plugin: EzRAGPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  async display(): Promise<void> {
    const { containerEl } = this;
    containerEl.empty();

    // Determine if we're on desktop and if this is the runner
    const isDesktop = Platform.isDesktopApp;
    const isRunner = isDesktop && this.plugin.runnerManager?.isRunner();

    if (!isDesktop) {
      // Mobile platform - show info message
      new Setting(containerEl).setName("Mobile Platform").setHeading();
      containerEl.createDiv({
        cls: "setting-item-description",
        text:
          "Indexing is not available on mobile devices. The runner can only be enabled on desktop. " +
          "You can still configure your API key and use chat/query features once they are implemented.",
      });
    }

    // API Key Section (ALWAYS VISIBLE ON ALL PLATFORMS)
    new Setting(containerEl).setName("Gemini Configuration").setHeading();

    const connectionState = this.plugin.getConnectionState();

    new Setting(containerEl)
      .setName("Gemini API Key")
      .setDesc("Your Google Gemini API key (get it from ai.google.dev)")
      .addText((text) =>
        text
          .setPlaceholder("Enter your API key")
          .setValue(this.plugin.stateManager.getSettings().apiKey)
          .onChange(async (value) => {
            const message = await this.plugin.updateApiKey(value);
            if (message) {
              new Notice(message);
            }
          }),
      );

    if (connectionState.apiKeyError) {
      containerEl.createDiv({
        cls: "setting-item-description mod-warning",
        text: connectionState.apiKeyError,
      });
    }

    // FileStore Management Button
    const hasApiKey = !!this.plugin.stateManager.getSettings().apiKey;
    new Setting(containerEl)
      .setName("FileSearch Stores")
      .setDesc("Manage your Gemini FileSearch stores")
      .addButton((button) =>
        button
          .setButtonText("Manage Stores")
          .setDisabled(!hasApiKey)
          .onClick(() => {
            new StoreManagementModal(this.app, this.plugin).open();
          }),
      );

    // MCP Server Section (visible on all platforms)
    new Setting(containerEl).setName("MCP Server").setHeading();

    const mcpSettings = this.plugin.stateManager.getSettings().mcpServer;
    const mcpStatus = this.plugin.getMCPServerStatus();

    new Setting(containerEl)
      .setName("Enable MCP server")
      .setDesc(
        "Start an MCP server to allow external tools (like Claude Code) to query your notes",
      )
      .addToggle((toggle) =>
        toggle.setValue(mcpSettings.enabled).onChange(async (value) => {
          await this.plugin.handleMCPServerToggle(value);
          this.display(); // Refresh to show/hide connection info
        }),
      );

    if (mcpSettings.enabled) {
      // Show status
      const statusSetting = new Setting(containerEl)
        .setName("Server status")
        .setDesc(mcpStatus.running ? `Running at ${mcpStatus.url}` : "Stopped");

      if (mcpStatus.running) {
        // Add copy URL button
        statusSetting.addButton((button) =>
          button.setButtonText("Copy URL").onClick(() => {
            navigator.clipboard.writeText(mcpStatus.url);
            new Notice("MCP server URL copied to clipboard");
          }),
        );
      }

      // Port configuration
      new Setting(containerEl)
        .setName("Server port")
        .setDesc(
          "Port for the MCP server (requires restart if server is running)",
        )
        .addText((text) =>
          text
            .setPlaceholder("42427")
            .setValue(String(mcpSettings.port))
            .onChange(async (value) => {
              const port = parseInt(value, 10);
              if (!isNaN(port) && port > 0 && port < 65536) {
                await this.plugin.updateMCPServerPort(port);
                this.display(); // Refresh to show new URL
              } else {
                new Notice("Invalid port number. Must be between 1 and 65535.");
              }
            }),
        );

      // Connection instructions
      containerEl.createDiv({
        cls: "setting-item-description",
        text:
          "Connect using Claude Code: claude mcp add --transport http ezrag-obsidian-notes " +
          mcpStatus.url,
      });
    }

    // Runner Configuration Toggle (Desktop only)
    if (isDesktop && this.plugin.runnerManager) {
      new Setting(containerEl).setName("Document Index").setHeading();

      const runnerManager = this.plugin.runnerManager;
      const runnerState = runnerManager.getState();

      new Setting(containerEl)
        .setName("Use this device as the runner")
        .setDesc(
          "Only one desktop should manage indexing for this vault. Turn this on for exactly one machine.",
        )
        .addToggle((toggle) =>
          toggle.setValue(runnerState.isRunner).onChange(async (value) => {
            await runnerManager.setRunner(value);
            const message = await this.plugin.handleRunnerStateChange();

            this.display();

            if (message) {
              new Notice(message);
            }
          }),
        );

      if (!runnerState.isRunner) {
        containerEl.createDiv({
          cls: "setting-item-description",
          text: "Runner controls will appear below once this is enabled.",
        });
      }
    }

    // Index Status (runner only - below runner config)
    if (isRunner) {
      const indexStatusSetting = new Setting(containerEl)
        .setName("Index Status")
        .setDesc(
          "The index tracks which notes have been uploaded to Gemini for search and retrieval.",
        );

      const controller = this.plugin.indexingController;
      if (controller) {
        indexStatusSetting.addButton((button) => {
          const updateLabel = () => {
            button.setButtonText(controller.isPaused() ? "Resume" : "Pause");
          };
          updateLabel();
          button.onClick(() => {
            if (!controller.isActive()) {
              new Notice("Indexing is not active.");
              return;
            }
            if (controller.isPaused()) {
              controller.resume();
            } else {
              controller.pause();
            }
            updateLabel();
          });
        });
      }

      indexStatusSetting.addButton((button) =>
        button.setButtonText("Open queue").onClick(() => {
          this.plugin.openIndexingStatusModal();
        }),
      );

      if (controller) {
        const controls = new Setting(containerEl)
          .setName("Rescan Notes")
          .setDesc(
            "Scan the vault for new or modified files and queue them for upload.",
          );

        controls.addButton((button) => {
          button.setButtonText("Rescan");
          button.onClick(async () => {
            if (!controller.isActive()) {
              new Notice("Indexing is not active.");
              return;
            }
            button.setDisabled(true);
            try {
              await controller.runFullReconcile();
              new Notice("Vault scan started");
            } catch (err) {
              console.error("[EzRAG] Failed to run full reconcile", err);
              new Notice("Failed to start scan. See console for details.");
            } finally {
              button.setDisabled(false);
            }
          });
        });

        // Rebuild Index
        new Setting(containerEl)
          .setName("Rebuild Index")
          .setDesc(
            "Clear and rebuild the local index from Gemini. Files with matching content are restored without re-upload.",
          )
          .addButton((button) =>
            button.setButtonText("Rebuild").onClick(async () => {
              await this.plugin.rebuildIndex();
            }),
          );

        // Clean Up Remote Index (Manual Janitor)
        new Setting(containerEl)
          .setName("Clean Up Gemini Index")
          .setDesc(
            "Remove outdated document versions and deleted files from Gemini.",
          )
          .addButton((button) =>
            button.setButtonText("Clean Up").onClick(async () => {
              await this.plugin.runJanitorWithUI();
            }),
          );
      }

      // Chunking Configuration Section
      new Setting(containerEl)
        .setName("Document Index Configuration")
        .setHeading();

      // Included Folders
      new Setting(containerEl)
        .setName("Included Folders")
        .setDesc(
          "Comma-separated list of folders to index (empty = entire vault)",
        )
        .addText((text) =>
          text
            .setPlaceholder("e.g., Projects, Notes")
            .setValue(
              this.plugin.stateManager.getSettings().includeFolders.join(", "),
            )
            .onChange(async (value) => {
              const folders = value
                .split(",")
                .map((f) => f.trim())
                .filter(Boolean);
              this.plugin.stateManager.updateSettings({
                includeFolders: folders,
              });
              await this.plugin.saveState();
            }),
        );

      // Concurrency
      new Setting(containerEl)
        .setName("Upload Concurrency")
        .setDesc(
          "Number of concurrent uploads (1-5). Each upload polls until complete.",
        )
        .addSlider((slider) =>
          slider
            .setLimits(1, 5, 1)
            .setValue(
              this.plugin.stateManager.getSettings().maxConcurrentUploads,
            )
            .setDynamicTooltip()
            .onChange(async (value) => {
              this.plugin.stateManager.updateSettings({
                maxConcurrentUploads: value,
              });
              await this.plugin.saveState();
            }),
        );

      new Setting(containerEl)
        .setName("Upload throttle")
        .setDesc(
          "Delay before uploading a modified note (seconds). Helps batch rapid edits into a single upload.",
        )
        .addSlider((slider) => {
          const currentSeconds = Math.floor(
            (this.plugin.stateManager.getSettings().uploadThrottleMs ?? 0) /
              1000,
          );
          slider
            .setLimits(0, 600, 10)
            .setValue(currentSeconds)
            .setDynamicTooltip()
            .onChange(async (value) => {
              this.plugin.stateManager.updateSettings({
                uploadThrottleMs: value * 1000,
              });
              await this.plugin.saveState();
            });
        });

      new Setting(containerEl)
        .setName("Max Tokens Per Chunk")
        .setDesc("Maximum number of tokens in each chunk (100-1000)")
        .addSlider((slider) =>
          slider
            .setLimits(100, 1000, 50)
            .setValue(
              this.plugin.stateManager.getSettings().chunkingConfig
                .maxTokensPerChunk,
            )
            .setDynamicTooltip()
            .onChange(async (value) => {
              const config =
                this.plugin.stateManager.getSettings().chunkingConfig;
              this.plugin.stateManager.updateSettings({
                chunkingConfig: {
                  ...config,
                  maxTokensPerChunk: value,
                },
              });
              await this.plugin.saveState();
            }),
        );

      new Setting(containerEl)
        .setName("Max Overlap Tokens")
        .setDesc("Number of overlapping tokens between chunks (0-200)")
        .addSlider((slider) =>
          slider
            .setLimits(0, 200, 10)
            .setValue(
              this.plugin.stateManager.getSettings().chunkingConfig
                .maxOverlapTokens,
            )
            .setDynamicTooltip()
            .onChange(async (value) => {
              const config =
                this.plugin.stateManager.getSettings().chunkingConfig;
              this.plugin.stateManager.updateSettings({
                chunkingConfig: {
                  ...config,
                  maxOverlapTokens: value,
                },
              });
              await this.plugin.saveState();
            }),
        );
    }
  }
}
