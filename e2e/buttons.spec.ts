import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { attachAppLogs, launchApp, mainWindow } from './helpers';

test.afterEach(async ({}, info) => attachAppLogs(info));

/**
 * 按钮全测: every button, switch and select on every page and settings tab is used once.
 * A control passes when it raises no error (no "出错了" toast, no window or app.log error — see
 * the zero-error rule in helpers) and a switch keeps its new state (it used to snap back).
 *
 * Controls with consequences carry data-test (enforced below for labels that sound like it):
 *  - "flow": a whole flow tested by its own spec (start a meeting, calibrate, record a voice)
 *  - "network": starts a download or calls an online service
 *  - "destructive": deletes something that matters (asks first)
 *  - "admin": needs an administrator password
 * Native file dialogs, external links and "open folder" are replaced in the main process, so
 * those buttons are used too.
 */
const SKIP = new Set(['flow', 'network', 'destructive', 'admin']);
const CONSEQUENTIAL = /下载|安装|卸载|删除|清除|移除|生成|开始同传|开启房间|结束会议|关闭房间|校准|开始录音|测试一下|预设|方案/;
const PAGES = ['会议同传', '现场房间', '会议记录', '术语表', '使用指南', '设置'];

async function stubNativeSide(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ dialog, shell }) => {
    const cancelled = async () => ({ canceled: true, filePaths: [] as string[], filePath: undefined });
    Object.assign(dialog, { showOpenDialog: cancelled, showSaveDialog: cancelled });
    Object.assign(shell, { openExternal: async () => undefined, openPath: async () => '', showItemInFolder: () => undefined, trashItem: async () => undefined });
  });
}

async function label(el: Locator): Promise<string> {
  return ((await el.getAttribute('aria-label')) || (await el.innerText().catch(() => '')) || '').trim().replace(/\s+/g, ' ');
}

/** Uses every control in the main area of the current page once. Returns labels that need a data-test. */
async function exercise(win: Page, where: string, reopen: () => Promise<void>): Promise<string[]> {
  const untagged: string[] = [];
  const done = new Set<string>();
  for (let round = 0; round < 200; round++) {
    // A switch is a visually hidden checkbox inside its visible label: use the label.
    const controls = win.locator('main button:visible, main label.toggle:visible, main select:visible');
    const n = await controls.count();
    let acted = false;
    for (let i = 0; i < n; i++) {
      const el = controls.nth(i);
      const tag = await el.evaluate((e) => e.tagName.toLowerCase()).catch(() => '');
      const isSwitch = tag === 'label';
      const role = isSwitch ? 'switch' : await el.getAttribute('role');
      const box = el.locator('input');
      const name = isSwitch ? (await label(el)) || ((await box.getAttribute('aria-label')) ?? '') : await label(el);
      const key = `${tag}:${role}:${name}`;
      if (done.has(key)) continue;
      done.add(key);
      const kind = (await el.getAttribute('data-test')) ?? (await el.evaluate((e) => e.closest('[data-test]')?.getAttribute('data-test') ?? null));
      // A switch only changes a setting; buttons with consequential labels must say what they do.
      const consequential = !isSwitch && CONSEQUENTIAL.test(name);
      if (!kind && consequential) untagged.push(`${where}: ${name}`);
      if ((kind && SKIP.has(kind)) || (!kind && consequential) || (await (isSwitch ? box : el).isDisabled())) continue;
      if (role === 'tab') continue; // the tabs are walked by the caller
      if (tag === 'select') {
        const values = await el.evaluate((e) => Array.from((e as unknown as { options: ArrayLike<{ value: string }> }).options, (o) => o.value));
        const before = await el.inputValue();
        const other = values.find((v) => v !== before);
        if (other !== undefined) {
          await el.selectOption(other, { timeout: 5000 });
          await win.waitForTimeout(200);
          // Changing one select may re-render or hide others; put the value back when it is still there.
          await el.selectOption(before, { timeout: 3000 }).catch(() => undefined);
        }
      } else if (role === 'switch') {
        const before = await box.isChecked();
        await el.click();
        await win.waitForTimeout(250);
        // The bug this guards: the switch saved the value but snapped back on screen.
        expect(await box.isChecked(), `${where}: switch "${name}" should stay ${!before ? 'on' : 'off'}`).toBe(!before);
        await el.click();
        await win.waitForTimeout(150);
      } else {
        await el.click();
        await win.waitForTimeout(250);
      }
      await expect(win.locator('.toast.error'), `${where}: "${name}"`).toHaveCount(0);
      await reopen();
      acted = true;
      break; // the page may have changed: query again
    }
    if (!acted) break;
  }
  if (process.env.MI_DEBUG_BUTTONS) console.log(`${where}: ${[...done].join(' | ')}`);
  return untagged;
}

