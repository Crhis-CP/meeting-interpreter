/**
 * One-click update: downloads this computer's installer from the latest GitHub release and checks
 * it against the release's SHA256SUMS.txt before anything runs it (a mismatch is deleted). Opening
 * it (Mac: the disk image, to drag into Applications; Windows: the installer) is the app's part.
 */
import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseSums, pickAsset, type UpdateInfo } from './update-check';

export interface DownloadProgress {
  received: number;
  total: number;
}

/** Downloads `url` to `dest`, hashing as it goes; a different SHA-256 deletes the file and throws. */
export async function downloadVerified(fetchImpl: typeof fetch, url: string, sha256: string, dest: string, onProgress?: (p: DownloadProgress) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetchImpl(url, { signal, headers: { 'User-Agent': 'meeting-interpreter' } });
  if (!res.ok || !res.body) throw new Error(`下载失败（HTTP ${res.status}）`);
  const total = Number(res.headers.get('content-length')) || 0;
  mkdirSync(dirname(dest), { recursive: true });
  const out = createWriteStream(dest);
  const hash = createHash('sha256');
  let received = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      hash.update(value);
      received += value.byteLength;
      if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
      onProgress?.({ received, total });
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  } catch (err) {
    out.destroy();
    rmSync(dest, { force: true });
    throw err;
  }
  if (hash.digest('hex') !== sha256.toLowerCase()) {
    rmSync(dest, { force: true });
    throw new Error('下载的安装包校验不通过（和发布页的指纹不一致），已删除。请稍后重试，或到官网下载。');
  }
}

/** Finds this computer's installer and its expected SHA-256 in the release; downloads and checks it. Returns the file. */
export async function downloadUpdate(o: { info: UpdateInfo; platform: NodeJS.Platform; arch: string; dir: string; fetch: typeof fetch; onProgress?: (p: DownloadProgress) => void; signal?: AbortSignal }): Promise<string> {
  const asset = pickAsset(o.info.assets, o.platform, o.arch);
  if (!asset) throw new Error('这台电脑的新版需要到官网下载');
  const sums = o.info.assets.find((a) => a.name === 'SHA256SUMS.txt');
  if (!sums) throw new Error('发布页缺少校验文件，为安全起见不自动更新，请到官网下载');
  const res = await o.fetch(sums.url, { signal: o.signal, headers: { 'User-Agent': 'meeting-interpreter' } });
  if (!res.ok) throw new Error(`读取校验文件失败（HTTP ${res.status}）`);
  const expected = parseSums(await res.text()).get(asset.name);
  if (!expected) throw new Error('校验文件里没有这个安装包，为安全起见不自动更新，请到官网下载');
  const dest = `${o.dir}/${asset.name}`;
  await downloadVerified(o.fetch, asset.url, expected, dest, o.onProgress, o.signal);
  return dest;
}
