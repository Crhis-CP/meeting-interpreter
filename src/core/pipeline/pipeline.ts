import { ASR_RATE } from '../audio/pcm';
import { Emitter, isAbortError, sleep } from '../events';
import { correctText } from '../glossary/correct';
import { findHits, hotwordsFor } from '../glossary/match';
import type { GlossaryEntry } from '../glossary/types';
import { baseOf } from '../lang/languages';
import { createLogger, type Logger } from '../log';
import type { AsrSession, StreamingAsr, Translator, Tts } from '../providers/types';
import type { LangCode, SegmentDir, TranscriptSegment } from '../types';
import { Committer } from './committer';
import { cleanTranslation, isValidTranslation } from './validate';

/** Speech rate for the current playback backlog: 1.0 up to 3 s, rising linearly to `max` at 12 s. */
export function rateForBacklog(seconds: number, max = 1.35): number {
  if (seconds <= 3) return 1;
  if (seconds >= 12) return max;
  return 1 + ((seconds - 3) / 9) * (max - 1);
}

export type PipelineState = 'idle' | 'connecting' | 'listening' | 'reconnecting' | 'error' | 'stopped';

export interface PipelineOptions {
  dir: SegmentDir;
  /** `me`, `them`, or a room participant's name. */
  speaker: string;
  /** Segment ids are `${idPrefix}-${seq}`. */
  idPrefix: string;
  srcLang: LangCode;
  dstLang: LangCode;
  asr: StreamingAsr;
  translator: Translator;
  tts: Tts | null;
  voice?: string;
  glossary: () => GlossaryEntry[];
  pinyinFuzzy: boolean;
  lowLatency: boolean;
  /** Seconds since the meeting started. */
  clock: () => number;
  /** Whether translated speech should be synthesised right now (can change mid-meeting). */
  speak?: () => boolean;
  maxRate?: number;
  log?: Logger;
  /** Backoff for reconnects in ms (tests shorten it). */
  reconnectDelays?: number[];
  /**
   * End the recognition session after the gate has been closed this long (ms); 0 keeps it open.
   * Cloud services drop idle connections anyway; local models are slow to reload, so keep those.
   */
  idleCloseMs?: number;
  /** Give up on a translation after this long (ms), so one stalled request can't silence a direction. */
  translateTimeoutMs?: number;
  /** Give up on synthesising one sentence after this long (ms). */
  ttsTimeoutMs?: number;
}

export type PipelineEvents = {
  partial: { text: string };
  segment: TranscriptSegment;
  audio: { segmentId: string; samples: Int16Array; sampleRate: number };
  audioEnd: { segmentId: string };
  /** Drop whatever audio is queued for playback (after skipToLatest). */
  audioFlush: Record<string, never>;
  status: { state: PipelineState; message?: string };
};

interface Job {
  seg: TranscriptSegment;
  translation: Promise<string | null>;
  skipped: boolean;
}

const BUFFER_WHILE_CONNECTING = ASR_RATE * 8; // keep the last 8 s while (re)connecting or a model loads

/**
 * One direction of interpretation: recognised speech → committed units → glossary correction →
 * translation → validation → synthesis. Text appears as soon as each translation is ready; audio
 * is produced strictly in the order speech was committed. Never speaks a failed or invalid
 * translation.
 */
export class DirectionPipeline extends Emitter<PipelineEvents> {
  private readonly o: PipelineOptions;
  private readonly log: Logger;
  private committer: Committer;
  private session: AsrSession | null = null;
  private state: PipelineState = 'idle';
  private seq = 0;
  private gateOpen = true;
  private backlog = 0;
  private stopping = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingAudio: Int16Array[] = [];
  private pendingSamples = 0;
  private queue: Job[] = [];
  private speaking: Promise<void> = Promise.resolve();
  private context: { src: string; dst: string }[] = [];
  private sentenceStart: number | null = null;
  private abort = new AbortController();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private connecting = false;

  constructor(opts: PipelineOptions) {
    super();
    this.o = opts;
    this.log = opts.log ?? createLogger(`pipeline:${opts.idPrefix}`);
    this.committer = new Committer({ base: baseOf(opts.srcLang), lowLatency: opts.lowLatency });
  }

  get currentState(): PipelineState {
    return this.state;
  }

  private setState(state: PipelineState, message?: string): void {
    this.state = state;
    this.emit('status', { state, message });
  }

  async start(): Promise<void> {
    this.stopping = false;
    await this.connect(false);
  }

