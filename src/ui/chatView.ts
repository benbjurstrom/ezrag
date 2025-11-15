// src/ui/chatView.ts - Chat interface inspired by the sample React project

import { App, ItemView, Notice, WorkspaceLeaf, Modal } from 'obsidian';
import type EzRAGPlugin from '../../main';
import { ChatMessage, ChatModel, GroundingChunk } from '../types';

export const CHAT_VIEW_TYPE = 'ezrag-chat-view';

class SourceModal extends Modal {
  constructor(app: App, private html: string) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass('ezrag-source-modal');
    this.contentEl.empty();

    const container = this.contentEl.createDiv('ezrag-source-modal__container');
    container.createEl('h3', { text: 'Source excerpt' });
    const body = container.createDiv('ezrag-source-modal__body');
    body.innerHTML = this.html;

    const footer = container.createDiv('ezrag-source-modal__footer');
    const closeBtn = footer.createEl('button', {
      text: 'Close',
      cls: 'ezrag-chat-button',
    });
    closeBtn.addEventListener('click', () => this.close());
  }
}

export class ChatView extends ItemView {
  private readonly plugin: EzRAGPlugin;
  private messages: ChatMessage[] = [];
  private isLoading = false;
  private headerTitleEl!: HTMLElement;
  private headerStatusEl!: HTMLElement;
  private historyEl!: HTMLElement;
  private inputEl!: HTMLInputElement;
  private sendButton!: HTMLButtonElement;
  private model: ChatModel = 'gemini-2.5-flash';
  private modelButtons: Partial<Record<ChatModel, HTMLButtonElement>> = {};

  constructor(leaf: WorkspaceLeaf, plugin: EzRAGPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return CHAT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'EzRAG Chat';
  }

  getIcon(): string {
    return 'message-square';
  }

  async onOpen(): Promise<void> {
    this.buildLayout();
    this.updateHeader();
    this.renderMessages();
  }

  async onClose(): Promise<void> {}

