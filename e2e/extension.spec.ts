import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect, test, type Page, type Worker } from '@playwright/test';
import { concatInt16, silence, tone } from '../src/core/audio/pcm';
import { encodeWav } from '../src/core/audio/wav';

/**
 * Loads the built extension (out/extension, `node scripts/build-extension.mjs`) into Chromium and
 * joins a stand-in meeting page served at a real meeting URL. The fake microphone plays 1 kHz
 * bursts; the demo voice speaks below 300 Hz, so the page can tell what the meeting receives.
 */
const EXT = resolve('out/extension');

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

test('extension: my Chinese is replaced by the translation in the meeting, subtitles float on the page', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mi-ext-'));
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
      '--no-proxy-server',
    ],
  });
  await context.route('https://meet.google.com/**', (r) => r.fulfill({ contentType: 'text/html', body: MEETING_PAGE }));
  const sw: Worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const extId = new URL(sw.url()).host;

  // An extension page to talk to the service worker (as the popup does).
  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${extId}/options.html`);
  await ext.evaluate(() => chrome.storage.local.set({ settings: { providers: 'demo', remote: 'es-MX' } }));
  await ext.reload();
  await expect(ext.getByText('当前方案不需要 Key。')).toBeVisible();
  await ext.screenshot({ path: 'test-results/extension-options.png' });

  const page = await context.newPage();
  await page.goto('https://meet.google.com/abc-defg-hij');
  await page.waitForFunction(() => (window as unknown as { stats: { ready: boolean } }).stats.ready);
  expect(await page.evaluate(() => (window as unknown as { trackLabel: string }).trackLabel)).not.toBe('');

  // Before interpretation the meeting hears the real microphone.
  await expect.poll(async () => (await stats(page)).before.hi, { timeout: 15_000 }).toBeGreaterThan(-60);

  await page.bringToFront();
  const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id);
  expect(tabId).toBeTruthy();
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
  await page.screenshot({ path: 'test-results/extension-meeting.png' });

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
  await ext.screenshot({ path: 'test-results/extension-history.png' });
  await context.close();
});
