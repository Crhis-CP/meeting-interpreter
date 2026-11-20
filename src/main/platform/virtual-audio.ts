/**
 * One-click install of the virtual audio device that carries the translated voice into meeting
 * apps. Always downloaded from the vendor at install time (never bundled):
 *  - macOS: BlackHole 2ch (existential.audio, GPL-3.0); URL and SHA-256 from Homebrew's cask API,
 *    verified before installing; the system asks for the administrator password once.
 *  - Windows: VB-CABLE (vb-audio.com, donationware), pinned by SHA-256; the setup's hash and
 *    Authenticode signature (VB-Audio's author) are checked again right before Windows asks for
 *    permission once.
 * Downloads go to a fresh private temp folder, and the check happens in the same elevated
 * command that installs, so nothing can swap the file in between.
 *  - Linux: a PulseAudio / PipeWire null sink plus a source from its monitor (no install).
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '../../core/log';

const BLACKHOLE_FALLBACK = {
  url: 'https://existential.audio/downloads/BlackHole2ch-0.7.1.pkg',
  sha256: '57b540f27a3e29c37e310e01bee0fdfab76733087e47f997ef9dccf851400dcf',
};
/** Apple Developer ID team of Existential Audio Inc. (BlackHole's publisher). */
const BLACKHOLE_TEAM = 'Q5C99V536K';
const VBCABLE = {
  url: 'https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack45.zip',
  sha256: 'b950e39f01af1d04ea623c8f6d8eb9b6ea5c477c637295fabf20631c85116bfb',
  setup: {
    x64: { name: 'VBCABLE_Setup_x64.exe', sha256: '734c35dfa6d98f48782a451633ceb471166ec70d60482fd89a1123d0ee3c4f41' },
    x86: { name: 'VBCABLE_Setup.exe', sha256: '01ffc86b623ff3c75a883aa900c0215a89482988e1c8e55988fc0a9fb513dbed' },
  },
  /** Authenticode signer of the setup (VB-Audio's author, EV certificate). */
  signer: 'BUREL VINCENT',
};
const MANUAL_HINT = '可以到官网手动下载安装（使用指南里有步骤）';

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
  if (digest !== meta.sha256) throw new Error(`下载的安装包校验不通过，已停止安装（请稍后重试，或${MANUAL_HINT}）`);
  const dir = mkdtempSync(join(tmpdir(), 'mi-driver-'));
  const path = join(dir, 'BlackHole2ch.pkg');
  writeFileSync(path, pkg, { mode: 0o600 });
  onProgress('正在安装（请在弹出的窗口里输入电脑密码）…');
  // As root: check the hash and the publisher's Apple signature again, then install; coreaudiod
  // is restarted so the new device shows up without a reboot.
  const shell = [
    `/usr/bin/shasum -a 256 ${sq(path)} | /usr/bin/grep -q ${sq(`^${meta.sha256} `)} || { echo MI_HASH_MISMATCH; exit 3; }`,
    `/usr/sbin/pkgutil --check-signature ${sq(path)} | /usr/bin/grep -q ${sq(`(${BLACKHOLE_TEAM})`)} || { echo MI_BAD_SIGNATURE; exit 4; }`,
    `/usr/sbin/installer -pkg ${sq(path)} -target /`,
    '(/bin/launchctl kickstart -kp system/com.apple.audio.coreaudiod || /usr/bin/killall coreaudiod || true)',
  ].join(' && ');
  const script = `do shell script ${JSON.stringify(shell)} with administrator privileges with prompt "会议同传助手要安装虚拟声卡 BlackHole（让会议软件听到译音）。"`;
  const r = await run('/usr/bin/osascript', ['-e', script]);
  if (r.code !== 0) {
    if (/-128|User canceled|用户已取消/i.test(r.out)) return { ok: false, message: '已取消安装' };
    if (/MI_HASH_MISMATCH|MI_BAD_SIGNATURE/.test(r.out)) throw new Error(`安装包校验不通过（文件被改动或签名不对），已停止安装。${MANUAL_HINT}`);
    throw new Error(`安装没有完成：${r.out.slice(0, 200)}`);
  }
  return { ok: true, message: '已安装 BlackHole 2ch' };
}

async function installWindows(fetchImpl: typeof fetch, onProgress: (t: string) => void): Promise<InstallResult> {
  const zip = await download(fetchImpl, VBCABLE.url, onProgress);
  if (createHash('sha256').update(zip).digest('hex') !== VBCABLE.sha256) throw new Error(`下载的安装包校验不通过（官网的文件和我们核对过的不一样），已停止安装。${MANUAL_HINT}`);
  const dir = mkdtempSync(join(tmpdir(), 'mi-driver-'));
  const zipPath = join(dir, 'VBCABLE.zip');
  const out = join(dir, 'VBCABLE');
  writeFileSync(zipPath, zip);
  onProgress('正在解压…');
  const ps = (cmd: string) => run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd]);
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const x = await ps(`Expand-Archive -Force -LiteralPath ${q(zipPath)} -DestinationPath ${q(out)}`);
  if (x.code !== 0) throw new Error(`解压失败：${x.out.slice(0, 200)}`);
  const want = process.arch === 'ia32' ? VBCABLE.setup.x86 : VBCABLE.setup.x64;
  const setup = join(out, want.name);
  onProgress('正在安装（请在弹出的窗口里点“是”，如果出现安装界面再点“Install Driver”）…');
  // Hash and signature are checked in the same command that asks Windows for permission.
  const r = await ps(
    [
      `$f = ${q(setup)}`,
      `if ((Get-FileHash -Algorithm SHA256 -LiteralPath $f).Hash.ToLower() -ne ${q(want.sha256)}) { Write-Output 'MI_HASH_MISMATCH'; exit 3 }`,
      `$s = Get-AuthenticodeSignature -LiteralPath $f`,
      `if ($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notmatch ${q(VBCABLE.signer)}) { Write-Output 'MI_BAD_SIGNATURE'; exit 4 }`,
      `Start-Process -FilePath $f -ArgumentList '-i','-h' -Verb RunAs -Wait`,
    ].join('; '),
  );
  if (r.code !== 0) {
    if (/MI_HASH_MISMATCH|MI_BAD_SIGNATURE/.test(r.out)) throw new Error(`安装程序校验不通过（文件被改动或签名不对），已停止安装。${MANUAL_HINT}`);
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
