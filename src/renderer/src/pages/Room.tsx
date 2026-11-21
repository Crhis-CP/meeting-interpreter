import { useEffect, useRef, useState } from 'react';
import type { AppSettings } from '@core/config/schema';
import { lang } from '@core/lang/languages';
import type { Page } from '../App';
import type { MeetingState, RoomState } from '@shared/ipc';
import { api, errMsg, useEvent } from '../api';
import { Level, SegmentView, StateBadge, Toggle } from '../components/ui';
import { useLiveSegments } from './Meeting';

export function RoomPage({ settings, state, go }: { settings: AppSettings; state: MeetingState | null; go: (p: Page) => void }) {
  const [room, setRoom] = useState<RoomState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [levels, setLevels] = useState({ mic: -100, meeting: -100 });
  const [selected, setSelected] = useState<string | null>(null);
  const segs = useLiveSegments(!!state?.active && state.mode === 'room');
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void api.room.state().then(setRoom);
  }, []);
  useEvent('room', setRoom);
  useEvent('levels', setLevels);
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [segs]);

  const meetingActive = !!state?.active && state.mode === 'meeting';
  const start = async () => {
    setBusy(true);
    setError('');
    try {
      setRoom(await api.room.start());
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    setBusy(true);
    try {
      await api.room.stop();
      setRoom(await api.room.state());
    } finally {
      setBusy(false);
    }
  };

  const urls = room ? [...room.urls, ...(room.publicUrl ? [room.publicUrl] : [])] : [];
  const shown = selected && urls.includes(selected) ? selected : (room?.publicUrl ?? urls[0]);
  const remote = lang(settings.languages.remote);

  return (
    <div>
      <header className="row between" style={{ marginBottom: 16 }}>
        <h1 className="page-title">现场房间</h1>
        {room?.active ? (
          <button data-test="flow" className="btn danger big" onClick={stop} disabled={busy}>
            关闭房间
          </button>
        ) : meetingActive ? (
          <button className="btn big" onClick={() => go('meeting')}>
            去会议同传
          </button>
        ) : (
          <button data-test="flow" className="btn primary big" onClick={start} disabled={busy}>
            {busy ? '正在开启…' : '开启房间'}
          </button>
        )}
      </header>
      {error && <div className="callout err" role="alert" style={{ marginBottom: 16 }}>{error}</div>}

      {room && !room.active && !meetingActive && (
        <div className="card qr-placeholder" aria-hidden="true">
          <span className="qr-box">▦</span>
          <span>手机扫码加入</span>
        </div>
      )}

      {room?.active && (
        <div className="grid2">
          <div className="card" style={{ textAlign: 'center' }}>
            <h3>扫码加入 · {remote.base === 'en' ? 'Scan to join' : 'Escanea para unirte'}</h3>
            {shown && room.qr[shown] && <img className="qr" src={room.qr[shown]} alt={`加入房间的二维码：${shown}`} style={{ width: 240, height: 240 }} />}
            <div className="url" style={{ marginTop: 10 }}>{shown}</div>
            {shown && shown !== room.publicUrl && <p className="muted small">手机提示“连接不安全”时，点“继续访问”</p>}
            {urls.length > 1 && (
              <div className="row" style={{ justifyContent: 'center', marginTop: 10 }}>
                {urls.map((u) => (
                  <button key={u} className={`btn sm ${u === shown ? 'primary' : ''}`} onClick={() => setSelected(u)}>
                    {u === room.publicUrl ? '公网链接' : `局域网 ${new URL(u).hostname}`}
                  </button>
                ))}
              </div>
            )}
            <div className="row" style={{ justifyContent: 'center', marginTop: 14 }}>
              <Toggle checked={room.publicStatus === 'on' || room.publicStatus === 'starting'} onChange={(v) => void api.room.setPublic(v).then(setRoom)} label="公网链接" />
            </div>
            {room.publicStatus === 'starting' && <p className="muted small" role="status">正在创建…</p>}
            {room.publicStatus === 'error' && <div className="callout err" role="alert">{room.publicError}</div>}
          </div>
          <div className="card">
            <h3>参会者（{(room.participants.length ?? 0) + 1}）</h3>
            <div className="stack">
              <div className="row">
                <span>🖥️ 主持人（本机）</span>
                <span className="badge">{lang(settings.languages.self).nameNative}</span>
                {state && <StateBadge state={state.out.state} message={state.out.message} />}
                <Level db={levels.mic} label="主持人麦克风音量" />
              </div>
              {room.participants.map((p) => (
                <div key={p.id} className="row">
                  <span>📱 {p.name}</span>
                  <span className="badge">{lang(p.lang).nameNative}</span>
                  {p.talking && <span className="badge live">正在说</span>}
                </div>
              ))}
              {room.participants.length === 0 && <p className="muted" role="status">等待加入…</p>}
            </div>
            {state && (
              <div className="row" style={{ marginTop: 14 }}>
                <Toggle checked={state.out.enabled} onChange={(v) => void api.meeting.setOut(v)} label="主持人麦克风" />
              </div>
            )}
          </div>
        </div>
      )}

      {(room?.active || segs.length > 0) && (
        <section className="card" aria-labelledby="room-live">
          <h3 id="room-live">双语记录</h3>
          <div ref={listRef} className="segments" style={{ maxHeight: 420, overflow: 'auto' }}>
            {segs.map((s) => (
              <SegmentView key={s.id} seg={s} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
