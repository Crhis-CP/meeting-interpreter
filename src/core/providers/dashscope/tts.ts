import { base64ToBytes, bytesToInt16 } from '../../audio/pcm';
import { lang, type LangBase } from '../../lang/languages';
import type { Logger } from '../../log';
import type { LangCode, PcmChunk } from '../../types';
import { uuid } from '../http';
import { AsyncQueue, ProviderError, type ProviderContext, type Tts, type TtsRequest, type VoiceInfo, type WebSocketLike } from '../types';
import { DASHSCOPE_DEFAULTS, authHeaders, dashscopeError, dashscopeHost, errorText, resolveModel, type DashscopeConfig, type DashscopeFailure } from './common';

/** Output sample rate requested from the realtime TTS session. */
export const DASHSCOPE_TTS_RATE = 24000;

/** How long to wait for `session.created` before sending anyway. */
const CREATED_WAIT_MS = 3000;
const CONNECT_TIMEOUT_MS = 10_000;
/** No server event for this long after connecting → give up (keeps the ordered playout from stalling). */
const IDLE_TIMEOUT_MS = 15_000;

/** Qwen3-TTS voices. Every voice speaks both Mandarin and Spanish. */
export const DASHSCOPE_VOICES: readonly VoiceInfo[] = [
  { id: 'Cherry', name: 'Cherry 芊悦（女声，亲切自然，普通话）', lang: 'multi', gender: 'female' },
  { id: 'Serena', name: 'Serena 苏瑶（女声，温柔，普通话）', lang: 'multi', gender: 'female' },
  { id: 'Ethan', name: 'Ethan 晨煦（男声，阳光，普通话略带北方口音）', lang: 'multi', gender: 'male' },
  { id: 'Neil', name: 'Neil 阿闻（男声，新闻播音腔）', lang: 'multi', gender: 'male' },
  { id: 'Sonrisa', name: 'Sonrisa 索尼莎（女声，拉美西语口音）', lang: 'multi', gender: 'female' },
  { id: 'Bodega', name: 'Bodega 博德加（男声，西班牙西语口音）', lang: 'multi', gender: 'male' },
];

export const DASHSCOPE_DEFAULT_VOICE: Record<LangBase, string> = { zh: 'Cherry', es: 'Sonrisa', en: 'Ethan' };

const VOICE_ORDER: Record<LangBase, string[]> = {
  zh: ['Cherry', 'Serena', 'Ethan', 'Neil', 'Sonrisa', 'Bodega'],
  es: ['Sonrisa', 'Bodega', 'Cherry', 'Serena', 'Ethan', 'Neil'],
  en: ['Ethan', 'Cherry', 'Serena', 'Neil', 'Sonrisa', 'Bodega'],
};

function baseOrZh(code: LangCode): LangBase {
  try {
    return lang(code).base;
  } catch {
    return 'zh';
  }
}

function clampRate(rate: number): number {
  const r = Number.isFinite(rate) ? rate : 1;
  return Math.round(Math.min(2, Math.max(0.5, r)) * 100) / 100;
}

/** An AsyncQueue that tells its producer when the consumer stops early (`break` out of `for await`). */
class TtsQueue extends AsyncQueue<PcmChunk> {
  onCancel: (() => void) | null = null;

  override [Symbol.asyncIterator](): AsyncIterator<PcmChunk> {
    const it = super[Symbol.asyncIterator]();
    return {
      next: () => it.next(),
      return: () => {
        this.onCancel?.();
        return it.return ? it.return() : Promise.resolve({ value: undefined as never, done: true });
      },
    };
  }
}

/**
 * Qwen3-TTS realtime (`/api-ws/v1/realtime?model=…`), one WebSocket session per request:
 * session.update → input_text_buffer.append → commit → session.finish; audio arrives as
 * base64 PCM16 (24 kHz) in `response.audio.delta` and the stream ends on `session.finished`.
 */
export class DashscopeTts implements Tts {
  readonly id = 'dashscope';

  constructor(
    private readonly cfg: DashscopeConfig,
    private readonly ctx: ProviderContext,
  ) {}

  get model(): string {
    return resolveModel(this.cfg.ttsModel, DASHSCOPE_DEFAULTS.ttsModel);
  }

