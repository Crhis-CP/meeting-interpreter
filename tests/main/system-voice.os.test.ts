import { describe, expect, it } from 'vitest';
import { SystemTts } from '../../src/main/providers/system-tts';
import { WindowsSpeechHost } from '../../src/main/providers/windows-speech-host';
import { ProviderError } from '../../src/core/providers/types';

/**
 * The computer's own voices, for real (no fakes). CI runs this on its Windows and macOS machines
 * with MI_REAL_VOICES=1; elsewhere it is skipped.
 */
const real = process.env.MI_REAL_VOICES === '1' && (process.platform === 'win32' || process.platform === 'darwin');

async function seconds(tts: SystemTts, text: string, lang: 'en-US' | 'zh-CN'): Promise<number> {
  let samples = 0;
  let rate = 1;
  for await (const c of tts.synthesize({ text, lang, rate: 1 })) {
    samples += c.samples.length;
    rate = c.sampleRate;
  }
  return samples / rate;
}

describe.runIf(real)(`system voices on ${process.platform}`, () => {
  it('speaks English, and on Windows the long-running speech process does the work', async () => {
    const host = process.platform === 'win32' ? new WindowsSpeechHost() : null;
    const tts = new SystemTts({ speechHost: host });
    try {
      tts.warmUp();
      const t0 = Date.now();
      const first = await seconds(tts, 'Good morning, when can you deliver the first order?', 'en-US');
      const t1 = Date.now();
      const second = await seconds(tts, 'We need the samples before the end of the month.', 'en-US');
      const t2 = Date.now();
      console.log(`first sentence ${t1 - t0} ms (${first.toFixed(1)} s of audio), second ${t2 - t1} ms (${second.toFixed(1)} s)`);
      expect(first).toBeGreaterThan(1);
      expect(second).toBeGreaterThan(1);
      // The host did not give up and fall back to one PowerShell per sentence.
      if (host) expect(host.broken).toBe(false);
    } finally {
      host?.dispose();
    }
  }, 120_000);

  it('a language without an installed voice gives a clear message instead of hanging', async () => {
    const host = process.platform === 'win32' ? new WindowsSpeechHost() : null;
    const tts = new SystemTts({ speechHost: host });
    try {
      const got = await seconds(tts, '大家好，欢迎参加今天的会议。', 'zh-CN').catch((err: unknown) => err);
      if (typeof got === 'number') {
        console.log(`Chinese voice installed: ${got.toFixed(1)} s of audio`);
        expect(got).toBeGreaterThan(1);
      } else {
        console.log(`no Chinese voice: ${(got as Error).message}`);
        expect(got).toBeInstanceOf(ProviderError);
        expect((got as Error).message).toMatch(/语音/);
      }
    } finally {
      host?.dispose();
    }
  }, 120_000);
});
