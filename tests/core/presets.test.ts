import { describe, expect, it } from 'vitest';
import { PLANS, preset } from '@core/config/presets';
import { MODELS } from '../../src/main/providers/local-asr/models';
import { AI_MODELS } from '../../src/main/providers/local-ai/model';
import { TTS_MODELS } from '../../src/main/providers/neural-tts/models';
import manifest from '../../src/browser/offline-mt/manifest.json';

describe('plan cards', () => {
  it('every real plan says how accurate it is, what the other side hears and what it takes; the demo is not a plan', () => {
    expect(PLANS().map((p) => p.id)).toEqual(['free', 'dashscope', 'azure']);
    for (const p of PLANS()) expect(p.card?.accuracy && p.card.voice && p.card.takes).toBeTruthy();
    expect(preset('demo')?.hidden).toBe(true);
  });

  it('the free plan’s download size is what its models really add up to', () => {
    const bytes =
      ['silero-vad', 'sensevoice', 'parakeet-v3'].reduce((n, id) => n + MODELS[id as keyof typeof MODELS].files.reduce((m, f) => m + f.size, 0), 0) +
      AI_MODELS['hy-mt2-1.8b'].files.reduce((m, f) => m + f.size, 0) +
      TTS_MODELS['kokoro-v1.0'].files.reduce((m, f) => m + f.size, 0) +
      (manifest as { files: { size: number }[] }).files.reduce((m, f) => m + f.size, 0);
    const said = Number(/约 ([\d.]+) GB/.exec(preset('free')!.card!.takes)![1]);
    expect(Math.abs(said - bytes / 1e9)).toBeLessThan(0.1);
  });
});
