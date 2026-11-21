import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { attachAppLogs, launchApp, mainWindow } from './helpers';

test.afterEach(async ({}, info) => attachAppLogs(info));

test('术语表: aliases are typed key by key — separators and multi-word Spanish included', async () => {
  const { app, dataDir } = await launchApp();
  const win = await mainWindow(app);
  await win.waitForLoadState('domcontentloaded');
  await win.getByRole('navigation').getByRole('button', { name: '术语表', exact: true }).click();
  await win.getByRole('button', { name: '+ 添加术语' }).click();
  await win.getByLabel('中文', { exact: true }).last().fill('报价单');
  await win.getByLabel('Español', { exact: true }).last().fill('cotización');
  await win.getByLabel('中文常被听成').last().pressSequentially('报价；包价单');
  await win.getByLabel('Español 常被听成').last().pressSequentially('plazo de entrega; cotizacion');
  await win.getByRole('button', { name: '保存' }).click();
  await expect
    .poll(() => {
      const gs = JSON.parse(readFileSync(join(dataDir, 'glossaries.json'), 'utf8')) as { glossaries?: { entries: { zh: string; aliasesZh: string[]; aliasesEs: string[] }[] }[] } | { entries: unknown[] }[];
      const all = (Array.isArray(gs) ? gs : gs.glossaries ?? []) as { entries: { zh: string; aliasesZh: string[]; aliasesEs: string[] }[] }[];
      const e = all.flatMap((g) => g.entries).find((x) => x.zh === '报价单');
      return e ? { zh: e.aliasesZh, es: e.aliasesEs } : null;
    })
    .toEqual({ zh: ['报价', '包价单'], es: ['plazo de entrega', 'cotizacion'] });
  await app.close();
});
