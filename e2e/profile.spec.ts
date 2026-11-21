import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, mainWindow, attachAppLogs } from './helpers';

test.afterEach(async ({}, info) => attachAppLogs(info));

test('accent calibration, then correcting a sentence teaches the profile', async () => {
  const { app, recordsDir, dataDir } = await launchApp();
  const win = await mainWindow(app);
  await win.waitForLoadState('domcontentloaded');

  // 1. Calibration: read each sentence (the fake microphone supplies the voice).
  await win.locator('.nav-item', { hasText: '词库' }).click();
  await win.getByRole('tab', { name: '口音校准' }).click();
  await win.getByRole('button', { name: /^开始校准/ }).click();
  // The first sentence starts with a button; each next one starts recording by itself.
  await win.getByRole('button', { name: '开始录音' }).click();
  for (let i = 0; i < 20; i++) {
    const done = win.getByRole('button', { name: /^读完了/ });
    if (!(await done.waitFor({ timeout: 8000 }).then(() => true, () => false))) break;
    await win.waitForTimeout(2200);
    await done.click();
  }
  const result = win.getByTestId('calibration-result');
  await expect(result).toBeVisible({ timeout: 60_000 });
  await expect(result.getByText('演示')).toBeVisible();
  await expect(result.getByText('%').first()).toBeVisible();
  await win.screenshot({ path: 'test-results/calibration.png' });
  const profile = JSON.parse(readFileSync(join(recordsDir, 'voice-profile.json'), 'utf8'));
  expect(profile.calibrations).toHaveLength(1);
  expect(profile.calibrations[0].results[0]).toMatchObject({ asr: 'demo' });

  // 2. A short demo meeting.
  await win.locator('.nav-item', { hasText: '会议同传' }).click();
  await win.getByRole('button', { name: '开始同传' }).click();
  await expect(win.getByText('大家好，欢迎参加今天的会议。')).toBeVisible({ timeout: 30_000 });
  await win.getByRole('button', { name: '结束会议' }).click();
  await expect(win.getByText('会议已结束')).toBeVisible({ timeout: 20_000 });

  // 3. Correct a recognised sentence in the record: re-translated, files rewritten, and learned.
  await win.getByRole('button', { name: '查看会议记录' }).click();
  await win.locator('.list-item').first().click();
  // AI learning after the meeting (the demo LLM answers): new terms go to the automatic glossary.
  const panel = win.getByTestId('review-panel');
  await panel.getByRole('button', { name: 'AI 自动学习' }).click();
  await expect(panel).toContainText(/学会 [1-9] 个新术语/, { timeout: 15_000 });
  await expect(panel).toContainText('会议 = reunión');
  await panel.locator('.row', { hasText: '会议 = ' }).getByRole('button', { name: '移除' }).click();
  await expect(panel).not.toContainText('会议 = reunión');
  // The automatic glossary exists, without the removed term.
  const glossaries = JSON.parse(readFileSync(join(dataDir, 'glossaries.json'), 'utf8')) as { id: string; name: string; entries: { zh: string }[] }[];
  const auto = glossaries.find((g) => g.id === 'auto-terms')!;
  expect(auto.name).toBe('自动术语（会后学到的）');
  expect(auto.entries.map((e) => e.zh)).not.toContain('会议');

  // 3. Correct a recognised sentence in the record: re-translated, files rewritten, and learned.
  const seg = win.locator('.editable-seg', { hasText: '欢迎参加今天的' }).first();
  await seg.getByRole('button', { name: '✎ 改正' }).click();
  await seg.getByLabel('改正识别的文字').fill('大家好，欢迎参加今天的会意。');
  await seg.getByRole('button', { name: '保存并重新翻译' }).click();
  await expect(seg.getByText('已记住')).toBeVisible({ timeout: 15_000 });
  await expect(seg.locator('.src')).toHaveText('大家好，欢迎参加今天的会意。');
  await win.screenshot({ path: 'test-results/corrected.png' });

  const folder = join(recordsDir, readdirSync(recordsDir).find((f) => f !== 'voice-profile.json')!);
  expect(readFileSync(join(folder, 'transcript.md'), 'utf8')).toContain('大家好，欢迎参加今天的会意。');
  const learned = JSON.parse(readFileSync(join(recordsDir, 'voice-profile.json'), 'utf8'));
  expect(learned.corrections).toContainEqual(expect.objectContaining({ heard: '会议', meant: '会意', source: 'edit' }));

  // 4. The correction list shows it, and it can be removed.
  await win.locator('.nav-item', { hasText: '词库' }).click();
  await win.getByRole('tab', { name: '纠错' }).click();
  const row = win.locator('tr', { hasText: '会意' });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: '删除' }).click();
  await expect(row).toHaveCount(0);
  await app.close();
});

test('accent calibration: leaving the page mid-sentence gives the microphone back', async () => {
  const { app } = await launchApp();
  const win = await mainWindow(app);
  await win.waitForLoadState('domcontentloaded');
  // Count the microphone tracks this window opens.
  await win.evaluate(() => {
    const md = (globalThis as unknown as { navigator: { mediaDevices: { getUserMedia(c: unknown): Promise<{ getTracks(): { readyState: string }[] }> } } }).navigator.mediaDevices;
    const tracks: { readyState: string }[] = [];
    const original = md.getUserMedia.bind(md);
    md.getUserMedia = async (c) => {
      const s = await original(c);
      tracks.push(...s.getTracks());
      return s;
    };
    (globalThis as unknown as { liveMics: () => number }).liveMics = () => tracks.filter((t) => t.readyState === 'live').length;
  });
  const liveMics = () => win.evaluate(() => (globalThis as unknown as { liveMics: () => number }).liveMics());
  await win.locator('.nav-item', { hasText: '词库' }).click();
  await win.getByRole('tab', { name: '口音校准' }).click();
  await win.getByRole('button', { name: /^开始校准/ }).click();
  await win.getByRole('button', { name: '开始录音' }).click();
  await expect(win.getByRole('button', { name: /^读完了/ })).toBeVisible();
  await expect.poll(liveMics).toBe(1);
  // Off to another page while recording: the microphone (and its indicator) must go off.
  await win.locator('.nav-item', { hasText: '会议记录' }).click();
  await expect.poll(liveMics).toBe(0);
  await app.close();
});
