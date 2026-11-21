import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import type { WorkerHandle } from '../../src/main/providers/local-asr/client';
import { LocalAiClient, LocalAiLoadingError } from '../../src/main/providers/local-ai/client';
import { attachAiWorker, type AiReply, type AiRequest } from '../../src/main/providers/local-ai/worker';
import { LocalAiTranslator } from '@core/providers/local-ai-translator';

/** A worker that answers like the real one, scripted. */
function fakeWorker(answer: (m: AiRequest) => AiReply | null, onSpawn: () => void = () => {}): () => WorkerHandle {
  return () => {
    onSpawn();
    const ev = new EventEmitter();
    return {
      postMessage: (m: unknown) => setImmediate(() => {
        const r = answer(m as AiRequest);
        if (r) ev.emit('message', r);
      }),
      on: (e: string, fn: (...a: any[]) => void) => void ev.on(e, fn),
      kill: () => void ev.emit('exit', 0),
    } as WorkerHandle;
  };
}

describe('local AI translation client', () => {
  it('loads the model once, then translates sentence by sentence', async () => {
    let spawns = 0;
    const c = new LocalAiClient({
      modelPath: '/m.gguf',
      threads: 2,
      spawn: fakeWorker((m) => (m.t === 'load' ? { t: 'loaded', gpu: 'false' } : m.t === 'complete' ? { t: 'result', id: m.id, text: `译:${m.prompt.slice(-2)}` } : null), () => spawns++),
    });
    await expect(c.complete('...你好')).rejects.toBeInstanceOf(LocalAiLoadingError); // the fallback translates meanwhile
    await c.ready();
    expect(await c.complete('...你好')).toBe('译:你好');
    expect(await c.complete('...再见')).toBe('译:再见');
    expect(spawns).toBe(1);
  });

  it('reports a model that cannot load, and tries again only after a while', async () => {
    let spawns = 0;
    const reported: string[] = [];
    const c = new LocalAiClient({
      modelPath: '/m.gguf',
      threads: 2,
      retryAfterMs: 30,
      spawn: fakeWorker(() => ({ t: 'error', message: '加载失败' }), () => spawns++),
      onLoadFailed: (m) => reported.push(m),
    });
    await expect(c.ready()).rejects.toThrow('加载失败');
    expect(reported).toEqual(['加载失败']); // the app logs it
    await expect(c.complete('x')).rejects.toThrow('加载失败'); // not retried every sentence
    expect(spawns).toBe(1);
    await new Promise((r) => setTimeout(r, 40));
    await expect(c.complete('x')).rejects.toThrow();
    expect(spawns).toBe(2);
  });

  it('times out a stuck sentence and tells the worker to skip it', async () => {
    const seen: string[] = [];
    const c = new LocalAiClient({ modelPath: '/m.gguf', threads: 2, requestTimeoutMs: 50, spawn: fakeWorker((m) => (seen.push(m.t), m.t === 'load' ? { t: 'loaded', gpu: 'false' } : null)) });
    await c.ready();
    await expect(c.complete('x')).rejects.toThrow('超时');
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toEqual(['load', 'complete', 'cancel']);
  });

  it('cancelling a sentence stops its generation, so newer sentences do not wait behind it', async () => {
    // A stand-in for node-llama-cpp: "slow" never finishes on its own, only when aborted.
    const lib = {
      getLlama: async () => ({ gpu: false, loadModel: async () => ({ createContext: async () => ({ getSequence: () => ({ clearHistory: async () => {} }) }) }) }),
      LlamaChatSession: class {
        async prompt(text: string, o: { signal: AbortSignal }) {
          if (text === 'slow') await new Promise((_r, reject) => o.signal.addEventListener('abort', () => reject(new Error('aborted'))));
          return `译:${text}`;
        }
        dispose() {}
      },
    };
    const replies: AiReply[] = [];
    let onMsg: (e: { data: unknown }) => void = () => {};
    attachAiWorker({ on: (_e, fn) => void (onMsg = fn), postMessage: (m) => void replies.push(m as AiReply) }, async () => lib as never);
    const send = (m: AiRequest) => onMsg({ data: m });
    const until = async (ok: () => boolean) => {
      for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
      return ok();
    };
    send({ t: 'load', modelPath: '/m.gguf', threads: 2 });
    expect(await until(() => replies.some((r) => r.t === 'loaded'))).toBe(true);
    send({ t: 'complete', id: 1, prompt: 'slow', maxTokens: 64 });
    send({ t: 'complete', id: 2, prompt: '你好', maxTokens: 64 });
    await new Promise((r) => setTimeout(r, 50));
    expect(replies.some((r) => r.t === 'result')).toBe(false); // 2 waits behind the stuck 1
    send({ t: 'cancel', id: 1 });
    expect(await until(() => replies.some((r) => r.t === 'result' && r.id === 2))).toBe(true);
    expect(replies.find((r) => r.t === 'error' && r.id === 1)).toMatchObject({ message: 'cancelled' });
  });

  it('the two directions translate side by side: a slow sentence one way does not hold up the other', async () => {
    const lib = {
      getLlama: async () => ({ gpu: false, loadModel: async () => ({ createContext: async () => ({ getSequence: () => ({}) }) }) }),
      LlamaChatSession: class {
        async prompt(text: string, o: { signal: AbortSignal }) {
          if (text === 'slow') await new Promise((_r, reject) => o.signal.addEventListener('abort', () => reject(new Error('aborted'))));
          return `译:${text}`;
        }
        dispose() {}
      },
    };
    const replies: AiReply[] = [];
    let onMsg: (e: { data: unknown }) => void = () => {};
    attachAiWorker({ on: (_e, fn) => void (onMsg = fn), postMessage: (m) => void replies.push(m as AiReply) }, async () => lib as never);
    const send = (m: AiRequest) => onMsg({ data: m });
    const until = async (ok: () => boolean) => {
      for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
      return ok();
    };
    send({ t: 'load', modelPath: '/m.gguf', threads: 2 });
    expect(await until(() => replies.some((r) => r.t === 'loaded'))).toBe(true);
    send({ t: 'complete', id: 1, prompt: 'slow', maxTokens: 64, lane: 0 });
    send({ t: 'complete', id: 2, prompt: 'Hola', maxTokens: 64, lane: 1 });
    expect(await until(() => replies.some((r) => r.t === 'result' && r.id === 2))).toBe(true);
    send({ t: 'cancel', id: 1 });
    expect(await until(() => replies.some((r) => r.t === 'error' && r.id === 1))).toBe(true);
  });

  it('the Mozilla translation stands in while the model loads', async () => {
    const t = new LocalAiTranslator({ complete: async () => { throw new LocalAiLoadingError(); } }, { id: 'offline', translate: async () => 'borrador' });
    expect(await t.translate({ text: '你好', from: 'zh-CN', to: 'es-AR', hits: [], context: [] })).toBe('borrador');
  });
});

