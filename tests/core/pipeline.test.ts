import { describe, expect, it } from 'vitest';
import { Emitter } from '@core/events';
import { DirectionPipeline, rateForBacklog } from '@core/pipeline/pipeline';
import type { AsrEvents, AsrSession, StreamingAsr, Translator, Tts, TranslateRequest, TtsRequest } from '@core/providers/types';
import type { TranscriptSegment } from '@core/types';
import { waitFor } from '../helpers/fakes';

class FakeSession implements AsrSession {
  events = new Emitter<AsrEvents>();
  pushed: Int16Array[] = [];
  ended = false;
  closed = false;
  push(pcm: Int16Array) { this.pushed.push(pcm); }
  async end() { this.ended = true; this.events.emit('closed', {}); }
  close() { this.closed = true; }
  final(text: string) { this.events.emit('final', { text }); }
  partial(text: string) { this.events.emit('partial', { text }); }
}

class FakeAsr implements StreamingAsr {
  id = 'fake';
  sessions: FakeSession[] = [];
  failNext = 0;
  hotwords: string[][] = [];
  async start(o: { hotwords: string[] }) {
    this.hotwords.push(o.hotwords);
    if (this.failNext > 0) { this.failNext--; throw new Error('connect failed'); }
    const s = new FakeSession();
    this.sessions.push(s);
    return s;
  }
  get last() { return this.sessions[this.sessions.length - 1]!; }
}

class FakeTranslator implements Translator {
  id = 'fake';
  delays: Record<string, number> = {};
  results: Record<string, string> = {};
  requests: TranslateRequest[] = [];
  async translate(req: TranslateRequest) {
    this.requests.push(req);
    await new Promise((r) => setTimeout(r, this.delays[req.text] ?? 5));
    return this.results[req.text] ?? `Traducción número ${this.requests.length}`;
  }
}

class FakeTts implements Tts {
  id = 'fake';
  calls: TtsRequest[] = [];
  async *synthesize(req: TtsRequest) {
    this.calls.push(req);
    yield { samples: new Int16Array(10), sampleRate: 24000 };
    yield { samples: new Int16Array(10), sampleRate: 24000 };
  }
  voices() { return []; }
}

function make(extra: Partial<ConstructorParameters<typeof DirectionPipeline>[0]> = {}) {
  const asr = new FakeAsr();
  const translator = new FakeTranslator();
  const tts = new FakeTts();
  const p = new DirectionPipeline({
    dir: 'out', speaker: 'me', idPrefix: 'out', srcLang: 'zh-CN', dstLang: 'es-ES',
    asr, translator, tts, glossary: () => [], pinyinFuzzy: false, lowLatency: false,
    clock: () => 10, reconnectDelays: [10, 10, 10], ...extra,
  });
  const segments: TranscriptSegment[] = [];
  const audio: string[] = [];
  const ends: string[] = [];
  p.on('segment', (s) => segments.push(s));
  p.on('audio', (a) => audio.push(a.segmentId));
  p.on('audioEnd', (a) => ends.push(a.segmentId));
  return { p, asr, translator, tts, segments, audio, ends };
}

describe('rateForBacklog', () => {
  it('speeds up with backlog', () => {
    expect(rateForBacklog(1)).toBe(1);
    expect(rateForBacklog(7.5)).toBeCloseTo(1.175, 3);
    expect(rateForBacklog(15)).toBe(1.35);
  });
});

