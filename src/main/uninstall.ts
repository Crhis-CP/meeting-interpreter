/**
 * 彻底卸载: everything the app put on this computer goes, after a backup of what the user made
 * (glossaries, accent profile, settings without keys) to the Downloads folder.
 *  - the data folder (models, caches, settings, keys): deleted after the app has quit (Chromium keeps
 *    some of its files open while it runs, Windows refuses to delete those);
 *  - the meeting records: only when ticked, and to the Trash, never deleted outright;
 *  - the virtual audio driver: only when ticked (other apps may use it);
 *  - the app: moved to the Trash (Mac) or its uninstaller run (Windows).
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join, parse, resolve, sep } from 'node:path';
import { glossaryToCsv } from '../core/glossary/csv';
import type { Glossary } from '../core/glossary/types';
import type { UninstallItem, UninstallPlan } from '../shared/ipc';
import { dirBytes } from './providers/local-asr/model-manager';

export type { UninstallItem, UninstallPlan };

export function planUninstall(o: { dataDir: string; recordsDir: string; downloadsDir: string; appPath: string | null; platform: NodeJS.Platform; driverName: string | null; now?: Date }): UninstallPlan {
  const day = (o.now ?? new Date()).toISOString().slice(0, 10);
  const items: UninstallItem[] = [
    { id: 'data', label: '模型、缓存、设置和 Key', path: o.dataDir, bytes: dirBytes(o.dataDir), byDefault: true },
    { id: 'records', label: '会议记录（录音、录屏、双语记录、纪要）和口音档案', path: o.recordsDir, bytes: dirBytes(o.recordsDir), byDefault: false, note: '勾选后移到废纸篓，不会直接删掉' },
  ];
  if (o.driverName) items.push({ id: 'driver', label: `虚拟声卡 ${o.driverName}`, path: null, bytes: 0, byDefault: false, note: '其他软件（录屏、直播等）可能也在用；需要输入一次电脑密码' });
  if (o.appPath) items.push({ id: 'app', label: o.platform === 'darwin' ? '软件本身（移到废纸篓）' : '软件本身（运行卸载程序）', path: o.appPath, bytes: 0, byDefault: true });
  return { items, backupDir: join(o.downloadsDir, `会议同传助手备份-${day}`) };
}

/** Writes the backup: each glossary as CSV, the accent profile, the settings (no keys). Returns the files. */
export function writeBackup(dir: string, data: { glossaries: Glossary[]; profileJson: string | null; settingsJson: string }): string[] {
  mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  const write = (name: string, text: string) => {
    const p = join(dir, name);
    writeFileSync(p, text, 'utf8');
    files.push(p);
  };
  data.glossaries.forEach((g, i) => write(`术语表-${safeName(g.name) || i + 1}.csv`, glossaryToCsv(g.entries)));
  if (data.profileJson) write('口音档案.json', data.profileJson);
  write('设置.json', data.settingsJson);
  write('说明.txt', '会议同传助手卸载前的备份。\n重新安装后：术语表在“术语表 › 导入 CSV”里导入；口音档案在“设置 › 同传与语言 › 导入”。\n');
  return files;
}

