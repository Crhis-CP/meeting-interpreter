import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, mainWindow, attachAppLogs } from './helpers';

test.afterEach(async ({}, info) => attachAppLogs(info));

// Needs the real model: MI_AI_MODEL=/path/to/Hy-MT2-1.8B-Q4_K_M.gguf (1.1 GB; the Mac / Windows CI job
// fetches it with scripts/dev/fetch-ai-model.mts).
const MODEL = process.env.MI_AI_MODEL;
const SHA = 'dc5f44fcf1fa496ee7ad725982c0c8c553a4de00259b53af84c4b89fb0c06699';

test.skip(!MODEL || !existsSync(MODEL), 'MI_AI_MODEL not set');

test('local AI translation: a meeting is translated by the model on this computer', async () => {
  test.setTimeout(180_000);
  const ai = { asr: 'demo', mt: 'local-ai', tts: 'demo', voice: '' };
  const { app, dataDir, recordsDir } = await launchApp({ out: { enabled: true, ...ai }, in: { enabled: true, ...ai } });
  // As if downloaded and checked: the model file and its checked-hash marker.
  const dir = join(dataDir, 'models', 'hy-mt2-1.8b');
  mkdirSync(dir, { recursive: true });
  try {
    symlinkSync(MODEL!, join(dir, 'Hy-MT2-1.8B-Q4_K_M.gguf'));
  } catch {
    copyFileSync(MODEL!, join(dir, 'Hy-MT2-1.8B-Q4_K_M.gguf')); // Windows without the symlink right
  }
  writeFileSync(join(dir, 'Hy-MT2-1.8B-Q4_K_M.gguf.sha256'), SHA);

  const win = await mainWindow(app);
  await win.waitForLoadState('domcontentloaded');
  await win.getByRole('button', { name: '开始同传' }).click();
  await expect(win.getByText('大家好，欢迎参加今天的会议。')).toBeVisible({ timeout: 30_000 });
  // Sentences spoken while the model loads use the fallback; the rest come from the model.
  await expect(win.getByText(/bienvenid|plazos|semanas|descuento/i).first()).toBeVisible({ timeout: 60_000 });
  await win.waitForTimeout(8000);
  await win.getByRole('button', { name: '结束会议' }).click();
  await expect(win.getByText('会议已结束')).toBeVisible({ timeout: 30_000 });
  const log = readFileSync(join(dataDir, 'app.log'), 'utf8');
  expect(log).toContain('local AI translation loaded');
  const folder = join(recordsDir, readdirSync(recordsDir).find((f) => f !== 'voice-profile.json')!);
  const md = readFileSync(join(folder, 'transcript.md'), 'utf8');
  console.log(md.split('\n').filter((l) => l.trim()).slice(0, 14).join('\n'));
  await app.close();
});
