// "Done speaking → translation ready", stage by stage, through the app's own pipeline with the
// real local models: real speech fed in real time, offline recognition (VAD + SenseVoice / Whisper),
// the local AI model, and a stand-in voice that records when it is asked to speak.
//
//   npx tsx --tsconfig tsconfig.node.json scripts/dev/e2e-latency.mts <models dir> <ai model.gguf> <zh.wav> <es.wav> [rounds]
//
// The models dir holds silero-vad/, sensevoice/, parakeet-v3/ as the app downloads them.
// What the voice itself adds depends on the voice (system voice, cloud): not measured here.
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { ASR_RATE, resampleInt16 } from '../../src/core/audio/pcm';
import { decodeWav, toMono } from '../../src/core/audio/wav';
import { createLogger, setLogLevel } from '../../src/core/log';
import { createDirection } from '../../src/core/pipeline/direction';
import { LocalAiTranslator } from '../../src/core/providers/local-ai-translator';
import type { Tts } from '../../src/core/providers/types';
import { LocalAiClient } from '../../src/main/providers/local-ai/client';
import { attachAiWorker } from '../../src/main/providers/local-ai/worker';
import { LocalAsr, type WorkerHandle } from '../../src/main/providers/local-asr/client';
import { createInProcessWorker } from '../../src/main/providers/local-asr/worker';

const [modelsDir, aiModel, zhWav, esWav, roundsArg] = process.argv.slice(2);
if (!modelsDir || !aiModel || !zhWav || !esWav) throw new Error('usage: e2e-latency.mts <models dir> <ai model.gguf> <zh.wav> <es.wav> [rounds]');
const rounds = Number(roundsArg) || 3;
setLogLevel('warn');

const toWorker = new EventEmitter();
const toMain = new EventEmitter();
attachAiWorker({ on: (_e, fn) => void toWorker.on('m', (d) => fn({ data: d })), postMessage: (m) => void setImmediate(() => toMain.emit('message', m)) });
const aiHandle = { postMessage: (m: unknown) => void setImmediate(() => toWorker.emit('m', m)), on: (e: string, fn: (...a: unknown[]) => void) => void toMain.on(e, fn), kill: () => {} } as unknown as WorkerHandle;
const ai = new LocalAiClient({ modelPath: aiModel, threads: 0, spawn: () => aiHandle, requestTimeoutMs: 120_000 });
await ai.ready();

function speech(file: string): { pcm: Int16Array; speechEnd: number } {
  const w = decodeWav(readFileSync(file));
  const pcm = resampleInt16(toMono(w.samples, w.channels), w.sampleRate, ASR_RATE);
  // Where the voice stops: the last 20 ms window louder than -40 dBFS.
  let end = 0;
  for (let i = 0; i + 320 <= pcm.length; i += 320) {
    let e = 0;
    for (let k = i; k < i + 320; k++) e += pcm[k]! * pcm[k]!;
    if (Math.sqrt(e / 320) > 327) end = i + 320;
  }
  return { pcm, speechEnd: end / ASR_RATE };
}

async function measure(src: 'zh-CN' | 'es-AR', dst: 'es-AR' | 'zh-CN', file: string, asrThreads: number) {
  const { pcm, speechEnd } = speech(file);
  const t0 = Date.now();
  const marks: Record<string, number> = {};
  const tts: Tts = {
    id: 'timer',
    voices: () => [],
    async *synthesize() {
      marks.speak ??= Date.now();
      yield { samples: new Int16Array(160), sampleRate: ASR_RATE };
    },
  };
  const asr = new LocalAsr({ modelsDir: modelsDir!, numThreads: asrThreads, spawn: () => createInProcessWorker() });
  const p = createDirection({
    dir: 'out', speaker: 'me', idPrefix: 'x', srcLang: src, dstLang: dst, asr, translator: new LocalAiTranslator(ai), tts,
    glossary: () => [], interpretation: { pinyinFuzzy: false, lowLatency: process.env.LOW_LATENCY !== '0' }, clock: () => (Date.now() - t0) / 1000, log: createLogger('latency'),
  });
  p.on('segment', (s) => {
    if (s.srcText && !marks.recognised) marks.recognised = Date.now();
    if (s.dstText && !s.draft && s.status === 'done') {
      marks.translated ??= Date.now();
      marks.allTranslated = Date.now(); // the last piece (with early clauses, the first can come before the end)
    }
  });
  await p.start();
  // Real time: 100 ms chunks, then 2 s of silence for the end of the sentence to be noticed.
  const t1 = Date.now();
  const chunk = ASR_RATE / 10;
  const all = new Int16Array(pcm.length + 2 * ASR_RATE);
  all.set(pcm);
  for (let i = 0; i < all.length; i += chunk) {
    p.push(all.subarray(i, i + chunk));
    const due = t1 + ((i + chunk) / ASR_RATE) * 1000;
    await new Promise((r) => setTimeout(r, Math.max(0, due - Date.now())));
  }
  for (let i = 0; i < 200 && !marks.speak; i++) await new Promise((r) => setTimeout(r, 50));
  await p.stop(2000);
  const end = t1 + speechEnd * 1000;
  return { recognised: (marks.recognised ?? NaN) - end, translated: (marks.translated ?? NaN) - end, allTranslated: (marks.allTranslated ?? NaN) - end, speak: (marks.speak ?? NaN) - end };
}

const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
for (const [src, dst, file] of [['zh-CN', 'es-AR', zhWav], ['es-AR', 'zh-CN', esWav]] as const) {
  for (const threads of src === 'zh-CN' ? [2] : [2, 4]) {
    const runs: Awaited<ReturnType<typeof measure>>[] = [];
    for (let r = 0; r < rounds; r++) runs.push(await measure(src, dst, file!, threads));
    const m = (k: 'recognised' | 'translated' | 'allTranslated' | 'speak') => Math.round(med(runs.map((x) => x[k])));
    console.log(`${src} → ${dst} (recognition ${threads} threads): first text ${m('recognised')} ms, first translation ${m('translated')} ms, all translated ${m('allTranslated')} ms, first speech asked ${m('speak')} ms (relative to when the voice stopped)`);
  }
}
ai.dispose();
process.exit(0);
