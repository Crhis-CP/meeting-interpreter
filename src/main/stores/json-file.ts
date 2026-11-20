import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Reads JSON, returning `fallback` when the file is missing; a corrupt file is kept as `.bak`. */
export function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    try {
      renameSync(path, `${path}.corrupt-${Date.now()}.bak`);
    } catch {
      /* ignore */
    }
    return fallback;
  }
}

/** Writes JSON atomically (temp file + rename) so a crash never leaves half a file. */
export function writeJson(path: string, data: unknown, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode });
  renameSync(tmp, path);
}

export function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === undefined) return base;
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch) || base === null || typeof base !== 'object' || Array.isArray(base)) {
    return patch as T;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    out[k] = deepMerge((base as Record<string, unknown>)[k], v);
  }
  return out as T;
}
