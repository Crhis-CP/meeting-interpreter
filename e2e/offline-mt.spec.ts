import { expect, test } from '@playwright/test';
import { launchApp, mainWindow } from './helpers';

/**
 * Free tier, no key: offline translation with Mozilla's models inside the real app. Downloads
 * about 140 MB on the first run (our mirror, else Mozilla), then translates without a network.
 */
test('offline translation: models download in the app and translate the meeting', async () => {
  test.setTimeout(600_000);
  const { app } = await launchApp({
    preset: 'custom',
    out: { enabled: true, asr: 'demo', mt: 'offline', tts: 'demo', voice: '' },
    in: { enabled: true, asr: 'demo', mt: 'offline', tts: 'demo', voice: '' },
  });
  const win = await mainWindow(app);
  await win.waitForLoadState('domcontentloaded');

  const status = () => win.evaluate('window.api.mt.status()') as Promise<{ missingBytes: number }>;
  if ((await status()).missingBytes) await win.evaluate('window.api.mt.download()');
  expect((await status()).missingBytes).toBe(0);

  const t0 = Date.now();
  await win.getByRole('button', { name: '开始同传' }).click();
  await expect(win.getByText('大家好，欢迎参加今天的会议。')).toBeVisible({ timeout: 60_000 });
  // Translated by the offline model (not the demo translator): Spanish text appears for it.
  await expect(win.locator('.seg.me .dst').first()).toHaveText(/[a-záéíóúñ]{3,}/i, { timeout: 30_000 });
  const first = await win.locator('.seg.me .dst').first().textContent();
  console.log(`offline translation: “${first}” (${Date.now() - t0} ms after start)`);
  expect(first).toMatch(/Hola|bienvenid|reunión/i);
  await win.screenshot({ path: 'test-results/offline-mt.png' });
  await win.getByRole('button', { name: '结束会议' }).click();
  await app.close();
});
