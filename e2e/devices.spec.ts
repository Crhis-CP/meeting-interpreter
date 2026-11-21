import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { allowErrors, attachAppLogs, launchApp, mainWindow } from './helpers';

test.afterEach(async ({}, info) => attachAppLogs(info));

/** What Chromium lists on Windows right after installing VB-CABLE: it became the default playback and recording device. */
const WINDOWS_AFTER_CABLE = [
  { deviceId: 'default', kind: 'audioinput', label: 'Default - CABLE Output (VB-Audio Virtual Cable)', groupId: 'g-cable' },
  { deviceId: 'rt-mic', kind: 'audioinput', label: 'Microphone (Realtek(R) Audio)', groupId: 'g-rt' },
  { deviceId: 'cable-out', kind: 'audioinput', label: 'CABLE Output (VB-Audio Virtual Cable)', groupId: 'g-cable' },
  { deviceId: 'default', kind: 'audiooutput', label: 'Default - CABLE Input (VB-Audio Virtual Cable)', groupId: 'g-cable' },
  { deviceId: 'rt-spk', kind: 'audiooutput', label: 'Speakers (Realtek(R) Audio)', groupId: 'g-rt' },
  { deviceId: 'cable-in', kind: 'audiooutput', label: 'CABLE Input (VB-Audio Virtual Cable)', groupId: 'g-cable' },
];

/** Replaces the window's device list (and tells it the devices changed). */
async function fakeDevices(page: Page, list: typeof WINDOWS_AFTER_CABLE): Promise<void> {
  await page.evaluate((l) => {
    // (This runs in the page; the test's own types have no DOM.)
    const md = (globalThis as unknown as { navigator: { mediaDevices: { enumerateDevices: () => Promise<unknown[]>; dispatchEvent: (e: unknown) => void } } }).navigator.mediaDevices;
    md.enumerateDevices = async () => l.map((d) => ({ ...d, toJSON: () => d }));
    md.dispatchEvent(new Event('devicechange'));
  }, list);
}

const settingsOf = (dataDir: string) => JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8')) as { devices: Record<string, string>; ui: { dismissed: string[] } };

test('设备检查: after VB-CABLE took over the defaults, loops are shown with one-click fixes', async () => {
  const { app, dataDir } = await launchApp({ devices: { meetingSource: 'none', virtualMic: 'cable-in' } });
  const win = await mainWindow(app);
  await win.waitForLoadState('domcontentloaded');
  await expect(win.getByRole('button', { name: '开始同传' })).toBeVisible();
  await fakeDevices(win, WINDOWS_AFTER_CABLE);
  // Open the page again so the check reads the list afresh (not only on the change event).
  const nav = (name: RegExp) => win.getByRole('navigation').getByRole('button', { name });
  await nav(/^词库/).click();
  await nav(/^会议同传/).click();

  const check = win.getByLabel('设备检查');
  await expect(check.getByText(/它是虚拟麦克风的另一端/))
    .toBeVisible()
    .catch(async (err: unknown) => {
      const seen = await win.evaluate(async () => JSON.stringify(await (globalThis as unknown as { navigator: { mediaDevices: { enumerateDevices(): Promise<unknown> } } }).navigator.mediaDevices.enumerateDevices()));
      throw new Error(`${String(err)}\ndevices seen by the page: ${seen}\nsettings: ${JSON.stringify(settingsOf(dataDir).devices)}`);
    });
  await expect(check.getByText(/给你听的中文会被送进会议/)).toBeVisible();
  await expect(check.getByText(/电脑的默认播放设备是虚拟声卡/)).toBeVisible();

  await check.getByRole('button', { name: '改用 Microphone (Realtek(R) Audio)' }).click();
  await check.getByRole('button', { name: '改用 Speakers (Realtek(R) Audio)' }).click();
  await expect.poll(() => settingsOf(dataDir).devices).toMatchObject({ mic: 'rt-mic', headphones: 'rt-spk' });
  await expect(check.getByText(/虚拟麦克风的另一端|送进会议/)).toHaveCount(0);

  // The system default is the user's call: "on purpose" stops the warning for that device.
  await check.getByRole('button', { name: '这是我故意的' }).first().click();
  await expect.poll(() => settingsOf(dataDir).ui.dismissed).toContain('system-output-virtual:CABLE Input (VB-Audio Virtual Cable)');
  await expect(check.getByText(/默认播放设备/)).toHaveCount(0);

  // Settings refuse to choose the other end of the virtual mic as the microphone.
  await win.getByRole('navigation').getByRole('button', { name: '设置', exact: true }).click();
  await win.getByRole('tab', { name: '音频设备' }).click();
  await win.getByLabel('① 我的麦克风（我说中文）').selectOption('cable-out');
  await expect(win.getByRole('alert').filter({ hasText: '没有改' })).toBeVisible();
  expect(settingsOf(dataDir).devices.mic).toBe('rt-mic');
  await app.close();
});

test('设备检查: the audio engine never opens a loop, and says why', async () => {
  // The faked virtual mic ('cable-in') does not exist on this machine: opening it for output fails.
  allowErrors(/AudioContext encountered an error from the audio device/);
  const { app } = await launchApp({ devices: { meetingSource: 'none', virtualMic: 'cable-in' } });
  const win = await mainWindow(app);
  await win.waitForLoadState('domcontentloaded');
  await expect.poll(() => app.windows().some((p) => p.url().includes('audio'))).toBe(true);
  const audio = app.windows().find((p) => p.url().includes('audio'))!;
  await audio.waitForFunction(() => 'mediaDevices' in (globalThis as unknown as { navigator: object }).navigator);
  await fakeDevices(audio, WINDOWS_AFTER_CABLE);

  await win.getByRole('button', { name: '开始同传' }).click();
  await expect(win.getByRole('alert').filter({ hasText: '没有打开麦克风' })).toBeVisible({ timeout: 20_000 });
  await expect(win.getByRole('alert').filter({ hasText: '中文译音不播放' })).toBeVisible();
  await win.getByRole('button', { name: '结束会议' }).click();
  await expect(win.getByText('会议已结束')).toBeVisible({ timeout: 20_000 });
  // The meeting app still listens to the virtual mic: remind to switch it back (once dismissed, never again).
  await win.getByRole('button', { name: '知道了，不再提示' }).click();
  await expect(win.getByText(/改回你自己的麦克风/)).toHaveCount(0);
  await app.close();
});
