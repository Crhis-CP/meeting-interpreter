import type { PushAudioInputStream, SpeechConfig, SpeechRecognizer } from 'microsoft-cognitiveservices-speech-sdk';
import { int16ToBytes } from '../../audio/pcm';
import { Emitter } from '../../events';
import { lang } from '../../lang/languages';
import type { Logger } from '../../log';
import { ProviderError, type AsrEvents, type AsrSession, type AsrStartOptions, type ProviderContext, type StreamingAsr } from '../types';
import {
  AZURE_ASR_NAME,
  AZURE_CANCELLATION_REASON,
  AZURE_RESULT_REASON,
  azureCancellationError,
  normalizeRegion,
  parseEndpoint,
  redactAzureDetails,
  type AzureConfig,
} from './common';

/** The Speech SDK module; injectable so tests can pass a fake. */
export type SpeechSdk = typeof import('microsoft-cognitiveservices-speech-sdk');

/** Azure recommends at most a couple of thousand phrases per phrase list. */
export const MAX_PHRASES = 2000;
/** Silence that ends a sentence (Azure allows 100–5000 ms). */
export const SEGMENTATION_SILENCE_MS = 500;
/** How long `end()` waits for the last results. */
export const END_TIMEOUT_MS = 5000;
/** How long `start()` waits for the WebSocket connection. */
export const START_TIMEOUT_MS = 15000;

const TICKS_PER_SECOND = 10_000_000;

// ---------------------------------------------------------------- pure event mapping

/** SDK offsets and durations are in 100 ns ticks; returns seconds rounded to the millisecond. */
export function ticksToSeconds(ticks: number): number {
  return Math.round((ticks / TICKS_PER_SECOND) * 1000) / 1000;
}

/** `recognizing` → the current hypothesis, or null when it is empty. */
export function mapRecognizing(result: { text?: string }): AsrEvents['partial'] | null {
  const text = (result.text ?? '').trim();
  return text ? { text } : null;
}

/** `recognized` → a final sentence with its timing; null for NoMatch (silence / noise) or empty text. */
export function mapRecognized(result: { reason: number; text?: string; offset?: number; duration?: number }): AsrEvents['final'] | null {
  if (result.reason !== AZURE_RESULT_REASON.RecognizedSpeech) return null;
  const text = (result.text ?? '').trim();
  if (!text) return null;
  const out: AsrEvents['final'] = { text };
  if (typeof result.offset === 'number' && Number.isFinite(result.offset)) {
    out.start = ticksToSeconds(result.offset);
    if (typeof result.duration === 'number' && Number.isFinite(result.duration)) out.end = ticksToSeconds(result.offset + result.duration);
  }
  return out;
}

/** `canceled` → a fatal ProviderError, or null when the audio simply ended (EndOfStream). */
export function mapCanceled(e: { reason: number; errorCode: number; errorDetails?: string }, key?: string): ProviderError | null {
  if (e.reason !== AZURE_CANCELLATION_REASON.Error) return null;
  return azureCancellationError(e.errorCode, e.errorDetails, key);
}

/** Trimmed, de-duplicated, non-empty phrases, capped at `MAX_PHRASES`. */
export function phraseList(hotwords: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const w of hotwords) {
    const p = (w ?? '').replace(/\s+/g, ' ').trim();
    if (p) seen.add(p);
    if (seen.size >= MAX_PHRASES) break;
  }
  return [...seen];
}

/** `fromEndpoint` when an endpoint is configured (Azure China / custom domain), else `fromSubscription`. */
export function createSpeechConfig(sdk: SpeechSdk, cfg: AzureConfig): SpeechConfig {
  const key = (cfg.key ?? '').trim();
  if (!key) throw new ProviderError(`${AZURE_ASR_NAME}：请先填写 Azure 语音 Key`, AZURE_ASR_NAME);
  if ((cfg.endpoint ?? '').trim()) {
    const url = parseEndpoint(cfg.endpoint);
    if (!url) throw new ProviderError(`${AZURE_ASR_NAME}：Endpoint 地址无效（${cfg.endpoint}）`, AZURE_ASR_NAME);
    return sdk.SpeechConfig.fromEndpoint(url, key);
  }
  const region = normalizeRegion(cfg.region);
  if (!region) throw new ProviderError(`${AZURE_ASR_NAME}：请先填写区域（region），例如 eastasia 或 chinaeast2`, AZURE_ASR_NAME);
  return sdk.SpeechConfig.fromSubscription(key, region);
}

/** The PCM as a standalone ArrayBuffer of little-endian 16-bit samples (what the push stream takes). */
export function pcmToArrayBuffer(pcm: Int16Array): ArrayBuffer {
  const bytes = int16ToBytes(pcm);
  const whole = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
  return (whole ? bytes.buffer : bytes.slice().buffer) as ArrayBuffer;
}

let sdkPromise: Promise<SpeechSdk> | null = null;

