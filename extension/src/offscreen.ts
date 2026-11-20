/**
 * The interpretation engine. Lives in the extension's offscreen document because it needs audio
 * (tab capture, playback) and long-lived network connections, which a service worker cannot keep.
 *
 *  我方: page microphone (via the bridge port) → recognise → translate → speak into the meeting
 *  对方: captured tab audio → recognise → translate → floating Chinese subtitles (optionally spoken)
 */
import { base64ToBytes, bytesToBase64, bytesToInt16, floatToInt16, int16ToBytes, int16ToFloat, resampleLinear } from '@core/audio/pcm';
import { otherLanguage } from '@core/lang/languages';
import { DirectionPipeline } from '@core/pipeline/pipeline';
import { Transcript } from '@core/session/transcript';
import type { Direction, MeetingMeta, TranscriptSegment } from '@core/types';
import { consoleLogger, createBrowserContext } from './browser-context';
import { buildProviders, offlineMt } from './engine-providers';
import { OfflineTranslator } from '@core/providers/offline-translator';
import { PORT_NAME, toAppSettings, type EngineToPage, type FromOffscreen, type PageToEngine, type SavedMeeting, type SessionState, type StoredData, type ToOffscreen, type DOmit } from './shared';

const log = consoleLogger('engine');

interface PagePort {
  port: chrome.runtime.Port;
  top: boolean;
  mic: boolean;
}

interface Session {
  tabId: number;
  meta: MeetingMeta;
  data: StoredData;
  startedAt: number;
  pipelines: Partial<Record<Direction, DirectionPipeline>>;
  transcript: Transcript;
  passthrough: boolean;
  ctx: AudioContext;
  tab: { stream: MediaStream; nodes: AudioNode[]; original: GainNode } | null;
  /** When the translated speech already sent to the page will have finished playing (ms). */
  outPlayedUntil: number;
  inNext: number;
  inPlaying: Set<AudioBufferSourceNode>;
}

let session: Session | null = null;
let starting: Promise<void> | null = null;
let startWarnings: string[] = [];
const ports = new Set<PagePort>();

const toBackground = (m: DOmit<FromOffscreen, 'target'>) => void chrome.runtime.sendMessage({ target: 'background', ...m }).catch(() => undefined);
const status = (patch: Partial<SessionState>) => toBackground({ type: 'status', patch });

const addHeaders = async (url: string, headers: Record<string, string>) => {
  const r = (await chrome.runtime.sendMessage({ target: 'background', type: 'wsHeaders', url, headers })) as { ok?: boolean; error?: string } | undefined;
  if (!r?.ok) throw new Error(r?.error ?? '无法设置连接参数');
};

function sendPage(m: EngineToPage, filter: (p: PagePort) => boolean = () => true) {
  for (const p of ports) {
    if (!filter(p)) continue;
    try {
      p.port.postMessage(m);
    } catch {
      ports.delete(p);
    }
  }
}

function modeMessage(): EngineToPage {
  return { t: 'mode', active: !!session, passthrough: session?.passthrough ?? false };
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;
  const tabId = port.sender?.tab?.id;
  if (!session || tabId !== session.tabId) {
    port.disconnect();
    return;
  }
  const p: PagePort = { port, top: port.sender?.frameId === 0, mic: false };
  ports.add(p);
  port.onDisconnect.addListener(() => ports.delete(p));
  port.onMessage.addListener((m: PageToEngine) => {
    const s = session;
    if (!s) return;
    switch (m.t) {
      case 'hello':
        p.top = m.top;
        p.mic = m.micHooked;
        if (p.mic) status({ micHooked: true });
        break;
      case 'micHooked':
        p.mic = true;
        status({ micHooked: true });
        break;
      case 'mic':
        s.pipelines.out?.push(bytesToInt16(base64ToBytes(m.pcm)));
        break;
    }
  });
  port.postMessage(modeMessage());
  port.postMessage({ t: 'subtitleStyle', size: session.data.settings.subtitleSize, showMine: session.data.settings.showMine } satisfies EngineToPage);
});

