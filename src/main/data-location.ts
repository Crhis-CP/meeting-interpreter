/**
 * Where the app keeps its data on Windows: %LOCALAPPDATA%\MeetingInterpreter. Electron's default is
 * the roaming profile (%APPDATA%), which offices may sync to a server at every sign-in — no place
 * for gigabytes of models. An existing folder there moves over by renaming (same drive: instant,
 * nothing copied); if that cannot happen, the old place keeps working and nothing is lost.
 */
import { join } from 'node:path';

export interface Fs {
  exists(path: string): boolean;
  rename(from: string, to: string): void;
}

export function windowsDataDir(o: { roaming: string; local: string; name: string; fs: Fs }): { dir: string; moved: boolean; error?: string } {
  const target = join(o.local, o.name);
  const old = join(o.roaming, o.name);
  if (o.fs.exists(target) || !o.fs.exists(old)) return { dir: target, moved: false };
  try {
    o.fs.rename(old, target);
    return { dir: target, moved: true };
  } catch (err) {
    return { dir: old, moved: false, error: err instanceof Error ? err.message : String(err) };
  }
}
