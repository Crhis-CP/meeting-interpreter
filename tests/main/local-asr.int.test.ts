import { beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { concatInt16, resampleInt16, silence, tone } from '@core/audio/pcm';
import { decodeWav, toMono } from '@core/audio/wav';
import { ProviderError, type AsrEvents, type AsrSession } from '@core/providers/types';
import { LocalAsr, type WorkerHandle } from '../../src/main/providers/local-asr/client';
import { ModelManager, type DownloadProgress } from '../../src/main/providers/local-asr/model-manager';
import { MODEL_BASE_URLS, type ForeignModelId, type WhisperModelId } from '../../src/main/providers/local-asr/models';
import {
  cleanText,
  LocalRecognizer,
  loadSherpaOnnx,
  PRE_ROLL_SECONDS,
  VAD_WINDOW,
  type ModelLocator,
  type SherpaOfflineRecognizerConfig,
  type SherpaOnnxModule,
  type SherpaSpeechSegment,
  type SherpaVadConfig,
} from '../../src/main/providers/local-asr/recognizer';
import { attachWorker, createInProcessWorker } from '../../src/main/providers/local-asr/worker';

// ------------------------------------------------------------------ a fake sherpa-onnx (energy VAD, canned text)

const fake = {
  vadConfigs: [] as SherpaVadConfig[],
  asrConfigs: [] as SherpaOfflineRecognizerConfig[],
  frontArgs: [] as (boolean | undefined)[],
  windowSizes: new Set<number>(),
};

class FakeVad {
  private segments: SherpaSpeechSegment[] = [];
  private pos = 0;
  private start = -1;
  private buf: number[] = [];
  private quiet = 0;
  constructor(config: SherpaVadConfig) {
    fake.vadConfigs.push(config);
  }
  acceptWaveform(s: Float32Array): void {
    fake.windowSizes.add(s.length);
    let e = 0;
    for (const x of s) e += x * x;
    const loud = Math.sqrt(e / s.length) > 0.05;
    if (loud && this.start < 0) this.start = this.pos;
    if (this.start >= 0) {
      for (const x of s) this.buf.push(x);
      this.quiet = loud ? 0 : this.quiet + s.length;
      if (this.quiet >= 0.5 * 16000) this.close();
    }
    this.pos += s.length;
  }
  private close(): void {
    this.segments.push({ start: this.start, samples: Float32Array.from(this.buf.slice(0, this.buf.length - this.quiet)) });
    this.start = -1;
    this.buf = [];
    this.quiet = 0;
  }
  isEmpty(): boolean {
    return this.segments.length === 0;
  }
  front(enableExternalBuffer?: boolean): SherpaSpeechSegment {
    fake.frontArgs.push(enableExternalBuffer);
    return this.segments[0]!;
  }
  pop(): void {
    this.segments.shift();
  }
  flush(): void {
    if (this.start >= 0) this.close();
  }
  reset(): void {}
}

class FakeRecognizer {
  constructor(private readonly config: SherpaOfflineRecognizerConfig) {
    fake.asrConfigs.push(config);
  }
  createStream() {
    const stream = {
      samples: new Float32Array(0) as Float32Array,
      acceptWaveform(w: { samples: Float32Array; sampleRate: number }) {
        stream.samples = w.samples;
      },
    };
    return stream;
  }
  decode(): void {}
  getResult(stream: { samples: Float32Array }) {
    const seconds = (stream.samples.length / 16000).toFixed(1);
    return { text: this.config.modelConfig.senseVoice ? ` 你好 ${seconds} ` : `hola ${seconds}` };
  }
}

const fakeSherpa = { Vad: FakeVad, OfflineRecognizer: FakeRecognizer } as unknown as SherpaOnnxModule;
const allReady: ModelLocator = { status: () => 'ready', pathOf: (id, file) => `/models/${id}/${file}` };

/** 1 s tone, 1 s silence, 0.8 s tone (no trailing silence: only flush() can close it). */
function twoSentences(): Int16Array {
  return concatInt16([tone(1, 300, 16000, 0.5), silence(1, 16000), tone(0.8, 300, 16000, 0.5)]);
}

function feedChunks(pcm: Int16Array, feed: (c: Int16Array) => void, size = 1600): void {
  for (let i = 0; i < pcm.length; i += size) feed(pcm.subarray(i, i + size));
}

describe('LocalRecognizer (fake sherpa-onnx)', () => {
  it('feeds the VAD 512-sample windows, decodes each sentence with 0.2 s of lead-in and reports times', () => {
    const finals: [string, number, number][] = [];
    const rec = new LocalRecognizer({ sherpa: fakeSherpa, lang: 'zh-CN', models: allReady, onFinal: (t, s, e) => finals.push([t, s, e]) });
    feedChunks(twoSentences(), (c) => rec.feed(c), 1000);
    expect(finals).toHaveLength(1);
    rec.flush();
    // The second sentence gets 0.2 s of the audio before it (PRE_ROLL_SECONDS); the first has nothing before it.
    expect(finals.map((f) => f[0])).toEqual(['你好 1.0', '你好 1.0']);
    expect(finals[0]![1]).toBeCloseTo(0, 1);
    expect(finals[0]![2]).toBeCloseTo(1, 1);
    expect(finals[1]![1]).toBeCloseTo(2 - PRE_ROLL_SECONDS, 1);
    expect(finals[1]![2]).toBeCloseTo(2.8, 1);
    expect([...fake.windowSizes]).toEqual([VAD_WINDOW]);
    expect(fake.frontArgs.every((a) => a === false)).toBe(true); // no external buffers (Electron)
    expect(fake.vadConfigs.at(-1)).toMatchObject({
      sileroVad: { model: '/models/silero-vad/silero_vad.onnx', windowSize: 512, threshold: 0.5, minSilenceDuration: 0.5 },
      sampleRate: 16000,
    });
    expect(fake.asrConfigs.at(-1)).toMatchObject({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        senseVoice: { model: '/models/sensevoice/model.int8.onnx', language: 'zh', useInverseTextNormalization: 1 },
        tokens: '/models/sensevoice/tokens.txt',
      },
    });
  });

  it('uses Parakeet for Spanish and English (a NeMo transducer that recognises the language itself)', () => {
    for (const lang of ['es-AR', 'en-US']) {
      const rec = new LocalRecognizer({ sherpa: fakeSherpa, lang, models: allReady, onFinal: () => undefined });
      expect(rec.model).toBe('parakeet-v3');
      expect(fake.asrConfigs.at(-1)!.modelConfig).toMatchObject({
        transducer: { encoder: '/models/parakeet-v3/encoder.int8.onnx', decoder: '/models/parakeet-v3/decoder.int8.onnx', joiner: '/models/parakeet-v3/joiner.int8.onnx' },
        modelType: 'nemo_transducer',
        tokens: '/models/parakeet-v3/tokens.txt',
      });
    }
  });

  it('until Parakeet is downloaded, a Whisper model an earlier version downloaded stands in (small, else base)', () => {
    const noParakeet: ModelLocator = { status: (id) => (id === 'parakeet-v3' ? 'missing' : 'ready'), pathOf: allReady.pathOf };
    expect(new LocalRecognizer({ sherpa: fakeSherpa, lang: 'es-MX', models: noParakeet, onFinal: () => undefined }).model).toBe('whisper-small');
    const onlyBase: ModelLocator = { status: (id) => (id === 'whisper-base' || id === 'silero-vad' ? 'ready' : 'missing'), pathOf: allReady.pathOf };
    const rec = new LocalRecognizer({ sherpa: fakeSherpa, lang: 'es-MX', models: onlyBase, onFinal: () => undefined });
    expect(rec.model).toBe('whisper-base');
    expect(fake.asrConfigs.at(-1)!.modelConfig).toMatchObject({
      whisper: { encoder: '/models/whisper-base/base-encoder.int8.onnx', decoder: '/models/whisper-base/base-decoder.int8.onnx', language: 'es', task: 'transcribe' },
      tokens: '/models/whisper-base/base-tokens.txt',
    });
    expect(new LocalRecognizer({ sherpa: fakeSherpa, lang: 'es-ES', models: allReady, esModel: 'whisper-small', onFinal: () => undefined }).model).toBe('whisper-small');
  });

  it('Whisper gets 6 s stretches and the threads asked for; SenseVoice keeps 10 s and at most 2 threads', () => {
    new LocalRecognizer({ sherpa: fakeSherpa, lang: 'es-AR', models: allReady, numThreads: 4, onFinal: () => undefined });
    expect(fake.vadConfigs.at(-1)!.sileroVad).toMatchObject({ maxSpeechDuration: 6 });
    expect(fake.asrConfigs.at(-1)!.modelConfig).toMatchObject({ numThreads: 4 });
    new LocalRecognizer({ sherpa: fakeSherpa, lang: 'zh-CN', models: allReady, numThreads: 4, onFinal: () => undefined });
    expect(fake.vadConfigs.at(-1)!.sileroVad).toMatchObject({ maxSpeechDuration: 10 });
    expect(fake.asrConfigs.at(-1)!.modelConfig).toMatchObject({ numThreads: 2 });
  });

  it('cleans results and drops Whisper’s inventions on silence', () => {
    expect(cleanText('  Hola   a todos ', 'es')).toBe('Hola a todos');
    expect(cleanText('Subtítulos realizados por la comunidad de Amara.org', 'es')).toBe('');
    expect(cleanText('(Música)', 'es')).toBe('');
    expect(cleanText('。', 'zh')).toBe('');
    expect(cleanText('开放时间早上9点至下午5点。', 'zh')).toBe('开放时间早上9点至下午5点。');
  });

  it('refuses to start without the models, in Chinese', () => {
    const none: ModelLocator = { status: () => 'missing', pathOf: allReady.pathOf };
    expect(() => new LocalRecognizer({ sherpa: fakeSherpa, lang: 'zh-CN', models: none, onFinal: () => undefined })).toThrow(/还没有下载.*Silero VAD.*SenseVoice/);
  });
});

