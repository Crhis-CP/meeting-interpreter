import { OrderedPlayer } from '../../../browser/ordered-player';
import { safeRouting } from '@core/audio/device-check';
import type { AudioConfig, FromAudio, ToAudio } from '@shared/ipc';

type Dir = 'out' | 'in';
type Send = (msg: FromAudio) => void;

const WORKLET_URL = new URL('./pcm-worklet.js', document.baseURI).toString();

interface SinkCtx {
  ctx: AudioContext;
  bus: GainNode;
  tap: MediaStreamAudioDestinationNode;
}

/** `AudioContext` with an output device ('' = system default, null = silent). */
async function makeContext(sinkId: string | null): Promise<AudioContext> {
  const opts: AudioContextOptions & { sinkId?: string | { type: 'none' } } = { latencyHint: 'interactive' };
  if (sinkId === null) opts.sinkId = { type: 'none' };
  else if (sinkId) opts.sinkId = sinkId;
  try {
    return new AudioContext(opts);
  } catch {
    // Device vanished or sinkId unsupported: fall back to the default output.
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    return ctx;
  }
}

function pickMime(kind: 'audio' | 'video'): string {
  const candidates =
    kind === 'video'
      ? ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      : ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
}

/**
 * Everything audio, in the hidden audio window: captures the microphone and the meeting, streams
 * 16 kHz PCM to the main process, plays translated speech to the virtual microphone (for the
 * meeting) and to the headphones (for me) with the original ducked, and records the mix and
 * optionally the screen.
 */
export class AudioEngine {
  private cfg: AudioConfig | null = null;
  private micStream: MediaStream | null = null;
  private meetingStream: MediaStream | null = null;
  private captureCtx: AudioContext | null = null;
  private outSink: SinkCtx | null = null;
  private inSink: SinkCtx | null = null;
  private micToMeeting: GainNode | null = null;
  private originalGain: GainNode | null = null;
  /** Translated speech, per direction: whole sentences, in order (also across room speakers). */
  private players: Record<Dir, OrderedPlayer | null> = { out: null, in: null };
  private levels = { mic: 0, meeting: 0 };
  private timer: ReturnType<typeof setInterval> | null = null;
  private recorders: { kind: 'mix' | 'screen'; rec: MediaRecorder }[] = [];
  /** Starting and stopping recorders one after another (a quick off/on must not overlap). */
  private recOps: Promise<void> = Promise.resolve();
  private queueRec(op: () => Promise<void>): Promise<void> {
    this.recOps = this.recOps.then(op, op);
    return this.recOps;
  }
  private recCtx: AudioContext | null = null;
  private screenStream: MediaStream | null = null;
  private passthrough = false;
  private running = false;

  constructor(private readonly send: Send) {}

  async handle(msg: ToAudio): Promise<void> {
    switch (msg.type) {
      case 'start':
        return this.start(msg.config);
      case 'config':
        return this.reconfigure(msg.config);
      case 'stop':
        return this.stop();
      case 'tts':
        return this.players[msg.dir]?.push(msg.segmentId, new Int16Array(msg.pcm), msg.sampleRate);
      case 'ttsEnd':
        return this.players[msg.dir]?.end(msg.segmentId);
      case 'flush':
        return this.flush(msg.dir);
      case 'passthrough':
        this.passthrough = msg.on;
        this.applyGains();
        return;
      case 'micGate':
        return;
      case 'startRecording':
        return this.queueRec(() => this.startRecording(msg.audio, msg.screen, msg.screenSourceId));
      case 'stopRecording':
        return this.queueRec(() => this.stopRecording());
      case 'testTone':
        return this.testTone(msg.target, msg.config);
    }
  }

  private log(message: string): void {
    this.send({ type: 'log', message });
  }

