import { describe, expect, it } from 'vitest';
import { parseSummary } from '@core/session/summary';


describe('summary replies with odd fields', () => {
  it('reads "mm:ss" times, a single evidence string and a numeric owner', () => {
    const s = parseSummary(JSON.stringify({ title: '会议', topics: [{ start: '01:15', title: '价格', points: [{ text: '降价', evidence: 'L3' }] }], todos: [{ text: '发合同', owner: 7, evidence: ['L1'] }] }));
    expect(s.topics[0]!.start).toBe(75);
    expect(s.topics[0]!.points[0]!.evidence).toEqual(['L3']);
    expect(s.todos[0]!.owner).toBe('7');
  });

  it('drops only the broken item, not the whole summary', () => {
    const s = parseSummary(JSON.stringify({ title: '会议', decisions: [{ text: '用海运' }, { text: 42 }], todos: [{ text: '发样品' }] }));
    expect(s.decisions.map((d) => d.text.zh)).toEqual(['用海运']);
    expect(s.todos).toHaveLength(1);
  });
});
