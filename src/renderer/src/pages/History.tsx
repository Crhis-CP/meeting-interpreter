import { useEffect, useState } from 'react';
import { baseOf } from '@core/lang/languages';
import { summaryToMarkdown, TEMPLATE_NAMES, type SummaryTemplate } from '@core/session/summary';
import type { MeetingDetail, MeetingListItem } from '@shared/ipc';
import { api, errMsg, useEvent } from '../api';
import { Markdown, SegmentView } from '../components/ui';

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function duration(a: string, b?: string): string {
  if (!b) return '';
  const m = Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000);
  return m >= 60 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分钟` : `${m} 分钟`;
}

export function HistoryPage({ openId, setOpenId }: { openId: string | null; setOpenId: (id: string | null) => void }) {
  const [items, setItems] = useState<MeetingListItem[] | null>(null);
  const [dir, setDir] = useState('');
  const load = () => void api.meetings.list().then(setItems);
  useEffect(() => {
    load();
    void api.app.info().then((i) => setDir(i.recordsDir));
  }, []);
  useEvent('meeting-state', (s) => {
    if (!s.active) load();
  });
  useEvent('summary-progress', (p) => {
    if (p.done === p.total) load();
  });

  if (openId) return <MeetingDetailView id={openId} onBack={() => { setOpenId(null); load(); }} />;

  return (
    <div>
      <h1 className="page-title">会议记录</h1>
      <p className="page-sub">
        每场会议的双语记录、中西文纪要、录音和录屏都保存在本机：<span className="kbd">{dir}</span>
      </p>
      <div className="card" style={{ padding: 0 }}>
        {items === null && <div className="empty">加载中…</div>}
        {items?.length === 0 && <div className="empty">还没有会议记录。开始一场会议同传或现场房间后，这里会出现记录。</div>}
        {items?.map((m) => (
          <div key={m.id} className="list-item" onClick={() => setOpenId(m.id)}>
            <div style={{ fontSize: 22 }}>{m.mode === 'room' ? '📱' : '🎧'}</div>
            <div className="grow">
              <div className="title">{m.title}</div>
              <div className="muted small">
                {fmtDate(m.startedAt)} {m.endedAt ? `· ${duration(m.startedAt, m.endedAt)}` : '· 未正常结束'} · {m.segments} 句
              </div>
            </div>
            <div className="row">
              {m.hasSummary && <span className="badge ok">纪要</span>}
              {m.hasAudio && <span className="badge">录音</span>}
              {m.hasScreen && <span className="badge">录屏</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function MeetingDetailView({ id, onBack }: { id: string; onBack: () => void }) {
  const [d, setD] = useState<MeetingDetail | null>(null);
  const [tab, setTab] = useState<'transcript' | 'summary-zh' | 'summary-foreign' | 'media' | 'files'>('transcript');
  const [template, setTemplate] = useState<SummaryTemplate>('general');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [title, setTitle] = useState('');

  const load = async () => {
    const detail = await api.meetings.get(id);
    setD(detail);
    if (detail) {
      setTitle(detail.meta.title);
      const u: Record<string, string> = {};
      for (const key of ['mix', 'screen', 'mic', 'meeting'] as const) {
        const rel = detail.meta.files[key];
        if (rel) u[key] = await api.meetings.fileUrl(id, rel);
      }
      setUrls(u);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  useEvent('summary-progress', (p) => {
    if (p.id !== id) return;
    setProgress(p.done < p.total ? `生成中 ${p.done}/${p.total}` : '');
    if (p.done === p.total) void load();
  });

  if (!d) return <div className="empty">加载中…</div>;
  const foreign: 'es' | 'en' = baseOf(d.meta.remoteLang) === 'en' ? 'en' : 'es';

  const summarize = async () => {
    setBusy(true);
    setError('');
    try {
      await api.meetings.summarize(id, template);
      await load();
      setTab('summary-zh');
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
      setProgress('');
    }
  };

  const saveTitle = async () => {
    if (title.trim() && title !== d.meta.title) await api.meetings.rename(id, title.trim());
  };

  const remove = async () => {
    if (!confirm('确定把这场会议的所有文件移到废纸篓吗？')) return;
    await api.meetings.remove(id);
    onBack();
  };

  return (
    <div>
      <div className="row between" style={{ marginBottom: 12 }}>
        <button className="btn ghost" onClick={onBack}>
          ← 返回列表
        </button>
        <div className="row">
          <button className="btn" onClick={() => void api.meetings.openFolder(id)}>
            打开文件夹
          </button>
          <button className="btn" onClick={remove}>
            删除
          </button>
        </div>
      </div>
      <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} onBlur={saveTitle} style={{ fontSize: 18, fontWeight: 700, width: '100%', marginBottom: 6 }} />
      <p className="page-sub">
        {fmtDate(d.meta.startedAt)} {d.meta.endedAt ? `· ${duration(d.meta.startedAt, d.meta.endedAt)}` : ''} · {d.segments.length} 句
      </p>
      <div className="tabs">
        {(
          [
            ['transcript', '双语记录'],
            ['summary-zh', '中文纪要'],
            ['summary-foreign', foreign === 'en' ? 'English minutes' : 'Acta en español'],
            ['media', '录音录屏'],
            ['files', '全部文件'],
          ] as const
        ).map(([k, label]) => (
          <button key={k} className={`tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'transcript' && (
        <div className="card">
          <div className="segments">
            {d.segments.length === 0 && <div className="empty">这场会议没有记录到发言。</div>}
            {d.segments.map((s) => (
              <SegmentView key={s.id} seg={s} />
            ))}
          </div>
        </div>
      )}

      {(tab === 'summary-zh' || tab === 'summary-foreign') && (
        <div className="card">
          <div className="row between" style={{ marginBottom: 12 }}>
            <div className="row">
              <select value={template} onChange={(e) => setTemplate(e.target.value as SummaryTemplate)}>
                {Object.entries(TEMPLATE_NAMES).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
              <button className="btn primary" onClick={summarize} disabled={busy || d.segments.length === 0}>
                {busy ? progress || '生成中…' : d.summary ? '重新生成纪要' : '生成纪要'}
              </button>
            </div>
            {d.summary && (
              <button className="btn sm" onClick={() => void navigator.clipboard.writeText(summaryToMarkdown(d.summary!, tab === 'summary-zh' ? 'zh' : foreign, d.meta))}>
                复制 Markdown
              </button>
            )}
          </div>
          {error && <div className="callout err">{error}</div>}
          {d.summary ? <Markdown text={summaryToMarkdown(d.summary, tab === 'summary-zh' ? 'zh' : foreign, d.meta)} /> : <div className="empty">还没有纪要。选择模板后点“生成纪要”（需要配置大模型）。</div>}
        </div>
      )}

      {tab === 'media' && (
        <div className="card">
          {!urls.mix && !urls.screen && !urls.mic && <div className="empty">这场会议没有录音或录屏。</div>}
          {urls.screen && (
            <div className="stack" style={{ marginBottom: 16 }}>
              <b>录屏</b>
              <video src={urls.screen} controls style={{ width: '100%', borderRadius: 10, background: '#000' }} />
              <span className="muted small">同目录下有双语字幕文件（.srt），可在播放器里加载。</span>
            </div>
          )}
          {urls.mix && (
            <div className="stack" style={{ marginBottom: 16 }}>
              <b>全程混音</b>
              <audio src={urls.mix} controls style={{ width: '100%' }} />
            </div>
          )}
          {urls.mic && (
            <div className="stack" style={{ marginBottom: 16 }}>
              <b>我方原声</b>
              <audio src={urls.mic} controls style={{ width: '100%' }} />
            </div>
          )}
          {urls.meeting && (
            <div className="stack">
              <b>会议原声</b>
              <audio src={urls.meeting} controls style={{ width: '100%' }} />
            </div>
          )}
        </div>
      )}

      {tab === 'files' && (
        <div className="card" style={{ padding: 0 }}>
          {d.files.map((f) => (
            <div key={f.rel} className="list-item" onClick={() => void api.meetings.openFile(id, f.rel)}>
              <div className="grow">
                <div>{f.rel}</div>
              </div>
              <span className="muted small">{f.size > 1048576 ? `${(f.size / 1048576).toFixed(1)} MB` : `${Math.ceil(f.size / 1024)} KB`}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
