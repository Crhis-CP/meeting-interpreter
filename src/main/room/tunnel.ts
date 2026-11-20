import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../../core/log';

/**
 * cloudflared is pinned to one release; every download is checked against these SHA-256 sums
 * (and the installed binary again before each start), so a swapped download never runs.
 */
const VERSION = '2026.11.1';
const BASE = `https://github.com/cloudflare/cloudflared/releases/download/${VERSION}/`;
const ASSETS: Record<string, { file: string; sha256: string; binSha256: string; archive: boolean }> = {
  'win32-x64': { file: 'cloudflared-windows-amd64.exe', sha256: '341deda3db5ec498a0482254d6c38c0b7cf01a30c37bb5dd95d2216d08955e35', binSha256: '341deda3db5ec498a0482254d6c38c0b7cf01a30c37bb5dd95d2216d08955e35', archive: false },
  // No Windows-on-ARM build: Windows runs the x64 one.
  'win32-arm64': { file: 'cloudflared-windows-amd64.exe', sha256: '341deda3db5ec498a0482254d6c38c0b7cf01a30c37bb5dd95d2216d08955e35', binSha256: '341deda3db5ec498a0482254d6c38c0b7cf01a30c37bb5dd95d2216d08955e35', archive: false },
  'darwin-x64': { file: 'cloudflared-darwin-amd64.tgz', sha256: '5e0403b188dfee71fbd9b995e7dc9910d61b661c52371935ab6475d41185632f', binSha256: '52686df40889be19803c368470bd46d5228737462f10a40380bedb6af8ed49a2', archive: true },
  'darwin-arm64': { file: 'cloudflared-darwin-arm64.tgz', sha256: '02fe4bcf08f2c09699cff30658228a739a0c47fb75f3653d1b8772a27ade4462', binSha256: '1cd7041838e5b0943378763ca86ddc0af896d1727875f36b29f5cc35eb2c4df7', archive: true },
  'linux-x64': { file: 'cloudflared-linux-amd64', sha256: '97bb3b02d23a5980fc9c15a1a270e692da1923f103f920d5b16d4931d5ab55e7', binSha256: '97bb3b02d23a5980fc9c15a1a270e692da1923f103f920d5b16d4931d5ab55e7', archive: false },
  'linux-arm64': { file: 'cloudflared-linux-arm64', sha256: 'b155cec3e48e489cfb8e5c602769fb8c771083018d8881d68b4d18a791567c5a', binSha256: 'b155cec3e48e489cfb8e5c602769fb8c771083018d8881d68b4d18a791567c5a', archive: false },
};

export function cloudflaredAsset(platform: string = process.platform, arch: string = process.arch) {
  return ASSETS[`${platform}-${arch}`] ?? null;
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

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
    private readonly fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init),
  ) {}

  private binPath(): string {
    return join(this.dir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  }

  private async ensureBinary(): Promise<string> {
    const bin = this.binPath();
    const a = cloudflaredAsset();
    if (!a) throw new Error('当前系统不支持公网链接');
    // An installed copy runs only if it is exactly the pinned release.
    if (existsSync(bin) && sha256(readFileSync(bin)) === a.binSha256) return bin;
    mkdirSync(this.dir, { recursive: true });
    this.log.info(`downloading ${a.file} ${VERSION}`);
    const res = await this.fetchImpl(BASE + a.file, { redirect: 'follow' });
    if (!res.ok) throw new Error(`下载 cloudflared 失败（HTTP ${res.status}）`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (sha256(buf) !== a.sha256) throw new Error('下载的 cloudflared 校验不通过，已停止（请检查网络后重试）');
    const tmp = mkdtempSync(join(this.dir, 'dl-'));
    try {
      let binary: Buffer = buf;
      if (a.archive) {
        const tgz = join(tmp, a.file);
        writeFileSync(tgz, buf);
        await new Promise<void>((resolve, reject) => {
          const p = spawn('tar', ['-xzf', tgz, '-C', tmp, 'cloudflared']);
          p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('解压 cloudflared 失败'))));
          p.on('error', reject);
        });
        binary = readFileSync(join(tmp, 'cloudflared'));
      }
      if (sha256(binary) !== a.binSha256) throw new Error('cloudflared 校验不通过，已停止');
      const part = `${bin}.part`;
      writeFileSync(part, binary, { mode: 0o755 });
      renameSync(part, bin);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
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
