import type { MeetingMeta, TranscriptSegment } from '../types';

/**
 * The bilingual record of a meeting. Every change to a segment is appended to a JSONL sink
 * (`transcript.jsonl`) so a crash loses at most the line being written; reading keeps the last
 * version of each segment id.
 */
export class Transcript {
  private segments = new Map<string, TranscriptSegment>();

  constructor(private readonly sink?: (line: string) => void) {}

  upsert(seg: TranscriptSegment): void {
    const prev = this.segments.get(seg.id);
    if (prev && JSON.stringify(prev) === JSON.stringify(seg)) return;
    this.segments.set(seg.id, seg);
    this.sink?.(JSON.stringify(seg) + '\n');
  }

  get(id: string): TranscriptSegment | undefined {
    return this.segments.get(id);
  }

  /** Segments in time order (start, then direction, then sequence). */
  list(): TranscriptSegment[] {
    return [...this.segments.values()].sort((a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id));
  }

  get size(): number {
    return this.segments.size;
  }

  static fromJsonl(text: string): Transcript {
    const t = new Transcript();
    for (const line of text.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try {
        const seg = JSON.parse(s) as TranscriptSegment;
        if (seg && typeof seg.id === 'string') t.segments.set(seg.id, seg);
      } catch {
        // A torn last line after a crash: ignore it.
      }
    }
    return t;
  }
}

export function formatClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`;
}

function srtTime(sec: number, sep: ',' | '.'): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  const p = (n: number, w = 2) => n.toString().padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(r, 3)}`;
}

/** `es`/`en`/`foreign`: the non-Chinese side's language. */
export type SubtitleMode = 'src' | 'dst' | 'bilingual' | 'zh' | 'es' | 'en' | 'foreign';

function subtitleText(seg: TranscriptSegment, mode: SubtitleMode): string | null {
  const isZh = (l: string) => l.toLowerCase().startsWith('zh');
  switch (mode) {
    case 'src':
      return seg.srcText;
    case 'dst':
      return seg.dstText;
    case 'bilingual':
      return seg.dstText ? `${seg.srcText}\n${seg.dstText}` : seg.srcText;
    case 'zh':
      return isZh(seg.srcLang) ? seg.srcText : seg.dstText;
    default:
      return isZh(seg.srcLang) ? seg.dstText : seg.srcText;
  }
}

function cues(segs: TranscriptSegment[], mode: SubtitleMode, offsetSec: number) {
  const out: { start: number; end: number; text: string }[] = [];
  for (const s of segs) {
    const text = subtitleText(s, mode);
    if (!text) continue;
    const start = Math.max(0, s.start - offsetSec);
    // Keep each cue on screen long enough to read.
    const end = Math.max(start + 1.2, s.end - offsetSec + 1.5);
    out.push({ start, end, text });
  }
  // Avoid overlapping cues from the same timeline being clipped by players.
  for (let i = 0; i + 1 < out.length; i++) {
    if (out[i]!.end > out[i + 1]!.start + 2) out[i]!.end = Math.max(out[i]!.start + 1, out[i + 1]!.start + 2);
  }
  return out;
}

/** SubRip subtitles aligned to a recording that started `offsetSec` after the meeting. */
export function toSrt(segs: TranscriptSegment[], mode: SubtitleMode, offsetSec = 0): string {
  return cues(segs, mode, offsetSec)
    .map((c, i) => `${i + 1}\n${srtTime(c.start, ',')} --> ${srtTime(c.end, ',')}\n${c.text}\n`)
    .join('\n');
}

export function toVtt(segs: TranscriptSegment[], mode: SubtitleMode, offsetSec = 0): string {
  return (
    'WEBVTT\n\n' +
    cues(segs, mode, offsetSec)
      .map((c) => `${srtTime(c.start, '.')} --> ${srtTime(c.end, '.')}\n${c.text}\n`)
      .join('\n')
  );
}

export type UiLang = 'zh' | 'es' | 'en';

export function speakerLabel(seg: TranscriptSegment, lang: UiLang = 'zh'): string {
  if (seg.speaker === 'me') return lang === 'zh' ? '我方' : lang === 'en' ? 'Us' : 'Nosotros';
  if (seg.speaker === 'them') return lang === 'zh' ? '对方' : lang === 'en' ? 'Them' : 'Ellos';
  return seg.speaker;
}

const MD_LABELS = {
  zh: { title: '会议记录', date: '时间', langs: '语言', platform: '会议软件', body: '双语逐句记录', failed: '（翻译失败）', locale: 'zh-CN' },
  es: { title: 'Acta de la reunión', date: 'Fecha', langs: 'Idiomas', platform: 'Plataforma', body: 'Transcripción bilingüe', failed: '(traducción fallida)', locale: 'es-ES' },
  en: { title: 'Meeting transcript', date: 'Date', langs: 'Languages', platform: 'Platform', body: 'Bilingual transcript', failed: '(translation failed)', locale: 'en-US' },
} as const;

/** Bilingual transcript as Markdown. */
export function toMarkdown(segs: TranscriptSegment[], meta: MeetingMeta, uiLang: UiLang = 'zh'): string {
  const T = MD_LABELS[uiLang];
  const started = new Date(meta.startedAt);
  const lines: string[] = [];
  lines.push(`# ${meta.title || T.title}`);
  lines.push('');
  lines.push(`- ${T.date}：${started.toLocaleString(T.locale)}${meta.endedAt ? ` – ${new Date(meta.endedAt).toLocaleTimeString(T.locale)}` : ''}`);
  lines.push(`- ${T.langs}：${meta.selfLang} ⇄ ${meta.remoteLang}`);
  if (meta.platform) lines.push(`- ${T.platform}：${meta.platform}`);
  lines.push('');
  lines.push(`## ${T.body}`);
  lines.push('');
  for (const s of segs) {
    const who = speakerLabel(s, uiLang);
    lines.push(`**[${formatClock(s.start)}] ${who}**  `);
    lines.push(`${s.srcText}  `);
    if (s.dstText) lines.push(`> ${s.dstText}`);
    else if (s.status === 'failed') lines.push(`> ${T.failed}`);
    lines.push('');
  }
  return lines.join('\n');
}

/** Plain text, one line per segment, for pasting into chats or emails. */
export function toPlainText(segs: TranscriptSegment[], uiLang: UiLang = 'zh'): string {
  return segs
    .map((s) => `[${formatClock(s.start)}] ${speakerLabel(s, uiLang)}：${s.srcText}${s.dstText ? `\n    ${s.dstText}` : ''}`)
    .join('\n');
}
