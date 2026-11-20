/**
 * Records a short sample of the user's own voice (for 百炼声音复刻) in any browser context:
 * the desktop window, the extension's settings page, the phone app. Returns a 24 kHz mono WAV.
 */
import { floatToInt16, resampleLinear } from '../core/audio/pcm';
import { encodeWav } from '../core/audio/wav';

/** What the user reads aloud (about 15 seconds at a normal pace). */
export const SAMPLE_SCRIPT =
  '大家好，这是我的声音样本。今天我们一起讨论一下项目的进展、交货时间和价格。如果有任何问题，欢迎随时提出来，我会尽量详细地回答。谢谢大家的配合，祝我们合作愉快。';

export const SAMPLE_SECONDS = 16;
const RATE = 24000;

export async function recordVoiceSample(seconds = SAMPLE_SECONDS, onTick?: (left: number, level: number) => void): Promise<Uint8Array> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
  const ctx = new AudioContext();
  try {
    await ctx.resume();
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    const parts: Float32Array[] = [];
    let level = 0;
    proc.onaudioprocess = (e) => {
      const d = e.inputBuffer.getChannelData(0);
      parts.push(new Float32Array(d));
      let peak = 0;
      for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]!));
      level = peak;
    };
    src.connect(proc).connect(mute).connect(ctx.destination);
    for (let left = seconds; left > 0; left--) {
      onTick?.(left, level);
      await new Promise((r) => setTimeout(r, 1000));
    }
    onTick?.(0, level);
    src.disconnect();
    proc.disconnect();
    const total = parts.reduce((n, p) => n + p.length, 0);
    const all = new Float32Array(total);
    let o = 0;
    for (const p of parts) {
      all.set(p, o);
      o += p.length;
    }
    let peak = 0;
    for (let i = 0; i < all.length; i++) peak = Math.max(peak, Math.abs(all[i]!));
    if (peak < 0.02) throw new Error('几乎没录到声音：请检查麦克风，靠近一点再录');
    return encodeWav(floatToInt16(resampleLinear(all, ctx.sampleRate, RATE)), RATE);
  } finally {
    for (const t of stream.getTracks()) t.stop();
    await ctx.close().catch(() => undefined);
  }
}
