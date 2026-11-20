import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AzureAsr, END_TIMEOUT_MS, MAX_PHRASES, mapCanceled, mapRecognized, mapRecognizing, phraseList, ticksToSeconds, type SpeechSdk } from '@core/providers/azure/asr';
import {
  AZURE_CANCELLATION_ERROR_CODE,
  AZURE_CANCELLATION_REASON,
  AZURE_RESULT_REASON,
  AZURE_VOICES,
  azureCancellationError,
  defaultAzureVoice,
  isChinaCloud,
  ttsUrl,
} from '@core/providers/azure/common';
import { AzureTts, PcmByteDecoder, buildSsml, escapeXml, prosodyRate } from '@core/providers/azure/tts';
import * as azureIndex from '@core/providers/azure';
import { ProviderError, collectPcm, type AsrSession } from '@core/providers/types';
import { fakeContext, waitFor } from '../helpers/fakes';

const KEY = '0123456789abcdef0123456789abcdef';

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------- fake Speech SDK

interface FakeOptions {
  /** startContinuousRecognitionAsync calls its error callback with this. */
  startError?: string;
  /** A `canceled` (reason Error) fired while starting, before the success callback (as the SDK does). */
  cancelDuringStart?: { errorCode: number; errorDetails: string };
  /** Simulate the service ending the session after the push stream closes. Default true. */
  stopOnStreamClose?: boolean;
}

function createFakeSdk(opts: FakeOptions = {}) {
  const state = {
    configs: [] as FakeSpeechConfig[],
    recognizers: [] as FakeRecognizer[],
    streams: [] as FakePushStream[],
    formats: [] as { rate: number; bits: number; channels: number }[],
    phrases: [] as string[][],
  };

  class FakeSpeechConfig {
    speechRecognitionLanguage = '';
    readonly props = new Map<unknown, string>();
    constructor(
      readonly kind: 'subscription' | 'endpoint',
      readonly key: string,
      readonly region?: string,
      readonly endpoint?: URL,
    ) {
      state.configs.push(this);
    }
    setProperty(name: unknown, value: string) {
      this.props.set(name, value);
    }
    static fromSubscription(key: string, region: string) {
      return new FakeSpeechConfig('subscription', key, region);
    }
    static fromEndpoint(endpoint: URL, key: string) {
      return new FakeSpeechConfig('endpoint', key, undefined, endpoint);
    }
  }

  class FakePushStream {
    writes: ArrayBuffer[] = [];
    closed = false;
    onClose?: () => void;
    constructor(readonly format: unknown) {
      state.streams.push(this);
    }
    write(buffer: ArrayBuffer) {
      if (this.closed) throw new Error('Stream closed');
      this.writes.push(buffer);
    }
    close() {
      if (this.closed) throw new Error('Stream closed');
      this.closed = true;
      this.onClose?.();
    }
  }

  class FakeRecognizer {
    recognizing?: (sender: unknown, e: unknown) => void;
    recognized?: (sender: unknown, e: unknown) => void;
    canceled?: (sender: unknown, e: unknown) => void;
    sessionStopped?: (sender: unknown, e: unknown) => void;
    startCalls = 0;
    stopCalls = 0;
    closeCalls = 0;
    constructor(
      readonly config: FakeSpeechConfig,
      readonly audio: { stream: FakePushStream },
    ) {
      state.recognizers.push(this);
      if (opts.stopOnStreamClose !== false) {
        audio.stream.onClose = () => setTimeout(() => this.sessionStopped?.(this, { sessionId: 's1' }), 5);
      }
    }
    startContinuousRecognitionAsync(cb?: () => void, err?: (e: string) => void) {
      this.startCalls++;
      setTimeout(() => {
        if (opts.startError) return err?.(opts.startError);
        if (opts.cancelDuringStart) this.fireCanceled(AZURE_CANCELLATION_REASON.Error, opts.cancelDuringStart.errorCode, opts.cancelDuringStart.errorDetails);
        cb?.();
      }, 1);
    }
    stopContinuousRecognitionAsync(cb?: () => void) {
      this.stopCalls++;
      setTimeout(() => cb?.(), 1);
    }
    close(cb?: () => void) {
      // The real SDK throws when closing a disposed recognizer.
      if (this.closeCalls++ > 0) throw new Error('the object is already disposed');
      cb?.();
    }
    // ---- test drivers (what the service would trigger)
    fireRecognizing(text: string) {
      this.recognizing?.(this, { result: { reason: AZURE_RESULT_REASON.RecognizingSpeech, text, offset: 0, duration: 0 } });
    }
    fireRecognized(text: string, offset: number, duration: number, reason: number = AZURE_RESULT_REASON.RecognizedSpeech) {
      this.recognized?.(this, { result: { reason, text, offset, duration } });
    }
    fireCanceled(reason: number, errorCode: number, errorDetails: string) {
      this.canceled?.(this, { reason, errorCode, errorDetails });
    }
    fireSessionStopped() {
      this.sessionStopped?.(this, { sessionId: 's1' });
    }
  }

  const sdk = {
    SpeechConfig: FakeSpeechConfig,
    PropertyId: { Speech_SegmentationSilenceTimeoutMs: 31, Recognizer_StopTimeoutMs: 67 },
    AudioStreamFormat: {
      getWaveFormatPCM: (rate: number, bits: number, channels: number) => {
        const f = { rate, bits, channels };
        state.formats.push(f);
        return f;
      },
    },
    AudioInputStream: { createPushStream: (format: unknown) => new FakePushStream(format) },
    AudioConfig: { fromStreamInput: (stream: FakePushStream) => ({ stream }) },
    SpeechRecognizer: FakeRecognizer,
    PhraseListGrammar: {
      fromRecognizer: () => ({ addPhrases: (phrases: string[]) => state.phrases.push([...phrases]) }),
    },
  };
  return { sdk: sdk as unknown as SpeechSdk, state };
}

