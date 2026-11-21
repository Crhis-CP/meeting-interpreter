import type { LangCode, PcmChunk } from '../types';
import type { Tts, TtsRequest, VoiceInfo } from './types';

/**
 * Speaks with one voice and, should that fail before a sound (the cloned voice deleted, the natural
 * voices not downloaded yet), falls back to another for the rest of the meeting, so the listener
 * keeps hearing the translation.
 */
export class FallbackTts implements Tts {
  readonly id: string;
  private broken = false;
  constructor(
    private readonly primary: Tts,
    private readonly fallback: Tts,
    private readonly onFallback?: (err: unknown) => void,
  ) {
    this.id = primary.id;
  }

  voices(l: LangCode): VoiceInfo[] {
    return this.primary.voices(l);
  }

  async *synthesize(req: TtsRequest): AsyncIterable<PcmChunk> {
    if (!this.broken) {
      let got = false;
      try {
        for await (const c of this.primary.synthesize(req)) {
          got = true;
          yield c;
        }
        return;
      } catch (err) {
        if (got || req.signal?.aborted) throw err;
        this.broken = true;
        this.onFallback?.(err);
      }
    }
    yield* this.fallback.synthesize({ ...req, voice: undefined });
  }
}
