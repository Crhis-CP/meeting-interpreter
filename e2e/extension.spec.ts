import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { Emitter } from '../src/core/events';
import { createLogger } from '../src/core/log';
import type { AsrEvents, AsrSession } from '../src/core/providers/types';
import { DesktopBridge } from '../src/main/bridge/desktop-bridge';
import { concatInt16, silence, tone } from '../src/core/audio/pcm';
import { encodeWav } from '../src/core/audio/wav';

/**
 * Loads the built extension (out/extension, `node scripts/build-extension.mjs`) into Chromium and
 * joins a stand-in meeting page served at a real meeting URL. The fake microphone plays 1 kHz
 * bursts; the demo voice speaks below 300 Hz, so the page can tell what the meeting receives.
 */
/** MI_EXTENSION_DIR tests a released extension (unzipped) instead of the local build. */
const EXT = process.env.MI_EXTENSION_DIR ? resolve(process.env.MI_EXTENSION_DIR) : resolve('out/extension');

const MEETING_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Weekly sync</title></head><body>
<h1>Fake meeting</h1>
<script>
  window.stats = { phase: 'before', ready: false, before: { hi: -200, lo: -200 }, after: { hi: -200, lo: -200 }, end: { hi: -200, lo: -200 } };
  (async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true }, video: false });
    window.trackLabel = stream.getAudioTracks()[0].label;
    const ac = new AudioContext();
    await ac.resume();
    const an = ac.createAnalyser();
    an.fftSize = 4096;
    an.smoothingTimeConstant = 0;
    ac.createMediaStreamSource(stream).connect(an);
    const data = new Float32Array(an.frequencyBinCount);
    const bin = (f) => Math.round(f / (ac.sampleRate / an.fftSize));
    const band = (a, b) => { let m = -200; for (let i = bin(a); i <= bin(b); i++) m = Math.max(m, data[i]); return m; };
    setInterval(() => {
      an.getFloatFrequencyData(data);
      const s = window.stats[window.stats.phase];
      s.hi = Math.max(s.hi, band(980, 1020));
      s.lo = Math.max(s.lo, band(190, 300));
    }, 40);
    window.stats.ready = true;
  })();
</script></body></html>`;

/**
 * A meeting opened straight from a calendar link: it asks for the microphone before anyone clicks
 * (so autoplay rules keep audio contexts suspended) and sends it through a real call
 * (RTCPeerConnection, looped back to a second one standing for the other side).
 */
const CALL_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Call</title></head><body>
<h1>Fake call</h1>
<script>
  window.stats = { phase: 'before', before: { hi: -200, lo: -200 }, after: { hi: -200, lo: -200 }, end: { hi: -200, lo: -200 } };
  window.level = 0;
  (async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const pc1 = new RTCPeerConnection(), pc2 = new RTCPeerConnection();
    pc1.onicecandidate = (e) => e.candidate && pc2.addIceCandidate(e.candidate);
    pc2.onicecandidate = (e) => e.candidate && pc1.addIceCandidate(e.candidate);
    const got = new Promise((r) => (pc2.ontrack = (e) => r(new MediaStream([e.track]))));
    pc1.addTrack(stream.getAudioTracks()[0], stream);
    window.pc1 = pc1;
    window.localTrack = stream.getAudioTracks()[0];
    const offer = await pc1.createOffer(); await pc1.setLocalDescription(offer); await pc2.setRemoteDescription(offer);
    const answer = await pc2.createAnswer(); await pc2.setLocalDescription(answer); await pc1.setRemoteDescription(answer);
    window.remote = await got;
    // How loud what the call sends is, without any audio context (none may run before a click).
    setInterval(async () => {
      for (const r of (await pc1.getStats()).values()) if (r.type === 'media-source' && r.kind === 'audio' && r.audioLevel !== undefined) window.level = Math.max(window.level, r.audioLevel);
    }, 100);
    window.ready = true;
  })();
  // After a click: listen to what the other side receives, by frequency.
  window.listen = async () => {
    const el = new Audio(); el.srcObject = window.remote; el.muted = true; await el.play().catch(() => {});
    const ac = new AudioContext(); await ac.resume();
    const an = ac.createAnalyser(); an.fftSize = 4096; an.smoothingTimeConstant = 0;
    ac.createMediaStreamSource(window.remote).connect(an);
    const data = new Float32Array(an.frequencyBinCount);
    const bin = (f) => Math.round(f / (ac.sampleRate / an.fftSize));
    const band = (a, b) => { let m = -200; for (let i = bin(a); i <= bin(b); i++) m = Math.max(m, data[i]); return m; };
    setInterval(() => { an.getFloatFrequencyData(data); const s = window.stats[window.stats.phase]; s.hi = Math.max(s.hi, band(980, 1020)); s.lo = Math.max(s.lo, band(190, 300)); }, 40);
  };
</script></body></html>`;

