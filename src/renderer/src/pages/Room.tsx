import { useEffect, useRef, useState } from 'react';
import type { AppSettings } from '@core/config/schema';
import { lang } from '@core/lang/languages';
import type { MeetingState, RoomState } from '@shared/ipc';
import { api, errMsg, useEvent } from '../api';
import { Level, SegmentView, StateBadge, Toggle } from '../components/ui';
import { useLiveSegments } from './Meeting';

export function RoomPage({ settings, state }: { settings: AppSettings; state: MeetingState | null }) {
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
      <div className="row between" style={{ marginBottom: 16 }}>
        <div>
          <h1 className="page-title">现场房间</h1>
          <p className="page-sub" style={{ margin: 0 }}>
            面对面开会或出差拜访时用：大家用手机扫码加入，各自选“中文”或“{remote.nameNative}”，戴上耳机，就能听到对方说话的同声传译。手机不用装任何 App。
          </p>
        </div>
        {room?.active ? (
          <button className="btn danger big" onClick={stop} disabled={busy}>
            关闭房间
          </button>
        ) : (
          <button className="btn primary big" onClick={start} disabled={busy || meetingActive}>
            {busy ? '正在开启…' : '开启房间'}
          </button>
        )}
      </div>
      {meetingActive && <div className="callout info" style={{ marginBottom: 16 }}>会议同传正在进行中，请先结束后再开房间。</div>}
      {error && <div className="callout err" style={{ marginBottom: 16 }}>{error}</div>}

      {!room?.active && (
        <div className="card">
          <h3>怎么用</h3>
          <ol className="steps">
            <li>电脑和大家的手机连同一个 Wi-Fi（或用手机热点）。如果有人不在现场（例如在视频会议里），打开“公网链接”。</li>
            <li>点“开启房间”，屏幕上会出现二维码。</li>
            <li>每个人用手机相机扫码，在网页里填名字、选语言，戴上耳机。</li>
            <li>说话时按住手机上的大按钮（或切到“持续说话”），其他语言的人就会在耳机里听到翻译，同时看到双语字幕。</li>
            <li>电脑这边也可以直接说话（用电脑麦克风，算“主持人”），说中文时西语手机会听到译音，西语的发言也会在电脑上播放中文译音。</li>
            <li>关闭房间后，双语记录、纪要和录音和普通会议一样保存在“会议记录”里。</li>
          </ol>
          <div className="callout">
            手机第一次打开局域网链接时会提示“连接不安全/证书无效”：这是因为房间运行在你自己的电脑上。iPhone 点“显示详细信息 → 访问此网站”；安卓 Chrome 点“高级 → 继续前往”。使用“公网链接”不会有这个提示。
          </div>
        </div>
      )}

      {room?.active && (
        <div className="grid2">
          <div className="card" style={{ textAlign: 'center' }}>
            <h3>扫码加入 · Escanea para unirte</h3>
            {shown && room.qr[shown] && <img className="qr" src={room.qr[shown]} style={{ width: 240, height: 240 }} />}
            <div className="url" style={{ marginTop: 10 }}>{shown}</div>
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
              <Toggle
                checked={room.publicStatus === 'on' || room.publicStatus === 'starting'}
                onChange={(v) => void api.room.setPublic(v).then(setRoom)}
                label="公网链接（让不在同一 Wi-Fi 的人也能加入）"
              />
            </div>
            {room.publicStatus === 'starting' && <p className="muted small">正在创建公网链接（首次需要下载约 30MB 的 cloudflared）…</p>}
            {room.publicStatus === 'error' && <div className="callout err">{room.publicError}</div>}
          </div>
          <div className="card">
            <h3>参会者（{(room.participants.length ?? 0) + 1}）</h3>
            <div className="stack">
              <div className="row">
                <span>🖥️ 主持人（本机）</span>
                <span className="badge">{lang(settings.languages.self).nameNative}</span>
                {state && <StateBadge state={state.out.state} message={state.out.message} />}
                <Level db={levels.mic} />
              </div>
              {room.participants.map((p) => (
                <div key={p.id} className="row">
                  <span>📱 {p.name}</span>
                  <span className="badge">{lang(p.lang).nameNative}</span>
                  {p.talking && <span className="badge live">正在说</span>}
                </div>
              ))}
              {room.participants.length === 0 && <p className="muted">等待手机加入…</p>}
            </div>
            {state && (
              <div className="row" style={{ marginTop: 14 }}>
                <Toggle checked={state.out.enabled} onChange={(v) => void api.meeting.setOut(v)} label="主持人麦克风参与翻译" />
              </div>
            )}
          </div>
        </div>
      )}

      {(room?.active || segs.length > 0) && (
        <div className="card">
          <h3>实时双语记录</h3>
          <div ref={listRef} className="segments" style={{ maxHeight: 420, overflow: 'auto' }}>
            {segs.length === 0 && <div className="empty">还没有人说话。</div>}
            {segs.map((s) => (
              <SegmentView key={s.id} seg={s} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