function loadSdk(): Promise<SpeechSdk> {
  sdkPromise ??= (async () => {
    const mod = (await import('microsoft-cognitiveservices-speech-sdk')) as SpeechSdk & { default?: SpeechSdk };
    // Named exports under ESM; `default` when a bundler wraps the CommonJS module.
    const sdk = (typeof mod.SpeechConfig === 'function' ? mod : mod.default) as SpeechSdk;
    await preferWsTransportInNode();
    return sdk;
  })();
  sdkPromise.catch(() => (sdkPromise = null));
  return sdkPromise;
}

/**
 * Node's built-in WebSocket (undici, Node 22+, also in Electron's main process) never fires
 * `close` when the handshake fails — a wrong key (HTTP 401) or an unreachable host — and the SDK
 * waits for `close`, so recognition would hang silently. In Node the SDK's long-standing `ws`
 * transport reports those failures, so prefer it there. Browsers keep their own WebSocket.
 */
async function preferWsTransportInNode(): Promise<void> {
  const g = globalThis as { process?: { versions?: { node?: string } }; window?: unknown };
  if (!g.process?.versions?.node || typeof g.window !== 'undefined') return;
  try {
    type Adapter = { forceNpmWebSocket?: unknown };
    const mod = (await import('microsoft-cognitiveservices-speech-sdk/distrib/lib/src/common.browser/WebsocketMessageAdapter.js')) as {
      WebsocketMessageAdapter?: Adapter;
      default?: { WebsocketMessageAdapter?: Adapter };
    };
    const adapter = mod.WebsocketMessageAdapter ?? mod.default?.WebsocketMessageAdapter;
    if (adapter && typeof adapter.forceNpmWebSocket === 'boolean') adapter.forceNpmWebSocket = true;
  } catch {
    // The SDK's internal layout changed: keep its default transport (start() still times out).
  }
}

/** Resolves when `p` settles or after `ms`, whichever comes first (never rejects). */
function settleWithin(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    p.then(done, done);
  });
}

// ---------------------------------------------------------------- provider

/**
 * Streaming recognition with the official Speech SDK: continuous recognition on a 16 kHz push
 * stream, glossary terms as a phrase list. Translation happens elsewhere, so this is a plain
 * SpeechRecognizer. The SDK is loaded lazily on the first `start()`.
 */
export class AzureAsr implements StreamingAsr {
  readonly id = 'azure';

  constructor(
    private readonly cfg: AzureConfig,
    private readonly ctx: ProviderContext,
    private readonly sdkOverride?: SpeechSdk,
  ) {}

  async start(opts: AsrStartOptions): Promise<AsrSession> {
    const speechSdk = this.sdkOverride ?? (await loadSdk());
    const log = this.ctx.log.child('azure-asr');
    const key = (this.cfg.key ?? '').trim();
    const language = lang(opts.lang).codes.azure;

    let recognizer: SpeechRecognizer;
    let pushStream: PushAudioInputStream;
    try {
      const speechConfig = createSpeechConfig(speechSdk, this.cfg);
      speechConfig.speechRecognitionLanguage = language;
      speechConfig.setProperty(speechSdk.PropertyId.Speech_SegmentationSilenceTimeoutMs, String(SEGMENTATION_SILENCE_MS));
      // Bounds the SDK's own graceful stop (it otherwise waits for the service indefinitely).
      if (speechSdk.PropertyId.Recognizer_StopTimeoutMs !== undefined) {
        speechConfig.setProperty(speechSdk.PropertyId.Recognizer_StopTimeoutMs, String(END_TIMEOUT_MS));
      }
      const format = speechSdk.AudioStreamFormat.getWaveFormatPCM(16000, 16, 1);
      pushStream = speechSdk.AudioInputStream.createPushStream(format);
      const audioConfig = speechSdk.AudioConfig.fromStreamInput(pushStream);
      recognizer = new speechSdk.SpeechRecognizer(speechConfig, audioConfig);
      const phrases = phraseList(opts.hotwords ?? []);
      if (phrases.length) speechSdk.PhraseListGrammar.fromRecognizer(recognizer).addPhrases(phrases);
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      const msg = redactAzureDetails(err instanceof Error ? err.message : String(err), key);
      throw new ProviderError(`${AZURE_ASR_NAME}：初始化失败（${msg}）`, AZURE_ASR_NAME, { cause: err });
    }

    const session = new AzureAsrSession(recognizer, pushStream, key, this.ctx, log);
    await session.begin();
    log.info(`recognition started (${language}, ${opts.hotwords?.length ?? 0} hot words)`);
    return session;
  }
}

type SessionState = 'starting' | 'running' | 'ending' | 'closed';

class AzureAsrSession implements AsrSession {
  readonly events = new Emitter<AsrEvents>();
  private state: SessionState = 'starting';
  private failStart: ((err: Error) => void) | null = null;
  private endPromise: Promise<void> | null = null;
  private readonly stopped: Promise<void>;
  private resolveStopped: () => void = () => {};

