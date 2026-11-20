import type { LangCode } from '../types';

export type LangBase = 'zh' | 'es' | 'en';

/** Languages written in Latin script (word boundaries, accents). */
export const isLatin = (b: LangBase): boolean => b !== 'zh';

export interface LanguageInfo {
  code: LangCode;
  base: LangBase;
  /** Name shown in the Chinese UI. */
  nameZh: string;
  /** Name in the language itself (shown to room participants). */
  nameNative: string;
  /** English name, used inside LLM prompts. */
  englishName: string;
  script: 'han' | 'latin';
  /** Codes per provider family. */
  codes: {
    azure: string;
    dashscope: string;
    qwenMt: string;
    deeplSource: string;
    deeplTarget: string;
    openai: string;
  };
}

const zh: LanguageInfo = {
  code: 'zh-CN',
  base: 'zh',
  nameZh: '中文（普通话）',
  nameNative: '中文',
  englishName: 'Simplified Chinese (Mandarin)',
  script: 'han',
  codes: { azure: 'zh-CN', dashscope: 'zh', qwenMt: 'Chinese', deeplSource: 'ZH', deeplTarget: 'ZH-HANS', openai: 'zh' },
};

function spanish(code: string, region: string, regionNative: string, deeplTarget = 'ES'): LanguageInfo {
  return {
    code,
    base: 'es',
    nameZh: `西班牙语（${region}）`,
    nameNative: `Español (${regionNative})`,
    englishName: 'Spanish',
    script: 'latin',
    codes: { azure: code, dashscope: 'es', qwenMt: 'Spanish', deeplSource: 'ES', deeplTarget, openai: 'es' },
  };
}

function english(code: string, region: string, regionNative: string, deeplTarget: string): LanguageInfo {
  return {
    code,
    base: 'en',
    nameZh: `英语（${region}）`,
    nameNative: `English (${regionNative})`,
    englishName: 'English',
    script: 'latin',
    codes: { azure: code, dashscope: 'en', qwenMt: 'English', deeplSource: 'EN', deeplTarget, openai: 'en' },
  };
}

export const LANGUAGES: Record<LangCode, LanguageInfo> = {
  'zh-CN': zh,
  'es-ES': spanish('es-ES', '西班牙', 'España'),
  'es-MX': spanish('es-MX', '墨西哥', 'México', 'ES-419'),
  'es-US': spanish('es-US', '美国', 'Estados Unidos', 'ES-419'),
  'es-AR': spanish('es-AR', '阿根廷', 'Argentina', 'ES-419'),
  'es-CO': spanish('es-CO', '哥伦比亚', 'Colombia', 'ES-419'),
  'es-CL': spanish('es-CL', '智利', 'Chile', 'ES-419'),
  'es-PE': spanish('es-PE', '秘鲁', 'Perú', 'ES-419'),
  'en-US': english('en-US', '美国', 'US', 'EN-US'),
  'en-GB': english('en-GB', '英国', 'UK', 'EN-GB'),
};

export const SELF_LANGUAGES: LangCode[] = ['zh-CN'];
export const REMOTE_LANGUAGES: LangCode[] = ['es-MX', 'es-ES', 'es-US', 'es-AR', 'es-CO', 'es-CL', 'es-PE', 'en-US', 'en-GB'];

/** What users choose: just the language. The accent (region) is an optional detail. */
export const REMOTE_CHOICES: { base: 'es' | 'en'; name: string; code: LangCode }[] = [
  { base: 'es', name: '西班牙语', code: 'es-MX' },
  { base: 'en', name: 'English 英语', code: 'en-US' },
];

/** The accents offered for a language, e.g. es → 拉美（墨西哥）、西班牙… */
export function accentsOf(base: LangBase): { code: LangCode; name: string }[] {
  return REMOTE_LANGUAGES.filter((c) => lang(c).base === base).map((c) => ({ code: c, name: lang(c).nameZh.replace(/^.*（(.*)）$/, '$1') }));
}

/** Changing the language keeps the accent when it still fits, else the language's default. */
export function withRemoteBase(current: LangCode, base: 'es' | 'en'): LangCode {
  return baseOf(current) === base ? current : REMOTE_CHOICES.find((c) => c.base === base)!.code;
}

export function lang(code: LangCode): LanguageInfo {
  const info = LANGUAGES[code];
  if (info) return info;
  // Accept bare or unknown regional tags by their base language.
  const base = code.split('-')[0]?.toLowerCase();
  if (base === 'zh') return zh;
  if (base === 'es') return LANGUAGES['es-ES']!;
  if (base === 'en') return LANGUAGES['en-US']!;
  throw new Error(`不支持的语言：${code}`);
}

export function baseOf(code: LangCode): LangBase {
  return lang(code).base;
}

/** The other side's language in a zh⇄es pair. */
export function otherLanguage(code: LangCode, remote: LangCode = 'es-MX'): LangCode {
  return baseOf(code) === 'zh' ? remote : 'zh-CN';
}

export function sameBase(a: LangCode, b: LangCode): boolean {
  return baseOf(a) === baseOf(b);
}
