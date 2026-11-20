import { sleep } from '../events';
import { redact } from '../log';
import { ProviderError, type ProviderContext } from './types';

export interface HttpRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  /** JSON body (serialised) or raw body. */
  json?: unknown;
  body?: RequestInit['body'];
  timeoutMs?: number;
  /** Retries on network errors, 429 and 5xx. Default 2. */
  retries?: number;
  signal?: AbortSignal;
}

/** Human-readable Chinese hint for common HTTP statuses. */
export function statusHint(status: number): string {
  if (status === 400) return '请求参数有误';
  if (status === 401) return 'Key 无效或已过期（401）';
  if (status === 403) return '没有权限或服务未开通（403）';
  if (status === 404) return '接口或模型不存在（404），请检查地址和模型名';
  if (status === 408) return '请求超时（408）';
  if (status === 413) return '请求内容太大（413）';
  if (status === 429) return '请求太频繁或额度用完（429）';
  if (status >= 500) return `服务暂时不可用（${status}）`;
  return `请求失败（${status}）`;
}

/**
 * fetch with timeout, abort, retries with backoff and errors mapped to ProviderError.
 * Returns the Response (status 2xx) so callers can stream the body.
 */
export async function httpRequest(ctx: ProviderContext, provider: string, url: string, opts: HttpRequestOptions = {}): Promise<Response> {
  const retries = opts.retries ?? 2;
  let attempt = 0;
  for (;;) {
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 20000);
    try {
      const headers: Record<string, string> = { ...(opts.headers ?? {}) };
      let body = opts.body;
      if (opts.json !== undefined) {
        headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
        body = JSON.stringify(opts.json);
      }
      const res = await ctx.fetch(url, { method: opts.method ?? (body ? 'POST' : 'GET'), headers, body, signal: ac.signal });
      if (res.ok) return res;
      const text = await res.text().catch(() => '');
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < retries) {
        attempt++;
        await sleep(500 * 2 ** (attempt - 1), opts.signal);
        continue;
      }
      throw new ProviderError(`${provider}：${statusHint(res.status)}${text ? ` — ${redact(text.slice(0, 300))}` : ''}`, provider, {
        status: res.status,
        retryable,
      });
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      if (opts.signal?.aborted) throw err;
      const timedOut = ac.signal.aborted;
      if (attempt < retries) {
        attempt++;
        await sleep(500 * 2 ** (attempt - 1), opts.signal);
        continue;
      }
      throw new ProviderError(
        `${provider}：${timedOut ? '请求超时' : '网络连接失败'}（${redact(err instanceof Error ? err.message : String(err))}）`,
        provider,
        { retryable: true, cause: err },
      );
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }
}

export async function httpJson<T>(ctx: ProviderContext, provider: string, url: string, opts: HttpRequestOptions = {}): Promise<T> {
  const res = await httpRequest(ctx, provider, url, opts);
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ProviderError(`${provider}：返回内容不是 JSON — ${redact(text.slice(0, 200))}`, provider);
  }
}

/** Reads a streaming response body chunk by chunk. */
export async function* readBody(res: Response): AsyncIterable<Uint8Array> {
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length) yield buf;
    return;
  }
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

export function uuid(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, '');
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}
