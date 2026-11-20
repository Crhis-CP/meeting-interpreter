import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ProviderError } from '@core/providers/types';
import { ModelManager, type DownloadProgress } from '../../src/main/providers/local-asr/model-manager';
import { MODEL_BASE_URLS, MODELS, modelsForLang, modelsSize, type ModelId, type ModelSpec } from '../../src/main/providers/local-asr/models';

const tmp = () => mkdtempSync(join(tmpdir(), 'mi-models-test-'));
const HF = 'https://huggingface.co';
const REV: Record<string, string> = Object.fromEntries(Object.values(MODELS).map((m) => [m.repo, m.files[0]!.url.split('/')[3]!]));
const at = (repo: string, name: string) => `${repo}/resolve/${REV[repo]}/${name}`;
const MIRROR = 'https://hf-mirror.com';

function content(size: number, seed = 7): Uint8Array {
  const b = new Uint8Array(size);
  for (let i = 0; i < size; i++) b[i] = (i * 31 + seed) & 0xff;
  return b;
}

/** The real manifest (real URL paths) with small sizes so fake downloads stay tiny, hashed like the real one. */
const SMALL: Record<ModelId, ModelSpec> = Object.fromEntries(
  Object.entries(MODELS).map(([id, spec]) => [
    id,
    { ...spec, files: spec.files.map((f, i) => ({ ...f, size: 1000 + 100 * i, sha256: createHash('sha256').update(content(1000 + 100 * i, f.name.length)).digest('hex') })) },
  ]),
) as Record<ModelId, ModelSpec>;

/** The body for a URL of the small manifest. */
function bodyFor(url: string): Uint8Array {
  for (const spec of Object.values(SMALL)) {
    for (const f of spec.files) if (url.endsWith(`/${f.url}`)) return content(f.size, f.name.length);
  }
  throw new Error(`unexpected url ${url}`);
}

interface StreamOpts {
  status?: number;
  chunks?: number;
  /** Error the stream after this many chunks. */
  failAfter?: number;
  /** Never deliver more than this many chunks (the connection stalls). */
  hangAfter?: number;
  headers?: Record<string, string>;
}

function streamed(data: Uint8Array, opts: StreamOpts = {}): Response {
  const n = opts.chunks ?? 4;
  const size = Math.ceil(data.length / n);
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (opts.failAfter !== undefined && i >= opts.failAfter) return controller.error(new Error('connection reset'));
      if (opts.hangAfter !== undefined && i >= opts.hangAfter) return new Promise<void>(() => undefined);
      if (i * size >= data.length) return controller.close();
      controller.enqueue(data.slice(i * size, (i + 1) * size));
      i++;
    },
  });
  return new Response(body, { status: opts.status ?? 200, headers: { 'content-length': String(data.length), ...opts.headers } });
}

function fakeFetch(route: (url: string, headers: Record<string, string>) => Response | Promise<Response>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const headers = { ...((init.headers ?? {}) as Record<string, string>) };
    calls.push({ url, headers });
    return route(url, headers);
  }) as typeof fetch;
  return { fn, calls };
}

describe('model manifest', () => {
  it('lists Hugging Face then hf-mirror, every file pinned to a commit and a SHA-256', () => {
    expect(MODEL_BASE_URLS).toEqual([HF, MIRROR]);
    for (const spec of Object.values(MODELS)) {
      for (const f of spec.files) {
        expect(f.url).toMatch(new RegExp(`^${spec.repo}/resolve/[0-9a-f]{40}/${f.name.replace(/\./g, '\\.')}$`));
        expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(f.size).toBeGreaterThan(100_000);
      }
    }
    expect(MODELS['silero-vad'].files.map((f) => f.url)).toEqual(['csukuangfj/vad/resolve/fba88cd2e921609e7675c3aaf51e0b9b295da4bc/silero_vad.onnx']);
    expect(MODELS.sensevoice.files.map((f) => f.name)).toEqual(['model.int8.onnx', 'tokens.txt']);
    expect(MODELS['whisper-small'].files.map((f) => f.name)).toEqual(['small-encoder.int8.onnx', 'small-decoder.int8.onnx', 'small-tokens.txt']);
    expect(MODELS['whisper-base'].files.map((f) => f.name)).toEqual(['base-encoder.int8.onnx', 'base-decoder.int8.onnx', 'base-tokens.txt']);
  });

  it('maps languages to models: zh → VAD + SenseVoice, es → VAD + Whisper (small by default)', () => {
    expect(modelsForLang('zh-CN')).toEqual(['silero-vad', 'sensevoice']);
    expect(modelsForLang('es-MX')).toEqual(['silero-vad', 'whisper-small']);
    expect(modelsForLang('es', 'whisper-base')).toEqual(['silero-vad', 'whisper-base']);
    expect(Math.round(modelsSize(['silero-vad', 'sensevoice']) / 1e6)).toBe(241);
  });
});

