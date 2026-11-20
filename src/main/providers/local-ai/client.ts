import type { LocalAiEngine } from '@core/providers/local-ai-translator';
import type { WorkerHandle } from '../local-asr/client';
import type { AiReply, AiRequest } from './worker';

export interface LocalAiClientOptions {
  modelPath: string;
  spawn: () => WorkerHandle;
  threads: number;
  /** Loading takes a few seconds (longer on slow disks). */
  loadTimeoutMs?: number;
  /** One sentence; a slow computer may need several seconds. */
  requestTimeoutMs?: number;
  onLoaded?: (gpu: string) => void;
  /** Stop the worker (and free its memory) after this long without a sentence. Default 10 min. */
  idleMs?: number;
  /** After a failed load, wait this long before trying again. Default 5 min. */
  retryAfterMs?: number;
}

/** The local AI model in its worker process, started on first use and kept for the session. */
export class LocalAiClient implements LocalAiEngine {
  private worker: WorkerHandle | null = null;
  private loaded: Promise<void> | null = null;
  private isLoaded = false;
  private seq = 0;
  private idle: ReturnType<typeof setTimeout> | null = null;
  /** After the model failed to load, sentences go to the fallback for a while instead of retrying each time. */
  private failed: { until: number; message: string } | null = null;
  private pending = new Map<number, { resolve: (s: string) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly o: LocalAiClientOptions) {}

  private start(): Promise<void> {
    if (this.loaded) return this.loaded;
    const w = this.o.spawn();
    this.worker = w;
    this.loaded = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('本机 AI 翻译模型加载超时')), this.o.loadTimeoutMs ?? 90_000);
      w.on('message', (m: AiReply) => {
        if (m.t === 'loaded') {
          clearTimeout(timer);
          this.isLoaded = true;
          this.o.onLoaded?.(m.gpu);
          resolve();
        } else if (m.t === 'error' && m.id === undefined) {
          clearTimeout(timer);
          reject(new Error(m.message));
        } else if (m.t === 'result' || m.t === 'error') {
          const p = this.pending.get(m.id!);
          if (!p) return;
          this.pending.delete(m.id!);
          clearTimeout(p.timer);
          if (m.t === 'result') p.resolve(m.text);
          else p.reject(new Error(m.message));
        }
      });
      w.on('exit', () => {
        clearTimeout(timer);
        reject(new Error('本机 AI 翻译进程退出了'));
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(new Error('本机 AI 翻译进程退出了'));
        }
        this.pending.clear();
        this.worker = null;
        this.loaded = null; // started again on the next sentence
        this.isLoaded = false;
      });
    });
    this.loaded.catch((err: unknown) => {
      this.failed = { until: Date.now() + (this.o.retryAfterMs ?? 300_000), message: err instanceof Error ? err.message : String(err) };
      this.dispose();
    });
    const req: AiRequest = { t: 'load', modelPath: this.o.modelPath, threads: this.o.threads };
    w.postMessage(req);
    return this.loaded;
  }

  /** Loads the model now (as a meeting starts), without translating anything. */
  warmUp(): void {
    void this.start().catch(() => undefined);
  }

  /** Resolves once the model is loaded (rejects if it cannot load). */
  ready(): Promise<void> {
    return this.start();
  }

  async complete(prompt: string, signal?: AbortSignal): Promise<string> {
    if (this.failed && Date.now() < this.failed.until) throw new Error(this.failed.message);
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.dispose(), this.o.idleMs ?? 600_000);
    this.idle.unref?.();
    // While the model loads (seconds; longer from a slow disk), sentences go to the fallback
    // instead of queueing up behind the load.
    if (!this.isLoaded) {
      this.warmUp();
      throw new LocalAiLoadingError();
    }
    const id = ++this.seq;
    const cancel = () => this.worker?.postMessage({ t: 'cancel', id } satisfies AiRequest);
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        cancel();
        reject(new Error('本机 AI 翻译超时'));
      }, this.o.requestTimeoutMs ?? 30_000);
      this.pending.set(id, { resolve, reject, timer });
      signal?.addEventListener('abort', () => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        cancel();
        reject(new DOMException('Aborted', 'AbortError'));
      });
      const req: AiRequest = { t: 'complete', id, prompt, maxTokens: Math.min(512, 64 + prompt.length * 3) };
      this.worker!.postMessage(req);
    });
  }

  dispose(): void {
    try {
      this.worker?.kill();
    } catch {
      /* already gone */
    }
    this.worker = null;
    this.loaded = null;
    this.isLoaded = false;
  }
}

/** The model is still loading: use the fallback translation for this sentence. */
export class LocalAiLoadingError extends Error {
  constructor() {
    super('本机 AI 翻译模型正在加载');
  }
}
