// Times each 智谱 free model directly (key injected by the environment, or MI_LLM_KEY).
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';
setGlobalDispatcher(new EnvHttpProxyAgent());
const key = process.env.MI_LLM_KEY || 'proxy-injected';
async function once(model: string, extra: Record<string, unknown>) {
  const t0 = Date.now();
  try {
    const res = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: 'system', content: 'Translate the Chinese into Spanish. Reply with the translation only.' }, { role: 'user', content: '第一批货可以在三周内发出。' }], temperature: 0.2, ...extra }),
      signal: AbortSignal.timeout(30000),
    });
    const text = await res.text();
    const out = res.ok ? (JSON.parse(text).choices?.[0]?.message?.content ?? '').slice(0, 60) : text.slice(0, 120);
    console.log(`${model}: HTTP ${res.status} in ${Date.now() - t0} ms — ${out}`);
  } catch (e) {
    console.log(`${model}: failed after ${Date.now() - t0} ms — ${e instanceof Error ? e.message : e}`);
  }
}
async function main() {
  for (let i = 0; i < 3; i++) {
    await once('glm-4.7-flash', { thinking: { type: 'disabled' } });
    await once('glm-4-flash-250414', {});
  }
}
void main();
