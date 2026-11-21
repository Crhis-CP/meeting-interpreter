import type { Logger } from '../core/log';

const LATEST = 'https://api.github.com/repos/Crhis-CP/meeting-interpreter/releases/latest';

/** Compares dotted versions: 1 when a > b, -1 when a < b, 0 when equal. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

export interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
}

export interface UpdateInfo {
  version: string;
  /** The release page. */
  url: string;
  /** What changed (the release notes). */
  notes: string;
  assets: ReleaseAsset[];
}

/** Looks up the latest GitHub release; resolves null when there is nothing newer or offline. */
export async function checkForUpdate(current: string, log: Logger, fetchImpl: typeof fetch = fetch): Promise<UpdateInfo | null> {
  try {
    const res = await fetchImpl(LATEST, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'meeting-interpreter' }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { tag_name?: string; html_url?: string; draft?: boolean; prerelease?: boolean; body?: string; assets?: { name?: string; browser_download_url?: string; size?: number }[] };
    if (!data.tag_name || data.draft || data.prerelease) return null;
    if (compareVersions(data.tag_name, current) <= 0) return null;
    const assets = (data.assets ?? []).filter((a) => a.name && a.browser_download_url?.startsWith('https://github.com/')).map((a) => ({ name: a.name!, url: a.browser_download_url!, size: a.size ?? 0 }));
    return { version: data.tag_name.replace(/^v/, ''), url: data.html_url ?? 'https://github.com/Crhis-CP/meeting-interpreter/releases/latest', notes: data.body ?? '', assets };
  } catch (err) {
    log.debug('update check failed', err instanceof Error ? err.message : String(err));
    return null;
  }
}

/** The installer for this computer, or null (Linux: the release page). */
export function pickAsset(assets: readonly ReleaseAsset[], platform: NodeJS.Platform, arch: string): ReleaseAsset | null {
  const want = platform === 'darwin' ? (arch === 'arm64' ? /-mac-arm64\.dmg$/ : /-mac-x64\.dmg$/) : platform === 'win32' ? /-windows-x64-setup\.exe$/ : null;
  return (want && assets.find((a) => want.test(a.name))) || null;
}

/** `sha256sum` output: "<hash>  <name>" per line. */
export function parseSums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (m) out.set(m[2]!.trim(), m[1]!.toLowerCase());
  }
  return out;
}
