import { describe, expect, it } from 'vitest';
import { Transcript, formatClock, toMarkdown, toSrt, toVtt } from '@core/session/transcript';
import { buildSummaryPrompt, parseSummary, summarize, summaryToMarkdown, splitParts } from '@core/session/summary';
import { MockLlm } from '@core/providers/mock';
import type { Llm, LlmRequest } from '@core/providers/types';
import type { MeetingMeta, TranscriptSegment } from '@core/types';

const meta: MeetingMeta = { id: 'm1', title: '交货期会议', startedAt: '2026-11-20T08:00:00.000Z', selfLang: 'zh-CN', remoteLang: 'es-ES', mode: 'meeting', files: {} };
const seg = (id: string, start: number, src: string, dst: string | null, speaker = 'me', extra: Partial<TranscriptSegment> = {}): TranscriptSegment => ({
  id, dir: speaker === 'me' ? 'out' : 'in', speaker, seq: 1, start, end: start + 2, srcLang: speaker === 'me' ? 'zh-CN' : 'es-ES', srcText: src,
  dstLang: speaker === 'me' ? 'es-ES' : 'zh-CN', dstText: dst, status: dst ? 'done' : 'failed', ...extra,
});

describe('Transcript', () => {
  it('appends one JSONL line per change and reloads the latest version', () => {
    const lines: string[] = [];
    const t = new Transcript((l) => lines.push(l));
    t.upsert(seg('out-1', 1, '你好', null, 'me', { status: 'translating' }));
    t.upsert(seg('out-1', 1, '你好', 'Hola'));
    t.upsert(seg('out-1', 1, '你好', 'Hola')); // unchanged → no line
    expect(lines).toHaveLength(2);
    const back = Transcript.fromJsonl(lines.join('') + '{"broken'); // torn tail is ignored
    expect(back.list()).toHaveLength(1);
    expect(back.get('out-1')!.dstText).toBe('Hola');
  });

  it('orders by start time', () => {
    const t = new Transcript();
    t.upsert(seg('in-1', 5, 'Hola', '你好', 'them'));
    t.upsert(seg('out-1', 1, '你好', 'Hola'));
    expect(t.list().map((s) => s.id)).toEqual(['out-1', 'in-1']);
  });
});

describe('exports', () => {
  const segs = [seg('out-1', 62.5, '大家好', 'Hola a todos'), seg('in-1', 66, 'Gracias', null, 'them')];

  it('formats clocks', () => {
    expect(formatClock(62.5)).toBe('01:02');
    expect(formatClock(3725)).toBe('1:02:05');
  });

  it('writes SRT with millisecond timestamps and bilingual lines', () => {
    const srt = toSrt(segs, 'bilingual');
    expect(srt).toContain('00:01:02,500 -->');
    expect(srt).toContain('大家好\nHola a todos');
    expect(toSrt(segs, 'zh')).not.toContain('Gracias'); // no Chinese for the failed one
    expect(toSrt(segs, 'es')).toContain('Gracias');
  });

  it('offsets subtitles to the recording start', () => {
    expect(toSrt(segs, 'src', 60)).toContain('00:00:02,500 -->');
    expect(toVtt(segs, 'src').startsWith('WEBVTT')).toBe(true);
  });

  it('writes markdown with speakers and translations', () => {
    const md = toMarkdown(segs, meta);
    expect(md).toContain('# 交货期会议');
    expect(md).toContain('**[01:02] 我方**');
    expect(md).toContain('> Hola a todos');
    expect(md).toContain('（翻译失败）');
  });

  it('marks a draft-only translation in the markdown (shown, not spoken)', () => {
    const md = toMarkdown([{ ...segs[0]!, dstText: 'Hola todos', draft: true }], meta);
    expect(md).toContain('> Hola todos （草稿，没有念）');
  });
});

describe('summary', () => {
  const segs = [seg('out-1', 0, '我们三周内发货', 'Enviamos en tres semanas'), seg('in-1', 5, 'Perfecto', '好的', 'them')];

  it('builds a prompt with line ids and glossary', () => {
    const p = buildSummaryPrompt(segs, meta, [{ id: '1', zh: '星云平台', es: 'Plataforma Nébula', aliasesZh: [], aliasesEs: [], note: '', enabled: true }], 'business');
    expect(p.user).toContain('[L1 00:00 我方] 我们三周内发货 ‖ Enviamos en tres semanas');
    expect(p.user).toContain('[L2 00:05 对方]');
    expect(p.user).toContain('星云平台 = Plataforma Nébula');
    expect(p.system).toContain('payment terms');
  });

  it('parses fenced JSON and fills missing arrays', () => {
    const s = parseSummary('Here you go:\n```json\n{"title":{"zh":"标题","es":"Título"},"summary":"只有一种语言"}\n```');
    expect(s.title.es).toBe('Título');
    expect(s.summary.zh).toBe('只有一种语言');
    expect(s.todos).toEqual([]);
  });

  it('rejects replies without JSON', () => {
    expect(() => parseSummary('抱歉')).toThrow(/JSON/);
  });

  it('summarises long meetings in parts and merges', async () => {
    const calls: LlmRequest[] = [];
    const llm: Llm = { id: 'x', complete: async (r) => { calls.push(r); return new MockLlm().complete(r); } };
    const many = Array.from({ length: 60 }, (_, i) => seg(`out-${i}`, i * 3, '这是一句比较长的测试句子，用来把记录撑大。'.repeat(3), 'Frase de prueba bastante larga para llenar el acta.'));
    const parts = splitParts(many, 2000);
    expect(parts.length).toBeGreaterThan(1);
    const res = await summarize(llm, many, meta, [], 'general', { maxCharsPerPart: 2000 });
    expect(calls).toHaveLength(parts.length + 1);
    expect(calls[1]!.user).toContain(`part 2 of ${parts.length}`);
    expect(res.title.zh).toBeTruthy();
  });

  it('renders markdown in each language', async () => {
    const s = await summarize(new MockLlm(), segs, meta, [], 'general');
    const zh = summaryToMarkdown(s, 'zh', meta);
    const es = summaryToMarkdown(s, 'es', meta);
    expect(zh).toContain('## 待办');
    expect(zh).toContain('负责人：我方');
    expect(es).toContain('## Tareas');
    expect(es).toContain('Enviar el borrador del contrato');
  });
});