function micWav(dir: string): string {
  const R = 48000;
  const audio = concatInt16([silence(0.8, R), tone(1.2, 1000, R, 0.4), silence(1.6, R), tone(1.2, 1000, R, 0.4), silence(2, R)]);
  const path = join(dir, 'mic.wav');
  writeFileSync(path, encodeWav(audio, R));
  return path;
}

type Stats = Record<'before' | 'after' | 'end', { hi: number; lo: number }>;
const stats = (p: Page) => p.evaluate(() => (window as unknown as { stats: Stats }).stats);
const subtitles = (p: Page) => p.evaluate(() => document.getElementById('meeting-interpreter-subtitles')?.shadowRoot?.textContent ?? '');

async function launch(network = false) {
  const dir = mkdtempSync(join(tmpdir(), 'mi-ext-'));
  // Tests that download from the internet go through the environment's proxy when there is one.
  const proxy = network && process.env.HTTPS_PROXY ? [`--proxy-server=${process.env.HTTPS_PROXY}`, '--ignore-certificate-errors'] : ['--no-proxy-server'];
  const context = await chromium.launchPersistentContext(join(dir, 'profile'), {
    headless: false,
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${micWav(dir)}`,
      '--autoplay-policy=no-user-gesture-required',
      ...proxy,
    ],
  });
  await context.route('https://meet.google.com/**', (r) => r.fulfill({ contentType: 'text/html', body: MEETING_PAGE }));
  await context.route('https://teams.microsoft.com/**', (r) => r.fulfill({ contentType: 'text/html', body: CALL_PAGE }));
  const sw: Worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const extId = new URL(sw.url()).host;
  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${extId}/options.html`);
  return { context, sw, extId, ext };
}

async function joinMeeting(context: BrowserContext, sw: Worker) {
  const page = await context.newPage();
  await page.goto('https://meet.google.com/abc-defg-hij');
  await page.waitForFunction(() => (window as unknown as { stats: { ready: boolean } }).stats.ready);
  await page.bringToFront();
  const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id);
  expect(tabId).toBeTruthy();
  return { page, tabId: tabId! };
}