describe('DirectionPipeline', () => {
  it('emits audio in commit order even when the first translation is slower', async () => {
    const { p, asr, translator, segments, ends } = make();
    translator.delays['第一句话。'] = 80;
    await p.start();
    asr.last.final('第一句话。');
    asr.last.final('第二句话。');
    await waitFor(() => ends.length === 2);
    expect(ends).toEqual(['out-1', 'out-2']);
    const done = segments.filter((s) => s.status === 'done').map((s) => s.id);
    expect(done).toEqual(['out-2', 'out-1']); // text shows as soon as ready
  });

  it('never speaks an invalid translation', async () => {
    const { p, asr, translator, tts, segments } = make();
    translator.results['你好。'] = '你好。'; // untranslated
    await p.start();
    asr.last.final('你好。');
    await waitFor(() => segments.some((s) => s.status === 'failed'));
    await new Promise((r) => setTimeout(r, 30));
    expect(tts.calls).toHaveLength(0);
  });

  it('reconnects after the recogniser closes and keeps working', async () => {
    const { p, asr, ends } = make();
    await p.start();
    asr.last.final('第一句。');
    asr.last.events.emit('closed', {});
    await waitFor(() => asr.sessions.length === 2);
    asr.last.final('第二句。');
    await waitFor(() => ends.length === 2);
    expect(ends).toEqual(['out-1', 'out-2']);
  });

  it('retries the connection when start fails', async () => {
    const { p, asr } = make();
    asr.failNext = 2;
    const states: string[] = [];
    p.on('status', (s) => states.push(s.state));
    await p.start();
    await waitFor(() => asr.sessions.length === 1, 1000);
    expect(states).toContain('error');
    expect(states[states.length - 1]).toBe('listening');
  });

  it('skipToLatest marks queued segments skipped and stops their audio', async () => {
    const { p, asr, translator, segments, audio } = make();
    translator.delays['一。'] = 50;
    translator.delays['二。'] = 50;
    await p.start();
    asr.last.final('一。');
    asr.last.final('二。');
    p.skipToLatest();
    await new Promise((r) => setTimeout(r, 120));
    expect(audio).toHaveLength(0);
    expect(segments.filter((s) => s.status === 'skipped').map((s) => s.id).sort()).toEqual(['out-1', 'out-2']);
  });

  it('drops audio while the gate is closed and flushes with silence', async () => {
    const { p, asr } = make();
    await p.start();
    p.push(new Int16Array(160).fill(100));
    p.setGate(false);
    p.push(new Int16Array(160).fill(100));
    const pushed = asr.last.pushed;
    expect(pushed).toHaveLength(2); // first chunk + silence flush
    expect(pushed[1]!.every((x) => x === 0)).toBe(true);
  });

  it('buffers audio spoken while connecting', async () => {
    const asr = new FakeAsr();
    const slow: StreamingAsr = { id: 'slow', start: async (o) => { await new Promise((r) => setTimeout(r, 30)); return asr.start(o); } };
    const { p } = make({ asr: slow });
    const started = p.start();
    p.push(new Int16Array(160).fill(7));
    await started;
    expect(asr.last.pushed[0]![0]).toBe(7);
  });

  it('passes glossary hits, context and hot words', async () => {
    const entry = { id: '1', zh: '星云平台', es: 'Plataforma Nébula', aliasesZh: ['心云平台'], aliasesEs: [], note: '', enabled: true };
    const { p, asr, translator, ends, segments } = make({ glossary: () => [entry] });
    await p.start();
    expect(asr.hotwords[0]).toEqual(['星云平台']);
    asr.last.final('我们介绍一下心云平台。');
    asr.last.final('它很快。');
    await waitFor(() => ends.length === 2);
    expect(segments[0]!.srcText).toBe('我们介绍一下星云平台。');
    expect(translator.requests[0]!.hits[0]!.target).toBe('Plataforma Nébula');
    expect(translator.requests[1]!.context.length).toBeGreaterThanOrEqual(0);
  });

  it('uses the backlog to raise the speech rate', async () => {
    const { p, asr, tts, ends } = make();
    await p.start();
    p.setBacklog(15);
    asr.last.final('快一点。');
    await waitFor(() => ends.length === 1);
    expect(tts.calls[0]!.rate).toBe(1.35);
  });

  it('stop waits for the last translation', async () => {
    const { p, asr, translator, segments } = make();
    translator.delays['最后一句。'] = 60;
    await p.start();
    asr.last.final('最后一句。');
    await p.stop();
    expect(segments.some((s) => s.status === 'done' && s.srcText === '最后一句。')).toBe(true);
  });
});
