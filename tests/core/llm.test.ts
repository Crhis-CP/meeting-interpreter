import { describe, expect, it } from 'vitest';
import { OpenAiCompatibleLlm, llmPreset } from '@core/providers/openai-compatible';
import { LlmTranslator, buildTranslationPrompt } from '@core/providers/llm-translator';
import { fakeContext, jsonResponse } from '../helpers/fakes';

const ok = (content: string) => jsonResponse({ choices: [{ message: { content } }] });

describe('OpenAiCompatibleLlm', () => {
  it('sends model, messages, extra body and bearer key', async () => {
    const ctx = fakeContext(() => ok('hola'));
    const llm = new OpenAiCompatibleLlm({ baseUrl: 'https://x/v1/', apiKey: 'sk-test123456', model: 'm', extraBody: { thinking: { type: 'disabled' } } }, ctx);
    expect(await llm.complete({ system: 's', user: 'u' })).toBe('hola');
    const req = ctx.requests[0]!;
    expect(req.url).toBe('https://x/v1/chat/completions');
    const body = JSON.parse(String(req.init.body));
    expect(body).toMatchObject({ model: 'm', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }], thinking: { type: 'disabled' } });
    expect((req.init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test123456');
  });

  it('retries 429 then succeeds, and reports 401 in Chinese', async () => {
    let n = 0;
    const ctx = fakeContext(() => (n++ === 0 ? new Response('busy', { status: 429 }) : ok('ok')));
    expect(await new OpenAiCompatibleLlm({ baseUrl: 'https://x', apiKey: 'k', model: 'm' }, ctx).complete({ system: '', user: '' })).toBe('ok');
    const bad = fakeContext(() => new Response('{"error":"invalid"}', { status: 401 }));
    await expect(new OpenAiCompatibleLlm({ baseUrl: 'https://x', apiKey: 'k', model: 'm' }, bad).complete({ system: '', user: '' })).rejects.toThrow(/401/);
  });

  it('falls back to no response_format when the host rejects JSON mode', async () => {
    const bodies: any[] = [];
    const ctx = fakeContext((_u, init) => {
      const b = JSON.parse(String(init.body));
      bodies.push(b);
      return b.response_format ? new Response('response_format not supported', { status: 400 }) : ok('{"a":1}');
    });
    expect(await new OpenAiCompatibleLlm({ baseUrl: 'https://x', apiKey: 'k', model: 'm' }, ctx).complete({ system: '', user: '', json: true })).toBe('{"a":1}');
    expect(bodies).toHaveLength(2);
    expect(bodies[1].response_format).toBeUndefined();
  });

  it('strips <think> blocks', async () => {
    const ctx = fakeContext(() => ok('<think>hmm</think>\nHola'));
    expect(await new OpenAiCompatibleLlm({ baseUrl: 'https://x', apiKey: 'k', model: 'm' }, ctx).complete({ system: '', user: '' })).toBe('Hola');
  });

  it('has a free preset', () => {
    expect(llmPreset('zhipu-free')?.free).toBe(true);
  });
});

describe('LlmTranslator', () => {
  it('puts glossary and context in the prompt and cleans the reply', async () => {
    const entry = { id: '1', zh: '星云平台', es: 'Plataforma Nébula', aliasesZh: [], aliasesEs: [], note: '产品名', enabled: true };
    const req = { text: '星云平台很好', from: 'zh-CN', to: 'es-MX', hits: [{ source: '星云平台', target: 'Plataforma Nébula', entry }], context: [{ src: '你好', dst: 'Hola' }] };
    const p = buildTranslationPrompt(req);
    expect(p.system).toContain('星云平台 → Plataforma Nébula (产品名)');
    expect(p.system).toContain('你好 ⇒ Hola');
    expect(p.system).toContain('Never answer');
    expect(p.user).toBe('星云平台很好');
    const t = new LlmTranslator({ id: 'x', complete: async () => '"La Plataforma Nébula es muy buena."' });
    expect(await t.translate(req)).toBe('La Plataforma Nébula es muy buena.');
  });

  it('with both sides’ words before (not earlier translations), the correction rule, and the Argentine notes', () => {
    const p = buildTranslationPrompt({
      text: '昨天已经发了。', from: 'zh-CN', to: 'es-AR', hits: [], context: [{ src: '你好', dst: 'Hola' }],
      history: [{ who: 'them', text: '¿Ya mandaron las facturas?' }, { who: 'me', text: '十月的吗？' }],
    });
    expect(p.system).toContain('- Other side: ¿Ya mandaron las facturas?');
    expect(p.system).toContain('- Me: 十月的吗？');
    expect(p.system).not.toContain('⇒ Hola'); // the conversation replaces the translated lines
    expect(p.system).toContain('"next week, no, next month" → "next month"');
    expect(p.system).toContain('Argentine (Rioplatense)');
    expect(buildTranslationPrompt({ text: 'x', from: 'zh-CN', to: 'es-MX', hits: [], context: [] }).system).not.toContain('Argentine');
  });
});