test('extension: my Chinese is replaced by the translation in the meeting, subtitles float on the page', async () => {
  const { context, sw, extId, ext } = await launch();

  // The options page talks to the service worker (as the popup does).
  await ext.evaluate(() => chrome.storage.local.set({ settings: { providers: 'demo', remote: 'es-MX' } }));
  await ext.reload();
  await expect(ext.getByRole('button', { name: '测试一下' })).toBeEnabled();
  await ext.screenshot({ path: 'test-results/extension-options.png' }).catch(() => undefined); // documentation only

  const { page, tabId } = await joinMeeting(context, sw);
  expect(await page.evaluate(() => (window as unknown as { trackLabel: string }).trackLabel)).not.toBe('');

  // Before interpretation the meeting hears the real microphone.
  await expect.poll(async () => (await stats(page)).before.hi, { timeout: 15_000 }).toBeGreaterThan(-60);

  const st = await ext.evaluate((id) => chrome.runtime.sendMessage({ type: 'start', tabId: id }), tabId);
  expect(st.status, JSON.stringify(st)).toBe('running');
  await expect.poll(async () => (await ext.evaluate(() => chrome.runtime.sendMessage({ type: 'state' }))).micHooked).toBe(true);
  await page.waitForTimeout(400); // the mic → translation switch ramps over a few ms
  await page.evaluate(() => ((window as unknown as { stats: { phase: string } }).stats.phase = 'after'));

  // My first sentence is recognised, translated and shown; its voice goes into the meeting.
  await expect.poll(() => subtitles(page), { timeout: 30_000 }).toContain('Hola a todos, bienvenidos a la reunión de hoy.');
  expect(await subtitles(page)).toContain('大家好，欢迎参加今天的会议。');
  await expect.poll(async () => (await stats(page)).after.lo, { timeout: 15_000 }).toBeGreaterThan(-70);
  // …and the original voice is not: the 1 kHz bursts are gone from what the meeting receives.
  await page.waitForTimeout(3000);
  const s = await stats(page);
  expect(s.after.hi, JSON.stringify(s)).toBeLessThan(s.before.hi - 30);
  await page.screenshot({ path: 'test-results/extension-meeting.png' }).catch(() => undefined); // documentation only

  // Stop: the meeting gets the real microphone back and the record is saved.
  const done = await ext.evaluate(() => chrome.runtime.sendMessage({ type: 'stop' }));
  expect(done.status).toBe('idle');
  await page.evaluate(() => ((window as unknown as { stats: { phase: string } }).stats.phase = 'end'));
  await expect.poll(async () => (await stats(page)).end.hi, { timeout: 15_000 }).toBeGreaterThan(-60);
  const meetings = await ext.evaluate(async () => ((await chrome.storage.local.get('meetings')).meetings as { segments: unknown[] }[]) ?? []);
  expect(meetings.length).toBe(1);
  expect(meetings[0]!.segments.length).toBeGreaterThan(0);

  await ext.goto(`chrome-extension://${extId}/options.html#meeting=${done.lastMeetingId}`);
  await expect(ext.getByText('下载双语记录')).toBeVisible();
  await ext.getByRole('button', { name: '生成会议纪要' }).click();
  await expect(ext.getByText('下载中文纪要')).toBeVisible();
  await ext.screenshot({ path: 'test-results/extension-history.png' }).catch(() => undefined); // documentation only
  await ext.evaluate(() => chrome.storage.local.set({ settings: {} }));
  await ext.setViewportSize({ width: 352, height: 560 });
  await ext.goto(`chrome-extension://${extId}/popup.html`);
  await expect(ext.getByRole('button', { name: '开始同传' })).toBeVisible();
  await ext.screenshot({ path: 'test-results/extension-popup.png' }).catch(() => undefined); // documentation only
  await ext.setViewportSize({ width: 1000, height: 820 });
  await ext.goto(`chrome-extension://${extId}/options.html`);
  await expect(ext.getByRole('link', { name: '去获取 ↗' })).toHaveAttribute('href', /bigmodel\.cn/);
  await ext.screenshot({ path: 'test-results/extension-options-free.png' }).catch(() => undefined); // documentation only
  await context.close();
});

