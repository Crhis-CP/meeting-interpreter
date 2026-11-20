import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { applyPreset } from '@core/config/presets';
import { defaultSettings } from '@core/config/schema';
import { concatInt16, silence, tone } from '@core/audio/pcm';
import { createLogger } from '@core/log';
import { MockAsr, MockLlm, MockTranslator, MockTts } from '@core/providers/mock';
import { decodeFrame, encodeAudioUp, encodeTtsFrame, ROOM_PROTOCOL_VERSION, type ServerMessage } from '@core/room/protocol';
import { SessionManager, type ProviderSet } from '../../src/main/session/session-manager';
import { RoomHost } from '../../src/main/room/room-host';
import type { ToAudio } from '../../src/shared/ipc';
import { waitFor } from '../helpers/fakes';

describe('room protocol', () => {
  it('round-trips audio and tts frames', () => {
    const pcm = new Int16Array([1, -2, 32767, -32768]);
    const up = decodeFrame(encodeAudioUp(pcm));
    expect(up).toEqual({ kind: 'audio', pcm });
    const down = decodeFrame(encodeTtsFrame('room-ab-1', 24000, pcm));
    expect(down).toEqual({ kind: 'tts', segmentId: 'room-ab-1', sampleRate: 24000, pcm });
    expect(decodeFrame(new Uint8Array([9]))).toBeNull();
  });
});

class Client {
  ws: WebSocket;
  msgs: ServerMessage[] = [];
  tts: string[] = [];
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const f = decodeFrame(new Uint8Array(data as Buffer));
        if (f?.kind === 'tts') this.tts.push(f.segmentId);
      } else this.msgs.push(JSON.parse(data.toString()));
    });
  }
  opened() {
    return new Promise<void>((r) => this.ws.once('open', () => r()));
  }
  send(o: object) {
    this.ws.send(JSON.stringify(o));
  }
}

describe('RoomHost', () => {
  it('relays a Chinese speaker to Spanish listeners and records the meeting', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mi-room-'));
    const staticDir = mkdtempSync(join(tmpdir(), 'mi-static-'));
    writeFileSync(join(staticDir, 'room.html'), '<!doctype html><title>room</title>');
    const settings = applyPreset(defaultSettings(), 'demo');
    settings.room.port = 0;
    const providers: ProviderSet = {
      asr: (d) => new MockAsr(d === 'out' ? 'self' : 'remote'),
      mt: () => new MockTranslator(),
      tts: () => new MockTts(),
      llm: () => new MockLlm(),
      describe: () => ({}),
    };
    const audio: ToAudio[] = [];
    const log = createLogger('test');
    const session = new SessionManager({ settings: () => settings, glossary: () => [], providers: () => providers, recordsDir: () => dir, toAudio: (m) => audio.push(m), broadcast: () => {}, log });
    const room = new RoomHost({ settings: () => settings, session, providers: () => providers as never, glossary: () => [], toAudio: (m) => audio.push(m), broadcast: () => {}, log, dataDir: dir, staticDir: () => staticDir, devUrl: () => undefined, insecure: true });

    const st = await room.start();
    expect(st.active).toBe(true);
    const url = new URL(st.urls[0]!);
    const token = url.searchParams.get('t')!;
    const base = `ws://127.0.0.1:${url.port}/ws`;

    // Static page is served.
    const page = await fetch(`http://127.0.0.1:${url.port}/?t=${token}`);
    expect(await page.text()).toContain('room');
    expect((await fetch(`http://127.0.0.1:${url.port}/../../etc/passwd`)).status).toBe(404);

    // A bad token is refused.
    const bad = new Client(base);
    await bad.opened();
    bad.send({ t: 'join', name: 'x', lang: 'zh-CN', token: 'nope', v: ROOM_PROTOCOL_VERSION });
    await waitFor(() => bad.msgs.some((m) => m.t === 'error'));

    const zh = new Client(base);
    const es = new Client(base);
    await Promise.all([zh.opened(), es.opened()]);
    zh.send({ t: 'join', name: '王经理', lang: 'zh-CN', token, v: ROOM_PROTOCOL_VERSION });
    es.send({ t: 'join', name: 'Carlos', lang: 'es-MX', token, v: ROOM_PROTOCOL_VERSION });
    await waitFor(() => zh.msgs.some((m) => m.t === 'welcome') && es.msgs.some((m) => m.t === 'welcome'));
    await waitFor(() => (room as any).participants.size === 2);

    zh.send({ t: 'talk', on: true });
    const speech = concatInt16([tone(1, 300, 16000), silence(1, 16000)]);
    for (let i = 0; i < speech.length; i += 1600) zh.ws.send(encodeAudioUp(speech.slice(i, i + 1600)));

    await waitFor(() => es.msgs.some((m) => m.t === 'segment' && m.seg.status === 'done' && m.seg.speaker === '王经理'), 5000);
    await waitFor(() => es.tts.length > 0, 5000);
    expect(zh.tts).toHaveLength(0); // the speaker does not hear their own translation
    const seg = es.msgs.find((m): m is Extract<ServerMessage, { t: 'segment' }> => m.t === 'segment' && m.seg.status === 'done')!.seg;
    expect(seg.dstLang).toBe('es-MX'); // the room's Spanish variant
    expect(seg.dstText).toMatch(/[a-z]/i);

    // A Spanish speaker reaches the Chinese phone and the host computer.
    es.send({ t: 'talk', on: true });
    for (let i = 0; i < speech.length; i += 1600) es.ws.send(encodeAudioUp(speech.slice(i, i + 1600)));
    await waitFor(() => zh.tts.length > 0, 5000);
    expect(audio.some((m) => m.type === 'tts' && m.dir === 'in')).toBe(true);

    await room.stop();
    expect(session.active).toBe(false);
    expect(es.msgs.some((m) => m.t === 'ended')).toBe(true);
  });
});
