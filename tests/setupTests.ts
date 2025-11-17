import { afterEach, beforeAll, vi } from 'vitest';
import { webcrypto } from 'node:crypto';

function applyDomPolyfills(): void {
  const proto = HTMLElement.prototype as any;

  if (!proto.empty) {
    proto.empty = function (): void {
      while (this.firstChild) {
        this.removeChild(this.firstChild);
      }
    };
  }

  if (!proto.createEl) {
    proto.createEl = function (tag: string, options: any = {}): HTMLElement {
      const element = document.createElement(tag);
      const classes = options.cls;
      if (typeof classes === 'string' && classes.length > 0) {
        element.classList.add(...classes.split(' ').filter(Boolean));
      } else if (Array.isArray(classes)) {
        element.classList.add(...classes);
      }
      if (options.text) {
        element.textContent = options.text;
      }
      if (options.attr) {
        Object.entries(options.attr).forEach(([key, value]) => {
          if (value != null) {
            element.setAttribute(key, String(value));
          }
        });
      }
      this.appendChild(element);
      return element;
    };
  }

  if (!proto.createDiv) {
    proto.createDiv = function (options: any = {}): HTMLElement {
      return this.createEl('div', options);
    };
  }
}

beforeAll(() => {
  if (!globalThis.crypto) {
    // @ts-expect-error - vitest environment
    globalThis.crypto = webcrypto as Crypto;
  }
  applyDomPolyfills();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
