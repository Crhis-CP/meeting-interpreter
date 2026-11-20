import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@core/log';
import { cloudflaredAsset, TunnelManager } from '../../src/main/room/tunnel';

describe('cloudflared download', () => {
  it('is pinned per platform (Windows on ARM uses the x64 build)', () => {
    expect(cloudflaredAsset('win32', 'arm64')?.file).toBe('cloudflared-windows-amd64.exe');
    expect(cloudflaredAsset('darwin', 'arm64')?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(cloudflaredAsset('freebsd', 'x64')).toBeNull();
  });

  it('never runs a download, or an installed copy, that is not the pinned release', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mi-cf-'));
    const bin = join(dir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
    writeFileSync(bin, Buffer.alloc(2_000_000, 7)); // a swapped binary already on disk
    let downloads = 0;
    const fake = (async () => {
      downloads++;
      return new Response(Buffer.alloc(2_000_000, 1));
    }) as typeof fetch;
    const t = new TunnelManager(dir, createLogger('t'), fake);
    await expect(t.start('https://127.0.0.1:1')).rejects.toThrow(/校验不通过/);
    expect(downloads).toBe(1);
    expect(existsSync(`${bin}.part`)).toBe(false);
  });
});
