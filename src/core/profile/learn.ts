/**
 * Comparing what was said with what was recognised: accuracy, accent patterns, and the personal
 * corrections worth keeping ("how the recogniser hears me" → "what I meant").
 */
import { similarSyllable, syllables } from '../glossary/correct';
import type { LangBase } from '../lang/languages';
import { asSpoken, contextSyllables, featureCounts, relatedBy, type FeatureCount } from './accents';

/** The accent feature relating two syllables ("l-n", "f-hu", …), or null. */
export const confusionOf = relatedBy;

export interface LearnedCorrection {
  heard: string;
  meant: string;
}

const HAN = /\p{Script=Han}/u;

/** Characters for Chinese (Latin words kept whole), lower-cased words for Spanish / English. */
export function tokens(text: string, base: LangBase): string[] {
  return rawTokens(text, base).map((t) => t.toLowerCase());
}

/** `tokens()` with the original letter case. */
function rawTokens(text: string, base: LangBase): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\p{Script=Han}|[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu)) out.push(m[0]);
  return base === 'zh' ? out : out.filter((t) => !HAN.test(t));
}

export type AlignOp =
  | { op: 'eq' | 'sub'; r: string; h: string; ri: number; hi: number }
  | { op: 'del'; r: string; ri: number }
  | { op: 'ins'; h: string; ri: number; hi: number };

/** Minimal edit alignment (Levenshtein) of reference and hypothesis tokens. `ri` = reference position. */
export function alignTokens(ref: string[], hyp: string[]): AlignOp[] {
  const n = ref.length;
  const m = hyp.length;
  const d: number[][] = Array.from({ length: n + 1 }, (_, i) => Array.from({ length: m + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++) d[i]![j] = Math.min(d[i - 1]![j - 1]! + (ref[i - 1] === hyp[j - 1] ? 0 : 1), d[i - 1]![j]! + 1, d[i]![j - 1]! + 1);
  const ops: AlignOp[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i]![j] === d[i - 1]![j - 1]! + (ref[i - 1] === hyp[j - 1] ? 0 : 1)) {
      ops.push({ op: ref[i - 1] === hyp[j - 1] ? 'eq' : 'sub', r: ref[i - 1]!, h: hyp[j - 1]!, ri: i - 1, hi: j - 1 });
      i--;
      j--;
    } else if (i > 0 && d[i]![j] === d[i - 1]![j]! + 1) {
      ops.push({ op: 'del', r: ref[i - 1]!, ri: i - 1 });
      i--;
    } else {
      ops.push({ op: 'ins', h: hyp[j - 1]!, ri: i, hi: j - 1 });
      j--;
    }
  }
  return ops.reverse();
}

/** 1 − token error rate (characters for Chinese, words otherwise), clamped to 0…1. Chinese numbers count however they are written (四十万 = 40万). */
export function accuracy(reference: string, recognised: string, base: LangBase = 'zh'): number {
  const ref = tokens(base === 'zh' ? asSpoken(reference) : reference, base);
  if (!ref.length) return 0;
  const errors = alignTokens(ref, tokens(base === 'zh' ? asSpoken(recognised) : recognised, base)).filter((o) => o.op !== 'eq').length;
  return Math.max(0, 1 - errors / ref.length);
}

const join = (t: string[], base: LangBase) => (base === 'zh' ? t.join('') : t.join(' '));

