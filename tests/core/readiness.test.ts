import { describe, expect, it } from 'vitest';
import { applyPreset } from '@core/config/presets';
import { defaultSettings } from '@core/config/schema';
import { keysNeeded, missingKeys } from '@core/config/readiness';

describe('keys a meeting needs', () => {
  it('the free plan needs none; 百炼 needs one key for everything', () => {
    expect(keysNeeded(applyPreset(defaultSettings(), 'free'))).toEqual([]);
    expect(keysNeeded(applyPreset(defaultSettings(), 'dashscope'))).toEqual([{ name: 'dashscope', for: '识别、翻译、语音' }]);
  });

  it('Azure: speech key, and the translator key unless the speech key covers it', () => {
    const s = applyPreset(defaultSettings(), 'azure');
    expect(keysNeeded(s).map((k) => k.name).sort()).toEqual(['azure', 'azureTranslator']);
    expect(missingKeys(s, { azure: true })).toEqual([]);
    expect(missingKeys(s, {}).map((k) => k.name).sort()).toEqual(['azure', 'azureTranslator']);
  });

  it('an LLM translator needs the LLM key (or the 百炼 key for 通义千问; none for a local model)', () => {
    const s = defaultSettings();
    s.out = { ...s.out, asr: 'demo', mt: 'llm', tts: 'none' };
    s.in = { ...s.in, enabled: false };
    s.llm.preset = 'zhipu-free';
    expect(missingKeys(s, {})).toEqual([{ name: 'llm', for: '翻译' }]);
    expect(missingKeys(s, { llm: true })).toEqual([]);
    s.llm.preset = 'qwen';
    expect(missingKeys(s, { dashscope: true })).toEqual([]);
    s.llm.preset = 'ollama';
    expect(keysNeeded(s)).toEqual([]);
  });

  it('a direction that is switched off needs nothing', () => {
    const s = applyPreset(defaultSettings(), 'dashscope');
    s.out.enabled = false;
    s.in.enabled = false;
    expect(keysNeeded(s)).toEqual([]);
  });
});
