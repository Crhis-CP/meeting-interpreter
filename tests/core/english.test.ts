import { describe, expect, it } from 'vitest';
import { Emitter } from '@core/events';
import { glossaryToCsv, parseGlossaryCsv } from '@core/glossary/csv';
import { correctText } from '@core/glossary/correct';
import { findHits, hotwordsFor } from '@core/glossary/match';
import { activeEntries, termOf, type GlossaryEntry } from '@core/glossary/types';
import { baseOf, lang, otherLanguage, REMOTE_LANGUAGES } from '@core/lang/languages';
import { DirectionPipeline } from '@core/pipeline/pipeline';
import { isValidTranslation } from '@core/pipeline/validate';
import { buildGlossaryDictionaries } from '@core/providers/deepl';
import { MockTranslator } from '@core/providers/mock';
import type { AsrEvents, AsrSession, StreamingAsr, Translator, TranslateRequest, Tts, TtsRequest } from '@core/providers/types';
import { buildSummaryPrompt, parseSummary, summaryToMarkdown } from '@core/session/summary';
import { speakerLabel, toMarkdown, toSrt } from '@core/session/transcript';
import type { MeetingMeta, TranscriptSegment } from '@core/types';
import { waitFor } from '../helpers/fakes';

const entry = (zh: string, en: string, extra: Partial<GlossaryEntry> = {}): GlossaryEntry => ({
  id: zh, zh, es: '', en, aliasesZh: [], aliasesEs: [], aliasesEn: [], note: '', enabled: true, ...extra,
});

describe('English languages', () => {
  it('offers en-US and en-GB as the other side', () => {
    expect(REMOTE_LANGUAGES).toContain('en-US');
    expect(REMOTE_LANGUAGES).toContain('en-GB');
    expect(baseOf('en-US')).toBe('en');
    expect(lang('en-GB').codes.deeplTarget).toBe('EN-GB');
    expect(lang('en-US').codes.qwenMt).toBe('English');
    expect(otherLanguage('zh-CN', 'en-US')).toBe('en-US');
    expect(otherLanguage('en-US', 'en-US')).toBe('zh-CN');
  });
});

describe('English glossary', () => {
  const nebula = entry('星云平台', 'Nebula Platform', { aliasesZh: ['心云平台'], aliasesEn: ['nebola platform'] });

  it('counts entries that only have an English term', () => {
    expect(activeEntries([{ id: 'g', name: 'g', enabled: true, entries: [nebula] }])).toHaveLength(1);
    expect(termOf(nebula, 'en')).toBe('Nebula Platform');
    expect(termOf(nebula, 'es')).toBe('');
  });

  it('finds Chinese terms with their English translation', () => {
    const hits = findHits('我们讨论一下这个星云平台', 'zh', [nebula], 'en');
    expect(hits[0]).toMatchObject({ source: '星云平台', target: 'Nebula Platform' });
  });

  it('finds English terms case-insensitively with their Chinese translation', () => {
    const hits = findHits('What about the nebula platform schedule?', 'en', [nebula], 'zh');
    expect(hits[0]).toMatchObject({ target: '星云平台' });
  });

  it('corrects mis-recognitions in both languages', () => {
    expect(correctText('讨论一下这个心云平台', 'zh', [nebula], { pinyinFuzzy: false }).text).toBe('讨论一下这个星云平台');
    expect(correctText('the nebola platform launch', 'en', [nebula], { pinyinFuzzy: false }).text).toContain('Nebula Platform');
  });

  it('uses English terms as hot words', () => {
    expect(hotwordsFor('en', [nebula, entry('交货期', 'lead time')])).toEqual(['Nebula Platform', 'lead time']);
  });

  it('reads and writes the English columns in CSV', () => {
    const { entries } = parseGlossaryCsv('中文,English,英语别名\n交货期,lead time,delivery time\n');
    expect(entries[0]).toMatchObject({ zh: '交货期', en: 'lead time', aliasesEn: ['delivery time'] });
    const back = parseGlossaryCsv(glossaryToCsv([nebula])).entries[0]!;
    expect(back).toMatchObject({ zh: '星云平台', en: 'Nebula Platform', aliasesZh: ['心云平台'], aliasesEn: ['nebola platform'] });
  });

  it('builds a zh⇄en DeepL glossary from the English column', () => {
    const d = buildGlossaryDictionaries([nebula, entry('交货期', 'lead time', { es: 'plazo de entrega' })], 'en')!;
    expect(d.foreign).toBe('en');
    expect(d.zhEs).toBe('星云平台\tNebula Platform\n交货期\tlead time');
    expect(buildGlossaryDictionaries([nebula], 'es')).toBeNull(); // no Spanish terms
    expect(buildGlossaryDictionaries([entry('交货期', 'lead time', { es: 'plazo' })], 'es')!.hash).not.toBe(d.hash);
  });
});

