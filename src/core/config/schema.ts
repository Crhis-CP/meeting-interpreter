import { z } from 'zod';

export const AsrProviderId = z.enum(['demo', 'dashscope', 'azure', 'local']);
export const MtProviderId = z.enum(['demo', 'offline', 'local-ai', 'llm', 'qwen-mt', 'deepl', 'azure-translator']);
/** 'local': the natural voices on this computer (free; the system's own voice stands in until they are downloaded). */
export const TtsProviderId = z.enum(['demo', 'dashscope', 'azure', 'local', 'system', 'none']);
export type AsrProviderId = z.infer<typeof AsrProviderId>;
export type MtProviderId = z.infer<typeof MtProviderId>;
export type TtsProviderId = z.infer<typeof TtsProviderId>;

export const DirectionConfigSchema = z.object({
  enabled: z.boolean().default(true),
  asr: AsrProviderId.default('demo'),
  mt: MtProviderId.default('demo'),
  tts: TtsProviderId.default('demo'),
  /** Provider-specific voice id; '' = the provider's default for the language. */
  voice: z.string().default(''),
});
export type DirectionConfig = z.infer<typeof DirectionConfigSchema>;

/** Default global shortcuts (see `shortcuts` below). */
export const DEFAULT_SHORTCUTS = {
  toggleOut: 'CommandOrControl+Alt+Shift+M',
  pushToTalk: 'CommandOrControl+Alt+Shift+Space',
  toggleOverlay: 'CommandOrControl+Alt+Shift+O',
} as const;

/** Defaults of earlier versions that collided with other apps; replaced unless the user chose them. */
const OLD_DEFAULT_SHORTCUTS: Record<string, string> = {
  toggleOut: 'CommandOrControl+Shift+M',
  pushToTalk: 'CommandOrControl+Shift+Space',
  toggleOverlay: 'CommandOrControl+Shift+S',
};

/** Upgrades settings saved by older versions. */
export function migrateSettings(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const r = { ...(raw as Record<string, unknown>) };
  if (r.shortcuts && typeof r.shortcuts === 'object') {
    const sc = { ...(r.shortcuts as Record<string, unknown>) };
    for (const [k, old] of Object.entries(OLD_DEFAULT_SHORTCUTS)) if (sc[k] === old) sc[k] = DEFAULT_SHORTCUTS[k as keyof typeof DEFAULT_SHORTCUTS];
    r.shortcuts = sc;
  }
  // 0.9: Parakeet recognises Spanish and English more accurately and faster than either Whisper
  // model (the Whisper files already downloaded stand in until Parakeet is there).
  if (r.local && typeof r.local === 'object') {
    const local = r.local as Record<string, unknown>;
    if (local.esModel === 'whisper-small' || local.esModel === 'whisper-base') r.local = { ...local, esModel: 'parakeet-v3' };
  }
  // 0.9: the free voices are the natural ones (the system's own voice is their stand-in now). A
  // system voice id means nothing to them: the voice starts as the default (female).
  for (const d of ['out', 'in'] as const) {
    const c = r[d] as Record<string, unknown> | undefined;
    if (c && typeof c === 'object' && c.tts === 'system') r[d] = { ...c, tts: 'local', voice: c.voice === 'male' || c.voice === 'female' ? c.voice : '' };
  }
  return r;
}

