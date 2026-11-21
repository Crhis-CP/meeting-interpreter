/**
 * "用我的声音": 百炼声音复刻. A 10–20 s recording of the user becomes a custom voice (creating it is
 * free); the translation into the other language is then spoken in that voice. Cloned voices are
 * bound to the model they were created for, and that model speaks over DashScope's task WebSocket
 * (run-task / continue-task / finish-task), not the realtime protocol of the stock voices.
 */
import { bytesToBase64, bytesToInt16 } from '../../audio/pcm';
import { sleep } from '../../events';
import { lang } from '../../lang/languages';
import type { LangCode, PcmChunk } from '../../types';
import { httpJson, uuid } from '../http';
import { ProviderError, type ProviderContext, type Tts, type TtsRequest, type VoiceInfo } from '../types';
import { authHeaders, dashscopeError, dashscopeHost, type DashscopeConfig } from './common';

/** The model cloned voices are made for (and speak with). */
export const CLONE_TTS_MODEL = 'qwen-audio-3.1-tts-flash';
export const CLONE_TTS_RATE = 24000;
const NAME = '百炼声音复刻';

interface EnrollmentReply {
  output?: { voice_id?: string; status?: string; voice_list?: { voice_id: string; status?: string; target_model?: string }[] };
  code?: string;
  message?: string;
}

function enrollmentUrl(cfg: DashscopeConfig): string {
  return `https://${dashscopeHost(cfg)}/api/v1/services/audio/tts/customization`;
}

async function enrollment(ctx: ProviderContext, cfg: DashscopeConfig, input: Record<string, unknown>): Promise<EnrollmentReply> {
  return httpJson<EnrollmentReply>(ctx, NAME, enrollmentUrl(cfg), {
    method: 'POST',
    headers: authHeaders(cfg),
    json: { model: 'voice-enrollment', input },
    timeoutMs: 60_000,
    retries: 1,
  });
}

/**
 * Creates a cloned voice from a recording (a WAV file, 16 kHz or more, 10–20 s of the user reading
 * in their own language). Returns the voice id; the voice is usable once {@link waitForVoice} says so.
 */
export async function createClonedVoice(ctx: ProviderContext, cfg: DashscopeConfig, wav: Uint8Array, sampleLang: LangCode = 'zh-CN', model = CLONE_TTS_MODEL): Promise<string> {
  const reply = await enrollment(ctx, cfg, {
    action: 'create_voice',
    target_model: model,
    prefix: 'mymeeting',
    audio: `data:audio/wav;base64,${bytesToBase64(wav)}`,
    language_hints: [lang(sampleLang).codes.dashscope],
  });
  const id = reply.output?.voice_id;
  if (!id) throw new ProviderError(`${NAME}：没有拿到音色 ID${reply.message ? `（${reply.message}）` : ''}`, NAME);
  return id;
}

/** DEPLOYING (being checked), OK (ready) or UNDEPLOYED (rejected). */
export async function clonedVoiceStatus(ctx: ProviderContext, cfg: DashscopeConfig, voiceId: string): Promise<string> {
  const reply = await enrollment(ctx, cfg, { action: 'query_voice', voice_id: voiceId });
  return reply.output?.status ?? 'UNKNOWN';
}

/** Waits until a new voice is ready. Throws when it was rejected or takes too long. */
export async function waitForVoice(ctx: ProviderContext, cfg: DashscopeConfig, voiceId: string, timeoutMs = 120_000, intervalMs = 3000): Promise<void> {
  const until = ctx.now() + timeoutMs;
  for (;;) {
    const status = await clonedVoiceStatus(ctx, cfg, voiceId);
    if (status === 'OK') return;
    if (status === 'UNDEPLOYED') throw new ProviderError(`${NAME}：录音没有通过审核，请换一段更清楚、没有背景声音的录音再试`, NAME);
    if (ctx.now() > until) throw new ProviderError(`${NAME}：音色还在生成中，请稍后再试`, NAME, { retryable: true });
    await sleep(intervalMs);
  }
}

export async function deleteClonedVoice(ctx: ProviderContext, cfg: DashscopeConfig, voiceId: string): Promise<void> {
  await enrollment(ctx, cfg, { action: 'delete_voice', voice_id: voiceId });
}

