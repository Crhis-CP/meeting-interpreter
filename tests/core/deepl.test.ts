import { describe, expect, it } from 'vitest';
import { DeeplTranslator, GLOSSARY_PREFIX, buildGlossaryDictionaries, deeplBaseUrl } from '@core/providers/deepl';
import type { GlossaryEntry, GlossaryHit } from '@core/glossary/types';
import { ProviderError, type TranslateRequest } from '@core/providers/types';
import { fakeContext, jsonResponse, waitFor } from '../helpers/fakes';

function entry(zh: string, es: string, extra: Partial<GlossaryEntry> = {}): GlossaryEntry {
  return { id: `${zh}|${es}`, zh, es, aliasesZh: [], aliasesEs: [], note: '', enabled: true, ...extra };
}

function hit(e: GlossaryEntry): GlossaryHit {
  return { source: e.zh, target: e.es, entry: e };
}

function request(over: Partial<TranslateRequest> = {}): TranslateRequest {
  return { text: '你好', from: 'zh-CN', to: 'es-ES', hits: [], context: [], ...over };
}

interface ServerOptions {
  /** Status for POST /v3/glossaries (default 201). */
  createStatus?: number;
  /** Status for POST /v2/translate when it carries a glossary_id (default 200). */
  translateWithGlossaryStatus?: number;
  /** Glossaries that already exist on the account. */
  existing?: { glossary_id: string; name: string }[];
  /** Status for every POST /v2/translate (default 200). */
  translateStatus?: number;
  translateBody?: string;
}

/** A fake DeepL API that records calls and keeps glossaries. */
function deeplServer(opts: ServerOptions = {}) {
  const glossaries: { glossary_id: string; name: string }[] = [...(opts.existing ?? [])];
  let created = 0;
  const ctx = fakeContext(async (url, init) => {
    const method = init.method ?? 'GET';
    const { pathname } = new URL(url);
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    if (pathname === '/v2/translate') {
      if (opts.translateStatus && opts.translateStatus !== 200) return new Response(opts.translateBody ?? '', { status: opts.translateStatus });
      if (body.glossary_id && opts.translateWithGlossaryStatus) return new Response('{"message":"Glossary not found"}', { status: opts.translateWithGlossaryStatus });
      return jsonResponse({ translations: [{ detected_source_language: 'ZH', text: ` Hola #${ctx.requests.length} ` }] });
    }
    if (pathname === '/v3/glossaries' && method === 'GET') return jsonResponse({ glossaries });
    if (pathname === '/v3/glossaries' && method === 'POST') {
      if (opts.createStatus && opts.createStatus >= 400) return new Response('{"message":"Too many glossaries"}', { status: opts.createStatus });
      const g = { glossary_id: `g${++created}`, name: body.name };
      glossaries.push(g);
      return jsonResponse({ ...g, dictionaries: [], creation_time: '2026-11-20T00:00:00Z' }, 201);
    }
    const del = pathname.match(/^\/v3\/glossaries\/(.+)$/);
    if (del && method === 'DELETE') {
      const i = glossaries.findIndex((g) => g.glossary_id === decodeURIComponent(del[1]!));
      if (i >= 0) glossaries.splice(i, 1);
      return new Response(null, { status: 204 });
    }
    return new Response('not found', { status: 404 });
  });
  const calls = (method: string, path: string) =>
    ctx.requests.filter((r) => (r.init.method ?? 'GET') === method && new URL(r.url).pathname === path);
  const translateBodies = () => calls('POST', '/v2/translate').map((r) => JSON.parse(String(r.init.body)));
  return { ctx, glossaries, calls, translateBodies };
}

