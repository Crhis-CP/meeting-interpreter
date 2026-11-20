import { Segmenter } from '../audio/segmenter';
import { Emitter } from '../events';
import { baseOf } from '../lang/languages';
import type { LangCode, PcmChunk } from '../types';
import type { AsrEvents, AsrSession, AsrStartOptions, Llm, LlmRequest, StreamingAsr, TranslateRequest, Translator, Tts, TtsRequest, VoiceInfo } from './types';

/** Demo conversation: what each side "says" in demo mode, with real translations. */
export const DEMO_LINES: { zh: string; es: string; en: string }[] = [
  { zh: '大家好，欢迎参加今天的会议。', es: 'Hola a todos, bienvenidos a la reunión de hoy.', en: 'Hello everyone, welcome to today’s meeting.' },
  { zh: '我们今天主要讨论新产品的交货期和价格。', es: 'Hoy vamos a hablar principalmente del plazo de entrega y del precio del nuevo producto.', en: 'Today we will mainly discuss the delivery time and price of the new product.' },
  { zh: '第一批货可以在三周内发出。', es: 'El primer lote puede enviarse en tres semanas.', en: 'The first batch can be shipped within three weeks.' },
  { zh: '如果订单超过一千台，我们可以给百分之五的折扣。', es: 'Si el pedido supera las mil unidades, podemos ofrecer un descuento del cinco por ciento.', en: 'If the order exceeds one thousand units, we can offer a five percent discount.' },
  { zh: '付款方式我们建议百分之三十预付，剩下的发货前付清。', es: 'Como forma de pago proponemos un treinta por ciento por adelantado y el resto antes del envío.', en: 'For payment, we suggest thirty percent in advance and the rest before shipment.' },
  { zh: '这个方案你们觉得怎么样？', es: '¿Qué les parece esta propuesta?', en: 'What do you think of this proposal?' },
  { zh: '好的，我会在周五之前把合同草稿发给你们。', es: 'De acuerdo, les enviaré el borrador del contrato antes del viernes.', en: 'Okay, I will send you the draft contract before Friday.' },
  { zh: '谢谢大家，我们下周同一时间再见。', es: 'Gracias a todos, nos vemos la próxima semana a la misma hora.', en: 'Thank you all, see you next week at the same time.' },
];

export const DEMO_REMOTE_LINES: { zh: string; es: string; en: string }[] = [
  { zh: '你好，很高兴见到你们。', es: 'Hola, encantado de conocerlos.', en: 'Hello, nice to meet you.' },
  { zh: '三周的交货期对我们来说没问题。', es: 'El plazo de entrega de tres semanas nos parece bien.', en: 'A three-week delivery time works for us.' },
  { zh: '我们能不能把折扣提高到百分之八？', es: '¿Podríamos aumentar el descuento al ocho por ciento?', en: 'Could we raise the discount to eight percent?' },
  { zh: '我们需要先和财务部门确认付款条件。', es: 'Necesitamos confirmar primero las condiciones de pago con el departamento de finanzas.', en: 'We need to confirm the payment terms with our finance department first.' },
  { zh: '请把产品的技术参数也一起发给我们。', es: 'Por favor, envíennos también las especificaciones técnicas del producto.', en: 'Please also send us the technical specifications of the product.' },
  { zh: '非常感谢，我们周五等你们的合同。', es: 'Muchas gracias, esperamos su contrato el viernes.', en: 'Thank you very much, we look forward to your contract on Friday.' },
];

/**
 * Pretends to recognise speech: every stretch of sound (found by the segmenter) becomes the next
 * scripted line, with a partial halfway through. Lets people try the app with no account and drives
 * the end-to-end tests with real audio flowing.
 */
export class MockAsr implements StreamingAsr {
  readonly id = 'demo';
  private next = 0;
  constructor(private readonly script: 'self' | 'remote' = 'self') {}

