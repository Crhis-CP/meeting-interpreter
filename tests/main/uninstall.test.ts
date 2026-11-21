import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { afterExitCommand, planUninstall, safeToDelete, startAfterExit, windowsCleanupScript, writeBackup } from '../../src/main/uninstall';

describe('彻底卸载', () => {
  it('lists what goes and what stays unless ticked, with sizes', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'MeetingInterpreter-'));
    const recordsDir = mkdtempSync(join(tmpdir(), 'mi-rec-'));
    mkdirSync(join(dataDir, 'models'), { recursive: true });
    writeFileSync(join(dataDir, 'models', 'm.bin'), new Uint8Array(4000));
    writeFileSync(join(recordsDir, 'meeting.json'), '{}');
    const plan = planUninstall({ dataDir, recordsDir, downloadsDir: '/home/u/Downloads', appPath: '/Applications/MeetingInterpreter.app', platform: 'darwin', driverName: 'BlackHole 2ch', now: new Date('2026-12-01T10:00:00Z') });
    expect(plan.items.map((i) => [i.id, i.byDefault])).toEqual([['data', true], ['records', false], ['driver', false], ['app', true]]);
    expect(plan.items[0]!.bytes).toBe(4000);
    expect(plan.items[2]!.note).toMatch(/其他软件/);
    expect(plan.backupDir).toBe(join('/home/u/Downloads', '会议同传助手备份-2026-12-01'));
    // No driver installed, running from source: nothing to offer for them.
    expect(planUninstall({ dataDir, recordsDir, downloadsDir: '/d', appPath: null, platform: 'linux', driverName: null }).items.map((i) => i.id)).toEqual(['data', 'records']);
  });

  it('backs up the glossaries, the accent profile and the settings (never the keys)', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'mi-dl-')), '备份');
    const files = writeBackup(dir, {
      glossaries: [{ id: 'g1', name: '客户/报价', enabled: true, entries: [{ id: 'e', zh: '报价单', es: 'cotización', aliasesZh: [], aliasesEs: [], note: '', enabled: true }] }],
      profileJson: '{"rules":[]}',
      settingsJson: '{"preset":"free"}',
    });
    expect(files.map((f) => f.slice(dir.length + 1))).toEqual(['术语表-客户 报价.csv', '口音档案.json', '设置.json', '说明.txt']);
    expect(readFileSync(files[0]!, 'utf8')).toContain('cotización');
  });

  it('deletes only a folder that is clearly the app’s', () => {
    const home = homedir();
    expect(safeToDelete(join(home, 'Library', 'Application Support', 'MeetingInterpreter'), home)).toBe(true);
    expect(safeToDelete(join(tmpdir(), 'mi-e2e-data-abc'), home)).toBe(true);
    for (const bad of ['/', home, join(home, 'Documents'), join(home, 'Downloads'), '/tmp', join(home, 'Library', 'Application Support')]) expect(safeToDelete(bad, home), bad).toBe(false);
  });

  it('finishes after the app has quit: waits for it, deletes the folder, runs the Windows uninstaller quietly', () => {
    const mac = afterExitCommand('darwin', 4242, "/Users/li/Library/Application Support/MeetingInterpreter", null);
    expect(mac.cmd).toBe('/bin/sh');
    expect(mac.args[1]).toContain('kill -0 4242');
    expect(mac.args[1]).toContain("rm -rf '/Users/li/Library/Application Support/MeetingInterpreter'");
    const win = afterExitCommand('win32', 7, "C:\\Users\\o'neil\\AppData\\Local\\MeetingInterpreter", 'C:\\Programs\\MeetingInterpreter\\Uninstall MeetingInterpreter.exe');
    expect(win.cmd).toBe('powershell.exe');
    // Handed on to a process outside the app's tree, as an encoded script…
    const handOn = win.args.at(-1)!;
    expect(handOn).toMatch(/^\$p = Start-Process -FilePath powershell\.exe .*-PassThru .*-EncodedCommand','[A-Za-z0-9+/=]+'; exit \$p\.Id$/);
    const script = Buffer.from(/EncodedCommand','([^']+)'/.exec(handOn)![1]!, 'base64').toString('utf16le');
    expect(script).toBe(windowsCleanupScript(7, "C:\\Users\\o'neil\\AppData\\Local\\MeetingInterpreter", 'C:\\Programs\\MeetingInterpreter\\Uninstall MeetingInterpreter.exe'));
    // …which waits, deletes (with retries) and runs the uninstaller quietly.
    expect(script).toContain('Wait-Process -Id 7');
    expect(script).toContain("'C:\\Users\\o''neil\\AppData\\Local\\MeetingInterpreter'"); // quoted for PowerShell
    expect(script).toContain('$i -lt 30');
    expect(script).toContain("-ArgumentList '/S'");
  });

  // A stand-in for child_process.spawn: a process that exits with `code` after writing `stderr`.
  const fakeSpawn = (code: number | null, stderr = '', opts: { spawnError?: Error } = {}) => {
    const calls: unknown[][] = [];
    const spawn = ((...a: unknown[]) => {
      calls.push(a);
      const child = Object.assign(new EventEmitter(), { pid: 99, stderr: new PassThrough(), unref: () => undefined, kill: () => true });
      setImmediate(() => {
        if (opts.spawnError) return void child.emit('error', opts.spawnError);
        child.emit('spawn');
        if (code === null) return;
        child.stderr.end(stderr);
        child.emit('exit', code);
      });
      return child;
    }) as unknown as typeof import('node:child_process').spawn;
    return { spawn, calls };
  };

  it('the app quits only once the clean-up runs on its own; otherwise it says why', async () => {
    const cmd = { cmd: 'powershell.exe', args: ['-Command', 'x'] };
    // Windows: the launcher exits with the clean-up's process id.
    await expect(startAfterExit('win32', cmd, fakeSpawn(5124).spawn)).resolves.toBe(5124);
    // PowerShell's own failure (exit code 1) with its message.
    await expect(startAfterExit('win32', cmd, fakeSpawn(1, 'Start-Process : Access is denied').spawn)).rejects.toThrow(/退出码 1，Start-Process : Access is denied/);
    await expect(startAfterExit('win32', cmd, fakeSpawn(0, '', { spawnError: new Error('spawn powershell.exe ENOENT') }).spawn)).rejects.toThrow(/ENOENT/);
    await expect(startAfterExit('win32', cmd, fakeSpawn(null).spawn, 50)).rejects.toThrow(/没有回应/);
    // Mac and Linux: a detached shell, running as soon as it has started.
    const unix = fakeSpawn(null);
    await expect(startAfterExit('darwin', { cmd: '/bin/sh', args: ['-c', 'x'] }, unix.spawn)).resolves.toBe(99);
    expect(unix.calls[0]![2]).toMatchObject({ detached: true, stdio: 'ignore' });
  });
});
