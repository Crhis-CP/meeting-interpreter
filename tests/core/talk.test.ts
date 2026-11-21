import { describe, expect, it } from 'vitest';
import { Talk } from '@core/pipeline/talk';

describe('the conversation translations see', () => {
  it('grows between sentences (so the local model reuses its work), then starts again from the last few', () => {
    const t = new Talk({ max: 4, keep: 2 });
    const said = (n: number) => t.add({ who: n % 2 ? 'them' : 'me', text: `第${n}句` });
    said(1);
    said(2);
    expect(t.window().map((x) => x.text)).toEqual(['第1句', '第2句']);
    said(3);
    said(4);
    expect(t.window().map((x) => x.text)).toEqual(['第1句', '第2句', '第3句', '第4句']);
    said(5);
    expect(t.window().map((x) => x.text)).toEqual(['第4句', '第5句']); // restarted
    said(6);
    expect(t.window().map((x) => x.text)).toEqual(['第4句', '第5句', '第6句']); // growing again
  });

  it('keeps the context short (long monologues would make every prompt long)', () => {
    const t = new Talk({ maxChars: 100 });
    for (let i = 0; i < 3; i++) t.add({ who: 'them', text: 'x'.repeat(45) });
    const w = t.window();
    expect(w.reduce((n, x) => n + x.text.length, 0)).toBeLessThanOrEqual(100);
    expect(w.length).toBeGreaterThan(0);
  });

  it('ignores empty turns; reset forgets', () => {
    const t = new Talk();
    t.add({ who: 'me', text: '  ' });
    expect(t.window()).toEqual([]);
    t.add({ who: 'me', text: '好' });
    t.reset();
    expect(t.window()).toEqual([]);
  });
});
