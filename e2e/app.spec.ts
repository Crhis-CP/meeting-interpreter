import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, mainWindow } from './helpers';

test('demo meeting: microphone audio becomes bilingual segments and a saved record', async () => {
  const { app, recordsDir } = await launchApp();
  const win = await mainWindow(app);
  await win.waitForLoadState('domcontentloaded');
  await expect(win.getByRole('heading', { name: '会议同传' })).toBeVisible();
  await win.screenshot({ path: 'test-results/main-idle.png' });

  await win.getByRole('button', { name: '开始同传' }).click();
  await expect(win.getByText('进行中')).toBeVisible();
  // The fake microphone plays bursts of sound; the demo recogniser turns each into a scripted line.
  await expect(win.getByText('大家好，欢迎参加今天的会议。')).toBeVisible({ timeout: 30_000 });
  await expect(win.getByText('Hola a todos, bienvenidos a la reunión de hoy.')).toBeVisible();
  await win.screenshot({ path: 'test-results/main-meeting.png' });

  await win.getByRole('button', { name: '结束会议' }).click();
  await expect(win.getByText('会议已结束')).toBeVisible({ timeout: 20_000 });

  const folders = readdirSync(recordsDir);
  expect(folders).toHaveLength(1);
  const folder = join(recordsDir, folders[0]!);
  for (const f of ['meeting.json', 'transcript.jsonl', 'transcript.md', 'transcript.zh.srt', 'audio/mic.wav']) expect(existsSync(join(folder, f)), f).toBe(true);
  expect(readFileSync(join(folder, 'transcript.md'), 'utf8')).toContain('大家好，欢迎参加今天的会议。');
  const meta = JSON.parse(readFileSync(join(folder, 'meeting.json'), 'utf8'));
  expect(meta.files.mix).toMatch(/^audio\/mix\./); // MediaRecorder mix was written
  expect(existsSync(join(folder, meta.files.mix))).toBe(true);

  // History page lists the meeting.
  await win.getByRole('button', { name: '查看会议记录' }).click();
  await expect(win.getByText('句').first()).toBeVisible();
  await win.screenshot({ path: 'test-results/history.png' });

  // Open the meeting and check the recording plays through the mi-media:// protocol.
  await win.locator('.list-item').first().click();
  await win.getByRole('button', { name: '录音录屏' }).click();
  const audio = win.locator('audio').first();
  await expect(audio).toBeVisible();
  await expect.poll(async () => audio.evaluate((el) => { const a = el as unknown as { error: unknown; readyState: number }; return a.error ? -1 : a.readyState; }), { timeout: 15_000 }).toBeGreaterThan(0);
  await win.getByRole('button', { name: '中文纪要' }).click();
  await win.getByRole('button', { name: '生成纪要' }).click();
  await expect(win.getByText('新产品交货与价格洽谈').first()).toBeVisible({ timeout: 20_000 });
  await win.screenshot({ path: 'test-results/summary.png' });
  await app.close();
});
