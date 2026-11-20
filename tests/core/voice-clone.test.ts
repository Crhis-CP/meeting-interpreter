import { describe, expect, it } from 'vitest';
import { int16ToBytes } from '@core/audio/pcm';
import { CLONE_TTS_MODEL, DashscopeCloneTts, FallbackTts, createClonedVoice, waitForVoice } from '@core/providers/dashscope/voice-clone';
import { collectPcm, type Tts } from '@core/providers/types';
import { createProviders } from '@core/providers/registry';
import { parseSettings } from '@core/config/schema';
import { fakeContext, jsonResponse, waitFor } from '../helpers/fakes';

const cfg = { apiKey: 'sk-test0123456789', region: 'cn' as const };

describe('voice cloning', () => {
  it('creates a voice from a WAV recording and waits until it is ready', async () => {
    let polls = 0;
    const ctx = fakeContext((url, init) => {
      const body = JSON.parse(String(init.body)) as { model: string; input: Record<string, unknown> };
      expect(url).toBe('https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization');
      expect(body.model).toBe('voice-enrollment');
      if (body.input.action === 'create_voice') {
        expect(body.input.target_model).toBe(CLONE_TTS_MODEL);
        expect(String(body.input.audio)).toMatch(/^data:audio\/wav;base64,/);
        expect(body.input.language_hints).toEqual(['zh']);
        return jsonResponse({ output: { voice_id: 'qwen-audio-3.1-tts-flash-mymeeting-abc' } });
      }
      polls++;
      return jsonResponse({ output: { status: polls < 2 ? 'DEPLOYING' : 'OK' } });
    });
    const id = await createClonedVoice(ctx, cfg, new Uint8Array([82, 73, 70, 70]));
    expect(id).toBe('qwen-audio-3.1-tts-flash-mymeeting-abc');
    expect((ctx.requests[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test0123456789');
    await waitForVoice(ctx, cfg, id, 5000, 1);
    expect(polls).toBe(2);
  });

  it('explains a rejected recording', async () => {
    const ctx = fakeContext(() => jsonResponse({ output: { status: 'UNDEPLOYED' } }));
    await expect(waitForVoice(ctx, cfg, 'v', 5000, 1)).rejects.toThrow(/没有通过审核/);
  });

  it('speaks with the cloned voice over the task WebSocket', async () => {
    const ctx = fakeContext();
    const tts = new DashscopeCloneTts(cfg, ctx, 'my-voice');
    const done = collectPcm(tts.synthesize({ text: 'Hola a todos', lang: 'es-MX', rate: 1 }));
    await waitFor(() => ctx.sockets.length === 1 && ctx.sockets[0]!.sent.length === 1);
    const ws = ctx.sockets[0]!;
    expect(ws.url).toBe('wss://dashscope.aliyuncs.com/api-ws/v1/inference');
    const run = ws.json()[0];
    expect(run.header.action).toBe('run-task');
    expect(run.payload).toMatchObject({ task: 'tts', function: 'SpeechSynthesizer', model: CLONE_TTS_MODEL, parameters: { voice: 'my-voice', format: 'pcm', sample_rate: 24000 } });
    ws.serverSend({ header: { event: 'task-started', task_id: run.header.task_id } });
    const sent = ws.json().map((m) => m.header.action);
    expect(sent).toEqual(['run-task', 'continue-task', 'finish-task']);
    expect(ws.json()[1].payload.input.text).toBe('Hola a todos');
    // PCM split across frames, mid-sample.
    const pcm = int16ToBytes(new Int16Array([1, 2, 3]));
    ws.serverSend(pcm.subarray(0, 3));
    ws.serverSend(pcm.subarray(3));
    ws.serverSend({ header: { event: 'task-finished' } });
    const out = await done;
    expect(Array.from(out.samples)).toEqual([1, 2, 3]);
    expect(out.sampleRate).toBe(24000);
  });

  it('falls back to the stock voice when the cloned one fails', async () => {
    const bad: Tts = { id: 'bad', voices: () => [], async *synthesize() { throw new Error('voice not found'); } };
    const good: Tts = { id: 'good', voices: () => [], async *synthesize() { yield { samples: new Int16Array([7]), sampleRate: 24000 }; } };
    const fallbacks: unknown[] = [];
    const tts = new FallbackTts(bad, good, (e) => fallbacks.push(e));
    expect(Array.from((await collectPcm(tts.synthesize({ text: 'x', lang: 'es-MX', rate: 1 }))).samples)).toEqual([7]);
    expect(Array.from((await collectPcm(tts.synthesize({ text: 'y', lang: 'es-MX', rate: 1 }))).samples)).toEqual([7]);
    expect(fallbacks).toHaveLength(1); // the broken voice is not retried every sentence
  });

  it('uses my voice only for my own speech, and only when switched on', () => {
    const ctx = fakeContext();
    const s = (useMyVoice: boolean) =>
      parseSettings({ preset: 'custom', out: { asr: 'dashscope', mt: 'qwen-mt', tts: 'dashscope' }, in: { asr: 'dashscope', mt: 'qwen-mt', tts: 'dashscope' }, dashscope: { myVoiceId: 'v1', useMyVoice } });
    expect(createProviders(s(true), { dashscope: 'sk-x' }, ctx, () => []).tts('out')).toBeInstanceOf(FallbackTts);
    expect(createProviders(s(true), { dashscope: 'sk-x' }, ctx, () => []).tts('in')).not.toBeInstanceOf(FallbackTts);
    expect(createProviders(s(false), { dashscope: 'sk-x' }, ctx, () => []).tts('out')).not.toBeInstanceOf(FallbackTts);
  });
});
