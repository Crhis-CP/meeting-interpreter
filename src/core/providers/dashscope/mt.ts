import { isAbortError } from '../../events';
import { lang } from '../../lang/languages';
import { httpJson } from '../http';
import { ProviderError, type ProviderContext, type TranslateRequest, type Translator } from '../types';
import { DASHSCOPE_DEFAULTS, authHeaders, dashscopeError, dashscopeHost, errorText, resolveModel, type DashscopeConfig } from './common';

/** Qwen-MT domain prompt (must be English). */
export const QWEN_MT_DOMAINS =
  "Spoken business meeting between Chinese and Spanish- or English-speaking participants. Keep the speaker's register, be concise, no explanations.";

const TIMEOUT_MS = 15_000;
/**
 * One quick retry for 429 / 5xx / network errors. The pipeline retries a retryable failure once more,
 * so a hung request costs at most 2 × 15 s per pipeline attempt instead of 3 × 15 s.
 */
const RETRIES = 1;
const LABEL = '百炼翻译';

interface ChatCompletion {
  choices?: { message?: { content?: unknown } }[];
}

/**
 * Qwen-MT over DashScope's OpenAI-compatible endpoint. Qwen-MT takes exactly one user message (no
 * system message); glossary terms, translation memory and the domain go in `translation_options`.
 */
export class QwenMtTranslator implements Translator {
  readonly id = 'qwen-mt';

  constructor(
    private readonly cfg: DashscopeConfig,
    private readonly ctx: ProviderContext,
  ) {}

  get model(): string {
    return resolveModel(this.cfg.mtModel, DASHSCOPE_DEFAULTS.mtModel);
  }

  async translate(req: TranslateRequest): Promise<string> {
    const text = req.text.trim();
    if (!text) return '';
    const headers = authHeaders(this.cfg);
    const url = `https://${dashscopeHost(this.cfg)}/compatible-mode/v1/chat/completions`;
    let res: ChatCompletion;
    try {
      res = await httpJson<ChatCompletion>(this.ctx, LABEL, url, {
        method: 'POST',
        headers,
        json: this.body(text, req),
        timeoutMs: TIMEOUT_MS,
        retries: RETRIES,
        signal: req.signal,
      });
    } catch (err) {
      throw this.mapError(err, req.signal);
    }
    const content = res?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new ProviderError(`${LABEL}：返回内容为空`, this.id, { retryable: true });
    }
    return content.trim();
  }

  private body(text: string, req: TranslateRequest): Record<string, unknown> {
    const options: Record<string, unknown> = {
      source_lang: lang(req.from).codes.qwenMt,
      target_lang: lang(req.to).codes.qwenMt,
    };
    const terms: { source: string; target: string }[] = [];
    for (const hit of req.hits) {
      const source = hit.source?.trim();
      const target = hit.target?.trim();
      if (source && target && !terms.some((t) => t.source === source)) terms.push({ source, target });
    }
    if (terms.length) options.terms = terms;
    const tmList = req.context
      .filter((c) => c.src?.trim() && c.dst?.trim())
      .slice(-3)
      .map((c) => ({ source: c.src.trim(), target: c.dst.trim() }));
    if (tmList.length) options.tm_list = tmList;
    options.domains = QWEN_MT_DOMAINS;
    return { model: this.model, messages: [{ role: 'user', content: text }], translation_options: options };
  }

  private mapError(err: unknown, signal: AbortSignal | undefined): unknown {
    if (signal?.aborted || isAbortError(err)) return err;
    if (err instanceof ProviderError) {
      if (err.status !== undefined) {
        const server = parseServerError(err.message);
        return dashscopeError('mt', { status: err.status, code: server.code, message: server.message, model: this.model, cause: err }, this.cfg);
      }
      return new ProviderError(err.message, this.id, { retryable: err.retryable, cause: err });
    }
    return new ProviderError(`${LABEL}：${errorText(err)}`, this.id, { retryable: true, cause: err });
  }
}

/** Pulls `code` / `message` out of the (redacted, truncated) response body that httpRequest appends after ` — `. */
function parseServerError(message: string): { code?: string; message?: string } {
  const i = message.indexOf(' — ');
  const body = i >= 0 ? message.slice(i + 3).trim() : '';
  if (!body) return {};
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  try {
    const json = JSON.parse(body) as { code?: unknown; message?: unknown; error?: { code?: unknown; message?: unknown } };
    const e = json.error ?? json;
    return { code: str(e.code), message: str(e.message) ?? body };
  } catch {
    return {
      code: /"code"\s*:\s*"([^"]*)"/.exec(body)?.[1] || undefined,
      message: /"message"\s*:\s*"([^"]*)"/.exec(body)?.[1] || body,
    };
  }
}
