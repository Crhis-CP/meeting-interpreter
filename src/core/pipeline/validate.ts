import { baseOf } from '../lang/languages';
import type { LangCode } from '../types';

const HAN = /\p{Script=Han}/gu;
const LETTER = /\p{L}/gu;

/** Strips quotes, labels and notes that language models sometimes add around a translation. */
export function cleanTranslation(text: string): string {
  let t = text.trim();
  t = t.replace(/^```[a-z]*\s*|\s*```$/g, '');
  t = t.replace(/^(translation|traducción|traduccion|译文|翻译|中文|español|spanish|chinese)\s*[:：]\s*/i, '');
  // One pair of wrapping quotes.
  const pairs: [string, string][] = [['"', '"'], ['“', '”'], ['「', '」'], ['«', '»'], ["'", "'"], ['『', '』']];
  for (const [a, b] of pairs) {
    if (t.length > 1 && t.startsWith(a) && t.endsWith(b)) {
      t = t.slice(a.length, t.length - b.length).trim();
      break;
    }
  }
  // Drop trailing explanations in brackets, e.g. "(Note: …)" or "（注：…）".
  t = t.replace(/\s*[（(](note|nota|注|说明)[:：][^)）]*[)）]\s*$/i, '');
  return t.trim();
}

/**
 * Whether `text` is an acceptable translation into `target`. Rejected translations are never
 * spoken (the meeting must not hear the original or the wrong language).
 */
export function isValidTranslation(text: string, target: LangCode, source: string): boolean {
  const t = text.trim();
  if (!t) return false;
  const letters = t.match(LETTER)?.length ?? 0;
  const han = t.match(HAN)?.length ?? 0;
  if (letters === 0 && !/\d/.test(t)) return false;
  const norm = (s: string) => s.replace(/[\s\p{P}]/gu, '').toLowerCase();
  if (norm(t) === norm(source) && (source.match(HAN)?.length ?? 0) > 0) return false;
  if (baseOf(target) === 'es') {
    // Spanish may keep a Chinese name here and there, but not be mostly Chinese.
    return letters === 0 || han / letters <= 0.3;
  }
  // Chinese must contain Chinese; Latin product names are fine alongside.
  return han > 0 || (letters > 0 && letters <= 3);
}
