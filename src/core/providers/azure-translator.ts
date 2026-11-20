import { baseOf } from '../lang/languages';
import { httpJson } from './http';
import { ProviderError, type ProviderContext, type TranslateRequest, type Translator } from './types';

export interface AzureTranslatorConfig {
  key: string;
  /** Resource region, e.g. `eastasia`; required for regional and multi-service resources. */
  region: string;
}

/**
 * Azure AI Translator (text). Free tier F0 includes 2M characters per month. Glossary terms are
 * forced with the dynamic dictionary markup.
 */
export class AzureTranslator implements Translator {
  readonly id = 'azure-translator';
  constructor(
    private readonly cfg: AzureTranslatorConfig,
    private readonly ctx: ProviderContext,
  ) {}

  private get base(): string {
    return this.cfg.region.toLowerCase().startsWith('china')
      ? 'https://api.translator.azure.cn'
      : 'https://api.cognitive.microsofttranslator.com';
  }

  async translate(req: TranslateRequest): Promise<string> {
    if (!this.cfg.key) throw new ProviderError('Azure 翻译：未填写 key', 'azure-translator');
    const code = (l: string) => (baseOf(l) === 'zh' ? 'zh-Hans' : 'es');
    let text = escapeXml(req.text);
    for (const h of req.hits) {
      if (!req.text.includes(h.source)) continue;
      text = text.split(escapeXml(h.source)).join(`<mstrans:dictionary translation="${escapeXml(h.target)}">${escapeXml(h.source)}</mstrans:dictionary>`);
    }
    const url = `${this.base}/translate?api-version=3.0&from=${code(req.from)}&to=${code(req.to)}&textType=html`;
    const headers: Record<string, string> = { 'Ocp-Apim-Subscription-Key': this.cfg.key };
    if (this.cfg.region) headers['Ocp-Apim-Subscription-Region'] = this.cfg.region;
    const res = await httpJson<{ translations?: { text: string }[] }[]>(this.ctx, 'Azure 翻译', url, {
      method: 'POST',
      headers,
      json: [{ Text: text }],
      timeoutMs: 10000,
      signal: req.signal,
    });
    const out = res[0]?.translations?.[0]?.text;
    if (!out) throw new ProviderError('Azure 翻译：返回为空', 'azure-translator', { retryable: true });
    return unescapeXml(out.replace(/<\/?mstrans:dictionary[^>]*>/g, ''));
  }
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function unescapeXml(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}