  async start(opts: AsrStartOptions): Promise<AsrSession> {
    const events = new Emitter<AsrEvents>();
    const seg = new Segmenter({ minSpeech: 0.2 });
    const lines = this.script === 'self' ? DEMO_LINES : DEMO_REMOTE_LINES;
    const key = baseOf(opts.lang);
    let open = true;
    let pendingPartial: ReturnType<typeof setTimeout> | null = null;
    seg.on('speechStart', () => {
      const line = lines[this.next % lines.length]![key];
      pendingPartial = setTimeout(() => {
        if (open) events.emit('partial', { text: line.slice(0, Math.max(2, Math.floor(line.length / 2))) });
      }, 300);
    });
    seg.on('segment', (s) => {
      if (pendingPartial) clearTimeout(pendingPartial);
      const line = lines[this.next++ % lines.length]![key];
      if (open) events.emit('final', { text: line, start: s.start, end: s.start + s.samples.length / 16000 });
    });
    const close = () => {
      if (!open) return;
      open = false;
      if (pendingPartial) clearTimeout(pendingPartial);
      events.emit('closed', {});
    };
    return {
      events,
      push: (pcm) => {
        if (open) seg.feed(pcm);
      },
      end: async () => {
        seg.flush();
        close();
      },
      close,
    };
  }
}

export class MockTranslator implements Translator {
  readonly id = 'demo';
  async translate(req: TranslateRequest): Promise<string> {
    await new Promise((r) => setTimeout(r, 120));
    const from = baseOf(req.from);
    const to = baseOf(req.to);
    for (const l of [...DEMO_LINES, ...DEMO_REMOTE_LINES]) {
      if (l[from] === req.text.trim()) return l[to];
    }
    let text = req.text;
    for (const h of req.hits) text = text.split(h.source).join(h.target);
    return to === 'zh' ? `[中] ${text}` : `[${to.toUpperCase()}] ${text}`;
  }
}

/** A "voice" made of short tones whose length follows the text, so routing can be heard and tested. */
export class MockTts implements Tts {
  readonly id = 'demo';
  async *synthesize(req: TtsRequest): AsyncIterable<PcmChunk> {
    const rate = 24000;
    const units = baseOf(req.lang) === 'zh' ? [...req.text.replace(/\s/g, '')].length : req.text.split(/\s+/).filter(Boolean).length * 2;
    const syllable = 0.11 / Math.max(0.5, req.rate);
    const base = baseOf(req.lang) === 'zh' ? 260 : 200;
    for (let i = 0; i < units; i++) {
      if (req.signal?.aborted) return;
      const n = Math.round(syllable * rate);
      const out = new Int16Array(n);
      const f = base + ((i * 37) % 90);
      for (let k = 0; k < n; k++) {
        const env = Math.sin((Math.PI * k) / n);
        out[k] = Math.round(Math.sin((2 * Math.PI * f * k) / rate) * env * 0.25 * 32767);
      }
      yield { samples: out, sampleRate: rate };
    }
  }
  voices(_lang: LangCode): VoiceInfo[] {
    return [{ id: 'demo', name: '演示音', lang: 'multi' }];
  }
}

/** Returns a fixed, valid bilingual summary so the summary screens work in demo mode. */
export class MockLlm implements Llm {
  readonly id = 'demo';
  async complete(req: LlmRequest): Promise<string> {
    if (!req.json) return req.user;
    return JSON.stringify({
      title: { zh: '新产品交货与价格洽谈', es: 'Negociación de entrega y precio del nuevo producto' },
      summary: {
        zh: '双方讨论了新产品的交货期、折扣和付款方式，约定周五前发送合同草稿。',
        es: 'Ambas partes hablaron del plazo de entrega, el descuento y la forma de pago del nuevo producto, y acordaron enviar el borrador del contrato antes del viernes.',
      },
      topics: [
        {
          start: 0,
          title: { zh: '交货期与价格', es: 'Plazo de entrega y precio' },
          summary: { zh: '第一批货三周内发出，千台以上给折扣。', es: 'El primer lote sale en tres semanas; descuento a partir de mil unidades.' },
          points: [{ text: { zh: '三周内发货', es: 'Envío en tres semanas' }, evidence: ['L1'] }],
        },
      ],
      decisions: [{ text: { zh: '周五前发合同草稿', es: 'Enviar el borrador del contrato antes del viernes' }, evidence: ['L1'] }],
      todos: [{ text: { zh: '发送合同草稿', es: 'Enviar el borrador del contrato' }, owner: '我方', due: '周五', evidence: ['L1'] }],
      terms: [],
    });
  }
}