  constructor(
    private readonly recognizer: SpeechRecognizer,
    private readonly pushStream: PushAudioInputStream,
    private readonly key: string,
    private readonly ctx: ProviderContext,
    private readonly log: Logger,
  ) {
    this.stopped = new Promise<void>((resolve) => (this.resolveStopped = resolve));
    recognizer.recognizing = (_s, e) => {
      if (this.state !== 'running' && this.state !== 'ending') return;
      const ev = mapRecognizing(e.result);
      if (ev) this.events.emit('partial', ev);
    };
    recognizer.recognized = (_s, e) => {
      if (this.state !== 'running' && this.state !== 'ending') return;
      const ev = mapRecognized(e.result);
      if (ev) this.events.emit('final', ev);
    };
    recognizer.canceled = (_s, e) => {
      const err = mapCanceled(e, this.key);
      if (!err) return; // end of the pushed audio; `sessionStopped` follows
      this.onFatal(err);
    };
    recognizer.sessionStopped = () => {
      if (this.state === 'starting') {
        this.failStart?.(new ProviderError(`${AZURE_ASR_NAME}：会话意外结束`, AZURE_ASR_NAME, { retryable: true }));
        return;
      }
      this.finish('session-stopped');
    };
  }

  /** Starts continuous recognition; rejects with a ProviderError when the service cannot be reached. */
  begin(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        fail(new ProviderError(`${AZURE_ASR_NAME}：连接超时（${START_TIMEOUT_MS / 1000} 秒），请检查网络和区域设置`, AZURE_ASR_NAME, { retryable: true }));
      }, START_TIMEOUT_MS);
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.failStart = null;
        this.state = 'closed';
        this.resolveStopped();
        this.release();
        reject(err);
      };
      this.failStart = fail;
      const ok = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.failStart = null;
        this.state = 'running';
        resolve();
      };
      try {
        this.recognizer.startContinuousRecognitionAsync(ok, (e: string) => {
          fail(new ProviderError(`${AZURE_ASR_NAME}：启动识别失败（${redactAzureDetails(String(e), this.key)}）`, AZURE_ASR_NAME, { retryable: true, cause: e }));
        });
      } catch (err) {
        const msg = redactAzureDetails(err instanceof Error ? err.message : String(err), this.key);
        fail(new ProviderError(`${AZURE_ASR_NAME}：启动识别失败（${msg}）`, AZURE_ASR_NAME, { retryable: true, cause: err }));
      }
    });
  }

  push(pcm: Int16Array): void {
    if (this.state !== 'running' || pcm.length === 0) return;
    try {
      this.pushStream.write(pcmToArrayBuffer(pcm));
    } catch (err) {
      this.log.warn('push failed', err instanceof Error ? err.message : String(err));
    }
  }

  end(): Promise<void> {
    if (!this.endPromise) this.endPromise = this.doEnd();
    return this.endPromise;
  }

  private async doEnd(): Promise<void> {
    if (this.state !== 'running') return;
    this.state = 'ending';
    // Closing the push stream lets the SDK send what is still queued; the service then delivers the
    // last results and stops the session (`canceled` EndOfStream, then `sessionStopped`).
    try {
      this.pushStream.close();
    } catch {
      // already closed
    }
    const startedAt = this.ctx.now();
    await settleWithin(this.stopped, END_TIMEOUT_MS);
    if (!this.isClosed) this.log.warn(`no end of session after ${this.ctx.now() - startedAt} ms; stopping`);
    this.finish('end');
  }

  /** Read through a getter so TypeScript does not narrow the state across awaits. */
  private get isClosed(): boolean {
    return this.state === 'closed';
  }

  close(): void {
    this.finish('close');
  }

  private onFatal(err: ProviderError): void {
    if (this.state === 'closed') return;
    if (this.state === 'starting') {
      this.failStart?.(err);
      return;
    }
    if (this.state === 'ending') {
      // We asked for the end; report it in the log only so the pipeline does not reconnect.
      this.log.warn('error while ending', err.message);
      this.finish('end');
      return;
    }
    this.log.warn('recognition canceled', err.message);
    this.events.emit('error', { error: err, fatal: true });
    this.finish('error');
  }

  /** Ends the session once: releases the SDK objects and emits `closed`. */
  private finish(reason: string): void {
    if (this.state === 'closed' || this.state === 'starting') return;
    this.state = 'closed';
    this.resolveStopped();
    this.release();
    this.events.emit('closed', { reason });
  }

  /** Closes the push stream, stops recognition and closes the recognizer (each at most once). */
  private release(): void {
    try {
      this.pushStream.close();
    } catch {
      // already closed
    }
    const recognizer = this.recognizer;
    let closed = false;
    const closeRecognizer = () => {
      if (closed) return;
      closed = true;
      try {
        recognizer.close(undefined, (e: string) => this.log.debug('close failed', e));
      } catch {
        // already disposed
      }
    };
    try {
      recognizer.stopContinuousRecognitionAsync(closeRecognizer, (e: string) => {
        this.log.debug('stop failed', redactAzureDetails(String(e), this.key));
        closeRecognizer();
      });
    } catch {
      closeRecognizer();
    }
  }
}
