import { test } from '@playwright/test';
import { attachAppLogs, launchApp, mainWindow } from './helpers';

test.afterEach(async ({}, info) => attachAppLogs(info));

// Diagnostics only (never fails): on the macOS CI machine the fake microphone captured silence.
// Logs the system's microphone permission and the peak level under different capture settings.
test.skip(process.platform !== 'darwin', 'macOS only');

test('macOS audio capture diagnostics', async () => {
  test.setTimeout(90_000);
  const { app } = await launchApp();
  const win = await mainWindow(app);
  await win.waitForLoadState('domcontentloaded');
  const status = await app.evaluate(({ systemPreferences }) => systemPreferences.getMediaAccessStatus('microphone'));
  console.log(`microphone access status: ${status}`);
  const variants: Record<string, MediaTrackConstraints | boolean> = {
    default: true,
    'processing off': { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    'app settings': { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  };
  for (const [name, audio] of Object.entries(variants)) {
    const r = await win.evaluate(async (audio) => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio });
        const t = s.getAudioTracks()[0]!;
        const ctx = new AudioContext();
        const an = ctx.createAnalyser();
        an.fftSize = 2048;
        ctx.createMediaStreamSource(s).connect(an);
        const buf = new Float32Array(an.fftSize);
        let peak = 0;
        const end = Date.now() + 4000;
        while (Date.now() < end) {
          await new Promise((r) => setTimeout(r, 50));
          an.getFloatTimeDomainData(buf);
          for (const v of buf) peak = Math.max(peak, Math.abs(v));
        }
        const info = `${t.label}, ${JSON.stringify(t.getSettings())}, muted=${t.muted}, ctx ${ctx.state} ${ctx.sampleRate} Hz`;
        s.getTracks().forEach((x) => x.stop());
        await ctx.close();
        return { peak, info };
      } catch (err) {
        return { peak: -1, info: String(err) };
      }
    }, audio);
    console.log(`[${name}] peak ${r.peak.toFixed(4)} — ${r.info}`);
  }
  await app.close();
});