const safeName = (s: string) => s.replace(/[\\/:*?"<>|\n\r\t]/g, ' ').trim().slice(0, 40);

/**
 * A folder the app may delete wholesale: an absolute path, not a filesystem root, not the home
 * folder or one of its direct standard folders, and named like the app (or a test folder).
 */
export function safeToDelete(dir: string, home: string): boolean {
  const p = resolve(dir);
  if (!p || p === parse(p).root) return false;
  const h = resolve(home);
  if (p === h || resolve(p, '..') === h && /^(Desktop|Documents|Downloads|Library|AppData|桌面|文档|下载)$/i.test(basename(p))) return false;
  if (p.split(sep).filter(Boolean).length < 2) return false;
  return /meeting-?interpreter|会议同传|^mi-e2e-/i.test(basename(p));
}

/** Windows: the clean-up itself (PowerShell), run once the app has quit. */
export function windowsCleanupScript(pid: number, dataDir: string, uninstaller: string | null, trace?: string): string {
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const note = (what: string) => (trace ? [`Add-Content -LiteralPath ${q(trace)} -Value ((Get-Date -Format o) + ' ${what}')`] : []);
  return [
    ...note('waiting for the app to quit'),
    `Wait-Process -Id ${pid} -ErrorAction SilentlyContinue`,
    ...note('the app has quit'),
    // The app's helper processes can hold files for a moment after it quits: retry for half a minute.
    `for ($i = 0; ($i -lt 30) -and (Test-Path -LiteralPath ${q(dataDir)}); $i++) { Start-Sleep -Seconds 1; Remove-Item -LiteralPath ${q(dataDir)} -Recurse -Force -ErrorAction SilentlyContinue }`,
    ...note(`data folder still there: ' + (Test-Path -LiteralPath ${q(dataDir)}) + '`),
    ...(uninstaller ? [`Start-Process -FilePath ${q(uninstaller)} -ArgumentList '/S' -Wait`] : []),
  ].join('; ');
}

/**
 * The command that finishes the job once the app has quit: waits for the process to end, deletes
 * the data folder, and (Windows) runs the uninstaller quietly. On Windows it is started by a
 * short-lived launcher that hands it on (so it is not part of the app's process tree: ending the
 * app's tree, as test harnesses and some tools do, would end the clean-up with it) and exits with
 * the clean-up's process id, so the app knows it is running before it quits.
 */
export function afterExitCommand(platform: NodeJS.Platform, pid: number, dataDir: string, uninstaller: string | null, trace?: string): { cmd: string; args: string[] } {
  if (platform === 'win32') {
    const encoded = Buffer.from(windowsCleanupScript(pid, dataDir, uninstaller, trace), 'utf16le').toString('base64');
    const handOn = `$p = Start-Process -FilePath powershell.exe -WindowStyle Hidden -PassThru -ErrorAction Stop -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded}'; exit $p.Id`;
    return { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', handOn] };
  }
  const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  // (spawned detached: on Mac and Linux that is its own session, outside the app's process group)
  return { cmd: '/bin/sh', args: ['-c', `while kill -0 ${pid} 2>/dev/null; do sleep 0.5; done; sleep 1; rm -rf ${sq(dataDir)}`] };
}

type Spawn = typeof nodeSpawn;

/**
 * Starts the clean-up and resolves with its process id once it runs on its own; rejects with the
 * reason if it could not be started (the app then stays open and says so, rather than quitting and
 * silently leaving gigabytes behind).
 * Windows: the launcher exits with the clean-up's process id (process ids are multiples of 4, never
 * 0 or 1, PowerShell's own exit codes). A PowerShell can take seconds to start on a busy computer,
 * hence the generous wait.
 */
export function startAfterExit(platform: NodeJS.Platform, command: { cmd: string; args: string[] }, spawn: Spawn = nodeSpawn, timeoutMs = 45_000): Promise<number> {
  return new Promise((resolve, reject) => {
    if (platform !== 'win32') {
      const child = spawn(command.cmd, command.args, { detached: true, stdio: 'ignore' });
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolve(child.pid ?? 0);
      });
      return;
    }
    const child = spawn(command.cmd, command.args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    const fail = (why: string) => reject(new Error(`清理程序没有启动：${why}`));
    const timer = setTimeout(() => {
      child.kill();
      fail(`${Math.round(timeoutMs / 1000)} 秒内没有回应`);
    }, timeoutMs);
    child.once('error', (err) => {
      clearTimeout(timer);
      fail(err.message);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code !== null && code > 1) return resolve(code);
      // The launcher started nothing, so its error output ends right after it.
      const why = () => `退出码 ${code ?? '无'}${stderr.trim() ? `，${stderr.trim().slice(0, 400)}` : ''}`;
      if (!child.stderr || child.stderr.readableEnded) fail(why());
      else child.stderr.once('end', () => fail(why()));
    });
  });
}
