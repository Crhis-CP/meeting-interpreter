import { describe, expect, it } from 'vitest';
import { Segmenter, type SpeechSegment } from '@core/audio/segmenter';
import { concatInt16, silence, tone } from '@core/audio/pcm';

const R = 16000;
function run(audio: Int16Array, opts = {}): SpeechSegment[] {
  const s = new Segmenter(opts);
  const out: SpeechSegment[] = [];
  s.on('segment', (seg) => out.push(seg));
  // Feed in uneven chunks like a real stream.
  for (let i = 0; i < audio.length; i += 777) s.feed(audio.subarray(i, i + 777));
  s.flush();
  return out;
}

describe('Segmenter', () => {
  it('emits nothing for silence', () => {
    expect(run(silence(3, R))).toEqual([]);
  });

  it('cuts one segment around a burst of sound', () => {
    const segs = run(concatInt16([silence(1, R), tone(1, 300, R), silence(1.5, R)]));
    expect(segs).toHaveLength(1);
    const seg = segs[0]!;
    expect(seg.start).toBeGreaterThan(0.8);
    expect(seg.start).toBeLessThan(1.0);
    const dur = seg.samples.length / R;
    expect(dur).toBeGreaterThan(1.1);
    expect(dur).toBeLessThan(1.5);
  });

  it('splits long continuous speech at max length', () => {
    const segs = run(concatInt16([tone(12, 300, R), silence(1, R)]));
    expect(segs.length).toBeGreaterThanOrEqual(2);
    expect(segs[0]!.samples.length / R).toBeLessThanOrEqual(8.01);
    const total = segs.reduce((s, x) => s + x.samples.length, 0) / R;
    expect(total).toBeGreaterThan(11.5);
  });

  it('ignores a short click inside a pause', () => {
    const click = tone(0.005, 2000, R, 0.8);
    const segs = run(concatInt16([tone(1, 300, R), silence(0.3, R), click, silence(0.5, R), silence(1, R)]));
    expect(segs).toHaveLength(1);
  });

  it('does not open a segment for a lone click', () => {
    const segs = run(concatInt16([silence(1, R), tone(0.005, 2000, R, 0.8), silence(1, R)]));
    expect(segs).toEqual([]);
  });

  it('flush closes an open segment', () => {
    const s = new Segmenter();
    const out: SpeechSegment[] = [];
    s.on('segment', (x) => out.push(x));
    s.feed(tone(1, 300, R));
    expect(out).toHaveLength(0);
    s.flush();
    expect(out).toHaveLength(1);
  });

  it('raises its gate over steady room noise', () => {
    const noise = new Int16Array(R * 3);
    for (let i = 0; i < noise.length; i++) noise[i] = Math.round((Math.random() - 0.5) * 2 * 600); // ~ -38 dBFS hiss
    const speech = tone(1, 300, R, 0.4);
    const mixed = concatInt16([noise, speech, noise.slice(0, R * 1.5)]);
    const segs = run(mixed);
    expect(segs).toHaveLength(1);
  });
});