test('按钮全测: every button, switch and select works and keeps its state', async () => {
  test.setTimeout(300_000);
  const { app } = await launchApp();
  const win = await mainWindow(app);
  await win.waitForLoadState('domcontentloaded');
  await stubNativeSide(app);
  win.on('dialog', (d) => void d.dismiss());
  const untagged: string[] = [];

  for (const page of PAGES) {
    const nav = win.getByRole('navigation').getByRole('button', { name: page, exact: true });
    await nav.click();
    if (page !== '设置') {
      untagged.push(...(await exercise(win, page, () => nav.click())));
      continue;
    }
    const tabs = win.getByRole('tab');
    await expect(tabs.first()).toBeVisible();
    const tabCount = await tabs.count();
    for (let t = 0; t < tabCount; t++) {
      const tabName = await label(tabs.nth(t));
      const openTab = async () => {
        await nav.click();
        await win.getByRole('tab', { name: tabName, exact: true }).click();
      };
      await openTab();
      untagged.push(...(await exercise(win, `设置 › ${tabName}`, openTab)));
    }
  }
  expect(untagged, 'buttons with consequences need data-test="flow|network|destructive|admin" (or "safe")').toEqual([]);
  await app.close();
});

test('字幕窗: buttons always visible, ✕ hides it, and it goes away when the meeting ends', async () => {
  const { app } = await launchApp({ ui: { overlay: { enabled: true } } });
  const win = await mainWindow(app);
  await win.waitForLoadState('domcontentloaded');
  const overlayVisible = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.getTitle() === '同传字幕' && w.isVisible()));

  await win.getByRole('button', { name: '开始同传' }).click();
  await expect.poll(overlayVisible).toBe(true);
  // It starts clear of the meeting app's toolbar at the bottom of the screen.
  const gap = await app.evaluate(({ BrowserWindow, screen }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() === '同传字幕')!;
    const a = screen.getPrimaryDisplay().workArea;
    const b = w.getBounds();
    return a.y + a.height - (b.y + b.height);
  });
  expect(gap).toBeGreaterThanOrEqual(140);
  await expect.poll(() => app.windows().some((p) => p.url().includes('overlay'))).toBe(true);
  const overlay = app.windows().find((p) => p.url().includes('overlay'))!;
  await expect(overlay.getByRole('button', { name: '关闭字幕窗' })).toBeVisible(); // no hover needed
  await overlay.getByRole('button', { name: '关闭字幕窗' }).click();
  await expect.poll(overlayVisible).toBe(false);

  await win.getByRole('button', { name: '字幕窗' }).click();
  await expect.poll(overlayVisible).toBe(true);
  await win.getByRole('button', { name: '结束会议' }).click();
  await expect(win.getByText('会议已结束')).toBeVisible({ timeout: 20_000 });
  await expect.poll(overlayVisible).toBe(false);
  await app.close();
});

test('快捷键: held only during a meeting, and not the everyday ones', async () => {
  const { app } = await launchApp();
  const win = await mainWindow(app);
  await win.waitForLoadState('domcontentloaded');
  const held = () =>
    app.evaluate(({ globalShortcut }) => ['CommandOrControl+Shift+S', 'CommandOrControl+Shift+M', 'CommandOrControl+Alt+Shift+O', 'CommandOrControl+Alt+Shift+M'].filter((a) => globalShortcut.isRegistered(a)));
  expect(await held()).toEqual([]);
  await win.getByRole('button', { name: '开始同传' }).click();
  await expect.poll(held).toEqual(['CommandOrControl+Alt+Shift+O', 'CommandOrControl+Alt+Shift+M']);
  await win.getByRole('button', { name: '结束会议' }).click();
  await expect(win.getByText('会议已结束')).toBeVisible({ timeout: 20_000 });
  await expect.poll(held).toEqual([]);
  await app.close();
});
