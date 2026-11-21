import { describe, expect, it } from 'vitest';
import { hyMtContextPrompt, hyMtPrompt, LocalAiTranslator, looksOff } from '@core/providers/local-ai-translator';
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

  it('with what was said before: the background format, conversation first, then the terms', async () => {
    const history = [{ who: 'them', text: '¿Ya mandaron las facturas?' }, { who: 'me', text: '你说的是十月的吗？' }];
    expect(hyMtContextPrompt('昨天已经发了。', 'es', [{ source: '发票', target: 'factura' }], history)).toBe(
      '【背景信息】\n对方：¿Ya mandaron las facturas?\n我方：你说的是十月的吗？\n参考下面的翻译：\n发票 翻译成 factura\n\n请结合背景信息将以下文本翻译为西班牙语。\n\n【待翻译文本】\n昨天已经发了。',
    );
    const prompts: string[] = [];
    const t = new LocalAiTranslator({ complete: async (p) => (prompts.push(p), 'Ya las enviamos ayer.') });
    expect(await t.translate({ text: '昨天已经发了。', from: 'zh-CN', to: 'es-AR', hits: [], context: [], history })).toBe('Ya las enviamos ayer.');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('【背景信息】');
  });

  it('an answer that does not look like this sentence’s translation is done again without the context', async () => {
    expect(looksOff('好的，感谢您的 waktu。', 'Perfecto, muchas gracias por su tiempo.', 'zh', [])).toBe(true);
    expect(looksOff('我们需要 Nébula 平台。', 'Necesitamos la plataforma Nébula.', 'zh', [])).toBe(false);
    expect(looksOff('Enviamos 样品 el lunes.', '我们周一寄样品。', 'es', [])).toBe(true);
    expect(looksOff('【待翻译文本】不，那需要另外计算。', 'No, eso va aparte.', 'zh', [])).toBe(true);
    const answers = ['好的，感谢您的 waktu。', '太好了，感谢您的时间。'];
    const prompts: string[] = [];
    const t = new LocalAiTranslator({ complete: async (p) => (prompts.push(p), answers.shift()!) });
    const out = await t.translate({ text: 'Perfecto, muchas gracias por su tiempo.', from: 'es-AR', to: 'zh-CN', hits: [], context: [], history: [{ who: 'me', text: '今天就到这里。' }] });
    expect(out).toBe('太好了，感谢您的时间。');
    expect(prompts[1]).not.toContain('背景信息');
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
