import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createProviders } from '@core/providers/registry';
import { headerRule, wrapBrowserWs } from '../src/browser-context';
import { DEFAULT_SETTINGS, MEETING_SITES, toAppSettings, withDefaults } from '../src/shared';

const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8')) as {
  manifest_version: number;
  permissions: string[];
  content_scripts: { matches: string[]; js: string[]; world?: string; run_at: string }[];
  icons: Record<string, string>;
};

describe('manifest', () => {
  it('injects both content scripts on exactly the meeting sites', () => {
    expect(manifest.manifest_version).toBe(3);
    for (const cs of manifest.content_scripts) {
      expect(cs.matches).toEqual(MEETING_SITES);
      expect(cs.run_at).toBe('document_start');
    }
    expect(manifest.content_scripts.find((c) => c.js.includes('page-mic.js'))?.world).toBe('MAIN');
  });

  it('references icon files that exist', () => {
    for (const f of Object.values(manifest.icons)) expect(() => readFileSync(new URL(`../public/${f}`, import.meta.url))).not.toThrow();
  });
});

describe('settings', () => {
  it('fills in provider presets', () => {
    const s = withDefaults({ providers: 'azure', remote: 'en-US' });
    expect(s.out).toMatchObject({ asr: 'azure', mt: 'azure-translator', tts: 'azure' });
    expect(withDefaults(undefined)).toEqual(DEFAULT_SETTINGS);
    const custom = withDefaults({ providers: 'custom', out: { asr: 'dashscope', mt: 'llm', tts: 'none', voice: '' } });
    expect(custom.out.mt).toBe('llm');
  });

  it('the free voices are the desktop app’s natural voices; settings from before 0.9 move over, keeping 男声', () => {
    expect(withDefaults({ providers: 'free' }).out.tts).toBe('local');
    const old = withDefaults({ providers: 'custom', out: { asr: 'local', mt: 'local-ai', tts: 'system', voice: 'male' }, in: { asr: 'local', mt: 'local-ai', tts: 'system', voice: 'Microsoft Helena' } });
    expect(old.out).toMatchObject({ tts: 'local', voice: 'male' });
    expect(old.in).toMatchObject({ tts: 'local', voice: '' });
    const app = toAppSettings(withDefaults({ providers: 'custom', out: { asr: 'local', mt: 'local-ai', tts: 'local', voice: 'male' } }));
    expect(app.out).toMatchObject({ tts: 'local', voice: 'male' });
  });

  it('maps to engine settings that build providers', () => {
    const app = toAppSettings(withDefaults({ providers: 'dashscope', remote: 'en-GB' }));
    expect(app.languages).toEqual({ self: 'zh-CN', remote: 'en-GB' });
    const ctx = { fetch, openWebSocket: () => { throw new Error('no'); }, log: console as never, now: Date.now };
    expect(() => createProviders(app, {}, ctx as never, () => []).asr('out')).toThrow(/百炼/);
    expect(() => createProviders(app, { dashscope: 'sk-x' }, ctx as never, () => []).asr('out')).not.toThrow();
  });
});

describe('websocket headers', () => {
  it('adds handshake headers only to the extension’s own requests to that endpoint', () => {
    const r = headerRule(5, 'wss://dashscope.aliyuncs.com/api-ws/v1/inference?x=1', { Authorization: 'bearer sk-1' });
    expect(r.condition).toMatchObject({ urlFilter: '|wss://dashscope.aliyuncs.com/api-ws/v1/inference', resourceTypes: ['websocket'], tabIds: [-1] });
    expect(r.action.requestHeaders).toEqual([{ header: 'Authorization', operation: 'set', value: 'bearer sk-1' }]);
  });

  it('opens the socket only after the headers are in place, and reports failures', async () => {
    const opened: string[] = [];
    (globalThis as { WebSocket?: unknown }).WebSocket = class {
      readyState = 0;
      binaryType = '';
      constructor(url: string) {
        opened.push(url);
      }
      close() {}
    };
    let release!: () => void;
    wrapBrowserWs('wss://a/b', { headers: { Authorization: 'x', 'User-Agent': 'y' } }, (_u, h) => {
      expect(h).toEqual({ Authorization: 'x' });
      return new Promise<void>((r) => (release = r));
    });
    await Promise.resolve();
    expect(opened).toEqual([]);
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(opened).toEqual(['wss://a/b']);

    const errors: string[] = [];
    const ws = wrapBrowserWs('wss://c', { headers: { A: '1' } }, async () => {
      throw new Error('rule failed');
    });
    ws.onerror = (e) => errors.push(e.message);
    await new Promise((r) => setTimeout(r, 0));
    expect(errors).toEqual(['rule failed']);
    expect(ws.readyState).toBe(3);
  });
});
