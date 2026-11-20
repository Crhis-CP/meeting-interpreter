/**
 * One-click install of the virtual audio device that carries the translated voice into meeting
 * apps. Always downloaded from the vendor at install time (never bundled):
 *  - macOS: BlackHole 2ch (existential.audio, GPL-3.0); URL and SHA-256 from Homebrew's cask API,
 *    verified before installing; the system asks for the administrator password once.
 *  - Windows: VB-CABLE (vb-audio.com, donationware); Windows asks for permission once.
 *  - Linux: a PulseAudio / PipeWire null sink plus a source from its monitor (no install).
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '../../core/log';

const BLACKHOLE_FALLBACK = {
  url: 'https://existential.audio/downloads/BlackHole2ch-0.7.1.pkg',
  sha256: '57b540f27a3e29c37e310e01bee0fdfab76733087e47f997ef9dccf851400dcf',
};
const VBCABLE_URL = 'https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack45.zip';

export interface InstallResult {
  ok: boolean;
  message: string;
}

function run(cmd: string, args: string[], timeoutMs = 300_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0;
      resolve({ code, out: `${stdout ?? ''}${stderr ?? ''}`.trim() });
    });
  });
}

async function download(fetchImpl: typeof fetch, url: string, onProgress: (text: string) => void): Promise<Uint8Array> {
  onProgress('正在从官网下载…');
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(180_000) });
  if (!res.ok) throw new Error(`下载失败（HTTP ${res.status}）`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Escapes a value for a single-quoted POSIX shell word. */
const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

async function installMac(fetchImpl: typeof fetch, log: Logger, onProgress: (t: string) => void): Promise<InstallResult> {
  let meta = BLACKHOLE_FALLBACK;
  try {
    const r = await fetchImpl('https://formulae.brew.sh/api/cask/blackhole-2ch.json', { signal: AbortSignal.timeout(15_000) });
    const j = (await r.json()) as { url?: string; sha256?: string };
    if (j.url?.startsWith('https://existential.audio/') && /^[0-9a-f]{64}$/.test(j.sha256 ?? '')) meta = { url: j.url, sha256: j.sha256! };
  } catch (err) {
    log.debug('brew cask lookup failed, using the pinned BlackHole release', err instanceof Error ? err.message : String(err));
  }
  const pkg = await download(fetchImpl, meta.url, onProgress);
  const digest = createHash('sha256').update(pkg).digest('hex');
  if (digest !== meta.sha256) throw new Error('下载的安装包校验不通过，已停止安装（请稍后重试）');
  const dir = join(tmpdir(), 'meeting-interpreter-driver');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'BlackHole2ch.pkg');
  writeFileSync(path, pkg);
  onProgress('正在安装（请在弹出的窗口里输入电脑密码）…');
  // installer needs root; coreaudiod is restarted so the new device shows up without a reboot.
  const shell = `/usr/sbin/installer -pkg ${sq(path)} -target / && (/bin/launchctl kickstart -kp system/com.apple.audio.coreaudiod || /usr/bin/killall coreaudiod || true)`;
  const script = `do shell script ${JSON.stringify(shell)} with administrator privileges with prompt "会议同传助手要安装虚拟声卡 BlackHole（让会议软件听到译音）。"`;
  const r = await run('/usr/bin/osascript', ['-e', script]);
  if (r.code !== 0) {
    if (/-128|User canceled|用户已取消/i.test(r.out)) return { ok: false, message: '已取消安装' };
    throw new Error(`安装没有完成：${r.out.slice(0, 200)}`);
  }
  return { ok: true, message: '已安装 BlackHole 2ch' };
}

async function installWindows(fetchImpl: typeof fetch, onProgress: (t: string) => void): Promise<InstallResult> {
  const zip = await download(fetchImpl, VBCABLE_URL, onProgress);
  const dir = join(tmpdir(), 'meeting-interpreter-driver');
  mkdirSync(dir, { recursive: true });
  const zipPath = join(dir, 'VBCABLE.zip');
  const out = join(dir, 'VBCABLE');
  writeFileSync(zipPath, zip);
  onProgress('正在解压…');
  const ps = (cmd: string) => run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd]);
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const x = await ps(`Expand-Archive -Force -LiteralPath ${q(zipPath)} -DestinationPath ${q(out)}`);
  if (x.code !== 0) throw new Error(`解压失败：${x.out.slice(0, 200)}`);
  const setup = join(out, process.arch === 'arm64' ? 'VBCABLE_Setup_x64.exe' : process.arch === 'x64' ? 'VBCABLE_Setup_x64.exe' : 'VBCABLE_Setup.exe');
  onProgress('正在安装（请在弹出的窗口里点“是”，如果出现安装界面再点“Install Driver”）…');
  const r = await ps(`Start-Process -FilePath ${q(setup)} -ArgumentList '-i','-h' -Verb RunAs -Wait`);
  if (r.code !== 0) {
    if (/canceled|取消/i.test(r.out)) return { ok: false, message: '已取消安装' };
    throw new Error(`安装没有完成：${r.out.slice(0, 200)}`);
  }
  return { ok: true, message: '已安装 VB-CABLE（如果设备列表里还没有，重启电脑后再看）' };
}

async function installLinux(): Promise<InstallResult> {
  const list = await run('pactl', ['list', 'short', 'sinks']);
  if (list.code !== 0) throw new Error('没有找到 pactl（需要 PulseAudio 或 PipeWire）');
  if (!/MI_Translated/.test(list.out)) {
    const a = await run('pactl', ['load-module', 'module-null-sink', 'sink_name=MI_Translated', 'sink_properties=device.description=MI_Translated']);
    if (a.code !== 0) throw new Error(`创建失败：${a.out}`);
    await run('pactl', ['load-module', 'module-remap-source', 'master=MI_Translated.monitor', 'source_name=MI_Translated_Mic', 'source_properties=device.description=MI_Translated_Mic']);
  }
  return { ok: true, message: '已创建虚拟麦克风 MI_Translated_Mic（重启电脑后需要再点一次）' };
}

export async function installVirtualAudio(fetchImpl: typeof fetch, log: Logger, onProgress: (text: string) => void): Promise<InstallResult> {
  if (process.platform === 'darwin') return installMac(fetchImpl, log, onProgress);
  if (process.platform === 'win32') return installWindows(fetchImpl, onProgress);
  return installLinux();
}
