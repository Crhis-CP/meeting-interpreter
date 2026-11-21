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
import { decodeFrame, encodeAudioUp, encodeTtsFrame, encodeUp, ROOM_PROTOCOL_VERSION, type ServerMessage } from '@core/room/protocol';
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

  it('survives malformed requests and reports provider errors to the phone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mi-room2-'));
    const staticDir = mkdtempSync(join(tmpdir(), 'mi-static2-'));
    writeFileSync(join(staticDir, 'room.html'), 'ok');
    const settings = applyPreset(defaultSettings(), 'demo');
    settings.room.port = 0;
    const log = createLogger('test');
    let broken = false;
    const providers = {
      asr: () => { if (broken) throw new Error('未填写 Key'); return new MockAsr(); },
      mt: () => new MockTranslator(),
      tts: () => new MockTts(),
      llm: () => null,
      describe: () => ({}),
    } as ProviderSet;
    const session = new SessionManager({ settings: () => settings, glossary: () => [], providers: () => providers, recordsDir: () => dir, toAudio: () => {}, broadcast: () => {}, log });
    const room = new RoomHost({ settings: () => settings, session, providers: () => providers as never, glossary: () => [], toAudio: () => {}, broadcast: () => {}, log, dataDir: dir, staticDir: () => staticDir, devUrl: () => undefined, insecure: true });
    const st = await room.start();
    const url = new URL(st.urls[0]!);
    const token = url.searchParams.get('t')!;
    expect((await fetch(`http://127.0.0.1:${url.port}/%E0%A4%A`)).status).toBe(400);
    const c = new Client(`ws://127.0.0.1:${url.port}/ws`);
    await c.opened();
    c.ws.send('null');
    c.ws.send('{"t":5}');
    c.send({ t: 'join', name: { evil: true }, lang: 7, token, v: ROOM_PROTOCOL_VERSION });
    await waitFor(() => c.msgs.some((m) => m.t === 'welcome'));
    broken = true;
    c.send({ t: 'talk', on: true });
    await waitFor(() => c.msgs.some((m) => m.t === 'error' && /翻译服务/.test(m.message)));
    expect(room.active).toBe(true);
    await room.stop();
  });
});


describe('room limits', () => {
  const setup = async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mi-room-lim-'));
    const staticDir = mkdtempSync(join(tmpdir(), 'mi-static-'));
    writeFileSync(join(staticDir, 'room.html'), '<!doctype html><title>room</title>');
    const settings = applyPreset(defaultSettings(), 'demo');
    settings.room.port = 0;
    const providers: ProviderSet = { asr: () => new MockAsr('self'), mt: () => new MockTranslator(), tts: () => new MockTts(), llm: () => null, describe: () => ({}) } as ProviderSet;
    const log = createLogger('test');
    const session = new SessionManager({ settings: () => settings, glossary: () => [], providers: () => providers, recordsDir: () => dir, toAudio: () => {}, broadcast: () => {}, log });
    const room = new RoomHost({ settings: () => settings, session, providers: () => providers as never, glossary: () => [], toAudio: () => {}, broadcast: () => {}, log, dataDir: dir, staticDir: () => staticDir, devUrl: () => undefined, insecure: true, limits: { participants: 3, talkers: 1, badJoins: 3 } });
    const st = await room.start();
    const url = new URL(st.urls[0]!);
    return { room, session, port: url.port, token: url.searchParams.get('t')! };
  };
  const joinRoom = async (port: string, token: string, name: string) => {
    const c = new Client(`ws://127.0.0.1:${port}/ws`);
    await c.opened();
    c.send({ t: 'join', name, lang: 'zh-CN', token, v: ROOM_PROTOCOL_VERSION });
    await waitFor(() => c.msgs.some((m) => m.t === 'welcome' || m.t === 'error'));
    return c;
  };

  it('uses a long random link token', async () => {
    const { room, token } = await setup();
    expect(token.length).toBeGreaterThanOrEqual(22);
    await room.stop();
  });

  it('caps participants and people talking at once', async () => {
    const { room, port, token } = await setup();
    const a = await joinRoom(port, token, 'a');
    const b = await joinRoom(port, token, 'b');
    await joinRoom(port, token, 'c');
    const d = await joinRoom(port, token, 'd');
    expect(d.msgs.some((m) => m.t === 'error' && /人数已满/.test(m.message))).toBe(true);
    a.send({ t: 'talk', on: true });
    await waitFor(() => a.msgs.some((m) => m.t === 'peers' && m.peers.some((p) => p.name === 'a' && p.talking)));
    b.send({ t: 'talk', on: true });
    await waitFor(() => b.msgs.some((m) => m.t === 'error' && /同时说话/.test(m.message)));
    await room.stop();
  });

  it('locks out a client that keeps guessing the link', async () => {
    const { room, port, token } = await setup();
    for (let i = 0; i < 3; i++) await joinRoom(port, 'wrong', 'x');
    const c = await joinRoom(port, token, 'late');
    expect(c.msgs.some((m) => m.t === 'error' && /尝试次数过多/.test(m.message))).toBe(true);
    await room.stop();
  });

  it('will not open a room while an online meeting is being interpreted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mi-room-busy-'));
    const settings = applyPreset(defaultSettings(), 'demo');
    settings.room.port = 0;
    const providers = { asr: () => new MockAsr('self'), mt: () => new MockTranslator(), tts: () => new MockTts(), llm: () => null, describe: () => ({}) } as ProviderSet;
    const log = createLogger('test');
    const session = new SessionManager({ settings: () => settings, glossary: () => [], providers: () => providers, recordsDir: () => dir, toAudio: () => {}, broadcast: () => {}, log });
    await session.start({ mode: 'meeting' });
    const room = new RoomHost({ settings: () => settings, session, providers: () => providers as never, glossary: () => [], toAudio: () => {}, broadcast: () => {}, log, dataDir: dir, staticDir: () => dir, devUrl: () => undefined, insecure: true });
    await expect(room.start()).rejects.toThrow(/线上会议/);
    await session.stop();
  });
});

