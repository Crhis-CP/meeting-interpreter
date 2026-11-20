import { afterEach, describe, expect, it, vi } from 'vitest';
import { bytesToBase64, int16ToBytes } from '@core/audio/pcm';
import type { GlossaryEntry } from '@core/glossary/types';
import {
  DASHSCOPE_DEFAULTS,
  DashscopeAsr,
  DashscopeTts,
  QWEN_MT_DOMAINS,
  QwenMtTranslator,
  dashscopeError,
  dashscopeHost,
  dashscopeVocabulary,
  type DashscopeConfig,
} from '@core/providers/dashscope';
import { ProviderError, collectPcm, type AsrSession, type AsrStartOptions, type TranslateRequest } from '@core/providers/types';
import type { PcmChunk } from '@core/types';
import { fakeContext, jsonResponse, tick, waitFor, type FakeContext, type FakeWebSocket } from '../helpers/fakes';

const KEY = 'sk-test0123456789';
const HAN = /[一-鿿]/;

const cfg = (over: Partial<DashscopeConfig> = {}): DashscopeConfig => ({ apiKey: KEY, region: 'cn', ...over });
const asrOpts = (over: Partial<AsrStartOptions> = {}): AsrStartOptions => ({ lang: 'zh-CN', hotwords: [], sampleRate: 16000, ...over });
const b64 = (samples: number[]) => bytesToBase64(int16ToBytes(new Int16Array(samples)));
/** Lets `queueMicrotask` work (FakeWebSocket auto-open) run while timers are faked. */
const flushMicrotasks = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

afterEach(() => {
  vi.useRealTimers();
});

async function openSocket(ctx: FakeContext, index = 0): Promise<FakeWebSocket> {
  await waitFor(() => ctx.sockets[index]?.readyState === 1);
  return ctx.sockets[index]!;
}

/** A duplex-protocol server event for the socket's task. */
function serverEvent(ws: FakeWebSocket, event: string, header: Record<string, unknown> = {}, payload: Record<string, unknown> = {}): void {
  ws.serverSend({ header: { task_id: ws.json()[0]?.header?.task_id, event, attributes: {}, ...header }, payload });
}

function sentence(
  ws: FakeWebSocket,
  s: { text: string; sentence_end: boolean; begin_time?: number | null; end_time?: number | null; heartbeat?: boolean },
): void {
  serverEvent(ws, 'result-generated', {}, { output: { sentence: { sentence_id: 1, ...s } } });
}

function record(session: AsrSession): [string, any][] {
  const log: [string, any][] = [];
  for (const type of ['partial', 'final', 'error', 'closed'] as const) session.events.on(type, (payload) => log.push([type, payload]));
  return log;
}

/** Starts a recognition session and answers `task-started`. */
async function startAsr(config = cfg(), opts = asrOpts()) {
  const ctx = fakeContext();
  const pending = new DashscopeAsr(config, ctx).start(opts);
  const ws = await openSocket(ctx);
  await waitFor(() => ws.sent.length === 1);
  const runTask = ws.json()[0];
  serverEvent(ws, 'task-started');
  const session = await pending;
  return { ctx, ws, session, runTask, log: record(session) };
}

function settle<T>(p: Promise<T>): Promise<unknown> {
  return p.then(
    () => null,
    (e: unknown) => e,
  );
}

// ---------------------------------------------------------------- common

