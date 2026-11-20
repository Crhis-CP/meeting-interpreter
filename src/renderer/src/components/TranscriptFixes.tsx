import { useState } from 'react';
import type { TranscriptSegment } from '@core/types';
import type { MeetingDetail } from '@shared/ipc';
import { api, errMsg } from '../api';
import { SegmentView } from './ui';

/** One sentence of a saved meeting; “改正” fixes what was recognised, re-translates it and teaches the profile. */
export function EditableSegment({ meetingId, seg, onSaved }: { meetingId: string; seg: TranscriptSegment; onSaved: (s: TranscriptSegment) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(seg.srcText);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const save = async () => {
    setBusy(true);
    setNote('');
    try {
      const r = await api.meetings.editSegment(meetingId, seg.id, text);
      onSaved(r.segment);
      setEditing(false);
      if (r.learned.length) setNote(`已记住：${r.learned.map((l) => `“${l.heard}”→“${l.meant}”`).join('，')}，以后会自动改对`);
    } catch (err) {
      setNote(errMsg(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="editable-seg">
      <SegmentView seg={seg} />
      {editing ? (
        <div className="row" style={{ margin: '0 0 10px 44px' }}>
          <input type="text" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void save()} style={{ flex: 1 }} autoFocus aria-label="改正识别的文字" />
          <button className="btn primary sm" disabled={busy || !text.trim()} onClick={() => void save()}>{busy ? '保存中…' : '保存并重新翻译'}</button>
          <button className="btn ghost sm" onClick={() => { setEditing(false); setText(seg.srcText); }}>取消</button>
        </div>
      ) : (
        <button className="btn ghost sm fix-btn" title="识别错了？点这里改正，软件会记住" onClick={() => { setText(seg.srcText); setEditing(true); }}>✎ 改正</button>
      )}
      {note && <div className="muted small" style={{ margin: '0 0 8px 44px' }}>{note}</div>}
    </div>
  );
}

/** “可能听错的地方”: the after-meeting review, to accept or ignore one by one (or all at once). */
export function ReviewPanel({ d, onChange }: { d: MeetingDetail; onChange: (d: MeetingDetail) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const open = d.review?.suggestions.filter((s) => !s.decision) ?? [];
  const decide = async (segId: string, heard: string, accept: boolean) => {
    const next = await api.meetings.decide(d.meta.id, segId, heard, accept);
    if (next) onChange(next);
  };
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };
  const mine = d.segments.some((s) => s.dir === 'out');
  if (!mine) return null;
  return (
    <div className="callout info" style={{ marginBottom: 12 }} data-testid="review-panel">
      {!d.review ? (
        <div className="row between">
          <span>想让识别越用越准？让大模型找出这场会议里我说的话可能听错的地方，确认后以后会自动改对。</span>
          <button className="btn sm" disabled={busy} onClick={() => void run(async () => { await api.meetings.review(d.meta.id); const n = await api.meetings.get(d.meta.id); if (n) onChange(n); })}>
            {busy ? '检查中…' : '找出可能听错的地方'}
          </button>
        </div>
      ) : open.length ? (
        <div className="stack">
          <div className="row between">
            <b>可能听错了 {open.length} 处：确认后会改正记录，并记住以后自动改对</b>
            <button className="btn primary sm" disabled={busy} onClick={() => void run(async () => { for (const s of open) await decide(s.segId, s.heard, true); })}>全部采用</button>
          </div>
          {open.map((s) => (
            <div key={`${s.segId}:${s.heard}`} className="row between">
              <span>
                “{s.heard}” → “<b>{s.meant}</b>”{s.reason ? <span className="muted small">（{s.reason}）</span> : null}
                <a href={`#seg-${s.segId}`} className="small" style={{ marginLeft: 6 }} onClick={(e) => { e.preventDefault(); document.getElementById(`seg-${s.segId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }}>看原句</a>
              </span>
              <span className="row">
                <button className="btn sm" disabled={busy} onClick={() => void run(() => decide(s.segId, s.heard, true))}>采用</button>
                <button className="btn ghost sm" disabled={busy} onClick={() => void run(() => decide(s.segId, s.heard, false))}>忽略</button>
              </span>
            </div>
          ))}
        </div>
      ) : (
        <span className="muted">会后检查完成{d.review.suggestions.length ? '，可能听错的地方都处理好了' : '：没有发现听错的地方'}。识别错了也可以点每句话旁边的“✎ 改正”。</span>
      )}
      {error && <div className="callout err" style={{ marginTop: 8 }}>{error}</div>}
    </div>
  );
}
