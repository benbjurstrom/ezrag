import { EventEmitter } from 'node:events';

export const Platform = {
  isDesktopApp: true,
};

export function setIcon(element: HTMLElement, icon: string): void {
  element.setAttribute('data-icon', icon);
}

export class Events {
  private emitter = new EventEmitter();

  on(name: string, callback: (...args: any[]) => unknown, ctx?: unknown): this {
    const bound = ctx ? callback.bind(ctx) : callback;
    this.emitter.on(name, bound);
    return this;
  }

  off(name: string, callback: (...args: any[]) => unknown): this {
    this.emitter.off(name, callback);
    return this;
  }

  trigger(name: string, ...args: any[]): void {
    this.emitter.emit(name, ...args);
  }
}

export class TAbstractFile extends Events {
  constructor(public path: string) {
    super();
  }
}

export class TFile extends TAbstractFile {
  public extension: string;
  public stat: { mtime: number };

  constructor(path: string, extension: string = 'md', mtime: number = Date.now()) {
    super(path);
    this.extension = extension;
    this.stat = { mtime };
  }
}

export class MetadataCache {
  private cache = new Map<string, any>();

  getFileCache(file: TFile): any {
    return this.cache.get(file.path);
  }

  setFileCache(file: TFile, cache: any): void {
    this.cache.set(file.path, cache);
  }
}

export class App {
  metadataCache: MetadataCache;

  constructor(metadataCache?: MetadataCache) {
    this.metadataCache = metadataCache ?? new MetadataCache();
  }
}

export class PluginSettingTab {
  app: App;
  plugin: any;
  containerEl: HTMLElement;

  constructor(app: App, plugin: any) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = document.createElement('div');
  }

  display(): void {}
}

export class Modal {
  app: App;
  contentEl: HTMLElement;

  constructor(app: App) {
    this.app = app;
    this.contentEl = document.createElement('div');
  }

  open(): void {
    if (typeof (this as any).onOpen === 'function') {
      (this as any).onOpen();
    }
  }

  close(): void {
    if (typeof (this as any).onClose === 'function') {
      (this as any).onClose();
    }
  }
}

class ButtonComponent {
  constructor(private el: HTMLButtonElement) {}

  setButtonText(text: string): this {
    this.el.textContent = text;
    return this;
  }

  setDisabled(disabled: boolean): this {
    this.el.disabled = disabled;
    return this;
  }

  onClick(callback: () => void): this {
    this.el.addEventListener('click', callback);
    return this;
  }
}

class ToggleComponent {
  constructor(private el: HTMLInputElement) {
    this.el.type = 'checkbox';
  }

  setValue(value: boolean): this {
    this.el.checked = value;
    return this;
  }

  onChange(callback: (value: boolean) => void): this {
    this.el.addEventListener('change', () => callback(this.el.checked));
    return this;
  }
}

class TextComponent {
  constructor(private el: HTMLInputElement) {
    this.el.type = 'text';
  }

  setPlaceholder(value: string): this {
    this.el.placeholder = value;
    return this;
  }

  setValue(value: string): this {
    this.el.value = value;
    return this;
  }

  onChange(callback: (value: string) => void): this {
    this.el.addEventListener('input', () => callback(this.el.value));
    return this;
  }
}

class SliderComponent {
  constructor(private el: HTMLInputElement) {
    this.el.type = 'range';
  }

  setLimits(min: number, max: number, step: number): this {
    this.el.min = String(min);
    this.el.max = String(max);
    this.el.step = String(step);
    return this;
  }

  setValue(value: number): this {
    this.el.value = String(value);
    return this;
  }

  setDynamicTooltip(): this {
    return this;
  }

  onChange(callback: (value: number) => void): this {
    this.el.addEventListener('change', () => callback(Number(this.el.value)));
    return this;
  }
}

export class Setting {
  settingEl: HTMLElement;
  private infoEl: HTMLElement;
  private controlEl: HTMLElement;
  private nameEl: HTMLElement | null = null;
  private descEl: HTMLElement | null = null;

  constructor(containerEl: HTMLElement) {
    this.settingEl = containerEl.createDiv({ cls: 'setting-item' });
    this.infoEl = this.settingEl.createDiv({ cls: 'setting-item-info' });
    this.controlEl = this.settingEl.createDiv({ cls: 'setting-item-control' });
  }

  setName(name: string): this {
    if (!this.nameEl) {
      this.nameEl = this.infoEl.createEl('div', { cls: 'setting-item-name' });
    }
    this.nameEl.textContent = name;
    return this;
  }

  setDesc(description: string): this {
    if (!this.descEl) {
      this.descEl = this.infoEl.createEl('div', { cls: 'setting-item-description' });
    }
    this.descEl.textContent = description;
    return this;
  }

  setHeading(): this {
    this.settingEl.classList.add('is-heading');
    return this;
  }

  addButton(callback: (button: ButtonComponent) => void): this {
    const buttonEl = document.createElement('button');
    this.controlEl.appendChild(buttonEl);
    callback(new ButtonComponent(buttonEl));
    return this;
  }

  addToggle(callback: (toggle: ToggleComponent) => void): this {
    const input = document.createElement('input');
    this.controlEl.appendChild(input);
    callback(new ToggleComponent(input));
    return this;
  }

  addText(callback: (text: TextComponent) => void): this {
    const input = document.createElement('input');
    this.controlEl.appendChild(input);
    callback(new TextComponent(input));
    return this;
  }

  addSlider(callback: (slider: SliderComponent) => void): this {
    const input = document.createElement('input');
    this.controlEl.appendChild(input);
    callback(new SliderComponent(input));
    return this;
  }
}

interface StoredFile {
  file: TFile;
  content: string;
}

export class Vault extends Events {
  private files = new Map<string, StoredFile>();

  constructor(initialFiles: Record<string, string> = {}) {
    super();
    for (const [path, content] of Object.entries(initialFiles)) {
      this.createMarkdownFile(path, content);
    }
  }

  createMarkdownFile(path: string, content: string): TFile {
    const extension = path.includes('.') ? path.split('.').pop() || 'md' : 'md';
    const file = new TFile(path, extension);
    this.files.set(path, { file, content });
    return file;
  }

  setFileContent(path: string, content: string): void {
    const stored = this.files.get(path);
    if (!stored) {
      this.createMarkdownFile(path, content);
      return;
    }
    stored.content = content;
    stored.file.stat.mtime = Date.now();
  }

  async read(file: TFile): Promise<string> {
    const stored = this.files.get(file.path);
    if (!stored) {
      throw new Error(`File not found: ${file.path}`);
    }
    return stored.content;
  }

  getMarkdownFiles(): TFile[] {
    return [...this.files.values()].map(value => value.file).filter(file => file.extension === 'md');
  }

  getAbstractFileByPath(path: string): TAbstractFile | null {
    return this.files.get(path)?.file ?? null;
  }
}

export class Notice {
  constructor(public message: string) {}
}

export class Workspace extends Events {}

export class Plugin extends Events {
  app: App;
  constructor(app: App) {
    super();
    this.app = app;
  }
}