describe('room resources', () => {
  it('gives back a quiet participant’s pipeline and makes a new one when they talk again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mi-room-idle-'));
    const staticDir = mkdtempSync(join(tmpdir(), 'mi-static-'));
    writeFileSync(join(staticDir, 'room.html'), 'ok');
    const settings = applyPreset(defaultSettings(), 'demo');
    settings.room.port = 0;
    const providers = { asr: () => new MockAsr('self'), mt: () => new MockTranslator(), tts: () => new MockTts(), llm: () => null, describe: () => ({}) } as ProviderSet;
    const log = createLogger('test');
    const session = new SessionManager({ settings: () => settings, glossary: () => [], providers: () => providers, recordsDir: () => dir, toAudio: () => {}, broadcast: () => {}, log });
    const room = new RoomHost({ settings: () => settings, session, providers: () => providers as never, glossary: () => [], toAudio: () => {}, broadcast: () => {}, log, dataDir: dir, staticDir: () => staticDir, devUrl: () => undefined, insecure: true, limits: { idlePipelineMs: 50 } });
    const st = await room.start();
    const url = new URL(st.urls[0]!);
    const c = new Client(`ws://127.0.0.1:${url.port}/ws`);
    await c.opened();
    c.send({ t: 'join', name: 'a', lang: 'zh-CN', token: url.searchParams.get('t'), v: ROOM_PROTOCOL_VERSION });
    await waitFor(() => c.msgs.some((m) => m.t === 'welcome'));
    const me = () => [...((room as any).participants as Map<string, { id: string; pipeline: unknown }>).values()][0]!;
    const prefix = () => (me().pipeline as { o: { idPrefix: string } }).o.idPrefix;
    c.send({ t: 'talk', on: true });
    await waitFor(() => !!me().pipeline);
    const first = prefix();
    c.send({ t: 'talk', on: false });
    await waitFor(() => me().pipeline === null);
    c.send({ t: 'talk', on: true });
    await waitFor(() => !!me().pipeline);
    // The new pipeline numbers its sentences apart, so it never replaces the earlier ones.
    expect(first).toBe(`room-${me().id}`);
    expect(prefix()).toBe(`room-${me().id}.2`);
    await room.stop();
  });
});

describe('closing the room', () => {
  it('finishes at once even when a phone is locked (never answers the close handshake)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mi-room-stop-'));
    const staticDir = mkdtempSync(join(tmpdir(), 'mi-static-'));
    writeFileSync(join(staticDir, 'room.html'), 'ok');
    const settings = applyPreset(defaultSettings(), 'demo');
    settings.room.port = 0;
    const providers = { asr: () => new MockAsr('self'), mt: () => new MockTranslator(), tts: () => new MockTts(), llm: () => null, describe: () => ({}) } as ProviderSet;
    const log = createLogger('test');
    const session = new SessionManager({ settings: () => settings, glossary: () => [], providers: () => providers, recordsDir: () => dir, toAudio: () => {}, broadcast: () => {}, log });
    const room = new RoomHost({ settings: () => settings, session, providers: () => providers as never, glossary: () => [], toAudio: () => {}, broadcast: () => {}, log, dataDir: dir, staticDir: () => staticDir, devUrl: () => undefined, insecure: true });
    const st = await room.start();
    const url = new URL(st.urls[0]!);
    const c = new Client(`ws://127.0.0.1:${url.port}/ws`);
    await c.opened();
    c.send({ t: 'join', name: 'a', lang: 'zh-CN', token: url.searchParams.get('t'), v: ROOM_PROTOCOL_VERSION });
    await waitFor(() => c.msgs.some((m) => m.t === 'welcome'));
    (c as unknown as { ws: { _socket: { pause(): void } } }).ws._socket.pause(); // the phone sleeps
    const t0 = Date.now();
    await room.stop();
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(session.active).toBe(false);
  });
});

