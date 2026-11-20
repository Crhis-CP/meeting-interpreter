import { redact } from '../../log';
import { ProviderError } from '../types';

/** Alibaba Cloud Bailian (DashScope) settings. The key comes from the secret store, never from settings. */
export interface DashscopeConfig {
  apiKey: string;
  /** `cn` = 华北2（北京），`intl` = 新加坡（国际站）. Keys do not work across regions. */
  region: 'cn' | 'intl';
  /** Optional workspace host, e.g. `<WorkspaceId>.cn-beijing.maas.aliyuncs.com` (scheme and API paths are ignored). */
  host?: string;
  asrModel?: string;
  ttsModel?: string;
  mtModel?: string;
}

export const DASHSCOPE_DEFAULTS = {
  asrModel: 'qwen-audio-3.1-asr-flash-streaming',
  ttsModel: 'qwen3-tts-flash-realtime',
  mtModel: 'qwen-mt-flash',
} as const;

/** Legacy region hosts (still served; new features go to workspace hosts). */
export const DASHSCOPE_HOSTS = {
  cn: 'dashscope.aliyuncs.com',
  intl: 'dashscope-intl.aliyuncs.com',
} as const;

/**
 * The host to talk to: the configured workspace host (tolerating a pasted URL such as
 * `https://<id>.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`) or the region's default host.
 */
