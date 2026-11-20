import type { ReactNode } from 'react';
import type { TranscriptSegment } from '@core/types';

export function Toggle(props: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean }) {
  return (
    <label className="toggle" style={props.disabled ? { opacity: 0.5, pointerEvents: 'none' } : undefined}>
      <input type="checkbox" checked={props.checked} onChange={(e) => props.onChange(e.target.checked)} />
      <span className="track" />
      {props.label && <span>{props.label}</span>}
    </label>
  );
}

export function Level({ db }: { db: number }) {
  const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  return (
    <div className="level" title={`${db} dB`}>
      <div style={{ width: `${pct}%` }} />
    </div>
  );
}

export function StateBadge({ state, message }: { state: string; message?: string }) {
  const map: Record<string, [string, string]> = {
    idle: ['', '待机'],
    connecting: ['warn', '连接中…'],
    listening: ['ok', '正在听'],
    reconnecting: ['warn', '重连中…'],
    error: ['err', '出错'],
    stopped: ['', '已停止'],
  };
  const [cls, text] = map[state] ?? ['', state];
  return (
    <span className={`badge ${cls}`} title={message}>
      {text}
    </span>
  );
}

function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const p = (n: number) => n.toString().padStart(2, '0');
  return h ? `${h}:${p(m % 60)}:${p(s % 60)}` : `${p(m)}:${p(s % 60)}`;
}

export function speakerName(seg: TranscriptSegment): string {
  if (seg.speaker === 'me') return '我方';
  if (seg.speaker === 'them') return '对方';
  return seg.speaker;
}

export function SegmentView({ seg, onClick }: { seg: TranscriptSegment; onClick?: () => void }) {
  const mine = seg.speaker === 'me' || seg.srcLang.startsWith('zh');
  const name = speakerName(seg);
  return (
    <div className={`seg ${mine ? 'me' : ''} ${seg.status}`} onClick={onClick} id={`seg-${seg.id}`}>
      <div className="avatar">{name.slice(0, 1)}</div>
      <div className="bubble">
        <div className="src">{seg.srcText}</div>
        <div className={seg.draft ? 'dst draft' : 'dst'}>
          {seg.status === 'translating' && <span className="muted">翻译中…</span>}
          {seg.status === 'failed' && <span>翻译失败{seg.error ? `：${seg.error}` : ''}</span>}
          {(seg.status === 'done' || seg.status === 'skipped') && seg.dstText}
        </div>
        <div className="meta">
          {name} · {clock(seg.start)}
          {seg.status === 'skipped' && ' · 已跳过语音'}
          {seg.edits?.length ? ` · 术语纠正 ${seg.edits.map((e) => `${e.from}→${e.to}`).join('，')}` : ''}
        </div>
      </div>
    </div>
  );
}

export function Field(props: { label: ReactNode; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="field">
      <span>{props.label}</span>
      {props.children}
      {props.hint && <span className="muted small">{props.hint}</span>}
    </label>
  );
}

export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        void window.api.app.openExternal(href);
      }}
    >
      {children}
    </a>
  );
}

/** Minimal Markdown renderer for our own summaries (headings, lists, tables, bold). */
export function Markdown({ text }: { text: string }) {
  const lines = text.split('\n');
  const out: ReactNode[] = [];
  let list: ReactNode[] = [];
  let table: string[][] = [];
  const flush = () => {
    if (list.length) out.push(<ul key={`ul${out.length}`}>{list}</ul>);
    list = [];
    if (table.length) {
      const [head, ...rows] = table;
      out.push(
        <table key={`t${out.length}`}>
          <thead>
            <tr>{head!.map((c, i) => <th key={i}>{c}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>
            ))}
          </tbody>
        </table>,
      );
    }
    table = [];
  };
  const inline = (s: string) => s.replace(/<sub>.*?<\/sub>/g, '').replace(/\*\*(.+?)\*\*/g, '$1');
  lines.forEach((l, i) => {
    if (/^\|/.test(l)) {
      if (/^\|[-| ]+\|$/.test(l)) return;
      table.push(l.split('|').slice(1, -1).map((c) => c.trim()));
      return;
    }
    if (/^- /.test(l)) {
      list.push(<li key={i}>{inline(l.slice(2).replace(/^\[ \] /, '☐ '))}</li>);
      return;
    }
    flush();
    if (/^### /.test(l)) out.push(<h3 key={i}>{inline(l.slice(4))}</h3>);
    else if (/^## /.test(l)) out.push(<h2 key={i}>{inline(l.slice(3))}</h2>);
    else if (/^# /.test(l)) out.push(<h1 key={i}>{inline(l.slice(2))}</h1>);
    else if (l.trim()) out.push(<p key={i}>{inline(l)}</p>);
  });
  flush();
  return <div className="md">{out}</div>;
}
