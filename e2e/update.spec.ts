import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { attachAppLogs, launchApp, mainWindow } from './helpers';

test.afterEach(async ({}, info) => attachAppLogs(info));

const version = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;

test('a newer version: the banner offers the update and stays out of the way when put off', async () => {
  const { app } = await launchApp();
  const win = await mainWindow(app);
  await expect(win.getByRole('button', { name: '开始同传' })).toBeVisible();
  // What the start-up check announces when GitHub has a newer release.
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('mi:event', { event: 'update-available', payload: { version: '9.9.9', notes: '- 更准\n- 更快' } });
  });
  const banner = win.getByLabel('有新版本');
  await expect(banner).toContainText('有新版本 9.9.9');
  await banner.getByRole('button', { name: '改了什么' }).click();
  await expect(banner).toContainText('更快');
  await banner.getByRole('button', { name: '稍后' }).click();
  await expect(banner).toHaveCount(0);
  await app.close();
});

test('after an update, the first start shows what changed, once', async () => {
  const { app, dataDir } = await launchApp({}, { files: { 'whats-new.json': JSON.stringify({ version, notes: '- 字幕窗不再挡住会议软件' }) } });
  const win = await mainWindow(app);
  const note = win.getByLabel('这次更新了什么');
  await expect(note).toContainText(`已更新到 ${version}`);
  await expect(note).toContainText('字幕窗不再挡住会议软件');
  expect(existsSync(join(dataDir, 'whats-new.json'))).toBe(false); // once
  await note.getByRole('button', { name: '知道了' }).click();
  await expect(note).toHaveCount(0);
  await app.close();
});
