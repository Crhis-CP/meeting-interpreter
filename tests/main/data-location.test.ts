import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { windowsDataDir, type Fs } from '../../src/main/data-location';

function fakeFs(present: string[], failRename = false): Fs & { renamed: [string, string][] } {
  const set = new Set(present);
  const renamed: [string, string][] = [];
  return {
    renamed,
    exists: (p) => set.has(p),
    rename: (a, b) => {
      if (failRename) throw new Error('EBUSY: resource busy or locked');
      set.delete(a);
      set.add(b);
      renamed.push([a, b]);
    },
  };
}

const roaming = join('C:', 'Users', 'li', 'AppData', 'Roaming');
const local = join('C:', 'Users', 'li', 'AppData', 'Local');
const name = 'MeetingInterpreter';

describe('Windows data folder', () => {
  it('a new install keeps its data in Local', () => {
    expect(windowsDataDir({ roaming, local, name, fs: fakeFs([]) })).toEqual({ dir: join(local, name), moved: false });
  });

  it('an earlier install moves from Roaming to Local by renaming (models are not downloaded again)', () => {
    const fs = fakeFs([join(roaming, name)]);
    expect(windowsDataDir({ roaming, local, name, fs })).toEqual({ dir: join(local, name), moved: true });
    expect(fs.renamed).toEqual([[join(roaming, name), join(local, name)]]);
  });

  it('when the move fails, the old folder keeps working', () => {
    const r = windowsDataDir({ roaming, local, name, fs: fakeFs([join(roaming, name)], true) });
    expect(r).toMatchObject({ dir: join(roaming, name), moved: false });
    expect(r.error).toMatch(/EBUSY/);
  });

  it('already moved: Local is used, Roaming is left alone', () => {
    const fs = fakeFs([join(roaming, name), join(local, name)]);
    expect(windowsDataDir({ roaming, local, name, fs })).toEqual({ dir: join(local, name), moved: false });
    expect(fs.renamed).toEqual([]);
  });
});
