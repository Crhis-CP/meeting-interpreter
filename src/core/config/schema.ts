import { z } from 'zod';

export const AsrProviderId = z.enum(['demo', 'dashscope', 'azure', 'local']);
export const MtProviderId = z.enum(['demo', 'offline', 'local-ai', 'llm', 'qwen-mt', 'deepl', 'azure-translator']);
export const TtsProviderId = z.enum(['demo', 'dashscope', 'azure', 'system', 'none']);
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
      esModel: z.enum(['whisper-small', 'whisper-base']).default('whisper-small'),
    })
    .default({ esModel: 'whisper-small' }),
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
        })
        .default({ enabled: true, fontSize: 22, opacity: 0.85, contentProtection: true, clickThrough: false, showOriginal: true }),
    })
    .default({
      language: 'zh',
      overlay: { enabled: true, fontSize: 22, opacity: 0.85, contentProtection: true, clickThrough: false, showOriginal: true },
    }),
  shortcuts: z
    .object({
      toggleOut: z.string().default('CommandOrControl+Shift+M'),
      pushToTalk: z.string().default('CommandOrControl+Shift+Space'),
      toggleOverlay: z.string().default('CommandOrControl+Shift+S'),
    })
    .default({ toggleOut: 'CommandOrControl+Shift+M', pushToTalk: 'CommandOrControl+Shift+Space', toggleOverlay: 'CommandOrControl+Shift+S' }),
  room: z
    .object({
      port: z.number().int().min(1024).max(65535).default(47800),
      publicLink: z.boolean().default(false),
    })
    .default({ port: 47800, publicLink: false }),
  /** Let the Chrome extension use this app's offline recognition and voices (free tier). */
  bridge: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
  platform: z.string().default(''),
});

export type AppSettings = z.infer<typeof SettingsSchema>;

export function defaultSettings(): AppSettings {
  return SettingsSchema.parse({});
}

/** Parses stored settings, falling back to defaults field by field for anything invalid. */
export function parseSettings(raw: unknown): AppSettings {
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
