/**
 * Command-line tool: interpret a WAV file through the same pipeline the app uses, or check that
 * provider keys work. Keys come from environment variables, never from arguments.
 *
 *   npm run cli -- translate-file meeting.wav --from zh-CN --to es-ES --preset dashscope --out es.wav --transcript t.md
 *   npm run cli -- check --preset free
 *
 * Environment: DASHSCOPE_API_KEY, AZURE_SPEECH_KEY, AZURE_SPEECH_REGION, AZURE_TRANSLATOR_KEY,
 * LLM_API_KEY, LLM_BASE_URL, LLM_MODEL, DEEPL_API_KEY, MI_MODELS_DIR (offline models).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ASR_RATE, concatInt16, resampleInt16 } from '../core/audio/pcm';
import { decodeWav, encodeWav, toMono } from '../core/audio/wav';
import { applyPreset, type PresetId } from '../core/config/presets';
import { defaultSettings, type Secrets } from '../core/config/schema';
import { sleep } from '../core/events';
import { otherLanguage } from '../core/lang/languages';
import { createLogger, setLogLevel } from '../core/log';
import { DirectionPipeline } from '../core/pipeline/pipeline';
import { createProviders, makeLlm } from '../core/providers/registry';
import { toMarkdown } from '../core/session/transcript';
import type { Direction, MeetingMeta, TranscriptSegment } from '../core/types';
import { createNodeContext } from '../main/platform/node-context';
import { testDirection, testLlm } from '../main/provider-test';
import { LocalAsr } from '../main/providers/local-asr/client';
import { createInProcessWorker } from '../main/providers/local-asr/worker';
import { SystemTts } from '../main/providers/system-tts';

function args(argv: string[]): { cmd: string; pos: string[]; flags: Record<string, string> } {
  const [cmd = 'help', ...rest] = argv;
  const pos: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith('--')) flags[a.slice(2)] = rest[i + 1] && !rest[i + 1]!.startsWith('--') ? rest[++i]! : 'true';
    else pos.push(a);
  }
  return { cmd, pos, flags };
}

function secretsFromEnv(): Secrets {
  const e = process.env;
  return {
    dashscope: e.DASHSCOPE_API_KEY,
    azure: e.AZURE_SPEECH_KEY,
    azureTranslator: e.AZURE_TRANSLATOR_KEY,
    llm: e.LLM_API_KEY,
    deepl: e.DEEPL_API_KEY,
  };
}

function setup(presetId: string) {
  let s = applyPreset(defaultSettings(), presetId as PresetId);
  if (process.env.AZURE_SPEECH_REGION) s = { ...s, azure: { ...s.azure, region: process.env.AZURE_SPEECH_REGION } };
  if (process.env.LLM_BASE_URL || process.env.LLM_MODEL)
    s = { ...s, llm: { ...s.llm, preset: 'custom', baseUrl: process.env.LLM_BASE_URL ?? s.llm.baseUrl, model: process.env.LLM_MODEL ?? s.llm.model } };
  const modelsDir = process.env.MI_MODELS_DIR ?? join(homedir(), '.meeting-interpreter', 'models');
  const ctx = createNodeContext(createLogger('cli'));
  const providers = createProviders(s, secretsFromEnv(), ctx, () => [], {
    systemTts: () => new SystemTts(),
    localAsr: () => new LocalAsr({ modelsDir, esModel: s.local.esModel, spawn: () => createInProcessWorker() }),
  });
  return { s, ctx, providers };
}

async function translateFile(file: string, flags: Record<string, string>): Promise<void> {
  const from = flags.from ?? 'zh-CN';
  const to = flags.to ?? otherLanguage(from);
  const speed = Number(flags.speed ?? 4);
  const { s, providers } = setup(flags.preset ?? 'demo');
  const dir: Direction = from.startsWith('zh') ? 'out' : 'in';
  const wav = decodeWav(new Uint8Array(readFileSync(file)));
  const pcm = resampleInt16(toMono(wav.samples, wav.channels), wav.sampleRate, ASR_RATE);
  const started = Date.now();
  const segments = new Map<string, TranscriptSegment>();
  const audio: Int16Array[] = [];
  let audioRate = 24000;
  const p = new DirectionPipeline({
    dir,
    speaker: dir === 'out' ? 'me' : 'them',
    idPrefix: dir,
    srcLang: from,
    dstLang: to,
    asr: providers.asr(dir),
    translator: providers.mt(dir),
    tts: flags.out ? providers.tts(dir) : null,
    glossary: () => [],
    pinyinFuzzy: s.interpretation.pinyinFuzzy,
    lowLatency: s.interpretation.lowLatency,
    clock: () => ((Date.now() - started) / 1000) * speed,
  });
  p.on('segment', (seg) => {
    segments.set(seg.id, seg);
    if (seg.status !== 'translating') console.log(`[${seg.status}] ${seg.srcText}\n    → ${seg.dstText ?? seg.error ?? ''}`);
  });
  p.on('status', ({ state, message }) => state === 'error' && console.error(`! ${message}`));
  p.on('audio', ({ samples, sampleRate }) => {
    audio.push(samples);
    audioRate = sampleRate;
  });
  await p.start();
  const chunk = ASR_RATE / 10;
  const padded = concatInt16([pcm, new Int16Array(ASR_RATE * 2)]);
  for (let i = 0; i < padded.length; i += chunk) {
    p.push(padded.subarray(i, i + chunk));
    await sleep(100 / speed);
  }
  await p.stop(20000);
  const list = [...segments.values()];
  if (flags.out) {
    writeFileSync(flags.out, encodeWav(concatInt16(audio), audioRate));
    console.log(`translated speech → ${flags.out}`);
  }
  if (flags.transcript) {
    const meta: MeetingMeta = { id: 'cli', title: file, startedAt: new Date(started).toISOString(), selfLang: 'zh-CN', remoteLang: s.languages.remote, mode: 'meeting', files: {} };
    writeFileSync(flags.transcript, toMarkdown(list, meta));
    console.log(`transcript → ${flags.transcript}`);
  }
  if (!list.length) process.exitCode = 1;
}

async function check(flags: Record<string, string>): Promise<void> {
  const { s, ctx, providers } = setup(flags.preset ?? 'demo');
  const results = [
    ...(await testDirection(providers, 'out', s.languages.self, s.languages.remote)),
    ...(await testDirection(providers, 'in', s.languages.remote, s.languages.self)),
    ...(await testLlm(makeLlm(s, secretsFromEnv(), ctx, true))),
  ];
  for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name} (${r.ms} ms) ${r.detail}`);
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

async function main(): Promise<void> {
  setLogLevel(process.env.MI_DEBUG ? 'debug' : 'warn');
  const { cmd, pos, flags } = args(process.argv.slice(2));
  if (cmd === 'translate-file' && pos[0]) return translateFile(pos[0], flags);
  if (cmd === 'check') return check(flags);
  console.log(`用法：
  npm run cli -- translate-file <输入.wav> [--from zh-CN] [--to es-ES] [--preset demo|free|dashscope|azure] [--out 译音.wav] [--transcript 记录.md] [--speed 4]
  npm run cli -- check [--preset demo|free|dashscope|azure]
Key 通过环境变量提供：DASHSCOPE_API_KEY、AZURE_SPEECH_KEY、AZURE_SPEECH_REGION、AZURE_TRANSLATOR_KEY、LLM_API_KEY、LLM_BASE_URL、LLM_MODEL、DEEPL_API_KEY`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
