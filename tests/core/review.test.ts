import { describe, expect, it } from 'vitest';
import type { Llm, LlmRequest } from '@core/providers/types';
import type { TranscriptSegment } from '@core/types';
import { reviewTranscript } from '@core/profile/review';

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
