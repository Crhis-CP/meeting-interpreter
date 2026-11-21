import { pinyin } from 'pinyin-pro';
import { isLatin, type LangBase } from '../lang/languages';
import { relatedBy, split } from '../profile/accents';
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

/** A toneless syllable as [initial, final] ("zhang" → ["zh", "ang"], "an" → ["", "an"]). */
export const splitSyllable = split;

/**
 * The accent feature that turns one syllable into the other ("l-n" for nan / lan, "f-hu" for
 * fa / hua, "r-y" for ren / yin…), or null (docs/accents.md).
 */
export function accentPairOf(a: string, b: string): string | null {
  return relatedBy(a, b);
}

/**
 * Pinyin syllables close enough to be a mis-hearing: identical, differing only by common
 * confusions, or by one of this user's own accent patterns (`extra`, e.g. "l-r").
 */
export function similarSyllable(a: string, b: string, extra?: ReadonlySet<string>): boolean {
  if (a === b) return true;
  if (extra?.size) {
    const c = relatedBy(a, b);
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
 * How a Spanish word sounds, for names and brands the recogniser spelled by ear: accents folded,
 * silent h dropped, b = v, s = z = soft c, ll = y, hard c = qu = k, soft g = j, double letters
 * single ("Nevula" ≈ "Nébula", "Sárate" ≈ "Zárate", "Ernández" ≈ "Hernández", "Llerba" ≈ "Yerba").
 */
export function spanishSound(s: string): string {
  return foldLatin(s)
    .replace(/ch/g, '§')
    .replace(/h/g, '')
    .replace(/qu(?=[ei])/g, 'k')
    .replace(/c(?=[ei])/g, 's')
    .replace(/g(?=[ei])/g, 'j')
    .replace(/gu(?=[ei])/g, 'g')
    .replace(/ll/g, 'y')
    .replace(/[cq]/g, 'k')
    .replace(/v/g, 'b')
    .replace(/z/g, 's')
    .replace(/(.)\1+/g, '$1')
    .replace(/§/g, 'ch');
}

/** A name or brand (capital letter, digit, several words): only these are matched by sound. */
function isNameLike(term: string): boolean {
  return /^\p{Lu}/u.test(term) || /\d/.test(term) || /\s/.test(term.trim());
}

/**
 * Applies glossary corrections to recognised text:
 * 1. exact alias replacement (known mis-recognitions → canonical term);
 * 2. optionally, for Chinese, pinyin-fuzzy replacement of Han runs that sound like a term (terms
 *    of 2+ characters): every syllable must sound alike — the same, a common merge, or one of this
 *    user's accent features — with at least one identical character; a term of 4+ characters may
 *    have one syllable that does not, when all its other characters are identical. (Before 0.9 a
 *    3-character term replaced any word sharing two characters: 销售数据 became 销售额据.)
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
      const allowed = n >= 4 ? 1 : 0;
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
        if (diff <= allowed && exactChars >= 1 && (diff === 0 || exactChars >= n - 1)) {
          chars.splice(i, n, ...e.zh);
          edits.push({ from: candidate, to: e.zh });
          i += n - 1;
        }
      }
      out = chars.join('');
    }
  }

  if (base === 'es') {
    // Names and brands that sound the same (spanishSound): the whole words must match by sound,
    // and the term must look like a name — ordinary lower-case words are never changed this way.
    for (const e of entries) {
      const t = termOf(e, base).trim();
      if (!e.enabled || !t || !isNameLike(t) || spanishSound(t).replace(/\s/g, '').length < 4) continue;
      const n = t.split(/\s+/).length;
      const key = spanishSound(t);
      const words = [...out.matchAll(/[\p{L}\p{N}]+/gu)];
      for (let i = words.length - n; i >= 0; i--) {
        const first = words[i]!;
        const last = words[i + n - 1]!;
        const from = first.index!;
        const to = last.index! + last[0].length;
        const candidate = out.slice(from, to);
        if (/[^\p{L}\p{N}\s]/u.test(candidate) || foldLatin(candidate) === foldLatin(t)) continue;
        if (spanishSound(candidate.replace(/\s+/g, ' ')) !== key) continue;
        out = out.slice(0, from) + t + out.slice(to);
        edits.push({ from: candidate, to: t });
      }
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
