import type { AppSettings, SecretName } from '../core/config/schema';
import type { Glossary } from '../core/glossary/types';
import type { PipelineState } from '../core/pipeline/pipeline';
import type { VoiceInfo } from '../core/providers/types';
import type { MeetingSummary, SummaryTemplate } from '../core/session/summary';
import type { Direction, MeetingMeta, TranscriptSegment } from '../core/types';

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] };

export interface DirectionState {
  enabled: boolean;
  state: PipelineState;
  message?: string;
  partial: string;
  /** Seconds of translated speech queued for playback. */
  backlog: number;
}

export interface RoomParticipant {
  id: string;
  name: string;
  lang: string;
  talking: boolean;
  connected: boolean;
}

export interface RoomState {
  active: boolean;
  urls: string[];
  publicUrl: string | null;
  publicStatus: 'off' | 'starting' | 'on' | 'error';
  publicError?: string;
  qr: Record<string, string>;
  participants: RoomParticipant[];
}

export interface MeetingState {
  active: boolean;
  mode: 'meeting' | 'room' | null;
  meta: MeetingMeta | null;
  /** Wall clock ms when the meeting started. */
  startedAtMs: number | null;
  out: DirectionState & { gate: boolean; passthrough: boolean };
  in: DirectionState & { speak: boolean };
  recording: { audio: boolean; screen: boolean; screenError?: string };
  meetingSource: 'device' | 'loopback' | 'none';
  /** Whether system loopback excludes our own playback (null = unknown / not loopback). */
  loopbackExcludesSelf: boolean | null;
  warnings: string[];
}

export interface MeetingListItem {
  id: string;
  title: string;
  startedAt: string;
  endedAt?: string;
  mode: 'meeting' | 'room';
  segments: number;
  hasSummary: boolean;
  hasAudio: boolean;
  hasScreen: boolean;
  folder: string;
}

export interface MeetingDetail {
  meta: MeetingMeta;
  segments: TranscriptSegment[];
  summary: MeetingSummary | null;
  folder: string;
  files: { name: string; rel: string; size: number }[];
}

export interface ProviderTestStep {
  name: string;
  ok: boolean;
  ms: number;
  detail: string;
}

export interface LocalModelStatus {
  id: string;
  name: string;
  ready: boolean;
  sizeMb: number;
}

export interface AppInfo {
  version: string;
  platform: string;
  arch: string;
  recordsDir: string;
  dataDir: string;
  osVersion: string;
}

export interface ScreenSource {
  id: string;
  name: string;
  thumbnail: string;
  kind: 'screen' | 'window';
}

/** What the preload exposes to the main and overlay windows as `window.api`. */
export interface RendererApi {
  settings: {
    get(): Promise<AppSettings>;
    set(patch: DeepPartial<AppSettings>): Promise<AppSettings>;
    applyPreset(id: string): Promise<AppSettings>;
  };
  secrets: {
    status(): Promise<Record<SecretName, boolean>>;
    set(name: SecretName, value: string): Promise<void>;
  };
  glossary: {
    list(): Promise<Glossary[]>;
    save(g: Glossary): Promise<Glossary[]>;
    remove(id: string): Promise<Glossary[]>;
    importCsv(targetId: string | null): Promise<{ imported: number; errors: { line: number; message: string }[]; glossaries: Glossary[] } | null>;
    exportCsv(id: string): Promise<boolean>;
  };
  meeting: {
    start(opts: { title?: string; platform?: string; mode?: 'meeting' | 'room' }): Promise<MeetingState>;
    stop(): Promise<MeetingMeta | null>;
    state(): Promise<MeetingState>;
    setOut(enabled: boolean): Promise<void>;
    setIn(enabled: boolean): Promise<void>;
    setInSpeak(speak: boolean): Promise<void>;
    setPassthrough(on: boolean): Promise<void>;
    pushToTalk(down: boolean): Promise<void>;
    skip(dir: Direction): Promise<void>;
    setRecording(opts: { audio?: boolean; screen?: boolean; screenSourceId?: string }): Promise<void>;
  };
  meetings: {
    list(): Promise<MeetingListItem[]>;
    get(id: string): Promise<MeetingDetail | null>;
    summarize(id: string, template: SummaryTemplate): Promise<MeetingSummary>;
    rename(id: string, title: string): Promise<void>;
    remove(id: string): Promise<void>;
    openFolder(id: string): Promise<void>;
    openFile(id: string, rel: string): Promise<void>;
    fileUrl(id: string, rel: string): Promise<string>;
  };
  providers: {
    test(scope: 'out' | 'in' | 'llm'): Promise<ProviderTestStep[]>;
    voices(provider: string, lang: string): Promise<VoiceInfo[]>;
  };
  /** “用我的声音”: clone the user's voice from a recorded WAV (百炼), or remove it. */
  voice: {
    create(wav: Uint8Array): Promise<string>;
    remove(): Promise<void>;
  };
  local: {
    status(): Promise<LocalModelStatus[]>;
    download(lang: 'zh' | 'es' | 'en'): Promise<void>;
  };
  audio: {
    testTone(target: 'virtualMic' | 'headphones'): Promise<void>;
  };
  room: {
    start(): Promise<RoomState>;
    stop(): Promise<void>;
    state(): Promise<RoomState>;
    setPublic(on: boolean): Promise<RoomState>;
  };
  app: {
    info(): Promise<AppInfo>;
    openExternal(url: string): Promise<void>;
    detectMeetingApps(): Promise<string[]>;
    screenSources(): Promise<ScreenSource[]>;
    chooseRecordsDir(): Promise<string | null>;
    showWindow(name: 'main' | 'overlay'): Promise<void>;
    setOverlayClickThrough(on: boolean): Promise<void>;
  };
  on<K extends keyof RendererEvents>(event: K, fn: (payload: RendererEvents[K]) => void): () => void;
}

