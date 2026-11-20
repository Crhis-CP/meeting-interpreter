import { parseSettings, type AppSettings, type Secrets } from '@core/config/schema';
import type { GlossaryEntry } from '@core/glossary/types';
import type { MeetingMeta, TranscriptSegment } from '@core/types';

/** Web meeting sites where the extension takes over the microphone and shows subtitles. */
export const MEETING_SITES = [
  'https://teams.microsoft.com/*',
  'https://teams.live.com/*',
  'https://teams.cloud.microsoft/*',
  'https://meet.google.com/*',
  'https://*.feishu.cn/*',
  'https://*.larksuite.com/*',
  'https://meeting.tencent.com/*',
  'https://*.voovmeeting.com/*',
  'https://app.zoom.us/*',
  'https://*.zoom.us/*',
  'https://*.zoom.com.cn/*',
  'https://*.webex.com/*',
];

export type ProviderSet = 'dashscope' | 'azure' | 'custom' | 'demo';

/** What the user configures in the extension (kept in chrome.storage.local). */
export interface ExtSettings {
  /** The other side's language, e.g. es-MX or en-US. */
  remote: string;
  providers: ProviderSet;
  out: { asr: string; mt: string; tts: string; voice: string };
  in: { asr: string; mt: string; tts: string; voice: string };
  llm: { preset: string; baseUrl: string; model: string };
  dashscopeRegion: 'cn' | 'intl';
  azureRegion: string;
  azureTranslatorRegion: string;
  /** Hear the other side's original voice (the tab is muted while it is captured). */
  playOriginal: boolean;
  originalVolume: number;
  /** Also speak the Chinese translation of the other side to me. */
  speakIn: boolean;
  /** Show my own sentences (and their translation) in the subtitles too. */
  showMine: boolean;
  subtitleSize: number;
  pinyinFuzzy: boolean;
}

export const DEFAULT_SETTINGS: ExtSettings = {
  remote: 'es-MX',
  providers: 'dashscope',
  out: { asr: 'dashscope', mt: 'qwen-mt', tts: 'dashscope', voice: '' },
  in: { asr: 'dashscope', mt: 'qwen-mt', tts: 'dashscope', voice: '' },
  llm: { preset: 'zhipu-free', baseUrl: '', model: '' },
  dashscopeRegion: 'cn',
  azureRegion: 'eastasia',
  azureTranslatorRegion: '',
  playOriginal: true,
  originalVolume: 1,
  speakIn: false,
  showMine: true,
  subtitleSize: 22,
  pinyinFuzzy: true,
};

/** Provider choices per preset; `custom` keeps the user's own per-direction choices. */
export const PROVIDER_SETS: Record<Exclude<ProviderSet, 'custom'>, { asr: string; mt: string; tts: string }> = {
  dashscope: { asr: 'dashscope', mt: 'qwen-mt', tts: 'dashscope' },
  azure: { asr: 'azure', mt: 'azure-translator', tts: 'azure' },
  demo: { asr: 'demo', mt: 'demo', tts: 'demo' },
};

export function withDefaults(s: Partial<ExtSettings> | undefined): ExtSettings {
  const v = { ...DEFAULT_SETTINGS, ...(s ?? {}) };
  v.out = { ...DEFAULT_SETTINGS.out, ...(s?.out ?? {}) };
  v.in = { ...DEFAULT_SETTINGS.in, ...(s?.in ?? {}) };
  v.llm = { ...DEFAULT_SETTINGS.llm, ...(s?.llm ?? {}) };
  if (v.providers !== 'custom') {
    const p = PROVIDER_SETS[v.providers] ?? PROVIDER_SETS.dashscope;
    v.out = { ...v.out, ...p };
    v.in = { ...v.in, ...p };
  }
  return v;
}

/** The core engine's settings for these extension settings. */
export function toAppSettings(s: ExtSettings): AppSettings {
  const tts = (t: string) => (t === 'none' || t === 'dashscope' || t === 'azure' || t === 'demo' ? t : 'none');
  return parseSettings({
    onboarded: true,
    preset: s.providers === 'demo' ? 'demo' : 'custom',
    languages: { self: 'zh-CN', remote: s.remote },
    out: { enabled: true, asr: s.out.asr, mt: s.out.mt, tts: tts(s.out.tts), voice: s.out.voice },
    in: { enabled: true, asr: s.in.asr, mt: s.in.mt, tts: tts(s.in.tts), voice: s.in.voice },
    llm: { preset: s.llm.preset, baseUrl: s.llm.baseUrl, model: s.llm.model, summaryModel: '' },
    dashscope: { region: s.dashscopeRegion },
    azure: { region: s.azureRegion, endpoint: '', translatorRegion: s.azureTranslatorRegion },
    interpretation: { pinyinFuzzy: s.pinyinFuzzy },
  });
}

export const SECRET_NAMES = ['dashscope', 'azure', 'azureTranslator', 'llm', 'deepl'] as const;

export interface StoredData {
  settings: ExtSettings;
  secrets: Secrets;
  glossary: GlossaryEntry[];
}

export async function loadAll(): Promise<StoredData> {
  const r = await chrome.storage.local.get(['settings', 'secrets', 'glossary']);
  return {
    settings: withDefaults(r.settings as Partial<ExtSettings> | undefined),
    secrets: (r.secrets as Secrets | undefined) ?? {},
    glossary: (r.glossary as GlossaryEntry[] | undefined) ?? [],
  };
}

/** A finished meeting kept in chrome.storage.local (the newest few). */
export interface SavedMeeting {
  meta: MeetingMeta;
  segments: TranscriptSegment[];
  summary?: unknown;
}

export const MAX_SAVED_MEETINGS = 30;

// ------------------------------------------------------------------ messages

/** Live state of the current session, kept in chrome.storage.session for the popup. */
export interface SessionState {
  status: 'idle' | 'starting' | 'running' | 'stopping';
  tabId: number | null;
  title: string;
  startedAt: number | null;
  out: { state: string; message?: string };
  in: { state: string; message?: string };
  /** Whether the meeting page has handed us its microphone. */
  micHooked: boolean;
  passthrough: boolean;
  error?: string;
  warnings: string[];
  /** The meeting saved when the last session ended. */
  lastMeetingId?: string;
}

export const IDLE_STATE: SessionState = {
  status: 'idle',
  tabId: null,
  title: '',
  startedAt: null,
  out: { state: 'idle' },
  in: { state: 'idle' },
  micHooked: false,
  passthrough: false,
  warnings: [],
};

/** popup / options → service worker */
export type ToBackground =
  | { type: 'start'; tabId: number }
  | { type: 'stop' }
  | { type: 'passthrough'; on: boolean }
  | { type: 'state' };

/** service worker → offscreen engine */
export type ToOffscreen =
  | { target: 'offscreen'; type: 'start'; tabId: number; title: string; streamId: string | null; data: StoredData }
  | { target: 'offscreen'; type: 'stop' }
  | { target: 'offscreen'; type: 'passthrough'; on: boolean };

/** offscreen engine → service worker */
export type FromOffscreen =
  | { target: 'background'; type: 'status'; patch: Partial<SessionState> }
  | { target: 'background'; type: 'wsHeaders'; url: string; headers: Record<string, string> }
  | { target: 'background'; type: 'ended'; meeting: SavedMeeting | null };

export * from './protocol';
