/**
 * What both sides of one meeting (or room) said, for the translations that depend on it: Chinese
 * leaves out the object Spanish must name with its gender ("昨天已经发了" → "ya las enviamos"
 * after "¿mandaron las facturas?"), "电池是一年" means the warranty after a question about it.
 *
 * Words as recognised (fillers removed), never machine translations, so one wrong translation
 * cannot mislead the next. The window a translation sees only grows (the local model then reuses
 * what it already computed for it) until it holds `max` turns or `maxChars` characters, then
 * starts again from the last `keep` turns. Short on purpose: what a reply needs is mostly the
 * turn or two before it, and every turn costs the local model time (4 turns: ~0.25 s a sentence
 * on 4 cores, docs/translation-benchmark.md).
 */
export interface Turn {
  /** 'me', 'them', or a room participant's name. */
  who: string;
  text: string;
}

export class Talk {
  private turns: Turn[] = [];
  private from = 0;

  constructor(private readonly o: { max?: number; keep?: number; maxChars?: number } = {}) {}

  add(turn: Turn): void {
    if (!turn.text.trim()) return;
    this.turns.push(turn);
    if (this.turns.length > 100) {
      this.turns.shift();
      this.from = Math.max(0, this.from - 1);
    }
  }

  /** The turns a translation sees now, oldest first. */
  window(): Turn[] {
    const max = this.o.max ?? 4;
    const keep = this.o.keep ?? 2;
    const maxChars = this.o.maxChars ?? 240;
    const chars = () => this.turns.slice(this.from).reduce((n, t) => n + t.text.length, 0);
    if (this.turns.length - this.from > max || chars() > maxChars) {
      this.from = Math.max(0, this.turns.length - keep);
      while (this.from < this.turns.length - 1 && chars() > maxChars / 2) this.from++;
    }
    return this.turns.slice(this.from);
  }

  reset(): void {
    this.turns = [];
    this.from = 0;
  }
}