test('extension: a meeting that asks for the mic before any click keeps its real mic, and is taken over when interpretation starts', async () => {
  const { context, sw, ext } = await launch();
  await ext.evaluate(() => chrome.storage.local.set({ settings: { providers: 'demo', remote: 'es-MX' } }));
  const page = await context.newPage();
  // Chrome's autoplay rule in this page only: audio contexts stay suspended until someone clicks
  // (a command-line policy would also hold the extension's own audio, which real Chrome does not).
  await page.addInitScript(() => {
    const w = globalThis as unknown as { AudioContext: typeof AudioContext; __unlockAudio: () => void };
    const Real = w.AudioContext;
    const made: AudioContext[] = [];
    let unlocked = false;
    w.AudioContext = class extends Real {
      constructor(o?: AudioContextOptions) {
        super(o);
        made.push(this);
        if (!unlocked) void Real.prototype.suspend.call(this);
      }
      override resume(): Promise<void> {
        return unlocked ? Real.prototype.resume.call(this) : new Promise<void>(() => undefined);
      }
    };
    w.__unlockAudio = () => {
      unlocked = true;
      for (const c of made) void Real.prototype.resume.call(c);
    };
  });
  await page.goto('https://teams.microsoft.com/l/meetup-join/abc');
  await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready === true);
  // Nobody clicked yet: the other side must still hear the microphone (not a silent stand-in).
  await expect.poll(() => page.evaluate(() => (window as unknown as { level: number }).level), { timeout: 15_000 }).toBeGreaterThan(0.05);

  await page.bringToFront();
  await page.evaluate(() => (window as unknown as { __unlockAudio(): void }).__unlockAudio());
  await page.mouse.click(10, 10); // the person clicks into the meeting
  await page.evaluate(() => (window as unknown as { listen(): Promise<void> }).listen());
  const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id);
  const st = await ext.evaluate((id) => chrome.runtime.sendMessage({ type: 'start', tabId: id }), tabId);
  expect(st.status, JSON.stringify(st)).toBe('running');
  await expect.poll(async () => (await ext.evaluate(() => chrome.runtime.sendMessage({ type: 'state' }))).micHooked, { timeout: 15_000 }).toBe(true);
  await page.waitForTimeout(400);
  await page.evaluate(() => ((window as unknown as { stats: { phase: string } }).stats.phase = 'after'));
  // The other side now hears the translation, not the original voice (measured once the switch
  // has settled: what was already on its way through the call does not count).
  await expect.poll(async () => (await stats(page)).after.lo, { timeout: 30_000 }).toBeGreaterThan(-70);
  await page.evaluate(() => ((window as unknown as { stats: Stats }).stats.after.hi = -200));
  await page.waitForTimeout(3000);
  const s = await stats(page);
  const sending = await page.evaluate(() => {
    const w = window as unknown as { pc1: RTCPeerConnection; localTrack: MediaStreamTrack };
    return { senders: w.pc1.getSenders().map((x) => ({ same: x.track === w.localTrack, kind: x.track?.kind })), mic: (window as unknown as { __meetingInterpreterMic?: unknown }).__meetingInterpreterMic };
  });
  expect(s.after.hi, `${JSON.stringify(s)} senders: ${JSON.stringify(sending)}`).toBeLessThan(-75);

  // Stop: the call sends the real microphone again.
  await ext.evaluate(() => chrome.runtime.sendMessage({ type: 'stop' }));
  await page.evaluate(() => ((window as unknown as { stats: { phase: string } }).stats.phase = 'end'));
  await expect.poll(async () => (await stats(page)).end.hi, { timeout: 15_000 }).toBeGreaterThan(-60);
  await context.close();
});

test('extension free tier: recognition and voice come from the desktop app', async () => {
  // A stand-in for the desktop app: "recognises" a fixed sentence once it has heard 1 s of audio
  // and speaks with a 250 Hz tone.
  const heard: string[] = [];
  const bridge = new DesktopBridge({
    version: 'test',
    log: createLogger('bridge'),
    enabled: () => true,
    modelsReady: () => true,
    ensureModels: async () => undefined,
    asr: () => ({
      id: 'fake',
      start: async (o) => {
        heard.push(o.lang);
        const events = new Emitter<AsrEvents>();
        let n = 0;
        let said = false;
        const s: AsrSession = {
          events,
          push: (pcm) => {
            n += pcm.length;
            if (!said && n > 16000) {
              said = true;
              events.emit('final', { text: '大家好，欢迎参加今天的会议。' });
            }
          },
          end: async () => void events.emit('closed', {}),
          close: () => undefined,
        };
        return s;
      },
    }),
    tts: () => ({
      id: 'fake',
      voices: () => [],
      async *synthesize() {
        const r = 22050;
        yield { samples: Int16Array.from({ length: r }, (_, i) => Math.round(Math.sin((2 * Math.PI * 250 * i) / r) * 8000)), sampleRate: r };
      },
    }),
  });
  await bridge.start();
  try {
    const { context, sw, ext } = await launch();
    await ext.evaluate(() =>
      chrome.storage.local.set({
        settings: { providers: 'custom', remote: 'es-MX', out: { asr: 'local', mt: 'demo', tts: 'system', voice: '' }, in: { asr: 'local', mt: 'demo', tts: 'none', voice: '' } },
      }),
    );
    await ext.reload();
    await expect(ext.getByText('桌面客户端已连接（test）')).toBeVisible();
    const { page, tabId } = await joinMeeting(context, sw);
    const st = await ext.evaluate((id) => chrome.runtime.sendMessage({ type: 'start', tabId: id }), tabId);
    expect(st.status, JSON.stringify(st)).toBe('running');
    await page.waitForTimeout(400);
    await page.evaluate(() => ((window as unknown as { stats: { phase: string } }).stats.phase = 'after'));
    await expect.poll(() => subtitles(page), { timeout: 30_000 }).toContain('Hola a todos, bienvenidos a la reunión de hoy.');
    await expect.poll(async () => (await stats(page)).after.lo, { timeout: 15_000 }).toBeGreaterThan(-70);
    expect(heard).toContain('zh-CN');
    await ext.evaluate(() => chrome.runtime.sendMessage({ type: 'stop' }));
    await context.close();
  } finally {
    await bridge.stop();
  }
});

