import { describe, expect, it } from 'vitest';
import { kokoroInput, sentences } from '../../src/core/speech-text/kokoro-input';
import type { PcmChunk } from '../../src/core/types';
import type { WorkerHandle } from '../../src/main/providers/local-asr/client';
import type { ParentPortLike } from '../../src/main/providers/local-asr/worker';
import { NeuralTts, type NeuralTtsOptions } from '../../src/main/providers/neural-tts/client';
import { NEURAL_VOICES, TTS_MODELS, neuralVoice } from '../../src/main/providers/neural-tts/models';
import { attachTtsWorker, kokoroConfig } from '../../src/main/providers/neural-tts/worker';

interface GenCall {
  text: string;
  sid: number;
  speed: number;
  phonemes?: string;
}

/** A stand-in for sherpa-onnx: one 0.1 s chunk per sentence (Chinese 。, or each phoneme entry). */
function fakeSherpa(opts: { calls: GenCall[]; configs: unknown[]; slow?: boolean; failLoad?: boolean }) {
  return () => ({
    OfflineTts: {
      createAsync: async (config: unknown) => {
        opts.configs.push(config);
        if (opts.failLoad) throw new Error('bad model file');
        return {
          sampleRate: 24000,
          generateAsync: async (req: { text: string; sid: number; speed: number; generationConfig?: { phonemeCodepoints?: number[][] }; onProgress?: (i: { samples: Float32Array; progress: number }) => number | boolean | void }) => {
            const phonemes = req.generationConfig?.phonemeCodepoints?.map((cps) => String.fromCodePoint(...cps)).join('|');
            opts.calls.push({ text: req.text, sid: req.sid, speed: req.speed, ...(phonemes ? { phonemes } : {}) });
            if (opts.slow) await new Promise(() => undefined); // never answers
            const parts = phonemes ? [phonemes] : req.text.split('。').filter(Boolean);
            let all = new Float32Array(0);
            for (const [i] of parts.entries()) {
              await new Promise((r) => setTimeout(r, 5));
              const samples = new Float32Array(2400).fill(0.5);
              all = samples;
              if (req.onProgress && !req.onProgress({ samples, progress: (i + 1) / parts.length })) break;
            }
            return { samples: all, sampleRate: 24000 };
          },
        };
      },
    },
  });
}

/** The worker in this process, with messages cloned and delivered asynchronously like real IPC. */
function inProcess(lib: ReturnType<typeof fakeSherpa>, sent: unknown[]): WorkerHandle & { exit(): void } {
  const messageFns: ((m: unknown) => void)[] = [];
  const exitFns: ((c: number) => void)[] = [];
  let portFn: ((e: { data: unknown }) => void) | null = null;
  let alive = true;
  const port: ParentPortLike = {
    on: (_e, l) => {
      portFn = l;
    },
    postMessage: (m) => setImmediate(() => alive && messageFns.forEach((f) => f(structuredClone(m)))),
  };
  const w = attachTtsWorker(port, lib as never);
  const exit = () => {
    if (!alive) return;
    alive = false;
    w.dispose();
    setImmediate(() => exitFns.forEach((f) => f(0)));
  };
  return {
    postMessage: (m) => {
      sent.push(m);
      setImmediate(() => alive && portFn?.({ data: structuredClone(m) }));
    },
    on: (ev: 'message' | 'exit', fn: (x: any) => void) => void (ev === 'message' ? messageFns : exitFns).push(fn),
    kill: exit,
    exit,
  };
}

function setup(over: Partial<NeuralTtsOptions> = {}, fake: { slow?: boolean; failLoad?: boolean } = {}) {
  const calls: GenCall[] = [];
  const configs: unknown[] = [];
  const sent: unknown[] = [];
  const workers: ReturnType<typeof inProcess>[] = [];
  const tts = new NeuralTts({
    dir: (m) => `/models/${m}`,
    ready: () => true,
    threads: 4,
    spawn: () => {
      const w = inProcess(fakeSherpa({ calls, configs, ...fake }), sent);
      workers.push(w);
      return w;
    },
    ...over,
  });
  return { tts, calls, configs, sent, workers };
}