/** A phone on the plain-HTTPS fallback: event stream down, ordered POSTs up. */
class HttpClient {
  msgs: ServerMessage[] = [];
  tts: string[] = [];
  sid = '';
  ended = false;
  private ctrl = new AbortController();
  constructor(private readonly base: string) {}
  async open(token: string): Promise<number> {
    const r = await fetch(`${this.base}/rt/open?t=${encodeURIComponent(token)}`, { method: 'POST' });
    if (!r.ok) return r.status;
    this.sid = ((await r.json()) as { sid: string }).sid;
    const down = await fetch(`${this.base}/rt/down?sid=${this.sid}`, { signal: this.ctrl.signal });
    void (async () => {
      const reader = down.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
            this.event(buf.slice(0, i));
            buf = buf.slice(i + 2);
          }
        }
      } catch {
        /* aborted */
      }
      this.ended = true;
    })();
    return 200;
  }
  private event(ev: string): void {
    let type = 'message';
    let data = '';
    for (const line of ev.split('\n')) {
      if (line.startsWith('event: ')) type = line.slice(7);
      else if (line.startsWith('data: ')) data += line.slice(6);
    }
    if (!data) return;
    if (type === 'b') {
      const f = decodeFrame(new Uint8Array(Buffer.from(data, 'base64')));
      if (f?.kind === 'tts') this.tts.push(f.segmentId);
    } else this.msgs.push(JSON.parse(data) as ServerMessage);
  }
  async up(items: (object | Uint8Array)[]): Promise<number> {
    const enc = new TextEncoder();
    const body = encodeUp(items.map((i) => (i instanceof Uint8Array ? { binary: true, data: i } : { binary: false, data: enc.encode(JSON.stringify(i)) })));
    return (await fetch(`${this.base}/rt/up?sid=${this.sid}`, { method: 'POST', body })).status;
  }
  close(): void {
    this.ctrl.abort();
  }
}

describe('room without WebSocket (Safari on iPhone refuses wss:// to the self-signed certificate)', () => {
  it('a phone joins, talks and listens over plain HTTPS, next to a WebSocket phone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mi-room-http-'));
    const staticDir = mkdtempSync(join(tmpdir(), 'mi-static-'));
    writeFileSync(join(staticDir, 'room.html'), 'ok');
    const settings = applyPreset(defaultSettings(), 'demo');
    settings.room.port = 0;
    const providers: ProviderSet = { asr: (d) => new MockAsr(d === 'out' ? 'self' : 'remote'), mt: () => new MockTranslator(), tts: () => new MockTts(), llm: () => null, describe: () => ({}) } as ProviderSet;
    const log = createLogger('test');
    const session = new SessionManager({ settings: () => settings, glossary: () => [], providers: () => providers, recordsDir: () => dir, toAudio: () => {}, broadcast: () => {}, log });
    const room = new RoomHost({ settings: () => settings, session, providers: () => providers as never, glossary: () => [], toAudio: () => {}, broadcast: () => {}, log, dataDir: dir, staticDir: () => staticDir, devUrl: () => undefined, insecure: true });
    const st = await room.start();
    const url = new URL(st.urls[0]!);
    const token = url.searchParams.get('t')!;
    const base = `http://127.0.0.1:${url.port}`;

    // Without the room link's token there is no connection at all; unknown sessions are gone.
    expect(await new HttpClient(base).open('guess')).toBe(403);
    expect((await fetch(`${base}/rt/up?sid=nope`, { method: 'POST', body: new Uint8Array(1) })).status).toBe(404);

    const iphone = new HttpClient(base);
    expect(await iphone.open(token)).toBe(200);
    expect(await iphone.up([{ t: 'join', name: '王经理', lang: 'zh-CN', token, v: ROOM_PROTOCOL_VERSION }])).toBe(204);
    const es = new Client(`ws://127.0.0.1:${url.port}/ws`);
    await es.opened();
    es.send({ t: 'join', name: 'Carlos', lang: 'es-AR', token, v: ROOM_PROTOCOL_VERSION });
    await waitFor(() => iphone.msgs.some((m) => m.t === 'welcome') && es.msgs.some((m) => m.t === 'welcome'));
    expect(await iphone.up([new Uint8Array([7, 7, 7])])).toBe(204); // not a frame: ignored
    expect((await fetch(`${base}/rt/up?sid=${iphone.sid}`, { method: 'POST', body: new Uint8Array([9, 0, 0]) })).status).toBe(400);

    // Talking: the "talk" message and the audio go up together, in order, in a few POSTs.
    const speech = concatInt16([tone(1, 300, 16000), silence(1, 16000)]);
    const frames = [] as Uint8Array[];
    for (let i = 0; i < speech.length; i += 1600) frames.push(new Uint8Array(encodeAudioUp(speech.slice(i, i + 1600))));
    await iphone.up([{ t: 'talk', on: true }, ...frames.slice(0, 10)]);
    await iphone.up(frames.slice(10));
    await waitFor(() => es.msgs.some((m) => m.t === 'segment' && m.seg.status === 'done' && m.seg.speaker === '王经理'), 5000);

    // Listening: translated speech comes down the event stream.
    es.send({ t: 'talk', on: true });
    for (const f of frames) es.ws.send(f);
    await waitFor(() => iphone.tts.length > 0, 5000);

    await room.stop();
    await waitFor(() => iphone.ended);
    expect(iphone.msgs.some((m) => m.t === 'ended')).toBe(true);
    iphone.close();
  });
});
