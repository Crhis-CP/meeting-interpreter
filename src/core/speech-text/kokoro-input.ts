/**
 * What the natural voices (Kokoro) are given for a sentence. Chinese and English go in as text (the
 * model's own word lists and number rules read them); Spanish goes in as phonemes from our reading
 * rules (es-read.ts) and pronunciation (es-phonemes.ts), one entry per sentence, so each sentence is
 * spoken with its own intonation and the first one plays while the next is made.
 */
import type { LangBase } from '../lang/languages';
import { spanishPhonemes } from './es-phonemes';
import { spanishForSpeech } from './es-read';

export type KokoroInput = { text: string } | { phonemes: string[] };

/** The model reads at most ~500 symbols at once; a sentence longer than this is split at its commas. */
const MAX_PHONEMES = 300;

/** Sentences: after . ? ! … followed by a space (not inside "3.5" or "S.A."-like abbreviations). */
export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.?!…])\s+(?=[¿¡"«(]?[\p{Lu}\d])/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Splits phonemes longer than the model takes at commas (or, failing that, at spaces). */
function fit(ph: string): string[] {
  if (ph.length <= MAX_PHONEMES) return [ph];
  const out: string[] = [];
  let cur = '';
  for (const part of ph.split(/(?<=,) /)) {
    if (cur && cur.length + part.length + 1 > MAX_PHONEMES) {
      out.push(cur);
      cur = part;
    } else cur = cur ? `${cur} ${part}` : part;
  }
  if (cur) out.push(cur);
  // A clause still too long (no commas): at word boundaries.
  return out.flatMap((p) => {
    if (p.length <= MAX_PHONEMES) return [p];
    const words = p.split(' ');
    const pieces: string[] = [];
    let w = '';
    for (const x of words) {
      if (w && w.length + x.length + 1 > MAX_PHONEMES) {
        pieces.push(w);
        w = x;
      } else w = w ? `${w} ${x}` : x;
    }
    if (w) pieces.push(w);
    return pieces;
  });
}

export function kokoroInput(text: string, lang: LangBase): KokoroInput {
  if (lang !== 'es') return { text: text.trim() };
  const phonemes = sentences(spanishForSpeech(text))
    .map((s) => spanishPhonemes(s, { affricate: 'ʧ' }).trim())
    .filter((p) => /[a-zɲʝβðɣŋɾʧ]/.test(p))
    .flatMap(fit);
  return { phonemes };
}