  private async connect(isReconnect: boolean): Promise<void> {
    // One session at a time: a second connect while one is open or opening would leak a session
    // (a whole worker process for local recognition, the only connection on Azure F0).
    if (this.stopping || this.connecting || this.session) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.connecting = true;
    this.setState(isReconnect ? 'reconnecting' : 'connecting');
    try {
      const session = await this.o.asr.start({
        lang: this.o.srcLang,
        hotwords: hotwordsFor(baseOf(this.o.srcLang), this.o.glossary()),
        sampleRate: 16000,
      });
      if (this.stopping) {
        session.close();
        return;
      }
      this.session = session;
      this.reconnectAttempt = 0;
      this.attach(session);
      this.setState('listening');
      // Audio spoken while connecting is not lost.
      for (const chunk of this.pendingAudio) session.push(chunk);
      this.pendingAudio = [];
      this.pendingSamples = 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn('ASR connect failed', msg);
      this.setState('error', msg);
      this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  private attach(session: AsrSession): void {
    session.events.on('partial', ({ text }) => {
      if (session !== this.session) return;
      if (this.sentenceStart === null) this.sentenceStart = Math.max(0, this.o.clock() - 0.6);
      this.emit('partial', { text });
      for (const unit of this.committer.onPartial(text, Date.now())) this.commit(unit, false);
    });
    session.events.on('final', ({ text }) => {
      if (session !== this.session) return;
      for (const unit of this.committer.onFinal(text, Date.now())) this.commit(unit, true);
      this.emit('partial', { text: '' });
      this.sentenceStart = null;
    });
    session.events.on('error', ({ error, fatal }) => {
      if (session !== this.session) return;
      this.log.warn('ASR error', error.message);
      if (fatal) this.setState('error', error.message);
    });
    session.events.on('closed', () => {
      if (session !== this.session) return;
      this.session = null;
      this.committer.reset();
      if (!this.stopping && this.gateOpen) this.scheduleReconnect();
      else if (!this.stopping) this.setState('idle');
    });
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer) return;
    const delays = this.o.reconnectDelays ?? [1000, 2000, 4000, 8000, 15000, 30000];
    const delay = delays[Math.min(this.reconnectAttempt, delays.length - 1)]!;
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect(true);
    }, delay);
  }

  /** 16 kHz mono PCM from the capture side. */
  push(pcm: Int16Array): void {
    if (this.stopping || !this.gateOpen) return;
    if (this.session && this.state === 'listening') {
      this.session.push(pcm);
      return;
    }
    this.pendingAudio.push(pcm);
    this.pendingSamples += pcm.length;
    while (this.pendingSamples > BUFFER_WHILE_CONNECTING && this.pendingAudio.length > 1) {
      this.pendingSamples -= this.pendingAudio.shift()!.length;
    }
    if (!this.session && !this.reconnectTimer && !this.connecting) void this.connect(true);
  }

  /**
   * Mute / push-to-talk. Closing the gate pushes a short silence so the recogniser finishes the
   * sentence, and ends the recognition session after 15 s idle — before services drop idle
   * connections themselves (DashScope after ~23 s) — and reconnects on the next open.
   */
  setGate(open: boolean): void {
    if (open === this.gateOpen) return;
    this.gateOpen = open;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (!open) {
      this.session?.push(new Int16Array(Math.round(ASR_RATE * 1.2)));
      const idle = this.o.idleCloseMs ?? 15000;
      if (idle > 0) {
        this.idleTimer = setTimeout(() => {
          const s = this.session;
          this.session = null;
          if (s) void s.end().catch(() => s.close());
          if (!this.stopping) this.setState('idle');
        }, idle);
      }
    } else if (!this.session && !this.stopping) {
      // Reconnect now rather than waiting out a backoff timer (connect() clears it).
      void this.connect(true);
    }
  }

  get gate(): boolean {
    return this.gateOpen;
  }

  /** Seconds of translated audio queued for playback on the listening side. */
  setBacklog(seconds: number): void {
    this.backlog = Math.max(0, seconds);
  }

  /** Marks everything not yet spoken as skipped and asks the player to drop its queue. */
  skipToLatest(): void {
    for (const job of this.queue) {
      if (job.skipped) continue;
      job.skipped = true;
      if (job.seg.status === 'done') {
        job.seg = { ...job.seg, status: 'skipped' };
        this.emit('segment', job.seg);
      }
    }
    this.emit('audioFlush', {});
  }

  private commit(text: string, isFinal: boolean): void {
    const src = baseOf(this.o.srcLang);
    const entries = this.o.glossary();
    const corrected = correctText(text, src, entries, { pinyinFuzzy: this.o.pinyinFuzzy });
    const now = this.o.clock();
    const estimate = Math.max(1, [...corrected.text].length * (src === 'zh' ? 0.22 : 0.07));
    const start = this.sentenceStart ?? Math.max(0, now - estimate);
    const seg: TranscriptSegment = {
      id: `${this.o.idPrefix}-${++this.seq}`,
      dir: this.o.dir,
      speaker: this.o.speaker,
      seq: this.seq,
      start: Math.round(start * 100) / 100,
      end: Math.round(now * 100) / 100,
      srcLang: this.o.srcLang,
      srcText: corrected.text,
      dstLang: this.o.dstLang,
      dstText: null,
      status: 'translating',
      ...(corrected.edits.length ? { edits: corrected.edits } : {}),
    };
    this.sentenceStart = isFinal ? null : now;
    this.emit('segment', seg);
    const job: Job = { seg, translation: Promise.resolve(null), skipped: false };
    job.translation = this.translate(job);
    this.queue.push(job);
    this.speaking = this.speaking.then(() => this.speak(job));
  }

  private async translate(job: Job): Promise<string | null> {
    const req = {
      text: job.seg.srcText,
      from: this.o.srcLang,
      to: this.o.dstLang,
      hits: findHits(job.seg.srcText, baseOf(this.o.srcLang), this.o.glossary()),
      context: this.context.slice(-3),
      signal: this.abort.signal,
    };
    let lastError = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = await this.withTimeout(this.o.translateTimeoutMs ?? 20000, (signal) => this.o.translator.translate({ ...req, signal }));
        const out = cleanTranslation(raw);
        if (!isValidTranslation(out, this.o.dstLang, job.seg.srcText)) {
          lastError = '译文无效（语言不对或为空），已丢弃';
          break;
        }
        job.seg = { ...job.seg, dstText: out, status: job.skipped ? 'skipped' : 'done' };
        this.context.push({ src: job.seg.srcText, dst: out });
        if (this.context.length > 6) this.context.shift();
        this.emit('segment', job.seg);
        return out;
      } catch (err) {
        if (isAbortError(err)) return null;
        lastError = err instanceof Error ? err.message : String(err);
        const retryable = (err as { retryable?: boolean }).retryable ?? true;
        if (!retryable || attempt === 1) break;
        await sleep(400, this.abort.signal).catch(() => undefined);
      }
    }
    job.seg = { ...job.seg, status: 'failed', error: lastError };
    this.log.warn('translation failed', lastError);
    this.emit('segment', job.seg);
    return null;
  }

  private async speak(job: Job): Promise<void> {
    try {
      const text = await job.translation;
      if (!text || job.skipped || !this.o.tts || this.stopping) return;
      if (this.o.speak && !this.o.speak()) return;
      const rate = rateForBacklog(this.backlog, this.o.maxRate ?? 1.35);
      const ac = this.linkedAbort();
      const timer = setTimeout(() => ac.abort(), this.o.ttsTimeoutMs ?? 30000);
      try {
        for await (const chunk of this.o.tts.synthesize({ text, lang: this.o.dstLang, voice: this.o.voice || undefined, rate, signal: ac.signal })) {
          if (job.skipped || ac.signal.aborted) break;
          this.emit('audio', { segmentId: job.seg.id, samples: chunk.samples, sampleRate: chunk.sampleRate });
        }
      } catch (err) {
        if (!isAbortError(err)) this.log.warn('TTS failed', err instanceof Error ? err.message : String(err));
      } finally {
        clearTimeout(timer);
        ac.dispose();
      }
      this.emit('audioEnd', { segmentId: job.seg.id });
    } finally {
      this.queue = this.queue.filter((j) => j !== job);
    }
  }

  /** An AbortController that also aborts when the pipeline stops. */
  private linkedAbort(): AbortController & { dispose(): void } {
    const ac = new AbortController() as AbortController & { dispose(): void };
    const onStop = () => ac.abort();
    if (this.abort.signal.aborted) ac.abort();
    else this.abort.signal.addEventListener('abort', onStop, { once: true });
    ac.dispose = () => this.abort.signal.removeEventListener('abort', onStop);
    return ac;
  }

  private async withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const ac = this.linkedAbort();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ac.abort();
        reject(Object.assign(new Error('翻译超时'), { retryable: true }));
      }, ms);
    });
    try {
      return await Promise.race([fn(ac.signal), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      ac.dispose();
    }
  }

  /** Ends recognition, waits (bounded) for the last translations and speech, and stops. */
  async stop(waitMs = 8000): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.reconnectTimer = null;
    const s = this.session;
    this.session = null;
    if (s) {
      // Deliver the last sentence: the session's final results still flow until it closes.
      this.session = s;
      await Promise.race([s.end().catch(() => undefined), sleep(4000)]);
      this.session = null;
      s.close();
    }
    await Promise.race([Promise.allSettled(this.queue.map((j) => j.translation)), sleep(waitMs)]);
    await Promise.race([this.speaking, sleep(waitMs)]);
    this.abort.abort();
    this.setState('stopped');
  }
}
