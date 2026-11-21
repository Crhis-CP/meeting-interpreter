/**
 * Accent calibration: the user's reading of known sentences goes through every recogniser they
 * can use; each is scored against the text, and the mistakes teach the profile.
 */
import { ASR_RATE, concatInt16 } from '../audio/pcm';
import { sleep } from '../events';
import { baseOf } from '../lang/languages';
import type { StreamingAsr } from '../providers/types';
import type { LangCode } from '../types';
import type { FeatureCount } from './accents';
import { accuracy, learnFromReading, type LearnedCorrection } from './learn';

export interface CalibrationCandidate {
  id: string;
  name: string;
  asr: StreamingAsr;
  hotwords: string[];
}

export interface CalibrationRun {
  results: { asr: string; name: string; accuracy: number; ms: number; texts: string[]; error?: string }[];
  /** The most accurate recogniser that worked. */
  best: string | null;
  /** How recognisers heard the user's own terms (from every recogniser tried). */
  corrections: LearnedCorrection[];
  /** Accent patterns, from the recogniser in use (or the best one when it was not tried). */
  confusions: string[];
  /** Per merge direction ("n→l"): chances in the reading and times heard merged (same recogniser). */
  features: Record<string, FeatureCount>;
}

async function recognise(c: CalibrationCandidate, pcm: Int16Array, lang: LangCode, paceMs: number): Promise<string> {
  const session = await c.asr.start({ lang, hotwords: c.hotwords, sampleRate: 16000 });
  const finals: string[] = [];
  let error = '';
  session.events.on('final', ({ text }) => finals.push(text));
  session.events.on('error', ({ error: e, fatal }) => fatal && (error = e.message));
  try {
    const padded = concatInt16([pcm, new Int16Array(Math.round(ASR_RATE * 1.2))]);
    const chunk = ASR_RATE / 10;
    for (let i = 0; i < padded.length; i += chunk) {
      session.push(padded.subarray(i, i + chunk));
      if (paceMs) await sleep(paceMs);
    }
    await Promise.race([session.end(), sleep(10_000)]);
  } finally {
    session.close();
  }
  if (!finals.length && error) throw new Error(error);
  return finals.join(baseOf(lang) === 'zh' ? '' : ' ');
}

export async function runCalibration(
  input: { sentences: string[]; audio: Int16Array[]; lang: LangCode; terms: string[]; current: string },
  candidates: CalibrationCandidate[],
  opts: { paceMs?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<CalibrationRun> {
  if (!candidates.length) throw new Error('没有可用的语音识别：请先下载本机离线识别，或填写百炼 / Azure Key');
  if (input.audio.length !== input.sentences.length) throw new Error('录音和句子数量不一致');
  const base = baseOf(input.lang);
  const reference = input.sentences.join(base === 'zh' ? '' : ' ');
  const total = candidates.length * input.sentences.length;
  let done = 0;
  const results: CalibrationRun['results'] = [];
  for (const c of candidates) {
    const t0 = Date.now();
    const texts: string[] = [];
    try {
      for (const pcm of input.audio) {
        texts.push(await recognise(c, pcm, input.lang, opts.paceMs ?? 25));
        opts.onProgress?.(++done, total);
      }
      results.push({ asr: c.id, name: c.name, accuracy: accuracy(reference, texts.join(base === 'zh' ? '' : ' '), base), ms: Date.now() - t0, texts });
    } catch (err) {
      done = results.length * input.sentences.length + input.sentences.length;
      opts.onProgress?.(done, total);
      results.push({ asr: c.id, name: c.name, accuracy: 0, ms: Date.now() - t0, texts, error: err instanceof Error ? err.message : String(err) });
    }
  }
  const working = results.filter((r) => !r.error);
  const best = working.length ? working.reduce((a, b) => (b.accuracy > a.accuracy ? b : a)).asr : null;
  const corrections: LearnedCorrection[] = [];
  let confusions: string[] = [];
  const features: Record<string, FeatureCount> = {};
  const learnFrom = working.find((r) => r.asr === input.current) ?? working.find((r) => r.asr === best);
  for (const r of working) {
    const learned = input.sentences.map((s, i) => learnFromReading(s, r.texts[i] ?? '', base, input.terms));
    for (const l of learned) for (const c of l.corrections) if (!corrections.some((x) => x.heard === c.heard)) corrections.push(c);
    if (r === learnFrom) {
      confusions = learned.flatMap((l) => l.confusions);
      for (const l of learned)
        for (const [k, c] of Object.entries(l.features)) {
          const t = (features[k] ??= { tested: 0, merged: 0 });
          t.tested += c.tested;
          t.merged += c.merged;
        }
    }
  }
  return { results, best, corrections, confusions, features };
}
