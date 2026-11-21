import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLogger } from '@core/log';
import { checkForUpdate, compareVersions, parseSums, pickAsset } from '../../src/main/update-check';
import { downloadUpdate } from '../../src/main/updater';

const GH = 'https://github.com/Crhis-CP/meeting-interpreter/releases/download/v0.9.0';
const ASSETS = [
  { name: 'MeetingInterpreter-0.9.0-mac-arm64.dmg', browser_download_url: `${GH}/MeetingInterpreter-0.9.0-mac-arm64.dmg`, size: 9 },
  { name: 'MeetingInterpreter-0.9.0-mac-x64.dmg', browser_download_url: `${GH}/MeetingInterpreter-0.9.0-mac-x64.dmg`, size: 9 },
  { name: 'MeetingInterpreter-0.9.0-windows-x64-setup.exe', browser_download_url: `${GH}/MeetingInterpreter-0.9.0-windows-x64-setup.exe`, size: 9 },
  { name: 'MeetingInterpreter-0.9.0-linux-x86_64.AppImage', browser_download_url: `${GH}/MeetingInterpreter-0.9.0-linux-x86_64.AppImage`, size: 9 },
  { name: 'SHA256SUMS.txt', browser_download_url: `${GH}/SHA256SUMS.txt`, size: 9 },
  { name: 'evil.exe', browser_download_url: 'https://evil.example/evil.exe', size: 9 },
];

describe('update check', () => {
  it('compares versions', () => {
    expect(compareVersions('v0.2.0', '0.1.9')).toBe(1);
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0);
    expect(compareVersions('0.1.0', '0.10.0')).toBe(-1);
  });

  it('reports a newer release with its notes and installers, and ignores older ones or failures', async () => {
    const reply = (tag: string) => (async () => new Response(JSON.stringify({ tag_name: tag, html_url: 'https://x/rel', body: '- 修复', assets: ASSETS }))) as unknown as typeof fetch;
    const log = createLogger('t');
    const u = await checkForUpdate('0.1.0', log, reply('v0.2.0'));
    expect(u).toMatchObject({ version: '0.2.0', url: 'https://x/rel', notes: '- 修复' });
    expect(u!.assets.map((a) => a.name)).not.toContain('evil.exe'); // only files on GitHub
    expect(await checkForUpdate('0.2.0', log, reply('v0.2.0'))).toBeNull();
    expect(await checkForUpdate('0.1.0', log, (async () => { throw new Error('offline'); }) as unknown as typeof fetch)).toBeNull();
  });

  it('picks the installer for this computer', () => {
    const assets = ASSETS.map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size }));
    expect(pickAsset(assets, 'darwin', 'arm64')?.name).toMatch(/mac-arm64\.dmg$/);
    expect(pickAsset(assets, 'darwin', 'x64')?.name).toMatch(/mac-x64\.dmg$/);
    expect(pickAsset(assets, 'win32', 'x64')?.name).toMatch(/windows-x64-setup\.exe$/);
    expect(pickAsset(assets, 'linux', 'x64')).toBeNull();
  });

  it('reads sha256sum output', () => {
    const h = 'a'.repeat(64);
    expect(parseSums(`${h}  MeetingInterpreter-0.9.0-mac-arm64.dmg\n${'b'.repeat(64)} *SHA256SUMS.txt\ngarbage`).get('MeetingInterpreter-0.9.0-mac-arm64.dmg')).toBe(h);
  });
});

describe('one-click update download', () => {
  const installer = new TextEncoder().encode('the real installer');
  const good = createHash('sha256').update(installer).digest('hex');
  const info = (sums: string) => ({ version: '0.9.0', url: 'x', notes: '', assets: ASSETS.slice(0, 5).map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size })), sums });
  const serve = (sums: string, body: Uint8Array) =>
    (async (url: string) => (String(url).endsWith('SHA256SUMS.txt') ? new Response(sums) : new Response(body, { headers: { 'content-length': String(body.length) } }))) as unknown as typeof fetch;

  it('downloads this computer’s installer and keeps it only when its SHA-256 matches the release', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mi-upd-'));
    const sums = `${good}  MeetingInterpreter-0.9.0-windows-x64-setup.exe\n`;
    const progress: number[] = [];
    const file = await downloadUpdate({ info: info(sums), platform: 'win32', arch: 'x64', dir, fetch: serve(sums, installer), onProgress: (p) => progress.push(p.received) });
    expect(readFileSync(file)).toEqual(Buffer.from(installer));
    expect(progress.at(-1)).toBe(installer.length);
  });

  it('deletes a download that does not match, and never updates without the checksum', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mi-upd-'));
    const sums = `${good}  MeetingInterpreter-0.9.0-mac-arm64.dmg\n`;
    await expect(downloadUpdate({ info: info(sums), platform: 'darwin', arch: 'arm64', dir, fetch: serve(sums, new TextEncoder().encode('tampered')) })).rejects.toThrow(/校验不通过/);
    expect(existsSync(join(dir, 'MeetingInterpreter-0.9.0-mac-arm64.dmg'))).toBe(false);
    await expect(downloadUpdate({ info: info(''), platform: 'darwin', arch: 'arm64', dir, fetch: serve('', installer) })).rejects.toThrow(/校验文件里没有/);
  });
});
