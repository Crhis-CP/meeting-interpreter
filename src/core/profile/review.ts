/**
 * After a meeting (only with the user's own LLM key): the LLM reads what *I* said and points out
 * words the recogniser most likely mis-heard. Suggestions are only kept when the word is really in
 * that sentence and sounds like the replacement; the user confirms each one before it is learned.
 */
import { baseOf } from '../lang/languages';
import type { Llm } from '../providers/types';
import type { TranscriptSegment } from '../types';
import { soundsAlike, tokens } from './learn';

export interface ReviewSuggestion {
  segId: string;
  heard: string;
  meant: string;
  reason: string;
}

/** A term the meeting used (name, product, industry word) with its translation, for the automatic glossary. */
export interface LearnedTerm {
  zh: string;
  foreign: string;
}

const MAX_CHARS = 9000;

export async function reviewTranscript(llm: Llm, segs: TranscriptSegment[], opts: { terms: string[]; signal?: AbortSignal; max?: number }): Promise<ReviewSuggestion[]> {
  return (await review(llm, segs, { ...opts, withTerms: null })).suggestions;
}

/** The full after-meeting pass: likely mis-hearings in my sentences, and terms worth keeping. */
export function reviewMeeting(llm: Llm, segs: TranscriptSegment[], opts: { terms: string[]; foreign: 'es' | 'en'; signal?: AbortSignal; max?: number }): Promise<{ suggestions: ReviewSuggestion[]; terms: LearnedTerm[] }> {
  return review(llm, segs, { ...opts, withTerms: opts.foreign });
}

const FOREIGN_NAME = { es: 'Spanish', en: 'English' } as const;
const HAN_RUN = /^\p{Script=Han}[\p{Script=Han}A-Za-z0-9·\-\s]{1,15}$/u;

async function review(
  llm: Llm,
  segs: TranscriptSegment[],
  opts: { terms: string[]; withTerms: 'es' | 'en' | null; signal?: AbortSignal; max?: number },
): Promise<{ suggestions: ReviewSuggestion[]; terms: LearnedTerm[] }> {
  const mine = segs.filter((s) => s.dir === 'out' && s.srcText.trim());
  if (!mine.length && !opts.withTerms) return { suggestions: [], terms: [] };
  const base = baseOf(mine[0]?.srcLang ?? 'zh-CN');
  const out: ReviewSuggestion[] = [];
  const known = opts.terms.filter(Boolean);
  const termsHint = known.slice(0, 80);
  const system = [
    'You check a speech-recognition transcript of one speaker in a business meeting.',
    'Find words that the recogniser most likely MIS-HEARD: homophones or near-homophones (for Chinese: same or similar pinyin, typical accent mix-ups such as n/l, f/h, z/zh, an/ang, in/ing), or mangled names and terms.',
    'Only flag a word when it is clearly wrong in context AND sounds like the replacement. Do not fix grammar, style, filler words or punctuation. Do not rewrite sentences.',
    termsHint.length ? `The speaker's own names and terms (likely meant when something sounds like them): ${termsHint.join('、')}` : '',
    opts.withTerms
      ? `Also list up to 15 TERMS from the bilingual transcript worth keeping in a glossary: names of people, companies, products, brands and places, and industry or technical terms. NOT everyday words. For each give the Chinese form and the ${FOREIGN_NAME[opts.withTerms]} form exactly as they appear in the transcript.`
      : '',
    `Reply with JSON only: {"items":[{"line":<line number>,"heard":"<exact text as it appears in that line>","meant":"<what was said>","reason":"<short reason in Chinese>"}]${opts.withTerms ? ',"terms":[{"zh":"<Chinese>","foreign":"<' + FOREIGN_NAME[opts.withTerms] + '>"}]' : ''}}. Use empty lists when there is nothing.`,
  ]
    .filter(Boolean)
    .join('\n');
  const bilingual = opts.withTerms
    ? segs
        .filter((s) => s.srcText.trim() && s.dstText?.trim())
        .map((s) => `${s.srcText.trim()} ‖ ${s.dstText!.trim()}`)
        .join('\n')
        .slice(0, MAX_CHARS)
    : '';
  let rawTerms: { zh?: unknown; foreign?: unknown }[] = [];
  // In parts, so long meetings fit; the bilingual transcript (for terms) goes with the first part.
  for (let i = 0, first = true; i < mine.length || first; first = false) {
    const start = i;
    let user = '';
    while (i < mine.length && (user.length < MAX_CHARS || i === start)) {
      user += `${i - start + 1}. ${mine[i]!.srcText.trim()}\n`;
      i++;
    }
    if (first && bilingual) user = `${user ? `My sentences (numbered):\n${user}\n` : ''}Bilingual transcript (source ‖ translation):\n${bilingual}\n`;
    const part = mine.slice(start, i);
    const reply = await llm.complete({ system, user, json: true, maxTokens: 2500, temperature: 0.1, signal: opts.signal });
    if (first) rawTerms = parseList(reply, 'terms');
    for (const it of parseList(reply, 'items')) {
      const line = typeof it.line === 'number' ? it.line : Number(it.line);
      const seg = part[line - 1];
      const heard = typeof it.heard === 'string' ? it.heard.trim() : '';
      const meant = typeof it.meant === 'string' ? it.meant.trim() : '';
      if (!seg || !heard || !meant || heard === meant || heard.length > 20 || meant.length > 20) continue;
      if (!seg.srcText.includes(heard)) continue;
      if (!soundsAlike(tokens(heard, base), tokens(meant, base), base)) continue;
      if (out.some((o) => o.segId === seg.id && o.heard === heard)) continue;
      out.push({ segId: seg.id, heard, meant, reason: typeof it.reason === 'string' ? it.reason.slice(0, 80) : '' });
      if (out.length >= (opts.max ?? 40)) break;
    }
    if (i >= mine.length) break;
  }
  // Terms: really in the meeting, in both languages, and not already the user's.
  const all = segs.map((s) => `${s.srcText}\n${s.dstText ?? ''}`).join('\n');
  const lower = all.toLowerCase();
  const knownSet = new Set(known.map((k) => k.toLowerCase()));
  const terms: LearnedTerm[] = [];
  for (const t of rawTerms) {
    const zh = typeof t.zh === 'string' ? t.zh.trim() : '';
    const foreign = typeof t.foreign === 'string' ? t.foreign.trim() : '';
    if (!HAN_RUN.test(zh) || foreign.length < 2 || foreign.length > 40) continue;
    if (!all.includes(zh) || !lower.includes(foreign.toLowerCase())) continue;
    if (knownSet.has(zh.toLowerCase()) || knownSet.has(foreign.toLowerCase())) continue;
    // A mis-heard word is not a term (the model sometimes lists both).
    if (out.some((o) => o.heard.includes(zh) || zh.includes(o.heard))) continue;
    if (terms.some((x) => x.zh === zh)) continue;
    terms.push({ zh, foreign });
    if (terms.length >= 15) break;
  }
  return { suggestions: out, terms };
}

function parseList(reply: string, key: 'items' | 'terms'): { line?: unknown; heard?: unknown; meant?: unknown; reason?: unknown; zh?: unknown; foreign?: unknown }[] {
  const m = reply.match(/\{[\s\S]*\}/);
  if (!m) return [];
  try {
    const v = JSON.parse(m[0]) as Record<string, unknown>;
    return Array.isArray(v[key]) ? (v[key] as { line?: unknown }[]) : [];
  } catch {
    return [];
  }
}
