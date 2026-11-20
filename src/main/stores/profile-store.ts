import { copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { emptyProfile, ProfileSchema, type VoiceProfile } from '../../core/profile/profile';
import { writeJson } from './json-file';

export const PROFILE_FILE = 'voice-profile.json';

/**
 * The voice profile as a plain file in the user's records folder (Documents/MeetingInterpreter
 * unless they chose another, e.g. a cloud-synced folder). No account, no server: deleting the
 * file deletes the profile.
 */
export class ProfileStore {
  private cache: { file: string; p: VoiceProfile } | null = null;

  constructor(private readonly dir: () => string) {}

  file(): string {
    return join(this.dir(), PROFILE_FILE);
  }

  get(): VoiceProfile {
    const file = this.file();
    if (this.cache?.file === file) return this.cache.p;
    let p = this.read(file);
    // The records folder moved: bring the profile along (the old copy stays where it was).
    if (!existsSync(file) && this.cache && this.cache.p.updatedAt) {
      p = this.cache.p;
      writeJson(file, p, 0o600);
    }
    this.cache = { file, p };
    return p;
  }

  update(fn: (p: VoiceProfile) => VoiceProfile): VoiceProfile {
    const p = fn(this.get());
    const file = this.file();
    writeJson(file, p, 0o600);
    this.cache = { file, p };
    return p;
  }

  reset(): void {
    const file = this.file();
    rmSync(file, { force: true });
    this.cache = { file, p: emptyProfile() };
  }

  private read(file: string): VoiceProfile {
    if (!existsSync(file)) return emptyProfile();
    try {
      const r = ProfileSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
      if (r.success) return r.data;
    } catch {
      /* damaged */
    }
    // Keep what was there; a fresh profile is written on the next change.
    try {
      copyFileSync(file, `${file}.damaged-${Date.now()}.bak`);
    } catch {
      /* ignore */
    }
    return emptyProfile();
  }
}
