/**
 * Electron `utilityProcess` entry for the natural voices: loads Kokoro (sherpa-onnx) in its own
 * process, so speech is made without ever blocking the app or the recognisers, and a crash takes
 * nothing else down. Speech comes back sentence by sentence as 16-bit PCM. Also loads under plain
 * Node (tests), where `process.parentPort` does not exist.
 */
import { join } from 'node:path';
import { loadSherpaOnnx, type SherpaOnnxModule } from '../local-asr/recognizer';
import type { WorkerHandle } from '../local-asr/client';
import type { ParentPortLike } from '../local-asr/worker';

/** `dir`: the model's folder (`<models>/<id>`); `phonemes`: one entry per sentence (Spanish). */
export type TtsWorkerRequest =
  | { t: 'load'; dir: string; threads: number }
  | { t: 'synth'; id: number; dir: string; threads: number; sid: number; speed: number; text?: string; phonemes?: string[] }
  | { t: 'cancel'; id: number };
export type TtsWorkerReply =
  | { t: 'loaded'; dir: string; ms: number }
  | { t: 'chunk'; id: number; pcm: ArrayBuffer; sampleRate: number }
  | { t: 'done'; id: number }
  | { t: 'error'; id?: number; message: string };

interface OfflineTtsLike {
  sampleRate: number;
  generateAsync(req: {
    text: string;
    sid: number;
    speed: number;
    generationConfig?: { sid: number; speed: number; phonemeCodepoints?: number[][] };
    onProgress?: (info: { samples: Float32Array; progress: number }) => number | boolean | void;
  }): Promise<{ samples: Float32Array; sampleRate: number }>;
}
interface TtsModule {
  OfflineTts: { createAsync(config: unknown): Promise<OfflineTtsLike> };
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The model's files, as they are laid out in its folder (models.ts). */
export function kokoroConfig(dir: string, threads: number): unknown {
  const f = (name: string) => join(dir, name);
  return {
    model: {
      kokoro: { model: f('model.onnx'), voices: f('voices.bin'), tokens: f('tokens.txt'), lexicon: `${f('lexicon-us-en.txt')},${f('lexicon-zh.txt')}`, dictDir: f('dict') },
      numThreads: threads,
      provider: 'cpu',
    },
    // A sentence at a time: the first one plays while the next is made.
    maxNumSentences: 1,
    ruleFsts: `${f('date-zh.fst')},${f('phone-zh.fst')},${f('number-zh.fst')}`,
  };
}

function toPcm(samples: Float32Array): ArrayBuffer {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]!));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out.buffer;
}

export function attachTtsWorker(port: ParentPortLike, loadLib: () => SherpaOnnxModule | TtsModule = loadSherpaOnnx): { dispose(): void } {
  const loaded = new Map<string, Promise<OfflineTtsLike>>();
  const cancelled = new Set<number>();
  /** One sentence at a time: the model is not made for parallel use, and the CPU is shared anyway. */
  let chain: Promise<void> = Promise.resolve();
  let disposed = false;
  // (Electron's parent port copies an ArrayBuffer; it cannot transfer one.)
  const reply = (m: TtsWorkerReply) => {
    if (!disposed) port.postMessage(m);
  };

  const model = (dir: string, threads: number): Promise<OfflineTtsLike> => {
    let p = loaded.get(dir);
    if (!p) {
      const t0 = Date.now();
      p = (loadLib() as TtsModule).OfflineTts.createAsync(kokoroConfig(dir, threads));
      loaded.set(dir, p);
      p.then(
        () => reply({ t: 'loaded', dir, ms: Date.now() - t0 }),
        () => loaded.delete(dir), // tried again on the next request
      );
    }
    return p;
  };

  const synth = async (m: Extract<TtsWorkerRequest, { t: 'synth' }>) => {
    if (cancelled.delete(m.id)) return reply({ t: 'done', id: m.id });
    const tts = await model(m.dir, m.threads);
    const onProgress = (info: { samples: Float32Array }) => {
      if (cancelled.has(m.id) || disposed) return 0; // stop after this sentence
      const pcm = toPcm(info.samples);
      reply({ t: 'chunk', id: m.id, pcm, sampleRate: tts.sampleRate });
      return 1;
    };
    if (m.phonemes) {
      // Spanish: our own phonemes, one entry per sentence.
      for (const ph of m.phonemes) {
        if (cancelled.has(m.id) || disposed) break;
        const codepoints = [[...ph].map((c) => c.codePointAt(0)!)];
        const g = await tts.generateAsync({ text: '', sid: m.sid, speed: m.speed, generationConfig: { sid: m.sid, speed: m.speed, phonemeCodepoints: codepoints } });
        if (!cancelled.has(m.id) && g.samples.length) onProgress(g);
      }
    } else {
      await tts.generateAsync({ text: m.text ?? '', sid: m.sid, speed: m.speed, onProgress });
    }
    cancelled.delete(m.id);
    reply({ t: 'done', id: m.id });
  };

  port.on('message', (e) => {
    const m = (e as { data?: unknown } | null)?.data as TtsWorkerRequest | undefined;
    if (disposed || !m || typeof m !== 'object') return;
    if (m.t === 'load') {
      model(m.dir, m.threads).catch((err: unknown) => reply({ t: 'error', message: `自然人声模型没能加载：${message(err)}` }));
    } else if (m.t === 'cancel') {
      if (cancelled.size > 1000) cancelled.clear(); // cancels that crossed a finished sentence
      cancelled.add(m.id);
    } else if (m.t === 'synth') {
      chain = chain.then(() =>
        synth(m).catch((err: unknown) => {
          cancelled.delete(m.id);
          reply({ t: 'error', id: m.id, message: message(err) });
        }),
      );
    }
  });

  return {
    dispose() {
      disposed = true;
    },
  };
}

/**
 * The worker inside this process, messages cloned and delivered asynchronously like real IPC. For
 * the CLI and tests; the app runs it in a utility process.
 */
export function createInProcessTtsWorker(loadLib?: () => SherpaOnnxModule | TtsModule): WorkerHandle {
  const messageFns: ((m: unknown) => void)[] = [];
  const exitFns: ((code: number) => void)[] = [];
  let portFn: ((e: { data: unknown }) => void) | null = null;
  let alive = true;
  const port: ParentPortLike = {
    on: (_event, listener) => {
      portFn = listener;
    },
    postMessage: (m) => setImmediate(() => alive && messageFns.forEach((fn) => fn(structuredClone(m)))),
  };
  const worker = attachTtsWorker(port, loadLib);
  return {
    postMessage: (m: unknown) => setImmediate(() => alive && portFn?.({ data: structuredClone(m) })),
    on: (ev: 'message' | 'exit', fn: (x: any) => void) => void (ev === 'message' ? messageFns : exitFns).push(fn),
    kill: () => {
      if (!alive) return;
      alive = false;
      worker.dispose();
      setImmediate(() => exitFns.forEach((fn) => fn(0)));
    },
  };
}

// ------------------------------------------------------------------ utility process entry
const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort;
if (parentPort) {
  attachTtsWorker(parentPort);
  process.on('uncaughtException', (err) => {
    try {
      parentPort.postMessage({ t: 'error', message: `自然人声进程出错：${message(err)}` } satisfies TtsWorkerReply);
    } finally {
      setTimeout(() => process.exit(1), 100);
    }
  });
}
