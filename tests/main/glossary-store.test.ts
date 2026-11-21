import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUTO_GLOSSARY_ID, GlossaryStore, MAX_AUTO_TERMS } from '../../src/main/stores/glossary-store';

describe('the automatic glossary', () => {
  it('remembers how the other side’s terms were mis-heard, on its own entries only, at most 5 each', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mi-gloss-'));
    const g = new GlossaryStore(dir);
    expect(g.addAutoTerms([{ zh: '萨拉特', foreign: 'Zárate' }], 'es')).toHaveLength(1);
    expect(g.addAutoAliases([{ heard: 'Sárate', meant: 'zarate' }, { heard: 'Kilmes', meant: 'Quilmes' }], 'es')).toEqual([{ heard: 'Sárate', meant: 'zarate' }]);
    expect(g.addAutoAliases([{ heard: 'sárate', meant: 'Zárate' }], 'es')).toEqual([]); // already there
    // (Spellings that differ only in accents are the same one.)
    for (const h of ['Sarate', 'Zarrate', 'Zárat', 'Sárat', 'Sarrate', 'Zarat']) g.addAutoAliases([{ heard: h, meant: 'Zárate' }], 'es');
    const entry = new GlossaryStore(dir).list().find((x) => x.id === AUTO_GLOSSARY_ID)!.entries[0]!;
    expect(entry.aliasesEs).toEqual(['Sárate', 'Zarrate', 'Zárat', 'Sárat', 'Sarrate']);
  });

  it('keeps at most MAX_AUTO_TERMS learned terms, dropping the oldest', () => {
    const g = new GlossaryStore(mkdtempSync(join(tmpdir(), 'mi-gloss-')));
    for (let i = 0; i < MAX_AUTO_TERMS + 5; i++) g.addAutoTerms([{ zh: `术语${i}号`, foreign: `Term ${i}` }], 'es');
    const auto = g.list().find((x) => x.id === AUTO_GLOSSARY_ID)!.entries;
    expect(auto).toHaveLength(MAX_AUTO_TERMS);
    expect(auto[0]!.zh).toBe('术语5号');
  });
});
