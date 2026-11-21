import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { smoothSpoken } from '../../src/core/text/disfluency';

const cases = JSON.parse(readFileSync(new URL('../fixtures/disfluency.json', import.meta.url), 'utf8')) as Record<'zh' | 'es' | 'en', [string, string][]>;

describe('spoken-language smoothing before translation', () => {
  for (const lang of ['zh', 'es', 'en'] as const) {
    it(`${lang}: fillers and stammered repeats go; normal sentences and meaningful look-alikes stay word for word`, () => {
      const wrong = cases[lang]
        .map(([input, want]) => ({ input, want: want === 'same' ? input : want, got: smoothSpoken(input, lang) }))
        .filter((c) => c.got !== c.want);
      expect(wrong).toEqual([]);
    });
  }

  it('a sentence that ended with a filler still ends properly', () => {
    expect(smoothSpoken('Lo hacemos así, eh.', 'es')).toBe('Lo hacemos así.');
    expect(smoothSpoken('That works for us, um.', 'en')).toBe('That works for us.');
  });

  it('keeps words that only contain a filler’s letters', () => {
    expect(smoothSpoken('我们的额度不够，金额要改。', 'zh')).toBe('我们的额度不够，金额要改。');
    expect(smoothSpoken('The ER was full; hmm, umbrellas sold out.', 'en')).toBe('The ER was full; umbrellas sold out.');
  });
});
