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
          <button data-test="network" className="btn primary sm" disabled={busy || !text.trim()} onClick={() => void save()}>{busy ? '保存中…' : '保存并重新翻译'}</button>
          <button className="btn ghost sm" onClick={() => { setEditing(false); setText(seg.srcText); }}>取消</button>
        </div>
      ) : (
        <button className="btn ghost sm fix-btn" onClick={() => { setText(seg.srcText); setEditing(true); }}>✎ 改正</button>
      )}
      {note && <div className="muted small" role="status" style={{ margin: '0 0 8px 44px' }}>{note}</div>}
    </div>
  );
}

/**
 * What the after-meeting review learned by itself: corrected mis-hearings (each can be undone) and
 * new terms added to the automatic glossary (each can be removed).
 */
export function ReviewPanel({ d, onChange }: { d: MeetingDetail; onChange: (d: MeetingDetail) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (fn: () => Promise<MeetingDetail | null | void>) => {
    setBusy(true);
    setError('');
    try {
      const next = await fn();
      if (next) onChange(next);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };
  const fixes = d.review?.suggestions.filter((s) => s.decision === 'accepted' || s.decision === 'undone' || !s.decision) ?? [];
  const terms = d.review?.terms ?? [];
  const jump = (segId: string) => document.getElementById(`seg-${segId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  if (!d.review)
    return (
      <div className="row" style={{ justifyContent: 'flex-end', marginBottom: 8 }} data-testid="review-panel">
        <button data-test="network" className="btn sm" disabled={busy} onClick={() => void run(async () => (await api.meetings.review(d.meta.id), api.meetings.get(d.meta.id)))}>
          {busy ? '学习中…' : 'AI 自动学习'}
        </button>
        {error && <div className="callout err" role="alert">{error}</div>}
      </div>
    );
  return (
    <section className="callout info" style={{ marginBottom: 12 }} aria-label="会后自动学习" data-testid="review-panel">
      {(
        <div className="stack">
          <b>会后自动学习：{fixes.length || terms.length ? `改正 ${fixes.filter((f) => f.decision !== 'undone').length} 处听错的词，学会 ${terms.length} 个新术语` : '没有发现听错的词，也没有新术语'}</b>
          {fixes.map((s) => (
            <div key={`${s.segId}:${s.heard}`} className="row between">
              <span>
                {s.decision === 'undone' ? <s>“{s.heard}” → “{s.meant}”</s> : <>“{s.heard}” → “<b>{s.meant}</b>”</>}
                <a href={`#seg-${s.segId}`} className="small" style={{ marginLeft: 6 }} onClick={(e) => (e.preventDefault(), jump(s.segId))}>看原句</a>
              </span>
              {s.decision === 'undone' ? (
                <span className="muted small">已撤销</span>
              ) : s.decision === 'accepted' ? (
                <button className="btn ghost sm" disabled={busy} onClick={() => void run(() => api.meetings.undo(d.meta.id, s.segId, s.heard))}>撤销</button>
              ) : (
                <span className="row">
                  <button className="btn sm" disabled={busy} onClick={() => void run(() => api.meetings.decide(d.meta.id, s.segId, s.heard, true))}>采用</button>
                  <button className="btn ghost sm" disabled={busy} onClick={() => void run(() => api.meetings.decide(d.meta.id, s.segId, s.heard, false))}>忽略</button>
                </span>
              )}
            </div>
          ))}
          {terms.map((t) => (
            <div key={t.zh} className="row between">
              <span>{t.zh} = <b>{t.foreign}</b> <span className="badge">新术语</span></span>
              <button className="btn ghost sm" disabled={busy} onClick={() => void run(() => api.meetings.forgetTerm(d.meta.id, t.zh))}>移除</button>
            </div>
          ))}
        </div>
      )}
      {error && <div className="callout err" role="alert" style={{ marginTop: 8 }}>{error}</div>}
    </section>
  );
}
