import type { LangBase } from '../lang/languages';
import type { GlossaryEntry, GlossaryHit } from './types';

/** Lower-cases and strips accents so "Nébula" matches "nebula". */
export function foldLatin(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole-word, case- and accent-insensitive search for a Latin-script term. */
export function containsLatinTerm(text: string, term: string): boolean {
  if (!term.trim()) return false;
  const t = foldLatin(text);
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(foldLatin(term.trim()))}(?=$|[^\\p{L}\\p{N}])`, 'u');
  return re.test(t);
}

function containsTerm(text: string, term: string, base: LangBase): boolean {
  if (!term) return false;
  if (base === 'zh') {
    // Chinese has no word boundaries; Latin parts inside Chinese terms (e.g. "AI平台") match case-insensitively.
    return /[A-Za-z]/.test(term) ? text.toLowerCase().includes(term.toLowerCase()) : text.includes(term);
  }
  return containsLatinTerm(text, term);
}

/**
 * Glossary terms that occur in `text` (source language `from`), with the fixed translation in the
 * other language. Aliases (known mis-recognitions) count as occurrences of the term.
 * Longer terms win when one contains another ("星云平台" over "星云").
 */
export function findHits(text: string, from: LangBase, entries: GlossaryEntry[]): GlossaryHit[] {
  const hits: GlossaryHit[] = [];
  const sorted = [...entries].sort((a, b) => (b[from]?.length ?? 0) - (a[from]?.length ?? 0));
  const covered: string[] = [];
  for (const e of sorted) {
    if (!e.enabled) continue;
    const source = from === 'zh' ? e.zh : e.es;
    const target = from === 'zh' ? e.es : e.zh;
    if (!source || !target) continue;
    const aliases = from === 'zh' ? e.aliasesZh : e.aliasesEs;
    const found = containsTerm(text, source, from) || aliases.some((a) => containsTerm(text, a, from));
    if (!found) continue;
    if (covered.some((c) => c.includes(source) && c !== source)) continue;
    covered.push(source);
    hits.push({ source, target, entry: e });
  }
  return hits;
}

/** Terms to send to a recogniser as hot words for the given language. */
export function hotwordsFor(base: LangBase, entries: GlossaryEntry[], limit = 500): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of entries) {
    if (!e.enabled) continue;
    const term = (base === 'zh' ? e.zh : e.es).trim();
    if (term && !seen.has(term)) {
      seen.add(term);
      out.push(term);
    }
    if (out.length >= limit) break;
  }
  return out;
}

/** True when the translation contains the fixed target term (used to warn, never to block). */
export function translationHonoursHit(translation: string, hit: GlossaryHit, to: LangBase): boolean {
  return containsTerm(translation, hit.target, to);
}
