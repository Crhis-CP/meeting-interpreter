import { describe, expect, it } from 'vitest';
import { hyMtPrompt, LocalAiTranslator } from '@core/providers/local-ai-translator';
import { createProviders } from '@core/providers/registry';
import { parseSettings } from '@core/config/schema';
import { createLogger } from '@core/log';

describe('local AI translation (Hy-MT2)', () => {
  it('uses the model’s own prompt, with the user’s terms as references', () => {
    expect(hyMtPrompt('今天天气真好。', 'zh', 'es', [])).toBe('将以下文本翻译为西班牙语，注意只需要输出翻译后的结果，不要额外解释：\n\n今天天气真好。');
    expect(hyMtPrompt('Hola', 'es', 'zh', [{ source: 'Nébula', target: '星云平台' }])).toBe('参考下面的翻译：\nNébula 翻译成 星云平台\n\n将以下文本翻译为中文，注意只需要输出翻译后的结果，不要额外解释：\n\nHola');
  });

  it('translates through the engine, plain Spanish first, and cleans the answer', async () => {
    const prompts: string[] = [];
    const t = new LocalAiTranslator({ complete: async (p) => (prompts.push(p), ' “好的，完美。” \n') });
    const entry = { id: '1', zh: '星云平台', es: 'Plataforma Nébula', aliasesZh: [], aliasesEs: [], note: '', enabled: true };
    const out = await t.translate({ text: 'Dale, perfecto.', from: 'es-AR', to: 'zh-CN', hits: [{ source: 'Plataforma Nébula', target: '星云平台', entry }], context: [] });
    expect(out).toBe('好的，完美。');
    expect(prompts[0]).toContain('De acuerdo, perfecto.');
    expect(prompts[0]).toContain('Plataforma Nébula 翻译成 星云平台');
  });

  it('falls back to the Mozilla models where the AI model is not available', () => {
    const s = parseSettings({ preset: 'free', out: { asr: 'demo', mt: 'local-ai', tts: 'none' }, in: { asr: 'demo', mt: 'local-ai', tts: 'none' } });
    const ctx = { fetch: globalThis.fetch, openWebSocket: () => { throw new Error('x'); }, log: createLogger('t'), now: () => 0 };
    const offlineMt = { translate: async () => 'x' };
    expect(createProviders(s, {}, ctx, () => [], { offlineMt }).mt('out').id).toBe('offline');
    expect(createProviders(s, {}, ctx, () => [], { offlineMt, localAi: () => null }).mt('out').id).toBe('offline');
    expect(createProviders(s, {}, ctx, () => [], { offlineMt, localAi: () => ({ complete: async () => 'y' }) }).mt('out').id).toBe('local-ai');
  });
});
