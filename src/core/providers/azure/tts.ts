import { abortError } from '../../events';
import { lang } from '../../lang/languages';
import type { LangCode, PcmChunk } from '../../types';
import { httpRequest, readBody } from '../http';
import { ProviderError, type ProviderContext, type Tts, type TtsRequest, type VoiceInfo } from '../types';
import { AZURE_TTS_NAME, azureVoicesFor, defaultAzureVoice, ttsUrl, type AzureConfig } from './common';

/** `raw-24khz-16bit-mono-pcm`: headerless little-endian 16-bit mono at 24 kHz. */
export const AZURE_TTS_SAMPLE_RATE = 24000;
export const AZURE_TTS_FORMAT = 'raw-24khz-16bit-mono-pcm';
/** Fails the stream when the service sends nothing for this long mid-sentence. */
const IDLE_TIMEOUT_MS = 15000;

/** Escapes text for XML content and attribute values, dropping characters XML 1.0 forbids. */
export function escapeXml(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Speed factor → SSML relative rate: 1.0 → `+0%`, 1.2 → `+20%`, 0.9 → `-10%` (clamped to −50…+100 %). */
export function prosodyRate(rate: number): string {
  const r = Number.isFinite(rate) && rate > 0 ? rate : 1;
  const pct = Math.max(-50, Math.min(100, Math.round((r - 1) * 100)));
  return pct < 0 ? `${pct}%` : `+${pct}%`;
}

/**
 * The SSML document for one sentence. HD (`DragonHD`) voices do not support a speaking rate, so
 * they get no `<prosody>`.
 */
export function buildSsml(text: string, language: LangCode, voice: string, rate: number): string {
  const body = /DragonHD/i.test(voice) ? escapeXml(text) : `<prosody rate="${prosodyRate(rate)}">${escapeXml(text)}</prosody>`;
  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${escapeXml(language)}">` +
    `<voice name="${escapeXml(voice)}">${body}</voice></speak>`
  );
}

/** Decodes a stream of little-endian 16-bit bytes, carrying an odd trailing byte to the next chunk. */
export class PcmByteDecoder {
  private carry: number | null = null;

  push(chunk: Uint8Array): Int16Array {
    const total = chunk.length + (this.carry === null ? 0 : 1);
    const out = new Int16Array(total >> 1);
    let i = 0;
    let o = 0;
    if (this.carry !== null && chunk.length > 0) {
      out[o++] = (((chunk[0]! << 8) | this.carry) << 16) >> 16;
      i = 1;
      this.carry = null;
    }
    for (; i + 1 < chunk.length; i += 2) out[o++] = (((chunk[i + 1]! << 8) | chunk[i]!) << 16) >> 16;
    if (i < chunk.length) this.carry = chunk[i]!;
    return out;
  }

  /** True when a byte is waiting for its pair. */
  get pending(): boolean {
    return this.carry !== null;
  }
}

/** Waits for the next body chunk, failing on abort or when the stream stalls. */
function nextChunk<T>(next: Promise<IteratorResult<T>>, signal: AbortSignal | undefined): Promise<IteratorResult<T>> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new ProviderError(`${AZURE_TTS_NAME}：音频流中断（${IDLE_TIMEOUT_MS / 1000} 秒没有收到数据）`, AZURE_TTS_NAME, { retryable: true }));
    }, IDLE_TIMEOUT_MS);
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    next.then(
      (r) => {
        cleanup();
        resolve(r);
      },
      (e) => {
        cleanup();
        reject(e);
      },
    );
  });
}

/** Azure voices have locale-prefixed ids (`es-MX-DaliaNeural`); anything else is another provider's. */
const AZURE_VOICE_ID = /^[a-z]{2,3}-[a-z0-9]{2,8}-\S+$/i;

/**
 * Neural text-to-speech over REST: one POST per sentence, raw 24 kHz PCM streamed back while it
 * is synthesised.
 */
export class AzureTts implements Tts {
  readonly id = 'azure';

  constructor(
    private readonly cfg: AzureConfig,
    private readonly ctx: ProviderContext,
  ) {}

  voices(language: LangCode): VoiceInfo[] {
    return azureVoicesFor(language).map((v) => ({ ...v }));
  }

  async *synthesize(req: TtsRequest): AsyncIterable<PcmChunk> {
    const text = req.text.trim();
    if (!text) return;
    const key = (this.cfg.key ?? '').trim();
    if (!key) throw new ProviderError(`${AZURE_TTS_NAME}：请先填写 Azure 语音 Key`, AZURE_TTS_NAME);
    const url = ttsUrl(this.cfg);
    const voice = req.voice && AZURE_VOICE_ID.test(req.voice) ? req.voice : defaultAzureVoice(req.lang);
    let xmlLang: string;
    try {
      xmlLang = lang(req.lang).codes.azure;
    } catch {
      xmlLang = req.lang;
    }
    if (req.signal?.aborted) throw abortError();

    let res: Response;
    try {
      res = await httpRequest(this.ctx, AZURE_TTS_NAME, url, {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': key,
          'Content-Type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': AZURE_TTS_FORMAT,
          'User-Agent': 'meeting-interpreter',
        },
        body: buildSsml(text, xmlLang, voice, req.rate),
        signal: req.signal,
        timeoutMs: 15000,
        retries: 1,
      });
    } catch (err) {
      if (err instanceof ProviderError && err.status === 401) {
        throw new ProviderError(`${AZURE_TTS_NAME}：Key 无效或与区域不匹配（401），请检查 Azure 语音 Key 和区域`, AZURE_TTS_NAME, {
          status: 401,
          retryable: false,
          cause: err,
        });
      }
      throw err;
    }

    const decoder = new PcmByteDecoder();
    const body = readBody(res)[Symbol.asyncIterator]();
    let bytes = 0;
    let complete = false;
    try {
      for (;;) {
        let r: IteratorResult<Uint8Array>;
        try {
          r = await nextChunk(body.next(), req.signal);
        } catch (err) {
          if (err instanceof ProviderError || req.signal?.aborted) throw req.signal?.aborted ? abortError() : err;
          const msg = err instanceof Error ? err.message : String(err);
          throw new ProviderError(`${AZURE_TTS_NAME}：音频流中断（${msg}）`, AZURE_TTS_NAME, { retryable: true, cause: err });
        }
        if (r.done) break;
        bytes += r.value.length;
        const samples = decoder.push(r.value);
        if (samples.length) yield { samples, sampleRate: AZURE_TTS_SAMPLE_RATE };
      }
      complete = true;
      if (bytes === 0) this.ctx.log.warn(`${AZURE_TTS_NAME}: empty audio for voice ${voice}`);
      else if (decoder.pending) this.ctx.log.debug(`${AZURE_TTS_NAME}: dropped a trailing odd byte`);
    } finally {
      if (!complete) {
        // Stopped early (abort, error or the consumer broke off): stop downloading the rest.
        void Promise.resolve(body.return?.())
          .then(() => res.body?.cancel())
          .catch(() => undefined);
      }
    }
  }
}
