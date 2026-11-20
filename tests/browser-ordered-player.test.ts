import { describe, expect, it } from 'vitest';
import { OrderedPlayer, type PlayerAudioContext } from '../src/browser/ordered-player';

/** A fake Web Audio context: records when each buffer starts. */
function fakeCtx() {
  const started: { label: number; at: number; dur: number }[] = [];
  let stopped = 0;
  const ctx: PlayerAudioContext & { t: number } = {
    t: 0,
    get currentTime() {
      return this.t;
    },
    createBuffer(_ch: number, length: number, rate: number) {
      const data = new Float32Array(length);
      return { duration: length / rate, getChannelData: () => data };
    },
    createBufferSource() {
      const src = {
        buffer: null as { duration: number; getChannelData: (c: number) => Float32Array } | null,
        onended: null as null | (() => void),
        connect: () => undefined,
        start(at: number) {
          const d = src.buffer!.getChannelData(0);
          started.push({ label: Math.round(d[0]! * 32768), at, dur: src.buffer!.duration });
        },
        stop: () => void stopped++,
      };
      return src;
    },
  };
  return { ctx, started, stopped: () => stopped };
}

const pcm = (label: number, seconds: number) => new Int16Array(Math.round(16000 * seconds)).fill(label);

describe('OrderedPlayer', () => {
  it('plays each sentence whole, and sentences in the order they began', () => {
    const { ctx, started } = fakeCtx();
    const p = new OrderedPlayer(ctx, {}, { lead: 0 });
    p.push('a', pcm(1, 1), 16000);
    p.push('b', pcm(2, 1), 16000); // b overlaps a: waits
    p.push('a', pcm(3, 1), 16000);
    p.end('a');
    p.push('b', pcm(4, 1), 16000);
    expect(started.map((s) => [s.label, s.at])).toEqual([[1, 0], [3, 1], [2, 2], [4, 3]]);
    expect(p.backlog()).toBeCloseTo(4);
  });

  it('reports what is still waiting to play, counting down', () => {
    const { ctx } = fakeCtx();
    const p = new OrderedPlayer(ctx, {}, { lead: 0 });
    p.push('a', pcm(1, 2), 16000);
    p.push('b', pcm(2, 1), 16000);
    expect(p.backlog()).toBeCloseTo(3);
    ctx.t = 1.5;
    expect(p.backlog()).toBeCloseTo(1.5);
  });

  it('moves on when a sentence never says it ended', () => {
    const { ctx, started } = fakeCtx();
    const p = new OrderedPlayer(ctx, {}, { lead: 0, stallS: 0.5 });
    p.push('a', pcm(1, 1), 16000);
    p.push('b', pcm(2, 1), 16000);
    ctx.t = 2; // a finished playing long ago and no end came
    p.push('b', pcm(3, 1), 16000);
    expect(started.map((s) => s.label)).toEqual([1, 2, 3]);
  });

  it('flushes everything, including sentences that were waiting', () => {
    const { ctx, started, stopped } = fakeCtx();
    const p = new OrderedPlayer(ctx, {}, { lead: 0 });
    p.push('a', pcm(1, 1), 16000);
    p.push('b', pcm(2, 1), 16000);
    p.flush();
    expect(stopped()).toBe(1);
    expect(p.backlog()).toBe(0);
    p.end('a');
    expect(started).toHaveLength(1);
    p.push('c', pcm(5, 1), 16000);
    expect(started.at(-1)!.label).toBe(5);
  });
});
