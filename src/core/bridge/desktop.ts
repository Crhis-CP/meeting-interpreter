/**
 * The "desktop bridge": the browser extension borrows the desktop app's free, offline speech
 * recognition and the computer's own voices over 127.0.0.1, so the extension can be used without
 * any paid service. Client side (isomorphic, used by the extension) and shared protocol.
 *
 *   GET  /ping                     → { app, version, models: { zh, es, en } }
 *   WS   /asr?lang=zh-CN&hw=[...]  ← binary 16 kHz Int16 PCM, text {"t":"end"}
 *                                  → {"t":"ready"} | {"t":"status",text} | {"t":"partial",text}
 *                                    | {"t":"final",text,start?,end?} | {"t":"error",message,fatal} | {"t":"closed"}
 *   POST /tts {text,lang,voice?,rate} → raw Int16 LE PCM, header X-Sample-Rate
 *   GET  /voices?lang=es-MX        → VoiceInfo[]
 *   POST /mt {text,from,to,terms}  → {text}  (the desktop app's local AI translation, when downloaded)
 */
import { Emitter } from '../events';
import { bytesToInt16, int16ToBytes } from '../audio/pcm';
import type { LangCode, PcmChunk } from '../types';
import { ProviderError, type AsrEvents, type AsrSession, type AsrStartOptions, type ProviderContext, type StreamingAsr, type TranslateRequest, type Translator, type Tts, type TtsRequest, type VoiceInfo } from '../providers/types';

export const DESKTOP_BRIDGE_PORT = 47811;
export const DESKTOP_BRIDGE_APP = 'meeting-interpreter';
const NAME = '桌面客户端';

export type BridgeAsrServerMessage =
  | { t: 'ready' }
  | { t: 'status'; text: string }
  | { t: 'partial'; text: string }
  | { t: 'final'; text: string; start?: number; end?: number }
  | { t: 'error'; message: string; fatal: boolean }
  | { t: 'closed' };

export interface BridgePing {
  app: string;
  version: string;
  models: Record<'zh' | 'es' | 'en', boolean>;
  /** Whether the local AI translation model is downloaded (desktop 0.8+). */
  ai?: boolean;
}

/** The desktop app's local AI translation (Hy-MT2), for the extension. */
export class DesktopBridgeTranslator implements Translator {
  readonly id = 'local-ai';
  constructor(
    private readonly ctx: ProviderContext,
    private readonly base = `127.0.0.1:${DESKTOP_BRIDGE_PORT}`,
  ) {}