  async start(cfg: AudioConfig): Promise<void> {
    if (this.running) await this.stop();
    this.cfg = cfg;
    this.running = true;
    // A new meeting never inherits "original voice into the meeting" from the last one.
    this.passthrough = false;
    const warnings: string[] = [];
    let loopbackExcludesSelf: boolean | null = null;

    this.captureCtx = await makeContext(null);
    await this.captureCtx.audioWorklet.addModule(WORKLET_URL);

    // What each path really uses now: an unplugged device falls back to the system default, and a
    // path that would feed the app its own output (e.g. VB-CABLE became the default) is not opened.
    let devices = await listDevices();
    let route = safeRouting(devices, cfg, cfg.foreignName);

    // Microphone → "out" (not opened when only listening).
    if (route.mic !== null && cfg.micWanted !== false) {
      try {
        this.micStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: route.mic ? { exact: route.mic } : undefined,
            echoCancellation: cfg.echoCancellation,
            noiseSuppression: cfg.noiseSuppression,
            autoGainControl: cfg.autoGainControl,
            channelCount: 1,
          },
        });
      } catch (err) {
        warnings.push(`无法打开麦克风：${errText(err)}`);
      }
      // Without permission the labels were hidden: judge again now that they can be read.
      if (this.micStream && !devices.some((d) => d.label)) {
        devices = await listDevices();
        route = safeRouting(devices, cfg, cfg.foreignName);
        if (route.mic === null) {
          this.micStream.getTracks().forEach((t) => t.stop());
          this.micStream = null;
        }
      }
      if (this.micStream) this.capture(this.micStream, 'out');
    }
    warnings.push(...route.warnings);

    // Meeting audio → "in".
    if (cfg.meetingSource === 'device') {
      if (!cfg.meetingDevice) warnings.push('未选择“会议声音”设备：请在设置里选择虚拟扬声器（如 BlackHole 16ch / CABLE-A Output），或改用“系统声音”。');
      else if (route.meetingDevice !== null) {
        try {
          this.meetingStream = await navigator.mediaDevices.getUserMedia({
            audio: { deviceId: { exact: cfg.meetingDevice }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
          });
          this.capture(this.meetingStream, 'in');
        } catch (err) {
          warnings.push(`无法打开会议声音设备：${errText(err)}`);
        }
      }
    } else if (cfg.meetingSource === 'loopback') {
      try {
        const s = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: { restrictOwnAudio: true } as MediaTrackConstraints,
        });
        for (const t of s.getVideoTracks()) {
          t.stop();
          s.removeTrack(t);
        }
        const track = s.getAudioTracks()[0];
        if (!track || track.readyState === 'ended') throw new Error('没有拿到系统声音（macOS 请在“系统设置 › 隐私与安全性 › 录屏与系统录音”中允许本应用）');
        const caps = (track.getCapabilities?.() ?? {}) as { restrictOwnAudio?: boolean[] };
        loopbackExcludesSelf = Array.isArray(caps.restrictOwnAudio) ? caps.restrictOwnAudio.includes(true) : null;
        if (loopbackExcludesSelf === false) {
          warnings.push('此系统的“系统声音”采集会把本应用播放的中文译音也采进去（需要 macOS 14.2+ 或 Windows 11）。建议改用虚拟扬声器，或只看字幕。');
        }
        this.meetingStream = s;
        this.capture(s, 'in');
      } catch (err) {
        warnings.push(`无法采集系统声音：${errText(err)}`);
      }
    }

    // Outputs.
    if (cfg.virtualMic) this.outSink = await this.makeSink(cfg.virtualMic);
    else if (cfg.mode === 'meeting') warnings.push('未选择“虚拟麦克风”输出设备：对方听不到译音（只记录文字）。');
    this.inSink = route.headphones === null ? null : await this.makeSink(route.headphones);
    this.players.out = this.outSink ? new OrderedPlayer(this.outSink.ctx, this.outSink.bus) : null;
    this.players.in = this.inSink ? new OrderedPlayer(this.inSink.ctx, this.inSink.bus, { onActivity: () => this.applyDuck() }) : null;

    if (this.outSink && this.micStream && route.micToMeeting) {
      this.micToMeeting = this.outSink.ctx.createGain();
      // Start at the target level: a default gain of 1 would leak the raw voice into the meeting.
      this.micToMeeting.gain.value = this.passthrough ? 1 : cfg.originalMixOut;
      this.outSink.ctx.createMediaStreamSource(this.micStream).connect(this.micToMeeting).connect(this.outSink.ctx.destination);
    }
    if (this.inSink && this.meetingStream && cfg.meetingSource === 'device' && cfg.playOriginalIn) {
      this.originalGain = this.inSink.ctx.createGain();
      this.originalGain.gain.value = cfg.originalInVolume;
      this.inSink.ctx.createMediaStreamSource(this.meetingStream).connect(this.originalGain).connect(this.inSink.ctx.destination);
    }
    this.applyGains();

    this.timer = setInterval(() => this.tick(), 250);
    this.send({ type: 'started', loopbackExcludesSelf, warnings });
    if (cfg.record.audio || cfg.record.screen) void this.queueRec(() => this.startRecording(cfg.record.audio, cfg.record.screen, cfg.record.screenSourceId));
  }

  private async makeSink(sinkId: string): Promise<SinkCtx> {
    const ctx = await makeContext(sinkId);
    const bus = ctx.createGain();
    const tap = ctx.createMediaStreamDestination();
    bus.connect(ctx.destination);
    bus.connect(tap);
    return { ctx, bus, tap };
  }

  private capture(stream: MediaStream, dir: Dir): void {
    const ctx = this.captureCtx!;
    const src = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'pcm-capture', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit' });
    // For the log: which device opened, and whether any sound came from it in the first seconds
    // ("it doesn't hear me" is then one line in app.log).
    const name = dir === 'out' ? 'microphone' : 'meeting audio';
    const track = stream.getAudioTracks()[0];
    const st = track?.getSettings?.() ?? {};
    this.log(`${name}: "${track?.label ?? '?'}" ${st.sampleRate ?? '?'} Hz, ${track?.muted ? 'muted' : 'live'}; capture context ${ctx.sampleRate} Hz (${ctx.state})`);
    let frames = 0;
    let peak = 0;
    setTimeout(() => {
      if (this.running) this.log(`${name}: ${frames} audio frames in 3 s, peak ${peak > 1e-5 ? Math.round(20 * Math.log10(peak)) : -100} dB (context ${ctx.state})`);
    }, 3000);
    node.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; level: number }>) => {
      if (!this.running) return;
      frames++;
      peak = Math.max(peak, e.data.level);
      this.send({ type: 'pcm', dir, pcm: e.data.pcm });
      const key = dir === 'out' ? 'mic' : 'meeting';
      this.levels[key] = Math.max(this.levels[key] * 0.6, e.data.level);
    };
    src.connect(node);
  }

  private backlog(dir: Dir): number {
    return this.players[dir]?.backlog() ?? 0;
  }

  private tick(): void {
    const db = (v: number) => (v <= 1e-5 ? -100 : Math.round(20 * Math.log10(v)));
    this.send({ type: 'levels', mic: db(this.levels.mic), meeting: db(this.levels.meeting) });
    this.levels.mic *= 0.5;
    this.levels.meeting *= 0.5;
    this.send({ type: 'backlog', out: this.backlog('out'), in: this.backlog('in') });
    this.applyDuck();
  }

  private applyGains(): void {
    if (!this.cfg) return;
    if (this.micToMeeting && this.outSink) {
      const g = this.passthrough ? 1 : this.cfg.originalMixOut;
      this.micToMeeting.gain.setTargetAtTime(g, this.outSink.ctx.currentTime, 0.05);
    }
    this.applyDuck();
  }

  /** Lowers the meeting's original audio while a Chinese translation is playing. */
  private applyDuck(): void {
    if (!this.cfg || !this.originalGain || !this.inSink) return;
    const speaking = this.backlog('in') > 0.05;
    const target = this.cfg.originalInVolume * (speaking ? this.cfg.duckLevel : 1);
    this.originalGain.gain.setTargetAtTime(target, this.inSink.ctx.currentTime, speaking ? 0.08 : 0.4);
  }

  private flush(dir: Dir): void {
    this.players[dir]?.flush();
    this.applyDuck();
  }

  private async reconfigure(cfg: AudioConfig): Promise<void> {
    const prev = this.cfg;
    if (!prev || !this.running) return;
    const devicesChanged =
      prev.mic !== cfg.mic ||
      prev.virtualMic !== cfg.virtualMic ||
      prev.meetingSource !== cfg.meetingSource ||
      prev.meetingDevice !== cfg.meetingDevice ||
      prev.headphones !== cfg.headphones ||
      prev.echoCancellation !== cfg.echoCancellation ||
      prev.noiseSuppression !== cfg.noiseSuppression ||
      prev.autoGainControl !== cfg.autoGainControl ||
      prev.playOriginalIn !== cfg.playOriginalIn ||
      prev.micWanted !== cfg.micWanted;
    if (devicesChanged) {
      // Recording continues in a new file only if restarted; keep it simple: restart capture & output.
      const rec = this.recorders.length > 0;
      await this.stop();
      await this.start({ ...cfg, record: rec ? cfg.record : { ...cfg.record, audio: false, screen: false } });
      return;
    }
    this.cfg = cfg;
    this.applyGains();
  }

  // ------------------------------------------------------------------ recording

  private async startRecording(audio: boolean, screen: boolean, screenSourceId: string): Promise<void> {
    if (this.recorders.length) return;
    this.recCtx = await makeContext(null);
    const ctx = this.recCtx;
    const mix = ctx.createMediaStreamDestination();
    const add = (stream: MediaStream | null | undefined, gain = 1) => {
      if (!stream || !stream.getAudioTracks().length) return;
      const g = ctx.createGain();
      g.gain.value = gain;
      ctx.createMediaStreamSource(stream).connect(g).connect(mix);
    };
    add(this.micStream);
    add(this.meetingStream);
    add(this.outSink?.tap.stream);
    add(this.inSink?.tap.stream);

    if (audio) {
      const mime = pickMime('audio');
      try {
        const rec = new MediaRecorder(mix.stream, mime ? { mimeType: mime, audioBitsPerSecond: 64000 } : undefined);
        this.wireRecorder(rec, 'mix', mime || rec.mimeType);
      } catch (err) {
        this.send({ type: 'recError', kind: 'mix', message: errText(err) });
      }
    }
    if (screen) {
      try {
        if (!screenSourceId) throw new Error('未选择要录制的屏幕或窗口');
        const video = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: screenSourceId, maxFrameRate: 15, maxWidth: 1920, maxHeight: 1080 },
          } as unknown as MediaTrackConstraints,
        });
        this.screenStream = video;
        const combined = new MediaStream([...video.getVideoTracks(), ...mix.stream.getAudioTracks()]);
        const mime = pickMime('video');
        const rec = new MediaRecorder(combined, mime ? { mimeType: mime, videoBitsPerSecond: 2_500_000, audioBitsPerSecond: 96000 } : undefined);
        this.wireRecorder(rec, 'screen', mime || rec.mimeType);
      } catch (err) {
        this.send({ type: 'recError', kind: 'screen', message: errText(err) });
      }
    }
  }

  private wireRecorder(rec: MediaRecorder, kind: 'mix' | 'screen', mime: string): void {
    // Chunks are read asynchronously; keep them in order and report "stopped" only after the last
    // one has been sent, or the end of the recording would be lost.
    let pending: Promise<void> = Promise.resolve();
    rec.ondataavailable = (e) => {
      if (!e.data.size) return;
      const blob = e.data;
      pending = pending.then(async () => this.send({ type: 'recChunk', kind, mime, data: await blob.arrayBuffer() }));
    };
    rec.onstop = () => void pending.then(() => this.send({ type: 'recStopped', kind }));
    rec.onerror = (e) => this.send({ type: 'recError', kind, message: String((e as unknown as { error?: Error }).error?.message ?? 'MediaRecorder error') });
    rec.start(1000);
    this.recorders.push({ kind, rec });
    this.log(`recording ${kind} as ${mime}`);
  }

  private async stopRecording(): Promise<void> {
    const recs = this.recorders;
    this.recorders = [];
    await Promise.all(
      recs.map(
        ({ rec }) =>
          new Promise<void>((resolve) => {
            if (rec.state === 'inactive') return resolve();
            rec.addEventListener('stop', () => resolve(), { once: true });
            rec.stop();
          }),
      ),
    );
    this.screenStream?.getTracks().forEach((t) => t.stop());
    this.screenStream = null;
    await this.recCtx?.close().catch(() => undefined);
    this.recCtx = null;
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.queueRec(() => this.stopRecording());
    this.flush('out');
    this.flush('in');
    for (const s of [this.micStream, this.meetingStream]) s?.getTracks().forEach((t) => t.stop());
    this.micStream = null;
    this.meetingStream = null;
    for (const c of [this.captureCtx, this.outSink?.ctx, this.inSink?.ctx]) await c?.close().catch(() => undefined);
    this.captureCtx = null;
    this.outSink = null;
    this.inSink = null;
    this.players = { out: null, in: null };
    this.micToMeeting = null;
    this.originalGain = null;
  }

  private async testTone(target: 'virtualMic' | 'headphones', cfg: AudioConfig): Promise<void> {
    let sinkId = target === 'virtualMic' ? cfg.virtualMic : cfg.headphones;
    if (target === 'virtualMic' && !sinkId) {
      this.send({ type: 'error', message: '还没有选择虚拟麦克风输出设备' });
      return;
    }
    if (target === 'headphones') {
      const route = safeRouting(await listDevices(), cfg, cfg.foreignName);
      if (route.headphones === null) {
        this.send({ type: 'error', message: route.warnings.find((w) => w.startsWith('中文译音不播放')) ?? '耳机设备不能用' });
        return;
      }
      sinkId = route.headphones;
    }
    const ctx = await makeContext(sinkId || '');
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.value = 660;
    g.gain.setValueAtTime(0, ctx.currentTime);
    g.gain.linearRampToValueAtTime(0.25, ctx.currentTime + 0.05);
    g.gain.setValueAtTime(0.25, ctx.currentTime + 0.8);
    g.gain.linearRampToValueAtTime(0, ctx.currentTime + 1);
    osc.connect(g).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 1.05);
    osc.onended = () => void ctx.close();
  }
}

async function listDevices(): Promise<MediaDeviceInfo[]> {
  return navigator.mediaDevices.enumerateDevices().catch(() => []);
}

function errText(err: unknown): string {
  if (err instanceof DOMException) {
    if (err.name === 'NotAllowedError') return '没有权限（请在系统设置中允许本应用使用麦克风/录屏）';
    if (err.name === 'NotFoundError' || err.name === 'OverconstrainedError') return '找不到该设备（可能已拔出），请重新选择';
    if (err.name === 'NotReadableError') return '设备被其他程序占用';
    return `${err.name}: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}
