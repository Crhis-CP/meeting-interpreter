import { describe, expect, it } from 'vitest';
import { Emitter } from '@core/events';
import { FallbackAsr } from '@core/providers/fallback-asr';
import { ProviderError, type AsrEvents, type AsrSession, type StreamingAsr } from '@core/providers/types';

const session = (): AsrSession => ({ events: new Emitter<AsrEvents>(), push() {}, async end() {}, close() {} });
const asr = (id: string, fail?: Error): StreamingAsr & { calls: number } => {
  const a = { id, calls: 0, async start() { a.calls++; if (fail) throw fail; return session(); } };
  return a;
};
const opts = { lang: 'zh-CN', hotwords: [], sampleRate: 16000 as const };

describe('FallbackAsr', () => {
  it('falls back when a model is unavailable and remembers the working one', async () => {
    const a = asr('a', new ProviderError('模型不存在（404）', 'dashscope', { status: 404 }));
    const b = asr('b');
    const moves: number[] = [];
    const f = new FallbackAsr([a, b], (_x, to) => moves.push(to));
    await f.start(opts);
    await f.start(opts);
    expect(a.calls).toBe(1);
    expect(b.calls).toBe(2);
    expect(moves).toEqual([1]);
    expect(f.id).toBe('b');
  });

  it('does not hide authentication errors behind another model', async () => {
    const a = asr('a', new ProviderError('百炼：Key 无效或已过期（401）', 'dashscope', { status: 401 }));
    const b = asr('b');
    await expect(new FallbackAsr([a, b]).start(opts)).rejects.toThrow(/401/);
    expect(b.calls).toBe(0);
  });
});
