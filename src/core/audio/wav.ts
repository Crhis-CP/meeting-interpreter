import { bytesToInt16, int16ToBytes } from './pcm';

/** A 44-byte canonical PCM WAV header for 16-bit samples. */
export function wavHeader(dataBytes: number, sampleRate: number, channels = 1): Uint8Array {
  const header = new Uint8Array(44);
  const v = new DataView(header.buffer);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) header[off + i] = s.charCodeAt(i);
  };
  writeStr(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * channels * 2, true);
  v.setUint16(32, channels * 2, true);
  v.setUint16(34, 16, true);
  writeStr(36, 'data');
  v.setUint32(40, dataBytes, true);
  return header;
}

export function encodeWav(samples: Int16Array, sampleRate: number, channels = 1): Uint8Array {
  const data = int16ToBytes(samples);
  const out = new Uint8Array(44 + data.length);
  out.set(wavHeader(data.length, sampleRate, channels), 0);
  out.set(data, 44);
  return out;
}

export interface DecodedWav {
  samples: Int16Array;
  sampleRate: number;
  channels: number;
}

/** Decodes 16-bit PCM WAV (any chunk order). Multi-channel audio is returned interleaved. */
export function decodeWav(bytes: Uint8Array): DecodedWav {
  if (bytes.length < 12) throw new Error('不是有效的 WAV 文件（太短）');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (off: number) => String.fromCharCode(bytes[off]!, bytes[off + 1]!, bytes[off + 2]!, bytes[off + 3]!);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('不是有效的 WAV 文件（缺少 RIFF/WAVE 标记）');
  let off = 12;
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  let format = 0;
  let data: Uint8Array | null = null;
  while (off + 8 <= bytes.length) {
    const id = tag(off);
    let size = v.getUint32(off + 4, true);
    const body = off + 8;
    if (body + size > bytes.length) size = bytes.length - body; // tolerate truncated files (crash mid-write)
    if (id === 'fmt ') {
      format = v.getUint16(body, true);
      channels = v.getUint16(body + 2, true);
      sampleRate = v.getUint32(body + 4, true);
      bits = v.getUint16(body + 14, true);
    } else if (id === 'data') {
      data = bytes.subarray(body, body + size);
    }
    off = body + size + (size % 2);
  }
  if (!data || !sampleRate) throw new Error('WAV 文件缺少 fmt 或 data 块');
  if (format !== 1 && format !== 0xfffe) throw new Error(`不支持的 WAV 编码：${format}（只支持 PCM）`);
  if (bits !== 16) throw new Error(`不支持 ${bits} 位 WAV（只支持 16 位）`);
  return { samples: bytesToInt16(data), sampleRate, channels };
}

/** Averages interleaved channels down to mono. */
export function toMono(samples: Int16Array, channels: number): Int16Array {
  if (channels <= 1) return samples;
  const n = Math.floor(samples.length / channels);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += samples[i * channels + c]!;
    out[i] = Math.round(sum / channels);
  }
  return out;
}
