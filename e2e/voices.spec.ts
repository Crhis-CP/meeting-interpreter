import { existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { attachAppLogs, launchApp, mainWindow } from './helpers';

test.afterEach(async ({}, info) => attachAppLogs(info));

// Needs the natural voices downloaded and checked: MI_MODELS_DIR=/path with kokoro-v1.0 in it (the
// Mac / Windows CI job has it from the unit tests, tests/main/neural-tts.int.test.ts).
// (Absolute: CI gives a relative folder, and a link stores its target as given.)
const SRC = process.env.MI_MODELS_DIR ? resolve(process.env.MI_MODELS_DIR, 'kokoro-v1.0') : '';
test.skip(!SRC || !existsSync(join(SRC, 'model.onnx.sha256')), 'natural voices not downloaded (MI_MODELS_DIR)');

test('natural voices: 女声 / 男声 to choose, and 试听 speaks with the model in its own process', async () => {
  test.setTimeout(120_000);
  const voice = { asr: 'demo', mt: 'demo', tts: 'local', voice: '' };
  const { app, dataDir } = await launchApp({ preset: 'custom', out: { enabled: true, ...voice }, in: { enabled: true, ...voice } });
  // As if downloaded: the model's folder (with its checked-hash marks), linked in.
  mkdirSync(join(dataDir, 'models'), { recursive: true });
  symlinkSync(SRC, join(dataDir, 'models', 'kokoro-v1.0'), process.platform === 'win32' ? 'junction' : 'dir');

  const win = await mainWindow(app);
  await win.waitForLoadState('domcontentloaded');
  await win.getByRole('navigation').getByRole('button', { name: '设置', exact: true }).click();
  const card = win.locator('.card', { has: win.getByRole('heading', { name: '声音', exact: true }) });
  await expect(card.getByText('对方听到的西语')).toBeVisible();
  await expect(card.getByText('我听到的中文')).toBeVisible();
  const select = card.locator('select').first();
  await expect(select.locator('option')).toHaveText(['女声', '男声']);
  await select.selectOption('male');
  await card.getByRole('button', { name: '试听' }).first().click();
  const log = () => readFileSync(join(dataDir, 'app.log'), 'utf8');
  await expect.poll(() => /natural voices (loaded in \d+ ms|: .*)/.exec(log())?.[0] ?? '', { timeout: 60_000, intervals: [500] }).toMatch(/loaded in/);
  await expect(card.getByRole('button', { name: '试听' }).first()).toBeEnabled({ timeout: 60_000 });
  await expect(card.getByRole('alert')).toHaveCount(0);
  // The choice is kept.
  const settings = JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8')) as { out: { voice: string } };
  expect(settings.out.voice).toBe('male');
  await app.close();
});