  synthesize(req: TtsRequest): AsyncQueue<PcmChunk> {
    const stream = new TtsStream(this.cfg, this.ctx, req, this.model);
    stream.start();
    return stream.queue;
  }

  voices(code: LangCode): VoiceInfo[] {
    const order = VOICE_ORDER[baseOrZh(code)];
    return order.map((id) => ({ ...DASHSCOPE_VOICES.find((v) => v.id === id)! }));
  }
}

interface RealtimeEvent {
  type?: string;
  delta?: unknown;
  error?: { type?: string; code?: string; message?: string; param?: string | null };
}

class TtsStream {
  readonly queue = new TtsQueue();
  private readonly log: Logger;
  private ws: WebSocketLike | null = null;
  private finished = false;
  private opened = false;
  private created = false;
  private textSent = false;
  private audioDone = false;
  /** An odd trailing byte carried over to the next delta (PCM16 samples may straddle deltas). */
  private carry: number | null = null;
  private transportError = '';
  private createdTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private errorTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly onAbort = () => this.complete();

  constructor(
    private readonly cfg: DashscopeConfig,
    private readonly ctx: ProviderContext,
    private readonly req: TtsRequest,
    private readonly model: string,
  ) {
    this.log = ctx.log.child('dashscope-tts');
  }

  start(): void {
    const { req } = this;
    if (req.signal?.aborted || !req.text.trim()) {
      this.finished = true;
      this.queue.end();
      return;
    }
    let headers: Record<string, string>;
    let session: Record<string, unknown>;
    try {
      headers = authHeaders(this.cfg);
      const base = lang(req.lang).base;
      session = {
        voice: req.voice?.trim() || DASHSCOPE_DEFAULT_VOICE[base],
        mode: 'server_commit',
        language_type: base === 'zh' ? 'Chinese' : base === 'en' ? 'English' : 'Spanish',
        response_format: 'pcm',
        sample_rate: DASHSCOPE_TTS_RATE,
        speech_rate: clampRate(req.rate),
      };
    } catch (err) {
      this.fail(err instanceof ProviderError ? err : this.error({ message: errorText(err) }));
      return;
    }
    this.queue.onCancel = () => this.complete();
    req.signal?.addEventListener('abort', this.onAbort, { once: true });
    this.arm(CONNECT_TIMEOUT_MS);
    const url = `wss://${dashscopeHost(this.cfg)}/api-ws/v1/realtime?model=${encodeURIComponent(this.model)}`;
    let ws: WebSocketLike;
    try {
      ws = this.ctx.openWebSocket(url, { headers });
    } catch (err) {
      this.fail(this.error({ message: errorText(err) }));
      return;
    }
    this.ws = ws;
    ws.onopen = () => this.onOpen(session);
    ws.onmessage = (data) => this.onMessage(data, session);
    ws.onerror = (err) => this.onTransportError(err);
    ws.onclose = (code, reason) => this.onClose(code, reason);
    if (ws.readyState === 1) this.onOpen(session);
  }

  private onOpen(session: Record<string, unknown>): void {
    if (this.finished || this.opened) return;
    this.opened = true;
    this.arm(IDLE_TIMEOUT_MS);
    if (this.created) {
      this.sendText(session);
      return;
    }
    this.createdTimer = setTimeout(() => {
      this.createdTimer = null;
      this.log.debug('no session.created yet, sending anyway');
      this.sendText(session);
    }, CREATED_WAIT_MS);
  }

  private onMessage(data: string | Uint8Array, session: Record<string, unknown>): void {
    if (this.finished || typeof data !== 'string') return;
    this.arm(IDLE_TIMEOUT_MS);
    let event: RealtimeEvent;
    try {
      event = JSON.parse(data) as RealtimeEvent;
    } catch {
      this.log.warn('ignoring a non-JSON message');
      return;
    }
    switch (event.type) {
      case 'session.created':
        this.created = true;
        if (this.opened) this.sendText(session);
        break;
      case 'response.audio.delta':
        if (typeof event.delta === 'string') this.onDelta(event.delta);
        break;
      case 'response.audio.done':
      case 'response.done':
        this.audioDone = true;
        break;
      case 'session.finished':
        this.complete();
        break;
      case 'error': {
        const e = event.error ?? {};
        const message = [e.message, e.param ? `(param: ${e.param})` : ''].filter(Boolean).join(' ');
        this.fail(this.error({ code: e.code ?? e.type, message: message || undefined }));
        break;
      }
      default:
        break;
    }
  }