// ------------------------------------------------------------------ client <-> worker protocol

function collect(session: AsrSession) {
  const got = { finals: [] as AsrEvents['final'][], errors: [] as AsrEvents['error'][], closed: [] as AsrEvents['closed'][] };
  session.events.on('final', (f) => got.finals.push(f));
  session.events.on('error', (e) => got.errors.push(e));
  session.events.on('closed', (c) => got.closed.push(c));
  return got;
}

/** A worker the test drives by hand. */
function manualWorker() {
  const fns = { message: [] as ((m: unknown) => void)[], exit: [] as ((c: number) => void)[] };
  const sent: any[] = [];
  const kill = vi.fn();
  const handle: WorkerHandle = {
    postMessage: (m) => sent.push(m),
    on: (ev: 'message' | 'exit', fn: (x: any) => void) => {
      fns[ev].push(fn);
    },
    kill,
  };
  return { handle, sent, kill, reply: (m: unknown) => fns.message.forEach((f) => f(m)), exit: (c: number) => fns.exit.forEach((f) => f(c)) };
}

const START = { lang: 'es-MX', hotwords: [], sampleRate: 16000 as const };

describe('LocalAsr ↔ worker', () => {
  it('starts the worker, streams PCM, emits finals and closes after end()', async () => {
    const asr = new LocalAsr({
      modelsDir: '/models',
      esModel: 'whisper-base',
      spawn: () => createInProcessWorker({ loadSherpa: () => fakeSherpa, createModels: () => allReady }),
    });
    expect(asr.id).toBe('local');
    const session = await asr.start(START);
    const got = collect(session);
    feedChunks(twoSentences(), (c) => session.push(c));
    await session.end();
    expect(got.finals.map((f) => f.text)).toEqual(['hola 1.0', 'hola 1.0']);
    expect(got.finals[1]!.start).toBeCloseTo(2 - PRE_ROLL_SECONDS, 1);
    expect(got.errors).toEqual([]);
    expect(got.closed).toEqual([{ reason: 'ended' }]);
    expect(fake.asrConfigs.at(-1)!.modelConfig.whisper!.encoder).toContain('whisper-base');
    session.push(tone(0.1, 300, 16000)); // ignored after close
    await session.end();
  });

  it('rejects start() with the worker’s Chinese message when models are missing', async () => {
    const asr = new LocalAsr({
      modelsDir: '/nowhere',
      spawn: () => createInProcessWorker({ loadSherpa: () => fakeSherpa, createModels: () => ({ ...allReady, status: () => 'missing' }) }),
    });
    const err = await asr.start({ ...START, lang: 'zh-CN' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as Error).message).toMatch(/本机离线识别模型还没有下载/);
  });

  it('sends start with language, models dir and Spanish model; PCM as an exact ArrayBuffer copy', async () => {
    const w = manualWorker();
    const asr = new LocalAsr({ modelsDir: '/m', esModel: 'whisper-base', numThreads: 3, spawn: () => w.handle });
    queueMicrotask(() => w.reply({ type: 'ready' }));
    const session = await asr.start(START);
    expect(w.sent[0]).toEqual({ type: 'start', lang: 'es-MX', modelsDir: '/m', esModel: 'whisper-base', numThreads: 3 });
    const big = new Int16Array([9, 9, 1, -2, 3, 9]);
    session.push(big.subarray(2, 5));
    expect(w.sent[1].type).toBe('pcm');
    expect(w.sent[1].data).toBeInstanceOf(ArrayBuffer);
    expect([...new Int16Array(w.sent[1].data)]).toEqual([1, -2, 3]);
    session.close();
    expect(w.kill).toHaveBeenCalled();
  });

  it('turns a worker crash into a fatal error and closes', async () => {
    const w = manualWorker();
    const asr = new LocalAsr({ modelsDir: '/m', spawn: () => w.handle });
    queueMicrotask(() => w.reply({ type: 'ready' }));
    const session = await asr.start(START);
    const got = collect(session);
    w.reply({ type: 'final', text: 'hola', start: 0.5, end: 1.2 });
    w.exit(1);
    expect(got.finals).toEqual([{ text: 'hola', start: 0.5, end: 1.2 }]);
    expect(got.errors).toHaveLength(1);
    expect(got.errors[0]!.fatal).toBe(true);
    expect(got.errors[0]!.error.message).toContain('意外退出（退出码 1）');
    expect(got.closed).toHaveLength(1);
    expect(w.kill).toHaveBeenCalled();
  });

  it('treats an error message from the worker as fatal', async () => {
    const w = manualWorker();
    const asr = new LocalAsr({ modelsDir: '/m', spawn: () => w.handle });
    queueMicrotask(() => w.reply({ type: 'ready' }));
    const session = await asr.start(START);
    const got = collect(session);
    w.reply({ type: 'error', message: '解码失败' });
    expect(got.errors.map((e) => [e.error.message, e.fatal])).toEqual([['解码失败', true]]);
    expect(got.closed).toEqual([{ reason: '解码失败' }]);
  });

  it('end() gives up waiting after endTimeoutMs; start() fails on early exit or ready timeout', async () => {
    const w = manualWorker();
    const asr = new LocalAsr({ modelsDir: '/m', spawn: () => w.handle, endTimeoutMs: 30 });
    queueMicrotask(() => w.reply({ type: 'ready' }));
    const session = await asr.start(START);
    const got = collect(session);
    await session.end();
    expect(w.sent.at(-1)).toEqual({ type: 'end' });
    expect(got.closed).toEqual([{ reason: 'ended' }]);

    const dead = manualWorker();
    queueMicrotask(() => dead.exit(3));
    await expect(new LocalAsr({ modelsDir: '/m', spawn: () => dead.handle }).start(START)).rejects.toThrow('启动失败（退出码 3）');

    const slow = manualWorker();
    await expect(new LocalAsr({ modelsDir: '/m', spawn: () => slow.handle, readyTimeoutMs: 30 }).start(START)).rejects.toThrow('加载超时');
    expect(slow.kill).toHaveBeenCalled();

    await expect(new LocalAsr({ modelsDir: '/m', spawn: () => { throw new Error('no fork'); } }).start(START)).rejects.toThrow('无法启动本机识别进程');
  });

  it('the worker answers on its port and ignores PCM before start', () => {
    const replies: unknown[] = [];
    let listener: (e: { data: unknown }) => void = () => undefined;
    attachWorker({ on: (_e, fn) => (listener = fn), postMessage: (m) => replies.push(m) }, { loadSherpa: () => fakeSherpa, createModels: () => allReady });
    listener({ data: { type: 'pcm', data: new ArrayBuffer(8) } });
    listener({ data: { type: 'start', lang: 'zh-CN', modelsDir: '/m' } });
    listener({ data: { type: 'pcm', data: twoSentences().buffer } });
    listener({ data: { type: 'end' } });
    expect(replies.map((r) => (r as { type: string }).type)).toEqual(['ready', 'final', 'final', 'ended']);
  });
});

