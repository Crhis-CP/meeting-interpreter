// Tries instruction formats for the local AI model on three sets, for grading by hand:
//   bench   — the 48 meeting sentences (each with the 3 before it as the conversation so far),
//   context — sentences whose translation depends on what was said before,
//   repair  — spoken corrections ("下周，不对，下个月").
//
//   npx tsx --tsconfig tsconfig.node.json scripts/dev/prompt-eval.mts <model.gguf> <variant,...> [set,...] [out.json]
//
// Variants: plain (today's prompt), bg (Hy-MT2's "background information" format with the
// conversation), bg-only (same, plus "only output the translation"), repair (Hy-MT2's
// "personalization" format asking to keep only the corrected wording), bg-repair (both).
import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { hyMtPrompt, LocalAiTranslator } from '../../src/core/providers/local-ai-translator';
import type { LangBase } from '../../src/core/lang/languages';
import { LocalAiClient } from '../../src/main/providers/local-ai/client';
import { attachAiWorker } from '../../src/main/providers/local-ai/worker';
import type { WorkerHandle } from '../../src/main/providers/local-asr/client';

type Turn = [speaker: 'me' | 'them', lang: LangBase, text: string];
interface Case { set: string; history: Turn[]; from: LangBase; to: LangBase; text: string; must?: string; terms?: { source: string; target: string }[] }

const [modelPath, variantsArg, setsArg, outPath] = process.argv.slice(2);
if (!modelPath || !variantsArg) throw new Error('usage: prompt-eval.mts <model.gguf> <variant,...> [set,...] [out.json]');
const sets = (setsArg ?? 'bench,context,repair').split(',');
const read = (f: string) => JSON.parse(readFileSync(new URL(f, import.meta.url), 'utf8'));

const cases: Case[] = [];
if (sets.includes('bench')) {
  const raw = read('./bench-cases.json') as [LangBase, LangBase, string][];
  const zh = raw.filter((c) => c[0] === 'zh');
  const other = raw.filter((c) => c[0] !== 'zh');
  const order: [LangBase, LangBase, string][] = [];
  for (let i = 0; i < Math.max(zh.length, other.length); i++) {
    if (zh[i]) order.push(zh[i]!);
    if (other[i]) order.push(other[i]!);
  }
  order.forEach(([from, to, text], i) =>
    cases.push({ set: 'bench', from, to, text, history: order.slice(Math.max(0, i - 3), i).map(([f, , t]) => [f === 'zh' ? 'me' : 'them', f, t] as Turn) }),
  );
}
if (sets.includes('context')) for (const c of read('./context-cases.json').cases) cases.push({ set: 'context', ...c });
if (sets.includes('repair')) for (const c of read('./repair-cases.json').cases) cases.push({ set: 'repair', history: [], ...c });
if (sets.includes('terms')) {
  // The user's glossary must still win when the conversation is in the prompt too.
  const t = (source: string, target: string) => ({ source, target });
  const h = (...turns: Turn[]) => turns;
  cases.push(
    { set: 'terms', from: 'zh', to: 'es', text: '报价我们明天发给您。', terms: [t('报价', 'cotización')], history: h(['them', 'es', '¿Cuándo tendremos los precios?']), must: 'cotización' },
    { set: 'terms', from: 'zh', to: 'es', text: '交货期是四十五天。', terms: [t('交货期', 'plazo de entrega')], history: h(['them', 'es', '¿Y cuánto tardan?']), must: 'plazo de entrega' },
    { set: 'terms', from: 'es', to: 'zh', text: 'El flete corre por nuestra cuenta.', terms: [t('flete', '运费')], history: h(['me', 'zh', '运输怎么安排？']), must: '运费' },
    { set: 'terms', from: 'zh', to: 'es', text: '我们的质保是两年。', terms: [t('质保', 'garantía')], history: h(['them', 'es', '¿Qué pasa si se rompe?']), must: 'garantía' },
    { set: 'terms', from: 'es', to: 'zh', text: 'Mandanos la proforma, por favor.', terms: [t('proforma', '形式发票')], history: h(['me', 'zh', '我们可以先付定金。']), must: '形式发票' },
  );
}

const NAME: Record<LangBase, string> = { zh: '中文', es: '西班牙语', en: '英语' };
const who = (t: Turn) => `${t[0] === 'me' ? '我方' : '对方'}：${t[2]}`;
const background = (h: Turn[]) => h.map(who).join('\n');
const REPAIR = '这是会议中的口语。说话人中途改口时，只翻译改正后的说法，去掉说错的部分、重复和口头语。';
const ONLY = '注意只需要输出翻译后的结果，不要额外解释';