export interface RendererEvents {
  'meeting-state': MeetingState;
  segment: TranscriptSegment;
  partial: { dir: Direction | 'room'; text: string; speaker?: string };
  levels: { mic: number; meeting: number };
  'summary-progress': { id: string; done: number; total: number };
  'model-progress': { id: string; file: string; received: number; total: number };
  room: RoomState;
  toast: { level: 'info' | 'warn' | 'error'; message: string };
  settings: AppSettings;
  navigate: { page: string };
}

// ------------------------------------------------------------ audio window protocol

export interface AudioConfig {
  mode: 'meeting' | 'room';
  mic: string;
  /** Output device for Spanish speech into the meeting ('' = none). */
  virtualMic: string;
  meetingSource: 'device' | 'loopback' | 'none';
  meetingDevice: string;
  headphones: string;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  originalMixOut: number;
  duckLevel: number;
  playOriginalIn: boolean;
  originalInVolume: number;
  record: { audio: boolean; screen: boolean; screenSourceId: string };
}

/** main → audio window */
export type ToAudio =
  | { type: 'start'; config: AudioConfig }
  | { type: 'config'; config: AudioConfig }
  | { type: 'stop' }
  | { type: 'tts'; dir: Direction; segmentId: string; sampleRate: number; pcm: ArrayBuffer }
  | { type: 'ttsEnd'; dir: Direction; segmentId: string }
  | { type: 'flush'; dir: Direction }
  | { type: 'passthrough'; on: boolean }
  | { type: 'micGate'; open: boolean }
  | { type: 'startRecording'; audio: boolean; screen: boolean; screenSourceId: string }
  | { type: 'stopRecording' }
  | { type: 'testTone'; target: 'virtualMic' | 'headphones'; config: AudioConfig };

/** audio window → main */
export type FromAudio =
  | { type: 'pcm'; dir: Direction; pcm: ArrayBuffer }
  | { type: 'levels'; mic: number; meeting: number }
  | { type: 'backlog'; out: number; in: number }
  | { type: 'started'; loopbackExcludesSelf: boolean | null; warnings: string[] }
  | { type: 'recChunk'; kind: 'mix' | 'screen'; mime: string; data: ArrayBuffer }
  | { type: 'recStopped'; kind: 'mix' | 'screen' }
  | { type: 'recError'; kind: 'mix' | 'screen'; message: string }
  | { type: 'error'; message: string }
  | { type: 'log'; message: string };

export const IPC = {
  invoke: 'mi:invoke',
  event: 'mi:event',
  toAudio: 'mi:to-audio',
  fromAudio: 'mi:from-audio',
} as const;