// With the real model (MI_AI_MODEL=/path/to/Hy-MT2-1.8B-Q4_K_M.gguf): the worker runs llama.cpp in-process.
const MODEL = process.env.MI_AI_MODEL;
// (Not on CI's Mac: there the GPU is virtual and Metal in the test process stalls at random; the
// e2e and packaged tests run the real worker process on Mac, the Windows run checks the quality.)
describe.skipIf(!MODEL || !existsSync(MODEL) || (process.platform === 'darwin' && !!process.env.CI))('local AI translation with the real model', () => {
  it('translates Chinese, Spanish and English with the user’s terms', async () => {
    const toWorker = new EventEmitter();
    const toMain = new EventEmitter();
    attachAiWorker({ on: (_e, fn) => void toWorker.on('m', (d) => fn({ data: d })), postMessage: (m) => void setImmediate(() => toMain.emit('message', m)) });
    const handle = { postMessage: (m: unknown) => void setImmediate(() => toWorker.emit('m', m)), on: (e: string, fn: (...a: any[]) => void) => void toMain.on(e, fn), kill: () => {} } as WorkerHandle;
    // This checks what is translated, not how fast: CI's Mac VMs (virtual GPU) need over 30 s for
    // the first sentence while Metal compiles its shaders. Speed is measured separately.
    const client = new LocalAiClient({ modelPath: MODEL!, threads: 4, spawn: () => handle, requestTimeoutMs: 180_000 });
    await client.ready();
    const t = new LocalAiTranslator(client);
    const entry = { id: '1', zh: '星云平台', es: 'Plataforma Nébula', aliasesZh: [], aliasesEs: [], note: '', enabled: true };
    const es = await t.translate({ text: '我们下周介绍星云平台的价格。', from: 'zh-CN', to: 'es-AR', hits: [{ source: '星云平台', target: 'Plataforma Nébula', entry }], context: [] });
    expect(es).toContain('Plataforma Nébula');
    const zh = await t.translate({ text: 'Dale, lo charlamos con el equipo y te confirmamos el lunes.', from: 'es-AR', to: 'zh-CN', hits: [], context: [] });
    expect(zh).toMatch(/周一/);
    expect(zh).not.toContain('戴尔');
    const en = await t.translate({ text: '第一批货可以在三周内发出。', from: 'zh-CN', to: 'en-US', hits: [], context: [] });
    expect(en.toLowerCase()).toContain('three weeks');
    console.log({ es, zh, en });
  }, 600_000);
});