test('extension: free offline translation (models downloaded into the browser)', async () => {
  test.setTimeout(600_000);
  const { context, sw, extId, ext } = await launch(true);
  await ext.evaluate(() =>
    chrome.storage.local.set({ settings: { providers: 'custom', remote: 'es-MX', out: { asr: 'demo', mt: 'offline', tts: 'demo', voice: '' }, in: { asr: 'demo', mt: 'offline', tts: 'demo', voice: '' } } }),
  );
  await ext.goto(`chrome-extension://${extId}/options.html#offline`); // starts the download
  await expect(ext.getByRole('status').filter({ hasText: '离线翻译已下载' })).toBeVisible({ timeout: 540_000 });
  const { page, tabId } = await joinMeeting(context, sw);
  const st = await ext.evaluate((id) => chrome.runtime.sendMessage({ type: 'start', tabId: id }), tabId);
  expect(st.status, JSON.stringify(st)).toBe('running');
  // The second demo sentence, as Mozilla's model (not the demo translator) words it.
  await expect.poll(() => subtitles(page), { timeout: 60_000 }).toMatch(/tiempo de entrega|plazo de entrega/);
  console.log('extension offline subtitles:', (await subtitles(page)).slice(0, 300));
  await ext.evaluate(() => chrome.runtime.sendMessage({ type: 'stop' }));
  await context.close();
});

test('extension: the voice profile exported from the desktop app can be imported', async () => {
  const { context, ext } = await launch();
  const file = join(mkdtempSync(join(tmpdir(), 'mi-prof-')), 'voice-profile.json');
  writeFileSync(
    file,
    '﻿' +
      JSON.stringify({ version: 1, corrections: [{ heard: '河同', meant: '合同', lang: 'zh', count: 1, source: 'edit', updatedAt: 1 }], confusions: { 'l-n': 3 }, calibrations: [], updatedAt: 1 }),
  );
  const card = ext.locator('#profile');
  await expect(card).toContainText('还没有导入');
  await card.locator('input[type=file]').setInputFiles(file);
  await expect(ext.locator('#profile')).toContainText('1 条纠错，口音特点：l/n', { timeout: 10_000 });
  const stored = await ext.evaluate(async () => (await chrome.storage.local.get('voiceProfile')).voiceProfile as { corrections: unknown[] });
  expect(stored.corrections).toHaveLength(1);
  // Not a profile: refused with a message.
  const bad = join(mkdtempSync(join(tmpdir(), 'mi-prof-')), 'x.json');
  writeFileSync(bad, '{"hello":1}');
  await ext.locator('#profile input[type=file]').setInputFiles(bad);
  await expect(ext.locator('#profile')).toContainText('不是会议同传的口音档案');
  await context.close();
});
