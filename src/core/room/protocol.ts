import type { TranscriptSegment } from '../types';

/** Wire protocol between the desktop room host and phone browsers. */
export const ROOM_PROTOCOL_VERSION = 1;

export interface RoomPeer {
  id: string;
  name: string;
  lang: string;
  talking: boolean;
  host?: boolean;
}

export interface RoomInfo {
  title: string;
  languages: { code: string; name: string }[];
}

export type ClientMessage =
  | { t: 'join'; name: string; lang: string; token: string; v: number; clientId?: string }
  | { t: 'talk'; on: boolean }
  | { t: 'ping' };

export type ServerMessage =
  | { t: 'welcome'; id: string; room: RoomInfo; history: TranscriptSegment[] }
  | { t: 'peers'; peers: RoomPeer[] }
  | { t: 'partial'; from: string; name: string; text: string }
  | { t: 'segment'; seg: TranscriptSegment }
  | { t: 'audioEnd'; segmentId: string }
  | { t: 'flush' }
  | { t: 'error'; message: string; fatal?: boolean }
  | { t: 'pong' }
  | { t: 'ended' };

const AUDIO_UP = 0x01;
const TTS_DOWN = 0x02;

/** Phone → host microphone frame: [0x01][Int16 LE PCM, 16 kHz mono]. */
export function encodeAudioUp(pcm: Int16Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(1 + pcm.length * 2);
  out[0] = AUDIO_UP;
  const v = new DataView(out.buffer);
  for (let i = 0; i < pcm.length; i++) v.setInt16(1 + i * 2, pcm[i]!, true);
  return out;
}

/** Host → phone speech frame: [0x02][u16 id length][id UTF-8][u32 sample rate][Int16 LE PCM]. */
export function encodeTtsFrame(segmentId: string, sampleRate: number, pcm: Int16Array): Uint8Array<ArrayBuffer> {
  const id = new TextEncoder().encode(segmentId);
  const out = new Uint8Array(1 + 2 + id.length + 4 + pcm.length * 2);
  const v = new DataView(out.buffer);
  out[0] = TTS_DOWN;
  v.setUint16(1, id.length, true);
  out.set(id, 3);
  v.setUint32(3 + id.length, sampleRate, true);
  const off = 7 + id.length;
  for (let i = 0; i < pcm.length; i++) v.setInt16(off + i * 2, pcm[i]!, true);
  return out;
}

export type DecodedFrame =
  | { kind: 'audio'; pcm: Int16Array }
  | { kind: 'tts'; segmentId: string; sampleRate: number; pcm: Int16Array };

export function decodeFrame(data: Uint8Array): DecodedFrame | null {
  if (data.length < 1) return null;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const readPcm = (off: number) => {
    const n = Math.floor((data.length - off) / 2);
    const pcm = new Int16Array(n);
    for (let i = 0; i < n; i++) pcm[i] = v.getInt16(off + i * 2, true);
    return pcm;
  };
  if (data[0] === AUDIO_UP) return { kind: 'audio', pcm: readPcm(1) };
  if (data[0] === TTS_DOWN && data.length >= 7) {
    const idLen = v.getUint16(1, true);
    if (data.length < 7 + idLen) return null;
    const segmentId = new TextDecoder().decode(data.subarray(3, 3 + idLen));
    const sampleRate = v.getUint32(3 + idLen, true);
    return { kind: 'tts', segmentId, sampleRate, pcm: readPcm(7 + idLen) };
  }
  return null;
}