export const SettingsSchema = z.object({
  version: z.literal(1).default(1),
  onboarded: z.boolean().default(false),
  preset: z.string().default('demo'),
  languages: z
    .object({
      self: z.string().default('zh-CN'),
      remote: z.string().default('es-MX'),
    })
    .default({ self: 'zh-CN', remote: 'es-MX' }),
  /** My speech → the meeting. */
  out: DirectionConfigSchema.default({ enabled: true, asr: 'demo', mt: 'demo', tts: 'demo', voice: '' }),
  /** The meeting → me. */
  in: DirectionConfigSchema.default({ enabled: true, asr: 'demo', mt: 'demo', tts: 'demo', voice: '' }),
  llm: z
    .object({
      preset: z.string().default('qwen'),
      baseUrl: z.string().default('https://dashscope.aliyuncs.com/compatible-mode/v1'),
      model: z.string().default('qwen-plus'),
      /** Model for summaries; '' = same as `model`. */
      summaryModel: z.string().default(''),
    })
    .default({ preset: 'qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', summaryModel: '' }),
  dashscope: z
    .object({
      region: z.enum(['cn', 'intl']).default('cn'),
      host: z.string().default(''),
      asrModel: z.string().default('qwen-audio-3.1-asr-flash-streaming'),
      ttsModel: z.string().default('qwen3-tts-flash-realtime'),
      mtModel: z.string().default('qwen-mt-flash'),
      /** “用我的声音”: the cloned voice id ('' = none) and whether my translation uses it. */
      myVoiceId: z.string().default(''),
      useMyVoice: z.boolean().default(false),
    })
    .default({ region: 'cn', host: '', asrModel: 'qwen-audio-3.1-asr-flash-streaming', ttsModel: 'qwen3-tts-flash-realtime', mtModel: 'qwen-mt-flash', myVoiceId: '', useMyVoice: false }),
  azure: z
    .object({
      region: z.string().default('eastasia'),
      endpoint: z.string().default(''),
      translatorRegion: z.string().default(''),
    })
    .default({ region: 'eastasia', endpoint: '', translatorRegion: '' }),
  deepl: z.object({ useGlossary: z.boolean().default(true) }).default({ useGlossary: true }),
  local: z
    .object({
      /** Spanish / English recogniser. Whisper only from earlier versions (migrated to Parakeet). */
      esModel: z.enum(['parakeet-v3', 'whisper-small', 'whisper-base']).default('parakeet-v3'),
      /** Local AI translation model: 1.8B (default) or 7B (more accurate; for Apple-silicon Macs). */
      aiModel: z.enum(['hy-mt2-1.8b', 'hy-mt2-7b']).default('hy-mt2-1.8b'),
    })
    .default({ esModel: 'parakeet-v3', aiModel: 'hy-mt2-1.8b' }),
  interpretation: z
    .object({
      outMode: z.enum(['continuous', 'push-to-talk']).default('continuous'),
      lowLatency: z.boolean().default(true),
      pinyinFuzzy: z.boolean().default(true),
      /** After each meeting (only with the user's own LLM key): find words the recogniser likely mis-heard. */
      autoReview: z.boolean().default(true),
      /** Volume (0..1) of my original voice mixed under the Spanish translation. */
      originalMixOut: z.number().min(0).max(1).default(0),
      /** Volume (0..1) of the meeting's original audio while a Chinese translation plays. */
      duckLevel: z.number().min(0).max(1).default(0.25),
      /** Hear the meeting's original audio at all (when captured from a virtual speaker). */
      playOriginalIn: z.boolean().default(true),
      /** Volume of the original meeting audio when nothing is being translated. */
      originalInVolume: z.number().min(0).max(1).default(1),
    })
    .default({ outMode: 'continuous', lowLatency: true, pinyinFuzzy: true, autoReview: true, originalMixOut: 0, duckLevel: 0.25, playOriginalIn: true, originalInVolume: 1 }),
  devices: z
    .object({
      mic: z.string().default(''),
      virtualMic: z.string().default(''),
      meetingSource: z.enum(['device', 'loopback', 'none']).default('device'),
      meetingDevice: z.string().default(''),
      headphones: z.string().default(''),
      echoCancellation: z.boolean().default(true),
      noiseSuppression: z.boolean().default(true),
      autoGainControl: z.boolean().default(true),
    })
    .default({ mic: '', virtualMic: '', meetingSource: 'device', meetingDevice: '', headphones: '', echoCancellation: true, noiseSuppression: true, autoGainControl: true }),
  recording: z
    .object({
      audio: z.boolean().default(true),
      screen: z.boolean().default(false),
      screenSourceId: z.string().default(''),
      dir: z.string().default(''),
    })
    .default({ audio: true, screen: false, screenSourceId: '', dir: '' }),
  summary: z
    .object({
      template: z.enum(['general', 'business', 'project']).default('general'),
      autoAtEnd: z.boolean().default(true),
    })
    .default({ template: 'general', autoAtEnd: true }),
  ui: z
    .object({
      language: z.enum(['zh', 'en']).default('zh'),
      overlay: z
        .object({
          enabled: z.boolean().default(true),
          fontSize: z.number().min(12).max(48).default(22),
          opacity: z.number().min(0.3).max(1).default(0.85),
          contentProtection: z.boolean().default(true),
          clickThrough: z.boolean().default(false),
          showOriginal: z.boolean().default(true),
          /** Where the user last put the subtitle window (null: the default place). */
          bounds: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).nullable().default(null),
        })
        .default({ enabled: true, fontSize: 22, opacity: 0.85, contentProtection: true, clickThrough: false, showOriginal: true, bounds: null }),
      /** Notices the user answered "this is on purpose / don't show again" (keys include the device). */
      dismissed: z.array(z.string().max(300)).max(100).default([]),
    })
    .default({
      language: 'zh',
      overlay: { enabled: true, fontSize: 22, opacity: 0.85, contentProtection: true, clickThrough: false, showOriginal: true, bounds: null },
      dismissed: [],
    }),
  // Held only during meetings, and three modifiers so they never collide with everyday shortcuts
  // (Cmd/Ctrl+Shift+S is "Save As" everywhere, Cmd/Ctrl+Shift+M is Teams' own mute).
  shortcuts: z
    .object({
      toggleOut: z.string().default(DEFAULT_SHORTCUTS.toggleOut),
      pushToTalk: z.string().default(DEFAULT_SHORTCUTS.pushToTalk),
      toggleOverlay: z.string().default(DEFAULT_SHORTCUTS.toggleOverlay),
    })
    .default(DEFAULT_SHORTCUTS),
  room: z
    .object({
      port: z.number().int().min(1024).max(65535).default(47800),
      publicLink: z.boolean().default(false),
    })
    .default({ port: 47800, publicLink: false }),
  /** Let the Chrome extension use this app's offline recognition and voices (free tier). */
  bridge: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
});

export type AppSettings = z.infer<typeof SettingsSchema>;

export function defaultSettings(): AppSettings {
  return SettingsSchema.parse({});
}

/** Parses stored settings, falling back to defaults field by field for anything invalid. */
export function parseSettings(input: unknown): AppSettings {
  const raw = migrateSettings(input);
  const res = SettingsSchema.safeParse(raw);
  if (res.success) return res.data;
  // Keep what is valid: merge top-level sections one by one.
  const base = defaultSettings() as Record<string, unknown>;
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!(k in base)) continue;
      const candidate = { ...base, [k]: v };
      if (SettingsSchema.safeParse(candidate).success) base[k] = v;
    }
  }
  return SettingsSchema.parse(base);
}

/** Names of credentials kept in the secret store (never in settings). */
export const SECRET_NAMES = ['dashscope', 'azure', 'azureTranslator', 'llm', 'deepl'] as const;
export type SecretName = (typeof SECRET_NAMES)[number];
export type Secrets = Partial<Record<SecretName, string>>;
