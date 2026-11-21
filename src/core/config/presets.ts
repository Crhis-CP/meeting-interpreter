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
  /** What a plan card says, so the choice is an informed one: how accurate, what the other side hears, what it takes. */
  card?: { accuracy: string; voice: string; takes: string };
  /** Not a plan (the demo): kept out of the plan lists, offered as a link instead. */
  hidden?: boolean;
  out: Omit<DirectionConfig, 'enabled' | 'voice'>;
  in: Omit<DirectionConfig, 'enabled' | 'voice'>;
  llmPreset: string;
}

export const PRESETS: ProviderPreset[] = [
  {
    id: 'free',
    name: '免费方案',
    description: '本机离线识别 + 本机 AI 翻译 + 本机自然人声。不用任何 Key，不联网也能用（第一次自动下载模型）。',
    cost: '0 元 · 不用 Key',
    quality: 2,
    needs: [],
    // (The download size is checked against the models in tests/core/presets.test.ts.)
    card: { accuracy: '翻译和云端大模型相当；西语识别错词约 3%', voice: '自然人声，男声女声可选', takes: '第一次下载约 2.6 GB，识别和翻译下完就能开会；之后不联网也能用' },
    out: { asr: 'local', mt: 'local-ai', tts: 'local' },
    in: { asr: 'local', mt: 'local-ai', tts: 'local' },
    llmPreset: 'zhipu-free',
  },
  {
    id: 'dashscope',
    name: '阿里云百炼（推荐，效果最好）',
    description: '一个 key 搞定识别、翻译、自然人声和纪要，国内直连，延迟低。新用户有免费额度。',
    cost: '约 2–4 元/小时（双向），新用户有免费额度',
    quality: 3,
    needs: ['dashscope'],
    card: { accuracy: '最好：云端识别和翻译', voice: '自然人声', takes: '一个阿里云 Key（1 分钟拿到）；约 2–4 元/小时，新用户有免费额度' },
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
    card: { accuracy: '很好：云端识别和翻译', voice: '自然人声（有阿根廷口音）', takes: '两个 Azure Key；双向同传要按量付费的标准层 S0' },
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
    hidden: true,
    out: { asr: 'demo', mt: 'demo', tts: 'demo' },
    in: { asr: 'demo', mt: 'demo', tts: 'demo' },
    llmPreset: 'qwen',
  },
];

/** The real plans, for the plan lists (the demo is offered separately). */
export const PLANS = (): ProviderPreset[] => PRESETS.filter((p) => !p.hidden);

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