const refs = (c: Case) => (c.terms?.length ? `参考下面的翻译：\n${c.terms.map((x) => `${x.source} 翻译成 ${x.target}`).join('\n')}\n` : '');
const VARIANTS: Record<string, (c: Case) => string> = {
  plain: (c) => hyMtPrompt(c.text, c.from, c.to, c.terms ?? []),
  // The conversation, then the user's terms, in the background block.
  'bg-terms': (c) => (c.history.length ? `【背景信息】\n${background(c.history)}\n${refs(c)}\n请结合背景信息将以下文本翻译为${NAME[c.to]}。\n\n【待翻译文本】\n${c.text}` : hyMtPrompt(c.text, c.from, c.to, c.terms ?? [])),
  // The terms first (Hy-MT2's own terminology format), then the conversation.
  'terms-bg': (c) => (c.history.length ? `${refs(c)}${refs(c) ? '\n' : ''}【背景信息】\n${background(c.history)}\n\n请结合背景信息将以下文本翻译为${NAME[c.to]}。\n\n【待翻译文本】\n${c.text}` : hyMtPrompt(c.text, c.from, c.to, c.terms ?? [])),
  bg: (c) => (c.history.length ? `【背景信息】\n${background(c.history)}\n\n请结合背景信息将以下文本翻译为${NAME[c.to]}。\n\n【待翻译文本】\n${c.text}` : hyMtPrompt(c.text, c.from, c.to, [])),
  'bg-only': (c) => (c.history.length ? `【背景信息】\n${background(c.history)}\n\n请结合背景信息将以下文本翻译为${NAME[c.to]}，${ONLY}。\n\n【待翻译文本】\n${c.text}` : hyMtPrompt(c.text, c.from, c.to, [])),
  repair: (c) => `【待翻译文本】\n${c.text}\n\n【翻译任务】\n1、${REPAIR}\n2、${ONLY}。\n3、将【待翻译文本】翻译为${NAME[c.to]}。`,
  'bg-repair': (c) =>
    `${c.history.length ? `【背景信息】\n${background(c.history)}\n\n` : ''}【待翻译文本】\n${c.text}\n\n【翻译任务】\n1、${c.history.length ? '结合背景信息理解省略的内容。' : ''}${REPAIR}\n2、${ONLY}。\n3、将【待翻译文本】翻译为${NAME[c.to]}。`,
};
const variants = variantsArg.split(',');
for (const v of variants) if (!VARIANTS[v] && v !== 'app') throw new Error(`unknown variant ${v}`);
const CODE: Record<LangBase, string> = { zh: 'zh-CN', es: 'es-AR', en: 'en-US' };

const toWorker = new EventEmitter();
const toMain = new EventEmitter();
attachAiWorker({ on: (_e, fn) => void toWorker.on('m', (d) => fn({ data: d })), postMessage: (m) => void setImmediate(() => toMain.emit('message', m)) });
const handle = { postMessage: (m: unknown) => void setImmediate(() => toWorker.emit('m', m)), on: (e: string, fn: (...a: unknown[]) => void) => void toMain.on(e, fn), kill: () => {} } as unknown as WorkerHandle;
const client = new LocalAiClient({ modelPath, threads: 0, spawn: () => handle, requestTimeoutMs: 120_000 });
await client.ready();

const rows: { set: string; variant: string; from: string; text: string; out: string; ms: number; must?: string }[] = [];
for (const c of cases) {
  for (const v of variants) {
    const t = Date.now();
    // 'app': the app's own translator (context prompt, output check, plain prompt when it looks off).
    const out =
      v === 'app'
        ? await new LocalAiTranslator(client).translate({
            text: c.text, from: CODE[c.from], to: CODE[c.to], context: [],
            hits: (c.terms ?? []).map((x) => ({ ...x, entry: { id: x.source, zh: '', es: '', aliasesZh: [], aliasesEs: [], note: '', enabled: true } })),
            history: c.history.map(([who, , text]) => ({ who, text })),
          })
        : (await client.complete(VARIANTS[v]!(c), undefined, c.to === 'zh' ? 1 : 0, 200)).trim();
    rows.push({ set: c.set, variant: v, from: c.from, text: c.text, out, ms: Date.now() - t, must: c.must });
  }
  console.log(`\n[${c.set}] ${c.text}${c.must ? `   ← ${c.must}` : ''}`);
  for (const r of rows.filter((x) => x.text === c.text && x.set === c.set)) console.log(`  ${r.variant.padEnd(9)} ${String(r.ms).padStart(5)} ms | ${r.out}`);
}
const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
for (const v of variants) console.log(`${v}: median ${med(rows.filter((r) => r.variant === v).map((r) => r.ms))} ms`);
if (outPath) writeFileSync(outPath, JSON.stringify(rows, null, 1));
client.dispose();
process.exit(0);
