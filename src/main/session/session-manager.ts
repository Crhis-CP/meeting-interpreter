import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendFileSync } from 'node:fs';
import type { AppSettings } from '../../core/config/schema';
import { Emitter } from '../../core/events';
import type { GlossaryEntry } from '../../core/glossary/types';
import { otherLanguage } from '../../core/lang/languages';
import type { Logger } from '../../core/log';
import { DirectionPipeline } from '../../core/pipeline/pipeline';
import type { Llm, StreamingAsr, Translator, Tts } from '../../core/providers/types';
import { summarize, summaryToMarkdown, type MeetingSummary, type SummaryTemplate } from '../../core/session/summary';
import { Transcript, toMarkdown, toSrt } from '../../core/session/transcript';
import type { Direction, MeetingMeta, TranscriptSegment } from '../../core/types';
import type { AudioConfig, DirectionState, FromAudio, MeetingState, RendererEvents, ToAudio } from '../../shared/ipc';
import { writeJson } from '../stores/json-file';
import { ChunkFileWriter, WavFileWriter } from './wav-writer';

export interface ProviderSet {
  asr(dir: Direction): StreamingAsr;
  mt(dir: Direction): Translator;
  tts(dir: Direction): Tts | null;
  llm(): Llm | null;
  /** Provider ids for the record. */
  describe(): Record<string, string>;
}

export interface SessionDeps {
  settings: () => AppSettings;
  glossary: () => GlossaryEntry[];
  providers: () => ProviderSet;
  recordsDir: () => string;
  toAudio: (msg: ToAudio) => void;
  broadcast: <K extends keyof RendererEvents>(event: K, payload: RendererEvents[K]) => void;
  log: Logger;
  now?: () => number;
}

/** Audio-window settings derived from the app settings. */
export function audioConfig(s: AppSettings, mode: 'meeting' | 'room'): AudioConfig {
  return {
    mode,
    mic: s.devices.mic,
    virtualMic: mode === 'meeting' ? s.devices.virtualMic : '',
    meetingSource: mode === 'meeting' ? s.devices.meetingSource : 'none',
    meetingDevice: s.devices.meetingDevice,
    headphones: s.devices.headphones,
    echoCancellation: s.devices.echoCancellation,
    noiseSuppression: s.devices.noiseSuppression,
    autoGainControl: s.devices.autoGainControl,
    originalMixOut: s.interpretation.originalMixOut,
    duckLevel: s.interpretation.duckLevel,
    playOriginalIn: s.interpretation.playOriginalIn,
    originalInVolume: s.interpretation.originalInVolume,
    record: { audio: s.recording.audio, screen: s.recording.screen, screenSourceId: s.recording.screenSourceId },
  };
}

function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|\n\r\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
}

