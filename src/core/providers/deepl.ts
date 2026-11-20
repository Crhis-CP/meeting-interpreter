import { abortError } from '../events';
import { termOf, type GlossaryEntry } from '../glossary/types';
import { baseOf, lang } from '../lang/languages';
import { httpJson, httpRequest } from './http';
import { ProviderError, type ProviderContext, type TranslateRequest, type Translator } from './types';

export interface DeeplConfig {
  apiKey: string;
  /** Use a DeepL glossary for sentences containing glossary terms. Default true. */
  useGlossary?: boolean;
}

const NAME = 'DeepL';
/** Glossary names are `meeting-interpreter-<hash of the entries>`. */
export const GLOSSARY_PREFIX = 'meeting-interpreter-';
/** After a failed glossary creation, translate without one for this long before trying again. */
const GLOSSARY_RETRY_MS = 60_000;
/** DeepL rejects glossary terms longer than this (UTF-8 bytes). */
const MAX_TERM_BYTES = 1024;

/** Free-plan keys end with `:fx` and use a separate host. */
export function deeplBaseUrl(apiKey: string): string {
  return apiKey.trim().endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
}

/** A short, stable, non-cryptographic hash (cyrb53) as hex. */
export function hashText(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/** DeepL glossary terms may not contain tabs, newlines or other control characters. */
function cleanTerm(term: string): string {
  return (term ?? '')
    .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tooLong(term: string): boolean {
  return new TextEncoder().encode(term).length > MAX_TERM_BYTES;
}

export interface GlossaryDictionaries {
  /** Hash of both dictionaries; part of the glossary name. */
  hash: string;
  name: string;
  /** The other language (`es` or `en`). */
  foreign: 'es' | 'en';
  /** TSV `zh\t<foreign>` lines. */
  zhEs: string;
  /** TSV `<foreign>\tzh` lines. */
  esZh: string;
}

/**
 * The two TSV dictionaries (zh→foreign, foreign→zh) for the enabled entries, with terms cleaned and
 * duplicate sources dropped (DeepL rejects them; the first entry wins). Null when nothing is usable.
 */
export function buildGlossaryDictionaries(entries: readonly GlossaryEntry[], foreign: 'es' | 'en' = 'es'): GlossaryDictionaries | null {
  const zhEs = new Map<string, string>();
  const esZh = new Map<string, string>();
  for (const e of entries) {
    if (!e || e.enabled === false) continue;
    const zh = cleanTerm(e.zh);
    const es = cleanTerm(termOf(e, foreign));
    if (!zh || !es || tooLong(zh) || tooLong(es)) continue;
    if (!zhEs.has(zh)) zhEs.set(zh, es);
    if (!esZh.has(es)) esZh.set(es, zh);
  }
  if (zhEs.size === 0) return null;
  const tsv = (m: Map<string, string>) => [...m].map(([s, t]) => `${s}\t${t}`).join('\n');
  const a = tsv(zhEs);
  const b = tsv(esZh);
  // Spanish keeps the original hash input so glossaries created by earlier versions are reused.
  const hash = hashText(`${foreign === 'es' ? '' : `${foreign}\u0000`}${a}\u0000${b}`);
  return { hash, name: `${GLOSSARY_PREFIX}${hash}`, foreign, zhEs: a, esZh: b };
}

interface DeeplTranslateResponse {
  translations?: { text?: string; detected_source_language?: string }[];
}

interface DeeplGlossary {
  glossary_id: string;
  name?: string;
}

/** Turns DeepL's auth / quota statuses into clearer Chinese messages; other errors pass through. */
function deeplError(err: unknown): unknown {
  if (!(err instanceof ProviderError)) return err;
  const detail = err.message.split(' — ')[1];
  const tail = detail ? ` — ${detail}` : '';
  if (err.status === 401 || err.status === 403) {
    return new ProviderError(`${NAME}：API Key 无效或与接口不匹配（${err.status}），请检查 Key（免费版 Key 以 :fx 结尾）${tail}`, NAME, {
      status: err.status,
      retryable: false,
      cause: err,
    });
  }
  if (err.status === 456) {
    return new ProviderError(`${NAME}：本月字符额度已用完（456）${tail}`, NAME, { status: 456, retryable: false, cause: err });
  }
  return err;
}

/**
 * DeepL text translation. Glossary terms use one DeepL v3 glossary (both directions) built from
 * the enabled entries, created on first need and replaced when the entries change.
 */
export class DeeplTranslator implements Translator {
  readonly id = 'deepl';
  private glossary: { hash: string; id: string } | null = null;
  private pending: { hash: string; promise: Promise<string> } | null = null;
  private glossaryFailure: { hash: string; until: number } | null = null;
  private generation = 0;

  constructor(
    private readonly cfg: DeeplConfig,
    private readonly ctx: ProviderContext,
    private readonly entries: () => GlossaryEntry[] = () => [],
  ) {}

  private get key(): string {
    return (this.cfg.apiKey ?? '').trim();
  }

  private get base(): string {
    return deeplBaseUrl(this.key);
  }

  private get headers(): Record<string, string> {
    return { Authorization: `DeepL-Auth-Key ${this.key}` };
  }

  async translate(req: TranslateRequest): Promise<string> {
    if (!this.key) throw new ProviderError(`${NAME}：请先填写 DeepL API Key`, NAME);
    if (!req.text.trim()) return '';
    if (req.signal?.aborted) throw abortError();

    const body: Record<string, unknown> = {
      text: [req.text],
      source_lang: lang(req.from).codes.deeplSource,
      target_lang: lang(req.to).codes.deeplTarget,
    };
    const context = req.context
      .slice(-3)
      .map((c) => c.src.trim())
      .filter(Boolean)
      .join('\n');
    if (context) body.context = context;

    const glossaryId = this.cfg.useGlossary !== false && req.hits.length > 0 ? await this.glossaryFor(baseOf(req.from) === 'en' || baseOf(req.to) === 'en' ? 'en' : 'es') : null;
    if (req.signal?.aborted) throw abortError();
    if (glossaryId) body.glossary_id = glossaryId;

    try {
      return await this.request(body, req.signal);
    } catch (err) {
      // The glossary may have been deleted elsewhere (e.g. in the DeepL account): retry once without it.
      if (glossaryId && err instanceof ProviderError && (err.status === 400 || err.status === 404) && !req.signal?.aborted) {
        this.ctx.log.warn(`${NAME}: translation with glossary failed, retrying without it`, err.message);
        if (this.glossary?.id === glossaryId) this.glossary = null;
        delete body.glossary_id;
        return await this.request(body, req.signal);
      }
      throw err;
    }
  }

  private async request(body: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    let res: DeeplTranslateResponse;
    try {
      res = await httpJson<DeeplTranslateResponse>(this.ctx, NAME, `${this.base}/v2/translate`, {
        method: 'POST',
        headers: this.headers,
        json: body,
        signal,
        timeoutMs: 15000,
        retries: 1,
      });
    } catch (err) {
      throw deeplError(err);
    }
    const text = res.translations?.[0]?.text;
    if (typeof text !== 'string') throw new ProviderError(`${NAME}：返回内容里没有译文`, NAME, { retryable: true });
    return text.trim();
  }

  /** The glossary id for the current entries, or null (no usable entries, or creating it failed). */
  private async glossaryFor(foreign: 'es' | 'en'): Promise<string | null> {
    const dicts = buildGlossaryDictionaries(this.entries(), foreign);
    if (!dicts) return null;
    if (this.glossary?.hash === dicts.hash) return this.glossary.id;
    if (this.glossaryFailure?.hash === dicts.hash && this.ctx.now() < this.glossaryFailure.until) return null;
    if (this.pending?.hash !== dicts.hash) {
      const promise = this.replaceGlossary(dicts);
      this.pending = { hash: dicts.hash, promise };
      const clear = () => {
        if (this.pending?.promise === promise) this.pending = null;
      };
      promise.then(clear, clear);
    }
    try {
      return await this.pending!.promise;
    } catch (err) {
      this.glossaryFailure = { hash: dicts.hash, until: this.ctx.now() + GLOSSARY_RETRY_MS };
      this.ctx.log.warn(`${NAME}: glossary unavailable, translating without it`, err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  private async replaceGlossary(dicts: GlossaryDictionaries): Promise<string> {
    const generation = ++this.generation;
    const id = (await this.findGlossary(dicts.name)) ?? (await this.createGlossary(dicts));
    // The entries changed again while this one was being created: keep the newer cache entry.
    if (generation !== this.generation) return id;
    const old = this.glossary;
    this.glossary = { hash: dicts.hash, id };
    this.glossaryFailure = null;
    if (old && old.id !== id) void this.deleteGlossary(old.id);
    return id;
  }

  /** Reuses a glossary with the same contents left by an earlier run (best effort). */
  private async findGlossary(name: string): Promise<string | null> {
    try {
      const res = await httpJson<{ glossaries?: DeeplGlossary[] }>(this.ctx, NAME, `${this.base}/v3/glossaries`, {
        method: 'GET',
        headers: this.headers,
        timeoutMs: 10000,
        retries: 0,
      });
      return res.glossaries?.find((g) => g.name === name && g.glossary_id)?.glossary_id ?? null;
    } catch (err) {
      this.ctx.log.debug(`${NAME}: listing glossaries failed`, err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  private async createGlossary(dicts: GlossaryDictionaries): Promise<string> {
    let res: Partial<DeeplGlossary>;
    try {
      res = await httpJson<Partial<DeeplGlossary>>(this.ctx, NAME, `${this.base}/v3/glossaries`, {
        method: 'POST',
        headers: this.headers,
        json: {
          name: dicts.name,
          dictionaries: [
            { source_lang: 'zh', target_lang: dicts.foreign, entries: dicts.zhEs, entries_format: 'tsv' },
            { source_lang: dicts.foreign, target_lang: 'zh', entries: dicts.esZh, entries_format: 'tsv' },
          ],
        },
        timeoutMs: 15000,
        retries: 1,
      });
    } catch (err) {
      throw deeplError(err);
    }
    if (!res.glossary_id) throw new ProviderError(`${NAME}：创建术语表失败（返回内容缺少 glossary_id）`, NAME);
    this.ctx.log.info(`${NAME}: created glossary ${dicts.name}`);
    return res.glossary_id;
  }

  private async deleteGlossary(id: string): Promise<void> {
    try {
      await httpRequest(this.ctx, NAME, `${this.base}/v3/glossaries/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: this.headers,
        timeoutMs: 10000,
        retries: 0,
      });
    } catch (err) {
      this.ctx.log.debug(`${NAME}: deleting old glossary failed`, err instanceof Error ? err.message : String(err));
    }
  }
}