describe('deepl', () => {
  it('uses the free host for :fx keys', () => {
    expect(deeplBaseUrl('abc-123:fx')).toBe('https://api-free.deepl.com');
    expect(deeplBaseUrl(' abc-123:fx ')).toBe('https://api-free.deepl.com');
    expect(deeplBaseUrl('abc-123')).toBe('https://api.deepl.com');
  });

  it('sends the documented request and returns the translation', async () => {
    const server = deeplServer();
    const t = new DeeplTranslator({ apiKey: 'key-123:fx' }, server.ctx);
    const out = await t.translate(
      request({
        text: '交货期是三周。',
        context: [
          { src: '第一句', dst: 'uno' },
          { src: '第二句', dst: 'dos' },
          { src: '第三句', dst: 'tres' },
          { src: '第四句', dst: 'cuatro' },
        ],
      }),
    );
    expect(out).toBe('Hola #1');
    expect(server.ctx.requests).toHaveLength(1);
    const { url, init } = server.ctx.requests[0]!;
    expect(url).toBe('https://api-free.deepl.com/v2/translate');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ Authorization: 'DeepL-Auth-Key key-123:fx', 'Content-Type': 'application/json' });
    expect(JSON.parse(String(init.body))).toEqual({
      text: ['交货期是三周。'],
      source_lang: 'ZH',
      target_lang: 'ES',
      context: '第二句\n第三句\n第四句',
    });
  });

  it('maps languages: Spanish (Mexico) → ES-419, Chinese → ZH-HANS, Pro host', async () => {
    const server = deeplServer();
    const t = new DeeplTranslator({ apiKey: 'pro-key' }, server.ctx);
    await t.translate(request({ text: '你好', from: 'zh-CN', to: 'es-MX' }));
    await t.translate(request({ text: 'Hola', from: 'es-MX', to: 'zh-CN' }));
    expect(server.ctx.requests.map((r) => r.url)).toEqual(['https://api.deepl.com/v2/translate', 'https://api.deepl.com/v2/translate']);
    const [a, b] = server.translateBodies();
    expect(a).toMatchObject({ source_lang: 'ZH', target_lang: 'ES-419' });
    expect(a.context).toBeUndefined();
    expect(b).toMatchObject({ source_lang: 'ES', target_lang: 'ZH-HANS' });
  });

  it('only uses a glossary when the sentence has glossary hits', async () => {
    const server = deeplServer();
    const entries = [entry('华为', 'Huawei')];
    const t = new DeeplTranslator({ apiKey: 'k:fx' }, server.ctx, () => entries);
    await t.translate(request({ text: '你好' }));
    expect(server.calls('POST', '/v3/glossaries')).toHaveLength(0);
    expect(server.translateBodies()[0].glossary_id).toBeUndefined();
    await t.translate(request({ text: '华为', hits: [hit(entries[0]!)] }));
    expect(server.translateBodies()[1].glossary_id).toBe('g1');
  });

  it('creates the glossary once, reuses it, and recreates it when the entries change', async () => {
    const server = deeplServer();
    let entries = [
      entry('华为', 'Huawei'),
      entry('交货期', 'plazo\tde\nentrega'), // tabs / newlines are not allowed in TSV terms
      entry('华为', 'Huawei Technologies'), // duplicate Chinese source: first one wins for zh→es
      entry('停用', 'desactivado', { enabled: false }),
      entry('只有中文', ''),
    ];
    const t = new DeeplTranslator({ apiKey: 'k:fx' }, server.ctx, () => entries);
    const hits = [hit(entries[0]!)];
    await t.translate(request({ text: '华为的交货期', hits }));
    await t.translate(request({ text: '华为', hits }));

    const creates = server.calls('POST', '/v3/glossaries');
    expect(creates).toHaveLength(1);
    expect(creates[0]!.url).toBe('https://api-free.deepl.com/v3/glossaries');
    expect(creates[0]!.init.headers).toMatchObject({ Authorization: 'DeepL-Auth-Key k:fx' });
    const body = JSON.parse(String(creates[0]!.init.body));
    expect(body.name).toMatch(new RegExp(`^${GLOSSARY_PREFIX}[0-9a-f]{14}$`));
    expect(body.dictionaries).toEqual([
      { source_lang: 'zh', target_lang: 'es', entries: '华为\tHuawei\n交货期\tplazo de entrega', entries_format: 'tsv' },
      { source_lang: 'es', target_lang: 'zh', entries: 'Huawei\t华为\nplazo de entrega\t交货期\nHuawei Technologies\t华为', entries_format: 'tsv' },
    ]);
    expect(server.translateBodies().map((b) => b.glossary_id)).toEqual(['g1', 'g1']);

    entries = [...entries, entry('报价', 'cotización')];
    await t.translate(request({ text: '华为的报价', hits }));
    expect(server.calls('POST', '/v3/glossaries')).toHaveLength(2);
    expect(server.translateBodies()[2].glossary_id).toBe('g2');
    // The old glossary is deleted (best effort, in the background).
    await waitFor(() => server.calls('DELETE', '/v3/glossaries/g1').length === 1);
    expect(server.glossaries.map((g) => g.glossary_id)).toEqual(['g2']);
  });

  it('reuses a glossary with the same contents from an earlier run', async () => {
    const entries = [entry('华为', 'Huawei')];
    const name = buildGlossaryDictionaries(entries)!.name;
    const server = deeplServer({ existing: [{ glossary_id: 'old-run', name }, { glossary_id: 'other', name: 'someone-else' }] });
    const t = new DeeplTranslator({ apiKey: 'k:fx' }, server.ctx, () => entries);
    await t.translate(request({ text: '华为', hits: [hit(entries[0]!)] }));
    expect(server.calls('POST', '/v3/glossaries')).toHaveLength(0);
    expect(server.translateBodies()[0].glossary_id).toBe('old-run');
  });

  it('creates one glossary for concurrent translations', async () => {
    const server = deeplServer();
    const entries = [entry('华为', 'Huawei')];
    const t = new DeeplTranslator({ apiKey: 'k:fx' }, server.ctx, () => entries);
    const hits = [hit(entries[0]!)];
    await Promise.all([t.translate(request({ text: '华为1', hits })), t.translate(request({ text: '华为2', hits })), t.translate(request({ text: '华为3', hits }))]);
    expect(server.calls('POST', '/v3/glossaries')).toHaveLength(1);
    expect(server.translateBodies().map((b) => b.glossary_id)).toEqual(['g1', 'g1', 'g1']);
  });

  it('translates without a glossary when creating it fails, and does not retry right away', async () => {
    const server = deeplServer({ createStatus: 400 });
    const entries = [entry('华为', 'Huawei')];
    const t = new DeeplTranslator({ apiKey: 'k:fx' }, server.ctx, () => entries);
    const hits = [hit(entries[0]!)];
    expect(await t.translate(request({ text: '华为', hits }))).toMatch(/^Hola/);
    await t.translate(request({ text: '华为', hits }));
    expect(server.calls('POST', '/v3/glossaries')).toHaveLength(1);
    expect(server.translateBodies().map((b) => b.glossary_id)).toEqual([undefined, undefined]);
  });

  it('retries without the glossary when DeepL no longer knows it', async () => {
    const server = deeplServer({ translateWithGlossaryStatus: 404 });
    const entries = [entry('华为', 'Huawei')];
    const t = new DeeplTranslator({ apiKey: 'k:fx' }, server.ctx, () => entries);
    expect(await t.translate(request({ text: '华为', hits: [hit(entries[0]!)] }))).toMatch(/^Hola/);
    expect(server.translateBodies().map((b) => b.glossary_id)).toEqual(['g1', undefined]);
  });

  it('never uses a glossary when disabled', async () => {
    const server = deeplServer();
    const entries = [entry('华为', 'Huawei')];
    const t = new DeeplTranslator({ apiKey: 'k:fx', useGlossary: false }, server.ctx, () => entries);
    await t.translate(request({ text: '华为', hits: [hit(entries[0]!)] }));
    expect(server.calls('GET', '/v3/glossaries')).toHaveLength(0);
    expect(server.calls('POST', '/v3/glossaries')).toHaveLength(0);
    expect(server.translateBodies()[0].glossary_id).toBeUndefined();
  });

  it('builds no glossary from entries without both sides', () => {
    expect(buildGlossaryDictionaries([entry('华为', ''), entry('', 'Huawei'), entry('a', 'b', { enabled: false })])).toBeNull();
    const a = buildGlossaryDictionaries([entry('华为', 'Huawei')])!;
    const b = buildGlossaryDictionaries([entry(' 华为 ', 'Huawei')])!;
    expect(a.hash).toBe(b.hash); // same cleaned contents → same glossary
    expect(buildGlossaryDictionaries([entry('华为', 'HUAWEI')])!.hash).not.toBe(a.hash);
  });

  it('explains auth and quota errors in Chinese', async () => {
    const forbidden = deeplServer({ translateStatus: 403, translateBody: '{"message":"Wrong endpoint. Use https://api.deepl.com"}' });
    const err = await new DeeplTranslator({ apiKey: 'k:fx' }, forbidden.ctx).translate(request()).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toContain('403');
    expect(err.message).toContain(':fx');
    expect(err.message).toContain('Wrong endpoint');
    expect(err.retryable).toBe(false);

    const quota = deeplServer({ translateStatus: 456 });
    const err2 = await new DeeplTranslator({ apiKey: 'k:fx' }, quota.ctx).translate(request()).catch((e) => e);
    expect(err2.message).toContain('额度');
    expect(err2.status).toBe(456);

    await expect(new DeeplTranslator({ apiKey: ' ' }, deeplServer().ctx).translate(request())).rejects.toThrow(/DeepL API Key/);
  });

  it('skips empty text and honours an aborted signal', async () => {
    const server = deeplServer();
    const t = new DeeplTranslator({ apiKey: 'k:fx' }, server.ctx);
    expect(await t.translate(request({ text: '  ' }))).toBe('');
    const ac = new AbortController();
    ac.abort();
    await expect(t.translate(request({ signal: ac.signal }))).rejects.toMatchObject({ name: 'AbortError' });
    expect(server.ctx.requests).toHaveLength(0);
  });
});