  private buildLayout(): void {
    this.contentEl.empty();
    this.contentEl.addClass('ezrag-chat-view');

    const header = this.contentEl.createDiv('ezrag-chat-header');
    const titleWrapper = header.createDiv('ezrag-chat-header__titles');
    this.headerTitleEl = titleWrapper.createEl('h2', { text: 'EzRAG Chat' });
    this.headerStatusEl = titleWrapper.createEl('p', {
      cls: 'ezrag-chat-header__status',
      text: '',
    });

    const controls = header.createDiv('ezrag-chat-header__controls');

    const modelToggle = controls.createDiv('ezrag-chat-model-toggle');
    modelToggle.createEl('span', { text: 'Model' });
    const flashButton = modelToggle.createEl('button', {
      text: 'Gemini 2.5 Flash',
      cls: 'ezrag-chat-model-button',
    }) as HTMLButtonElement;
    const proButton = modelToggle.createEl('button', {
      text: 'Gemini 2.5 Pro',
      cls: 'ezrag-chat-model-button',
    }) as HTMLButtonElement;
    this.modelButtons = {
      'gemini-2.5-flash': flashButton,
      'gemini-2.5-pro': proButton,
    };
    flashButton.addEventListener('click', () => this.setModel('gemini-2.5-flash'));
    proButton.addEventListener('click', () => this.setModel('gemini-2.5-pro'));

    const newChatButton = controls.createEl('button', {
      text: 'New chat',
      cls: 'ezrag-chat-button',
    });
    newChatButton.addEventListener('click', () => {
      this.resetChat();
    });
    this.updateModelButtons();

    this.historyEl = this.contentEl.createDiv('ezrag-chat-history');

    const footer = this.contentEl.createDiv('ezrag-chat-footer');
    const inputRow = footer.createDiv('ezrag-chat-input-row');
    this.inputEl = inputRow.createEl('input', {
      type: 'text',
      placeholder: 'Ask something about your notes…',
      cls: 'ezrag-chat-input',
    }) as HTMLInputElement;
    this.inputEl.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        this.handleSubmit();
      }
    });

    this.sendButton = inputRow.createEl('button', {
      text: 'Send',
      cls: 'ezrag-chat-send',
    }) as HTMLButtonElement;
    this.sendButton.addEventListener('click', () => this.handleSubmit());
  }

  private getReadiness(): { ready: boolean; message?: string } {
    const settings = this.plugin.stateManager.getSettings();
    if (!settings.apiKey) {
      return { ready: false, message: 'Add your Gemini API key in the EzRAG settings tab.' };
    }
    if (!settings.storeName) {
      return {
        ready: false,
        message: 'Your vault has not been indexed yet. Enable a desktop runner to build the index.',
      };
    }
    return { ready: true };
  }

  private setModel(next: ChatModel): void {
    if (this.model === next) return;
    this.model = next;
    this.updateModelButtons();
  }

  private updateModelButtons(): void {
    (Object.keys(this.modelButtons) as ChatModel[]).forEach((key) => {
      const button = this.modelButtons[key];
      if (!button) return;
      if (key === this.model) {
        button.addClass('is-active');
      } else {
        button.removeClass('is-active');
      }
    });
  }

  private updateHeader(): void {
    const settings = this.plugin.stateManager.getSettings();
    const displayName = settings.storeDisplayName || this.app.vault.getName();
    this.headerTitleEl.setText(`Chat with ${displayName}`);

    const readiness = this.getReadiness();
    if (readiness.ready) {
      this.headerStatusEl.setText('Connected to Gemini File Search');
      this.contentEl.removeClass('ezrag-chat-view--disabled');
      this.inputEl.disabled = this.isLoading;
      this.sendButton.disabled = this.isLoading;
    } else {
      this.headerStatusEl.setText(readiness.message ?? '');
      this.contentEl.addClass('ezrag-chat-view--disabled');
      this.inputEl.disabled = true;
      this.sendButton.disabled = true;
    }
  }

  private renderMessages(): void {
    this.historyEl.empty();
    const readiness = this.getReadiness();

    if (!readiness.ready) {
      const empty = this.historyEl.createDiv({ cls: 'ezrag-chat-empty' });
      empty.setText(readiness.message ?? 'Chat is not available yet.');
      return;
    }

    if (this.messages.length === 0 && !this.isLoading) {
      const empty = this.historyEl.createDiv({ cls: 'ezrag-chat-empty' });
      empty.setText('Ask a question about any indexed note to get started.');
    }

    for (const message of this.messages) {
      this.historyEl.appendChild(this.renderMessageBubble(message));
    }

    if (this.isLoading) {
      const typing = this.historyEl.createDiv('ezrag-chat-bubble ezrag-chat-bubble--model');
      typing.createDiv('ezrag-chat-spinner');
    }

    this.historyEl.scrollTop = this.historyEl.scrollHeight;
  }

  private renderMessageBubble(message: ChatMessage): HTMLElement {
    const bubble = document.createElement('div');
    bubble.addClass('ezrag-chat-bubble');
    bubble.addClass(message.role === 'user' ? 'ezrag-chat-bubble--user' : 'ezrag-chat-bubble--model');

    const body = bubble.createDiv('ezrag-chat-message');
    body.innerHTML = this.renderMarkdown(message.text);

    if (message.role === 'model' && message.groundingChunks && message.groundingChunks.length > 0) {
      const footer = bubble.createDiv('ezrag-chat-sources');
      footer.createEl('span', { text: 'Sources:' });
      message.groundingChunks.forEach((chunk: GroundingChunk, index: number) => {
        const text = chunk?.retrievedContext?.text;
        if (!text) return;
        const btn = footer.createEl('button', {
          text: `Source ${index + 1}`,
          cls: 'ezrag-chat-source-button',
        });
        btn.addEventListener('click', () => {
          const html = this.renderMarkdown(text);
          new SourceModal(this.app, html).open();
        });
      });
    }

    return bubble;
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
      const unordered = line.match(/^\s*[\*\-]\s(.*)/);

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
    void this.sendMessage(value);
  }

  private async sendMessage(prompt: string): Promise<void> {
    const readiness = this.getReadiness();
    if (!readiness.ready) {
      new Notice(readiness.message ?? 'Chat is not ready yet.');
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
