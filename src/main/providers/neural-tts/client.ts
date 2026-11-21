/**
 * The natural voices (free, offline): one female and one male voice per language, made by Kokoro
 * in its own process (worker.ts) and streamed sentence by sentence. One instance serves the whole
 * app (both directions of a meeting, the room, the Chrome extension): the model is loaded once.
 */
import { baseOf } from '@core/lang/languages';
import { ProviderError, type Tts, type TtsRequest, type VoiceInfo } from '@core/providers/types';
import { kokoroInput } from '@core/speech-text/kokoro-input';
import type { LangCode, PcmChunk } from '@core/types';
import type { WorkerHandle } from '../local-asr/client';
import { MAX_CATCH_UP, NEURAL_VOICES, neuralVoice, type TtsModelId } from './models';
import type { TtsWorkerReply, TtsWorkerRequest } from './worker';

export interface NeuralTtsOptions {
  /** The model's folder. */
  dir: (model: TtsModelId) => string;
  /** Whether the model is downloaded (and checked). */
  ready: (model: TtsModelId) => boolean;
  spawn: () => WorkerHandle;
  /** 4 where the computer has room (a sentence in a quarter of its length), else 2. */
  threads: number;
  /** A sentence that brings no sound for this long fails (and the fallback voice speaks). Default 20 s. */
  stallMs?: number;
  /** Stop the process (and free its memory) after this long without speech. Default 10 min. */
  idleMs?: number;
  /** While this says so (a meeting is on), the model stays loaded however long nobody speaks. */
  keepLoaded?: () => boolean;
  onLoaded?: (ms: number) => void;
  onError?: (message: string) => void;
}

interface Pending {
  chunk(c: PcmChunk): void;
  end(err?: Error): void;
}

export class NeuralTts implements Tts {
  readonly id = 'local';
  private worker: WorkerHandle | null = null;
  private seq = 0;
  private idle: ReturnType<typeof setTimeout> | null = null;
  private readonly pending = new Map<number, Pending>();

  constructor(private readonly o: NeuralTtsOptions) {}

  voices(lang: LangCode): VoiceInfo[] {
    const base = baseOf(lang);
    return NEURAL_VOICES.filter((v) => v.lang === base).map((v) => ({ id: v.gender, name: v.gender === 'female' ? '女声' : '男声', lang, gender: v.gender }));
  }

  /** Whether the voices for this language can speak now (downloaded). */
  available(lang: LangCode): boolean {
    return this.o.ready(neuralVoice(baseOf(lang)).model);
  }

  /** Loads the model ahead (before a meeting), so the first sentence is not kept waiting. */
  warmUp(lang: LangCode): void {
    const model = neuralVoice(baseOf(lang)).model;
    if (!this.o.ready(model)) return;
    this.armIdle();
    this.ensureWorker().postMessage({ t: 'load', dir: this.o.dir(model), threads: this.o.threads } satisfies TtsWorkerRequest);
  }

  private ensureWorker(): WorkerHandle {
    if (this.worker) return this.worker;
    const w = this.o.spawn();
    this.worker = w;
    w.on('message', (m: TtsWorkerReply) => {
      if (m.t === 'loaded') this.o.onLoaded?.(m.ms);
      else if (m.t === 'error' && m.id === undefined) this.o.onError?.(m.message);
      else if (m.t === 'chunk') this.pending.get(m.id)?.chunk({ samples: new Int16Array(m.pcm), sampleRate: m.sampleRate });
      else if (m.t === 'done') this.pending.get(m.id)?.end();
      else if (m.t === 'error') this.pending.get(m.id!)?.end(new ProviderError(`自然人声出错：${m.message}`, 'local'));
    });
    w.on('exit', () => {
      if (this.worker !== w) return;
      this.worker = null; // started again on the next sentence
      for (const p of this.pending.values()) p.end(new ProviderError('自然人声进程退出了', 'local'));
    });
    return w;
  }

  private armIdle(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => (this.o.keepLoaded?.() || this.pending.size ? this.armIdle() : this.dispose()), this.o.idleMs ?? 600_000);
    this.idle.unref?.();
  }

  async *synthesize(req: TtsRequest): AsyncIterable<PcmChunk> {
    const base = baseOf(req.lang);
    const voice = neuralVoice(base, req.voice);
    if (!this.o.ready(voice.model)) throw new ProviderError('自然人声模型还没下载好', 'local');
    const input = kokoroInput(req.text, base);
    if ('text' in input ? !input.text : !input.phonemes.length) return;
    if (req.signal?.aborted) return;
    this.armIdle();
    const w = this.ensureWorker();
    const id = ++this.seq;
    const queue: PcmChunk[] = [];
    let finished = false;
    /** The worker said it is done with this request (no cancel needed). */
    let workerDone = false;
    let failure: Error | undefined;
    let wake: (() => void) | null = null;
    let stall: ReturnType<typeof setTimeout> | null = null;
    const end = (err?: Error) => {
      if (finished) return;
      finished = true;
      failure = err;
      if (stall) clearTimeout(stall);
      wake?.();
    };
    const armStall = () => {
      if (stall) clearTimeout(stall);
      stall = setTimeout(() => end(new ProviderError('自然人声太慢了（没有声音出来）', 'local')), this.o.stallMs ?? 20_000);
    };
    this.pending.set(id, {
      chunk: (c) => {
        armStall();
        queue.push(c);
        wake?.();
      },
      end: (err) => {
        workerDone = true;
        end(err);
      },
    });
    const onAbort = () => end();
    req.signal?.addEventListener('abort', onAbort, { once: true });
    // Catching up speeds the voice up a little, never past what is still easy to follow.
    const speed = voice.speed * Math.min(req.rate > 0 ? req.rate : 1, MAX_CATCH_UP);
    armStall();
    w.postMessage({ t: 'synth', id, dir: this.o.dir(voice.model), threads: this.o.threads, sid: voice.sid, speed, ...input } satisfies TtsWorkerRequest);
    try {
      for (;;) {
        if (queue.length) {
          if (req.signal?.aborted) return;
          yield queue.shift()!;
          continue;
        }
        if (finished) {
          if (failure && !req.signal?.aborted) throw failure;
          return;
        }
        await new Promise<void>((r) => (wake = r));
        wake = null;
      }
    } finally {
      req.signal?.removeEventListener('abort', onAbort);
      if (stall) clearTimeout(stall);
      // Stopped before the end (aborted, stalled, or the listener gave up): the rest is not made.
      if (!workerDone) this.worker?.postMessage({ t: 'cancel', id } satisfies TtsWorkerRequest);
      this.pending.delete(id);
    }
  }

  dispose(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    const w = this.worker;
    this.worker = null;
    for (const p of this.pending.values()) p.end(new ProviderError('自然人声已停止', 'local'));
    try {
      w?.kill();
    } catch {
      /* already gone */
    }
  }
}
