import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, mainWindow, attachAppLogs } from './helpers';

test.afterEach(async ({}, info) => attachAppLogs(info));

test('a device change mid-meeting and a second meeting both keep working', async () => {
  const { app, recordsDir } = await launchApp();
  const win = await mainWindow(app);

  await win.getByRole('button', { name: '开始同传' }).click();
  await expect(win.getByText('大家好，欢迎参加今天的会议。')).toBeVisible({ timeout: 30_000 });
  // Change a capture setting while the meeting runs: the audio engine restarts its devices.
  await win.evaluate(() => (globalThis as unknown as { api: { settings: { set(p: object): Promise<unknown> } } }).api.settings.set({ devices: { echoCancellation: false } }));
  await expect(win.getByText('我们今天主要讨论新产品的交货期和价格。')).toBeVisible({ timeout: 30_000 });
  await win.getByRole('button', { name: '结束会议' }).click();
  await expect(win.getByText('会议已结束')).toBeVisible({ timeout: 20_000 });

  // Second meeting in the same app session.
  await win.getByRole('button', { name: '开始同传' }).click();
  await expect(win.getByText('进行中')).toBeVisible();
  await expect(win.locator('.seg').first()).toBeVisible({ timeout: 30_000 });
  await win.getByRole('button', { name: '结束会议' }).click();
  await expect(win.getByText('会议已结束')).toBeVisible({ timeout: 20_000 });

  const folders = readdirSync(recordsDir).sort();
  expect(folders).toHaveLength(2);
  const first = JSON.parse(readFileSync(join(recordsDir, folders[0]!, 'meeting.json'), 'utf8'));
  expect(first.files.mix).toBeTruthy();
  expect(first.files.mix2).toBeTruthy(); // recording continued after the device change
  const second = JSON.parse(readFileSync(join(recordsDir, folders[1]!, 'meeting.json'), 'utf8'));
  expect(second.files.mix).toBeTruthy();
  expect(readFileSync(join(recordsDir, folders[1]!, 'transcript.jsonl'), 'utf8').length).toBeGreaterThan(10);
  await app.close();
});
