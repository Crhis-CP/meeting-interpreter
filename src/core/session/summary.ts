import { z } from 'zod';
import type { GlossaryEntry } from '../glossary/types';
import type { Llm } from '../providers/types';
import type { MeetingMeta, TranscriptSegment } from '../types';
import { formatClock, speakerLabel } from './transcript';

const Bi = z.object({ zh: z.string().default(''), es: z.string().default('') });
const Evidence = z.array(z.string()).default([]);

export const MeetingSummarySchema = z.object({
  title: Bi.default({ zh: '', es: '' }),
  summary: Bi.default({ zh: '', es: '' }),
  topics: z
    .array(
      z.object({
        start: z.number().default(0),
        title: Bi.default({ zh: '', es: '' }),
        summary: Bi.default({ zh: '', es: '' }),
        points: z.array(z.object({ text: Bi, evidence: Evidence })).default([]),
      }),
    )
    .default([]),
  decisions: z.array(z.object({ text: Bi, evidence: Evidence })).default([]),
  todos: z
    .array(
      z.object({
        text: Bi,
        owner: z.string().nullable().default(null),
        due: z.string().nullable().default(null),
        evidence: Evidence,
      }),
    )
    .default([]),
  terms: z.array(z.object({ zh: z.string().default(''), es: z.string().default(''), note: z.string().default('') })).default([]),
});

export type MeetingSummary = z.infer<typeof MeetingSummarySchema>;
export type SummaryTemplate = 'general' | 'business' | 'project';

export const TEMPLATE_NAMES: Record<SummaryTemplate, string> = {
  general: '通用会议',
  business: '商务谈判 / 客户会议',
  project: '项目例会',
};

const TEMPLATE_FOCUS: Record<SummaryTemplate, string> = {
  general: 'Cover the main topics, what was agreed and the follow-up actions.',
  business:
    'This is a business negotiation or client meeting. Pay special attention to prices, quantities, discounts, payment terms, delivery dates, quality requirements, open disagreements and each side\'s commitments.',
  project:
    'This is a project status meeting. Pay special attention to progress, blockers and risks, decisions, owners and deadlines.',
};

/** One transcript line as the model sees it: `[L3 01:15 我方] 原文 ‖ 译文`. */
export function promptLine(seg: TranscriptSegment, index: number): string {
  return `[L${index + 1} ${formatClock(seg.start)} ${speakerLabel(seg)}] ${seg.srcText}${seg.dstText ? ` ‖ ${seg.dstText}` : ''}`;
}

export function buildSummaryPrompt(
  segs: TranscriptSegment[],
  meta: MeetingMeta,
  glossary: GlossaryEntry[],
  template: SummaryTemplate,
  part?: { index: number; of: number; offset: number },
): { system: string; user: string } {
  const system = [
    'You write meeting minutes for a bilingual meeting between Chinese and Spanish speakers.',
    'Every text field must be given in BOTH Simplified Chinese ("zh") and Spanish ("es"), each written naturally in that language (not a word-for-word translation).',
    TEMPLATE_FOCUS[template],
    'Rules:',
    '- Only state what the transcript says. Never invent facts, numbers, names or dates.',
    '- Every point, decision and to-do needs evidence: the ids of the transcript lines that support it (e.g. ["L12","L13"]).',
    '- Speech recognition makes mistakes; use context and the glossary to write names and terms correctly.',
    '- Topics in time order; at most 8 topics, at most 5 points per topic; to-dos only when someone committed to do something (often none).',
    '- owner: "我方" (our side), "对方" (the other side), a person\'s name, or null; due: a date or deadline as said, or null.',
    '- terms: names and jargon a reader might not know, with their equivalent in the other language (at most 10).',
    '- Reply with one JSON object only, no markdown, matching exactly:',
    '{"title":{"zh":"","es":""},"summary":{"zh":"2-4 sentences","es":""},"topics":[{"start":seconds,"title":{"zh":"","es":""},"summary":{"zh":"","es":""},"points":[{"text":{"zh":"","es":""},"evidence":["L1"]}]}],"decisions":[{"text":{"zh":"","es":""},"evidence":["L2"]}],"todos":[{"text":{"zh":"","es":""},"owner":"我方","due":null,"evidence":["L3"]}],"terms":[{"zh":"","es":"","note":""}]}',
  ].join('\n');

  const header: string[] = [];
  header.push(`Meeting: ${meta.title || '(untitled)'}; started ${meta.startedAt}; languages ${meta.selfLang} and ${meta.remoteLang}.`);
  header.push('Speakers: 我方 = our side (Chinese speakers), 对方 = the other side (Spanish speakers); names are room participants.');
  const terms = glossary.filter((g) => g.enabled && g.zh && g.es).slice(0, 80);
  if (terms.length) header.push(`Glossary (correct spellings): ${terms.map((t) => `${t.zh} = ${t.es}`).join('; ')}`);
  if (part) header.push(`The meeting is long, so it is summarised in parts. This is part ${part.index} of ${part.of}; summarise only these lines.`);
  header.push('Transcript (id, time, speaker, original ‖ translation):');
  const offset = part?.offset ?? 0;
  const body = segs.map((s, i) => promptLine(s, offset + i));
  return { system, user: [...header, ...body].join('\n') };
}

