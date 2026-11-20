import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe('core stays isomorphic', () => {
  it('src/core imports no Node or Electron modules', () => {
    const bad: string[] = [];
    for (const file of walk(join(__dirname, '..', 'src', 'core'))) {
      if (!file.endsWith('.ts')) continue;
      const text = readFileSync(file, 'utf8');
      if (/from\s+['"](electron|node:[^'"]+|fs|path|ws|os|child_process)['"]/.test(text)) bad.push(file);
    }
    expect(bad).toEqual([]);
  });
});
