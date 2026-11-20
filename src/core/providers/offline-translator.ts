import type { LangBase } from '../lang/languages';
import { baseOf } from '../lang/languages';
import { ProviderError, type TranslateRequest, type Translator } from './types';

/** The offline engine as the core sees it (runs in a browser context: worker + wasm). */
export interface OfflineMtEngine {
  translate(text: string, from: LangBase, to: LangBase, signal?: AbortSignal): Promise<string>;
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
    try {
      return (await this.engine.translate(text, baseOf(req.from), baseOf(req.to), req.signal)).trim();
    } catch (err) {
      throw new ProviderError(`离线翻译：${err instanceof Error ? err.message : String(err)}`, 'offline', { retryable: true, cause: err });
    }
  }
}
