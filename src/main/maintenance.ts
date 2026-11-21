/**
 * Keeps the data folder from growing without end. Deliberately narrow: it deletes only
 *  - downloads interrupted more than a week ago (`*.part`),
 *  - files on the OBSOLETE list (left by earlier versions; kept up to date with each release),
 *  - the virtual audio driver's temporary installers,
 * and rotates the log. Anything it does not know is never touched (a user's own files, or newer
 * models when an older version of the app runs).
 */
import { readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Paths under the data folder that earlier versions left and nothing uses any more. */
export const OBSOLETE: readonly string[] = [];

const DAY = 24 * 60 * 60 * 1000;

export interface CleanupResult {
  removed: string[];
  bytes: number;
}

function sizeOf(path: string): number {
  try {
    const st = statSync(path);
    if (!st.isDirectory()) return st.size;
    return readdirSync(path).reduce((n, e) => n + sizeOf(join(path, e)), 0);
  } catch {
    return 0;
  }
}

function remove(path: string, out: CleanupResult): void {
  const bytes = sizeOf(path);
  try {
    rmSync(path, { recursive: true, force: true });
    out.removed.push(path);
    out.bytes += bytes;
  } catch {
    /* in use: next time */
  }
}

/** `*.part` files older than `maxAgeMs` anywhere under `dir`. */
function staleParts(dir: string, now: number, maxAgeMs: number, out: CleanupResult): void {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) staleParts(p, now, maxAgeMs, out);
    else if (e.name.endsWith('.part')) {
      try {
        if (now - statSync(p).mtimeMs > maxAgeMs) remove(p, out);
      } catch {
        /* gone */
      }
    }
  }
}

export function cleanupData(opts: { dataDir: string; tmpDir: string; now?: number; obsolete?: readonly string[] }): CleanupResult {
  const now = opts.now ?? Date.now();
  const out: CleanupResult = { removed: [], bytes: 0 };
  staleParts(join(opts.dataDir, 'models'), now, 7 * DAY, out);
  for (const rel of opts.obsolete ?? OBSOLETE) {
    // Only inside the data folder, whatever the list says.
    if (rel.includes('..') || rel.startsWith('/') || /^[a-z]:/i.test(rel)) continue;
    const p = join(opts.dataDir, rel);
    if (sizeOf(p) || existsish(p)) remove(p, out);
  }
  // The driver installers go to fresh `mi-driver-*` folders in the system temp folder.
  try {
    for (const name of readdirSync(opts.tmpDir)) {
      if (!name.startsWith('mi-driver-')) continue;
      const p = join(opts.tmpDir, name);
      try {
        if (now - statSync(p).mtimeMs > DAY) remove(p, out);
      } catch {
        /* gone */
      }
    }
  } catch {
    /* no temp folder */
  }
  return out;
}

function existsish(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Keeps the log at most `maxBytes` (plus one older copy): app.log → app.1.log when it is full.
 * About 20 meetings each; enough to diagnose, never gigabytes.
 */
export function rotateLog(path: string, maxBytes = 5 * 1024 * 1024): boolean {
  try {
    if (statSync(path).size < maxBytes) return false;
    renameSync(path, path.replace(/\.log$/, '.1.log'));
    return true;
  } catch {
    return false;
  }
}
