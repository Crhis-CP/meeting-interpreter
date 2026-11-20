import { pinyin } from 'pinyin-pro';
import type { LangBase } from '../lang/languages';
import { foldLatin } from './match';
import type { GlossaryEntry } from './types';

export interface Correction {
  text: string;
  edits: { from: string; to: string }[];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const HAN = /\p{Script=Han}/u;

/** Toneless pinyin syllables for each character (non-Han characters map to themselves). */
function syllables(text: string): string[] {
  return pinyin(text, { toneType: 'none', type: 'array', nonZh: 'consecutive' }) as string[];
}

/** Pinyin syllables close enough to be a mis-hearing: identical, or differing only by common confusions. */
function similarSyllable(a: string, b: string): boolean {
  if (a === b) return true;
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
export function correctText(text: string, base: LangBase, entries: GlossaryEntry[], opts: { pinyinFuzzy: boolean }): Correction {
  const edits: { from: string; to: string }[] = [];
  let out = text;
  for (const e of entries) {
    if (!e.enabled) continue;
    const term = base === 'zh' ? e.zh : e.es;
    const aliases = base === 'zh' ? e.aliasesZh : e.aliasesEs;
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
          if (!similarSyllable(py[k] ?? '', termPy[k] ?? '')) diff++;
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

  if (base === 'es') {
    // Restore the canonical capitalisation/accents of Spanish terms the recogniser wrote differently.
    for (const e of entries) {
      if (!e.enabled || !e.es) continue;
      const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${escapeRegExp(e.es)})(?=$|[^\\p{L}\\p{N}])`, 'giu');
      out = out.replace(re, (m, pre: string, word: string) => (word === e.es ? m : `${pre}${e.es}`));
      // Accent-insensitive variant ("nebula" → "Nébula").
      const folded = foldLatin(e.es);
      if (folded !== e.es.toLowerCase()) {
        const re2 = new RegExp(`(^|[^\\p{L}\\p{N}])(${escapeRegExp(folded)})(?=$|[^\\p{L}\\p{N}])`, 'giu');
        out = out.replace(re2, (m, pre: string, word: string) => {
          if (foldLatin(word) !== folded) return m;
          edits.push({ from: word, to: e.es });
          return `${pre}${e.es}`;
        });
      }
    }
  }
  return { text: out, edits };
}