function stamp(d: Date): string {
  const p = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

const idleDir = (): DirectionState => ({ enabled: true, state: 'idle', partial: '', backlog: 0 });

/**
 * One live meeting: owns both direction pipelines, the transcript file, the WAV tracks and the
 * MediaRecorder files, and talks to the audio window.
 */
export class SessionManager extends Emitter<{ segment: TranscriptSegment; ended: MeetingMeta; tts: { dir: Direction; segmentId: string; samples: Int16Array; sampleRate: number } ; ttsEnd: { dir: Direction; segmentId: string } }> {
  private readonly d: SessionDeps;
  private pipelines: Partial<Record<Direction, DirectionPipeline>> = {};
  private transcript: Transcript | null = null;
  private folder = '';
  private meta: MeetingMeta | null = null;
  private startedAtMs: number | null = null;
  private wav: Partial<Record<Direction, WavFileWriter>> = {};
  private rec: Partial<Record<'mix' | 'screen', ChunkFileWriter>> = {};
  private recMime: Partial<Record<'mix' | 'screen', string>> = {};
  private recStartedAt: Partial<Record<'mix' | 'screen', number>> = {};
  private s: MeetingState = SessionManager.emptyState();
  private stopping: Promise<MeetingMeta | null> | null = null;
  private stateTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: SessionDeps) {
    super();
    this.d = deps;
  }

  static emptyState(): MeetingState {
    return {
      active: false,
      mode: null,
      meta: null,
      startedAtMs: null,
      out: { ...idleDir(), gate: true, passthrough: false },
      in: { ...idleDir(), speak: true },
      recording: { audio: false, screen: false },
      meetingSource: 'device',
      loopbackExcludesSelf: null,
      warnings: [],
    };
  }

  private now(): number {
    return this.d.now ? this.d.now() : Date.now();
  }

  /** Seconds since the meeting started. */
  clock(): number {
    return this.startedAtMs === null ? 0 : (this.now() - this.startedAtMs) / 1000;
  }

  get state(): MeetingState {
    return this.s;
  }

  get active(): boolean {
    return this.s.active;
  }

  get currentMeta(): MeetingMeta | null {
    return this.meta;
  }

  get currentFolder(): string {
    return this.folder;
  }

  private publish(immediate = false): void {
    if (immediate) {
      if (this.stateTimer) clearTimeout(this.stateTimer);
      this.stateTimer = null;
      this.d.broadcast('meeting-state', this.s);
      return;
    }
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      this.d.broadcast('meeting-state', this.s);
    }, 100);
  }

  async start(opts: { title?: string; platform?: string; mode?: 'meeting' | 'room' } = {}): Promise<MeetingState> {
    if (this.s.active) return this.s;
    if (this.stopping) await this.stopping;
    const settings = this.d.settings();
    const mode = opts.mode ?? 'meeting';
    const startedAt = new Date(this.now());
    const title = sanitize(opts.title || '') || `${mode === 'room' ? '现场会议' : '会议'} ${stamp(startedAt).replace('_', ' ')}`;
    const dir = join(this.d.recordsDir(), `${stamp(startedAt)}_${sanitize(title)}`);
    let folder = dir;
    for (let i = 2; existsSync(folder); i++) folder = `${dir}-${i}`;
    mkdirSync(join(folder, 'audio'), { recursive: true });
    this.folder = folder;
    this.startedAtMs = startedAt.getTime();

    let providers: ProviderSet;
    try {
      providers = this.d.providers();
    } catch (err) {
      this.startedAtMs = null;
      throw err;
    }
    const selfLang = settings.languages.self;
    const remoteLang = settings.languages.remote;
    this.meta = {
      id: folder.split(/[\\/]/).pop()!,
      title,
      startedAt: startedAt.toISOString(),
      selfLang,
      remoteLang,
      platform: opts.platform || settings.platform || undefined,
      mode,
      files: { transcript: 'transcript.jsonl' },
      providers: providers.describe(),
    };
    writeJson(join(folder, 'meeting.json'), this.meta);
    const transcriptPath = join(folder, 'transcript.jsonl');
    writeFileSync(transcriptPath, '');
    this.transcript = new Transcript((line) => appendFileSync(transcriptPath, line));

    this.s = {
      ...SessionManager.emptyState(),
      active: true,
      mode,
      meta: this.meta,
      startedAtMs: this.startedAtMs,
      meetingSource: mode === 'meeting' ? settings.devices.meetingSource : 'none',
      recording: { audio: settings.recording.audio, screen: settings.recording.screen },
    };
    this.s.out.enabled = settings.out.enabled;
    this.s.in.enabled = settings.in.enabled && mode === 'meeting';
    const pushToTalk = settings.interpretation.outMode === 'push-to-talk';
    this.s.out.gate = this.s.out.enabled && !pushToTalk;

    this.wav.out = new WavFileWriter(join(folder, 'audio', 'mic.wav'), 16000);
    this.meta.files.mic = 'audio/mic.wav';
    if (mode === 'meeting' && settings.devices.meetingSource !== 'none') {
      this.wav.in = new WavFileWriter(join(folder, 'audio', 'meeting.wav'), 16000);
      this.meta.files.meeting = 'audio/meeting.wav';
    }

    const makePipeline = (dir: Direction) => {
      const cfg = dir === 'out' ? settings.out : settings.in;
      const src = dir === 'out' ? selfLang : remoteLang;
      const dst = dir === 'out' ? (mode === 'room' ? remoteLang : remoteLang) : selfLang;
      const p = new DirectionPipeline({
        dir,
        speaker: dir === 'out' ? 'me' : 'them',
        idPrefix: dir,
        srcLang: src,
        dstLang: dst || otherLanguage(src, remoteLang),
        asr: providers.asr(dir),
        translator: providers.mt(dir),
        tts: providers.tts(dir),
        voice: cfg.voice || undefined,
        glossary: this.d.glossary,
        pinyinFuzzy: settings.interpretation.pinyinFuzzy,
        lowLatency: settings.interpretation.lowLatency,
        clock: () => this.clock(),
        speak: dir === 'in' ? () => this.s.in.speak : () => !this.s.out.passthrough,
        log: this.d.log.child(dir),
      });
      p.on('segment', (seg) => this.onSegment(seg));
      p.on('partial', ({ text }) => {
        this.s[dir].partial = text;
        this.d.broadcast('partial', { dir, text });
      });
      p.on('status', ({ state, message }) => {
        this.s[dir].state = state;
        this.s[dir].message = message;
        this.publish();
      });
      p.on('audio', ({ segmentId, samples, sampleRate }) => {
        const pcm = samples.slice().buffer;
        this.d.toAudio({ type: 'tts', dir, segmentId, sampleRate, pcm });
        this.emit('tts', { dir, segmentId, samples, sampleRate });
      });
      p.on('audioEnd', ({ segmentId }) => {
        this.d.toAudio({ type: 'ttsEnd', dir, segmentId });
        this.emit('ttsEnd', { dir, segmentId });
      });
      p.on('audioFlush', () => this.d.toAudio({ type: 'flush', dir }));
      return p;
    };

    this.pipelines.out = makePipeline('out');
    this.pipelines.out.setGate(this.s.out.gate);
    if (mode === 'meeting' && settings.devices.meetingSource !== 'none') {
      this.pipelines.in = makePipeline('in');
      this.pipelines.in.setGate(this.s.in.enabled);
    }
    await Promise.all(Object.values(this.pipelines).map((p) => p!.start()));

    this.d.toAudio({ type: 'start', config: audioConfig(settings, mode) });
    this.publish(true);
    this.d.log.info(`meeting started: ${this.meta.id}`);
    return this.s;
  }

  private onSegment(seg: TranscriptSegment): void {
    this.transcript?.upsert(seg);
    this.d.broadcast('segment', seg);
    this.emit('segment', seg);
  }

  /** Lets the room server feed segments of room participants into the same record. */
  recordExternalSegment(seg: TranscriptSegment): void {
    if (this.s.active) this.onSegment(seg);
  }

  handleAudio(msg: FromAudio): void {
    switch (msg.type) {
      case 'pcm': {
        if (!this.s.active) return;
        const pcm = new Int16Array(msg.pcm);
        const w = this.wav[msg.dir];
        if (w) {
          w.padTo(Math.max(0, this.clock() - pcm.length / 16000));
          w.write(pcm);
        }
        this.pipelines[msg.dir]?.push(pcm);
        return;
      }
      case 'levels':
        this.d.broadcast('levels', { mic: msg.mic, meeting: msg.meeting });
        return;
      case 'backlog':
        this.pipelines.out?.setBacklog(msg.out);
        this.pipelines.in?.setBacklog(msg.in);
        if (Math.abs(this.s.out.backlog - msg.out) > 0.5 || Math.abs(this.s.in.backlog - msg.in) > 0.5) {
          this.s.out.backlog = msg.out;
          this.s.in.backlog = msg.in;
          this.publish();
        }
        return;
      case 'started':
        this.s.loopbackExcludesSelf = msg.loopbackExcludesSelf;
        this.s.warnings = msg.warnings;
        // System loopback that also captures our own Chinese speech would feed it back into the
        // Spanish recogniser: switch the voice off (subtitles stay) rather than loop.
        if (msg.loopbackExcludesSelf === false && this.s.meetingSource === 'loopback' && this.s.in.speak) {
          this.setInSpeak(false);
          this.s.warnings = [...this.s.warnings, '为避免把中文译音再次翻译，已自动关闭“播放中文译音”（只显示字幕）。要听中文语音，请改用“虚拟扬声器”模式。'];
        }
        this.publish(true);
        return;
      case 'recChunk': {
        if (!this.s.active && !this.stopping) return;
        let w = this.rec[msg.kind];
        if (!w) {
          const ext = msg.mime.includes('mp4') ? (msg.kind === 'mix' ? 'm4a' : 'mp4') : 'webm';
          const rel = msg.kind === 'mix' ? `audio/mix.${ext}` : `screen.${ext}`;
          w = new ChunkFileWriter(join(this.folder, rel));
          this.rec[msg.kind] = w;
          this.recMime[msg.kind] = msg.mime;
          this.recStartedAt[msg.kind] = this.clock();
          if (this.meta) this.meta.files[msg.kind === 'mix' ? 'mix' : 'screen'] = rel;
        }
        w.write(new Uint8Array(msg.data));
        return;
      }
      case 'recStopped':
        this.rec[msg.kind]?.close();
        return;
      case 'recError':
        if (msg.kind === 'screen') this.s.recording.screenError = msg.message;
        this.d.broadcast('toast', { level: 'warn', message: `${msg.kind === 'screen' ? '录屏' : '录音'}失败：${msg.message}` });
        this.publish();
        return;
      case 'error':
        this.d.broadcast('toast', { level: 'error', message: msg.message });
        return;
      case 'log':
        this.d.log.info(`[audio] ${msg.message}`);
        return;
    }
  }

  setOut(enabled: boolean): void {
    this.s.out.enabled = enabled;
    this.applyOutGate();
  }

  private pttDown = false;

  pushToTalk(down: boolean): void {
    this.pttDown = down;
    this.applyOutGate();
  }

  private applyOutGate(): void {
    const ptt = this.d.settings().interpretation.outMode === 'push-to-talk';
    const open = this.s.out.enabled && !this.s.out.passthrough && (!ptt || this.pttDown);
    this.s.out.gate = open;
    this.pipelines.out?.setGate(open);
    this.publish();
  }

  setIn(enabled: boolean): void {
    this.s.in.enabled = enabled;
    this.pipelines.in?.setGate(enabled);
    this.publish();
  }

  setInSpeak(speak: boolean): void {
    this.s.in.speak = speak;
    if (!speak) this.d.toAudio({ type: 'flush', dir: 'in' });
    this.publish();
  }

  setPassthrough(on: boolean): void {
    this.s.out.passthrough = on;
    this.d.toAudio({ type: 'passthrough', on });
    if (on) this.d.toAudio({ type: 'flush', dir: 'out' });
    this.applyOutGate();
  }

  skip(dir: Direction): void {
    this.pipelines[dir]?.skipToLatest();
  }

  /** Re-sends device/volume settings to the audio window during a meeting. */
  refreshAudio(): void {
    if (this.s.active && this.s.mode) this.d.toAudio({ type: 'config', config: audioConfig(this.d.settings(), this.s.mode) });
  }

  segments(): TranscriptSegment[] {
    return this.transcript?.list() ?? [];
  }

  async stop(): Promise<MeetingMeta | null> {
    if (!this.s.active) return this.stopping ? this.stopping : null;
    this.stopping = this.doStop();
    try {
      return await this.stopping;
    } finally {
      this.stopping = null;
    }
  }

  private async doStop(): Promise<MeetingMeta | null> {
    const meta = this.meta!;
    const folder = this.folder;
    this.s.active = false;
    this.publish(true);
    this.d.toAudio({ type: 'stop' });
    await Promise.all(Object.values(this.pipelines).map((p) => p!.stop()));
    this.pipelines = {};
    // Give the audio window a moment to deliver the last recorder chunks.
    await new Promise((r) => setTimeout(r, 600));
    for (const w of Object.values(this.wav)) w?.close();
    for (const w of Object.values(this.rec)) w?.close();
    this.wav = {};
    this.rec = {};

    meta.endedAt = new Date(this.now()).toISOString();
    const segs = this.transcript?.list() ?? [];
    try {
      writeFileSync(join(folder, 'transcript.md'), toMarkdown(segs, meta, 'zh'));
      writeFileSync(join(folder, 'transcript.zh.srt'), toSrt(segs, 'zh'));
      writeFileSync(join(folder, 'transcript.es.srt'), toSrt(segs, 'es'));
      writeFileSync(join(folder, 'transcript.bilingual.srt'), toSrt(segs, 'bilingual'));
      Object.assign(meta.files, {
        markdown: 'transcript.md',
        srtZh: 'transcript.zh.srt',
        srtEs: 'transcript.es.srt',
        srtBilingual: 'transcript.bilingual.srt',
      });
      // Subtitles aligned to the screen recording, which starts a little after the meeting.
      const screenOffset = this.recStartedAt.screen;
      if (meta.files.screen && screenOffset !== undefined) {
        const base = meta.files.screen.replace(/\.[^.]+$/, '');
        writeFileSync(join(folder, `${base}.bilingual.srt`), toSrt(segs, 'bilingual', screenOffset));
        meta.files.screenSrt = `${base}.bilingual.srt`;
      }
    } catch (err) {
      this.d.log.error('export failed', err);
    }
    writeJson(join(folder, 'meeting.json'), meta);
    this.recStartedAt = {};
    this.emit('ended', meta);
    this.s = SessionManager.emptyState();
    this.startedAtMs = null;
    this.publish(true);
    this.d.log.info(`meeting stopped: ${meta.id} (${segs.length} segments)`);

    const settings = this.d.settings();
    if (settings.summary.autoAtEnd && segs.filter((x) => x.srcText).length >= 3) {
      const llm = this.d.providers().llm();
      if (llm) {
        void this.writeSummary(folder, meta, segs, llm, settings.summary.template).catch((err) =>
          this.d.broadcast('toast', { level: 'warn', message: `纪要生成失败：${err instanceof Error ? err.message : String(err)}` }),
        );
      }
    }
    this.transcript = null;
    this.meta = null;
    return meta;
  }

  /** Generates and saves summary.json and the zh/es Markdown minutes for a meeting folder. */
  async writeSummary(folder: string, meta: MeetingMeta, segs: TranscriptSegment[], llm: Llm, template: SummaryTemplate): Promise<MeetingSummary> {
    const summary = await summarize(llm, segs, meta, this.d.glossary(), template, {
      onProgress: (done, total) => this.d.broadcast('summary-progress', { id: meta.id, done, total }),
    });
    writeJson(join(folder, 'summary.json'), summary);
    writeFileSync(join(folder, 'summary.zh.md'), summaryToMarkdown(summary, 'zh', meta));
    writeFileSync(join(folder, 'summary.es.md'), summaryToMarkdown(summary, 'es', meta));
    meta.files.summary = 'summary.json';
    meta.files.summaryZh = 'summary.zh.md';
    meta.files.summaryEs = 'summary.es.md';
    if (summary.title.zh && /^(会议|现场会议) \d/.test(meta.title)) meta.title = summary.title.zh;
    writeJson(join(folder, 'meeting.json'), meta);
    this.d.broadcast('summary-progress', { id: meta.id, done: 1, total: 1 });
    return summary;
  }
}
