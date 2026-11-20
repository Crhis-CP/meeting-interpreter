import type { AppSettings, Secrets } from '../config/schema';
import type { GlossaryEntry } from '../glossary/types';
import type { Direction } from '../types';
import { AzureAsr, AzureTts } from './azure';
import { AzureTranslator } from './azure-translator';
import { DashscopeAsr, DashscopeTts, QwenMtTranslator, type DashscopeConfig } from './dashscope';
import { DeeplTranslator } from './deepl';
import { OfflineTranslator, type OfflineMtEngine } from './offline-translator';
import { DashscopeCloneTts, FallbackTts } from './dashscope/voice-clone';
import { FallbackAsr } from './fallback-asr';
import { LlmTranslator } from './llm-translator';
import { MockAsr, MockLlm, MockTranslator, MockTts } from './mock';
import { llmPreset, OpenAiCompatibleLlm } from './openai-compatible';
import { ProviderError, type Llm, type ProviderContext, type StreamingAsr, type Translator, type Tts } from './types';

export interface ProviderExtras {
  /** OS voices (main process only). */
  systemTts?: () => Tts;
  /** Offline recogniser for a language (main process only). */
  localAsr?: (dir: Direction) => StreamingAsr;
  /** Offline translation engine (Mozilla models in a browser context). */
  offlineMt?: OfflineMtEngine;
}

export interface Providers {
  asr(dir: Direction): StreamingAsr;
  mt(dir: Direction): Translator;
  tts(dir: Direction): Tts | null;
  llm(): Llm | null;
  describe(): Record<string, string>;
}

const NAMES: Record<string, string> = {
  dashscope: '阿里云百炼',
  azure: 'Azure 语音',
  azureTranslator: 'Azure 翻译',
  llm: '大模型',
  deepl: 'DeepL',
};

/** DashScope recognisers that handle both Chinese and Spanish, newest first. */
export const DASHSCOPE_ASR_FALLBACKS = ['qwen-audio-3.1-asr-flash-streaming', 'qwen-audio-3.0-asr-flash-streaming', 'fun-asr-realtime'];

function need(secrets: Secrets, name: keyof Secrets): string {
  const v = secrets[name];
  if (!v) throw new ProviderError(`请先在“服务设置”里填写 ${NAMES[name] ?? name} 的 Key`, String(name));
  return v;
}

/** The LLM key: its own, or the DashScope key for the 通义千问 preset. */
export function llmKey(settings: AppSettings, secrets: Secrets): string {
  if (secrets.llm) return secrets.llm;
  const p = llmPreset(settings.llm.preset);
  if (p?.usesDashscopeKey && secrets.dashscope) return secrets.dashscope;
  return '';
}

export function makeLlm(settings: AppSettings, secrets: Secrets, ctx: ProviderContext, forSummary = false): Llm | null {
  if (settings.preset === 'demo' && !secrets.llm && !secrets.dashscope) return new MockLlm();
  const p = llmPreset(settings.llm.preset);
  const key = llmKey(settings, secrets);
  if (!key && !p?.noKey) return null;
  return new OpenAiCompatibleLlm(
    {
      baseUrl: settings.llm.baseUrl || p?.baseUrl || '',
      apiKey: key,
      model: (forSummary && settings.llm.summaryModel) || settings.llm.model || p?.model || '',
      extraBody: p?.extraBody,
      label: p?.name ?? '大模型',
      maxConcurrent: p?.maxConcurrent,
      // Fall back only from the preset's own model (a custom model name means the user chose it).
      fallbackModels: !settings.llm.model || settings.llm.model === p?.model ? p?.fallbackModels : undefined,
    },
    ctx,
  );
}

function dashscopeConfig(settings: AppSettings, secrets: Secrets): DashscopeConfig {
  return {
    apiKey: need(secrets, 'dashscope'),
    region: settings.dashscope.region,
    host: settings.dashscope.host || undefined,
    asrModel: settings.dashscope.asrModel || undefined,
    ttsModel: settings.dashscope.ttsModel || undefined,
    mtModel: settings.dashscope.mtModel || undefined,
  };
}

function azureConfig(settings: AppSettings, secrets: Secrets) {
  return { key: need(secrets, 'azure'), region: settings.azure.region, endpoint: settings.azure.endpoint || undefined };
}

