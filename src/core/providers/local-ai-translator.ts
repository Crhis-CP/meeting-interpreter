/**
 * Free, offline translation with a small local AI model (Tencent Hy-MT2-1.8B, Apache-2.0), run on
 * the user's computer by llama.cpp. As accurate as the cloud LLMs on our meeting benchmark
 * (docs/translation-benchmark.md), about a second per sentence on an ordinary CPU.
 */
import { baseOf, type LangBase } from '../lang/languages';
import { plainSpanish } from './offline-translator';
import { ProviderError, type TranslateRequest, type Translator } from './types';

/** Runs one prompt through the local model (in a worker process / via the desktop app). */
export interface LocalAiEngine {
  /**
   * `lane`: 0 into the other language, 1 into Chinese (each direction keeps its own cached prefix).
   * `maxTokens`: a cap for the answer (a model stuck repeating itself must not hold up the next sentences).
   */
  complete(prompt: string, signal?: AbortSignal, lane?: number, maxTokens?: number): Promise<string>;
}

/**
 * How long a translation of `text` can sensibly be, in tokens, with room to spare: a Chinese
 * character becomes up to ~3 tokens of Spanish or English; the other way round, ~1 per character.
 */
export function answerBudget(text: string, from: LangBase): number {
  const n = [...text].length;
  return Math.min(400, 32 + Math.ceil(n * (from === 'zh' ? 3 : 1.2)));
}

const NAME_ZH: Record<LangBase, string> = { zh: '中文', es: '西班牙语', en: '英语' };

/** Hy-MT2's own instruction (from its model card), with the user's terms as reference translations. */
export function hyMtPrompt(text: string, from: LangBase, to: LangBase, terms: { source: string; target: string }[]): string {
  void from;
  const refs = terms.filter((t) => t.source && t.target).slice(0, 20);
  const head = refs.length ? `参考下面的翻译：\n${refs.map((t) => `${t.source} 翻译成 ${t.target}`).join('\n')}\n\n` : '';
  return `${head}将以下文本翻译为${NAME_ZH[to]}，注意只需要输出翻译后的结果，不要额外解释：\n\n${text}`;
}

/** The model sometimes wraps the answer in quotes or adds a label: keep just the translation. */
function clean(out: string): string {
  let s = out.trim().replace(/^(译文|翻译|Traducción|Translation)\s*[:：]\s*/i, '');
  const pairs: [string, string][] = [['“', '”'], ['"', '"'], ['「', '」'], ['«', '»']];
  for (const [a, b] of pairs) if (s.startsWith(a) && s.endsWith(b) && s.length > 2) s = s.slice(a.length, -b.length).trim();
  return s;
}

export class LocalAiTranslator implements Translator {
  readonly id = 'local-ai';
  /** `fallback` (the Mozilla models) translates while the model loads or if it fails. */
  constructor(
    private readonly engine: LocalAiEngine,
    private readonly fallback?: Translator,
  ) {}

  async translate(req: TranslateRequest): Promise<string> {
    const from = baseOf(req.from);
    const to = baseOf(req.to);
    const text = from === 'es' ? plainSpanish(req.text) : req.text;
    try {
      const out = clean(await this.engine.complete(hyMtPrompt(text, from, to, req.hits), req.signal, to === 'zh' ? 1 : 0, answerBudget(text, from)));
      if (!out) throw new Error('没有翻译结果');
      return out;
    } catch (err) {
      if (req.signal?.aborted) throw err;
      if (this.fallback) return this.fallback.translate(req);
      throw new ProviderError(`本机 AI 翻译：${err instanceof Error ? err.message : String(err)}`, 'local-ai', { retryable: false, cause: err });
    }
  }
}
