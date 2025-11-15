// src/ui/chatView.ts - Mobile-first chat interface using Obsidian design system

import { App, ItemView, Notice, WorkspaceLeaf, Modal, setIcon } from 'obsidian';
import type EzRAGPlugin from '../../main';
import { ChatMessage, ChatModel, GroundingChunk } from '../types';

export const CHAT_VIEW_TYPE = 'ezrag-chat-view';

class SourceModal extends Modal {
  constructor(app: App, private source: { text: string; index: number; title?: string; uri?: string }) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    // Use standard modal structure
    const header = contentEl.createEl('h3', { text: `Source ${this.source.index}` });

    // Display title and uri if available
    if (this.source.title || this.source.uri) {
      const metadata = contentEl.createDiv('source-metadata');
      metadata.style.marginBottom = '1em';
      metadata.style.fontSize = '0.9em';
      metadata.style.color = 'var(--text-muted)';

      if (this.source.title) {
        const titleEl = metadata.createDiv();
        titleEl.createEl('strong', { text: 'Title: ' });
        titleEl.createSpan({ text: this.source.title });
      }

      if (this.source.uri) {
        const uriEl = metadata.createDiv();
        uriEl.createEl('strong', { text: 'URI: ' });
        uriEl.createSpan({ text: this.source.uri });
      }
    }

    const sourceContent = contentEl.createDiv('modal-content');
    sourceContent.innerHTML = this.renderMarkdown(this.source.text);

