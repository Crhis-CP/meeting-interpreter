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
  /** The model could not be loaded (its sentences fail meanwhile; the meeting says so). */
  onLoadFailed?: (message: string) => void;
  /** Stop the worker (and free its memory) after this long without a sentence. Default 10 min. */
  idleMs?: number;
  /** While this says so (a meeting is on), the model stays loaded however long nobody speaks. */
  keepLoaded?: () => boolean;
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
  /** After the model failed to load, sentences fail at once for a while instead of retrying each time. */
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
      this.o.onLoadFailed?.(this.failed.message);
      this.dispose();
    });
    const req: AiRequest = { t: 'load', modelPath: this.o.modelPath, threads: this.o.threads };
    w.postMessage(req);
    return this.loaded;
  }

  /** Loads the model now (before a meeting), without translating anything; not again soon after a failed load. */
  warmUp(): void {
    if (this.loadError) return;
    void this.start().catch(() => undefined);
  }

  /** Why the model could not be loaded, while that is recent (it is tried again after a while, or on start). */
  get loadError(): string | null {
    return this.failed && Date.now() < this.failed.until ? this.failed.message : null;
  }

  /** Resolves once the model is loaded (rejects if it cannot load); tries again even right after a failure. */
  ready(): Promise<void> {
    this.armIdle();
    if (!this.loaded) this.failed = null;
    return this.start();
  }

  /** Whether the model is loaded now (a meeting starts only then: its first sentences are accurate too). */
  get loadedNow(): boolean {
    return this.isLoaded;
  }

  private armIdle(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => (this.o.keepLoaded?.() ? this.armIdle() : this.dispose()), this.o.idleMs ?? 600_000);
    this.idle.unref?.();
  }

  /** `lane`: the direction (0 into the other language, 1 into Chinese); each keeps its own cached prefix. */
  async complete(prompt: string, signal?: AbortSignal, lane = 0, maxTokens?: number): Promise<string> {
    if (this.failed && Date.now() < this.failed.until) throw new Error(this.failed.message);
    this.armIdle();
    // Accuracy first: a sentence that comes while the model loads waits for it (the meeting
    // normally starts with the model loaded; this is a reload after a crash). One that ends up too
    // late is shown and not spoken — the pipeline's rule — rather than replaced by a rough guess.
    if (!this.isLoaded) await this.start();
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
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
      const req: AiRequest = { t: 'complete', id, prompt, maxTokens: maxTokens ?? Math.min(512, 64 + prompt.length * 3), lane };
      if (!this.worker) {
        this.pending.delete(id);
        clearTimeout(timer);
        return reject(new Error('本机 AI 翻译进程退出了'));
      }
      this.worker.postMessage(req);
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
