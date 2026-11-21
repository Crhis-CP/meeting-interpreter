// How long the local AI model takes per sentence, through the app's own client and translator
// (the meeting benchmark sentences, both directions interleaved as in a meeting).
// npx tsx --tsconfig tsconfig.node.json scripts/dev/latency-bench.mts <model.gguf> [threads] [out.json]
import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { LocalAiTranslator } from '../../src/core/providers/local-ai-translator';
import { LocalAiClient } from '../../src/main/providers/local-ai/client';
import { attachAiWorker } from '../../src/main/providers/local-ai/worker';
import type { WorkerHandle } from '../../src/main/providers/local-asr/client';

const [modelPath, threadsArg, outPath] = process.argv.slice(2);
if (!modelPath) throw new Error('usage: latency-bench.mts <model.gguf> [threads] [out.json]');
const threads = Number(threadsArg) || Math.max(2, Math.min(6, Math.floor(cpus().length / 2)));
const cases = JSON.parse(readFileSync(new URL('./bench-cases.json', import.meta.url), 'utf8')) as [string, string, string][];
const code: Record<string, string> = { zh: 'zh-CN', es: 'es-AR', en: 'en-US' };

// Interleave the directions (a meeting goes back and forth).
const zh = cases.filter((c) => c[0] === 'zh');
const other = cases.filter((c) => c[0] !== 'zh');
const order: [string, string, string][] = [];
for (let i = 0; i < Math.max(zh.length, other.length); i++) {
  if (zh[i]) order.push(zh[i]!);
  if (other[i]) order.push(other[i]!);
}

const toWorker = new EventEmitter();
const toMain = new EventEmitter();
attachAiWorker({ on: (_e, fn) => void toWorker.on('m', (d) => fn({ data: d })), postMessage: (m) => void setImmediate(() => toMain.emit('message', m)) });
const handle = { postMessage: (m: unknown) => void setImmediate(() => toWorker.emit('m', m)), on: (e: string, fn: (...a: unknown[]) => void) => void toMain.on(e, fn), kill: () => {} } as unknown as WorkerHandle;
const client = new LocalAiClient({ modelPath, threads, spawn: () => handle, requestTimeoutMs: 120_000 });

const t0 = Date.now();
await client.ready();
const loadMs = Date.now() - t0;
const t = new LocalAiTranslator(client);
const rows: { from: string; to: string; src: string; out: string; ms: number }[] = [];
for (const [f, to, text] of order) {
  const s = Date.now();
  const out = await t.translate({ text, from: code[f]!, to: code[to]!, hits: [], context: [] });
  const ms = Date.now() - s;
  rows.push({ from: f, to, src: text, out, ms });
  console.log(`${f}→${to} ${String(ms).padStart(5)} ms | ${out}`);
}
const sorted = rows.map((r) => r.ms).sort((a, b) => a - b);
const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
const summary = { threads, cpus: cpus().length, cpu: cpus()[0]?.model, loadMs, sentences: rows.length, firstMs: rows[0]?.ms, medianMs: q(0.5), p90Ms: q(0.9), maxMs: sorted.at(-1) };
console.log(JSON.stringify(summary, null, 2));
if (outPath) writeFileSync(outPath, JSON.stringify({ summary, rows }, null, 1));
process.exit(0);