/** Extracts and validates the JSON object from a model reply (tolerates code fences and chatter). */
export function parseSummary(raw: string): MeetingSummary {
  let text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first < 0 || last <= first) throw new Error('纪要模型没有返回 JSON');
  text = text.slice(first, last + 1);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('纪要模型返回的 JSON 无法解析');
  }
  return MeetingSummarySchema.parse(normalize(data));
}

/** Accepts plain strings where bilingual objects are expected (some models drop one language). */
function normalize(v: unknown, key = ''): unknown {
  const biKeys = new Set(['title', 'summary', 'text']);
  if (typeof v === 'string' && biKeys.has(key)) return { zh: v, es: v };
  if (Array.isArray(v)) return v.map((x) => normalize(x, key === 'evidence' ? 'evidence' : ''));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = normalize(x, k);
    return out;
  }
  return v;
}

export interface SummarizeOptions {
  /** Max characters of transcript per model call. */
  maxCharsPerPart?: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

/** Splits the transcript into parts of at most `maxChars` prompt characters. */
export function splitParts(segs: TranscriptSegment[], maxChars: number): { segs: TranscriptSegment[]; offset: number }[] {
  const parts: { segs: TranscriptSegment[]; offset: number }[] = [];
  let cur: TranscriptSegment[] = [];
  let curLen = 0;
  let offset = 0;
  segs.forEach((s, i) => {
    const len = promptLine(s, i).length + 1;
    if (cur.length && curLen + len > maxChars) {
      parts.push({ segs: cur, offset });
      offset = i;
      cur = [];
      curLen = 0;
    }
    cur.push(s);
    curLen += len;
  });
  if (cur.length) parts.push({ segs: cur, offset });
  return parts;
}

/** Summarises a meeting in one call, or per part plus a merge call for long meetings. */
export async function summarize(
  llm: Llm,
  segs: TranscriptSegment[],
  meta: MeetingMeta,
  glossary: GlossaryEntry[],
  template: SummaryTemplate,
  opts: SummarizeOptions = {},
): Promise<MeetingSummary> {
  const usable = segs.filter((s) => s.srcText.trim());
  if (!usable.length) throw new Error('会议记录为空，无法生成纪要');
  const parts = splitParts(usable, opts.maxCharsPerPart ?? 24000);
  const total = parts.length + (parts.length > 1 ? 1 : 0);
  const ask = async (system: string, user: string) => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = await llm.complete({ system, user, json: true, maxTokens: 6000, temperature: 0.2, signal: opts.signal });
        return parseSummary(raw);
      } catch (err) {
        lastErr = err;
        if (opts.signal?.aborted) break;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  };

