import { ASR_RATE, concatInt16, resampleInt16 } from '../core/audio/pcm';
import { sleep } from '../core/events';
import { lang } from '../core/lang/languages';
import type { Providers } from '../core/providers/registry';
import { collectPcm, type Llm } from '../core/providers/types';
import type { Direction } from '../core/types';
import type { ProviderTestStep } from '../shared/ipc';

const SAMPLES: Record<'zh' | 'es' | 'en', string> = {
  en: 'Good morning, today we will discuss the delivery time and the price.',
  zh: '大家好，我们今天讨论一下交货时间和价格。',
  es: 'Buenos días, hoy vamos a hablar del plazo de entrega y del precio.',
};

async function step<T>(steps: ProviderTestStep[], name: string, fn: () => Promise<{ value: T; detail: string }>): Promise<T | null> {
  const t0 = Date.now();
  try {
    const { value, detail } = await fn();
    steps.push({ name, ok: true, ms: Date.now() - t0, detail });
    return value;
  } catch (err) {
    steps.push({ name, ok: false, ms: Date.now() - t0, detail: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/**
 * Checks one direction end to end with real services: synthesise a sample sentence in the source
 * language (with the other direction's voice), recognise it, translate it and synthesise the result.
 */
export async function testDirection(p: Providers, dir: Direction, srcLang: string, dstLang: string): Promise<ProviderTestStep[]> {
  const steps: ProviderTestStep[] = [];
  const srcBase = lang(srcLang).base;
  const sampleText = SAMPLES[srcBase];
  const other: Direction = dir === 'out' ? 'in' : 'out';

  // 1. Test audio in the source language, spoken by whichever voice speaks it.
  const audio = await step(steps, `生成${lang(srcLang).nameZh}测试语音`, async () => {
    const tts = p.tts(other) ?? p.tts(dir);
    if (!tts) throw new Error('没有可用的语音合成，跳过识别测试（可直接开会对着麦克风试）');
    const pcm = await collectPcm(tts.synthesize({ text: sampleText, lang: srcLang, rate: 1 }));
    if (!pcm.samples.length) throw new Error('合成结果为空');
    return { value: resampleInt16(pcm.samples, pcm.sampleRate, ASR_RATE), detail: `${(pcm.samples.length / pcm.sampleRate).toFixed(1)} 秒` };
  });

  // 2. Recognition.
  let recognised = '';
  if (audio) {
    recognised =
      (await step(steps, `语音识别（${lang(srcLang).nameZh}）`, async () => {
        const session = await p.asr(dir).start({ lang: srcLang, hotwords: [], sampleRate: 16000 });
        const finals: string[] = [];
        let error = '';
        session.events.on('final', ({ text }) => finals.push(text));
        session.events.on('error', ({ error: e }) => (error = e.message));
        const padded = concatInt16([audio, new Int16Array(ASR_RATE * 1.5)]);
        const chunk = ASR_RATE / 10;
        for (let i = 0; i < padded.length; i += chunk) {
          session.push(padded.subarray(i, i + chunk));
          await sleep(25); // ~4× real time
        }
        await Promise.race([session.end(), sleep(8000)]);
        session.close();
        const text = finals.join('');
        if (!text) throw new Error(error || '没有识别出文字');
        return { value: text, detail: text };
      })) ?? '';
  }

  // 3. Translation (of what was recognised, or of the sample sentence).
  const source = recognised || sampleText;
  const translated = await step(steps, `翻译（${lang(srcLang).nameZh} → ${lang(dstLang).nameZh}）`, async () => {
    const out = await p.mt(dir).translate({ text: source, from: srcLang, to: dstLang, hits: [], context: [] });
    if (!out.trim()) throw new Error('翻译结果为空');
    return { value: out, detail: out };
  });

  // 4. Voice for the translation.
  await step(steps, `语音合成（${lang(dstLang).nameZh}）`, async () => {
    const tts = p.tts(dir);
    if (!tts) return { value: null, detail: '此方向未开启语音（只出字幕）' };
    const pcm = await collectPcm(tts.synthesize({ text: translated || (dstLang.startsWith('zh') ? '测试' : 'Prueba'), lang: dstLang, rate: 1 }));
    if (!pcm.samples.length) throw new Error('合成结果为空');
    return { value: null, detail: `${(pcm.samples.length / pcm.sampleRate).toFixed(1)} 秒语音` };
  });
  return steps;
}

export async function testLlm(llm: Llm | null): Promise<ProviderTestStep[]> {
  const steps: ProviderTestStep[] = [];
  await step(steps, '大模型（翻译 / 纪要）', async () => {
    if (!llm) throw new Error('还没有保存大模型 Key：在“翻译服务”里粘贴后点“保存”（离开输入框也会自动保存）');
    const out = await llm.complete({ system: 'Reply with the single word OK.', user: 'ping', maxTokens: 10 });
    return { value: null, detail: out.slice(0, 40) };
  });
  return steps;
}
