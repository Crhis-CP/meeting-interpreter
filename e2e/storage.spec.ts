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
  await expect(win.getByText(dataDir)).toBeVisible();

  await row.getByRole('button', { name: '删除' }).click();
  await expect(row).toHaveCount(0);
  expect(existsSync(dir)).toBe(false);
  await app.close();
});
