import { isLatin, type LangBase } from '../lang/languages';

/**
 * Decides which pieces of recognised speech become translation units.
 *
 * Final sentences from the recogniser are always committed. In low-latency mode a long sentence is
 * also committed early, clause by clause: once a partial hypothesis has kept the same prefix up to
 * a clause mark (，、；：,;:) for `stableMs` and that prefix has enough content, the prefix goes out
 * (idea from Parrots' clause submission). The final then contributes only what was not committed.
 */
export interface CommitterOptions {
  base: LangBase;
  lowLatency?: boolean;
  /** How long a partial prefix must stay unchanged before it is committed early. */
  stableMs?: number;
  /** Minimum Han characters (zh) in an early clause. */
  minChars?: number;
  /** Minimum words (es) in an early clause. */
  minWords?: number;
}

const CLAUSE_MARKS = /[，、；：,;:]/g;
const PUNCT_SPACE = /[\s，。、；：？！,.;:?!"'“”‘’«»…—\-()（）]/g;

export function normalizeForCompare(s: string): string {
  return s.replace(PUNCT_SPACE, '').toLowerCase();
}

/** Number of characters of `text` covered by `prefix` when both are compared without punctuation/space. */
function coveredLength(text: string, prefix: string): number {
  const target = normalizeForCompare(prefix);
  if (!target) return 0;
  let n = 0;
  let i = 0;
  for (; i < text.length && n < target.length; i++) {
    const c = text[i]!;
    if (normalizeForCompare(c) === '') continue;
    if (c.toLowerCase() !== target[n]) return -1;
    n++;
  }
  if (n < target.length) return -1;
  // Also swallow punctuation directly after the covered prefix.
  while (i < text.length && normalizeForCompare(text[i]!) === '') i++;
  return i;
}

/** Longest common prefix of two strings compared without punctuation/space, as a length in `b`. */
function commonPrefixIn(b: string, a: string): number {
  const na = normalizeForCompare(a);
  let n = 0;
  let i = 0;
  let lastGood = 0;
  for (; i < b.length; i++) {
    const c = b[i]!;
    if (normalizeForCompare(c) === '') continue;
    if (n < na.length && c.toLowerCase() === na[n]) {
      n++;
      lastGood = i + 1;
    } else break;
  }
  return lastGood;
}

/** Moves `idx` back to the start of the word it falls in (Intl.Segmenter knows Chinese words). */
export function snapToWordStart(text: string, idx: number, base: LangBase): number {
  if (idx <= 0 || idx >= text.length) return Math.max(0, Math.min(idx, text.length));
  const Seg = (Intl as unknown as { Segmenter?: new (l: string, o: { granularity: 'word' }) => { segment(s: string): Iterable<{ index: number; segment: string }> } }).Segmenter;
  if (Seg) {
    let start = 0;
    for (const s of new Seg(base, { granularity: 'word' }).segment(text)) {
      if (s.index > idx) break;
      start = s.index;
      if (s.index + s.segment.length > idx) return s.index === idx ? idx : start;
    }
    return start;
  }
  if (isLatin(base)) {
    const sp = text.lastIndexOf(' ', idx - 1);
    return sp < 0 ? 0 : sp + 1;
  }
  return idx;
}

export class Committer {
  private readonly base: LangBase;
  private readonly lowLatency: boolean;
  private readonly stableMs: number;
  private readonly minChars: number;
  private readonly minWords: number;
  /** Text of the current sentence already committed early. */
  private committed = '';
  private candidate = '';
  private candidateSince = 0;

  constructor(opts: CommitterOptions) {
    this.base = opts.base;
    this.lowLatency = opts.lowLatency ?? true;
    this.stableMs = opts.stableMs ?? 700;
    this.minChars = opts.minChars ?? 6;
    this.minWords = opts.minWords ?? 4;
  }

  private enoughContent(s: string): boolean {
    if (!isLatin(this.base)) return (s.match(/\p{Script=Han}/gu)?.length ?? 0) >= this.minChars;
    return s.trim().split(/\s+/).filter((w) => /\p{L}/u.test(w)).length >= this.minWords;
  }

  /** The text of `partial` after what was already committed, or null when the partial diverged. */
  private remainder(text: string): string | null {
    if (!this.committed) return text;
    const at = coveredLength(text, this.committed);
    if (at < 0) return null;
    return text.slice(at);
  }

  onPartial(text: string, nowMs: number): string[] {
    if (!this.lowLatency) return [];
    const rest = this.remainder(text);
    if (rest === null) return [];
    // Last clause mark inside the uncommitted part (not counting a trailing one still being typed).
    let cut = -1;
    for (const m of rest.matchAll(CLAUSE_MARKS)) {
      if (m.index !== undefined && m.index < rest.length - 1) cut = m.index + 1;
    }
    if (cut < 0) {
      this.candidate = '';
      return [];
    }
    const clause = rest.slice(0, cut);
    if (normalizeForCompare(clause) !== normalizeForCompare(this.candidate)) {
      this.candidate = clause;
      this.candidateSince = nowMs;
      return [];
    }
    if (nowMs - this.candidateSince < this.stableMs || !this.enoughContent(clause)) return [];
    const unit = clause.trim();
    this.committed += clause;
    this.candidate = '';
    return unit ? [unit] : [];
  }

  onFinal(text: string, _nowMs: number): string[] {
    let rest: string;
    if (!this.committed) rest = text;
    else {
      const at = coveredLength(text, this.committed);
      // The recogniser revised what we already sent: send what follows the common prefix.
      rest = at >= 0 ? text.slice(at) : text.slice(snapToWordStart(text, commonPrefixIn(text, this.committed), this.base));
    }
    this.committed = '';
    this.candidate = '';
    const unit = rest.replace(/^[\s，、；：,;:。.]+/, '').trim();
    return unit && normalizeForCompare(unit) ? [unit] : [];
  }

  reset(): void {
    this.committed = '';
    this.candidate = '';
  }
}
