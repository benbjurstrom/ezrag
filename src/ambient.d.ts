declare module '@google/genai' {
  export class GoogleGenAI {
    constructor(config: Record<string, unknown>);
    files: any;
    models: any;
    operations?: any;
    fileSearchStores: any;
  }
}

declare module 'p-queue' {
  export default class PQueue {
    constructor(options?: { concurrency?: number });
    add<T>(fn: () => Promise<T>): Promise<T>;
    pause(): void;
    start(): void;
    clear(): void;
    onIdle(): Promise<void>;
    readonly isPaused: boolean;
  }
}
