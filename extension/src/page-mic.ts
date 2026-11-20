/**
 * Runs in the meeting page's own JavaScript world, before the page's scripts.
 *
 * Wraps getUserMedia so the meeting receives an audio track we control: before interpretation
 * starts (and in passthrough) it carries the real microphone; while interpretation runs it
 * carries only the translated speech, so the other side never hears the original voice. The real
 * microphone is resampled to 16 kHz and handed to the extension for recognition.
 *
 * If anything here fails, the page gets its original stream: the meeting must never lose its mic.
 */
import { base64ToBytes, bytesToBase64, bytesToInt16, floatToInt16, int16ToBytes, int16ToFloat, resampleLinear } from '@core/audio/pcm';
import { PAGE_TAG, type BridgeToMain, type MainToBridge, type DOmit } from './protocol';
import { OrderedPlayer } from '../../src/browser/ordered-player';

interface Hook {
  real: MediaStreamTrack;
  out: MediaStreamTrack;
  pass: GainNode;
  nodes: AudioNode[];
  createdAt: number;
}

(() => {
  const md = navigator.mediaDevices;
  if (!md?.getUserMedia || (window as unknown as Record<string, unknown>)[PAGE_TAG]) return;
  (window as unknown as Record<string, unknown>)[PAGE_TAG] = true;

  const original = md.getUserMedia.bind(md);
  const hooks: Hook[] = [];
  let ctx: AudioContext | null = null;
  let ttsBus: GainNode | null = null;
  let active = false;
  let passthrough = false;
  /** The translated voice into the meeting's microphone: whole sentences, in order. */
  let player: OrderedPlayer | null = null;

  const post = (m: DOmit<MainToBridge, typeof PAGE_TAG>) => window.postMessage({ [PAGE_TAG]: 'main', ...m }, '*');

  const audioContext = (): AudioContext => {
    if (!ctx) {
      ctx = new AudioContext({ latencyHint: 'interactive' });
      ttsBus = ctx.createGain();
      const resume = () => {
        if (ctx?.state === 'suspended') void ctx.resume().catch(() => undefined);
      };
      // Autoplay rules may start the context suspended; any click or key in the meeting resumes it.
      for (const ev of ['pointerdown', 'keydown', 'touchstart']) window.addEventListener(ev, resume, { capture: true });
      resume();
    }
    return ctx;
  };

  const live = () => hooks.filter((h) => h.out.readyState === 'live' && h.real.readyState === 'live');
  /** The microphone the meeting is using now: the newest live hook. */
  const current = () => live().sort((a, b) => b.createdAt - a.createdAt)[0];

  const applyMode = () => {
    if (!ctx) return;
    const v = !active || passthrough ? 1 : 0;
    for (const h of hooks) h.pass.gain.setTargetAtTime(v, ctx.currentTime, 0.02);
    if (!active) flush();
  };

  const flush = () => player?.flush();

  const playTts = (id: string, pcmB64: string, rate: number) => {
    if (!ctx || !ttsBus || !active) return;
    player ??= new OrderedPlayer(ctx, ttsBus, { lead: 0.02 });
    player.push(id || 'tts', bytesToInt16(base64ToBytes(pcmB64)), rate);
  };

  const hook = (stream: MediaStream): MediaStream => {
    const real = stream.getAudioTracks()[0];
    if (!real) return stream;
    const ac = audioContext();
    const src = ac.createMediaStreamSource(new MediaStream([real]));
    const dest = ac.createMediaStreamDestination();
    dest.channelCount = 1;
    const pass = ac.createGain();
    pass.gain.value = !active || passthrough ? 1 : 0;
    src.connect(pass).connect(dest);
    ttsBus!.connect(dest);

    // Tap the real microphone for recognition (ScriptProcessor needs no extra script URL, so the
    // page's content security policy cannot block it).
    const proc = ac.createScriptProcessor(4096, 1, 1);
    const mute = ac.createGain();
    mute.gain.value = 0;
    src.connect(proc).connect(mute).connect(ac.destination);

    const out = dest.stream.getAudioTracks()[0]!;
    const h: Hook = { real, out, pass, nodes: [src, dest, pass, proc, mute], createdAt: performance.now() };
    proc.onaudioprocess = (e) => {
      if (!active || current() !== h || !out.enabled) return;
      const input = e.inputBuffer.getChannelData(0);
      const pcm = floatToInt16(resampleLinear(input, ac.sampleRate, 16000));
      post({ t: 'mic', pcm: bytesToBase64(int16ToBytes(pcm)) });
    };

    // Look like the real microphone to the meeting app (device name, settings) and stop it with ours.
    try {
      Object.defineProperty(out, 'label', { get: () => real.label });
      const settings = out.getSettings.bind(out);
      out.getSettings = () => ({ ...settings(), ...real.getSettings() });
      out.getCapabilities = () => real.getCapabilities();
      out.getConstraints = () => real.getConstraints();
      out.applyConstraints = (c) => real.applyConstraints(c);
      const stop = out.stop.bind(out);
      out.stop = () => {
        stop();
        real.stop();
        for (const n of h.nodes) n.disconnect();
        const i = hooks.indexOf(h);
        if (i >= 0) hooks.splice(i, 1);
      };
    } catch {
      // Cosmetic only.
    }
    real.addEventListener('ended', () => out.dispatchEvent(new Event('ended')));
    hooks.push(h);
    post({ t: 'hooked' });
    return new MediaStream([out, ...stream.getVideoTracks()]);
  };

  md.getUserMedia = async function getUserMedia(constraints?: MediaStreamConstraints): Promise<MediaStream> {
    const stream = await original(constraints);
    if (!constraints?.audio) return stream;
    try {
      return hook(stream);
    } catch (err) {
      console.warn('[会议同传] 无法接管麦克风，使用原始麦克风', err);
      return stream;
    }
  };

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const m = e.data as BridgeToMain | undefined;
    if (!m || m[PAGE_TAG] !== 'bridge') return;
    switch (m.t) {
      case 'mode':
        active = m.active;
        passthrough = m.passthrough;
        if (active && ctx?.state === 'suspended') void ctx.resume().catch(() => undefined);
        applyMode();
        break;
      case 'tts':
        playTts(m.id, m.pcm, m.rate);
        break;
      case 'ttsEnd':
        player?.end(m.id);
        break;
      case 'ttsFlush':
        flush();
        break;
      case 'ping':
        if (live().length) post({ t: 'hooked' });
        break;
    }
  });
})();
