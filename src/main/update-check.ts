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

/** Looks up the latest GitHub release; resolves null when there is nothing newer or offline. */
export async function checkForUpdate(current: string, log: Logger, fetchImpl: typeof fetch = fetch): Promise<{ version: string; url: string } | null> {
  try {
    const res = await fetchImpl(LATEST, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'meeting-interpreter' }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { tag_name?: string; html_url?: string; draft?: boolean; prerelease?: boolean };
    if (!data.tag_name || data.draft || data.prerelease) return null;
    return compareVersions(data.tag_name, current) > 0 ? { version: data.tag_name.replace(/^v/, ''), url: data.html_url ?? 'https://github.com/Crhis-CP/meeting-interpreter/releases/latest' } : null;
  } catch (err) {
    log.debug('update check failed', err instanceof Error ? err.message : String(err));
    return null;
  }
}