/** Records every session event in order. */
function record(session: AsrSession) {
  const events: [string, any][] = [];
  session.events.on('partial', (e) => events.push(['partial', e]));
  session.events.on('final', (e) => events.push(['final', e]));
  session.events.on('error', (e) => events.push(['error', e]));
  session.events.on('closed', (e) => events.push(['closed', e]));
  return events;
}

async function startSession(cfg: { key: string; region: string; endpoint?: string } = { key: KEY, region: 'eastasia' }, fake = createFakeSdk(), lang = 'es-MX', hotwords: string[] = []) {
  const asr = new AzureAsr(cfg, fakeContext(), fake.sdk);
  const session = await asr.start({ lang, hotwords, sampleRate: 16000 });
  return { asr, session, ...fake, recognizer: fake.state.recognizers[0]!, stream: fake.state.streams[0]! };
}

// ---------------------------------------------------------------- common

describe('azure common', () => {
  it('picks the global or the China TTS host', () => {
    expect(ttsUrl({ key: KEY, region: 'eastasia' })).toBe('https://eastasia.tts.speech.microsoft.com/cognitiveservices/v1');
    expect(ttsUrl({ key: KEY, region: 'chinaeast2' })).toBe('https://chinaeast2.tts.speech.azure.cn/cognitiveservices/v1');
    expect(ttsUrl({ key: KEY, region: ' West Europe ' })).toBe('https://westeurope.tts.speech.microsoft.com/cognitiveservices/v1');
    // An Azure China resource endpoint selects the China cloud even with a non-china region name.
    expect(ttsUrl({ key: KEY, region: 'eastasia', endpoint: 'https://myres.cognitiveservices.azure.cn' })).toBe(
      'https://eastasia.tts.speech.azure.cn/cognitiveservices/v1',
    );
    expect(() => ttsUrl({ key: KEY, region: '' })).toThrow(ProviderError);
  });

  it('detects Azure China from the region or the endpoint host', () => {
    expect(isChinaCloud({ region: 'chinanorth3' })).toBe(true);
    expect(isChinaCloud({ region: 'ChinaEast2' })).toBe(true);
    expect(isChinaCloud({ region: '', endpoint: 'myres.cognitiveservices.azure.cn' })).toBe(true);
    expect(isChinaCloud({ region: 'eastasia', endpoint: '' })).toBe(false);
    expect(isChinaCloud({ region: 'eastasia', endpoint: 'https://myres.cognitiveservices.azure.com' })).toBe(false);
    expect(isChinaCloud({ region: 'eastasia', endpoint: 'https://evil-azure.cn.example.com' })).toBe(false);
  });

  it('lists full voice ids per language with a default', () => {
    expect(defaultAzureVoice('zh-CN')).toBe('zh-CN-XiaoxiaoNeural');
    expect(defaultAzureVoice('es-ES')).toBe('es-ES-ElviraNeural');
    expect(defaultAzureVoice('es-PE')).toBe('es-PE-CamilaNeural');
    expect(defaultAzureVoice('es')).toBe('es-ES-ElviraNeural');
    expect(AZURE_VOICES['zh-CN']!.map((v) => v.id)).toEqual(['zh-CN-XiaoxiaoNeural', 'zh-CN-YunxiNeural', 'zh-CN-YunyangNeural']);
    for (const code of ['es-ES', 'es-MX', 'es-US', 'es-AR', 'es-CO', 'es-CL', 'es-PE']) {
      const list = AZURE_VOICES[code]!;
      expect(list.map((v) => v.gender)).toEqual(['female', 'male']);
      for (const v of list) {
        expect(v.id.startsWith(`${code}-`) && v.id.endsWith('Neural')).toBe(true);
        expect(v.lang).toBe(code);
        expect(v.name).toMatch(/\p{Script=Han}/u); // shown in the Chinese UI
      }
    }
  });

  it('maps cancellation codes to Chinese messages without leaking the key', () => {
    const E = AZURE_CANCELLATION_ERROR_CODE;
    const auth = azureCancellationError(E.AuthenticationFailure, `401 Unauthorized wss://x?Ocp-Apim-Subscription-Key=${KEY}`, KEY);
    expect(auth.message).toContain('Key 或区域不正确');
    expect(auth.message).not.toContain(KEY);
    expect(auth.retryable).toBe(false);
    expect(auth.status).toBe(401);
    expect(azureCancellationError(E.Forbidden, '').message).toContain('额度');
    expect(azureCancellationError(E.TooManyRequests, '').message).toContain('F0');
    expect(azureCancellationError(E.TooManyRequests, '').retryable).toBe(true);
    expect(azureCancellationError(E.ServiceTimeout, '').message).toContain('超时');
    const net = azureCancellationError(E.ConnectionFailure, 'Unable to contact server. StatusCode: 1006');
    expect(net.message).toContain('网络');
    expect(net.retryable).toBe(true);
    // A refused WebSocket upgrade reported as a connection failure is shown as what it is.
    expect(azureCancellationError(E.ConnectionFailure, 'Unexpected server response: 401').message).toContain('Key 或区域不正确');
  });

  it('mirrors the Speech SDK enum values', async () => {
    const real = await import('microsoft-cognitiveservices-speech-sdk');
    for (const [name, value] of Object.entries(AZURE_CANCELLATION_ERROR_CODE)) {
      expect(real.CancellationErrorCode[name as keyof typeof real.CancellationErrorCode]).toBe(value);
    }
    for (const [name, value] of Object.entries(AZURE_CANCELLATION_REASON)) {
      expect(real.CancellationReason[name as keyof typeof real.CancellationReason]).toBe(value);
    }
    for (const [name, value] of Object.entries(AZURE_RESULT_REASON)) {
      expect(real.ResultReason[name as keyof typeof real.ResultReason]).toBe(value);
    }
    expect(typeof real.PropertyId.Speech_SegmentationSilenceTimeoutMs).toBe('number');
    expect(typeof real.PropertyId.Recognizer_StopTimeoutMs).toBe('number');
  });

  it('re-exports everything from the index', () => {
    expect(azureIndex.AzureAsr).toBe(AzureAsr);
    expect(azureIndex.AzureTts).toBe(AzureTts);
    expect(azureIndex.ttsUrl).toBe(ttsUrl);
  });
});

