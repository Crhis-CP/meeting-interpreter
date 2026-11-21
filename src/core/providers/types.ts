import type { Emitter } from '../events';
import type { GlossaryHit } from '../glossary/types';
import type { Logger } from '../log';
import type { LangCode, PcmChunk } from '../types';

/**
 * A minimal WebSocket surface shared by the `ws` package (Node, supports headers) and the browser
 * WebSocket. Binary messages arrive as Uint8Array.
 */
export interface WebSocketLike {
  readonly readyState: number; // 0 connecting, 1 open, 2 closing, 3 closed
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen?: () => void;
  onmessage?: (data: string | Uint8Array) => void;
  onclose?: (code: number, reason: string) => void;
  onerror?: (err: Error) => void;
}

export interface OpenWebSocketOptions {
  headers?: Record<string, string>;
  protocols?: string[];
}

/** Everything a provider may use from its host environment. Injected so core stays isomorphic. */
export interface ProviderContext {
  fetch: typeof fetch;
  openWebSocket(url: string, opts?: OpenWebSocketOptions): WebSocketLike;
  log: Logger;
  /** Milliseconds, monotonic enough for timeouts. */
  now(): number;
}

/** Provider errors carry a user-facing Chinese message and whether retrying can help. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly options: { status?: number; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'ProviderError';
  }
  get retryable(): boolean {
    return this.options.retryable ?? false;
  }
  get status(): number | undefined {
    return this.options.status;
  }
}

// ---------------------------------------------------------------- speech recognition

export interface AsrStartOptions {
  lang: LangCode;
  /** Terms to bias recognition towards (glossary). May be ignored by providers without hot words. */
  hotwords: string[];
  /** PCM pushed is always 16 kHz mono Int16. */
  sampleRate: 16000;
  /**
   * Other languages that may be spoken in the same stream (conversation mode). Providers that
   * accept several language hints use them; the text tells which language was spoken.
   */
  alsoLangs?: LangCode[];
}

export type AsrEvents = {
  /** The current, still-changing hypothesis for the sentence being spoken (replaces the previous partial). */
  partial: { text: string };
  /** A finished sentence. `start`/`end` are seconds relative to the session start when known. */
  final: { text: string; start?: number; end?: number };
  /** `fatal` errors end the session; the pipeline reconnects. */
  error: { error: Error; fatal: boolean };
  /** The session ended (after `end()`, a fatal error, or the server closing). */
  closed: { reason?: string };
};

export interface AsrSession {
  readonly events: Emitter<AsrEvents>;
  push(pcm: Int16Array): void;
  /** Flushes buffered audio and resolves once the provider sent its last result. */
  end(): Promise<void>;
  /** Closes immediately. */
  close(): void;
}

export interface StreamingAsr {
  readonly id: string;
  start(opts: AsrStartOptions): Promise<AsrSession>;
}

// ---------------------------------------------------------------- translation

export interface TranslateRequest {
  text: string;
  from: LangCode;
  to: LangCode;
  /** Glossary terms present in `text`. */
  hits: GlossaryHit[];
  /** Recent source/translation pairs, oldest first, for coherence. */
  context: { src: string; dst: string }[];
  /**
   * What both sides said just before, oldest first (see Conversation): who ('me', 'them', or a
   * room participant's name) and their words as recognised — never machine translations.
   */
  history?: { who: string; text: string }[];
  signal?: AbortSignal;
}

export interface Translator {
  readonly id: string;
  translate(req: TranslateRequest): Promise<string>;
}

// ---------------------------------------------------------------- speech synthesis

export interface TtsRequest {
  text: string;
  lang: LangCode;
  /** Provider-specific voice id; undefined → the provider's default for `lang`. */
  voice?: string;
  /** 1.0 = normal; the pipeline raises it up to 1.35 to catch up. */
  rate: number;
  signal?: AbortSignal;
}

export interface VoiceInfo {
  id: string;
  name: string;
  lang: LangCode | 'multi';
  gender?: 'female' | 'male';
}

export interface Tts {
  readonly id: string;
  /** Streams PCM as it is synthesised. */
  synthesize(req: TtsRequest): AsyncIterable<PcmChunk>;
  voices(lang: LangCode): VoiceInfo[];
}

// ---------------------------------------------------------------- language model

export interface LlmRequest {
  system: string;
  user: string;
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface Llm {
  readonly id: string;
  complete(req: LlmRequest): Promise<string>;
}

// ---------------------------------------------------------------- helpers

/** Collects all chunks of a TTS stream into one PcmChunk (tests, CLI, previews). */
export async function collectPcm(stream: AsyncIterable<PcmChunk>): Promise<PcmChunk> {
  const parts: Int16Array[] = [];
  let rate = 16000;
  for await (const c of stream) {
    parts.push(c.samples);
    rate = c.sampleRate;
  }
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Int16Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return { samples: out, sampleRate: rate };
}

/** Turns a callback-driven producer into an async iterable (used by WebSocket TTS providers). */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private done = false;
  private error: Error | null = null;
  private rejecters: ((e: Error) => void)[] = [];

  push(item: T): void {
    if (this.done) return;
    const w = this.waiters.shift();
    this.rejecters.shift();
    if (w) w({ value: item, done: false });
    else this.items.push(item);
  }

  end(): void {
    if (this.done) return;
    this.done = true;
    for (const w of this.waiters) w({ value: undefined as never, done: true });
    this.waiters = [];
    this.rejecters = [];
  }

  fail(err: Error): void {
    if (this.done) return;
    this.error = err;
    this.done = true;
    for (const r of this.rejecters) r(err);
    this.waiters = [];
    this.rejecters = [];
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.error) return Promise.reject(this.error);
        if (this.done) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve, reject) => {
          this.waiters.push(resolve);
          this.rejecters.push(reject);
        });
      },
      return: () => {
        this.end();
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
  }
}
