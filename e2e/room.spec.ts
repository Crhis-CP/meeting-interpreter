import { chromium, expect, test } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { launchApp, mainWindow, speechWav } from './helpers';

test('room: a Chinese phone speaks, a Spanish phone sees the translation', async () => {
  const { app } = await launchApp({ room: { port: 0, publicLink: false } });
  const win = await mainWindow(app);
  await win.getByRole('button', { name: /现场房间/ }).click();
  await win.getByRole('button', { name: '开启房间' }).click();
  const urlBox = win.locator('.url').first();
  await expect(urlBox).toContainText('https://');
  const url = (await urlBox.textContent())!.trim();
  await win.screenshot({ path: 'test-results/room-host.png' });

  const wav = speechWav(mkdtempSync(`${tmpdir()}/mi-room-wav-`));
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--no-proxy-server', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`, '--autoplay-policy=no-user-gesture-required'],
  });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['microphone'], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const zh = await ctx.newPage();
  const es = await ctx.newPage();

  for (const [page, lang, name] of [[zh, '中文', '王经理'], [es, 'Español', 'Carlos']] as const) {
    await page.goto(url);
    await page.getByRole('radio', { name: lang, exact: true }).check();
    await page.getByRole('textbox', { name: lang === '中文' ? '你的名字' : 'Tu nombre' }).fill(name);
    await page.getByRole('button', { name: lang === '中文' ? '加入' : 'Unirse' }).click();
  }
  await expect(zh.getByRole('button', { name: '按住说话' })).toBeVisible();
  await expect(es.getByRole('button', { name: 'Mantén pulsado para hablar' })).toBeVisible();
  await es.screenshot({ path: 'test-results/room-phone-es-joined.png' });

  // Hold to talk on the Chinese phone while its fake microphone plays a burst of sound.
  const talk = zh.getByRole('button', { name: '按住说话' });
  const box = (await talk.boundingBox())!;
  await zh.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await zh.mouse.down();
  await zh.waitForTimeout(5500);
  await zh.mouse.up();

  await expect(es.getByText('Hola a todos, bienvenidos a la reunión de hoy.').first()).toBeVisible({ timeout: 30_000 });
  await expect(zh.getByText('大家好，欢迎参加今天的会议。').first()).toBeVisible();
  await es.screenshot({ path: 'test-results/room-phone-es.png' });
  await zh.screenshot({ path: 'test-results/room-phone-zh.png' });
  // The host window shows the participants and the transcript.
  await expect(win.getByText('📱 王经理')).toBeVisible();
  await win.screenshot({ path: 'test-results/room-host-live.png' });

  await win.getByRole('button', { name: '关闭房间' }).click();
  await expect(es.getByText('La sala se ha cerrado.')).toBeVisible();
  await browser.close();
  await app.close();
});
