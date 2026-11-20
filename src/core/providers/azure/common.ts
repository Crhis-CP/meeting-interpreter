import { lang } from '../../lang/languages';
import { redact } from '../../log';
import type { LangCode } from '../../types';
import { ProviderError, type VoiceInfo } from '../types';

/** Azure AI Speech resource settings. `endpoint` (optional) is used for Azure China / custom domains. */
export interface AzureConfig {
  key: string;
  /** Region id, e.g. `eastasia`, `westeurope`, `chinaeast2`. */
  region: string;
  /** e.g. `https://<resource>.cognitiveservices.azure.cn`; blank = derive everything from `region`. */
  endpoint?: string;
}

/** Provider labels used as the prefix of user-facing (Chinese) error messages. */
export const AZURE_ASR_NAME = 'Azure 语音识别';
export const AZURE_TTS_NAME = 'Azure 语音合成';

/** `East Asia ` → `eastasia`. Returns '' when the region is blank. */
export function normalizeRegion(region: string | undefined): string {
  return (region ?? '').trim().toLowerCase().replace(/\s+/g, '');
}

/** The endpoint as a URL (a missing `https://` is added), or null when blank / not a URL. */
export function parseEndpoint(endpoint: string | undefined): URL | null {
  const raw = (endpoint ?? '').trim();
  if (!raw) return null;
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
}

/** Azure China (operated by 21Vianet): `china*` regions or an endpoint under `.azure.cn`. */
export function isChinaCloud(cfg: Pick<AzureConfig, 'region' | 'endpoint'>): boolean {
  if (normalizeRegion(cfg.region).startsWith('china')) return true;
  const host = parseEndpoint(cfg.endpoint)?.hostname.toLowerCase() ?? '';
  return host === 'azure.cn' || host.endsWith('.azure.cn');
}

/** REST text-to-speech URL for the resource's region (global or Azure China). */
export function ttsUrl(cfg: AzureConfig): string {
  const region = normalizeRegion(cfg.region);
  if (!region) {
    throw new ProviderError(`${AZURE_TTS_NAME}：请先填写区域（region），例如 eastasia 或 chinaeast2`, AZURE_TTS_NAME);
  }
  if (!/^[a-z0-9-]+$/.test(region)) {
    throw new ProviderError(`${AZURE_TTS_NAME}：区域格式不正确（${region}），应类似 eastasia 或 chinaeast2`, AZURE_TTS_NAME);
  }
  const domain = isChinaCloud(cfg) ? 'azure.cn' : 'microsoft.com';
  return `https://${region}.tts.speech.${domain}/cognitiveservices/v1`;
}

// ---------------------------------------------------------------- voices

function voice(id: string, name: string, gender: 'female' | 'male'): VoiceInfo {
  return { id, name, lang: id.split('-').slice(0, 2).join('-'), gender };
}

/** Neural voices offered per language (the first one is the default). */
export const AZURE_VOICES: Record<LangCode, VoiceInfo[]> = {
  'zh-CN': [
    voice('zh-CN-XiaoxiaoNeural', '晓晓（女声）', 'female'),
    voice('zh-CN-YunxiNeural', '云希（男声）', 'male'),
    voice('zh-CN-YunyangNeural', '云扬（男声，播音）', 'male'),
  ],
  'es-ES': [voice('es-ES-ElviraNeural', 'Elvira（女声，西班牙）', 'female'), voice('es-ES-AlvaroNeural', 'Álvaro（男声，西班牙）', 'male')],
  'es-MX': [voice('es-MX-DaliaNeural', 'Dalia（女声，墨西哥）', 'female'), voice('es-MX-JorgeNeural', 'Jorge（男声，墨西哥）', 'male')],
  'es-US': [voice('es-US-PalomaNeural', 'Paloma（女声，美国）', 'female'), voice('es-US-AlonsoNeural', 'Alonso（男声，美国）', 'male')],
  'es-AR': [voice('es-AR-ElenaNeural', 'Elena（女声，阿根廷）', 'female'), voice('es-AR-TomasNeural', 'Tomás（男声，阿根廷）', 'male')],
  'es-CO': [voice('es-CO-SalomeNeural', 'Salomé（女声，哥伦比亚）', 'female'), voice('es-CO-GonzaloNeural', 'Gonzalo（男声，哥伦比亚）', 'male')],
  'es-CL': [voice('es-CL-CatalinaNeural', 'Catalina（女声，智利）', 'female'), voice('es-CL-LorenzoNeural', 'Lorenzo（男声，智利）', 'male')],
  'es-PE': [voice('es-PE-CamilaNeural', 'Camila（女声，秘鲁）', 'female'), voice('es-PE-AlexNeural', 'Alex（男声，秘鲁）', 'male')],
  'en-US': [voice('en-US-AvaNeural', 'Ava（女声，美国）', 'female'), voice('en-US-AndrewNeural', 'Andrew（男声，美国）', 'male'), voice('en-US-JennyNeural', 'Jenny（女声，美国）', 'female')],
  'en-GB': [voice('en-GB-SoniaNeural', 'Sonia（女声，英国）', 'female'), voice('en-GB-RyanNeural', 'Ryan（男声，英国）', 'male')],
};