chrome.runtime.onMessage.addListener((msg: ToOffscreen, _sender, reply) => {
  if (msg?.target !== 'offscreen') return;
  (async () => {
    try {
      if (msg.type === 'start') {
        await start(msg);
        const s = session as Session | null;
        return reply({ ok: true, state: { status: 'running', startedAt: s?.startedAt ?? Date.now(), title: s?.meta.title ?? '', warnings: startWarnings } });
      } else if (msg.type === 'stop') return reply({ ok: true, meeting: await stop() });
      else if (msg.type === 'passthrough') setPassthrough(msg.on);
      reply({ ok: true });
    } catch (err) {
      reply({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  })();
  return true;
});

async function start(msg: Extract<ToOffscreen, { type: 'start' }>) {
  if (session || starting) return;
  starting = (async () => {
    const { data } = msg;
    const settings = toAppSettings(data.settings);
    const pctx = createBrowserContext(log, addHeaders);
    const providers = buildProviders(data.settings, data.secrets, pctx, () => data.glossary); // throws when a key is missing
    const now = Date.now();
    const meta: MeetingMeta = {
      id: new Date(now).toISOString().replace(/[:.]/g, '-'),
      title: msg.title || '网页会议',
      startedAt: new Date(now).toISOString(),
      selfLang: settings.languages.self,
      remoteLang: settings.languages.remote,
      mode: 'meeting',
      platform: '浏览器插件',
      files: {},
      providers: providers.describe(),
    };
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    const s: Session = {
      tabId: msg.tabId,
      meta,
      data,
      startedAt: now,
      pipelines: {},
      transcript: new Transcript(),
      passthrough: false,
      ctx,
      tab: null,
      outPlayedUntil: 0,
      inNext: 0,
      inPlaying: new Set(),
    };
    const warnings: string[] = [];

    // An offline draft in front of a cloud / LLM translator, when the models are in this browser.
    const draft = (await offlineMt().missingBytes().catch(() => 1)) === 0 ? new OfflineTranslator({ translate: (t, f, to) => offlineMt().translate(t, f, to) }) : undefined;
    for (const dir of ['out', 'in'] as const) {
      const src = dir === 'out' ? settings.languages.self : settings.languages.remote;
      const dst = otherLanguage(src, settings.languages.remote);
      const cfg = dir === 'out' ? settings.out : settings.in;
      const p = new DirectionPipeline({
        dir,
        speaker: dir === 'out' ? 'me' : 'them',
        idPrefix: dir,
        srcLang: src,
        dstLang: dst,
        asr: providers.asr(dir),
        translator: providers.mt(dir),
        draft: cfg.mt === 'offline' || cfg.mt === 'demo' ? undefined : draft,
        tts: providers.tts(dir),
        voice: cfg.voice || undefined,
        glossary: () => data.glossary,
        pinyinFuzzy: settings.interpretation.pinyinFuzzy,
        lowLatency: settings.interpretation.lowLatency,
        clock: () => (Date.now() - now) / 1000,
        speak: dir === 'out' ? () => !s.passthrough : () => s.data.settings.speakIn,
        idleCloseMs: 15000,
        log: log.child(dir),
      });
      p.on('segment', (seg) => onSegment(s, seg));
      p.on('partial', ({ text }) => sendPage({ t: 'partial', dir, text }, (x) => x.top));
      p.on('status', ({ state, message }) => status({ [dir]: { state, message } }));
      p.on('audio', ({ samples, sampleRate }) => (dir === 'out' ? sendOutAudio(s, samples, sampleRate) : playIn(s, samples, sampleRate)));
      s.pipelines[dir] = p;
    }

    if (msg.streamId) {
      try {
        s.tab = await captureTab(s, msg.streamId);
      } catch (err) {
        warnings.push(`无法采集会议声音，对方的发言不会有字幕：${err instanceof Error ? err.message : String(err)}`);
      }
    } else warnings.push('没有拿到会议声音（请从插件图标打开面板后点“开始”）。对方的发言不会有字幕。');

    session = s;
    startWarnings = warnings;
    await Promise.all(Object.values(s.pipelines).map((p) => p!.start()));
    status({ status: 'running', startedAt: now, title: meta.title, warnings });
    sendPage(modeMessage());
  })();
  try {
    await starting;
  } catch (err) {
    await teardown();
    throw err;
  } finally {
    starting = null;
  }
}

function onSegment(s: Session, seg: TranscriptSegment) {
  s.transcript.upsert(seg);
  sendPage({ t: 'seg', seg, mine: seg.dir === 'out' }, (x) => x.top);
}

/** Translated speech for the meeting: to every frame that holds the page's microphone. */
function sendOutAudio(s: Session, samples: Int16Array, rate: number) {
  const n = Date.now();
  s.outPlayedUntil = Math.max(s.outPlayedUntil, n) + (samples.length / rate) * 1000;
  s.pipelines.out?.setBacklog((s.outPlayedUntil - n) / 1000);
  // ~0.5 s per message keeps messages small.
  const step = Math.max(1, Math.floor(rate / 2));
  for (let i = 0; i < samples.length; i += step) {
    sendPage({ t: 'tts', id: '', rate, pcm: bytesToBase64(int16ToBytes(samples.subarray(i, i + step))) }, (x) => x.mic);
  }
}

/** Chinese speech of the other side, to me (only when enabled). Lowers the original meanwhile. */
function playIn(s: Session, samples: Int16Array, rate: number) {
  const f = int16ToFloat(samples);
  if (!f.length) return;
  const buf = s.ctx.createBuffer(1, f.length, rate);
  buf.copyToChannel(f as Float32Array<ArrayBuffer>, 0);
  const src = s.ctx.createBufferSource();
  src.buffer = buf;
  src.connect(s.ctx.destination);
  const at = Math.max(s.ctx.currentTime + 0.02, s.inNext);
  src.start(at);
  s.inNext = at + buf.duration;
  s.pipelines.in?.setBacklog(Math.max(0, s.inNext - s.ctx.currentTime));
  s.inPlaying.add(src);
  if (s.tab) s.tab.original.gain.setTargetAtTime(0.25 * originalVolume(s), at, 0.05);
  src.onended = () => {
    s.inPlaying.delete(src);
    if (!s.inPlaying.size && s.tab) s.tab.original.gain.setTargetAtTime(originalVolume(s), s.ctx.currentTime, 0.15);
  };
}

const originalVolume = (s: Session) => (s.data.settings.playOriginal ? s.data.settings.originalVolume : 0);

async function captureTab(s: Session, streamId: string) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } } as unknown as MediaTrackConstraints,
    video: false,
  });
  const src = s.ctx.createMediaStreamSource(stream);
  // Capturing mutes the tab for me: play the original back (at the chosen volume).
  const original = s.ctx.createGain();
  original.gain.value = originalVolume(s);
  src.connect(original).connect(s.ctx.destination);
  const proc = s.ctx.createScriptProcessor(4096, 1, 1);
  const mute = s.ctx.createGain();
  mute.gain.value = 0;
  src.connect(proc).connect(mute).connect(s.ctx.destination);
  proc.onaudioprocess = (e) => {
    const ch = e.inputBuffer.numberOfChannels;
    let input = e.inputBuffer.getChannelData(0);
    if (ch > 1) {
      const mix = new Float32Array(input.length);
      for (let c = 0; c < ch; c++) {
        const d = e.inputBuffer.getChannelData(c);
        for (let i = 0; i < d.length; i++) mix[i]! += d[i]! / ch;
      }
      input = mix;
    }
    s.pipelines.in?.push(floatToInt16(resampleLinear(input, s.ctx.sampleRate, 16000)));
  };
  return { stream, nodes: [src, original, proc, mute], original };
}

