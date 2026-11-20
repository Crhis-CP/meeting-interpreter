import { pinyin } from 'pinyin-pro';
import { isLatin, type LangBase } from '../lang/languages';
import { foldLatin } from './match';
import { aliasesOf, termOf, type GlossaryEntry } from './types';

export interface Correction {
  text: string;
  edits: { from: string; to: string }[];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const HAN = /\p{Script=Han}/u;

/** Toneless pinyin syllables for each character (non-Han characters map to themselves). */
export function syllables(text: string): string[] {
  return pinyin(text, { toneType: 'none', type: 'array', nonZh: 'consecutive' }) as string[];
}

const INITIALS = ['zh', 'ch', 'sh', 'b', 'p', 'm', 'f', 'd', 't', 'n', 'l', 'g', 'k', 'h', 'j', 'q', 'x', 'r', 'z', 'c', 's', 'y', 'w'];

/** A toneless syllable as [initial, final] ("zhang" → ["zh", "ang"], "an" → ["", "an"]). */
export function splitSyllable(s: string): [string, string] {
  const i = INITIALS.find((x) => s.startsWith(x) && s.length > x.length) ?? '';
  return [i, s.slice(i.length)];
}

/**
 * The single accent pattern that turns one syllable into the other, e.g. "l-n" (nan → lan),
 * "f-h", "z-zh", "in-ing"; null when they are equal or differ in both initial and final.
 */
export function confusionOf(a: string, b: string): string | null {
  if (!a || !b || a === b) return null;
  const [ia, fa] = splitSyllable(a);
  const [ib, fb] = splitSyllable(b);
  if (ia !== ib && fa === fb && ia && ib) return [ia, ib].sort().join('-');
  if (fa !== fb && ia === ib && fa && fb) return [fa, fb].sort().join('-');
  return null;
}

/** Sound pairs that Chinese regional accents really merge (anything else is noise, not an accent). */
export const ACCENT_PAIRS: ReadonlySet<string> = new Set(['l-n', 'f-h', 'z-zh', 'c-ch', 's-sh', 'l-r', 'in-ing', 'en-eng', 'an-ang', 'ian-iang', 'uan-uang', 'eng-ong']);

/** `confusionOf`, but only for real accent pairs. */
export function accentPairOf(a: string, b: string): string | null {
  const c = confusionOf(a, b);
  return c && ACCENT_PAIRS.has(c) ? c : null;
}

/**
 * Pinyin syllables close enough to be a mis-hearing: identical, differing only by common
 * confusions, or by one of this user's own accent patterns (`extra`, e.g. "l-r").
 */
export function similarSyllable(a: string, b: string, extra?: ReadonlySet<string>): boolean {
  if (a === b) return true;
  if (extra?.size) {
    const c = confusionOf(a, b);
    if (c && extra.has(c)) return true;
  }
  const norm = (s: string) =>
    s
      .replace(/^zh/, 'z')
      .replace(/^ch/, 'c')
      .replace(/^sh/, 's')
      .replace(/ing$/, 'in')
      .replace(/eng$/, 'en')
      .replace(/ang$/, 'an')
      .replace(/^n/, 'l')
      .replace(/^f/, 'h');
  return norm(a) === norm(b);
}

/**
 * Applies glossary corrections to recognised text:
 * 1. exact alias replacement (known mis-recognitions → canonical term);
 * 2. optionally, for Chinese, pinyin-fuzzy replacement of Han runs that sound like a term
 *    (terms of 2+ characters; at most one syllable may differ for 2–3 character terms, two for 4+).
 */
export function correctText(text: string, base: LangBase, entries: GlossaryEntry[], opts: { pinyinFuzzy: boolean; extraPairs?: readonly string[] }): Correction {
  const extra = opts.extraPairs?.length ? new Set(opts.extraPairs) : undefined;
  const edits: { from: string; to: string }[] = [];
  let out = text;
  for (const e of entries) {
    if (!e.enabled) continue;
    const term = termOf(e, base);
    const aliases = aliasesOf(e, base);
    if (!term) continue;
    for (const alias of aliases) {
      if (!alias || alias === term) continue;
      if (base === 'zh') {
        if (out.includes(alias)) {
          out = out.split(alias).join(term);
          edits.push({ from: alias, to: term });
        }
      } else {
        const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${escapeRegExp(alias)})(?=$|[^\\p{L}\\p{N}])`, 'giu');
        if (re.test(out)) {
          out = out.replace(re, (_m, pre: string) => `${pre}${term}`);
          edits.push({ from: alias, to: term });
        }
      }
    }
  }

  if (base === 'zh' && opts.pinyinFuzzy) {
    for (const e of entries) {
      if (!e.enabled || !e.zh || e.zh.length < 2 || ![...e.zh].every((c) => HAN.test(c))) continue;
      if (out.includes(e.zh)) continue;
      const termPy = syllables(e.zh);
      const n = e.zh.length;
      const allowed = n >= 4 ? 2 : 1;
      const chars = [...out];
      for (let i = 0; i + n <= chars.length; i++) {
        const window = chars.slice(i, i + n);
        if (!window.every((c) => HAN.test(c))) continue;
        const candidate = window.join('');
        const py = syllables(candidate);
        let diff = 0;
        let exactChars = 0;
        for (let k = 0; k < n; k++) {
          if (window[k] === e.zh[k]) exactChars++;
          if (!similarSyllable(py[k] ?? '', termPy[k] ?? '', extra)) diff++;
        }
        // Require at least one identical character so unrelated homophones are left alone.
        if (diff <= allowed && diff < n && exactChars >= 1 && (diff === 0 || exactChars >= n - allowed)) {
          chars.splice(i, n, ...e.zh);
          edits.push({ from: candidate, to: e.zh });
          i += n - 1;
        }
      }
      out = chars.join('');
    }
  }

  if (isLatin(base)) {
    // Restore the canonical capitalisation/accents of Spanish terms the recogniser wrote differently.
    for (const e of entries) {
      const t = termOf(e, base);
      if (!e.enabled || !t) continue;
      const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${escapeRegExp(t)})(?=$|[^\\p{L}\\p{N}])`, 'giu');
      out = out.replace(re, (m, pre: string, word: string) => (word === t ? m : `${pre}${t}`));
      // Accent-insensitive variant ("nebula" → "Nébula").
      const folded = foldLatin(t);
      if (folded !== t.toLowerCase()) {
        const re2 = new RegExp(`(^|[^\\p{L}\\p{N}])(${escapeRegExp(folded)})(?=$|[^\\p{L}\\p{N}])`, 'giu');
        out = out.replace(re2, (m, pre: string, word: string) => {
          if (foldLatin(word) !== folded) return m;
          edits.push({ from: word, to: t });
          return `${pre}${t}`;
        });
      }
    }
  }
  return { text: out, edits };
}
