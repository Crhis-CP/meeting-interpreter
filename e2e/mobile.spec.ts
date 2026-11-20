import { createServer } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { chromium, devices, expect, test } from '@playwright/test';
import { speechWav } from './helpers';

/** The phone app's web part (out/mobile, `node scripts/build-mobile.mjs`) in a phone-sized browser. */
test('phone app: hands-free conversation translates what is said and speaks it', async () => {
  const root = resolve('out/mobile');
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
  const server = createServer((req, res) => {
    const f = join(root, (req.url ?? '/').split('?')[0] === '/' ? 'index.html' : (req.url ?? '').split('?')[0]!);
    let body: Buffer;
    try {
      body = readFileSync(f);
    } catch {
      return void res.writeHead(404).end();
    }
    res.writeHead(200, { 'Content-Type': types[extname(f)] ?? 'application/octet-stream' }).end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const wav = speechWav(mkdtempSync(join(tmpdir(), 'mi-mobile-')));
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`, '--autoplay-policy=no-user-gesture-required', '--no-proxy-server'],
  });
  const ctx = await browser.newContext({ ...devices['Pixel 7'], permissions: ['microphone'] });
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${port}/`);
  await page.evaluate(() => localStorage.setItem('mi-settings', JSON.stringify({ provider: 'demo', mode: 'hands-free' })));
  await page.reload();
  await expect(page.getByText('把手机放在你们中间，直接说话。')).toBeVisible();
  await page.screenshot({ path: 'test-results/mobile-idle.png' });

  await page.getByRole('button', { name: '开始' }).click();
  await expect(page.locator('.turn.me .main').first()).toHaveText('Hola a todos, bienvenidos a la reunión de hoy.', { timeout: 30_000 });
  await expect(page.locator('.turn.me .src').first()).toHaveText('大家好，欢迎参加今天的会议。');
  await expect.poll(() => page.evaluate(() => document.body.dataset.state), { timeout: 15_000 }).toBe('speaking');
  await page.screenshot({ path: 'test-results/mobile-talking.png' });
  await page.getByRole('button', { name: '暂停' }).click();
  await expect(page.getByRole('button', { name: '开始' })).toBeVisible();

  // Push-to-talk mode and the settings sheet.
  await page.getByRole('button', { name: '按住说话', exact: true }).last().click();
  await expect(page.locator('.mic .cap')).toHaveText('按住说话');
  await page.getByRole('button', { name: '设置' }).click();
  await expect(page.getByText('去获取 Key ↗')).toBeVisible();
  await page.screenshot({ path: 'test-results/mobile-settings.png' });
  await browser.close();
  server.close();
});