function setPassthrough(on: boolean) {
  if (!session) return;
  session.passthrough = on;
  if (on) sendPage({ t: 'ttsFlush' }, (x) => x.mic);
  sendPage(modeMessage());
  status({ passthrough: on });
}

/** Stops the session and returns the finished meeting (null when nothing was said). */
async function stop(): Promise<SavedMeeting | null> {
  if (starting) await starting.catch(() => undefined);
  const s = session;
  if (!s) {
    return null;
  }
  session = null;
  sendPage({ t: 'ttsFlush' }, (x) => x.mic);
  sendPage(modeMessage());
  await Promise.all(Object.values(s.pipelines).map((p) => p!.stop().catch(() => undefined)));
  s.meta.endedAt = new Date().toISOString();
  const segments = s.transcript.list();
  await teardownSession(s);
  for (const p of [...ports]) p.port.disconnect();
  ports.clear();
  return segments.length ? { meta: s.meta, segments } : null;
}

async function teardownSession(s: Session) {
  for (const t of s.tab?.stream.getTracks() ?? []) t.stop();
  for (const n of s.tab?.nodes ?? []) n.disconnect();
  for (const src of s.inPlaying) {
    try {
      src.stop();
    } catch {
      // already stopped
    }
  }
  await s.ctx.close().catch(() => undefined);
}

async function teardown() {
  const s = session;
  session = null;
  if (s) {
    await Promise.all(Object.values(s.pipelines).map((p) => p!.stop().catch(() => undefined)));
    await teardownSession(s);
  }
}
