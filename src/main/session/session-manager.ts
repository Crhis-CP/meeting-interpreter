import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendFileSync } from 'node:fs';
import type { AppSettings } from '../../core/config/schema';
import { Emitter } from '../../core/events';
import type { GlossaryEntry } from '../../core/glossary/types';
import { baseOf, otherLanguage, type LangBase } from '../../core/lang/languages';
import type { CorrectionRule } from '../../core/profile/profile';
import type { Logger } from '../../core/log';
import type { DirectionPipeline } from '../../core/pipeline/pipeline';
import { createDirection } from '../../core/pipeline/direction';
import type { Llm, StreamingAsr, Translator, Tts } from '../../core/providers/types';
import { summarize, summaryToMarkdown, type MeetingSummary, type SummaryTemplate } from '../../core/session/summary';
import { Transcript, toMarkdown, toSrt } from '../../core/session/transcript';
import type { Direction, MeetingMeta, TranscriptSegment } from '../../core/types';
import type { AudioConfig, DirectionState, FromAudio, MeetingState, RendererEvents, ToAudio } from '../../shared/ipc';
import { writeJson } from '../stores/json-file';
import { ChunkFileWriter, WavFileWriter } from './wav-writer';

/** The other side's language (`es` or `en`) of a meeting. */
function foreignOf(meta: MeetingMeta): 'es' | 'en' {
  return baseOf(meta.remoteLang) === 'en' ? 'en' : 'es';
}

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
  /** The user's voice profile for a source language (learned corrections, accent patterns, hot words). */
  personal?: (base: LangBase) => { rules: readonly CorrectionRule[]; pairs: readonly string[]; hotwords: readonly string[] };
  providers: () => ProviderSet;
  /** The fast offline translator for drafts (null when its models are not downloaded). */
  draftTranslator?: () => Promise<Translator | null>;
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
  private recStopped: Partial<Record<'mix' | 'screen', () => void>> = {};
  /** How many files each recorder kind has started in this meeting (a device change restarts it). */
  private recSeq: Partial<Record<'mix' | 'screen', number>> = {};
  private startGen = 0;
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
    const withIn = mode === 'meeting' && settings.devices.meetingSource !== 'none';

    // Build every provider first: a missing key must fail before any state, file or audio exists.
    const providers = this.d.providers();
    const chosen: Partial<Record<Direction, { asr: StreamingAsr; mt: Translator; tts: Tts | null }>> = {
      out: { asr: providers.asr('out'), mt: providers.mt('out'), tts: providers.tts('out') },
    };
    if (withIn) chosen.in = { asr: providers.asr('in'), mt: providers.mt('in'), tts: providers.tts('in') };
    // A cloud or LLM translator gets an offline draft in front of it, when the models are there.
    const needsDraft = settings.out.mt !== 'offline' || settings.in.mt !== 'offline';
    const draft = needsDraft && !settings.preset.startsWith('demo') ? ((await this.d.draftTranslator?.()) ?? undefined) : undefined;

    const gen = ++this.startGen;
    const startedAt = new Date(this.now());
    const title = sanitize(opts.title || '') || `${mode === 'room' ? '现场会议' : '会议'} ${stamp(startedAt).replace('_', ' ')}`;
    const dir = join(this.d.recordsDir(), `${stamp(startedAt)}_${sanitize(title)}`);
    let folder = dir;
    for (let i = 2; existsSync(folder); i++) folder = `${dir}-${i}`;
    try {
      mkdirSync(join(folder, 'audio'), { recursive: true });
      this.folder = folder;
      this.startedAtMs = startedAt.getTime();
      this.pttDown = false;
      this.recSeq = {};

      const selfLang = settings.languages.self;
      const remoteLang = settings.languages.remote;
      this.meta = {
        id: folder.split(/[\\/]/).pop()!,
        title,
        startedAt: startedAt.toISOString(),
        selfLang,
        remoteLang,
        platform: opts.platform || undefined,
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
      if (withIn) {
        this.wav.in = new WavFileWriter(join(folder, 'audio', 'meeting.wav'), 16000);
        this.meta.files.meeting = 'audio/meeting.wav';
      }

      const makePipeline = (dir: Direction) => {
        const cfg = dir === 'out' ? settings.out : settings.in;
        const src = dir === 'out' ? selfLang : remoteLang;
        const dst = dir === 'out' ? remoteLang : selfLang;
        const p = createDirection({
          dir,
          speaker: dir === 'out' ? 'me' : 'them',
          idPrefix: dir,
          srcLang: src,
          dstLang: dst || otherLanguage(src, remoteLang),
          asr: chosen[dir]!.asr,
          translator: chosen[dir]!.mt,
          draft,
          tts: chosen[dir]!.tts,
          voice: cfg.voice || undefined,
          glossary: this.d.glossary,
          personal: this.d.personal ? () => this.d.personal!(baseOf(src)) : undefined,
          interpretation: settings.interpretation,
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
      if (withIn) {
        this.pipelines.in = makePipeline('in');
        this.pipelines.in.setGate(this.s.in.enabled);
      }
    } catch (err) {
      this.abortStart();
      throw err;
    }
    await Promise.all(Object.values(this.pipelines).map((p) => p!.start()));
    // Stop may have been pressed while recognition was still connecting.
    if (gen !== this.startGen || !this.s.active || !this.meta) return this.s;

    this.d.toAudio({ type: 'start', config: audioConfig(settings, mode) });
    this.publish(true);
    this.d.log.info(`meeting started: ${this.meta.id}`);
    return this.s;
  }

  /** Undoes a start that failed half-way (e.g. the folder could not be written). */
  private abortStart(): void {
    for (const p of Object.values(this.pipelines)) void p?.stop(0);
    this.pipelines = {};
    for (const w of Object.values(this.wav)) w?.close();
    this.wav = {};
    this.transcript = null;
    this.meta = null;
    this.startedAtMs = null;
    this.s = SessionManager.emptyState();
    this.publish(true);
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
          // A recorder restarted mid-meeting (device change) continues in a new file.
          const n = (this.recSeq[msg.kind] ?? 0) + 1;
          this.recSeq[msg.kind] = n;
          const ext = msg.mime.includes('mp4') ? (msg.kind === 'mix' ? 'm4a' : 'mp4') : 'webm';
          const base = msg.kind === 'mix' ? 'audio/mix' : 'screen';
          const rel = `${base}${n > 1 ? `-${n}` : ''}.${ext}`;
          w = new ChunkFileWriter(join(this.folder, rel));
          this.rec[msg.kind] = w;
          this.recMime[msg.kind] = msg.mime;
          if (n === 1) {
            this.recStartedAt[msg.kind] = this.clock();
            if (this.meta) this.meta.files[msg.kind === 'mix' ? 'mix' : 'screen'] = rel;
          } else if (this.meta) this.meta.files[`${msg.kind}${n}`] = rel;
        }
        w.write(new Uint8Array(msg.data));
        return;
      }
      case 'recStopped':
        this.rec[msg.kind]?.close();
        delete this.rec[msg.kind];
        this.recStopped[msg.kind]?.();
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

  /** Starts the audio window again for the running meeting (after it crashed and was recreated). */
  restartAudio(): void {
    if (this.s.active && this.s.mode) this.d.toAudio({ type: 'start', config: audioConfig(this.d.settings(), this.s.mode) });
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
    // Wait (bounded) for the audio window to deliver the last recorder chunks.
    const kinds = Object.keys(this.rec) as ('mix' | 'screen')[];
    const recordersDone = Promise.all(kinds.map((k) => new Promise<void>((resolve) => (this.recStopped[k] = resolve))));
    this.d.toAudio({ type: 'stop' });
    await Promise.all(Object.values(this.pipelines).map((p) => p!.stop()));
    this.pipelines = {};
    await Promise.race([recordersDone, new Promise((r) => setTimeout(r, kinds.length ? 5000 : 300))]);
    this.recStopped = {};
    for (const w of Object.values(this.wav)) w?.close();
    for (const w of Object.values(this.rec)) w?.close();
    this.wav = {};
    this.rec = {};

    meta.endedAt = new Date(this.now()).toISOString();
    const segs = this.transcript?.list() ?? [];
    try {
      writeTranscriptFiles(folder, meta, segs);
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
    this.recSeq = {};
    this.pttDown = false;
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

  /** Generates and saves summary.json and the zh and es/en Markdown minutes for a meeting folder. */
  async writeSummary(folder: string, meta: MeetingMeta, segs: TranscriptSegment[], llm: Llm, template: SummaryTemplate): Promise<MeetingSummary> {
    const summary = await summarize(llm, segs, meta, this.d.glossary(), template, {
      onProgress: (done, total) => this.d.broadcast('summary-progress', { id: meta.id, done, total }),
    });
    writeJson(join(folder, 'summary.json'), summary);
    writeFileSync(join(folder, 'summary.zh.md'), summaryToMarkdown(summary, 'zh', meta));
    const f = foreignOf(meta);
    writeFileSync(join(folder, `summary.${f}.md`), summaryToMarkdown(summary, f, meta));
    meta.files.summary = 'summary.json';
    meta.files.summaryZh = 'summary.zh.md';
    meta.files.summaryForeign = `summary.${f}.md`;
    if (summary.title.zh && /^(会议|现场会议) \d/.test(meta.title)) meta.title = summary.title.zh;
    writeJson(join(folder, 'meeting.json'), meta);
    this.d.broadcast('summary-progress', { id: meta.id, done: 1, total: 1 });
    return summary;
  }
}

/** transcript.md and the .srt subtitles of a meeting (at the end, and again after a correction). */
export function writeTranscriptFiles(folder: string, meta: MeetingMeta, segs: TranscriptSegment[]): void {
  const f = foreignOf(meta);
  writeFileSync(join(folder, 'transcript.md'), toMarkdown(segs, meta, 'zh'));
  writeFileSync(join(folder, 'transcript.zh.srt'), toSrt(segs, 'zh'));
  writeFileSync(join(folder, `transcript.${f}.srt`), toSrt(segs, 'foreign'));
  writeFileSync(join(folder, 'transcript.bilingual.srt'), toSrt(segs, 'bilingual'));
  Object.assign(meta.files, {
    markdown: 'transcript.md',
    srtZh: 'transcript.zh.srt',
    srtForeign: `transcript.${f}.srt`,
    srtBilingual: 'transcript.bilingual.srt',
  });
}
