/**
 * Which keys the chosen services need before a meeting can start (pure: the desktop app's
 * readiness checklist and its tests use it).
 */
import { llmPreset } from '../providers/openai-compatible';
import type { AppSettings, SecretName } from './schema';

export const KEY_NAMES: Record<SecretName, string> = {
  dashscope: '阿里云百炼',
  azure: 'Azure 语音',
  azureTranslator: 'Azure 翻译',
  llm: '大模型',
  deepl: 'DeepL',
};

/** Keys the interpretation needs (both directions as configured), each once, with what it is for. */
export function keysNeeded(s: AppSettings): { name: SecretName; for: string }[] {
  const out = new Map<SecretName, Set<string>>();
  const add = (name: SecretName, what: string) => out.set(name, (out.get(name) ?? new Set()).add(what));
  const llm = llmPreset(s.llm.preset);
  for (const d of [s.out, s.in]) {
    if (!d.enabled) continue;
    if (d.asr === 'dashscope') add('dashscope', '识别');
    if (d.asr === 'azure') add('azure', '识别');
    if (d.mt === 'qwen-mt') add('dashscope', '翻译');
    if (d.mt === 'deepl') add('deepl', '翻译');
    if (d.mt === 'azure-translator') add('azureTranslator', '翻译');
    if (d.mt === 'llm' && !llm?.noKey) add(llm?.usesDashscopeKey ? 'dashscope' : 'llm', '翻译');
    if (d.tts === 'dashscope') add('dashscope', '语音');
    if (d.tts === 'azure') add('azure', '语音');
  }
  return [...out].map(([name, what]) => ({ name, for: [...what].join('、') }));
}

/** Of those, the ones not saved yet (`have`: which keys are saved). Azure Translator also accepts the speech key. */
export function missingKeys(s: AppSettings, have: Partial<Record<SecretName, boolean>>): { name: SecretName; for: string }[] {
  return keysNeeded(s).filter((k) => !have[k.name] && !(k.name === 'azureTranslator' && have.azure) && !(k.name === 'llm' && llmPreset(s.llm.preset)?.usesDashscopeKey && have.dashscope));
}