// ------------------------------------------------------------------ real models (opt-in: MI_MODELS_DIR=/path)

const MODELS_DIR = process.env.MI_MODELS_DIR;
const TEST_WAVS = {
  zh: 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/test_wavs/zh.wav',
  es: 'csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/main/test_wavs/es.wav',
  en: 'csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/main/test_wavs/en.wav',
};

async function downloadIfMissing(urlPath: string, dest: string): Promise<void> {
  if (existsSync(dest) && statSync(dest).size > 1000) return;
  mkdirSync(dirname(dest), { recursive: true });
  let last: unknown;
  for (const base of MODEL_BASE_URLS) {
    try {
      const res = await fetch(`${base}/${urlPath}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      writeFileSync(dest, new Uint8Array(await res.arrayBuffer()));
      return;
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

function read16k(path: string): Int16Array {
  const wav = decodeWav(readFileSync(path));
  const mono = toMono(wav.samples, wav.channels);
  return wav.sampleRate === 16000 ? mono : resampleInt16(mono, wav.sampleRate, 16000);
}

function progressLogger(): (p: DownloadProgress) => void {
  let last = '';
  return (p) => {
    const line = `${p.id}/${p.file} ${Math.floor((p.received / p.total) * 10) * 10}%`;
    if (line !== last && (p.received === p.total || line.endsWith(' 0%') || line.endsWith('50%'))) console.log(`[models] ${line}`);
    last = line;
  };
}

function transcribe(sherpa: SherpaOnnxModule, models: ModelManager, lang: string, pcm: Int16Array, esModel?: ForeignModelId) {
  const t0 = performance.now();
  const finals: { text: string; start: number; end: number }[] = [];
  const rec = new LocalRecognizer({ sherpa, lang, models, esModel, onFinal: (text, start, end) => finals.push({ text, start, end }) });
  const loadMs = performance.now() - t0;
  const t1 = performance.now();
  feedChunks(pcm, (c) => rec.feed(c)); // 100 ms chunks, as the app streams them
  rec.flush();
  const decodeMs = performance.now() - t1;
  const audio = pcm.length / 16000;
  console.log(
    `[${rec.model}] load ${loadMs.toFixed(0)} ms; ${audio.toFixed(2)} s audio decoded in ${decodeMs.toFixed(0)} ms (RTF ${(decodeMs / 1000 / audio).toFixed(3)}): ${JSON.stringify(finals)}`,
  );
  return finals;
}

describe.skipIf(!MODELS_DIR)('offline recognition with real sherpa-onnx models', () => {
  let models: ModelManager;
  let sherpa: SherpaOnnxModule;

  beforeAll(async () => {
    models = new ModelManager(MODELS_DIR!);
    await models.ensureFor('zh', 'parakeet-v3', progressLogger());
    await models.ensureFor('es', 'parakeet-v3', progressLogger());
    for (const lang of ['zh', 'es', 'en'] as const) await downloadIfMissing(TEST_WAVS[lang], join(MODELS_DIR!, 'test_wavs', `${lang}.wav`));
    sherpa = loadSherpaOnnx();
    console.log(`[sherpa-onnx-node] version ${String(sherpa.version)}`);
  }, 30 * 60_000);

  it('transcribes Chinese speech with Silero VAD + SenseVoice', () => {
    const pcm = read16k(join(MODELS_DIR!, 'test_wavs', 'zh.wav'));
    const finals = transcribe(sherpa, models, 'zh-CN', pcm);
    const text = finals.map((f) => f.text).join('');
    expect(text).toMatch(/[一-鿿]{4,}/);
    expect(finals[0]!.start).toBeGreaterThanOrEqual(0);
    expect(finals.at(-1)!.end).toBeLessThanOrEqual(pcm.length / 16000 + 0.01);
  }, 120_000);

  it('works end to end through LocalAsr and the worker (in-process)', async () => {
    const pcm = read16k(join(MODELS_DIR!, 'test_wavs', 'zh.wav'));
    const asr = new LocalAsr({ modelsDir: MODELS_DIR!, spawn: () => createInProcessWorker() });
    const session = await asr.start({ lang: 'zh-CN', hotwords: [], sampleRate: 16000 });
    const got = collect(session);
    feedChunks(pcm, (c) => session.push(c));
    await session.end();
    expect(got.errors).toEqual([]);
    expect(got.finals.map((f) => f.text).join('')).toMatch(/[一-鿿]{4,}/);
    expect(got.closed).toEqual([{ reason: 'ended' }]);
  }, 120_000);

  it('reports the Chinese sentence while it is being spoken (partials before the final)', async () => {
    const pcm = read16k(join(MODELS_DIR!, 'test_wavs', 'zh.wav'));
    const asr = new LocalAsr({ modelsDir: MODELS_DIR!, spawn: () => createInProcessWorker() });
    const session = await asr.start({ lang: 'zh-CN', hotwords: [], sampleRate: 16000 });
    const events: string[] = [];
    session.events.on('partial', ({ text }) => events.push(`p:${text}`));
    session.events.on('final', ({ text }) => events.push(`f:${text}`));
    feedChunks(pcm, (c) => session.push(c));
    await session.end();
    console.log(events.join('\n'));
    const firstFinal = events.findIndex((e) => e.startsWith('f:'));
    expect(events.slice(0, firstFinal).filter((e) => e.startsWith('p:')).length).toBeGreaterThan(0);
  }, 120_000);

  it('transcribes Spanish and English with Silero VAD + Parakeet, and reports the sentence while it is spoken', async () => {
    const es = transcribe(sherpa, models, 'es-AR', read16k(join(MODELS_DIR!, 'test_wavs', 'es.wav')));
    expect(es.map((f) => f.text).join(' ')).toMatch(/no preguntes qu[eé] puede hacer tu pa[ií]s por ti,? pregunta qu[eé] puedes hacer t[uú] por tu pa[ií]s/i);
    const en = transcribe(sherpa, models, 'en-US', read16k(join(MODELS_DIR!, 'test_wavs', 'en.wav')));
    expect(en.map((f) => f.text).join(' ')).toMatch(/ask not what your country can do for you\.? ask what you can do for your country/i);
    // Through the worker, with partial results before the final (they let translation start early).
    const asr = new LocalAsr({ modelsDir: MODELS_DIR!, spawn: () => createInProcessWorker() });
    const session = await asr.start({ lang: 'es-AR', hotwords: [], sampleRate: 16000 });
    const events: string[] = [];
    session.events.on('partial', ({ text }) => events.push(`p:${text}`));
    session.events.on('final', ({ text }) => events.push(`f:${text}`));
    feedChunks(read16k(join(MODELS_DIR!, 'test_wavs', 'es.wav')), (c) => session.push(c));
    await session.end();
    console.log(events.join('\n'));
    const firstFinal = events.findIndex((e) => e.startsWith('f:'));
    expect(firstFinal).toBeGreaterThan(0);
    expect(events.slice(0, firstFinal).some((e) => e.startsWith('p:'))).toBe(true);
  }, 300_000);

  // The stand-in from earlier versions (base ≈ 161 MB, small ≈ 375 MB): opt in with MI_WHISPER=whisper-base|whisper-small.
  it.skipIf(!process.env.MI_WHISPER)(
    'transcribes Spanish speech with Silero VAD + Whisper',
    async () => {
      const esModel: WhisperModelId = process.env.MI_WHISPER === 'whisper-base' ? 'whisper-base' : 'whisper-small';
      await models.ensureFor('es', esModel, progressLogger());
      const wav = join(MODELS_DIR!, 'test_wavs', 'es.wav');
      await downloadIfMissing(TEST_WAVS.es, wav);
      const finals = transcribe(sherpa, models, 'es-ES', read16k(wav), esModel);
      expect(finals.map((f) => f.text).join(' ')).toMatch(/[a-záéíóúñ]{3,}/i);
    },
    30 * 60_000,
  );
});
