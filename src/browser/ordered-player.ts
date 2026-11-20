/**
 * Plays translated speech gaplessly with Web Audio: each sentence whole, and sentences in the
 * order they began — two speakers translated at the same time are never mixed chunk by chunk.
 * Used by every place that plays translations (desktop, extension, phone, room page).
 */

/** The parts of Web Audio the player uses (a real AudioContext fits; tests pass a fake). */
interface PlayerBuffer {
  readonly duration: number;
  getChannelData(channel: number): Float32Array;
}
interface PlayerSource {
  buffer: PlayerBuffer | null;
  onended: ((...args: any[]) => unknown) | null;
  connect(destination: any): unknown;
  start(when?: number): void;
  stop(): void;
}
export interface PlayerAudioContext {
  readonly currentTime: number;
  createBuffer(channels: number, length: number, sampleRate: number): PlayerBuffer;
  createBufferSource(): PlayerSource;
}

export interface OrderedPlayerOptions {
  /** Seconds between "now" and the first scheduled sound (scheduling headroom). Default 0.03. */
  lead?: number;
  /**
   * A sentence that stopped sending audio this long after its last sound ended is treated as
   * finished, so a lost "end" never blocks the next one. Default 1.5 s.
   */
  stallS?: number;
  /** Called with the number of sounds playing whenever it changes (e.g. to lower other audio). */
  onActivity?: (playing: number) => void;
}

interface Waiting {
  id: string;
  buffers: PlayerBuffer[];
  ended: boolean;
}

export class OrderedPlayer {
  private nextTime = 0;
  private current: { id: string; ended: boolean } | null = null;
  private waiting: Waiting[] = [];
  private sources = new Set<PlayerSource>();

  constructor(
    private readonly ctx: PlayerAudioContext,
    private readonly dest: unknown,
    private readonly o: OrderedPlayerOptions = {},
  ) {}

  /** A chunk of a sentence's speech (16-bit PCM). */
  push(segmentId: string, samples: Int16Array, sampleRate: number): void {
    if (!samples.length) return;
    const buf = this.ctx.createBuffer(1, samples.length, sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < samples.length; i++) ch[i] = samples[i]! / 32768;
    this.unstall();
    if (!this.current) this.current = { id: segmentId, ended: false };
    if (this.current.id === segmentId) return this.schedule(buf);
    let w = this.waiting.find((x) => x.id === segmentId);
    if (!w) this.waiting.push((w = { id: segmentId, buffers: [], ended: false }));
    w.buffers.push(buf);
  }

  /** The sentence has no more audio. */
  end(segmentId: string): void {
    if (this.current?.id === segmentId) {
      this.current.ended = true;
      this.advance();
    } else {
      const w = this.waiting.find((x) => x.id === segmentId);
      if (w) w.ended = true;
    }
  }

  /** Seconds of speech still to play, including sentences waiting their turn. */
  backlog(): number {
    const waiting = this.waiting.reduce((n, w) => n + w.buffers.reduce((m, b) => m + b.duration, 0), 0);
    return Math.max(0, this.nextTime - this.ctx.currentTime) + waiting;
  }

  /** Stops everything now (skip, or translated speech switched off). */
  flush(): void {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.sources.clear();
    this.waiting = [];
    this.current = null;
    this.nextTime = 0;
    this.o.onActivity?.(0);
  }

  private schedule(buf: PlayerBuffer): void {
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.dest);
    const at = Math.max(this.ctx.currentTime + (this.o.lead ?? 0.03), this.nextTime);
    src.start(at);
    this.nextTime = at + buf.duration;
    this.sources.add(src);
    this.o.onActivity?.(this.sources.size);
    src.onended = () => {
      this.sources.delete(src);
      this.o.onActivity?.(this.sources.size);
    };
  }

  /** The current sentence ended: the next waiting one plays right after it. */
  private advance(): void {
    while (this.current?.ended) {
      const next = this.waiting.shift();
      if (!next) {
        this.current = null;
        return;
      }
      this.current = { id: next.id, ended: next.ended };
      for (const b of next.buffers) this.schedule(b);
    }
  }

  /** A sentence that went quiet without an "end" is finished once its sound has played out. */
  private unstall(): void {
    if (this.current && !this.current.ended && this.waiting.length && this.ctx.currentTime > this.nextTime + (this.o.stallS ?? 1.5)) {
      this.current.ended = true;
      this.advance();
    }
  }
}
