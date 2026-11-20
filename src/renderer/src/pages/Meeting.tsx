import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppSettings } from '@core/config/schema';
import { preset } from '@core/config/presets';
import { lang } from '@core/lang/languages';
import type { TranscriptSegment } from '@core/types';
import type { MeetingState, ScreenSource } from '@shared/ipc';
import { api, errMsg, useEvent } from '../api';
import { Level, SegmentView, StateBadge, Toggle } from '../components/ui';
import { MEETING_APPS } from '../content/guides';
import type { Page } from '../App';

function elapsed(ms: number | null): string {
  if (!ms) return '00:00';
  const s = Math.floor((Date.now() - ms) / 1000);
  const p = (n: number) => n.toString().padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}` : `${p(Math.floor(s / 60))}:${p(s % 60)}`;
}

export function useLiveSegments(active: boolean): TranscriptSegment[] {
  const [segs, setSegs] = useState<Map<string, TranscriptSegment>>(new Map());
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current) setSegs(new Map());
    wasActive.current = active;
  }, [active]);
  useEvent('segment', (s) =>
    setSegs((m) => {
      const n = new Map(m);
      n.set(s.id, s);
      return n;
    }),
  );
  return useMemo(() => [...segs.values()].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id)), [segs]);
}

export function MeetingPage({ settings, state, go }: { settings: AppSettings; state: MeetingState | null; go: (p: Page) => void }) {
  const [title, setTitle] = useState('');
  const [platform, setPlatform] = useState(settings.platform || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [levels, setLevels] = useState({ mic: -100, meeting: -100 });
  const [partials, setPartials] = useState<Record<string, string>>({});
  const [running, setRunning] = useState<string[]>([]);
  const [sources, setSources] = useState<ScreenSource[] | null>(null);
  const [lastMeeting, setLastMeeting] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const segs = useLiveSegments(!!state?.active && state.mode === 'meeting');
  const listRef = useRef<HTMLDivElement>(null);

  useEvent('levels', setLevels);
  useEvent('partial', (p) => setPartials((x) => ({ ...x, [p.dir]: p.text })));

  useEffect(() => {
    void api.app.detectMeetingApps().then((apps) => {
      setRunning(apps);
      if (!platform && apps[0]) setPlatform(apps[0]);
    });
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const el = listRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
  }, [segs]);

  const active = !!state?.active && state.mode === 'meeting';
  const roomActive = !!state?.active && state.mode === 'room';
  const p = preset(settings.preset);
  const ptt = settings.interpretation.outMode === 'push-to-talk';
  const short = (code: string) => (lang(code).base === 'zh' ? '中文' : '西语');
  const selfName = short(settings.languages.self);
  const remoteName = short(settings.languages.remote);

  const checks: { ok: boolean; text: string; fix?: () => void }[] = [
    { ok: !!settings.devices.virtualMic, text: settings.devices.virtualMic ? '已选择虚拟麦克风（对方能听到西语译音）' : '未选择虚拟麦克风：对方将听不到译音', fix: () => go('settings') },
    {
      ok: settings.devices.meetingSource !== 'none' && (settings.devices.meetingSource === 'loopback' || !!settings.devices.meetingDevice),
      text:
        settings.devices.meetingSource === 'loopback'
          ? '会议声音：系统声音（无需额外驱动）'
          : settings.devices.meetingSource === 'device'
            ? settings.devices.meetingDevice
              ? '会议声音：虚拟扬声器'
              : '会议声音：未选择设备'
            : '不翻译会议声音',
      fix: () => go('settings'),
    },
    { ok: true, text: `服务：${p?.name ?? settings.preset}` },
  ];

  const start = async () => {
    setBusy(true);
    setError('');
    try {
      await api.meeting.start({ title: title.trim() || undefined, platform: platform || undefined, mode: 'meeting' });
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    setBusy(true);
    try {
      const meta = await api.meeting.stop();
      if (meta) setLastMeeting(meta.id);
    } finally {
      setBusy(false);
    }
  };

  const pickScreen = async () => setSources(await api.app.screenSources());

  return (
    <div>
      <div className="row between" style={{ marginBottom: 16 }}>
        <div>
          <h1 className="page-title">会议同传</h1>
          <p className="page-sub" style={{ margin: 0 }}>
            在 Teams、飞书、腾讯会议等任何会议软件里：你说{selfName}，对方听到{remoteName}；对方说{remoteName}，你听到{selfName}。
          </p>
        </div>
        {active ? (
          <div className="row">
            <span className="badge live">进行中 {elapsed(state?.startedAtMs ?? null)}</span>
            <button className="btn danger big" onClick={stop} disabled={busy}>
              结束会议
            </button>
          </div>
        ) : (
          <button className="btn primary big" onClick={start} disabled={busy || roomActive}>
            {busy ? '正在开始…' : '开始同传'}
          </button>
        )}
      </div>

      {roomActive && <div className="callout info" style={{ marginBottom: 16 }}>现场房间正在进行中，请先在“现场房间”页结束。</div>}
      {error && <div className="callout err" style={{ marginBottom: 16 }}>{error}</div>}
      {state?.warnings?.map((w) => (
        <div key={w} className="callout" style={{ marginBottom: 10 }}>
          {w}
          {window.platform === 'darwin' && /系统声音|录屏/.test(w) && (
            <button
              className="btn sm"
              style={{ marginLeft: 8 }}
              onClick={() => void api.app.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')}
            >
              打开“录屏与系统录音”设置
            </button>
          )}
          {window.platform === 'darwin' && /麦克风/.test(w) && (
            <button
              className="btn sm"
              style={{ marginLeft: 8 }}
              onClick={() => void api.app.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone')}
            >
              打开“麦克风”权限设置
            </button>
          )}
        </div>
      ))}

      {!active && (
        <div className="grid2">
          <div className="card">
            <h3>会议信息</h3>
            <div className="stack">
              <input type="text" placeholder="会议名称（可选，例如：与墨西哥客户的价格谈判）" value={title} onChange={(e) => setTitle(e.target.value)} />
              <select value={platform} onChange={(e) => setPlatform(e.target.value)}>
                <option value="">会议软件（可选）</option>
                {MEETING_APPS.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {running.includes(a.id) ? '（正在运行）' : ''}
                  </option>
                ))}
              </select>
              {platform && (
                <div className="callout info">
                  <b>{MEETING_APPS.find((a) => a.id === platform)?.name}</b>：{MEETING_APPS.find((a) => a.id === platform)?.steps[1]}
                </div>
              )}
            </div>
          </div>
          <div className="card">
            <h3>开始前检查</h3>
            <div className="stack">
              {checks.map((c) => (
                <div key={c.text} className="row">
                  <span>{c.ok ? '✅' : '⚠️'}</span>
                  <span style={{ flex: 1 }}>{c.text}</span>
                  {!c.ok && c.fix && (
                    <button className="btn sm" onClick={c.fix}>
                      去设置
                    </button>
                  )}
                </div>
              ))}
              <Toggle checked={settings.recording.audio} onChange={(v) => void api.meeting.setRecording({ audio: v })} label="录音（保存全程混音）" />
              <div className="row">
                <Toggle checked={settings.recording.screen} onChange={(v) => void api.meeting.setRecording({ screen: v })} label="录屏" />
                {settings.recording.screen && (
                  <button className="btn sm" onClick={pickScreen}>
                    {settings.recording.screenSourceId ? '更换录制画面' : '选择录制画面'}
                  </button>
                )}
              </div>
              {(settings.recording.audio || settings.recording.screen) && <span className="muted small">录音录屏前请征得参会者同意。</span>}
            </div>
          </div>
        </div>
      )}

      {sources && (
        <div className="card">
          <div className="row between">
            <h3>选择要录制的屏幕或窗口</h3>
            <button className="btn sm" onClick={() => setSources(null)}>
              关闭
            </button>
          </div>
          <div className="grid3">
            {sources.map((s) => (
              <button
                key={s.id}
                className={`preset ${settings.recording.screenSourceId === s.id ? 'active' : ''}`}
                onClick={() => {
                  void api.meeting.setRecording({ screenSourceId: s.id });
                  setSources(null);
                }}
              >
                <img src={s.thumbnail} style={{ width: '100%', borderRadius: 6 }} />
                <p>{s.name}</p>
              </button>
            ))}
          </div>
        </div>
      )}

      {active && state && (
        <div className="grid2">
          <div className={`dir-card ${state.out.enabled ? '' : 'off'}`}>
            <div className="row between" style={{ flexWrap: 'nowrap' }}>
              <div className="title">
                我说{selfName} → 对方听{remoteName} <StateBadge state={state.out.state} message={state.out.message} />
              </div>
              <Toggle checked={state.out.enabled} onChange={(v) => void api.meeting.setOut(v)} />
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <span className="muted small">麦克风</span>
              <Level db={levels.mic} />
              {state.out.backlog > 1 && <span className="badge warn">译音排队 {state.out.backlog.toFixed(0)} 秒</span>}
              {state.out.backlog > 8 && (
                <button className="btn sm" onClick={() => void api.meeting.skip('out')}>
                  跳到最新
                </button>
              )}
            </div>
            <div className="partial">{partials.out}</div>
            <div className="row" style={{ marginTop: 8 }}>
              {ptt && (
                <button
                  className={`btn ${state.out.gate ? 'danger' : 'primary'}`}
                  onMouseDown={() => void api.meeting.pushToTalk(true)}
                  onMouseUp={() => void api.meeting.pushToTalk(false)}
                  onMouseLeave={() => state.out.gate && void api.meeting.pushToTalk(false)}
                >
                  {state.out.gate ? '正在说…松开结束' : '按住说话'}
                </button>
              )}
              <Toggle checked={state.out.passthrough} onChange={(v) => void api.meeting.setPassthrough(v)} label="原声直通（我直接说西语时打开）" />
            </div>
            {state.out.message && state.out.state === 'error' && <div className="callout err" style={{ marginTop: 8 }}>{state.out.message}</div>}
          </div>
          <div className={`dir-card ${state.in.enabled ? '' : 'off'}`}>
            <div className="row between" style={{ flexWrap: 'nowrap' }}>
              <div className="title">
                对方说{remoteName} → 我听{selfName} <StateBadge state={state.in.state} message={state.in.message} />
              </div>
              <Toggle checked={state.in.enabled} onChange={(v) => void api.meeting.setIn(v)} />
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <span className="muted small">会议声音</span>
              <Level db={levels.meeting} />
              {state.in.backlog > 1 && <span className="badge warn">译音排队 {state.in.backlog.toFixed(0)} 秒</span>}
              {state.in.backlog > 8 && (
                <button className="btn sm" onClick={() => void api.meeting.skip('in')}>
                  跳到最新
                </button>
              )}
            </div>
            <div className="partial">{partials.in}</div>
            <div className="row" style={{ marginTop: 8 }}>
              <Toggle checked={state.in.speak} onChange={(v) => void api.meeting.setInSpeak(v)} label="播放中文译音（关掉则只看字幕）" />
              <button className="btn sm" onClick={() => void api.app.showWindow('overlay')}>
                显示字幕窗
              </button>
            </div>
            {state.in.message && state.in.state === 'error' && <div className="callout err" style={{ marginTop: 8 }}>{state.in.message}</div>}
          </div>
        </div>
      )}

      {lastMeeting && !active && (
        <div className="callout info" style={{ margin: '12px 0' }}>
          会议已结束，记录已保存。{settings.summary.autoAtEnd ? '纪要正在后台生成。' : ''}
          <button className="btn sm" style={{ marginLeft: 8 }} onClick={() => go('history')}>
            查看会议记录
          </button>
        </div>
      )}

      <div className="card" style={{ marginTop: 16 }}>
        <div className="row between">
          <h3>实时双语记录</h3>
          {active && state?.recording && (
            <div className="row">
              {state.recording.audio && <span className="badge live">录音</span>}
              {state.recording.screen && !state.recording.screenError && <span className="badge live">录屏</span>}
            </div>
          )}
        </div>
        <div ref={listRef} className="segments" style={{ maxHeight: 460, overflow: 'auto', paddingRight: 4 }}>
          {segs.length === 0 && <div className="empty">{active ? '开始说话吧，双语记录会出现在这里。' : '开始同传后，双语逐句记录会出现在这里。'}</div>}
          {segs.map((s) => (
            <SegmentView key={s.id} seg={s} />
          ))}
        </div>
      </div>
    </div>
  );
}
