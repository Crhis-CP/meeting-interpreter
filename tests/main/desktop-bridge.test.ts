import { afterEach, describe, expect, it } from 'vitest';
import { Emitter } from '../../src/core/events';
import { DesktopBridgeAsr, DesktopBridgeTts, pingDesktop } from '../../src/core/bridge/desktop';
import { collectPcm, type AsrEvents, type AsrSession, type StreamingAsr, type Tts } from '../../src/core/providers/types';
import { createLogger } from '../../src/core/log';
import { DesktopBridge } from '../../src/main/bridge/desktop-bridge';
import { createNodeContext, wrapWs } from '../../src/main/platform/node-context';

const log = createLogger('test');
const PORT = 47911;
const base = `127.0.0.1:${PORT}`;

class EchoSession implements AsrSession {
  events = new Emitter<AsrEvents>();
  samples = 0;
  push(pcm: Int16Array) {
    this.samples += pcm.length;
    if (this.samples >= 1600) {
      this.events.emit('final', { text: `听到 ${this.samples} 个采样` });
      this.samples = 0;
    }
  }
  async end() {
    this.events.emit('closed', {});
  }
  close() {}
}

const asr: StreamingAsr = { id: 'echo', start: async (o) => (o.lang === 'zh-CN' ? new EchoSession() : Promise.reject(new Error('no model'))) };
const tts: Tts = {
  id: 'tone',
  async *synthesize(req) {
    yield { samples: new Int16Array(req.text.length * 10).fill(100), sampleRate: 22050 };
  },
  voices: () => [{ id: 'v1', name: 'Voice 1', lang: 'zh-CN' }],
};

let bridge: DesktopBridge | null = null;
afterEach(async () => {
  await bridge?.stop();
  bridge = null;
});

async function startBridge(enabled = true) {
  bridge = new DesktopBridge(
    { version: '9.9.9', log, enabled: () => enabled, asr: () => asr, tts: () => tts, modelsReady: () => true, ensureModels: async () => undefined },
    PORT,
  );
  await bridge.start();
}

describe('desktop bridge', () => {
  it('answers pings and synthesises speech for the extension', async () => {
    await startBridge();
    const ctx = createNodeContext(log);
    expect(await pingDesktop(ctx, base)).toMatchObject({ app: 'meeting-interpreter', version: '9.9.9', models: { zh: true } });
    const pcm = await collectPcm(new DesktopBridgeTts(ctx, base).synthesize({ text: '你好', lang: 'zh-CN', rate: 1 }));
    expect(pcm.sampleRate).toBe(22050);
    expect(pcm.samples.length).toBe(20);
  });

  it('streams recognition over a WebSocket', async () => {
    await startBridge();
    const session = await new DesktopBridgeAsr(createNodeContext(log), base).start({ lang: 'zh-CN', hotwords: ['星云平台'], sampleRate: 16000 });
    const finals: string[] = [];
    session.events.on('final', ({ text }) => finals.push(text));
    session.push(new Int16Array(1600));
    await expect.poll(() => finals).toEqual(['听到 1600 个采样']);
    await session.end();
  });

  it('reports recogniser failures before the session is ready', async () => {
    await startBridge();
    await expect(new DesktopBridgeAsr(createNodeContext(log), base).start({ lang: 'es-MX', hotwords: [], sampleRate: 16000 })).rejects.toThrow(/no model/);
  });

  it('refuses web pages', async () => {
    await startBridge();
    const res = await fetch(`http://${base}/ping`, { headers: { Origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
    const ok = await fetch(`http://${base}/ping`, { headers: { Origin: 'chrome-extension://abc' } });
    expect(ok.headers.get('access-control-allow-origin')).toBe('chrome-extension://abc');
    const closed = await new Promise<string>((resolve) => {
      const ws = wrapWs(`ws://${base}/asr?lang=zh-CN`, { headers: { Origin: 'https://evil.example' } });
      ws.onerror = (e) => resolve(e.message);
      ws.onopen = () => resolve('opened');
    });
    expect(closed).toMatch(/403/);
  });

  it('says clearly when the desktop app is not running or the bridge is off', async () => {
    await expect(new DesktopBridgeAsr(createNodeContext(log), '127.0.0.1:1').start({ lang: 'zh-CN', hotwords: [], sampleRate: 16000 })).rejects.toThrow(/桌面客户端/);
    await startBridge(false);
    expect(await pingDesktop(createNodeContext(log), base)).toBeNull();
  });
});

describe('desktop bridge: only this computer, by its own address', () => {
  it('refuses a DNS-rebinding host name', async () => {
    const { DesktopBridge } = await import('../../src/main/bridge/desktop-bridge');
    const { createLogger } = await import('@core/log');
    const bridge = new DesktopBridge({ version: '1', log: createLogger('t'), enabled: () => true, asr: () => { throw new Error('x'); }, tts: () => ({ id: 't', voices: () => [], async *synthesize() {} }), modelsReady: () => true, ensureModels: async () => {} }, 0);
    await bridge.start();
    const port = ((bridge as unknown as { server: import('node:http').Server }).server.address() as import('node:net').AddressInfo).port;
    const http = await import('node:http');
    const get = (host: string) =>
      new Promise<number>((resolve) => http.get({ host: '127.0.0.1', port, path: '/ping', headers: { Host: host } }, (r) => resolve(r.statusCode ?? 0)).on('error', () => resolve(-1)));
    expect(await get(`127.0.0.1:${port}`)).toBe(200);
    expect(await get(`localhost:${port}`)).toBe(200);
    expect(await get(`evil.example.com:${port}`)).toBe(403);
    expect(await get('127.0.0.1')).toBe(403);
    await bridge.stop();
  });
});
