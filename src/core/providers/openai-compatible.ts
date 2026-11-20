import { httpJson } from './http';
import { ProviderError, type Llm, type LlmRequest, type ProviderContext } from './types';

export interface LlmPreset {
  id: string;
  /** Shown in the UI. */
  name: string;
  baseUrl: string;
  model: string;
  /** Extra request fields, e.g. to turn off "thinking" for low latency. */
  extraBody?: Record<string, unknown>;
  free?: boolean;
  /** Where to get a key. */
  keyUrl?: string;
  note?: string;
  /** Uses the DashScope key when no separate LLM key is set. */
  usesDashscopeKey?: boolean;
  noKey?: boolean;
  /** Requests allowed at once for one key (free tiers are strict). */
  maxConcurrent?: number;
  /** Other models of the same service to fall back to while the main one is rate limited. */
  fallbackModels?: string[];
}

export const LLM_PRESETS: LlmPreset[] = [
  {
    id: 'zhipu-free',
    name: '智谱 GLM-4.7-Flash（免费）',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4.7-flash',
    extraBody: { thinking: { type: 'disabled' } },
    free: true,
    maxConcurrent: 1,
    fallbackModels: ['glm-4-flash-250414'],
    keyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
    note: '免费模型，注册即可获得 key；免费档并发较低，两个方向同时翻译时偶尔需要排队。',
  },
  {
    id: 'qwen',
    name: '通义千问（阿里云百炼）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    extraBody: { enable_thinking: false },
    keyUrl: 'https://bailian.console.aliyun.com/?tab=model#/api-key',
    usesDashscopeKey: true,
    note: '未单独填写时使用阿里云百炼的 key。',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    keyUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'doubao',
    name: '豆包（火山方舟）',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: '',
    keyUrl: 'https://console.volcengine.com/ark',
    note: '模型处填写方舟控制台里的模型 ID 或推理接入点 ID。',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5-mini',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'google/gemini-2.5-flash',
    keyUrl: 'https://openrouter.ai/keys',
  },
  {
    id: 'ollama',
    name: 'Ollama（本机，免费离线）',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5:7b',
    free: true,
    noKey: true,
    note: '先安装 Ollama 并运行 `ollama pull qwen2.5:7b`。',
  },
  { id: 'custom', name: '自定义（OpenAI 兼容）', baseUrl: '', model: '' },
];

export function llmPreset(id: string): LlmPreset | undefined {
  return LLM_PRESETS.find((p) => p.id === id);
}

export interface OpenAiCompatibleConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  extraBody?: Record<string, unknown>;
  /** Label used in error messages. */
  label?: string;
  timeoutMs?: number;
  /** Requests allowed at once for this key (shared by every client using it). Default: unlimited. */
  maxConcurrent?: number;
  /** Models to try while the main one answers 429 (rate limited). */
  fallbackModels?: string[];
}

/** A queue per endpoint + key, so free tiers that allow one request at a time are not flooded. */
class Gate {
  private active = 0;
  private waiting: (() => void)[] = [];
  constructor(private readonly limit: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}
const gates = new Map<string, Gate>();
function gateFor(key: string, limit: number): Gate {
  let g = gates.get(key);
  if (!g) gates.set(key, (g = new Gate(limit)));
  return g;
}

/** Remembers, per endpoint + key, until when the main model is known to be rate limited. */
const limitedUntil = new Map<string, number>();
const RATE_LIMIT_BACKOFF_MS = [700, 1500, 3000];

interface ChatResponse {
  choices?: { message?: { content?: string | null; reasoning_content?: string | null } }[];
  error?: { message?: string };
}

function withoutExtra(body: Record<string, unknown>, extra: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!extra) return body;
  const out = { ...body };
  for (const k of Object.keys(extra)) delete out[k];
  return out;
}

/** Chat completions against any OpenAI-compatible endpoint (DeepSeek, 通义, 智谱, Ollama, OpenAI…). */
export class OpenAiCompatibleLlm implements Llm {
  readonly id = 'llm';
  constructor(
    private readonly cfg: OpenAiCompatibleConfig,
    private readonly ctx: ProviderContext,
  ) {}

  private get label(): string {
    return this.cfg.label ?? '大模型';
  }

  async complete(req: LlmRequest): Promise<string> {
    if (!this.cfg.baseUrl) throw new ProviderError(`${this.label}：未填写接口地址`, 'llm');
    if (!this.cfg.model) throw new ProviderError(`${this.label}：未填写模型名`, 'llm');
    const url = `${this.cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
      temperature: req.temperature ?? 0.2,
      stream: false,
      ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
      ...(req.json ? { response_format: { type: 'json_object' } } : {}),
      ...(this.cfg.extraBody ?? {}),
    };
    const headers: Record<string, string> = {};
    if (this.cfg.apiKey) headers.Authorization = `Bearer ${this.cfg.apiKey}`;
    const send = (b: Record<string, unknown>) =>
      httpJson<ChatResponse>(this.ctx, this.label, url, {
        method: 'POST',
        json: b,
        headers,
        timeoutMs: this.cfg.timeoutMs ?? (req.json ? 120000 : 20000),
        signal: req.signal,
        retries: 0, // retried below, where rate limits can switch models
      });
    const sendOnce = async (b: Record<string, unknown>): Promise<ChatResponse> => {
      try {
        return await send(b);
      } catch (err) {
        // Some OpenAI-compatible hosts reject response_format; the prompt asks for JSON anyway.
        if (!(err instanceof ProviderError) || err.status !== 400 || !req.json) throw err;
        const { response_format: _drop, ...rest } = b;
        return send(rest);
      }
    };
    const key = `${url}|${this.cfg.apiKey}`;
    const fallbacks = this.cfg.fallbackModels ?? [];
    // While rate limited, go straight to the other free model; otherwise wait a little and retry.
    const attempt = async (): Promise<ChatResponse> => {
      let lastErr: unknown;
      for (let i = 0; i <= RATE_LIMIT_BACKOFF_MS.length; i++) {
        const limited = (limitedUntil.get(key) ?? 0) > this.ctx.now();
        const models = limited && fallbacks.length ? [...fallbacks, this.cfg.model] : [this.cfg.model, ...fallbacks];
        for (const model of models) {
          if (req.signal?.aborted) throw lastErr ?? new Error('aborted');
          // The fallback models do not take the main model's extra options (e.g. "thinking").
          const b = model === this.cfg.model ? body : { ...withoutExtra(body, this.cfg.extraBody), model };
          try {
            return await sendOnce(b);
          } catch (err) {
            if (!(err instanceof ProviderError) || !err.retryable) throw err;
            lastErr = err;
            if (err.status !== 429) break; // a server or network hiccup: wait, then retry the same way
            if (model === this.cfg.model) limitedUntil.set(key, this.ctx.now() + 60_000);
            this.ctx.log.warn(`${this.label}: rate limited on ${model}`);
          }
        }
        const wait = RATE_LIMIT_BACKOFF_MS[i];
        if (wait === undefined) break;
        await new Promise((r) => setTimeout(r, wait));
      }
      throw lastErr;
    };
    const res = this.cfg.maxConcurrent ? await gateFor(key, this.cfg.maxConcurrent).run(attempt) : await attempt();
    const content = res.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new ProviderError(`${this.label}：返回内容为空${res.error?.message ? `（${res.error.message}）` : ''}`, 'llm', { retryable: true });
    }
    // Some reasoning models put their thinking in <think> tags inside the content.
    return content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  }
}