/** Where each term occurs in the reference tokens: [start, end) ranges. */
function termRanges(ref: string[], terms: string[], base: LangBase): { start: number; end: number; term: string }[] {
  const out: { start: number; end: number; term: string }[] = [];
  for (const term of terms) {
    const tt = tokens(term, base);
    if (!tt.length) continue;
    for (let i = 0; i + tt.length <= ref.length; i++) if (tt.every((t, k) => ref[i + k] === t)) out.push({ start: i, end: i + tt.length, term });
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * A known text read aloud and what the recogniser made of it.
 * - `confusions`: the accent pattern behind each character mis-heard as a sound-alike (Chinese).
 * - `corrections`: how the recogniser heard each of the user's own `terms` when it got them wrong.
 *   Everyday words are never turned into rules: one person's 你好 heard for 您好 must not rewrite
 *   everybody's 你好.
 */
export function learnFromReading(
  reference: string,
  recognised: string,
  base: LangBase,
  terms: string[] = [],
): { corrections: LearnedCorrection[]; confusions: string[]; features: Record<string, FeatureCount> } {
  const ref = tokens(base === 'zh' ? asSpoken(reference) : reference, base);
  const hyp = tokens(base === 'zh' ? asSpoken(recognised) : recognised, base);
  const ops = alignTokens(ref, hyp);
  const confusions: string[] = [];
  let features: Record<string, FeatureCount> = {};
  if (base === 'zh') {
    // Characters read in context (多音字: 银行 hang, 行走 xing), on both sides.
    const said = contextSyllables(ref);
    const heard = contextSyllables(hyp);
    for (const o of ops) {
      if (o.op !== 'sub' || !HAN.test(o.r) || !HAN.test(o.h)) continue;
      const c = relatedBy(heard[o.hi] ?? '', said[o.ri] ?? '');
      if (c) confusions.push(c);
    }
    features = featureCounts(ref, ops, hyp);
  }
  const corrections: LearnedCorrection[] = [];
  const termOf = new Map<string, string>(terms.map((t) => [join(tokens(t, base), base), t]));
  for (const r of termRanges(ref, terms, base)) {
    const heard: string[] = [];
    for (const o of ops) {
      const inside = o.op === 'ins' ? o.ri > r.start && o.ri < r.end : o.ri >= r.start && o.ri < r.end;
      if (inside && o.op !== 'del') heard.push(o.h);
    }
    const h = join(heard, base);
    const meant = termOf.get(join(ref.slice(r.start, r.end), base)) ?? r.term;
    if (h && h !== join(tokens(meant, base), base) && heard.length <= 2 * (r.end - r.start) && !corrections.some((c) => c.heard === h)) corrections.push({ heard: h, meant });
  }
  return { corrections, confusions, features };
}

/**
 * The accent features behind a correction of Chinese ("what the recogniser wrote" → "what was
 * said"): each mis-heard character that differs from the right one by a known merge. Counted into
 * the profile, so features show up from everyday use too, without any calibration.
 */
export function accentEvidence(heard: string, meant: string): string[] {
  return learnFromReading(meant, heard, 'zh').confusions;
}

function editDistance(a: string, b: string): number {
  return alignTokens([...a], [...b]).filter((o) => o.op !== 'eq').length;
}

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '');

/** Do two spans sound alike (a recogniser's mistake rather than a rewrite)? */
export function soundsAlike(heard: string[], meant: string[], base: LangBase): boolean {
  if (base === 'zh') {
    if (heard.length !== meant.length || !heard.every((c) => HAN.test(c)) || !meant.every((c) => HAN.test(c))) return false;
    const ph = syllables(heard.join(''));
    const pm = syllables(meant.join(''));
    return ph.every((s, k) => similarSyllable(s, pm[k] ?? '') || relatedBy(s, pm[k] ?? '') !== null);
  }
  const h = fold(heard.join(' '));
  const m = fold(meant.join(' '));
  if (h === m || h === `${m}s` || m === `${h}s` || h === `${m}es` || m === `${h}es`) return false;
  return editDistance(h, m) <= Math.max(1, Math.floor(0.4 * Math.max(h.length, m.length)));
}

/**
 * A sentence the user corrected by hand: each changed span that sounds like what was recognised
 * becomes a correction (Chinese spans are widened to two characters or more so a single
 * character is never rewritten everywhere). Rewrites in other words are not learned.
 */
export function learnFromEdit(before: string, after: string, base: LangBase): LearnedCorrection[] {
  const rawAfter = rawTokens(after, base);
  const rawBefore = rawTokens(before, base);
  const ops = alignTokens(tokens(after, base), tokens(before, base));
  const out: LearnedCorrection[] = [];
  let k = 0;
  while (k < ops.length) {
    if (ops[k]!.op === 'eq') {
      k++;
      continue;
    }
    let e = k;
    while (e < ops.length && ops[e]!.op !== 'eq') e++;
    const span = ops.slice(k, e);
    const meant = span.flatMap((o) => (o.op === 'ins' ? [] : [o.r]));
    const heard = span.flatMap((o) => (o.op === 'del' ? [] : [o.h]));
    const maxLen = base === 'zh' ? 6 : 3;
    if (meant.length && heard.length && meant.length <= maxLen && soundsAlike(heard, meant, base)) {
      // Widen single Chinese characters with an unchanged neighbour (right first, then left).
      let s = k;
      let t = e;
      if (base === 'zh' && meant.length < 2) {
        if (t < ops.length && ops[t]!.op === 'eq') t++;
        else if (s > 0 && ops[s - 1]!.op === 'eq') s--;
      }
      const wide = ops.slice(s, t);
      const m = join(wide.flatMap((o) => (o.op === 'ins' ? [] : [rawAfter[o.ri]!])), base);
      const h = join(wide.flatMap((o) => (o.op === 'del' ? [] : [rawBefore[o.hi]!])), base);
      if ((base !== 'zh' || [...m].length >= 2) && h !== m) out.push({ heard: h, meant: m });
    }
    k = e;
  }
  return out;
}
