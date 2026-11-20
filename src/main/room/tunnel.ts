import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../../core/log';

const BASE = 'https://github.com/cloudflare/cloudflared/releases/latest/download/';

function asset(): { file: string; archive: boolean } | null {
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'amd64' : null;
  if (!arch) return null;
  if (process.platform === 'win32') return { file: `cloudflared-windows-${arch}.exe`, archive: false };
  if (process.platform === 'darwin') return { file: `cloudflared-darwin-${arch}.tgz`, archive: true };
  if (process.platform === 'linux') return { file: `cloudflared-linux-${arch}`, archive: false };
  return null;
}

/**
 * A free Cloudflare "quick tunnel" (no account) that gives the local room server a public HTTPS
 * address, so people outside the Wi-Fi — e.g. on a video call — can join from their phones.
 * cloudflared (Apache-2.0) is downloaded on first use.
 */
export class TunnelManager {
  private child: ChildProcess | null = null;

  constructor(
    private readonly dir: string,
    private readonly log: Logger,
  ) {}

  private binPath(): string {
    return join(this.dir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  }

  private async ensureBinary(): Promise<string> {
    const bin = this.binPath();
    if (existsSync(bin) && statSync(bin).size > 1_000_000) return bin;
    const a = asset();
    if (!a) throw new Error('当前系统不支持公网链接');
    mkdirSync(this.dir, { recursive: true });
    this.log.info(`downloading ${a.file}`);
    const res = await fetch(BASE + a.file, { redirect: 'follow' });
    if (!res.ok) throw new Error(`下载 cloudflared 失败（HTTP ${res.status}）`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1_000_000) throw new Error('下载的 cloudflared 文件不完整');
    if (a.archive) {
      const tgz = join(this.dir, a.file);
      writeFileSync(tgz, buf);
      await new Promise<void>((resolve, reject) => {
        const p = spawn('tar', ['-xzf', tgz, '-C', this.dir]);
        p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('解压 cloudflared 失败'))));
        p.on('error', reject);
      });
    } else {
      const tmp = `${bin}.part`;
      writeFileSync(tmp, buf);
      renameSync(tmp, bin);
    }
    if (process.platform !== 'win32') chmodSync(bin, 0o755);
    return bin;
  }

  /** Starts the tunnel to `localUrl` and resolves with the public https URL. */
  async start(localUrl: string): Promise<string> {
    this.stop();
    const bin = await this.ensureBinary();
    return new Promise((resolve, reject) => {
      const child = spawn(bin, ['tunnel', '--no-autoupdate', '--url', localUrl, '--no-tls-verify'], { windowsHide: true });
      this.child = child;
      let done = false;
      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          reject(new Error('创建公网链接超时，请检查网络（需要能访问 Cloudflare）'));
          this.stop();
        }
      }, 45000);
      const onData = (d: Buffer) => {
        const m = d.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (m && !done) {
          done = true;
          clearTimeout(timer);
          resolve(m[0]);
        }
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.on('exit', (code) => {
        this.child = null;
        if (!done) {
          done = true;
          clearTimeout(timer);
          reject(new Error(`cloudflared 退出（${code}）`));
        }
      });
      child.on('error', (err) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  stop(): void {
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
  }

  get running(): boolean {
    return this.child !== null;
  }
}
