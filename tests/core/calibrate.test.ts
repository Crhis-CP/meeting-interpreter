import { describe, expect, it } from 'vitest';
import { Emitter } from '@core/events';
import type { AsrEvents, AsrSession, AsrStartOptions, StreamingAsr } from '@core/providers/types';
import { runCalibration } from '@core/profile/calibrate';

/** Answers each session with the next scripted text once the audio ends. */
class ScriptedAsr implements StreamingAsr {
  starts: AsrStartOptions[] = [];
  pushed = 0;
  constructor(public id: string, private texts: string[], private fail = false) {}
  async start(o: AsrStartOptions): Promise<AsrSession> {
    if (this.fail) throw new Error('没有网络');
    this.starts.push(o);
    const text = this.texts[this.starts.length - 1] ?? '';
    const events = new Emitter<AsrEvents>();
    return {
      events,
      push: () => void this.pushed++,
      end: async () => {
        if (text) events.emit('final', { text });
        events.emit('closed', {});
      },
      close: () => undefined,
    };
  }
}

const sentences = ['您好，我们今天主要讨论新方案的价格。', '接下来介绍一下星云平台。'];
const audio = [new Int16Array(16000), new Int16Array(8000)];

describe('accent calibration', () => {
  it('scores each recogniser on the user’s own reading and recommends the best', async () => {
    const local = new ScriptedAsr('local', ['您好我们今天主要讨论新航案的价格', '接下来介绍一下星云平太']);
    const cloud = new ScriptedAsr('dashscope', ['您好，我们今天主要讨论新方案的价格。', '接下来介绍一下星云平台。']);
    const r = await runCalibration({ sentences, audio, lang: 'zh-CN', terms: ['星云平台'], current: 'local' }, [
      { id: 'local', name: '本机离线', asr: local, hotwords: ['星云平台'] },
      { id: 'dashscope', name: '阿里云百炼', asr: cloud, hotwords: ['星云平台'] },
    ], { paceMs: 0 });
    expect(r.results.map((x) => [x.asr, Math.round(x.accuracy * 100)])).toEqual([['local', 93], ['dashscope', 100]]);
    expect(r.best).toBe('dashscope');
    expect(r.corrections).toEqual([{ heard: '星云平太', meant: '星云平台' }]);
    expect(r.confusions).toEqual(['f-h']); // from the recogniser in use (local)
    expect(local.starts[0]).toMatchObject({ lang: 'zh-CN', hotwords: ['星云平台'] });
    expect(local.pushed).toBeGreaterThan(0);
  });

  it('keeps going when one recogniser fails', async () => {
    const r = await runCalibration({ sentences, audio, lang: 'zh-CN', terms: [], current: 'azure' }, [
      { id: 'azure', name: 'Azure', asr: new ScriptedAsr('azure', [], true), hotwords: [] },
      { id: 'local', name: '本机离线', asr: new ScriptedAsr('local', sentences), hotwords: [] },
    ], { paceMs: 0 });
    expect(r.results[0]).toMatchObject({ asr: 'azure', accuracy: 0, error: '没有网络' });
    expect(r.best).toBe('local');
  });

  it('needs at least one recogniser', async () => {
    await expect(runCalibration({ sentences, audio, lang: 'zh-CN', terms: [], current: 'local' }, [], { paceMs: 0 })).rejects.toThrow();
  });
});