describe('ModelManager', () => {
  it('downloads to <dir>/<id>/<file> from Hugging Face and reports the models ready', async () => {
    const dir = tmp();
    const { fn, calls } = fakeFetch((url) => streamed(bodyFor(url)));
    const mm = new ModelManager(dir, fn, { models: SMALL });
    expect(mm.status('sensevoice')).toBe('missing');
    expect(mm.missingBytes(['silero-vad', 'sensevoice'])).toBe(1000 + 1000 + 1100);

    await mm.ensureFor('zh', 'whisper-small');

    expect(calls.map((c) => c.url)).toEqual([
      `${HF}/${at('csukuangfj/vad', 'silero_vad.onnx')}`,
      `${HF}/${at('csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17', 'model.int8.onnx')}`,
      `${HF}/${at('csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17', 'tokens.txt')}`,
    ]);
    const model = mm.pathOf('sensevoice', 'model.int8.onnx');
    expect(model).toBe(join(dir, 'sensevoice', 'model.int8.onnx'));
    expect(readFileSync(model)).toEqual(Buffer.from(bodyFor(calls[1]!.url)));
    expect(existsSync(`${model}.part`)).toBe(false);
    expect(mm.status('silero-vad')).toBe('ready');
    expect(mm.status('sensevoice')).toBe('ready');
    expect(mm.missingBytes(['silero-vad', 'sensevoice'])).toBe(0);
    expect(mm.statusList('whisper-small').map((r) => [r.id, r.ready])).toEqual([
      ['silero-vad', true],
      ['sensevoice', true],
      ['whisper-small', false],
    ]);
  });

  it('describes the models for the settings page with real sizes', () => {
    const rows = new ModelManager(tmp()).statusList('whisper-base');
    expect(rows).toEqual([
      { id: 'silero-vad', name: MODELS['silero-vad'].label, ready: false, sizeMb: 2 },
      { id: 'sensevoice', name: MODELS.sensevoice.label, ready: false, sizeMb: 240 },
      { id: 'whisper-base', name: MODELS['whisper-base'].label, ready: false, sizeMb: 161 },
    ]);
    expect(new ModelManager(tmp()).statusList('whisper-small')[2]).toMatchObject({ id: 'whisper-small', sizeMb: 375 });
  });

  it('downloads the chosen Whisper model for Spanish', async () => {
    const { fn, calls } = fakeFetch((url) => streamed(bodyFor(url)));
    const mm = new ModelManager(tmp(), fn, { models: SMALL });
    await mm.ensureFor('es', 'whisper-base');
    expect(calls.map((c) => c.url.split('/').pop())).toEqual(['silero_vad.onnx', 'base-encoder.int8.onnx', 'base-decoder.int8.onnx', 'base-tokens.txt']);
    expect(mm.status('whisper-base')).toBe('ready');
    expect(mm.status('whisper-small')).toBe('missing');
  });

  it('falls back to the mirror when Hugging Face answers 500', async () => {
    const { fn, calls } = fakeFetch((url) => (url.startsWith(HF) ? new Response('oops', { status: 500 }) : streamed(bodyFor(url))));
    const mm = new ModelManager(tmp(), fn, { models: SMALL });
    await mm.ensure(['silero-vad']);
    expect(calls.map((c) => c.url)).toEqual([`${HF}/${at('csukuangfj/vad', 'silero_vad.onnx')}`, `${MIRROR}/${at('csukuangfj/vad', 'silero_vad.onnx')}`]);
    expect(mm.status('silero-vad')).toBe('ready');
  });

  it('skips files already present (and genuine) and replaces implausible ones', async () => {
    const dir = tmp();
    const { fn, calls } = fakeFetch((url) => streamed(bodyFor(url)));
    const mm = new ModelManager(dir, fn, { models: SMALL });
    const write = (id: string, name: string, size: number, genuine = true) => {
      const p = mm.pathOf(id, name);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, genuine ? content(size, name.length) : content(size));
    };
    write('silero-vad', 'silero_vad.onnx', 1000);
    write('sensevoice', 'model.int8.onnx', 1000);
    write('sensevoice', 'tokens.txt', 20, false); // e.g. an error page saved under the final name
    await mm.ensure(['silero-vad', 'sensevoice']);
    expect(calls.map((c) => c.url.split('/').pop())).toEqual(['tokens.txt']);
    expect(readFileSync(mm.pathOf('sensevoice', 'tokens.txt')).length).toBe(1100);
  });

  it('reports progress per file up to the full size', async () => {
    const { fn } = fakeFetch((url) => streamed(bodyFor(url), { chunks: 5 }));
    const mm = new ModelManager(tmp(), fn, { models: SMALL });
    const events: DownloadProgress[] = [];
    await mm.ensure(['silero-vad'], (p) => events.push(p));
    expect(events[0]).toEqual({ id: 'silero-vad', file: 'silero_vad.onnx', received: 0, total: 1000 });
    expect(events.at(-1)).toEqual({ id: 'silero-vad', file: 'silero_vad.onnx', received: 1000, total: 1000 });
    expect(events).toHaveLength(6);
    for (let i = 1; i < events.length; i++) expect(events[i]!.received).toBeGreaterThan(events[i - 1]!.received);
  });

  it('resumes a partial download with a Range request', async () => {
    const dir = tmp();
    const full = bodyFor(`/${SMALL['silero-vad'].files[0]!.url}`);
    const { fn, calls } = fakeFetch((_url, headers) => {
      expect(headers.Range).toBe('bytes=400-');
      return streamed(full.slice(400), { status: 206 });
    });
    const mm = new ModelManager(dir, fn, { models: SMALL });
    const dest = mm.pathOf('silero-vad', 'silero_vad.onnx');
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(`${dest}.part`, full.slice(0, 400));
    const events: DownloadProgress[] = [];
    await mm.ensure(['silero-vad'], (p) => events.push(p));
    expect(calls).toHaveLength(1);
    expect(events[0]).toMatchObject({ received: 400, total: 1000 });
    expect(readFileSync(dest)).toEqual(Buffer.from(full));
    expect(existsSync(`${dest}.part`)).toBe(false);
  });

  it('continues from the mirror when the connection drops in the middle of a file', async () => {
    const full = bodyFor(`/${SMALL['silero-vad'].files[0]!.url}`);
    const { fn, calls } = fakeFetch((url, headers) => {
      if (url.startsWith(HF)) return streamed(full, { chunks: 4, failAfter: 2 });
      const from = Number(/bytes=(\d+)-/.exec(headers.Range ?? '')?.[1] ?? 0);
      return streamed(full.slice(from), { status: from ? 206 : 200 });
    });
    const mm = new ModelManager(tmp(), fn, { models: SMALL });
    await mm.ensure(['silero-vad']);
    expect(calls[1]!.headers.Range).toBe('bytes=500-');
    expect(readFileSync(mm.pathOf('silero-vad', 'silero_vad.onnx'))).toEqual(Buffer.from(full));
  });

  it('drops a stalled connection and tries the mirror', async () => {
    const full = bodyFor(`/${SMALL['silero-vad'].files[0]!.url}`);
    const { fn, calls } = fakeFetch((url, headers) => {
      if (url.startsWith(HF)) return streamed(full, { hangAfter: 1 });
      const from = Number(/bytes=(\d+)-/.exec(headers.Range ?? '')?.[1] ?? 0);
      return streamed(full.slice(from), { status: from ? 206 : 200 });
    });
    const mm = new ModelManager(tmp(), fn, { models: SMALL, stallTimeoutMs: 50 });
    await mm.ensure(['silero-vad']);
    expect(calls.map((c) => c.url.startsWith(HF))).toEqual([true, false]);
    expect(mm.status('silero-vad')).toBe('ready');
  });

  it('rejects a wrong-sized body (an HTML page) and takes the file from the mirror', async () => {
    const { fn } = fakeFetch((url) => (url.startsWith(HF) ? streamed(new TextEncoder().encode('<html>blocked</html>')) : streamed(bodyFor(url))));
    const mm = new ModelManager(tmp(), fn, { models: SMALL });
    await mm.ensure(['silero-vad']);
    expect(readFileSync(mm.pathOf('silero-vad', 'silero_vad.onnx')).length).toBe(1000);
  });

  it('fails with a Chinese ProviderError naming the file when every host fails', async () => {
    const { fn, calls } = fakeFetch(() => new Response('down', { status: 503 }));
    const mm = new ModelManager(tmp(), fn, { models: SMALL });
    const err = await mm.ensure(['sensevoice']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).retryable).toBe(true);
    expect((err as Error).message).toMatch(/model\.int8\.onnx 下载失败.*huggingface\.co：HTTP 503.*hf-mirror\.com：HTTP 503/);
    expect(calls).toHaveLength(2);
    expect(mm.status('sensevoice')).toBe('missing');
  });

  it('stops on abort without trying the mirror and keeps the partial file for later', async () => {
    const full = bodyFor(`/${SMALL['silero-vad'].files[0]!.url}`);
    const { fn, calls } = fakeFetch(() => streamed(full, { hangAfter: 1 }));
    const mm = new ModelManager(tmp(), fn, { models: SMALL });
    const ac = new AbortController();
    const err = await mm
      .ensure(['silero-vad'], (p) => {
        if (p.received > 0) ac.abort();
      }, ac.signal)
      .catch((e: unknown) => e);
    expect((err as Error).name).toBe('AbortError');
    expect(calls).toHaveLength(1);
    expect(readFileSync(`${mm.pathOf('silero-vad', 'silero_vad.onnx')}.part`).length).toBe(250);
    expect(mm.status('silero-vad')).toBe('missing');
  });

  it('shares one download between concurrent callers', async () => {
    const { fn, calls } = fakeFetch((url) => streamed(bodyFor(url)));
    const mm = new ModelManager(tmp(), fn, { models: SMALL });
    await Promise.all([mm.ensure(['silero-vad']), mm.ensure(['silero-vad'])]);
    expect(calls).toHaveLength(1);
  });
});

