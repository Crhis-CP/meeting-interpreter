import { describe, expect, it } from 'vitest';
import { createDirection } from '@core/pipeline/direction';

const asr = (id: string) => ({ id, start: async () => { throw new Error('unused'); } });
const tr = (id: string) => ({ id, translate: async () => 'x' });
const base = { dir: 'out' as const, speaker: 'me', idPrefix: 'out', srcLang: 'zh-CN', dstLang: 'es-AR', tts: null, glossary: () => [], interpretation: { pinyinFuzzy: true, lowLatency: true }, clock: () => 0 };
const opts = (p: unknown) => (p as { o: { draft?: unknown; idleCloseMs?: number; pinyinFuzzy: boolean } }).o;

describe('one way to assemble a translation direction', () => {
  it('puts the instant draft only in front of a slower translator', () => {
    const draft = tr('offline');
    expect(opts(createDirection({ ...base, asr: asr('dashscope'), translator: tr('local-ai'), draft })).draft).toBe(draft);
    expect(opts(createDirection({ ...base, asr: asr('dashscope'), translator: tr('offline'), draft })).draft).toBeUndefined();
    expect(opts(createDirection({ ...base, asr: asr('dashscope'), translator: tr('demo'), draft })).draft).toBeUndefined();
  });

  it('keeps local recognisers open and closes idle cloud sessions', () => {
    expect(opts(createDirection({ ...base, asr: asr('local'), translator: tr('llm') })).idleCloseMs).toBe(0);
    expect(opts(createDirection({ ...base, asr: asr('desktop'), translator: tr('llm') })).idleCloseMs).toBe(0);
    expect(opts(createDirection({ ...base, asr: asr('azure'), translator: tr('llm') })).idleCloseMs).toBe(15000);
    expect(opts(createDirection({ ...base, asr: asr('azure'), translator: tr('llm'), idleCloseMs: 5 })).idleCloseMs).toBe(5);
    expect(opts(createDirection({ ...base, asr: asr('azure'), translator: tr('llm') })).pinyinFuzzy).toBe(true);
  });
});