    // Use standard button container
    const buttonContainer = contentEl.createDiv('modal-button-container');
    const closeBtn = buttonContainer.createEl('button', {
      text: 'Close',
      cls: 'mod-cta'
    });
    closeBtn.addEventListener('click', () => this.close());
  }

  private renderMarkdown(text: string): string {
    if (!text) return '';
    const escaped = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    const lines = escaped.split('\n');
    let html = '';
    let listType: 'ul' | 'ol' | null = null;
    let paragraph = '';

    const flushParagraph = () => {
      if (paragraph) {
        html += `<p>${paragraph}</p>`;
        paragraph = '';
      }
    };

    const flushList = () => {
      if (listType) {
        html += `</${listType}>`;
        listType = null;
      }
    };

    for (const raw of lines) {
      const line = raw
        .replace(/\*\*(.*?)\*\*|__(.*?)__/g, '<strong>$1$2</strong>')
        .replace(/\*(.*?)\*|_(.*?)_/g, '<em>$1$2</em>')
        .replace(/`([^`]+)`/g, '<code>$1</code>');

      const ordered = line.match(/^\s*\d+\.\s(.*)/);
      const unordered = line.match(/^\s*[*-]\s(.*)/);

      if (ordered) {
        flushParagraph();
        if (listType !== 'ol') {
          flushList();
          html += '<ol>';
          listType = 'ol';
        }
        html += `<li>${ordered[1]}</li>`;
        continue;
      }

      if (unordered) {
        flushParagraph();
        if (listType !== 'ul') {
          flushList();
          html += '<ul>';
          listType = 'ul';
        }
        html += `<li>${unordered[1]}</li>`;
        continue;
      }

      flushList();
      if (line.trim().length === 0) {
        flushParagraph();
      } else {
        paragraph += `${paragraph ? '<br/>' : ''}${line}`;
      }
    }

    flushParagraph();
    flushList();
    return html;
  }
}

export class ChatView extends ItemView {
  private readonly plugin: EzRAGPlugin;
  private messages: ChatMessage[] = [];
  private isLoading = false;
  private headerEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private historyEl!: HTMLElement;
  private inputContainer!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendButton!: HTMLButtonElement;
  private model: ChatModel = 'gemini-2.5-flash';
  private modelSwitcher!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, plugin: EzRAGPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return CHAT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Chat';
  }

  getIcon(): string {
    return 'message-square';
  }

  async onOpen(): Promise<void> {
    this.buildLayout();
    this.updateHeader();
    this.renderMessages();
  }

  async onClose(): Promise<void> {
    // Cleanup if needed
  }

  private buildLayout(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('ezrag-chat-view');

    // Header section with vault name and status
    this.headerEl = contentEl.createDiv('ezrag-chat-header');
    this.headerEl.createEl('div', { cls: 'ezrag-chat-title' });
    this.statusEl = this.headerEl.createEl('div', { cls: 'ezrag-chat-status' });

    // Action bar with model switcher and new chat
    const actionBar = contentEl.createDiv('ezrag-chat-actions');

    // Model switcher (compact for mobile)
    this.modelSwitcher = actionBar.createDiv('ezrag-chat-model-switcher');
    this.buildModelSwitcher();

    // New chat button
    const newChatBtn = actionBar.createEl('button', {
      cls: 'ezrag-new-chat-btn',
      attr: { 'aria-label': 'New chat' }
    });
    setIcon(newChatBtn, 'file-plus');
    newChatBtn.addEventListener('click', () => this.resetChat());

    // Messages area (scrollable)
    this.historyEl = contentEl.createDiv('ezrag-chat-messages');

    // Input area (fixed at bottom)
    this.inputContainer = contentEl.createDiv('ezrag-chat-input-container');

    // Textarea for multi-line input
    this.inputEl = this.inputContainer.createEl('textarea', {
      cls: 'ezrag-chat-input',
      attr: {
        placeholder: 'Ask about your notes...',
        rows: '1'
      }
    }) as HTMLTextAreaElement;

    // Auto-resize textarea as user types
    this.inputEl.addEventListener('input', () => {
      this.inputEl.style.height = 'auto';
      this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 120) + 'px';
    });

    this.inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.handleSubmit();
      }
    });

    // Send button
    this.sendButton = this.inputContainer.createEl('button', {
      cls: 'ezrag-chat-send',
      attr: { 'aria-label': 'Send message' }
    });
    setIcon(this.sendButton, 'send');
    this.sendButton.addEventListener('click', () => this.handleSubmit());
  }

  private buildModelSwitcher(): void {
    this.modelSwitcher.empty();

    const select = this.modelSwitcher.createEl('select', {
      cls: 'dropdown'
    }) as HTMLSelectElement;

    select.createEl('option', {
      value: 'gemini-2.5-flash',
      text: 'gemini-2.5-flash'
    });

    select.createEl('option', {
      value: 'gemini-2.5-pro',
      text: 'gemini-2.5-pro'
    });

    select.value = this.model;
    select.addEventListener('change', () => {
      this.model = select.value as ChatModel;
    });
  }

  private getReadiness(): { ready: boolean; message?: string } {
    const settings = this.plugin.stateManager.getSettings();
    if (!settings.apiKey) {
      return {
        ready: false,
        message: 'Add your Gemini API key in settings to start chatting.'
      };
    }
    const connectionState = this.plugin.getConnectionState();
    if (!connectionState.connected) {
      const message = connectionState.online
        ? (connectionState.apiKeyError ?? 'Validate your API key in settings to enable chat.')
        : 'Connect to the internet to use chat.';
      return {
        ready: false,
        message,
      };
    }
    if (!settings.storeName) {
      return {
        ready: false,
        message: 'Enable indexing on a desktop device to start chatting.',
      };
    }
    return { ready: true };
  }

  private updateHeader(): void {
    const settings = this.plugin.stateManager.getSettings();
    const vaultName = settings.storeDisplayName || this.app.vault.getName();

    this.headerEl.querySelector('.ezrag-chat-title')?.setText(`Chat with ${vaultName}`);

    const readiness = this.getReadiness();
    if (readiness.ready) {
      this.statusEl.setText('Connected');
      this.statusEl.removeClass('is-disabled');
      this.inputEl.disabled = this.isLoading;
      this.sendButton.disabled = this.isLoading;
    } else {
      this.statusEl.setText('Unavailable');
      this.statusEl.addClass('is-disabled');
      this.inputEl.disabled = true;
      this.sendButton.disabled = true;
    }
  }

  private renderMessages(): void {
    this.historyEl.empty();
    const readiness = this.getReadiness();

    if (!readiness.ready) {
      const emptyState = this.historyEl.createDiv('ezrag-empty-state');
      const icon = emptyState.createDiv('ezrag-empty-icon');
      setIcon(icon, 'message-square');
      emptyState.createEl('p', { text: readiness.message });
      return;
    }

    if (this.messages.length === 0 && !this.isLoading) {
      const emptyState = this.historyEl.createDiv('ezrag-empty-state');
      const icon = emptyState.createDiv('ezrag-empty-icon');
      setIcon(icon, 'sparkles');
      emptyState.createEl('p', { text: 'Ask a question about your notes to get started.' });
      return;
    }

    for (const message of this.messages) {
      this.historyEl.appendChild(this.renderMessageBubble(message));
    }

    if (this.isLoading) {
      const loadingBubble = this.historyEl.createDiv('ezrag-message-row is-assistant');
      const bubble = loadingBubble.createDiv('ezrag-message-bubble');
      const spinner = bubble.createDiv('ezrag-loading');
      spinner.createDiv('ezrag-loading-dot');
      spinner.createDiv('ezrag-loading-dot');
      spinner.createDiv('ezrag-loading-dot');
    }

    // Scroll to bottom
    this.historyEl.scrollTop = this.historyEl.scrollHeight;
  }

  private renderMessageBubble(message: ChatMessage): HTMLElement {
    const row = document.createElement('div');
    row.addClass('ezrag-message-row');
    row.addClass(message.role === 'user' ? 'is-user' : 'is-assistant');

    const bubble = row.createDiv('ezrag-message-bubble');
    const content = bubble.createDiv('ezrag-message-content');
    content.innerHTML = this.renderMarkdown(message.text);

    // Sources (for assistant messages only)
    if (message.role === 'model' && message.groundingChunks && message.groundingChunks.length > 0) {
      const sources = bubble.createDiv('ezrag-message-sources');

      message.groundingChunks.forEach((chunk: GroundingChunk, index: number) => {
        const text = chunk?.retrievedContext?.text;
        if (!text) return;

        const title = chunk?.retrievedContext?.title;
        const uri = chunk?.retrievedContext?.uri;

        const sourceBtn = sources.createEl('button', {
          cls: 'ezrag-source-chip',
          text: `${index + 1}`
        });

        // Show title in tooltip if available
        if (title) {
          sourceBtn.setAttribute('aria-label', title);
          sourceBtn.setAttribute('title', title);
        }

        sourceBtn.addEventListener('click', () => {
          new SourceModal(this.app, { text, index: index + 1, title, uri }).open();
        });
      });
    }

    return row;
  }

  private renderMarkdown(text: string): string {
    if (!text) return '';
    const escaped = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    const lines = escaped.split('\n');
    let html = '';
    let listType: 'ul' | 'ol' | null = null;
    let paragraph = '';

    const flushParagraph = () => {
      if (paragraph) {
        html += `<p>${paragraph}</p>`;
        paragraph = '';
      }
    };

    const flushList = () => {
      if (listType) {
        html += `</${listType}>`;
        listType = null;
      }
    };

    for (const raw of lines) {
      const line = raw
        .replace(/\*\*(.*?)\*\*|__(.*?)__/g, '<strong>$1$2</strong>')
        .replace(/\*(.*?)\*|_(.*?)_/g, '<em>$1$2</em>')
        .replace(/`([^`]+)`/g, '<code>$1</code>');

      const ordered = line.match(/^\s*\d+\.\s(.*)/);
      const unordered = line.match(/^\s*[*-]\s(.*)/);

      if (ordered) {
        flushParagraph();
        if (listType !== 'ol') {
          flushList();
          html += '<ol>';
          listType = 'ol';
        }
        html += `<li>${ordered[1]}</li>`;
        continue;
      }

      if (unordered) {
        flushParagraph();
        if (listType !== 'ul') {
          flushList();
          html += '<ul>';
          listType = 'ul';
        }
        html += `<li>${unordered[1]}</li>`;
        continue;
      }

      flushList();
      if (line.trim().length === 0) {
        flushParagraph();
      } else {
        paragraph += `${paragraph ? '<br/>' : ''}${line}`;
      }
    }

    flushParagraph();
    flushList();
    return html;
  }

  private handleSubmit(): void {
    const value = this.inputEl.value.trim();
    if (!value || this.isLoading) {
      return;
    }
    this.inputEl.value = '';
    this.inputEl.style.height = 'auto';
    void this.sendMessage(value);
  }

  private async sendMessage(prompt: string): Promise<void> {
    const readiness = this.getReadiness();
    if (!readiness.ready) {
      new Notice(readiness.message ?? 'Chat is not ready yet.');
      return;
    }

    if (!this.plugin.isConnected()) {
      new Notice('Gemini is offline. Check your connection and API key.');
      return;
    }

    const service = this.plugin.getGeminiService();
    const settings = this.plugin.stateManager.getSettings();
    if (!service || !settings.storeName) {
      new Notice('Gemini is not configured yet.');
      return;
    }

    this.messages.push({ role: 'user', text: prompt });
    this.isLoading = true;
    this.updateHeader();
    this.renderMessages();

    try {
      const result = await service.fileSearch(settings.storeName, prompt, this.model);
      this.messages.push({
        role: 'model',
        text: result.text || 'No response returned.',
        groundingChunks: result.groundingChunks || [],
      });
    } catch (err) {
      console.error('[EzRAG] Chat query failed', err);
      new Notice('Failed to run the query. Check the console for details.');
      this.messages.push({
        role: 'model',
        text: 'Sorry, something went wrong while running that query.',
      });
    } finally {
      this.isLoading = false;
      this.updateHeader();
      this.renderMessages();
    }
  }

  private resetChat(): void {
    this.messages = [];
    this.isLoading = false;
    this.renderMessages();
    this.updateHeader();
  }
}
