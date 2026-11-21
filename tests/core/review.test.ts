import { describe, expect, it } from 'vitest';
import type { Llm, LlmRequest } from '@core/providers/types';
import type { TranscriptSegment } from '@core/types';
import { reviewMeeting, reviewTranscript } from '@core/profile/review';
import { applyCorrections } from '@core/profile/profile';

const seg = (id: string, dir: 'out' | 'in', srcText: string, srcLang = dir === 'out' ? 'zh-CN' : 'es-AR'): TranscriptSegment => ({
  id, dir, speaker: dir === 'out' ? 'me' : 'them', seq: 1, start: 0, end: 1, srcLang, srcText, dstLang: 'x', dstText: 'x', status: 'done',
});

class FakeLlm implements Llm {
  id = 'fake';
  requests: LlmRequest[] = [];
  constructor(private reply: string) {}
  async complete(req: LlmRequest) {
    this.requests.push(req);
    return this.reply;
  }
}

describe('after-meeting review of what I said', () => {
  const segs = [seg('out-1', 'out', '我们下周把河同发给你们。'), seg('in-1', 'in', 'Perfecto, gracias.'), seg('out-2', 'out', '价格包括运费，到布宜诺斯艾利斯。')];

  it('asks the LLM about my own sentences only and keeps sound-alike suggestions that are really there', async () => {
    const llm = new FakeLlm(
      '```json\n' +
        JSON.stringify({
          items: [
            { line: 1, heard: '河同', meant: '合同', reason: '上下文是合同' },
            { line: 2, heard: '运费', meant: '保险', reason: '不像同音' },
            { line: 2, heard: '不存在', meant: '布存在', reason: 'x' },
            { line: 9, heard: '河同', meant: '合同', reason: 'x' },
          ],
        }) +
        '\n```',
    );
    const out = await reviewTranscript(llm, segs, { terms: ['星云平台'] });
    expect(out).toEqual([{ segId: 'out-1', heard: '河同', meant: '合同', reason: '上下文是合同' }]);
    expect(llm.requests[0]!.json).toBe(true);
    expect(llm.requests[0]!.user).toContain('1. 我们下周把河同发给你们。');
    expect(llm.requests[0]!.user).not.toContain('Perfecto');
    expect(llm.requests[0]!.system).toContain('星云平台');
  });

  it('returns nothing when there is nothing of mine or the reply is not JSON', async () => {
    expect(await reviewTranscript(new FakeLlm('{}'), [seg('in-1', 'in', 'Hola')], { terms: [] })).toEqual([]);
    expect(await reviewTranscript(new FakeLlm('sorry'), segs, { terms: [] })).toEqual([]);
  });
});

describe('after-meeting review learns terms by itself', () => {
  const segs = [
    seg('out-1', 'out', '我们下周介绍星云平台的价格。'),
    { ...seg('in-1', 'in', 'Nos interesa mucho la Plataforma Nébula.'), dstText: '我们对星云平台很感兴趣。' },
    seg('out-2', 'out', '星云平台支持西班牙语。'),
  ];

  it('returns names / products / industry terms that are really in the meeting, with their translation', async () => {
    const llm = new FakeLlm(
      JSON.stringify({
        items: [],
        terms: [
          { zh: '星云平台', foreign: 'Plataforma Nébula' },
          { zh: '价格', foreign: 'precio' }, // an everyday word the model should have skipped: still in the meeting, so kept (the user can delete it)
          { zh: '量子计划', foreign: 'Plan Cuántico' }, // never said in the meeting
          { zh: 'x', foreign: '' },
        ],
      }),
    );
    const r = await reviewMeeting(llm, segs, { terms: [], foreign: 'es' });
    expect(r.terms).toContainEqual({ zh: '星云平台', foreign: 'Plataforma Nébula' });
    expect(r.terms.find((t) => t.zh === '量子计划')).toBeUndefined();
    expect(r.terms.find((t) => t.zh === 'x')).toBeUndefined();
    expect(llm.requests[0]!.user).toContain('Nos interesa mucho la Plataforma Nébula. ‖ 我们对星云平台很感兴趣。');
  });

  it('does not suggest terms the user already has', async () => {
    const llm = new FakeLlm(JSON.stringify({ items: [], terms: [{ zh: '星云平台', foreign: 'Plataforma Nébula' }] }));
    const r = await reviewMeeting(llm, segs, { terms: ['星云平台'], foreign: 'es' });
    expect(r.terms).toEqual([]);
  });
});

describe('learned terms are never mis-hearings', () => {
  it('drops a “term” that is the mis-heard word itself', async () => {
    const segs = [seg('out-1', 'out', '我们下周把河同发给你们。'), { ...seg('in-1', 'in', 'Gracias por el contrato.'), dstText: '谢谢你们的合同。' }];
    const llm = new FakeLlm(JSON.stringify({ items: [{ line: 1, heard: '河同', meant: '合同', reason: '' }], terms: [{ zh: '河同', foreign: 'contrato' }] }));
    const r = await reviewMeeting(llm, segs, { terms: [], foreign: 'es' });
    expect(r.suggestions).toHaveLength(1);
    expect(r.terms).toEqual([]);
  });
});

describe('single-character fixes are never learned', () => {
  it('drops 的→得 and 在→再 from the review, keeps real word fixes', async () => {
    const segs = [seg('out-1', 'out', '我在公司的会议室等你的河同。')];
    const reply = JSON.stringify({ items: [{ line: 1, heard: '的', meant: '得' }, { line: 1, heard: '在', meant: '再' }, { line: 1, heard: '河同', meant: '合同' }] });
    const r = await reviewMeeting(new FakeLlm(reply), segs, { terms: [], foreign: 'es' });
    expect(r.suggestions.map((s) => `${s.heard}→${s.meant}`)).toEqual(['河同→合同']);
  });

  it('a one-character rule learned by an older version is ignored', () => {
    const rules = [{ heard: '的', meant: '得', lang: 'zh' as const }, { heard: '河同', meant: '合同', lang: 'zh' as const }];
    expect(applyCorrections('我的河同', rules, 'zh').text).toBe('我的合同');
  });
});

describe('the other side’s names and terms', () => {
  it('are checked too: sound-alike fixes that are really in their sentence are kept, everyday words are not', async () => {
    const segs = [seg('out-1', 'out', '我们和萨拉特先生谈过了。'), seg('in-1', 'in', 'Habló con el señor Sárate ayer.'), seg('in-2', 'in', 'La planta de Kilmes está lejos.')];
    const replies = [
      JSON.stringify({ items: [], terms: [] }),
      JSON.stringify({ items: [{ line: 1, heard: 'Sárate', meant: 'Zárate' }, { line: 2, heard: 'Kilmes', meant: 'Quilmes' }, { line: 2, heard: 'lejos', meant: 'cerca' }, { line: 1, heard: 'Pérez', meant: 'Peres' }] }),
    ];
    const llm: Llm & { requests: LlmRequest[] } = { id: 'fake', requests: [], async complete(req) { this.requests.push(req); return replies.shift()!; } };
    const r = await reviewMeeting(llm, segs, { terms: ['Zárate'], foreign: 'es' });
    expect(r.theirs.map((s) => `${s.segId}:${s.heard}→${s.meant}`)).toEqual(['in-1:Sárate→Zárate', 'in-2:Kilmes→Quilmes']);
    expect(llm.requests[1]!.system).toContain('OTHER side');
    expect(llm.requests[1]!.system).toContain('Zárate');
    expect(llm.requests[1]!.user).toBe('1. Habló con el señor Sárate ayer.\n2. La planta de Kilmes está lejos.');
  });
});