// ---------------------------------------------------------------- TTS

describe('azure tts', () => {
  it('escapes XML special characters', () => {
    expect(escapeXml(`a & b < c > d " e ' f`)).toBe('a &amp; b &lt; c &gt; d &quot; e &apos; f');
    expect(escapeXml('x\u0001y\u000bz')).toBe('xyz'); // characters XML 1.0 forbids are dropped
    expect(escapeXml('第一行\n第二行')).toBe('第一行\n第二行');
  });

  it('turns the speed factor into a prosody rate', () => {
    expect(prosodyRate(1)).toBe('+0%');
    expect(prosodyRate(1.2)).toBe('+20%');
    expect(prosodyRate(0.9)).toBe('-10%');
    expect(prosodyRate(1.35)).toBe('+35%');
    expect(prosodyRate(Number.NaN)).toBe('+0%');
    expect(prosodyRate(5)).toBe('+100%');
  });

  it('builds SSML with voice, language and escaped text', () => {
    expect(buildSsml(`Tom & Jerry <"hola"> 'ok'`, 'es-MX', 'es-MX-DaliaNeural', 1.2)).toBe(
      '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="es-MX">' +
        '<voice name="es-MX-DaliaNeural"><prosody rate="+20%">Tom &amp; Jerry &lt;&quot;hola&quot;&gt; &apos;ok&apos;</prosody></voice></speak>',
    );
    // HD voices do not support a rate.
    expect(buildSsml('hola', 'es-ES', 'es-ES-Ximena:DragonHDLatestNeural', 1.2)).not.toContain('prosody');
  });

  it('decodes little-endian PCM across chunk boundaries', () => {
    const d = new PcmByteDecoder();
    expect([...d.push(new Uint8Array([0x01, 0x00, 0x02]))]).toEqual([1]);
    expect(d.pending).toBe(true);
    expect([...d.push(new Uint8Array([]))]).toEqual([]);
    expect([...d.push(new Uint8Array([0x00, 0xfe, 0xff, 0xff]))]).toEqual([2, -2]);
    expect([...d.push(new Uint8Array([0x7f]))]).toEqual([32767]);
    expect(d.pending).toBe(false);
  });

  it('posts SSML with the documented headers and streams 24 kHz PCM', async () => {
    const chunks = [
      [0x01, 0x00, 0x02], // sample 1, then half of sample 2
      [0x00, 0xfe, 0xff, 0xff, 0x7f], // rest of 2, then -2, 32767
    ];
    const ctx = fakeContext(() => {
      let i = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(c) {
          if (i < chunks.length) c.enqueue(new Uint8Array(chunks[i++]!));
          else c.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'audio/x-wav' } });
    });
    const tts = new AzureTts({ key: KEY, region: 'eastasia' }, ctx);
    const parts: { samples: Int16Array; sampleRate: number }[] = [];
    for await (const c of tts.synthesize({ text: 'Hola & adiós', lang: 'es-MX', rate: 1.2 })) parts.push(c);

    expect(parts.map((p) => [...p.samples])).toEqual([[1], [2, -2, 32767]]);
    expect(parts.every((p) => p.sampleRate === 24000)).toBe(true);
    expect(ctx.requests).toHaveLength(1);
    const { url, init } = ctx.requests[0]!;
    expect(url).toBe('https://eastasia.tts.speech.microsoft.com/cognitiveservices/v1');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'Ocp-Apim-Subscription-Key': KEY,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'raw-24khz-16bit-mono-pcm',
      'User-Agent': 'meeting-interpreter',
    });
    expect(init.body).toBe(buildSsml('Hola & adiós', 'es-MX', 'es-MX-DaliaNeural', 1.2));
  });

  it('uses the China host, the requested voice, and falls back from foreign voice ids', async () => {
    const ctx = fakeContext(() => new Response(new Uint8Array([1, 0, 2, 0])));
    const tts = new AzureTts({ key: KEY, region: 'chinaeast2' }, ctx);
    const pcm = await collectPcm(tts.synthesize({ text: '你好', lang: 'zh-CN', voice: 'zh-CN-YunxiNeural', rate: 1 }));
    expect([...pcm.samples]).toEqual([1, 2]);
    expect(pcm.sampleRate).toBe(24000);
    expect(ctx.requests[0]!.url).toBe('https://chinaeast2.tts.speech.azure.cn/cognitiveservices/v1');
    expect(String(ctx.requests[0]!.init.body)).toContain('<voice name="zh-CN-YunxiNeural"><prosody rate="+0%">你好</prosody>');
    // A voice id from another provider (e.g. DashScope's "Cherry") is replaced by the default.
    await collectPcm(tts.synthesize({ text: 'hola', lang: 'es-ES', voice: 'Cherry', rate: 1 }));
    expect(String(ctx.requests[1]!.init.body)).toContain('<voice name="es-ES-ElviraNeural">');
  });

  it('reports 401 as a Chinese key/region error', async () => {
    const ctx = fakeContext(() => new Response('', { status: 401 }));
    const tts = new AzureTts({ key: KEY, region: 'eastasia' }, ctx);
    const err = await collectPcm(tts.synthesize({ text: 'hola', lang: 'es-ES', rate: 1 })).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toContain('401');
    expect(err.message).toMatch(/Key 无效/);
    expect(err.status).toBe(401);
    expect(err.retryable).toBe(false);
    expect(ctx.requests).toHaveLength(1); // 401 is not retried
  });

  it('needs a key and skips empty text', async () => {
    const ctx = fakeContext();
    await expect(collectPcm(new AzureTts({ key: '', region: 'eastasia' }, ctx).synthesize({ text: 'hola', lang: 'es-ES', rate: 1 }))).rejects.toThrow(
      /Key/,
    );
    const pcm = await collectPcm(new AzureTts({ key: KEY, region: 'eastasia' }, ctx).synthesize({ text: '  ', lang: 'es-ES', rate: 1 }));
    expect(pcm.samples.length).toBe(0);
    expect(ctx.requests).toHaveLength(0);
  });

  it('stops promptly with an AbortError when aborted mid-stream', async () => {
    const ctx = fakeContext(() => {
      let sent = false;
      const stream = new ReadableStream<Uint8Array>({
        pull(c) {
          if (!sent) {
            sent = true;
            c.enqueue(new Uint8Array([5, 0, 6, 0]));
          }
          // then never sends anything else
        },
      });
      return new Response(stream);
    });
    const ac = new AbortController();
    const it = new AzureTts({ key: KEY, region: 'eastasia' }, ctx).synthesize({ text: 'hola', lang: 'es-ES', rate: 1, signal: ac.signal })[Symbol.asyncIterator]();
    const first = await it.next();
    expect([...first.value!.samples]).toEqual([5, 6]);
    const pending = it.next();
    ac.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('offers voices for a language, falling back to the base language', () => {
    const tts = new AzureTts({ key: KEY, region: 'eastasia' }, fakeContext());
    expect(tts.voices('es-MX').map((v) => v.id)).toEqual(['es-MX-DaliaNeural', 'es-MX-JorgeNeural']);
    expect(tts.voices('es-419').map((v) => v.id)).toEqual(['es-ES-ElviraNeural', 'es-ES-AlvaroNeural']);
    expect(tts.voices('zh-TW')[0]!.id).toBe('zh-CN-XiaoxiaoNeural');
    expect(tts.voices('fr-FR')).toEqual([]);
  });
});