/** Voices for `code`, falling back to the base language's list (`es-419` → `es-ES`); [] if unsupported. */
export function azureVoicesFor(code: LangCode): VoiceInfo[] {
  const exact = AZURE_VOICES[code];
  if (exact) return exact;
  let base: string;
  try {
    base = lang(code).base;
  } catch {
    return [];
  }
  return AZURE_VOICES[base === 'zh' ? 'zh-CN' : base === 'en' ? 'en-US' : 'es-ES'] ?? [];
}

/** The default voice id for a language. Throws for languages the app does not support. */
export function defaultAzureVoice(code: LangCode): string {
  const first = azureVoicesFor(code)[0];
  if (!first) throw new ProviderError(`${AZURE_TTS_NAME}：不支持的语言 ${code}`, AZURE_TTS_NAME);
  return first.id;
}

// ---------------------------------------------------------------- SDK enums and errors

/**
 * Mirrors of the Speech SDK enums this app relies on, so modules that only map events (and the
 * REST TTS) do not have to load the SDK. Their values are checked against the SDK in the tests.
 */
export const AZURE_RESULT_REASON = { NoMatch: 0, Canceled: 1, RecognizingSpeech: 2, RecognizedSpeech: 3 } as const;
export const AZURE_CANCELLATION_REASON = { Error: 0, EndOfStream: 1 } as const;
export const AZURE_CANCELLATION_ERROR_CODE = {
  NoError: 0,
  AuthenticationFailure: 1,
  BadRequestParameters: 2,
  TooManyRequests: 3,
  ConnectionFailure: 4,
  ServiceTimeout: 5,
  ServiceError: 6,
  RuntimeError: 7,
  Forbidden: 8,
} as const;

const E = AZURE_CANCELLATION_ERROR_CODE;

const ERROR_HINTS: Record<number, { hint: string; retryable: boolean; status?: number }> = {
  [E.NoError]: { hint: '识别连接被中断', retryable: true },
  [E.AuthenticationFailure]: { hint: 'Key 或区域不正确（鉴权失败，401），请检查 Azure 语音 Key 与区域 / Endpoint 是否匹配', retryable: false, status: 401 },
  [E.BadRequestParameters]: { hint: '请求参数有误（语言或音频格式不受支持，400）', retryable: false, status: 400 },
  [E.TooManyRequests]: { hint: '请求太频繁或同时识别的路数超出限制（429）；免费层 F0 只允许 1 路同时识别', retryable: true, status: 429 },
  [E.ConnectionFailure]: { hint: '无法连接 Azure 语音服务，请检查网络 / 代理，以及 Key、区域或 Endpoint 是否正确', retryable: true },
  [E.ServiceTimeout]: { hint: '服务响应超时，请检查网络后重试', retryable: true },
  [E.ServiceError]: { hint: '服务端出错，请稍后重试', retryable: true },
  [E.RuntimeError]: { hint: '语音 SDK 运行出错', retryable: true },
  [E.Forbidden]: { hint: '没有权限或免费额度已用完（403），请检查 Azure 订阅状态和配额', retryable: false, status: 403 },
};

/** Removes the key (sent in the WebSocket URL by the SDK) and anything else secret-looking. */
export function redactAzureDetails(details: string, key?: string): string {
  let out = details;
  const k = key?.trim();
  if (k && k.length >= 4) out = out.split(k).join('***');
  return redact(out).replace(/\s+/g, ' ').trim().slice(0, 300);
}

/**
 * A Chinese, user-facing error for a Speech SDK cancellation. Connection failures whose details
 * show an HTTP 401/403/429 (the WebSocket upgrade was refused) are reported as that cause.
 */
export function azureCancellationError(errorCode: number, errorDetails: string | undefined, key?: string, provider = AZURE_ASR_NAME): ProviderError {
  let code = errorCode;
  const details = errorDetails ?? '';
  if (code === E.ConnectionFailure || code === E.NoError) {
    if (/\b401\b/.test(details)) code = E.AuthenticationFailure;
    else if (/\b403\b/.test(details)) code = E.Forbidden;
    else if (/\b429\b/.test(details)) code = E.TooManyRequests;
  }
  const info = ERROR_HINTS[code] ?? { hint: `识别出错（错误码 ${errorCode}）`, retryable: true };
  const shown = redactAzureDetails(details, key);
  return new ProviderError(`${provider}：${info.hint}${shown ? `（${shown}）` : ''}`, provider, {
    status: info.status,
    retryable: info.retryable,
    cause: details || undefined,
  });
}
