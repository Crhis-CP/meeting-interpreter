// Real translations against 智谱 GLM (free) — needs a key: ZHIPU key injected by the environment, or MI_LLM_KEY.
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';
import { createLogger } from '../../src/core/log';
import { parseSettings } from '../../src/core/config/schema';
import { createProviders } from '../../src/core/providers/registry';
import { createNodeContext } from '../../src/main/platform/node-context';
import { findHits } from '../../src/core/glossary/match';
setGlobalDispatcher(new EnvHttpProxyAgent());
const log = createLogger('t');
const ctx = createNodeContext(log, (i, init) => fetch(i, init));
const s = (remote: string) => parseSettings({ preset: 'custom', languages: { self: 'zh-CN', remote }, out: { asr: 'demo', mt: 'llm', tts: 'none' }, in: { asr: 'demo', mt: 'llm', tts: 'none' }, llm: { preset: 'zhipu-free', baseUrl: '', model: '' } });
const glossary = [{ id: '1', zh: '星云平台', es: 'Plataforma Nébula', en: 'Nebula Platform', aliasesZh: [], aliasesEs: [], note: '', enabled: true }];
const run = async (label: string, remote: string, dir: 'out' | 'in', text: string, from: string, to: string) => {
  const p = createProviders(s(remote), { llm: process.env.MI_LLM_KEY || 'proxy-injected' }, ctx, () => glossary);
  const t0 = Date.now();
  try {
    const out = await p.mt(dir).translate({ text, from, to, hits: findHits(text, from.startsWith('zh') ? 'zh' : (from.slice(0, 2) as 'es' | 'en'), glossary, to.startsWith('zh') ? 'zh' : (to.slice(0, 2) as 'es' | 'en')), context: [] });
    console.log(`✅ ${label} (${Date.now() - t0} ms): ${out}`);
  } catch (e) {
    console.log(`❌ ${label} (${Date.now() - t0} ms): ${e instanceof Error ? e.message : e}`);
  }
};
async function main() {
await run('中→西', 'es-MX', 'out', '大家好，我们今天讨论一下星云平台的交货时间和价格。', 'zh-CN', 'es-MX');
await run('西→中', 'es-MX', 'in', 'Buenos días, ¿cuándo pueden entregar la Plataforma Nébula?', 'es-MX', 'zh-CN');
await run('中→英', 'en-US', 'out', '第一批货可以在三周内发出。', 'zh-CN', 'en-US');
console.log('--- 4 at once (two directions, like a real meeting) ---');
await Promise.all([
  run('同时1 中→西', 'es-MX', 'out', '付款方式我们建议百分之三十预付。', 'zh-CN', 'es-MX'),
  run('同时2 西→中', 'es-MX', 'in', 'Nos parece bien, pero necesitamos una garantía.', 'es-MX', 'zh-CN'),
  run('同时3 中→西', 'es-MX', 'out', '好的，我会在周五之前把合同发给你们。', 'zh-CN', 'es-MX'),
  run('同时4 西→中', 'es-MX', 'in', 'Perfecto, muchas gracias.', 'es-MX', 'zh-CN'),
]);
}
void main();