  private sendText(session: Record<string, unknown>): void {
    if (this.textSent || this.finished) return;
    this.textSent = true;
    if (this.createdTimer) clearTimeout(this.createdTimer);
    this.createdTimer = null;
    const events: Record<string, unknown>[] = [
      { type: 'session.update', session },
      { type: 'input_text_buffer.append', text: this.req.text },
      { type: 'input_text_buffer.commit' },
      { type: 'session.finish' },
    ];
    for (const event of events) {
      if (!this.send({ event_id: `event_${uuid()}`, ...event })) {
        this.fail(this.error({ message: `发送 ${String(event.type)} 失败，连接已断开` }));
        return;
      }
    }
  }

  private onDelta(b64: string): void {
    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(b64);
    } catch {
      this.log.warn('ignoring an undecodable audio delta');
      return;
    }
    if (this.carry !== null) {
      const merged = new Uint8Array(bytes.length + 1);
      merged[0] = this.carry;
      merged.set(bytes, 1);
      bytes = merged;
      this.carry = null;
    }
    if (bytes.length % 2 === 1) {
      this.carry = bytes[bytes.length - 1]!;
      bytes = bytes.subarray(0, bytes.length - 1);
    }
    if (bytes.length) this.queue.push({ samples: bytesToInt16(bytes), sampleRate: DASHSCOPE_TTS_RATE });
  }

  private onTransportError(err: Error): void {
    this.transportError = errorText(err);
    this.log.warn('socket error', this.transportError);
    if (this.finished || this.errorTimer) return;
    // A close event normally follows at once and may carry more detail; fall back if it never comes.
    this.errorTimer = setTimeout(() => {
      this.errorTimer = null;
      this.onClose(1006, '');
    }, 100);
  }

  private onClose(code: number, reason: string): void {
    if (this.finished) return;
    if (this.audioDone) {
      this.complete();
      return;
    }
    this.fail(this.error({ closeCode: code, closeReason: reason, message: this.transportError || undefined }));
  }

  /** (Re)starts the watchdog: connect timeout until open, then an idle timeout between server events. */
  private arm(ms: number): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      if (this.audioDone) this.complete();
      else this.fail(this.error({ message: this.opened ? `${ms / 1000} 秒没有收到服务器响应，已超时` : `连接超时（${ms / 1000} 秒）` }));
    }, ms);
  }

  private send(event: Record<string, unknown>): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return false;
    try {
      ws.send(JSON.stringify(event));
      return true;
    } catch (err) {
      this.log.warn('send failed', errorText(err));
      return false;
    }
  }

  /** Ends the stream normally (finished, aborted or abandoned by the consumer). */
  private complete(): void {
    if (this.finished) return;
    this.finished = true;
    this.teardown();
    this.queue.end();
  }

  private fail(error: ProviderError): void {
    if (this.finished) return;
    this.finished = true;
    this.teardown();
    this.log.warn('synthesis failed', error.message);
    this.queue.fail(error);
  }

  private teardown(): void {
    if (this.createdTimer) clearTimeout(this.createdTimer);
    if (this.watchdog) clearTimeout(this.watchdog);
    if (this.errorTimer) clearTimeout(this.errorTimer);
    this.createdTimer = this.watchdog = this.errorTimer = null;
    this.req.signal?.removeEventListener('abort', this.onAbort);
    this.queue.onCancel = null;
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.onopen = undefined;
    ws.onmessage = undefined;
    ws.onerror = undefined;
    ws.onclose = undefined;
    try {
      if (ws.readyState !== 3) ws.close(1000, 'done');
    } catch (err) {
      this.log.debug('close failed', errorText(err));
    }
  }

  private error(failure: DashscopeFailure): ProviderError {
    return dashscopeError('tts', { model: this.model, ...failure }, this.cfg);
  }
}