  if (parts.length === 1) {
    const { system, user } = buildSummaryPrompt(usable, meta, glossary, template);
    const res = await ask(system, user);
    opts.onProgress?.(1, 1);
    return res;
  }
  const partial: MeetingSummary[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    const { system, user } = buildSummaryPrompt(p.segs, meta, glossary, template, { index: i + 1, of: parts.length, offset: p.offset });
    partial.push(await ask(system, user));
    opts.onProgress?.(i + 1, total);
  }
  const mergeSystem = buildSummaryPrompt([], meta, glossary, template).system;
  const mergeUser = [
    `The meeting "${meta.title || '(untitled)'}" was long, so it was summarised in ${parts.length} parts (JSON below, in time order, evidence ids refer to the full transcript).`,
    'Merge them into the minutes for the whole meeting: combine overlapping topics, keep every decision and to-do, keep evidence ids, and write a new overall title and summary.',
    ...partial.map((p, i) => `Part ${i + 1}: ${JSON.stringify(p)}`),
  ].join('\n');
  const merged = await ask(mergeSystem, mergeUser);
  opts.onProgress?.(total, total);
  return merged;
}

/** Minutes as Markdown in one language. */
export function summaryToMarkdown(sum: MeetingSummary, lang: 'zh' | 'es', meta?: MeetingMeta): string {
  const zh = lang === 'zh';
  const L = (b: { zh: string; es: string }) => (zh ? b.zh || b.es : b.es || b.zh);
  const ev = (e: string[]) => (e.length ? ` <sub>${e.join(', ')}</sub>` : '');
  const out: string[] = [];
  out.push(`# ${L(sum.title) || meta?.title || (zh ? '会议纪要' : 'Acta de la reunión')}`);
  if (meta) {
    out.push('');
    out.push(`${zh ? '时间' : 'Fecha'}：${new Date(meta.startedAt).toLocaleString(zh ? 'zh-CN' : 'es-ES')}`);
  }
  out.push('');
  out.push(`## ${zh ? '摘要' : 'Resumen'}`);
  out.push('');
  out.push(L(sum.summary));
  if (sum.topics.length) {
    out.push('');
    out.push(`## ${zh ? '议题' : 'Temas'}`);
    for (const t of sum.topics) {
      out.push('');
      out.push(`### ${formatClock(t.start)} ${L(t.title)}`);
      if (L(t.summary)) out.push('', L(t.summary));
      if (t.points.length) {
        out.push('');
        for (const p of t.points) out.push(`- ${L(p.text)}${ev(p.evidence)}`);
      }
    }
  }
  out.push('');
  out.push(`## ${zh ? '结论' : 'Acuerdos'}`);
  out.push('');
  if (sum.decisions.length) for (const d of sum.decisions) out.push(`- ${L(d.text)}${ev(d.evidence)}`);
  else out.push(zh ? '（无）' : '(ninguno)');
  out.push('');
  out.push(`## ${zh ? '待办' : 'Tareas'}`);
  out.push('');
  if (sum.todos.length) {
    for (const t of sum.todos) {
      const who = t.owner ? (zh ? `负责人：${t.owner}` : `Responsable: ${t.owner}`) : '';
      const due = t.due ? (zh ? `截止：${t.due}` : `Plazo: ${t.due}`) : '';
      const extra = [who, due].filter(Boolean).join('；');
      out.push(`- [ ] ${L(t.text)}${extra ? `（${extra}）` : ''}${ev(t.evidence)}`);
    }
  } else out.push(zh ? '（无）' : '(ninguna)');
  if (sum.terms.length) {
    out.push('');
    out.push(`## ${zh ? '术语' : 'Términos'}`);
    out.push('');
    out.push(zh ? '| 中文 | Español | 说明 |' : '| Chino | Español | Nota |');
    out.push('|---|---|---|');
    for (const t of sum.terms) out.push(`| ${t.zh} | ${t.es} | ${t.note} |`);
  }
  out.push('');
  return out.join('\n');
}