/**
 * Builds the providers chosen in the settings. Constructing is cheap and validates that the
 * needed keys exist; nothing connects until a pipeline starts.
 */
export function createProviders(
  settings: AppSettings,
  secrets: Secrets,
  ctx: ProviderContext,
  glossary: () => GlossaryEntry[],
  extras: ProviderExtras = {},
): Providers {
  const cfg = (dir: Direction) => (dir === 'out' ? settings.out : settings.in);
  const remoteScript = (dir: Direction) => (dir === 'out' ? 'self' : 'remote');

  const asr = (dir: Direction): StreamingAsr => {
    switch (cfg(dir).asr) {
      case 'demo':
        return new MockAsr(remoteScript(dir));
      case 'dashscope': {
        const base = dashscopeConfig(settings, secrets);
        const primary = base.asrModel ?? 'qwen-audio-3.1-asr-flash-streaming';
        // If the chosen model isn't available to this account/host, fall back to older ones.
        const models = [primary, ...DASHSCOPE_ASR_FALLBACKS.filter((m) => m !== primary)];
        return new FallbackAsr(
          models.map((m) => new DashscopeAsr({ ...base, asrModel: m }, ctx)),
          (_from, to, err) => ctx.log.warn(`DashScope ASR falls back to ${models[to]}: ${err.message}`),
        );
      }
      case 'azure':
        return new AzureAsr(azureConfig(settings, secrets), ctx);
      case 'local':
        if (!extras.localAsr) throw new ProviderError('本机离线识别只在桌面版可用', 'local');
        return extras.localAsr(dir);
    }
  };

  const mt = (dir: Direction): Translator => {
    switch (cfg(dir).mt) {
      case 'demo':
        return new MockTranslator();
      case 'offline':
        if (!extras.offlineMt) throw new ProviderError('离线翻译需要先下载翻译模型（设置里点“下载离线翻译”）', 'offline');
        return new OfflineTranslator(extras.offlineMt);
      case 'llm': {
        const llm = makeLlm(settings, secrets, ctx);
        if (!llm) throw new ProviderError('请先在“服务设置”里填写大模型的 Key（例如免费的智谱 GLM）', 'llm');
        return new LlmTranslator(llm);
      }
      case 'qwen-mt':
        return new QwenMtTranslator(dashscopeConfig(settings, secrets), ctx);
      case 'deepl':
        return new DeeplTranslator({ apiKey: need(secrets, 'deepl'), useGlossary: settings.deepl.useGlossary }, ctx, glossary);
      case 'azure-translator':
        return new AzureTranslator(
          { key: secrets.azureTranslator || need(secrets, 'azure'), region: settings.azure.translatorRegion || settings.azure.region },
          ctx,
        );
    }
  };

  const tts = (dir: Direction): Tts | null => {
    switch (cfg(dir).tts) {
      case 'none':
        return null;
      case 'demo':
        return new MockTts();
      case 'dashscope': {
        const stock = new DashscopeTts(dashscopeConfig(settings, secrets), ctx);
        // My own speech (→ the other language) in my cloned voice, when chosen.
        const d = settings.dashscope;
        if (dir === 'out' && d.useMyVoice && d.myVoiceId) {
          return new FallbackTts(new DashscopeCloneTts(dashscopeConfig(settings, secrets), ctx, d.myVoiceId), stock, (err) =>
            ctx.log.warn('my voice failed, using the stock voice', err instanceof Error ? err.message : String(err)),
          );
        }
        return stock;
      }
      case 'azure':
        return new AzureTts(azureConfig(settings, secrets), ctx);
      case 'system':
        if (!extras.systemTts) throw new ProviderError('系统语音只在桌面版可用', 'system');
        return extras.systemTts();
    }
  };

  return {
    asr,
    mt,
    tts,
    llm: () => makeLlm(settings, secrets, ctx, true),
    describe: () => ({
      outAsr: settings.out.asr,
      outMt: settings.out.mt,
      outTts: settings.out.tts,
      inAsr: settings.in.asr,
      inMt: settings.in.mt,
      inTts: settings.in.tts,
      llm: `${settings.llm.preset}:${settings.llm.model}`,
    }),
  };
}