// ---------------------------------------------------------------- speaking with the voice

interface TaskEvent {
  header?: { event?: string; task_id?: string; error_code?: string; error_message?: string };
}

/** Speaks with a cloned voice (DashScope task WebSocket, PCM 24 kHz). */
export class DashscopeCloneTts implements Tts {
  readonly id = 'dashscope-clone';
  constructor(
    private readonly cfg: DashscopeConfig,
    private readonly ctx: ProviderContext,
    private readonly voiceId: string,
    private readonly model = CLONE_TTS_MODEL,
  ) {}

  voices(_lang: LangCode): VoiceInfo[] {
    return [{ id: this.voiceId, name: '我的声音', lang: 'multi' }];
  }

  async *synthesize(req: TtsRequest): AsyncIterable<PcmChunk> {
    if (!req.text.trim() || req.signal?.aborted) return;
    const chunks: PcmChunk[] = [];
    let done = false;
    let failure: Error | null = null;
    let wake: (() => void) | null = null;
    const notify = () => {
      wake?.();
      wake = null;
    };
    const taskId = uuid().replace(/-/g, '');
    const ws = this.ctx.openWebSocket(`wss://${dashscopeHost(this.cfg)}/api-ws/v1/inference`, { headers: authHeaders(this.cfg) });
    let carry: number | null = null;
    const send = (action: string, payload: Record<string, unknown>) => ws.send(JSON.stringify({ header: { action, task_id: taskId, streaming: 'duplex' }, payload }));
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      if (err) failure = err;
      try {
        ws.close();
      } catch {
        // already closed
      }
      notify();
    };
    const timer = setTimeout(() => finish(dashscopeError('tts', { message: '语音合成超时' }, this.cfg)), 30_000);
    const onAbort = () => finish();
    req.signal?.addEventListener('abort', onAbort, { once: true });

    ws.onopen = () =>
      send('run-task', {
        task_group: 'audio',
        task: 'tts',
        function: 'SpeechSynthesizer',
        model: this.model,
        parameters: {
          text_type: 'PlainText',
          voice: this.voiceId,
          format: 'pcm',
          sample_rate: CLONE_TTS_RATE,
          ...(req.rate > 1.01 ? { rate: Math.min(2, req.rate) } : {}),
        },
        input: {},
      });
    ws.onmessage = (data) => {
      if (typeof data !== 'string') {
        // PCM16; a sample may straddle two frames.
        let bytes = data;
        if (carry !== null) {
          const joined = new Uint8Array(bytes.length + 1);
          joined[0] = carry;
          joined.set(bytes, 1);
          bytes = joined;
          carry = null;
        }
        if (bytes.length % 2) {
          carry = bytes[bytes.length - 1]!;
          bytes = bytes.subarray(0, bytes.length - 1);
        }
        if (bytes.length) {
          chunks.push({ samples: bytesToInt16(bytes), sampleRate: CLONE_TTS_RATE });
          notify();
        }
        return;
      }
      let ev: TaskEvent;
      try {
        ev = JSON.parse(data) as TaskEvent;
      } catch {
        return;
      }
      switch (ev.header?.event) {
        case 'task-started':
          send('continue-task', { input: { text: req.text } });
          send('finish-task', { input: {} });
          break;
        case 'task-finished':
          finish();
          break;
        case 'task-failed':
          finish(dashscopeError('tts', { code: ev.header.error_code, message: ev.header.error_message, model: this.model }, this.cfg));
          break;
      }
    };
    ws.onerror = (err) => finish(dashscopeError('tts', { message: err.message, model: this.model }, this.cfg));
    ws.onclose = (code, reason) => {
      if (!done) finish(code === 1000 ? undefined : dashscopeError('tts', { closeCode: code, closeReason: reason, model: this.model }, this.cfg));
    };

    try {
      for (;;) {
        while (chunks.length) yield chunks.shift()!;
        if (done) break;
        await new Promise<void>((r) => (wake = r));
      }
      while (chunks.length) yield chunks.shift()!;
      if (failure) throw failure;
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onAbort);
      finish();
    }
  }
}

/** (Moved: also used by the natural voices.) */
export { FallbackTts } from '../fallback-tts';