// ---------------------------------------------------------------- ASR

describe('azure asr event mapping', () => {
  it('converts 100 ns ticks to seconds', () => {
    expect(ticksToSeconds(15_000_000)).toBe(1.5);
    expect(ticksToSeconds(12_345_678)).toBe(1.235);
    expect(ticksToSeconds(0)).toBe(0);
  });

  it('maps recognizing, recognized and canceled', () => {
    expect(mapRecognizing({ text: ' hola ' })).toEqual({ text: 'hola' });
    expect(mapRecognizing({ text: '' })).toBeNull();
    expect(mapRecognized({ reason: AZURE_RESULT_REASON.RecognizedSpeech, text: '你好。', offset: 15_000_000, duration: 25_000_000 })).toEqual({
      text: '你好。',
      start: 1.5,
      end: 4,
    });
    expect(mapRecognized({ reason: AZURE_RESULT_REASON.NoMatch, text: '', offset: 0, duration: 0 })).toBeNull();
    expect(mapRecognized({ reason: AZURE_RESULT_REASON.RecognizedSpeech, text: '  ', offset: 0, duration: 0 })).toBeNull();
    expect(mapCanceled({ reason: AZURE_CANCELLATION_REASON.EndOfStream, errorCode: 0, errorDetails: '' })).toBeNull();
    const err = mapCanceled({ reason: AZURE_CANCELLATION_REASON.Error, errorCode: AZURE_CANCELLATION_ERROR_CODE.Forbidden, errorDetails: 'quota' });
    expect(err).toBeInstanceOf(ProviderError);
    expect(err!.message).toContain('Azure 语音识别');
    expect(err!.status).toBe(403);
  });

  it('cleans the phrase list and caps it', () => {
    expect(phraseList([' 华为 ', '华为', '', 'Mate  60', '  '])).toEqual(['华为', 'Mate 60']);
    const many = Array.from({ length: MAX_PHRASES + 50 }, (_, i) => `term${i}`);
    expect(phraseList(many)).toHaveLength(MAX_PHRASES);
  });
});