export function dashscopeHost(cfg: Pick<DashscopeConfig, 'region' | 'host'>): string {
  const custom = (cfg.host ?? '')
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '') // scheme
    .replace(/[?#].*$/, '') // query / fragment
    .replace(/\/(?:compatible-mode|api-ws|api)(?:\/.*)?$/i, '') // pasted DashScope API path
    .replace(/\/+$/, ''); // trailing slashes
  if (custom) return custom;
  return cfg.region === 'intl' ? DASHSCOPE_HOSTS.intl : DASHSCOPE_HOSTS.cn;
}

/** `Authorization: Bearer <key>` for HTTP and WebSocket handshakes. Throws when no key is set. */
export function authHeaders(cfg: Pick<DashscopeConfig, 'apiKey'>): Record<string, string> {
  const key = (cfg.apiKey ?? '').trim();
  if (!key) throw new ProviderError('阿里云百炼：还没有填写 API Key，请在“服务商”设置里填写。', 'dashscope');
  return { Authorization: `Bearer ${key}` };
}

/** The configured model id, or the default when empty. */
export function resolveModel(value: string | undefined, fallback: string): string {
  const v = value?.trim();
  return v ? v : fallback;
}

// ---------------------------------------------------------------- errors

export type DashscopeService = 'asr' | 'tts' | 'mt';

const SERVICE_LABEL: Record<DashscopeService, string> = {
  asr: '百炼语音识别',
  tts: '百炼语音合成',
  mt: '百炼翻译',
};

/** What went wrong, as reported by the server (`task-failed`, `error`, HTTP body) or the transport. */
export interface DashscopeFailure {
  /** DashScope / OpenAI-style error code, e.g. `InvalidApiKey`, `Throttling.RateQuota`, `invalid_value`. */
  code?: string;
  /** Server or transport message. */
  message?: string;
  /** HTTP status when known. */
  status?: number;
  /** WebSocket close code when the failure is a closed socket. */
  closeCode?: number;
  closeReason?: string;
  /** Model in use; named in the hint. */
  model?: string;
  cause?: unknown;
}

function statusFromText(text: string): number | undefined {
  const m = /\b(400|401|403|404|429|5\d\d)\b/.exec(text);
  return m ? Number(m[1]) : undefined;
}

function detailOf(f: DashscopeFailure): string {
  const parts: string[] = [];
  const add = (s: string | undefined) => {
    const t = s?.trim();
    if (t && !parts.includes(t)) parts.push(t);
  };
  add(f.code);
  add(f.message);
  if (f.closeCode !== undefined) add(`WebSocket ${f.closeCode}`);
  add(f.closeReason);
  return redact(parts.join(' ')).slice(0, 200);
}

/**
 * Maps a DashScope failure to a Chinese, user-facing ProviderError that names the likely fix
 * (wrong key, wrong region, model not enabled, rate limit…). WebSocket handshake failures arrive as
 * a close whose reason or transport error contains the HTTP status (401/403); close code 1007 means
 * the request was rate limited.
 */
export function dashscopeError(
  service: DashscopeService,
  failure: DashscopeFailure,
  cfg?: Pick<DashscopeConfig, 'region' | 'host'>,
): ProviderError {
  const label = SERVICE_LABEL[service];
  const provider = service === 'mt' ? 'qwen-mt' : 'dashscope';
  const raw = [failure.code, failure.message, failure.closeReason].filter((s): s is string => !!s && !!s.trim()).join(' ');
  // A refused handshake only shows its HTTP status in transport text ("Unexpected server response: 401").
  // Server error messages are not scanned: "limit 500" there is not an HTTP 500.
  const status = failure.status ?? (failure.closeCode !== undefined ? statusFromText(raw) : undefined);
  const detail = detailOf(failure);
  const model = failure.model ? `「${failure.model}」` : '';
  const host = cfg ? `（当前主机：${dashscopeHost(cfg)}）` : '';
  const workspaceHost = cfg?.region === 'intl' ? '{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com' : '{WorkspaceId}.cn-beijing.maas.aliyuncs.com';
  const alternative =
    service === 'asr' ? '改用模型 fun-asr-realtime' : service === 'mt' ? '改用模型 qwen-mt-plus，或改用通义千问大模型翻译' : '换一个模型';
  const fix = `可以在设置里${alternative}，或填写业务空间主机（${workspaceHost}）。`;
  const make = (text: string, opts: { status?: number; retryable?: boolean } = {}) =>
    new ProviderError(`${label}：${text}${detail ? `（详情：${detail}）` : ''}`, provider, {
      status: opts.status ?? status,
      retryable: opts.retryable ?? false,
      cause: failure.cause,
    });

  if (status === 401 || /InvalidApiKey|invalid[\s_-]*api[\s_-]*key|incorrect api key|unauthori[sz]ed/i.test(raw)) {
    return make(`API Key 无效或已过期（401）。请检查 Key 是否完整，以及地域是否选对——北京和新加坡（国际站）的 Key 不通用${host}。`, {
      status: 401,
    });
  }
  if (/Arrearage|overdue|good standing/i.test(raw)) {
    return make('阿里云账户欠费，服务已暂停，请到阿里云控制台充值后重试。');
  }
  if (/FreeTierOnly|free tier/i.test(raw)) {
    return make(`模型${model}的免费额度已用完（开启了“仅使用免费额度”）。请在百炼控制台关闭该选项，或${alternative}。`);
  }
  if (status === 429 || failure.closeCode === 1007 || /Throttl|rate[\s_-]*limit|too many requests|quota/i.test(raw)) {
    const extra = service === 'mt' ? '北京地域 qwen-mt 每分钟约 60 次请求，多人房间可改用通义千问大模型翻译。' : '';
    return make(`请求太频繁或额度用完（限流），请稍后再试。${extra}`, { status: 429, retryable: true });
  }
  if (/DataInspectionFailed|data inspection|inappropriate/i.test(raw)) {
    return make('内容未通过安全审核，这一句已跳过。');
  }
  if (/NO_VALID_AUDIO/i.test(raw)) {
    return make('没有收到有效的音频，请检查音频来源是否有声音。', { retryable: true });
  }
  if (/request timeout after/i.test(raw) || (failure.code === 'CLIENT_ERROR' && /timeout/i.test(raw))) {
    return make('长时间没有收到音频，服务器结束了本次识别（会自动重新连接）。', { retryable: true });
  }
  if (status === 403 || /AccessDenied|access denied|forbidden|not authori[sz]ed/i.test(raw)) {
    return make(`没有权限使用模型${model}（403）：可能是该模型还没在百炼控制台开通，或在当前地域/主机上不可用${host}。${fix}`, {
      status: 403,
    });
  }
  if (status === 404 || /ModelNotFound|model[\s_-]*not[\s_-]*(?:found|exist)|does not exist|unknown model|invalid model/i.test(raw)) {
    return make(`模型${model}不存在或当前主机不支持（404）${host}。请检查模型名；${fix}`, { status: 404 });
  }
  if (service === 'tts' && /voice/i.test(raw)) {
    return make('音色不可用，请在设置里换一个音色。');
  }
  if (status === 400 || /InvalidParameter|invalid[_\s]value|invalid[_\s]request|BadRequest/i.test(raw)) {
    return make(`请求参数有误（400）。如果刚改过模型，请确认模型${model}支持这项功能和所选语言。`, { status: 400 });
  }
  if ((status !== undefined && status >= 500) || failure.closeCode === 1011 || /InternalError|ServiceUnavailable|SystemError|internal server error|service unavailable|bad gateway/i.test(raw)) {
    return make('服务暂时不可用，请稍后重试。', { retryable: true });
  }
  if (/timed?\s*out|timeout|超时/i.test(raw)) {
    return make('连接超时，请检查网络或代理设置。', { retryable: true });
  }
  if (failure.closeCode !== undefined) {
    return make(`连接意外断开（${failure.closeCode}），请检查网络连接。`, { retryable: true });
  }
  return make(detail ? '请求失败。' : '未知错误。');
}

/** The message of anything thrown. */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
