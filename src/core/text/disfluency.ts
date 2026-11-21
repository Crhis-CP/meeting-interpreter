/**
 * Spoken-language smoothing before translation ("disfluency removal"): what a human interpreter
 * leaves out — hesitation sounds (呃, eh, um), "怎么说呢", and words said twice in a row while
 * thinking (我们我们我们, el el) — so the other side hears the meaning, not the stammer.
 *
 * Deliberately conservative: only what is certainly a filler goes. A word that also carries
 * meaning stays (este producto, 额度, 好啊, 对吧, "you know the supplier"), reduplicated words stay
 * (谢谢, 看看, 研究研究, muy muy, had had), digits stay (二二, dos dos), and an utterance that is
 * nothing but a filler stays whole ("嗯。" answers "yes"; "Eh?" asks "what?"). Corrections ("下周，
 * 不对，下个月") are left to the translation step, where a model sees the whole sentence.
 *
 * Only the translation input is smoothed; the transcript keeps every word as it was said.
 */
import type { LangBase } from '../lang/languages';

/** Hesitation sounds, as the recognisers write them. */
const ZH_FILLERS = /(^|[，。！？、；：,.!?\s])(?:呃|额|嗯|唔)+(?:[，、,。.！!…]+|\s+|$)/g;
/** Phrases said while searching for words; the punctuation after them stays (it marks the pause). */
const ZH_FILLER_PHRASES = /怎么说呢|怎么讲呢/g;
/** Words that, said twice or more in a row, are a stammer (not 谢谢, 看看, 研究研究…). */
const ZH_REPEATABLE = ['我们', '你们', '他们', '咱们', '这个', '那个', '就是', '然后', '所以', '但是', '因为', '还有', '我', '你', '他', '她', '这', '那', '就', '也', '是'];

const LATIN_FILLER: Record<'es' | 'en', RegExp> = {
  es: /^(?:e+h+|e+m+|eh+m+|m{2,}|hm+|mm+)$/i,
  en: /^(?:u+h+|u+m+|uhm+|erm+|er|hm+|mm+)$/i,
};
/** Spanish "este" is a filler only when drawn out ("este...", "este…"); "este producto" stays. */
const ES_DRAWN_OUT = /^este$/i;
/** Short function words that, said twice in a row (no comma between), are a stammer. */
const LATIN_REPEATABLE: Record<'es' | 'en', Set<string>> = {
  es: new Set(['el', 'la', 'los', 'las', 'un', 'una', 'que', 'y', 'de', 'en', 'a', 'o', 'yo', 'lo', 'le', 'se', 'nos', 'nosotros', 'con', 'por', 'para', 'es']),
  en: new Set(['the', 'a', 'an', 'i', 'we', 'you', 'they', 'he', 'she', 'it', 'and', 'but', 'so', 'to', 'in', 'on', 'of', 'for', 'with', 'my', 'our', 'your']),
};

const hasContent = (s: string) => /[\p{L}\p{N}]/u.test(s);

function smoothZh(text: string): string {
  let s = text.replace(ZH_FILLERS, '$1').replace(ZH_FILLER_PHRASES, '');
  for (const w of ZH_REPEATABLE) s = s.replace(new RegExp(`(${w})(?:${w})+`, 'g'), '$1');
  // A clause that now starts with punctuation (the filler was its first word).
  return s.replace(/^[，、,；;：:\s]+/, '').replace(/([，、,])[，、,]+/g, '$1');
}

function smoothLatin(text: string, lang: 'es' | 'en'): string {
  // Words and the gaps between them, alternating.
  const parts = text.match(/[\p{L}\p{N}'’]+|[^\p{L}\p{N}'’]+/gu) ?? [];
  const isWord = (p: string | undefined) => !!p && /^[\p{L}\p{N}'’]/u.test(p);
  // (An all-capitals word is an abbreviation — ER, MM — never a hesitation.)
  const isFiller = (word: string, gapAfter: string | undefined) =>
    (word !== word.toUpperCase() || word.length === 1) &&
    (LATIN_FILLER[lang].test(word) || (lang === 'es' && ES_DRAWN_OUT.test(word) && /^(?:\.\.\.|…)/.test(gapAfter ?? '')));

  // 1. Fillers go, with the punctuation after them (the pause they filled); the gap before stays.
  const kept: string[] = [];
  let droppedEnd = '';
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (isWord(p) && isFiller(p, parts[i + 1])) {
      if (i + 2 >= parts.length) droppedEnd = (parts[i + 1] ?? '').trim().slice(-1);
      i++;
      continue;
    }
    kept.push(p);
  }

  // 2. A short function word said again right away (only a space between): the first one stays.
  const out: string[] = [];
  for (const p of kept) {
    const gap = out[out.length - 1];
    const prev = out[out.length - 2];
    if (isWord(p) && gap !== undefined && /^\s+$/.test(gap) && prev !== undefined && prev.toLowerCase() === p.toLowerCase() && LATIN_REPEATABLE[lang].has(p.toLowerCase())) {
      out.pop();
      continue;
    }
    out.push(p);
  }

  let s = out.join('').replace(/^[\s,;:]+/, '').replace(/\s+([,;:.!?])/g, '$1').replace(/\s{2,}/g, ' ');
  // The sentence ended with the filler ("…lo hacemos, eh."): end it where it now ends.
  if (/[.!?…]/.test(droppedEnd)) s = s.replace(/[\s,;:]+$/, '') + droppedEnd;
  // A sentence that now starts lower-case (its first word was a filler).
  return s.replace(/^([¿¡]?)(\p{Ll})/u, (_m, mark: string, c: string) => `${mark}${c.toUpperCase()}`);
}

/** The text to translate: fillers and stammered repeats removed (see the module comment). */
export function smoothSpoken(text: string, lang: LangBase): string {
  const out = lang === 'zh' ? smoothZh(text) : smoothLatin(text, lang);
  // Nothing but a filler: it is the answer itself ("嗯。" = yes, "Eh?" = what?).
  return hasContent(out) ? out.trim() : text;
}
