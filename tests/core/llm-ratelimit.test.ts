import { describe, expect, it } from 'vitest';
import { OpenAiCompatibleLlm } from '@core/providers/openai-compatible';
import { fakeContext, jsonResponse } from '../helpers/fakes';

const reply = (text: string) => jsonResponse({ choices: [{ message: { content: text } }] });
const limited = () => jsonResponse({ error: { code: '1302', message: '您的账户已达到速率限制，请您控制请求频率' } }, 429);

describe('free-tier rate limits', () => {
  it('switches to the fallback model when the main one is rate limited, and drops its extra options', async () => {
    const models: string[] = [];
    const bodies: Record<string, unknown>[] = [];
    const ctx = fakeContext((_u, init) => {
      const b = JSON.parse(String(init.body)) as { model: string };
      models.push(b.model);
      bodies.push(b);
      return b.model === 'glm-4.7-flash' ? limited() : reply('Hola');
    });
    const llm = new OpenAiCompatibleLlm({ baseUrl: 'https://x.test/v4', apiKey: 'k1', model: 'glm-4.7-flash', extraBody: { thinking: { type: 'disabled' } }, fallbackModels: ['glm-4-flash-250414'] }, ctx);
    expect(await llm.complete({ system: 's', user: 'u' })).toBe('Hola');
    expect(models).toEqual(['glm-4.7-flash', 'glm-4-flash-250414']);
    expect(bodies[1]).not.toHaveProperty('thinking');
    // While limited, later requests go straight to the fallback.
    await llm.complete({ system: 's', user: 'u' });
    expect(models.slice(2)).toEqual(['glm-4-flash-250414']);
  });

  it('waits and retries when every model is briefly limited', async () => {
    let n = 0;
    const ctx = fakeContext(() => (++n < 3 ? limited() : reply('ok')));
    const llm = new OpenAiCompatibleLlm({ baseUrl: 'https://y.test/v4', apiKey: 'k2', model: 'm' }, ctx);
    expect(await llm.complete({ system: 's', user: 'u' })).toBe('ok');
    expect(n).toBe(3);
  });

  it('sends one request at a time for a key limited to one', async () => {
    let active = 0;
    let peak = 0;
    const ctx = fakeContext(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
      return reply('x');
    });
    const llm = new OpenAiCompatibleLlm({ baseUrl: 'https://z.test/v4', apiKey: 'k3', model: 'm', maxConcurrent: 1 }, ctx);
    await Promise.all([1, 2, 3].map(() => llm.complete({ system: 's', user: 'u' })));
    expect(peak).toBe(1);
  });
});

describe('LLM endpoints', () => {
  it('only sends keys over HTTPS (plain http only to this computer)', async () => {
    const { isSafeEndpoint } = await import('@core/providers/openai-compatible');
    expect(isSafeEndpoint('https://open.bigmodel.cn/api/paas/v4')).toBe(true);
    expect(isSafeEndpoint('http://localhost:11434/v1')).toBe(true);
    expect(isSafeEndpoint('http://127.0.0.1:8080/v1')).toBe(true);
    expect(isSafeEndpoint('http://api.example.com/v1')).toBe(false);
    expect(isSafeEndpoint('http://localhost.evil.com/v1')).toBe(false);
    expect(isSafeEndpoint('ftp://x')).toBe(false);
    expect(isSafeEndpoint('not a url')).toBe(false);
  });
});
