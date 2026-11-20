import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProfileStore } from '../../src/main/stores/profile-store';
import { addCorrections } from '@core/profile/profile';

describe('the voice profile file', () => {
  it('lives in the chosen folder, survives restarts, and follows the folder when it changes', () => {
    let dir = mkdtempSync(join(tmpdir(), 'mi-prof-'));
    const store = new ProfileStore(() => dir);
    expect(store.get().corrections).toEqual([]);
    store.update((p) => addCorrections(p, [{ heard: '河同', meant: '合同' }], 'zh', 'edit', 1));
    expect(JSON.parse(readFileSync(join(dir, 'voice-profile.json'), 'utf8')).corrections[0].meant).toBe('合同');
    if (process.platform !== 'win32') expect(statSync(join(dir, 'voice-profile.json')).mode & 0o077).toBe(0);
    expect(new ProfileStore(() => dir).get().corrections).toHaveLength(1);
    const old = dir;
    dir = mkdtempSync(join(tmpdir(), 'mi-prof-new-'));
    expect(store.get().corrections).toHaveLength(1);
    expect(existsSync(join(dir, 'voice-profile.json'))).toBe(true);
    expect(existsSync(join(old, 'voice-profile.json'))).toBe(true);
  });

  it('keeps a damaged file as a backup instead of overwriting it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mi-prof-bad-'));
    writeFileSync(join(dir, 'voice-profile.json'), '{ broken');
    const store = new ProfileStore(() => dir);
    expect(store.get().corrections).toEqual([]);
    store.update((p) => addCorrections(p, [{ heard: 'a b', meant: 'ab' }], 'en', 'manual', 1));
    expect(readdirSync(dir).some((f) => f.startsWith('voice-profile.json.damaged-'))).toBe(true);
  });

  it('can be reset', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mi-prof-reset-'));
    const store = new ProfileStore(() => dir);
    store.update((p) => addCorrections(p, [{ heard: '河同', meant: '合同' }], 'zh', 'edit', 1));
    store.reset();
    expect(store.get().corrections).toEqual([]);
    expect(existsSync(join(dir, 'voice-profile.json'))).toBe(false);
  });
});
