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

const MAX_CHARS = 9000;

function parseItems(reply: string): { line?: unknown; heard?: unknown; meant?: unknown; reason?: unknown }[] {
  const m = reply.match(/\{[\s\S]*\}/);
  if (!m) return [];
  try {
    const v = JSON.parse(m[0]) as { items?: unknown };
    return Array.isArray(v.items) ? (v.items as { line?: unknown }[]) : [];
  } catch {
    return [];
  }
}

export async function reviewTranscript(llm: Llm, segs: TranscriptSegment[], opts: { terms: string[]; signal?: AbortSignal; max?: number }): Promise<ReviewSuggestion[]> {
  const mine = segs.filter((s) => s.dir === 'out' && s.srcText.trim());
  if (!mine.length) return [];
  const base = baseOf(mine[0]!.srcLang);
  const out: ReviewSuggestion[] = [];
  const terms = opts.terms.filter(Boolean).slice(0, 80);
  const system = [
    'You check a speech-recognition transcript of one speaker in a business meeting.',
    'Find words that the recogniser most likely MIS-HEARD: homophones or near-homophones (for Chinese: same or similar pinyin, typical accent mix-ups such as n/l, f/h, z/zh, an/ang, in/ing), or mangled names and terms.',
    'Only flag a word when it is clearly wrong in context AND sounds like the replacement. Do not fix grammar, style, filler words or punctuation. Do not rewrite sentences.',
    terms.length ? `The speaker's own names and terms (likely meant when something sounds like them): ${terms.join('、')}` : '',
    'Reply with JSON only: {"items":[{"line":<line number>,"heard":"<exact text as it appears in that line>","meant":"<what was said>","reason":"<short reason in Chinese>"}]}. Use {"items":[]} if nothing is wrong.',
  ]
    .filter(Boolean)
    .join('\n');
  // In parts, so long meetings fit.
  for (let i = 0; i < mine.length; ) {
    const start = i;
    let user = '';
    while (i < mine.length && (user.length < MAX_CHARS || i === start)) {
      user += `${i - start + 1}. ${mine[i]!.srcText.trim()}\n`;
      i++;
    }
    const part = mine.slice(start, i);
    const reply = await llm.complete({ system, user, json: true, maxTokens: 2000, temperature: 0.1, signal: opts.signal });
    for (const it of parseItems(reply)) {
      const line = typeof it.line === 'number' ? it.line : Number(it.line);
      const seg = part[line - 1];
      const heard = typeof it.heard === 'string' ? it.heard.trim() : '';
      const meant = typeof it.meant === 'string' ? it.meant.trim() : '';
      if (!seg || !heard || !meant || heard === meant || heard.length > 20 || meant.length > 20) continue;
      if (!seg.srcText.includes(heard)) continue;
      if (!soundsAlike(tokens(heard, base), tokens(meant, base), base)) continue;
      if (out.some((o) => o.segId === seg.id && o.heard === heard)) continue;
      out.push({ segId: seg.id, heard, meant, reason: typeof it.reason === 'string' ? it.reason.slice(0, 80) : '' });
      if (out.length >= (opts.max ?? 40)) return out;
    }
  }
  return out;
}