  async translate(req: TranslateRequest): Promise<string> {
    let res: Response;
    try {
      res = await this.ctx.fetch(`http://${this.base}/mt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: req.text, from: req.from, to: req.to, terms: req.hits.map((h) => ({ source: h.source, target: h.target })) }),
        signal: req.signal,
      });
    } catch (err) {
      if (req.signal?.aborted) throw err;
      throw new ProviderError(NOT_RUNNING, 'local-ai', { retryable: true, cause: err });
    }
    if (!res.ok) throw new ProviderError(`${NAME}：本机 AI 翻译失败（${res.status} ${await res.text().catch(() => '')}）`, 'local-ai', { retryable: res.status >= 500 });
    return ((await res.json()) as { text: string }).text;
  }
}

/** Origins allowed to use the bridge: the browser extension (and local tools without an Origin). */
export function bridgeOriginAllowed(origin: string | undefined): boolean {
  return !origin || origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://');
}

const NOT_RUNNING = `${NAME}：连接不上本机的会议同传助手。免费版需要电脑上同时打开桌面客户端（版本 0.3 以上）。`;

export class DesktopBridgeAsr implements StreamingAsr {
  readonly id = 'desktop';
  constructor(
    private readonly ctx: ProviderContext,
    private readonly base = `127.0.0.1:${DESKTOP_BRIDGE_PORT}`,
    /** How long to wait for the session to be ready (model loading / first download). */
    private readonly readyTimeoutMs = 120_000,
  ) {}

  start(opts: AsrStartOptions): Promise<AsrSession> {
    const url = `ws://${this.base}/asr?lang=${encodeURIComponent(opts.lang)}&hw=${encodeURIComponent(JSON.stringify(opts.hotwords.slice(0, 200)))}`;
    const ws = this.ctx.openWebSocket(url);
    const events = new Emitter<AsrEvents>();
    let ready = false;
    let closed = false;
    let endResolve: (() => void) | null = null;
    const finish = (reason?: string) => {
      if (closed) return;
      closed = true;
      endResolve?.();
      events.emit('closed', { reason });
    };
    const session: AsrSession = {
      events,
      push(pcm) {
        if (ws.readyState === 1 && pcm.length) ws.send(int16ToBytes(pcm));
      },
      end() {
        if (closed) return Promise.resolve();
        return new Promise<void>((resolve) => {
          endResolve = resolve;
          if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'end' }));
          setTimeout(() => {
            ws.close();
            finish('end timeout');
          }, 8000);
        });
      },
      close() {
        ws.close();
        finish('closed');
      },
    };
    return new Promise<AsrSession>((resolve, reject) => {
      let lastStatus = '';
      const timer = setTimeout(() => {
        if (ready) return;
        ws.close();
        reject(new ProviderError(`${NAME}：识别没有准备好${lastStatus ? `（${lastStatus}）` : ''}`, NAME, { retryable: true }));
      }, this.readyTimeoutMs);
      ws.onmessage = (data) => {
        if (typeof data !== 'string') return;
        let m: BridgeAsrServerMessage;
        try {
          m = JSON.parse(data) as BridgeAsrServerMessage;
        } catch {
          return;
        }
        switch (m.t) {
          case 'ready':
            ready = true;
            clearTimeout(timer);
            resolve(session);
            break;
          case 'status':
            lastStatus = m.text;
            this.ctx.log.info(`${NAME}: ${m.text}`);
            break;
          case 'partial':
            events.emit('partial', { text: m.text });
            break;
          case 'final':
            events.emit('final', { text: m.text, start: m.start, end: m.end });
            break;
          case 'error':
            if (!ready) {
              clearTimeout(timer);
              reject(new ProviderError(`${NAME}：${m.message}`, NAME, { retryable: !m.fatal }));
            } else events.emit('error', { error: new ProviderError(`${NAME}：${m.message}`, NAME), fatal: m.fatal });
            break;
          case 'closed':
            ws.close();
            finish();
            break;
        }
      };
      ws.onerror = () => {
        if (!ready) {
          clearTimeout(timer);
          reject(new ProviderError(NOT_RUNNING, NAME, { retryable: true }));
        }
      };
      ws.onclose = () => {
        if (!ready) {
          clearTimeout(timer);
          reject(new ProviderError(NOT_RUNNING, NAME, { retryable: true }));
        } else finish('socket closed');
      };
    });
  }
}

export class DesktopBridgeTts implements Tts {
  readonly id = 'desktop';
  constructor(
    private readonly ctx: ProviderContext,
    private readonly base = `127.0.0.1:${DESKTOP_BRIDGE_PORT}`,
  ) {}

  async *synthesize(req: TtsRequest): AsyncIterable<PcmChunk> {
    let res: Response;
    try {
      res = await this.ctx.fetch(`http://${this.base}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: req.text, lang: req.lang, voice: req.voice, rate: req.rate }),
        signal: req.signal,
      });
    } catch (err) {
      if (req.signal?.aborted) throw err;
      throw new ProviderError(NOT_RUNNING, NAME, { retryable: true, cause: err });
    }
    if (!res.ok) throw new ProviderError(`${NAME}：语音合成失败（${res.status}）${(await res.text().catch(() => '')).slice(0, 200)}`, NAME);
    const rate = Number(res.headers.get('X-Sample-Rate')) || 22050;
    const samples = bytesToInt16(new Uint8Array(await res.arrayBuffer()));
    if (samples.length) yield { samples, sampleRate: rate };
  }

  voices(_lang: LangCode): VoiceInfo[] {
    return [];
  }
}

/** Whether the desktop app is running and reachable (null when not). */
export async function pingDesktop(ctx: ProviderContext, base = `127.0.0.1:${DESKTOP_BRIDGE_PORT}`): Promise<BridgePing | null> {
  try {
    const res = await ctx.fetch(`http://${base}/ping`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const j = (await res.json()) as BridgePing;
    return j.app === DESKTOP_BRIDGE_APP ? j : null;
  } catch {
    return null;
  }
}
