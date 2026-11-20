import type { LangBase } from '../lang/languages';
import { baseOf } from '../lang/languages';
import { ProviderError, type TranslateRequest, type Translator } from './types';

/** The offline engine as the core sees it (runs in a browser context: worker + wasm). */
export interface OfflineMtEngine {
  translate(text: string, from: LangBase, to: LangBase, signal?: AbortSignal): Promise<string>;
}

// Sentence start: the beginning, or after . ! ? ¿ ¡ (and spaces).
const START = String.raw`(^|[.!?¿¡]\s*)`;
// Followed by a comma / end of sentence (the word stands on its own, as an interjection).
const ALONE = String.raw`(?=\s*[,.!?;]|\s*$)`;
const rx = (src: string) => new RegExp(src, 'giu');

/** Everyday (mostly Rioplatense) words and set phrases the offline models mistranslate, as plain Spanish. */
const PLAIN_SPANISH: [RegExp, string | ((...m: string[]) => string)][] = [
  [rx(`${START}che\\s*,?\\s*`), '$1'],
  [rx(`${START}dale${ALONE}`), '$1De acuerdo'],
  [rx(`${START}listo(?=\\s*[,.!;]|\\s*$)`), '$1Bien'],
  [rx(`${START}b[aá]rbar[oa]${ALONE}`), '$1Genial'],
  [rx(`${START}ojo(?=\\s*,)`), '$1Atención'],
  [rx(`\\b(est[aá]n?|es|son|estaba|era|fue|qued[oó]|sali[oó])\\s+re\\s+`), '$1 muy '],
  [rx(`\\s*,?\\s*¿viste\\?`), '.'],
  [rx(`${START}(nos|me) parece bien${ALONE}`), (_m, pre, who) => `${pre}${who.toLowerCase() === 'nos' ? 'Estamos' : 'Estoy'} de acuerdo`],
  [rx(`\\blaburo(s?)\\b`), 'trabajo$1'],
  [rx(`\\blaburar\\b`), 'trabajar'],
  [rx(`\\b(m)e pas[aá]s\\b(?!\\s+(?:a|por)\\b)`), '$1e das'],
  [rx(`\\b(p)asame\\b`), (_m, p) => (p === 'P' ? 'Dame' : 'dame')],
];

/** Rewrites everyday Argentine / Latin American expressions into plain Spanish (offline models only). */
export function plainSpanish(text: string): string {
  let out = text;
  for (const [re, to] of PLAIN_SPANISH) out = out.replace(re, to as string);
  return out.replace(/\.\s*\./g, '.');
}

/**
 * Free, keyless translation with Mozilla's offline models. Glossary terms are protected: each term
 * in the sentence is swapped for its fixed translation before translating (names and product terms
 * pass through these models unchanged), so the result uses the user's wording.
 */
export class OfflineTranslator implements Translator {
  readonly id = 'offline';
  constructor(private readonly engine: OfflineMtEngine) {}

  async translate(req: TranslateRequest): Promise<string> {
    let text = req.text;
    for (const h of [...req.hits].sort((a, b) => b.source.length - a.source.length)) {
      if (h.source && h.target) text = text.split(h.source).join(h.target);
    }
    if (baseOf(req.from) === 'es') text = plainSpanish(text);
    try {
      return (await this.engine.translate(text, baseOf(req.from), baseOf(req.to), req.signal)).trim();
    } catch (err) {
      throw new ProviderError(`离线翻译：${err instanceof Error ? err.message : String(err)}`, 'offline', { retryable: true, cause: err });
    }
  }
}
