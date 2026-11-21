/**
 * Records the microphone until stopped (accent calibration): 16 kHz mono PCM, with a live level.
 * Works in any browser context (desktop window, extension page, phone app).
 */
import { floatToInt16, resampleLinear } from '../core/audio/pcm';

export interface Recording {
  /** Peak level of the last ~0.1 s (0…1). */
  level(): number;
  seconds(): number;
  stop(): Promise<Int16Array>;
  cancel(): void;
}

/**
 * @param deviceId the chosen microphone ('' = system default; one that is unplugged falls back to it)
 * @param maxSeconds recording stops collecting after this (a forgotten recording never grows without end)
 */
export async function startRecording(deviceId = '', maxSeconds = 60): Promise<Recording> {
  const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
  const stream = await navigator.mediaDevices
    .getUserMedia({ audio: deviceId ? { ...audio, deviceId: { exact: deviceId } } : audio })
    .catch((err: unknown) => (deviceId ? navigator.mediaDevices.getUserMedia({ audio }) : Promise.reject(err)));
  const ctx = new AudioContext();
  await ctx.resume();
  const src = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(2048, 1, 1);
  const mute = ctx.createGain();
  mute.gain.value = 0;
  const parts: Float32Array[] = [];
  let level = 0;
  let total = 0;
  proc.onaudioprocess = (e) => {
    const d = e.inputBuffer.getChannelData(0);
    if (total < maxSeconds * ctx.sampleRate) {
      parts.push(new Float32Array(d));
      total += d.length;
    }
    let peak = 0;
    for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]!));
    level = peak;
  };
  src.connect(proc).connect(mute).connect(ctx.destination);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    src.disconnect();
    proc.disconnect();
    for (const t of stream.getTracks()) t.stop();
    void ctx.close().catch(() => undefined);
  };
  return {
    level: () => level,
    seconds: () => total / ctx.sampleRate,
    cancel: close,
    async stop() {
      const rate = ctx.sampleRate;
      close();
      const all = new Float32Array(total);
      let o = 0;
      for (const p of parts) {
        all.set(p, o);
        o += p.length;
      }
      let peak = 0;
      for (let i = 0; i < all.length; i++) peak = Math.max(peak, Math.abs(all[i]!));
      if (all.length < rate * 0.8) throw new Error('录音太短：请把这句话完整读完再点“读完了”');
      if (peak < 0.02) throw new Error('几乎没录到声音：请检查麦克风，靠近一点再读');
      return floatToInt16(resampleLinear(all, rate, 16000));
    },
  };
}
