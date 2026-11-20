import { describe, expect, it } from 'vitest';
import { Emitter } from '@core/events';
import { SharedAsr, textSide } from '@core/pipeline/conversation';
import { DirectionPipeline } from '@core/pipeline/pipeline';
import type { AsrEvents, AsrSession, AsrStartOptions, StreamingAsr, Translator, Tts } from '@core/providers/types';
import { waitFor } from '../helpers/fakes';

class Real implements AsrSession {
  events = new Emitter<AsrEvents>();
  pushed = 0;
  push(pcm: Int16Array) {
    this.pushed += pcm.length;
  }
  async end() {
    this.events.emit('closed', {});
  }
  close() {
    this.events.emit('closed', { reason: 'closed' });
  }
}

function fakeAsr() {
  const sessions: Real[] = [];
  const opts: AsrStartOptions[] = [];
  const asr: StreamingAsr = {
    id: 'fake',
    start: async (o) => {
      opts.push(o);
      const s = new Real();
      sessions.push(s);
      return s;
    },
  };
  return { asr, sessions, opts };
}

describe('textSide', () => {
  it('tells Chinese from Spanish and English, names included', () => {
    expect(textSide('我们下周交货。')).toBe('zh');
    expect(textSide('¿Cuándo llega el pedido?')).toBe('foreign');
    expect(textSide('Let us talk about the price.')).toBe('foreign');
    expect(textSide('我们用 Microsoft Teams 开会')).toBe('zh');
    expect(textSide('Hablamos con el señor 王')).toBe('foreign');
    expect(textSide('…')).toBeNull();
  });
});

describe('SharedAsr', () => {
  it('opens one recogniser for both languages and routes sentences by language', async () => {
    const { asr, sessions, opts } = fakeAsr();
    const shared = new SharedAsr(asr, 'zh-CN', 'es-MX');
    const zh = await shared.view('zh').start({ lang: 'zh-CN', hotwords: [], sampleRate: 16000 });
    const es = await shared.view('foreign').start({ lang: 'es-MX', hotwords: [], sampleRate: 16000 });
    expect(sessions).toHaveLength(1);
    expect(opts[0]).toMatchObject({ lang: 'zh-CN', alsoLangs: ['es-MX'] });
    const got: string[] = [];
    zh.events.on('final', ({ text }) => got.push(`zh:${text}`));
    es.events.on('final', ({ text }) => got.push(`es:${text}`));
    sessions[0]!.events.emit('final', { text: '你好，欢迎。' });
    sessions[0]!.events.emit('final', { text: 'Hola, gracias.' });
    expect(got).toEqual(['zh:你好，欢迎。', 'es:Hola, gracias.']);
    zh.push(new Int16Array(100));
    es.push(new Int16Array(100)); // the listener does not carry audio
    expect(sessions[0]!.pushed).toBe(100);
  });

  it('closes both views when the recogniser closes, and reopens on the next start', async () => {
    const { asr, sessions } = fakeAsr();
    const shared = new SharedAsr(asr, 'zh-CN', 'en-US');
    const zh = await shared.view('zh').start({ lang: 'zh-CN', hotwords: [], sampleRate: 16000 });
    const en = await shared.view('foreign').start({ lang: 'en-US', hotwords: [], sampleRate: 16000 });
    let closed = 0;
    zh.events.on('closed', () => closed++);
    en.events.on('closed', () => closed++);
    sessions[0]!.events.emit('closed', { reason: 'server' });
    expect(closed).toBe(2);
    await shared.view('zh').start({ lang: 'zh-CN', hotwords: [], sampleRate: 16000 });
    expect(sessions).toHaveLength(2);
  });

  it('drives two pipelines: each sentence is translated the right way round', async () => {
    const { asr, sessions } = fakeAsr();
    const shared = new SharedAsr(asr, 'zh-CN', 'es-MX');
    const translator: Translator = { id: 't', translate: async (r) => (r.to === 'es-MX' ? 'Hola a todos.' : '大家好。') };
    const tts: Tts = { id: 's', voices: () => [], async *synthesize() { yield { samples: new Int16Array(10), sampleRate: 24000 }; } };
    const done: string[] = [];
    const make = (side: 'zh' | 'foreign') =>
      new DirectionPipeline({
        dir: side === 'zh' ? 'out' : 'in',
        speaker: side === 'zh' ? 'me' : 'them',
        idPrefix: side === 'zh' ? 'out' : 'in',
        srcLang: side === 'zh' ? 'zh-CN' : 'es-MX',
        dstLang: side === 'zh' ? 'es-MX' : 'zh-CN',
        asr: shared.view(side),
        translator,
        tts,
        glossary: () => [],
        pinyinFuzzy: false,
        lowLatency: false,
        clock: () => 1,
        reconnectDelays: [10],
      });
    const out = make('zh');
    const inn = make('foreign');
    for (const p of [out, inn]) p.on('segment', (s) => s.status === 'done' && done.push(`${s.srcText}→${s.dstText}`));
    await Promise.all([out.start(), inn.start()]);
    await waitFor(() => sessions.length === 1);
    sessions[0]!.events.emit('final', { text: '大家好。' });
    sessions[0]!.events.emit('final', { text: 'Hola a todos.' });
    await waitFor(() => done.length === 2);
    expect(done.sort()).toEqual(['Hola a todos.→大家好。', '大家好。→Hola a todos.']);
    await Promise.all([out.stop(), inn.stop()]);
  });
});
