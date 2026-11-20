import { Emitter } from '../events';
import { ASR_RATE, rms } from './pcm';

/**
 * Cuts 16 kHz mono speech into segments by loudness.
 *
 * Rules adapted from Cicada's Segmenter (Apache-2.0, github.com/wquguru/cicada): a pause of 0.6 s
 * ends a segment; one that runs to 8 s is cut at its quietest frame in the last 2 s so words are
 * rarely split; sound must last 30 ms (three 10 ms steps) before it counts, so a key click neither
 * opens a segment nor breaks a pause. An adaptive gate follows the noise floor for room mics.
 */
export interface SegmenterOptions {
  /** Minimum RMS (0..1) that counts as sound. Default 0.01 (≈ −40 dBFS). */
  threshold?: number;
  /** Seconds of quiet that end a segment. Default 0.6. */
  pause?: number;
  /** Longest segment in seconds. Default 8. */
  maxLength?: number;
  /** Segments with less sound than this (seconds) are dropped. Default 0.25. */
  minSpeech?: number;
  /** Raise the gate above a steady noise floor (mic in a room). Default true. */
  adaptive?: boolean;
}

export interface SpeechSegment {
  index: number;
  /** Seconds since the first sample fed. */
  start: number;
  samples: Int16Array;
}

const FRAME = 480; // 30 ms
const STEP = 160; // 10 ms
const ONSET = 3;
const PRE_ROLL = 0.15;
const TAIL = 0.15;
const CUT_WINDOW = 2.0;

