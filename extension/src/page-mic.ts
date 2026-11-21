/**
 * Runs in the meeting page's own JavaScript world, before the page's scripts.
 *
 * Wraps getUserMedia so the meeting receives an audio track we control: before interpretation
 * starts (and in passthrough) it carries the real microphone; while interpretation runs it
 * carries only the translated speech, so the other side never hears the original voice. The real
 * microphone is resampled to 16 kHz and handed to the extension for recognition.
 *
 * If anything here fails, the page gets its original stream: the meeting must never lose its mic.
 * In particular, while autoplay rules keep our audio context suspended (nobody has clicked the
 * page yet) its output is silence: then the page gets its real microphone untouched, and when
 * interpretation starts we take over the call's audio sender instead (replaceTrack), giving the
 * real track back when it stops.
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
  /** Took over a call's audio sender (the page keeps its real track): given back when interpretation stops. */
  sender?: RTCRtpSender;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  /** How often the call's microphone was taken over / given back (diagnostics). */
  const switches = { takeOver: 0, giveBack: 0, modes: [] as string[] };
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

  /** Our track in place of `real`: the real voice (passthrough) or the translation, switchable. */
  const makeHook = (real: MediaStreamTrack, owned: boolean): Hook => {
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
      // A taken-over sender: the meeting mutes its own (real) track; the translation mutes with it.
      if (h.sender) out.enabled = real.enabled;
      if (!active || current() !== h || !out.enabled) return;
      const input = e.inputBuffer.getChannelData(0);
      const pcm = floatToInt16(resampleLinear(input, ac.sampleRate, 16000));
      post({ t: 'mic', pcm: bytesToBase64(int16ToBytes(pcm)) });
    };

    if (owned) {
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
          dispose(h);
        };
      } catch {
        // Cosmetic only.
      }
      real.addEventListener('ended', () => out.dispatchEvent(new Event('ended')));
    }
    hooks.push(h);
    post({ t: 'hooked' });
    return h;
  };

  /** Removes our nodes (the real track is the page's business). */
  const dispose = (h: Hook) => {
    for (const n of h.nodes) n.disconnect();
    const i = hooks.indexOf(h);
    if (i >= 0) hooks.splice(i, 1);
  };

  /** Starts our audio context if the page allows it now; never waits long. */
  const running = async (): Promise<boolean> => {
    const ac = audioContext();
    if (ac.state !== 'running') await Promise.race([ac.resume().catch(() => undefined), sleep(150)]);
    return ac.state === 'running';
  };

  // The call's audio senders, to take over when interpretation starts after the page already has
  // its real microphone (and to give them back).
  const senders = new Set<RTCRtpSender>();
  const PC = (window as unknown as { RTCPeerConnection?: typeof RTCPeerConnection }).RTCPeerConnection;
  const Sender = (window as unknown as { RTCRtpSender?: typeof RTCRtpSender }).RTCRtpSender;
  const replace = Sender?.prototype.replaceTrack;
  if (PC && Sender && replace) {
    try {
      const addTrack = PC.prototype.addTrack;
      PC.prototype.addTrack = function (this: RTCPeerConnection, track: MediaStreamTrack, ...streams: MediaStream[]) {
        const sender = addTrack.call(this, track, ...streams);
        if (track.kind === 'audio') senders.add(sender);
        return sender;
      };
      const addTransceiver = PC.prototype.addTransceiver;
      PC.prototype.addTransceiver = function (this: RTCPeerConnection, t: MediaStreamTrack | string, init?: RTCRtpTransceiverInit) {
        const tr = addTransceiver.call(this, t, init);
        if ((typeof t === 'string' ? t : t.kind) === 'audio') senders.add(tr.sender);
        return tr;
      };
      // The meeting switching microphones while we hold its sender: the new one is taken over too.
      Sender.prototype.replaceTrack = function (this: RTCRtpSender, track: MediaStreamTrack | null) {
        const held = hooks.find((h) => h.sender === this);
        if (held) dispose(held);
        if (active && track && track.kind === 'audio' && track.readyState === 'live' && !hooks.some((h) => h.out === track) && ctx?.state === 'running') {
          const h = makeHook(track, false);
          h.sender = this;
          return replace.call(this, h.out);
        }
        return replace.call(this, track);
      };
    } catch {
      // Without this the page-level hook below still works.
    }
  }

  /** Interpretation started while the call sends a microphone we do not control: take it over. */
  const takeOver = async () => {
    if (!replace || !(await running())) return;
    for (const s of senders) {
      const t = s.track;
      if (!active || !t || t.kind !== 'audio' || t.readyState !== 'live' || hooks.some((h) => h.out === t)) continue;
      const h = makeHook(t, false);
      h.sender = s;
      switches.takeOver++;
      await replace.call(s, h.out).catch(() => dispose(h));
    }
  };

  /** Interpretation stopped: the call sends the meeting's own microphone again. */
  const giveBack = () => {
    if (!replace) return;
    for (const h of hooks.filter((x) => x.sender)) {
      switches.giveBack++;
      void replace.call(h.sender!, h.real).catch(() => undefined);
      dispose(h);
    }
  };

  const hook = (stream: MediaStream): MediaStream => {
    const real = stream.getAudioTracks()[0];
    if (!real) return stream;
    const h = makeHook(real, true);
    return new MediaStream([h.out, ...stream.getVideoTracks()]);
  };

  md.getUserMedia = async function getUserMedia(constraints?: MediaStreamConstraints): Promise<MediaStream> {
    const stream = await original(constraints);
    if (!constraints?.audio) return stream;
    try {
      // A suspended context would hand the meeting a silent microphone: give it the real one.
      if (!(await running())) return stream;
      return hook(stream);
    } catch (err) {
      console.warn('[会议同传] 无法接管麦克风，使用原始麦克风', err);
      return stream;
    }
  };

  // Read-only state for diagnostics (tests, support): nothing private in it.
  try {
    Object.defineProperty(window, '__meetingInterpreterMic', {
      get: () => ({ active, passthrough, context: ctx?.state ?? null, senders: senders.size, hooks: hooks.map((h) => ({ sender: !!h.sender, live: h.out.readyState === 'live' })), switches }),
    });
  } catch {
    // Diagnostics only.
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const m = e.data as BridgeToMain | undefined;
    if (!m || m[PAGE_TAG] !== 'bridge') return;
    switch (m.t) {
      case 'mode': {
        const was = active;
        if (switches.modes.length < 20) switches.modes.push(`${Math.round(performance.now())}:${m.active ? 'on' : 'off'}${m.passthrough ? '+pass' : ''}`);
        active = m.active;
        passthrough = m.passthrough;
        if (active && ctx?.state === 'suspended') void ctx.resume().catch(() => undefined);
        applyMode();
        if (active && !was) void takeOver();
        if (!active && was) giveBack();
        break;
      }
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
