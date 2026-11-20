import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import type { WorkerHandle } from '../../src/main/providers/local-asr/client';
import { LocalAiClient } from '../../src/main/providers/local-ai/client';
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
      spawn: fakeWorker((m) => (m.t === 'load' ? { t: 'loaded', gpu: 'false' } : { t: 'result', id: m.id, text: `译:${m.prompt.slice(-2)}` }), () => spawns++),
    });
    expect(await c.complete('...你好')).toBe('译:你好');
    expect(await c.complete('...再见')).toBe('译:再见');
    expect(spawns).toBe(1);
  });

  it('reports a model that cannot load, and tries again only after a while', async () => {
    let spawns = 0;
    const c = new LocalAiClient({ modelPath: '/m.gguf', threads: 2, retryAfterMs: 30, spawn: fakeWorker(() => ({ t: 'error', message: '加载失败' }), () => spawns++) });
    await expect(c.complete('x')).rejects.toThrow('加载失败');
    await expect(c.complete('x')).rejects.toThrow('加载失败'); // not retried every sentence
    expect(spawns).toBe(1);
    await new Promise((r) => setTimeout(r, 40));
    await expect(c.complete('x')).rejects.toThrow('加载失败');
    expect(spawns).toBe(2);
  });

  it('times out a stuck sentence', async () => {
    const c = new LocalAiClient({ modelPath: '/m.gguf', threads: 2, requestTimeoutMs: 50, spawn: fakeWorker((m) => (m.t === 'load' ? { t: 'loaded', gpu: 'false' } : null)) });
    await expect(c.complete('x')).rejects.toThrow('超时');
  });
});

// With the real model (MI_AI_MODEL=/path/to/Hy-MT2-1.8B-Q4_K_M.gguf): the worker runs llama.cpp in-process.
const MODEL = process.env.MI_AI_MODEL;
describe.skipIf(!MODEL || !existsSync(MODEL))('local AI translation with the real model', () => {
  it('translates Chinese, Spanish and English with the user’s terms', async () => {
    const toWorker = new EventEmitter();
    const toMain = new EventEmitter();
    attachAiWorker({ on: (_e, fn) => void toWorker.on('m', (d) => fn({ data: d })), postMessage: (m) => void setImmediate(() => toMain.emit('message', m)) });
    const handle = { postMessage: (m: unknown) => void setImmediate(() => toWorker.emit('m', m)), on: (e: string, fn: (...a: any[]) => void) => void toMain.on(e, fn), kill: () => {} } as WorkerHandle;
    const t = new LocalAiTranslator(new LocalAiClient({ modelPath: MODEL!, threads: 4, spawn: () => handle }));
    const entry = { id: '1', zh: '星云平台', es: 'Plataforma Nébula', aliasesZh: [], aliasesEs: [], note: '', enabled: true };
    const es = await t.translate({ text: '我们下周介绍星云平台的价格。', from: 'zh-CN', to: 'es-AR', hits: [{ source: '星云平台', target: 'Plataforma Nébula', entry }], context: [] });
    expect(es).toContain('Plataforma Nébula');
    const zh = await t.translate({ text: 'Dale, lo charlamos con el equipo y te confirmamos el lunes.', from: 'es-AR', to: 'zh-CN', hits: [], context: [] });
    expect(zh).toMatch(/周一/);
    expect(zh).not.toContain('戴尔');
    const en = await t.translate({ text: '第一批货可以在三周内发出。', from: 'zh-CN', to: 'en-US', hits: [], context: [] });
    expect(en.toLowerCase()).toContain('three weeks');
    console.log({ es, zh, en });
  }, 120_000);
});
