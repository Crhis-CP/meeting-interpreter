import { describe, expect, it } from 'vitest';
import { floatToInt16, int16ToFloat, resampleLinear, rms, tone, concatInt16, int16ToBytes, bytesToInt16, bytesToBase64, base64ToBytes } from '@core/audio/pcm';
import { decodeWav, encodeWav, toMono } from '@core/audio/wav';
import { redact } from '@core/log';
import { lang, otherLanguage, baseOf } from '@core/lang/languages';
import { Emitter } from '@core/events';

describe('pcm', () => {
  it('round-trips int16 <-> float within 1 LSB', () => {
    const src = new Int16Array([0, 1, -1, 32767, -32768, 12345, -12345]);
    const back = floatToInt16(int16ToFloat(src));
    for (let i = 0; i < src.length; i++) expect(Math.abs(back[i]! - src[i]!)).toBeLessThanOrEqual(1);
  });

  it('resamples 48k to 16k keeping length and energy', () => {
    const t = int16ToFloat(tone(1, 440, 48000, 0.5));
    const out = resampleLinear(t, 48000, 16000);
    expect(out.length).toBe(16000);
    const e = (a: Float32Array) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length);
    expect(Math.abs(e(out) - e(t)) / e(t)).toBeLessThan(0.05);
  });

  it('computes rms and concatenates', () => {
    expect(rms(new Int16Array(100))).toBe(0);
    const c = concatInt16([new Int16Array([1, 2]), new Int16Array([3])]);
    expect([...c]).toEqual([1, 2, 3]);
  });

  it('converts little-endian bytes and base64', () => {
    const s = new Int16Array([1, -2, 300]);
    expect([...bytesToInt16(int16ToBytes(s))]).toEqual([1, -2, 300]);
    const b = new Uint8Array([0, 1, 2, 250, 255]);
    expect([...base64ToBytes(bytesToBase64(b))]).toEqual([...b]);
  });
});

describe('wav', () => {
  it('encodes and decodes identically', () => {
    const s = tone(0.1, 1000, 16000);
    const d = decodeWav(encodeWav(s, 16000));
    expect(d.sampleRate).toBe(16000);
    expect(d.channels).toBe(1);
    expect([...d.samples]).toEqual([...s]);
  });

  it('rejects non-RIFF data', () => {
    expect(() => decodeWav(new Uint8Array(64))).toThrow(/WAV/);
  });

  it('downmixes stereo', () => {
    expect([...toMono(new Int16Array([10, 20, -10, -30]), 2)]).toEqual([15, -20]);
  });
});

describe('redact', () => {
  it('masks credentials', () => {
    expect(redact('key sk-abc123xyz789 used')).not.toContain('abc123xyz789');
    expect(redact('Authorization: Bearer abcdef123456')).not.toContain('abcdef123456');
    expect(redact('url?api_key=zzzzzz111111&x=1')).not.toContain('zzzzzz111111');
    expect(redact('azure 0123456789abcdef0123456789abcdef')).not.toContain('0123456789abcdef0123456789abcdef');
    expect(redact('plain text 你好')).toBe('plain text 你好');
  });
});

describe('languages', () => {
  it('maps codes and pairs', () => {
    expect(otherLanguage('es-MX')).toBe('zh-CN');
    expect(otherLanguage('zh-CN', 'es-MX')).toBe('es-MX');
    expect(baseOf('es')).toBe('es');
    expect(lang('es-MX').codes.deeplTarget).toBe('ES-419');
    expect(() => lang('fr-FR')).toThrow();
  });
});

describe('emitter', () => {
  it('delivers events and isolates throwing listeners', () => {
    const e = new Emitter<{ a: number }>();
    const got: number[] = [];
    e.on('a', () => {
      throw new Error('boom');
    });
    const off = e.on('a', (n) => got.push(n));
    e.emit('a', 1);
    off();
    e.emit('a', 2);
    expect(got).toEqual([1]);
  });
});