describe('English translation checks', () => {
  it('accepts English and rejects untranslated Chinese', () => {
    expect(isValidTranslation('Let us discuss the Nebula Platform.', 'en-US', '我们讨论一下星云平台。')).toBe(true);
    expect(isValidTranslation('我们讨论一下星云平台。', 'en-US', '我们讨论一下星云平台。')).toBe(false);
  });

  it('the demo translator produces English', async () => {
    const t = new MockTranslator();
    const out = await t.translate({ text: '大家好，欢迎参加今天的会议。', from: 'zh-CN', to: 'en-US', hits: [], context: [] });
    expect(out).toBe('Hello everyone, welcome to today’s meeting.');
    const back = await t.translate({ text: 'Hello, nice to meet you.', from: 'en-US', to: 'zh-CN', hits: [], context: [] });
    expect(back).toBe('你好，很高兴见到你们。');
  });
});

class Session implements AsrSession {
  events = new Emitter<AsrEvents>();
  push() {}
  async end() { this.events.emit('closed', {}); }
  close() {}
}

describe('zh → en pipeline', () => {
  it('passes English glossary targets to the translator and speaks English', async () => {
    const session = new Session();
    const asr: StreamingAsr = { id: 'a', start: async () => session };
    const requests: TranslateRequest[] = [];
    const translator: Translator = { id: 't', translate: async (r) => (requests.push(r), "Let's discuss the Nebula Platform.") };
    const calls: TtsRequest[] = [];
    const tts: Tts = { id: 's', voices: () => [], async *synthesize(r) { calls.push(r); yield { samples: new Int16Array(10), sampleRate: 24000 }; } };
    const p = new DirectionPipeline({
      dir: 'out', speaker: 'me', idPrefix: 'out', srcLang: 'zh-CN', dstLang: 'en-US',
      asr, translator, tts, glossary: () => [entry('星云平台', 'Nebula Platform', { aliasesZh: ['心云平台'] })],
      pinyinFuzzy: false, lowLatency: false, clock: () => 1, reconnectDelays: [10],
    });
    const segs: TranscriptSegment[] = [];
    p.on('segment', (s) => segs.push(s));
    await p.start();
    session.events.emit('final', { text: '讨论一下这个心云平台。' });
    await waitFor(() => calls.length === 1);
    expect(segs.at(-1)!.srcText).toBe('讨论一下这个星云平台。');
    expect(requests[0]!.hits[0]!.target).toBe('Nebula Platform');
    expect(calls[0]!.lang).toBe('en-US');
    await p.stop();
  });
});

describe('English meeting records', () => {
  const meta: MeetingMeta = { id: 'm', title: 'Weekly sync', startedAt: '2026-11-20T08:00:00.000Z', selfLang: 'zh-CN', remoteLang: 'en-US', mode: 'meeting', files: {} };
  const segs: TranscriptSegment[] = [
    { id: 'out-1', dir: 'out', speaker: 'me', seq: 1, start: 1, end: 3, srcLang: 'zh-CN', srcText: '大家好', dstLang: 'en-US', dstText: 'Hello everyone', status: 'done' },
    { id: 'in-1', dir: 'in', speaker: 'them', seq: 1, start: 4, end: 6, srcLang: 'en-US', srcText: 'Thanks', dstLang: 'zh-CN', dstText: '谢谢', status: 'done' },
  ];

  it('writes English subtitles and transcript labels', () => {
    expect(toSrt(segs, 'foreign')).toContain('Hello everyone');
    expect(toSrt(segs, 'foreign')).toContain('Thanks');
    expect(toSrt(segs, 'foreign')).not.toContain('谢谢');
    expect(speakerLabel(segs[1]!, 'en')).toBe('Them');
    expect(toMarkdown(segs, meta, 'en')).toContain('## Bilingual transcript');
  });

  it('asks for Chinese and English minutes', () => {
    const p = buildSummaryPrompt(segs, meta, [entry('星云平台', 'Nebula Platform')], 'general');
    expect(p.system).toContain('Chinese and English speakers');
    expect(p.system).toContain('"en"');
    expect(p.system).not.toContain('Spanish');
    expect(p.user).toContain('星云平台 = Nebula Platform');
  });

  it('renders English minutes', () => {
    const sum = parseSummary(JSON.stringify({
      title: { zh: '周会', en: 'Weekly sync' },
      summary: { zh: '讨论了交货期。', en: 'We discussed the lead time.' },
      decisions: [{ text: { zh: '下周交货', en: 'Deliver next week' }, evidence: ['L1'] }],
      terms: [{ zh: '交货期', en: 'lead time', note: '' }],
    }));
    const md = summaryToMarkdown(sum, 'en', meta);
    expect(md).toContain('# Weekly sync');
    expect(md).toContain('## Decisions');
    expect(md).toContain('Deliver next week');
    expect(md).toContain('| Chinese | English | Note |');
    expect(md).toContain('| 交货期 | lead time |  |');
    expect(summaryToMarkdown(sum, 'zh', meta)).toContain('| 中文 | English | 说明 |');
  });
});