describe('model integrity', () => {
  it('throws away a download whose content is not the published file, and tries the mirror', async () => {
    const dir = tmp();
    const { fn, calls } = fakeFetch((url) => streamed(url.startsWith(HF) ? content(bodyFor(url).length, 99) : bodyFor(url)));
    const m = new ModelManager(dir, fn, { models: SMALL });
    await m.ensure(['silero-vad']);
    expect(calls.map((c) => new URL(c.url).host)).toEqual(['huggingface.co', 'hf-mirror.com']);
    expect(m.status('silero-vad')).toBe('ready');
  });

  it('checks files downloaded before hashes existed once, without downloading them again', async () => {
    const dir = tmp();
    const f = SMALL['silero-vad'].files[0]!;
    mkdirSync(join(dir, 'silero-vad'), { recursive: true });
    writeFileSync(join(dir, 'silero-vad', f.name), content(f.size, f.name.length));
    const { fn, calls } = fakeFetch((url) => streamed(bodyFor(url)));
    const m = new ModelManager(dir, fn, { models: SMALL });
    expect(m.status('silero-vad')).toBe('missing');
    await m.verifyExisting(['silero-vad']);
    expect(m.status('silero-vad')).toBe('ready');
    expect(calls).toHaveLength(0);
    // A swapped file on disk is not accepted: it is deleted and downloaded again.
    writeFileSync(join(dir, 'silero-vad', f.name), content(f.size, 1));
    writeFileSync(join(dir, 'silero-vad', `${f.name}.sha256`), 'x');
    await m.ensure(['silero-vad']);
    expect(calls).toHaveLength(1);
    expect(readFileSync(join(dir, 'silero-vad', f.name))).toEqual(Buffer.from(content(f.size, f.name.length)));
  });
});
