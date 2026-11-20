import { llmPreset } from '../providers/openai-compatible';
import type { AppSettings, DirectionConfig, SecretName } from './schema';

export type PresetId = 'free' | 'dashscope' | 'azure' | 'demo';

export interface ProviderPreset {
  id: PresetId;
  name: string;
  /** One-line description for the onboarding cards. */
  description: string;
  cost: string;
  quality: 1 | 2 | 3;
  /** Credentials the user must enter. */
  needs: SecretName[];
  out: Omit<DirectionConfig, 'enabled' | 'voice'>;
  in: Omit<DirectionConfig, 'enabled' | 'voice'>;
  llmPreset: string;
}

export const PRESETS: ProviderPreset[] = [
  {
    id: 'free',
    name: '免费方案',
    description: '本机离线识别 + 本机 AI 翻译 + 系统自带语音。不用任何 Key，不联网也能用（第一次自动下载模型）。',
    cost: '0 元 · 不用 Key',
    quality: 2,
    needs: [],
    out: { asr: 'local', mt: 'local-ai', tts: 'system' },
    in: { asr: 'local', mt: 'local-ai', tts: 'system' },
    llmPreset: 'zhipu-free',
  },
  {
    id: 'dashscope',
    name: '阿里云百炼（推荐，效果最好）',
    description: '一个 key 搞定识别、翻译、自然人声和纪要，国内直连，延迟低。新用户有免费额度。',
    cost: '约 2–4 元/小时（双向），新用户有免费额度',
    quality: 3,
    needs: ['dashscope'],
    out: { asr: 'dashscope', mt: 'qwen-mt', tts: 'dashscope' },
    in: { asr: 'dashscope', mt: 'qwen-mt', tts: 'dashscope' },
    llmPreset: 'qwen',
  },
  {
    id: 'azure',
    name: 'Azure 语音（含免费层）',
    description: '微软 Azure 识别和神经网络语音，支持 Azure 中国区。翻译用 Azure 翻译（每月 200 万字符免费）。注意：免费层 F0 同一时间只能识别一路，双向同传请用标准层 S0（按量付费）。',
    cost: '免费层够轻度使用，超出按量付费',
    quality: 3,
    needs: ['azure', 'azureTranslator'],
    out: { asr: 'azure', mt: 'azure-translator', tts: 'azure' },
    in: { asr: 'azure', mt: 'azure-translator', tts: 'azure' },
    llmPreset: 'zhipu-free',
  },
  {
    id: 'demo',
    name: '演示模式',
    description: '不需要任何 key，用预设的对话演示界面和声音路由；不会真正识别和翻译。',
    cost: '只演示，不真正翻译',
    quality: 1,
    needs: [],
    out: { asr: 'demo', mt: 'demo', tts: 'demo' },
    in: { asr: 'demo', mt: 'demo', tts: 'demo' },
    llmPreset: 'qwen',
  },
];

export function preset(id: string): ProviderPreset | undefined {
  return PRESETS.find((p) => p.id === id);
}

/** Returns new settings with the preset's providers applied (keeps languages, devices, etc.). */
export function applyPreset(settings: AppSettings, id: PresetId): AppSettings {
  const p = preset(id);
  if (!p) throw new Error(`未知的预设：${id}`);
  const lp = llmPreset(p.llmPreset);
  return {
    ...settings,
    preset: id,
    out: { ...settings.out, ...p.out, voice: '' },
    in: { ...settings.in, ...p.in, voice: '' },
    llm: lp ? { ...settings.llm, preset: lp.id, baseUrl: lp.baseUrl, model: lp.model } : settings.llm,
  };
}
