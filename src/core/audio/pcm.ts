/** PCM helpers shared by the engine (Node) and the audio window (browser). */

export const ASR_RATE = 16000;

export function floatToInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]!));
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

export function int16ToFloat(input: Int16Array): Float32Array {
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = input[i]!;
    out[i] = s < 0 ? s / 0x8000 : s / 0x7fff;
  }
  return out;
}

/**
 * Resamples with linear interpolation after a simple moving-average low-pass when downsampling.
 * Good enough for speech recognition input; not meant for music.
 */
export function resampleLinear(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to || input.length === 0) return input.slice();
  let src = input;
  if (to < from) {
    // Crude anti-alias: average over the decimation window.
    const win = Math.max(1, Math.floor(from / to));
    if (win > 1) {
      src = new Float32Array(input.length);
      let acc = 0;
      for (let i = 0; i < input.length; i++) {
        acc += input[i]!;
        if (i >= win) acc -= input[i - win]!;
        src[i] = acc / Math.min(i + 1, win);
      }
    }
  }
  const outLen = Math.max(1, Math.round((src.length * to) / from));
  const out = new Float32Array(outLen);
  const ratio = from / to;
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, src.length - 1);
    const frac = pos - i0;
    out[i] = src[Math.min(i0, src.length - 1)]! * (1 - frac) + src[i1]! * frac;
  }
  return out;
}

export function resampleInt16(input: Int16Array, from: number, to: number): Int16Array {
  if (from === to) return input.slice();
  return floatToInt16(resampleLinear(int16ToFloat(input), from, to));
}

/** Root-mean-square level in 0..1. */
export function rms(input: Int16Array, start = 0, end = input.length): number {
  if (end <= start) return 0;
  let sum = 0;
  for (let i = start; i < end; i++) {
    const s = input[i]!;
    sum += s * s;
  }
  return Math.sqrt(sum / (end - start)) / 32768;
}

/** Level in dBFS (−100 for silence). */
export function dbfs(level: number): number {
  return level <= 1e-5 ? -100 : 20 * Math.log10(level);
}

export function concatInt16(chunks: Int16Array[]): Int16Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Int16Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** Copies the PCM samples into a little-endian byte array (Int16Array is platform-endian). */
export function int16ToBytes(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i]!, true);
  return out;
}

export function bytesToInt16(bytes: Uint8Array): Int16Array {
  const n = Math.floor(bytes.byteLength / 2);
  const out = new Int16Array(n);
  const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}

/** A sine tone, for tests, the demo voice and the device "test sound". */
export function tone(seconds: number, freq: number, sampleRate: number, amplitude = 0.3): Int16Array {
  const n = Math.round(seconds * sampleRate);
  const out = new Int16Array(n);
  const fade = Math.min(n / 2, Math.round(0.01 * sampleRate));
  for (let i = 0; i < n; i++) {
    let a = amplitude;
    if (i < fade) a *= i / fade;
    else if (i > n - fade) a *= (n - i) / fade;
    out[i] = Math.round(Math.sin((2 * Math.PI * freq * i) / sampleRate) * a * 32767);
  }
  return out;
}

export function silence(seconds: number, sampleRate: number): Int16Array {
  return new Int16Array(Math.round(seconds * sampleRate));
}

/** Base64 helpers that work without Buffer. */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