export class Segmenter extends Emitter<{
  segment: SpeechSegment;
  speechStart: { t: number };
  speechEnd: { t: number };
}> {
  private readonly threshold: number;
  private readonly pause: number;
  private readonly maxLength: number;
  private readonly minSpeech: number;
  private readonly adaptive: boolean;

  private pending: Int16Array = new Int16Array(0);
  private current: Int16Array[] = [];
  private currentLen = 0;
  private levels: number[] = [];
  private before: { frame: Int16Array; level: number }[] = [];
  private consumed = 0;
  private currentStart = 0;
  private quietFrames = 0;
  private loudFrames = 0;
  private sounding = 0;
  private index = 0;
  private noiseFloor = 0;
  private recent: number[] = [];
  private framesSinceFloor = 0;
  private open = false;

  constructor(opts: SegmenterOptions = {}) {
    super();
    this.threshold = opts.threshold ?? 0.01;
    this.pause = opts.pause ?? 0.6;
    this.maxLength = opts.maxLength ?? 8;
    this.minSpeech = opts.minSpeech ?? 0.25;
    this.adaptive = opts.adaptive ?? true;
  }

  /** The level that currently counts as speech. */
  get line(): number {
    return this.adaptive ? Math.max(this.threshold, this.noiseFloor * 2) : this.threshold;
  }

  get speaking(): boolean {
    return this.open;
  }

  /** Seconds of audio seen so far. */
  get time(): number {
    return this.consumed / ASR_RATE;
  }

  feed(samples: Int16Array): void {
    let buf: Int16Array;
    if (this.pending.length) {
      buf = new Int16Array(this.pending.length + samples.length);
      buf.set(this.pending);
      buf.set(samples, this.pending.length);
    } else buf = samples;
    let off = 0;
    while (off + FRAME <= buf.length) {
      this.step(buf.subarray(off, off + FRAME));
      off += FRAME;
    }
    this.pending = buf.slice(off);
  }

  /** Ends the open segment (listening stopped or push-to-talk released). */
  flush(): void {
    if (this.open) this.close(this.currentLen - Math.max(0, this.quietFrames * FRAME - Math.round(TAIL * ASR_RATE)));
    this.pending = new Int16Array(0);
  }

  reset(): void {
    this.pending = new Int16Array(0);
    this.current = [];
    this.currentLen = 0;
    this.levels = [];
    this.before = [];
    this.quietFrames = 0;
    this.loudFrames = 0;
    this.sounding = 0;
    this.open = false;
    this.recent = [];
    this.noiseFloor = 0;
  }

  private isSpeech(frame: Int16Array): boolean {
    const line = this.line;
    let said = false;
    for (let i = 0; i < frame.length; i += STEP) {
      const level = rms(frame, i, Math.min(frame.length, i + STEP));
      if (level >= line) {
        if (++this.sounding >= ONSET) said = true;
      } else this.sounding = 0;
    }
    return said;
  }

  private step(frame: Int16Array): void {
    const level = rms(frame);
    if (this.adaptive) this.trackFloor(level);
    const loud = this.isSpeech(frame);
    const now = this.consumed / ASR_RATE;
    this.consumed += frame.length;

    if (!this.open) {
      if (!loud) {
        this.before.push({ frame: frame.slice(), level });
        const keep = Math.ceil((PRE_ROLL * ASR_RATE) / FRAME) + 1;
        while (this.before.length > keep) this.before.shift();
        return;
      }
      this.open = true;
      this.currentStart = now - (this.before.length * FRAME) / ASR_RATE;
      for (const b of this.before) this.append(b.frame, b.level);
      this.before = [];
      this.quietFrames = 0;
      this.loudFrames = 0;
      this.emit('speechStart', { t: this.currentStart });
    }

    this.append(frame.slice(), level);
    if (loud) {
      this.quietFrames = 0;
      this.loudFrames++;
    } else this.quietFrames++;

    if (this.quietFrames * FRAME >= this.pause * ASR_RATE) {
      this.close(this.currentLen - this.quietFrames * FRAME + Math.round(TAIL * ASR_RATE));
    } else if (this.currentLen >= this.maxLength * ASR_RATE) {
      const from = Math.max(1, this.levels.length - Math.round((CUT_WINDOW * ASR_RATE) / FRAME));
      let cut = from;
      for (let i = from; i < this.levels.length; i++) if (this.levels[i]! < this.levels[cut]!) cut = i;
      this.close(cut * FRAME, true);
    }
  }

  /**
   * The noise floor is the 10th percentile of the last 5 s of frame levels: speech dips between
   * words reach it, steady hiss or hum sits on it. Capped at −26 dBFS so loud continuous sound
   * (or a test tone) still counts as speech.
   */
  private trackFloor(level: number): void {
    this.recent.push(level);
    if (this.recent.length > 166) this.recent.shift();
    if (++this.framesSinceFloor < 10 && this.recent.length > 10) return;
    this.framesSinceFloor = 0;
    const sorted = [...this.recent].sort((a, b) => a - b);
    const p10 = sorted[Math.floor(sorted.length * 0.1)] ?? 0;
    this.noiseFloor = Math.min(p10, 0.05);
  }

  private append(frame: Int16Array, level: number): void {
    this.current.push(frame);
    this.currentLen += frame.length;
    this.levels.push(level);
  }

  /** Emits samples [0, end) of the open segment; with `carry`, the rest starts the next one. */
  private close(end: number, carry = false): void {
    const all = new Int16Array(this.currentLen);
    let o = 0;
    for (const c of this.current) {
      all.set(c, o);
      o += c.length;
    }
    end = Math.max(0, Math.min(end, all.length));
    const loudSeconds = (this.loudFrames * FRAME) / ASR_RATE;
    const start = this.currentStart;
    if (end > 0 && loudSeconds >= this.minSpeech) {
      this.emit('segment', { index: this.index++, start, samples: all.slice(0, end) });
    }
    const rest = carry ? all.slice(end) : new Int16Array(0);
    const restLevels = carry ? this.levels.slice(Math.floor(end / FRAME)) : [];
    this.current = [];
    this.currentLen = 0;
    this.levels = [];
    this.quietFrames = 0;
    this.loudFrames = 0;
    if (carry && rest.length) {
      this.current = [rest];
      this.currentLen = rest.length;
      this.levels = restLevels;
      this.currentStart = start + end / ASR_RATE;
      // The carried audio was all part of continuous speech.
      this.loudFrames = restLevels.length;
    } else {
      this.open = false;
      this.emit('speechEnd', { t: start + end / ASR_RATE });
    }
  }
}