async function collect(it: AsyncIterable<PcmChunk>): Promise<PcmChunk[]> {
  const out: PcmChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

describe('natural voices: catalogue', () => {
  it('has a female and a male voice for every language, each in the catalogue', () => {
    for (const lang of ['zh', 'es', 'en'] as const) {
      expect(neuralVoice(lang, 'female')).toMatchObject({ lang, gender: 'female' });
      expect(neuralVoice(lang, 'male')).toMatchObject({ lang, gender: 'male' });
      expect(neuralVoice(lang).gender).toBe('female'); // default
    }
    for (const v of NEURAL_VOICES) {
      expect(TTS_MODELS[v.model]).toBeDefined();
      expect(v.speed).toBeGreaterThanOrEqual(1);
      expect(v.speed).toBeLessThan(1.4);
    }
  });

  it('pins every file to a commit and a SHA-256', () => {
    for (const spec of Object.values(TTS_MODELS)) {
      for (const f of spec.files) {
        expect(f.url).toMatch(/\/resolve\/[0-9a-f]{40}\//);
        expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(f.size).toBeGreaterThan(0);
      }
    }
  });

  it('configures Kokoro with the files of its folder', () => {
    const c = JSON.stringify(kokoroConfig('/m/kokoro-v1.0', 4));
    for (const f of TTS_MODELS['kokoro-v1.0'].files.filter((x) => !x.name.startsWith('dict/'))) expect(c).toContain(f.name);
    expect(c).toContain('"dictDir":"/m/kokoro-v1.0/dict"');
  });
});

describe('natural voices: what the model is given', () => {
  it('Chinese and English as text', () => {
    expect(kokoroInput('第一批货三周内发出。', 'zh')).toEqual({ text: '第一批货三周内发出。' });
    expect(kokoroInput(' Hello there. ', 'en')).toEqual({ text: 'Hello there.' });
  });

  it('Spanish as phonemes, numbers read out, one entry per sentence', () => {
    const r = kokoroInput('Buenos días. El envío sale en 3 semanas.', 'es');
    expect('phonemes' in r && r.phonemes).toHaveLength(2);
    if (!('phonemes' in r)) throw new Error('phonemes expected');
    expect(r.phonemes[1]).toContain('tɾˈes'); // "3" → tres
    expect(r.phonemes.join(' ')).not.toMatch(/\d/);
  });

  it('splits sentences only where one ends', () => {
    expect(sentences('Cuesta 3.5 dólares. ¿Le sirve? Sí.')).toEqual(['Cuesta 3.5 dólares.', '¿Le sirve?', 'Sí.']);
  });

  it('splits a sentence longer than the model takes at its commas', () => {
    const long = Array.from({ length: 12 }, (_, i) => `la empresa número ${i + 1} tiene oficinas en Buenos Aires`).join(', ') + '.';
    const r = kokoroInput(long, 'es');
    if (!('phonemes' in r)) throw new Error('phonemes expected');
    expect(r.phonemes.length).toBeGreaterThan(1);
    for (const p of r.phonemes) expect(p.length).toBeLessThanOrEqual(300);
  });

  it('says nothing for text with nothing to say', () => {
    const r = kokoroInput('… 123', 'es');
    expect('phonemes' in r && r.phonemes.length).toBe(1); // "ciento veintitrés"
    expect(kokoroInput('—', 'es')).toEqual({ phonemes: [] });
  });
});

describe('natural voices: speaking', () => {
  it('streams Chinese sentence by sentence at the voice’s own speed', async () => {
    const { tts, calls } = setup();
    const chunks = await collect(tts.synthesize({ text: '大家好。欢迎参加会议。', lang: 'zh-CN', voice: 'male', rate: 1 }));
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.sampleRate).toBe(24000);
    expect(chunks[0]!.samples).toBeInstanceOf(Int16Array);
    expect(chunks[0]!.samples[0]).toBe(Math.trunc(0.5 * 0x7fff));
    const v = neuralVoice('zh', 'male');
    expect(calls[0]).toMatchObject({ text: '大家好。欢迎参加会议。', sid: v.sid });
    expect(calls[0]!.speed).toBeCloseTo(v.speed);
  });

  it('speaks Spanish from phonemes', async () => {
    const { tts, calls } = setup();
    const chunks = await collect(tts.synthesize({ text: 'Hola. Gracias.', lang: 'es-AR', voice: 'female', rate: 1 }));
    expect(chunks).toHaveLength(2);
    expect(calls.map((c) => c.phonemes)).toEqual(['ˈola.', 'ɡɾˈasjas.']);
    expect(calls[0]!.sid).toBe(neuralVoice('es', 'female').sid);
  });

  it('catches up a little faster, but never past the limit', async () => {
    const { tts, calls } = setup();
    await collect(tts.synthesize({ text: '好。', lang: 'zh-CN', voice: 'male', rate: 1.35 }));
    expect(calls[0]!.speed).toBeCloseTo(neuralVoice('zh', 'male').speed * 1.2);
  });

  it('loads the model once for all requests (one process)', async () => {
    const { tts, configs, workers } = setup();
    await collect(tts.synthesize({ text: '好。', lang: 'zh-CN', rate: 1 }));
    await collect(tts.synthesize({ text: 'Hola.', lang: 'es-AR', rate: 1 }));
    expect(configs).toHaveLength(1);
    expect(workers).toHaveLength(1);
  });

  it('refuses when the model is not downloaded (the fallback voice speaks)', async () => {
    const { tts, workers } = setup({ ready: () => false });
    await expect(collect(tts.synthesize({ text: '好。', lang: 'zh-CN', rate: 1 }))).rejects.toThrow('还没下载好');
    expect(workers).toHaveLength(0);
    expect(tts.available('zh-CN')).toBe(false);
  });

  it('stops making speech when the sentence is cancelled', async () => {
    const { tts, sent } = setup();
    const ac = new AbortController();
    const got: PcmChunk[] = [];
    for await (const c of tts.synthesize({ text: '一。二。三。四。', lang: 'zh-CN', rate: 1, signal: ac.signal })) {
      got.push(c);
      ac.abort();
    }
    expect(got).toHaveLength(1);
    expect(sent.some((m) => (m as { t: string }).t === 'cancel')).toBe(true);
  });

  it('fails a sentence that brings no sound, and cancels it', async () => {
    const { tts, sent } = setup({ stallMs: 50 }, { slow: true });
    await expect(collect(tts.synthesize({ text: '好。', lang: 'zh-CN', rate: 1 }))).rejects.toThrow('太慢');
    expect(sent.some((m) => (m as { t: string }).t === 'cancel')).toBe(true);
  });

  it('fails the sentence when the model cannot load, and tries again next time', async () => {
    const { tts, configs } = setup({}, { failLoad: true });
    await expect(collect(tts.synthesize({ text: '好。', lang: 'zh-CN', rate: 1 }))).rejects.toThrow('bad model file');
    await expect(collect(tts.synthesize({ text: '好。', lang: 'zh-CN', rate: 1 }))).rejects.toThrow('bad model file');
    expect(configs).toHaveLength(2);
  });

  it('fails what is in progress when the process ends, then starts a new one', async () => {
    const { tts, workers } = setup({}, { slow: true });
    const p = collect(tts.synthesize({ text: '好。', lang: 'zh-CN', rate: 1 }));
    await new Promise((r) => setTimeout(r, 20));
    workers[0]!.exit();
    await expect(p).rejects.toThrow('进程退出');
    const q = collect(tts.synthesize({ text: '好。', lang: 'zh-CN', rate: 1 }));
    await new Promise((r) => setTimeout(r, 20));
    expect(workers).toHaveLength(2);
    tts.dispose();
    await expect(q).rejects.toThrow();
  });

  it('offers a female and a male voice', () => {
    const { tts } = setup();
    expect(tts.voices('es-AR').map((v) => [v.id, v.name])).toEqual([
      ['female', '女声'],
      ['male', '男声'],
    ]);
  });

  it('loads ahead on request, only when downloaded', async () => {
    const off = setup({ ready: () => false });
    off.tts.warmUp('zh-CN');
    expect(off.workers).toHaveLength(0);
    let loadedMs = -1;
    const on = setup({ onLoaded: (ms) => (loadedMs = ms) });
    on.tts.warmUp('zh-CN');
    await new Promise((r) => setTimeout(r, 30));
    expect(on.configs).toHaveLength(1);
    expect(loadedMs).toBeGreaterThanOrEqual(0);
    on.tts.dispose();
  });
});

describe('natural voices: choosing them', () => {
  it('the free voices are the natural ones, with the stand-in the desktop gives', async () => {
    const { createProviders } = await import('../../src/core/providers/registry');
    const { parseSettings } = await import('../../src/core/config/schema');
    const { fakeContext } = await import('../helpers/fakes');
    const s = parseSettings({ preset: 'free', out: { asr: 'local', mt: 'local-ai', tts: 'local' }, in: { asr: 'local', mt: 'local-ai', tts: 'local' } });
    const mine = { id: 'local', voices: () => [], synthesize: async function* () {} };
    expect(createProviders(s, {}, fakeContext(), () => [], { localTts: () => mine }).tts('out')).toBe(mine);
    expect(() => createProviders(s, {}, fakeContext(), () => []).tts('in')).toThrow('电脑版');
  });
});