describe('azure asr session (fake SDK)', () => {
  it('builds the config with fromSubscription, language, segmentation timeout, push stream and phrase list', async () => {
    const { session, state, recognizer } = await startSession({ key: KEY, region: 'East Asia' }, createFakeSdk(), 'es-MX', ['Huawei', ' Huawei ', 'Mate 60', '']);
    const cfg = state.configs[0]!;
    expect(cfg.kind).toBe('subscription');
    expect(cfg.key).toBe(KEY);
    expect(cfg.region).toBe('eastasia');
    expect(cfg.speechRecognitionLanguage).toBe('es-MX');
    expect(cfg.props.get(31)).toBe('500'); // Speech_SegmentationSilenceTimeoutMs
    expect(cfg.props.get(67)).toBe(String(END_TIMEOUT_MS)); // Recognizer_StopTimeoutMs
    expect(state.formats).toEqual([{ rate: 16000, bits: 16, channels: 1 }]);
    expect(recognizer.audio.stream).toBe(state.streams[0]);
    expect(state.phrases).toEqual([['Huawei', 'Mate 60']]);
    expect(recognizer.startCalls).toBe(1);
    session.close();
  });

  it('uses fromEndpoint when an endpoint is configured and sets the Chinese language code', async () => {
    const { session, state } = await startSession({ key: KEY, region: 'chinaeast2', endpoint: 'https://myres.cognitiveservices.azure.cn' }, createFakeSdk(), 'zh-CN');
    const cfg = state.configs[0]!;
    expect(cfg.kind).toBe('endpoint');
    expect(cfg.endpoint).toBeInstanceOf(URL);
    expect(cfg.endpoint!.href).toBe('https://myres.cognitiveservices.azure.cn/');
    expect(cfg.key).toBe(KEY);
    expect(cfg.speechRecognitionLanguage).toBe('zh-CN');
    expect(state.phrases).toEqual([]); // no hot words → no phrase list
    session.close();
  });

  it('maps SDK events to partial / final / error + closed', async () => {
    const { session, recognizer } = await startSession();
    const events = record(session);
    recognizer.fireRecognizing('hola a');
    recognizer.fireRecognized('Hola a todos.', 15_000_000, 25_000_000);
    recognizer.fireRecognized('', 41_000_000, 1_000_000, AZURE_RESULT_REASON.NoMatch); // silence: ignored
    recognizer.fireCanceled(AZURE_CANCELLATION_REASON.EndOfStream, 0, ''); // not an error
    recognizer.fireCanceled(
      AZURE_CANCELLATION_REASON.Error,
      AZURE_CANCELLATION_ERROR_CODE.AuthenticationFailure,
      `WebSocket upgrade failed: Authentication error (401). wss://x/?Ocp-Apim-Subscription-Key=${KEY}`,
    );
    expect(events.map(([type]) => type)).toEqual(['partial', 'final', 'error', 'closed']);
    expect(events[0]![1]).toEqual({ text: 'hola a' });
    expect(events[1]![1]).toEqual({ text: 'Hola a todos.', start: 1.5, end: 4 });
    const { error, fatal } = events[2]![1];
    expect(fatal).toBe(true);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.message).toMatch(/^Azure 语音识别：Key 或区域不正确/);
    expect(error.message).toContain('401');
    expect(error.message).not.toContain(KEY);
    // After closing: SDK objects released, later events ignored.
    await waitFor(() => recognizer.closeCalls === 1);
    expect(recognizer.stopCalls).toBe(1);
    recognizer.fireRecognized('late', 0, 1);
    recognizer.fireSessionStopped();
    expect(events).toHaveLength(4);
  });

  it('pushes PCM as little-endian bytes', async () => {
    const { session, stream } = await startSession();
    session.push(new Int16Array([1, -2, 0x1234]));
    session.push(new Int16Array(0)); // nothing to send
    expect(stream.writes).toHaveLength(1);
    expect(stream.writes[0]).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(stream.writes[0]!)]).toEqual([0x01, 0x00, 0xfe, 0xff, 0x34, 0x12]);
    session.close();
  });

  it('end() closes the stream, delivers the last result, stops and closes once', async () => {
    const { session, recognizer, stream } = await startSession();
    const events = record(session);
    const ended = session.end();
    expect(stream.closed).toBe(true);
    recognizer.fireRecognized('Última frase.', 10_000_000, 5_000_000); // flushed audio still recognised
    await ended;
    expect(events.map(([type]) => type)).toEqual(['final', 'closed']);
    expect(events[0]![1].text).toBe('Última frase.');
    expect(recognizer.stopCalls).toBe(1);
    await waitFor(() => recognizer.closeCalls === 1);
    // Further calls are harmless no-ops.
    session.push(new Int16Array([1, 2]));
    expect(stream.writes).toHaveLength(0);
    await session.end();
    session.close();
    expect(events.filter(([type]) => type === 'closed')).toHaveLength(1);
    expect(recognizer.closeCalls).toBe(1);
  });

  it('end() gives up after 5 s when the service never ends the session', async () => {
    const { session, recognizer } = await startSession(undefined, createFakeSdk({ stopOnStreamClose: false }));
    const events = record(session);
    vi.useFakeTimers();
    let done = false;
    const ended = session.end().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(END_TIMEOUT_MS - 100);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    await ended;
    expect(events.map(([type]) => type)).toEqual(['closed']);
    await vi.advanceTimersByTimeAsync(10);
    expect(recognizer.stopCalls).toBe(1);
    expect(recognizer.closeCalls).toBe(1);
  });

  it('close() stops immediately and emits closed once', async () => {
    const { session, recognizer, stream } = await startSession();
    const events = record(session);
    session.close();
    session.close();
    expect(stream.closed).toBe(true);
    expect(events).toEqual([['closed', { reason: 'close' }]]);
    await waitFor(() => recognizer.closeCalls === 1);
    recognizer.fireRecognizing('late');
    expect(events).toHaveLength(1);
  });

  it('an unexpected end of session from the service closes the session', async () => {
    const { session, recognizer } = await startSession();
    const events = record(session);
    recognizer.fireSessionStopped();
    expect(events).toEqual([['closed', { reason: 'session-stopped' }]]);
  });

  it('start() rejects with a ProviderError when recognition cannot start', async () => {
    const fake = createFakeSdk({ startError: `connection refused key=${KEY}` });
    const asr = new AzureAsr({ key: KEY, region: 'eastasia' }, fakeContext(), fake.sdk);
    const err = await asr.start({ lang: 'zh-CN', hotwords: [], sampleRate: 16000 }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toContain('启动识别失败');
    expect(err.message).not.toContain(KEY);
    await waitFor(() => fake.state.recognizers[0]!.closeCalls === 1);
  });

  it('start() rejects when the connection is canceled while starting', async () => {
    const fake = createFakeSdk({
      cancelDuringStart: { errorCode: AZURE_CANCELLATION_ERROR_CODE.ConnectionFailure, errorDetails: 'Unable to contact server. StatusCode: 1006' },
    });
    const asr = new AzureAsr({ key: KEY, region: 'eastasia' }, fakeContext(), fake.sdk);
    const err = await asr.start({ lang: 'es-ES', hotwords: [], sampleRate: 16000 }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toContain('无法连接 Azure 语音服务');
    expect(err.retryable).toBe(true);
    await waitFor(() => fake.state.recognizers[0]!.closeCalls === 1);
  });

  it('start() rejects without a key or a region', async () => {
    const fake = createFakeSdk();
    await expect(new AzureAsr({ key: '', region: 'eastasia' }, fakeContext(), fake.sdk).start({ lang: 'zh-CN', hotwords: [], sampleRate: 16000 })).rejects.toThrow(
      /请先填写 Azure 语音 Key/,
    );
    await expect(new AzureAsr({ key: KEY, region: ' ' }, fakeContext(), fake.sdk).start({ lang: 'zh-CN', hotwords: [], sampleRate: 16000 })).rejects.toThrow(
      /区域/,
    );
    expect(fake.state.recognizers).toHaveLength(0);
  });
});

describe('azure asr with the real SDK (local server, no internet)', () => {
  it('reports a refused handshake (HTTP 401) quickly as a key/region error instead of hanging', async () => {
    // Node's built-in WebSocket never fires `close` for a failed handshake; the provider makes the
    // SDK use its `ws` transport in Node so this surfaces as an error.
    const server = createServer((_req, res) => {
      res.writeHead(401);
      res.end();
    });
    server.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    try {
      const { port } = server.address() as AddressInfo;
      const endpoint = `ws://127.0.0.1:${port}/speech/recognition/conversation/cognitiveservices/v1`;
      const asr = new AzureAsr({ key: KEY, region: 'eastasia', endpoint }, fakeContext());
      const startedAt = Date.now();
      const err = await asr.start({ lang: 'zh-CN', hotwords: ['华为'], sampleRate: 16000 }).catch((e) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.status).toBe(401);
      expect(err.retryable).toBe(false);
      expect(err.message).toContain('Key 或区域不正确');
      expect(err.message).not.toContain(KEY);
      expect(Date.now() - startedAt).toBeLessThan(5000);
    } finally {
      server.close();
    }
  });
});