describe('dashscope common', () => {
  it('picks the region host or a cleaned-up workspace host', () => {
    expect(dashscopeHost({ region: 'cn' })).toBe('dashscope.aliyuncs.com');
    expect(dashscopeHost({ region: 'intl', host: '  ' })).toBe('dashscope-intl.aliyuncs.com');
    expect(dashscopeHost({ region: 'cn', host: 'https://ws-1a2b.cn-beijing.maas.aliyuncs.com/' })).toBe('ws-1a2b.cn-beijing.maas.aliyuncs.com');
    expect(dashscopeHost({ region: 'cn', host: 'https://ws-1a2b.cn-beijing.maas.aliyuncs.com/compatible-mode/v1' })).toBe(
      'ws-1a2b.cn-beijing.maas.aliyuncs.com',
    );
    expect(dashscopeHost({ region: 'intl', host: 'wss://proxy.example.com:8443/dashscope/api-ws/v1/inference' })).toBe('proxy.example.com:8443/dashscope');
  });

  it('maps failures to Chinese messages that name the likely fix', () => {
    const auth = dashscopeError('asr', { code: 'InvalidApiKey', message: 'Invalid API-key provided.' }, { region: 'intl' });
    expect(auth.message).toMatch(/API Key/);
    expect(auth.message).toMatch(/北京和新加坡/);
    expect(auth.message).toContain('dashscope-intl.aliyuncs.com');
    expect(auth.status).toBe(401);
    expect(auth.retryable).toBe(false);

    const denied = dashscopeError('asr', { closeCode: 1006, closeReason: 'Unexpected server response: 403', model: 'qwen-audio-3.1-asr-flash-streaming' }, { region: 'cn' });
    expect(denied.status).toBe(403);
    expect(denied.message).toContain('「qwen-audio-3.1-asr-flash-streaming」');
    expect(denied.message).toContain('fun-asr-realtime');
    expect(denied.message).toContain('业务空间主机（{WorkspaceId}.cn-beijing.maas.aliyuncs.com）');

    const limited = dashscopeError('tts', { closeCode: 1007, closeReason: '' });
    expect(limited.message).toMatch(/限流/);
    expect(limited.retryable).toBe(true);

    const missing = dashscopeError('mt', { status: 404, code: 'model_not_found', message: 'The model `qwen-mt-x` does not exist', model: 'qwen-mt-x' });
    expect(missing.message).toContain('模型「qwen-mt-x」不存在');
    expect(missing.provider).toBe('qwen-mt');

    const arrears = dashscopeError('asr', { code: 'Arrearage', message: 'Access denied, please make sure your account is in good standing.' });
    expect(arrears.message).toMatch(/欠费/);

    const idle = dashscopeError('asr', { code: 'CLIENT_ERROR', message: 'request timeout after 23 seconds.' });
    expect(idle.message).toMatch(/长时间没有收到音频/);
    expect(idle.retryable).toBe(true);

    // Numbers inside a server message are not HTTP statuses.
    const param = dashscopeError('asr', { code: 'InvalidParameter', message: 'vocabulary size exceeds limit 500' });
    expect(param.message).toMatch(/请求参数有误/);
    expect(param.retryable).toBe(false);

    for (const e of [auth, denied, limited, missing, arrears, idle, param]) {
      expect(e).toBeInstanceOf(ProviderError);
      expect(e.message).toMatch(HAN);
    }
  });

  it('never puts the key into an error message', () => {
    expect(dashscopeError('asr', { message: `rejected Authorization: Bearer ${KEY}` }).message).not.toContain(KEY);
  });

  it('fails fast without network when no key is set', async () => {
    const ctx = fakeContext();
    const noKey = cfg({ apiKey: '  ' });
    await expect(new DashscopeAsr(noKey, ctx).start(asrOpts())).rejects.toThrow(/API Key/);
    await expect(collectPcm(new DashscopeTts(noKey, ctx).synthesize({ text: '你好', lang: 'zh-CN', rate: 1 }))).rejects.toThrow(/API Key/);
    await expect(new QwenMtTranslator(noKey, ctx).translate(mtRequest())).rejects.toThrow(/API Key/);
    expect(ctx.sockets).toHaveLength(0);
    expect(ctx.requests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- ASR

describe('DashscopeAsr', () => {
  it('opens the inference socket with Bearer auth and sends run-task', async () => {
    const hotwords = [
      '星云平台',
      ' 星云平台 ', // duplicate after trimming
      'Nebula',
      '',
      '一二三四五六七八九十一二三四五六', // 16 non-ASCII characters: too long
      'one two three four five six seven eight', // 8 ASCII words: too long
      'Plataforma Nébula', // non-ASCII, 17 characters: too long
      'one two  three four five six seven', // 7 words once whitespace is collapsed
    ];
    const { ws, runTask, session } = await startAsr(cfg(), asrOpts({ hotwords }));
    expect(ws.url).toBe('wss://dashscope.aliyuncs.com/api-ws/v1/inference');
    expect(ws.opts.headers).toEqual({ Authorization: `Bearer ${KEY}` });
    expect(runTask).toEqual({
      header: { action: 'run-task', task_id: expect.stringMatching(/^[0-9a-f]{32}$/), streaming: 'duplex' },
      payload: {
        task_group: 'audio',
        task: 'asr',
        function: 'recognition',
        model: DASHSCOPE_DEFAULTS.asrModel,
        parameters: {
          format: 'pcm',
          sample_rate: 16000,
          language_hints: ['zh'],
          max_sentence_silence: 800,
          heartbeat: true,
          vocabulary: { 星云平台: 4, Nebula: 4, 'one two three four five six seven': 4 },
        },
        input: {},
      },
    });
    session.close();
  });

  it('connects to the intl host or a configured workspace host', async () => {
    const cases: [DashscopeConfig, string][] = [
      [cfg({ region: 'intl' }), 'wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference'],
      [cfg({ host: 'https://ws-1a2b.cn-beijing.maas.aliyuncs.com/' }), 'wss://ws-1a2b.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference'],
    ];
    for (const [config, url] of cases) {
      const { ws, session } = await startAsr(config);
      expect(ws.url).toBe(url);
      session.close();
    }
  });

  it('sends vocabulary only to qwen-audio models, and the Spanish hint for es-*', async () => {
    const fun = await startAsr(cfg({ asrModel: 'fun-asr-realtime' }), asrOpts({ lang: 'es-MX', hotwords: ['Nebula'] }));
    expect(fun.runTask.payload.model).toBe('fun-asr-realtime');
    expect(fun.runTask.payload.parameters.language_hints).toEqual(['es']);
    expect(fun.runTask.payload.parameters).not.toHaveProperty('vocabulary');
    fun.session.close();

    const noTerms = await startAsr(cfg({ asrModel: 'qwen-audio-3.0-asr-flash-streaming' }), asrOpts({ hotwords: [] }));
    expect(noTerms.runTask.payload.parameters).not.toHaveProperty('vocabulary');
    noTerms.session.close();
  });

  it('caps the inline vocabulary at 500 unique terms', () => {
    const terms = Array.from({ length: 600 }, (_, i) => `term${i}`);
    const vocabulary = dashscopeVocabulary([...terms, ...terms]);
    expect(Object.keys(vocabulary)).toHaveLength(500);
    expect(vocabulary.term0).toBe(4);
    expect(vocabulary.term499).toBe(4);
    expect(vocabulary).not.toHaveProperty('term500');
  });

  it('resolves start() only once task-started arrives', async () => {
    const ctx = fakeContext();
    let resolved = false;
    const pending = new DashscopeAsr(cfg(), ctx).start(asrOpts()).then((s) => {
      resolved = true;
      return s;
    });
    const ws = await openSocket(ctx);
    await tick(20);
    expect(ws.json().map((m) => m.header.action)).toEqual(['run-task']);
    expect(resolved).toBe(false);
    serverEvent(ws, 'task-started');
    (await pending).close();
    expect(resolved).toBe(true);
  });

  it('rejects start() on task-failed with a Chinese message and closes the socket', async () => {
    const ctx = fakeContext();
    const settled = settle(new DashscopeAsr(cfg(), ctx).start(asrOpts()));
    const ws = await openSocket(ctx);
    serverEvent(ws, 'task-failed', { error_code: 'Model.AccessDenied', error_message: 'Model access denied.' });
    const err = (await settled) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toMatch(HAN);
    expect(err.message).toContain('fun-asr-realtime');
    expect(err.status).toBe(403);
    expect(ws.readyState).toBe(3);
  });

  it('rejects start() when the handshake is refused with 401', async () => {
    // Status in the close reason…
    const ctx1 = fakeContext(undefined, { autoOpen: false });
    const first = settle(new DashscopeAsr(cfg(), ctx1).start(asrOpts()));
    ctx1.sockets[0]!.serverClose(1006, 'Unexpected server response: 401');
    // …or only in the transport error that precedes the close.
    const ctx2 = fakeContext(undefined, { autoOpen: false });
    const second = settle(new DashscopeAsr(cfg(), ctx2).start(asrOpts()));
    ctx2.sockets[0]!.onerror?.(new Error('Unexpected server response: 401'));
    ctx2.sockets[0]!.serverClose(1006, '');
    for (const err of [(await first) as ProviderError, (await second) as ProviderError]) {
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.message).toContain('401');
      expect(err.message).toMatch(/Key/);
      expect(err.status).toBe(401);
      expect(err.retryable).toBe(false);
    }
  });

  it('rejects start() as rate limited when the server closes with 1007', async () => {
    const ctx = fakeContext();
    const settled = settle(new DashscopeAsr(cfg(), ctx).start(asrOpts()));
    const ws = await openSocket(ctx);
    ws.serverClose(1007, '');
    const err = (await settled) as ProviderError;
    expect(err.message).toMatch(/限流/);
    expect(err.retryable).toBe(true);
  });

  it('rejects start() after 10 s without task-started', async () => {
    vi.useFakeTimers();
    const ctx = fakeContext();
    const settled = settle(new DashscopeAsr(cfg(), ctx).start(asrOpts()));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(9_900);
    expect(ctx.sockets[0]!.readyState).toBe(1);
    await vi.advanceTimersByTimeAsync(200);
    const err = (await settled) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toMatch(/超时/);
    expect(err.retryable).toBe(true);
    expect(ctx.sockets[0]!.readyState).toBe(3);
  });

  it('forwards pushed PCM as little-endian binary frames of at most 100 ms', async () => {
    const { ws, session } = await startAsr();
    session.push(new Int16Array([1, -2, 0x1234]));
    expect(ws.binary()).toHaveLength(1);
    expect([...ws.binary()[0]!]).toEqual([0x01, 0x00, 0xfe, 0xff, 0x34, 0x12]);
    session.push(new Int16Array(4000));
    expect(ws.binary().slice(1).map((b) => b.length)).toEqual([3200, 3200, 1600]);
    session.close();
    session.push(new Int16Array(10));
    expect(ws.binary()).toHaveLength(4);
  });

  it('maps results to partial / final, skipping heartbeats and empty finals, with times in seconds', async () => {
    const { ws, session, log } = await startAsr();
    sentence(ws, { text: '', sentence_end: false, heartbeat: true });
    sentence(ws, { text: '你好', sentence_end: false, begin_time: 120, end_time: null });
    sentence(ws, { text: '你好世界。', sentence_end: true, begin_time: 120, end_time: 1850 });
    sentence(ws, { text: '', sentence_end: true, begin_time: 2000, end_time: 2100 });
    sentence(ws, { text: 'Hola', sentence_end: false, begin_time: 2500, end_time: null });
    expect(log).toEqual([
      ['partial', { text: '你好' }],
      ['final', { text: '你好世界。', start: 0.12, end: 1.85 }],
      ['partial', { text: 'Hola' }],
    ]);
    session.close();
  });

  it('reports an unexpected close as a fatal error followed by one closed event', async () => {
    const { ws, session, log } = await startAsr();
    ws.serverClose(1006, '');
    expect(log.map(([type]) => type)).toEqual(['error', 'closed']);
    const { error, fatal } = log[0]![1];
    expect(fatal).toBe(true);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.message).toMatch(HAN);
    expect(error.retryable).toBe(true);
    session.close();
    await session.end();
    expect(log.filter(([type]) => type === 'closed')).toHaveLength(1);
  });

  it('treats a socket error that is never followed by close as a close', async () => {
    const { ws, log } = await startAsr();
    ws.onerror?.(new Error('read ECONNRESET'));
    await waitFor(() => log.some(([type]) => type === 'closed'));
    expect(log.map(([type]) => type)).toEqual(['error', 'closed']);
    expect(log[0]![1].error.message).toContain('ECONNRESET');
    expect(ws.readyState).toBe(3);
  });

  it('turns task-failed during recognition into a fatal error, then closed', async () => {
    const { ws, log } = await startAsr();
    serverEvent(ws, 'task-failed', { error_code: 'NO_VALID_AUDIO_ERROR', error_message: 'no valid audio' });
    expect(log.map(([type]) => type)).toEqual(['error', 'closed']);
    expect(log[0]![1].fatal).toBe(true);
    expect(log[0]![1].error.message).toMatch(/有效的音频/);
    expect(ws.readyState).toBe(3);
  });

  it('end() sends finish-task, delivers the last results and resolves on task-finished', async () => {
    const { ws, session, runTask, log } = await startAsr();
    let ended = false;
    const done = session.end().then(() => {
      ended = true;
    });
    expect(ws.json()[1]).toEqual({ header: { action: 'finish-task', task_id: runTask.header.task_id, streaming: 'duplex' }, payload: { input: {} } });
    session.push(new Int16Array(160)); // no audio after finish-task
    expect(ws.binary()).toHaveLength(0);
    sentence(ws, { text: '最后一句。', sentence_end: true, begin_time: 0, end_time: 900 });
    await tick(20);
    expect(ended).toBe(false);
    serverEvent(ws, 'task-finished');
    await waitFor(() => ended, 500); // promptly, not via the 5 s fallback
    await done;
    expect(log).toEqual([
      ['final', { text: '最后一句。', start: 0, end: 0.9 }],
      ['closed', expect.anything()],
    ]);
    expect(ws.readyState).toBe(3);
    session.close();
    expect(log).toHaveLength(2);
  });

  it('end() gives up after 5 s without task-finished', async () => {
    vi.useFakeTimers();
    const ctx = fakeContext();
    const pending = new DashscopeAsr(cfg(), ctx).start(asrOpts());
    await flushMicrotasks();
    const ws = ctx.sockets[0]!;
    serverEvent(ws, 'task-started');
    const session = await pending;
    const log = record(session);
    let ended = false;
    const done = session.end().then(() => {
      ended = true;
    });
    await vi.advanceTimersByTimeAsync(4_900);
    expect(ended).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    await done;
    expect(log.map(([type]) => type)).toEqual(['closed']);
    expect(ws.readyState).toBe(3);
  });

  it('close() closes at once and emits closed exactly once', async () => {
    const { ws, session, log } = await startAsr();
    session.close();
    session.close();
    expect(ws.readyState).toBe(3);
    expect(ws.closedWith?.code).toBe(1000);
    sentence(ws, { text: '太晚了', sentence_end: true, begin_time: 0, end_time: 500 });
    await session.end();
    expect(log.map(([type]) => type)).toEqual(['closed']);
  });
});

// ---------------------------------------------------------------- TTS

describe('DashscopeTts', () => {
  it('waits for session.created, then sends session.update, append, commit and finish with event ids', async () => {
    const ctx = fakeContext();
    const stream = new DashscopeTts(cfg(), ctx).synthesize({ text: '你好，世界', lang: 'zh-CN', rate: 1 });
    const ws = await openSocket(ctx);
    expect(ws.url).toBe('wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3-tts-flash-realtime');
    expect(ws.opts.headers).toEqual({ Authorization: `Bearer ${KEY}` });
    await tick(20);
    expect(ws.sent).toHaveLength(0);
    ws.serverSend({ type: 'session.created', event_id: 'event_s1', session: { id: 'sess_1' } });
    const events = ws.json();
    expect(events.map((e) => e.type)).toEqual(['session.update', 'input_text_buffer.append', 'input_text_buffer.commit', 'session.finish']);
    expect(events[0].session).toEqual({
      voice: 'Cherry',
      mode: 'server_commit',
      language_type: 'Chinese',
      response_format: 'pcm',
      sample_rate: 24000,
      speech_rate: 1,
    });
    expect(events[1].text).toBe('你好，世界');
    for (const e of events) expect(e.event_id).toMatch(/^event_[0-9a-f]{32}$/);
    expect(new Set(events.map((e) => e.event_id)).size).toBe(4);
    ws.serverSend({ type: 'session.finished' });
    await collectPcm(stream);
  });

  it('speaks Spanish with Sonrisa by default, honours an explicit voice and clamps the speech rate', async () => {
    const ctx = fakeContext();
    const tts = new DashscopeTts(cfg({ region: 'intl', ttsModel: 'qwen3-tts-flash-realtime-2025-11-27' }), ctx);
    const requests: { rate: number; voice?: string }[] = [{ rate: 3 }, { rate: 0.2, voice: 'Bodega' }, { rate: 1.234 }];
    const updates: any[] = [];
    for (const [i, r] of requests.entries()) {
      const stream = tts.synthesize({ text: 'hola', lang: 'es-MX', ...r });
      const ws = await openSocket(ctx, i);
      ws.serverSend({ type: 'session.created' });
      updates.push(ws.json()[0].session);
      ws.serverSend({ type: 'session.finished' });
      await collectPcm(stream);
    }
    expect(ctx.sockets[0]!.url).toBe('wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime?model=qwen3-tts-flash-realtime-2025-11-27');
    expect(updates.map((u) => [u.voice, u.language_type, u.speech_rate])).toEqual([
      ['Sonrisa', 'Spanish', 2],
      ['Bodega', 'Spanish', 0.5],
      ['Sonrisa', 'Spanish', 1.23],
    ]);
  });

  it('sends anyway when session.created does not arrive within 3 s', async () => {
    vi.useFakeTimers();
    const ctx = fakeContext();
    const stream = new DashscopeTts(cfg(), ctx).synthesize({ text: '你好', lang: 'zh-CN', rate: 1 });
    await flushMicrotasks();
    const ws = ctx.sockets[0]!;
    expect(ws.readyState).toBe(1);
    await vi.advanceTimersByTimeAsync(2_900);
    expect(ws.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(ws.json().map((e) => e.type)).toEqual(['session.update', 'input_text_buffer.append', 'input_text_buffer.commit', 'session.finish']);
    ws.serverSend({ type: 'session.finished' });
    expect((await collectPcm(stream)).samples).toHaveLength(0);
  });

  it('decodes base64 deltas to Int16 (an odd byte carried across deltas) and ends on session.finished', async () => {
    const ctx = fakeContext();
    const stream = new DashscopeTts(cfg(), ctx).synthesize({ text: 'hola', lang: 'es-ES', rate: 1 });
    const ws = await openSocket(ctx);
    ws.serverSend({ type: 'session.created' });
    const bytes = int16ToBytes(new Int16Array([1, -2, 300, -32768, 32767]));
    for (const part of [bytes.subarray(0, 3), bytes.subarray(3, 8), bytes.subarray(8)]) {
      ws.serverSend({ type: 'response.audio.delta', delta: bytesToBase64(part) });
    }
    ws.serverSend({ type: 'response.audio.done' });
    ws.serverSend({ type: 'response.done' });
    ws.serverSend({ type: 'session.finished' });
    const chunks: PcmChunk[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect(chunks.map((c) => [...c.samples])).toEqual([[1], [-2, 300, -32768], [32767]]);
    expect(chunks.every((c) => c.sampleRate === 24000)).toBe(true);
    expect(ws.readyState).toBe(3);
  });

  it('rejects iteration on an error event with a Chinese message, after the audio already received', async () => {
    const ctx = fakeContext();
    const stream = new DashscopeTts(cfg(), ctx).synthesize({ text: '你好', lang: 'zh-CN', voice: 'Nobody', rate: 1 });
    const ws = await openSocket(ctx);
    ws.serverSend({ type: 'session.created' });
    ws.serverSend({ type: 'response.audio.delta', delta: b64([5, 6]) });
    ws.serverSend({ type: 'error', error: { type: 'invalid_request_error', code: 'invalid_value', message: 'Voice not found: Nobody', param: 'session.voice' } });
    const got: number[] = [];
    const consume = async () => {
      for await (const chunk of stream) got.push(...chunk.samples);
    };
    await expect(consume()).rejects.toThrow(/百炼语音合成：音色不可用/);
    expect(got).toEqual([5, 6]);
    expect(ws.readyState).toBe(3);
  });

  it('ends when the socket closes after the audio is done, and fails when it closes before', async () => {
    const ctx = fakeContext();
    const tts = new DashscopeTts(cfg(), ctx);
    const ok = tts.synthesize({ text: 'uno', lang: 'es-ES', rate: 1 });
    const ws1 = await openSocket(ctx, 0);
    ws1.serverSend({ type: 'session.created' });
    ws1.serverSend({ type: 'response.audio.delta', delta: b64([7]) });
    ws1.serverSend({ type: 'response.audio.done' });
    ws1.serverClose(1000, '');
    expect([...(await collectPcm(ok)).samples]).toEqual([7]);

    const broken = tts.synthesize({ text: 'dos', lang: 'es-ES', rate: 1 });
    const ws2 = await openSocket(ctx, 1);
    ws2.serverSend({ type: 'session.created' });
    ws2.serverClose(1006, '');
    await expect(collectPcm(broken)).rejects.toThrow(/连接意外断开/);
  });

  it('closes the socket and ends the stream on abort', async () => {
    const ctx = fakeContext();
    const ac = new AbortController();
    const stream = new DashscopeTts(cfg(), ctx).synthesize({ text: 'hola', lang: 'es-ES', rate: 1, signal: ac.signal });
    const ws = await openSocket(ctx);
    ws.serverSend({ type: 'session.created' });
    ws.serverSend({ type: 'response.audio.delta', delta: b64([1, 2]) });
    ac.abort();
    expect(ws.readyState).toBe(3);
    expect([...(await collectPcm(stream)).samples]).toEqual([1, 2]);
  });

  it('closes the socket when the consumer stops iterating early', async () => {
    const ctx = fakeContext();
    const stream = new DashscopeTts(cfg(), ctx).synthesize({ text: 'hola', lang: 'es-ES', rate: 1 });
    const ws = await openSocket(ctx);
    ws.serverSend({ type: 'session.created' });
    ws.serverSend({ type: 'response.audio.delta', delta: b64([1]) });
    for await (const chunk of stream) {
      expect([...chunk.samples]).toEqual([1]);
      break;
    }
    expect(ws.readyState).toBe(3);
  });

  it('ends at once without a socket for empty text or an already aborted request', async () => {
    const ctx = fakeContext();
    const tts = new DashscopeTts(cfg(), ctx);
    expect((await collectPcm(tts.synthesize({ text: '  ', lang: 'zh-CN', rate: 1 }))).samples).toHaveLength(0);
    const ac = new AbortController();
    ac.abort();
    expect((await collectPcm(tts.synthesize({ text: '你好', lang: 'zh-CN', rate: 1, signal: ac.signal }))).samples).toHaveLength(0);
    expect(ctx.sockets).toHaveLength(0);
  });

  it('lists the six multilingual voices with Chinese names, the language default first', () => {
    const tts = new DashscopeTts(cfg(), fakeContext());
    const zh = tts.voices('zh-CN');
    const es = tts.voices('es-MX');
    expect(zh.map((v) => v.id)).toEqual(['Cherry', 'Serena', 'Ethan', 'Neil', 'Sonrisa', 'Bodega']);
    expect(es.map((v) => v.id)).toEqual(['Sonrisa', 'Bodega', 'Cherry', 'Serena', 'Ethan', 'Neil']);
    for (const v of [...zh, ...es]) {
      expect(v.lang).toBe('multi');
      expect(v.name).toMatch(/[男女]声/);
    }
    expect(es.find((v) => v.id === 'Bodega')!.name).toMatch(/西班牙/);
    expect(es.find((v) => v.id === 'Sonrisa')!.name).toMatch(/拉美/);
  });
});

// ---------------------------------------------------------------- Qwen-MT

const entry = (zh: string, es: string): GlossaryEntry => ({ id: zh, zh, es, aliasesZh: [], aliasesEs: [], note: '', enabled: true });

function mtRequest(over: Partial<TranslateRequest> = {}): TranslateRequest {
  return { text: '星云平台下周上线。', from: 'zh-CN', to: 'es-ES', hits: [], context: [], ...over };
}

describe('QwenMtTranslator', () => {
  it('posts one user message with translation_options (terms, last 3 tm pairs, domains)', async () => {
    const ctx = fakeContext(() =>
      jsonResponse({
        id: 'chatcmpl-1',
        choices: [{ index: 0, message: { role: 'assistant', content: '  La Plataforma Nebula se lanza la próxima semana.\n' }, finish_reason: 'stop' }],
      }),
    );
    const hit = { source: '星云平台', target: 'Plataforma Nebula', entry: entry('星云平台', 'Plataforma Nebula') };
    const out = await new QwenMtTranslator(cfg(), ctx).translate(
      mtRequest({
        hits: [hit, { ...hit }],
        context: [
          { src: '一', dst: 'uno' },
          { src: '二', dst: 'dos' },
          { src: '三', dst: 'tres' },
          { src: '四', dst: 'cuatro' },
        ],
      }),
    );
    expect(out).toBe('La Plataforma Nebula se lanza la próxima semana.');
    expect(ctx.requests).toHaveLength(1);
    const { url, init } = ctx.requests[0]!;
    expect(url).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      model: 'qwen-mt-flash',
      messages: [{ role: 'user', content: '星云平台下周上线。' }],
      translation_options: {
        source_lang: 'Chinese',
        target_lang: 'Spanish',
        terms: [{ source: '星云平台', target: 'Plataforma Nebula' }],
        tm_list: [
          { source: '二', target: 'dos' },
          { source: '三', target: 'tres' },
          { source: '四', target: 'cuatro' },
        ],
        domains: QWEN_MT_DOMAINS,
      },
    });
    expect(body.messages.some((m: { role: string }) => m.role === 'system')).toBe(false);
  });

  it('omits empty terms and tm_list, and follows the region, workspace host and model settings', async () => {
    const ctx = fakeContext(() => jsonResponse({ choices: [{ message: { content: '你好' } }] }));
    const out = await new QwenMtTranslator(cfg({ region: 'intl', mtModel: 'qwen-mt-plus' }), ctx).translate(
      mtRequest({ text: 'Hola', from: 'es-MX', to: 'zh-CN', context: [{ src: '', dst: 'x' }] }),
    );
    expect(out).toBe('你好');
    expect(ctx.requests[0]!.url).toBe('https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions');
    const body = JSON.parse(String(ctx.requests[0]!.init.body));
    expect(body.model).toBe('qwen-mt-plus');
    expect(body.translation_options).toEqual({ source_lang: 'Spanish', target_lang: 'Chinese', domains: QWEN_MT_DOMAINS });

    await new QwenMtTranslator(cfg({ host: 'https://ws-9.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/' }), ctx).translate(mtRequest());
    expect(ctx.requests[1]!.url).toBe('https://ws-9.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions');
  });

  it('maps a 401 to a Chinese error naming 401 and the key, without retrying', async () => {
    const ctx = fakeContext(() =>
      jsonResponse({ error: { message: 'Incorrect API key provided. ', type: 'invalid_request_error', param: null, code: 'invalid_api_key' }, request_id: 'r1' }, 401),
    );
    const err = (await settle(new QwenMtTranslator(cfg(), ctx).translate(mtRequest()))) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toContain('401');
    expect(err.message).toMatch(/API Key/);
    expect(err.message).toMatch(/北京和新加坡/);
    expect(err.message).toContain('invalid_api_key');
    expect(err.status).toBe(401);
    expect(err.retryable).toBe(false);
    expect(err.provider).toBe('qwen-mt');
    expect(ctx.requests).toHaveLength(1);
  });

  it('retries a 429 once, then reports rate limiting as retryable', async () => {
    const ctx = fakeContext(() => jsonResponse({ error: { code: 'Throttling.RateQuota', message: 'Requests rate limit exceeded, please try again later.' } }, 429));
    const err = (await settle(new QwenMtTranslator(cfg(), ctx).translate(mtRequest()))) as ProviderError;
    expect(ctx.requests).toHaveLength(2);
    expect(err.message).toMatch(/限流/);
    expect(err.retryable).toBe(true);
    expect(err.status).toBe(429);
  });

  it('rejects an empty translation as retryable and skips the request for empty text', async () => {
    const ctx = fakeContext(() => jsonResponse({ choices: [{ message: { content: '  ' } }] }));
    const mt = new QwenMtTranslator(cfg(), ctx);
    const err = (await settle(mt.translate(mtRequest()))) as ProviderError;
    expect(err.message).toMatch(/为空/);
    expect(err.retryable).toBe(true);
    expect(await mt.translate(mtRequest({ text: '   ' }))).toBe('');
    expect(ctx.requests).toHaveLength(1);
  });
});
