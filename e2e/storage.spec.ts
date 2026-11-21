import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { attachAppLogs, launchApp, mainWindow } from './helpers';

test.afterEach(async ({}, info) => attachAppLogs(info));

test('存储空间: models on disk are listed with their size and state, and can be deleted', async () => {
  const { app, dataDir } = await launchApp();
  // An earlier download the settings no longer use (the light Spanish model), half there.
  const dir = join(dataDir, 'models', 'whisper-base');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'base-encoder.int8.onnx'), new Uint8Array(3_000_000));
  const win = await mainWindow(app);
  win.on('dialog', (d) => void d.accept());
  await win.getByRole('navigation').getByRole('button', { name: '设置', exact: true }).click();
  await win.getByRole('tab', { name: '存储空间' }).click();

  const row = win.getByLabel('西语 / 英语识别（轻量）');
  await expect(row).toBeVisible();
  await expect(row).toContainText('3 MB');
  await expect(row).toContainText('没下完');
  await expect(win.getByText(dataDir, { exact: true })).toBeVisible();

  await row.getByRole('button', { name: '删除' }).click();
  await expect(row).toHaveCount(0);
  expect(existsSync(dir)).toBe(false);
  await app.close();
});

test('彻底卸载 (rehearsal): the backup is written first, and the list says what would go', async () => {
  const { app, dataDir } = await launchApp();
  const win = await mainWindow(app);
  await win.getByRole('navigation').getByRole('button', { name: '设置', exact: true }).click();
  await win.getByRole('tab', { name: '存储空间' }).click();
  const card = win.getByLabel('彻底卸载');
  await expect(card.getByText('模型、缓存、设置和 Key')).toBeVisible();
  // Records and the driver stay unless ticked.
  await expect(card.getByRole('checkbox', { name: /会议记录/ })).not.toBeChecked();

  const r = (await win.evaluate("window.api.uninstall.run({ records: false, driver: false, dryRun: true })")) as { backupDir: string; files: string[]; removed: string[] };
  expect(r.backupDir.startsWith(`${dataDir}-downloads`)).toBe(true);
  expect(r.files.map((f) => f.split(/[\\/]/).pop())).toEqual(expect.arrayContaining(['设置.json', '说明.txt']));
  expect(r.files.some((f) => /术语表-.*\.csv$/.test(f))).toBe(true);
  for (const f of r.files) expect(existsSync(f), f).toBe(true);
  expect(r.removed).toEqual([dataDir]); // records not ticked; running from source: no app to remove
  expect(existsSync(dataDir)).toBe(true); // a rehearsal deletes nothing
  await app.close();
});

test('彻底卸载 for real (a test data folder): the app quits and its data folder is gone afterwards', async () => {
  const { app, dataDir } = await launchApp();
  const win = await mainWindow(app);
  const closed = new Promise<void>((r) => app.once('close', () => r()));
  await win.evaluate("window.api.uninstall.run({ records: false, driver: false })").catch(() => undefined);
  await closed; // the app quits by itself
  await expect.poll(() => existsSync(dataDir), { timeout: 30_000 }).toBe(false);
  expect(existsSync(`${dataDir}-downloads`)).toBe(true); // the backup stays
});
