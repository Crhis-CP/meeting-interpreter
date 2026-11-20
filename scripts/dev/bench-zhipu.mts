// The benchmark sentences (bench-cases.json) through the app's own LLM translator (智谱 free preset), one at a time.
// npx tsx scripts/dev/bench-zhipu.mts scripts/dev/bench-cases.json out/bench-zhipu.json
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';
import { readFileSync, writeFileSync } from 'node:fs';
import { createLogger } from '../../src/core/log';
import { parseSettings } from '../../src/core/config/schema';
import { createProviders } from '../../src/core/providers/registry';
import { createNodeContext } from '../../src/main/platform/node-context';
setGlobalDispatcher(new EnvHttpProxyAgent());
const cases = JSON.parse(readFileSync(process.argv[2], 'utf8')) as [string, string, string][];
const ctx = createNodeContext(createLogger('b'), (i, init) => fetch(i, init));
const code = { zh: 'zh-CN', es: 'es-AR', en: 'en-US' } as Record<string, string>;
const rows: unknown[] = [];
for (const [i, [f, t, text]] of cases.entries()) {
  const remote = f === 'zh' ? code[t] : code[f];
  const s = parseSettings({ preset: 'custom', languages: { self: 'zh-CN', remote }, out: { asr: 'demo', mt: 'llm', tts: 'none' }, in: { asr: 'demo', mt: 'llm', tts: 'none' }, llm: { preset: 'zhipu-free', baseUrl: '', model: '' } });
  const p = createProviders(s, { llm: process.env.MI_LLM_KEY || 'proxy-injected' }, ctx, () => []);
  const t0 = Date.now();
  let out: string;
  try { out = await p.mt(f === 'zh' ? 'out' : 'in').translate({ text, from: code[f], to: code[t], hits: [], context: [] }); } catch (e) { out = 'ERROR ' + (e instanceof Error ? e.message : String(e)); }
  const ms = Date.now() - t0;
  rows.push({ i, from: f, to: t, src: text, ms, out });
  console.log(`${f}→${t} ${ms}ms | ${out}`);
}
writeFileSync(process.argv[3], JSON.stringify(rows, null, 1));
