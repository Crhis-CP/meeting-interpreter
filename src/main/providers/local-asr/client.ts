import { Emitter } from '@core/events';
import { ProviderError, type AsrEvents, type AsrSession, type AsrStartOptions, type StreamingAsr } from '@core/providers/types';
import type { LangCode } from '@core/types';
import type { ForeignModelId } from './models';

/** The worker process as seen from the main process. Electron's `UtilityProcess` fits as is. */
export interface WorkerHandle {
  postMessage(m: unknown): void;
  on(ev: 'message', fn: (m: any) => void): void;
  on(ev: 'exit', fn: (code: number) => void): void;
  kill(): void;
}

/** Main → worker. */
export type WorkerRequest =
  | { type: 'start'; lang: LangCode; modelsDir: string; esModel?: ForeignModelId; numThreads?: number; hotwords?: string[] }
  | { type: 'pcm'; data: ArrayBuffer }
  | { type: 'end' };

/** Worker → main. `start`/`end` are seconds since the session started. */
export type WorkerReply =
  | { type: 'ready' }
  | { type: 'final'; text: string; start: number; end: number }
  | { type: 'partial'; text: string }
  | { type: 'error'; message: string }
  | { type: 'ended' };

export interface LocalAsrOptions {
  modelsDir: string;
  /** Starts a worker running `worker.ts` (the app: `utilityProcess.fork(...)`; tests/CLI: `createInProcessWorker()`). */
  spawn: () => WorkerHandle;
  /** Recogniser for Spanish and English (settings `local.esModel`). Default Parakeet. */
  esModel?: ForeignModelId;
  /** Recogniser threads per session. Default 2. */
  numThreads?: number;
  /** Loading the models can take a while on slow disks. Default 120 s. */
  readyTimeoutMs?: number;
  /** How long `end()` waits for the last sentence. Default 30 s. */
  endTimeoutMs?: number;
}

const PROVIDER = 'local';
/** More phrases make every decode slower; the glossary's first ones are the ones that matter. */
const MAX_HOTWORDS = 100;

/**
 * Free offline speech recognition (sherpa-onnx in a separate process, so a native crash or a slow
 * decode never takes the app down). Emits `partial` results while a sentence is spoken (SenseVoice,
 * Parakeet) and `final` per sentence; Parakeet also listens for the user's terms (hot words).
 */
export class LocalAsr implements StreamingAsr {
  readonly id = 'local';

  constructor(private readonly opts: LocalAsrOptions) {}

  async start(start: AsrStartOptions): Promise<AsrSession> {
    let worker: WorkerHandle;
    try {
      worker = this.opts.spawn();
    } catch (err) {
      throw new ProviderError(`无法启动本机识别进程：${err instanceof Error ? err.message : String(err)}`, PROVIDER, { cause: err });
    }
    const session = new LocalAsrSession(worker, this.opts);
    const request: WorkerRequest = {
      type: 'start',
      lang: start.lang,
      modelsDir: this.opts.modelsDir,
      esModel: this.opts.esModel,
      numThreads: this.opts.numThreads,
      // The user's terms and names (Parakeet listens for them; SenseVoice cannot).
      ...(start.hotwords?.length ? { hotwords: start.hotwords.slice(0, MAX_HOTWORDS) } : {}),
    };
    session.send(request);
    await session.ready(this.opts.readyTimeoutMs ?? 120_000);
    return session;
  }
}

type State = 'starting' | 'running' | 'ending' | 'closed';

class LocalAsrSession implements AsrSession {
  readonly events = new Emitter<AsrEvents>();
  private state: State = 'starting';
  private readyWaiter: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private startError: ProviderError | null = null;
  private onEnded: (() => void) | null = null;
  private ending: Promise<void> | null = null;

  constructor(
    private readonly worker: WorkerHandle,
    private readonly opts: LocalAsrOptions,
  ) {
    worker.on('message', (m: WorkerReply) => this.onMessage(m));
    worker.on('exit', (code: number) => this.onExit(code));
  }

  send(m: WorkerRequest): void {
    try {
      this.worker.postMessage(m);
    } catch (err) {
      this.fail(new ProviderError(`本机识别进程已停止：${err instanceof Error ? err.message : String(err)}`, PROVIDER, { cause: err, retryable: true }));
    }
  }

  ready(timeoutMs: number): Promise<void> {
    if (this.startError) return Promise.reject(this.startError);
    if (this.state !== 'starting') return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new ProviderError('本机识别模型加载超时', PROVIDER, { retryable: true })), timeoutMs);
      this.readyWaiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
    });
  }

  push(pcm: Int16Array): void {
    if ((this.state !== 'running' && this.state !== 'starting') || !pcm.length) return;
    // A copy of exactly these samples (the view may sit inside a larger buffer).
    this.send({ type: 'pcm', data: pcm.slice().buffer as ArrayBuffer });
  }

  end(): Promise<void> {
    if (this.state === 'closed') return Promise.resolve();
    if (this.ending) return this.ending;
    this.state = 'ending';
    this.ending = new Promise<void>((resolve) => {
      const timer = setTimeout(() => this.onEnded?.(), this.opts.endTimeoutMs ?? 30_000);
      this.onEnded = () => {
        clearTimeout(timer);
        this.onEnded = null;
        this.shutdown('ended');
        resolve();
      };
      this.send({ type: 'end' });
    });
    return this.ending;
  }

  close(): void {
    this.shutdown('closed');
  }

  private onMessage(m: WorkerReply): void {
    if (this.state === 'closed' || !m || typeof m !== 'object') return;
    switch (m.type) {
      case 'ready':
        if (this.state === 'starting') {
          this.state = 'running';
          const w = this.readyWaiter;
          this.readyWaiter = null;
          w?.resolve();
        }
        break;
      case 'final':
        if (m.text) this.events.emit('final', { text: m.text, start: m.start, end: m.end });
        break;
      case 'partial':
        if (m.text) this.events.emit('partial', { text: m.text });
        break;
      case 'error':
        this.fail(new ProviderError(m.message || '本机识别出错', PROVIDER));
        break;
      case 'ended':
        this.onEnded?.();
        break;
    }
  }

  private onExit(code: number): void {
    if (this.state === 'closed') return;
    const starting = this.state === 'starting';
    this.fail(
      new ProviderError(starting ? `本机识别进程启动失败（退出码 ${code}）` : `本机识别进程意外退出（退出码 ${code}）`, PROVIDER, { retryable: true }),
    );
  }

  /** Fatal: before `ready` the start promise rejects; afterwards an `error` event is emitted. Either way the session closes. */
  private fail(error: ProviderError): void {
    if (this.state === 'closed') return;
    if (this.state === 'starting') {
      this.startError = error;
      const waiter = this.readyWaiter;
      this.readyWaiter = null;
      this.shutdown(error.message, false);
      waiter?.reject(error);
      return;
    }
    this.events.emit('error', { error, fatal: true });
    const ended = this.onEnded;
    this.onEnded = null;
    this.shutdown(error.message);
    ended?.();
  }

  private shutdown(reason: string, notify = true): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    try {
      this.worker.kill();
    } catch {
      // already gone
    }
    if (notify) this.events.emit('closed', { reason });
  }
}
