import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppSettings } from '@core/config/schema';
import { lang, REMOTE_CHOICES, withRemoteBase } from '@core/lang/languages';
import type { TranscriptSegment } from '@core/types';
import type { MeetingState, ReadinessItem } from '@shared/ipc';
import { api, errMsg, useEvent, useLlmReady } from '../api';
import { FlashButton, Field, Level, SegmentView, StateBadge, Toggle } from '../components/ui';
import { ScreenPicker } from '../components/ScreenPicker';
import { DeviceCheck } from '../components/DeviceCheck';
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
  // Coming back to the page mid-meeting: start from what was said so far (newer live updates win).
  useEffect(() => {
    void api.meeting.segments().then((list) =>
      setSegs((m) => {
        const n = new Map(list.map((x) => [x.id, x] as const));
        for (const [id, x] of m) n.set(id, x);
        return n;
      }),
    );
  }, []);
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [levels, setLevels] = useState({ mic: -100, meeting: -100 });
  const [partials, setPartials] = useState<Record<string, string>>({});
  const [lastMeeting, setLastMeeting] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const segs = useLiveSegments(!!state?.active && state.mode === 'meeting');
  const llmReady = useLlmReady(settings);
  const listRef = useRef<HTMLDivElement>(null);

  useEvent('levels', setLevels);
  useEvent('partial', (p) => setPartials((x) => ({ ...x, [p.dir]: p.text })));

  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const el = listRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
  }, [segs]);

  const active = !!state?.active && state.mode === 'meeting';
  const roomActive = !!state?.active && state.mode === 'room';
  const ptt = settings.interpretation.outMode === 'push-to-talk';
  const short = (code: string) => ({ zh: '中文', es: '西语', en: '英语' })[lang(code).base];
  const selfName = short(settings.languages.self);
  const remoteName = short(settings.languages.remote);

  // Only what needs attention, each with its fix.
  /** Opens settings on the tab that fixes something. */
  const openSettings = (tab: 'providers' | 'devices') => {
    sessionStorage.setItem('settings-tab', tab);
    go('settings');
  };
  // 准备情况: keys, downloads (from the main process) and devices, each with its fix.
  const [ready, setReady] = useState<ReadinessItem[] | null>(null);
  useEffect(() => {
    if (active) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () =>
      void api.meeting.readiness().then((r) => {
        if (stop) return;
        setReady(r);
        // While something downloads, follow its progress.
        if (r.some((x) => x.downloading)) timer = setTimeout(load, 3000);
      }, () => setReady([]));
    load();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [active, settings]);
  const problems: { text: string; fix: () => void; downloading?: boolean }[] = [
    ...(ready ?? []).map((r) => ({ text: r.text, fix: () => openSettings(r.fix), downloading: r.downloading })),
    ...(!settings.devices.virtualMic ? [{ text: `对方听不到${remoteName}译音：没选虚拟麦克风`, fix: () => openSettings('devices') }] : []),
    ...(settings.devices.meetingSource === 'device' && !settings.devices.meetingDevice ? [{ text: '听不到对方：没选会议声音', fix: () => openSettings('devices') }] : []),
  ];

  const start = async () => {
    setBusy(true);
    setError('');
    try {
      await api.meeting.start({ title: title.trim() || undefined, mode: 'meeting' });
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

  return (
    <div>
      <header className="row between" style={{ marginBottom: 16 }}>
        <h1 className="page-title">会议同传</h1>
        {active ? (
          <div className="row">
            <span className="badge live" role="status">进行中 {elapsed(state?.startedAtMs ?? null)}</span>
            <button data-test="flow" className="btn danger big" onClick={stop} disabled={busy}>
              结束会议
            </button>
          </div>
        ) : roomActive ? (
          <button className="btn big" onClick={() => go('room')}>
            去现场房间
          </button>
        ) : (
          <button data-test="flow" className="btn primary big" onClick={start} disabled={busy}>
            {busy ? '正在开始…' : '开始同传'}
          </button>
        )}
      </header>

      {error && (
        <div className="callout err" role="alert" style={{ marginBottom: 16 }}>
          {error}
          {/模型还在下载|正在下载.*模型/.test(error) && (
            <button className="btn sm" style={{ marginLeft: 8 }} onClick={() => go('settings')}>
              查看下载进度
            </button>
          )}
          {window.platform === 'darwin' && /屏幕录制/.test(error) && (
            <button className="btn sm" data-test="external" style={{ marginLeft: 8 }} onClick={() => void api.app.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')}>
              打开“屏幕录制”权限
            </button>
          )}
        </div>
      )}
      {state?.warnings?.map((w) => (
        <div key={w} className="callout" role="alert" style={{ marginBottom: 10 }}>
          {w}
          {window.platform === 'darwin' && /^无法采集系统声音/.test(w) && (
            <button className="btn sm" style={{ marginLeft: 8 }} onClick={() => void api.app.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')}>
              打开“录屏与系统录音”设置
            </button>
          )}
          {window.platform === 'darwin' && /^无法打开麦克风/.test(w) && (
            <button className="btn sm" style={{ marginLeft: 8 }} onClick={() => void api.app.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone')}>
              打开“麦克风”权限设置
            </button>
          )}
        </div>
      ))}

      {!active && (
        <section className="card" aria-label="会议准备">
          <DeviceCheck s={settings} foreign={remoteName ?? '西语'} />
          {problems.map((p) => (
            <div key={p.text} className={`callout ${p.downloading ? 'info' : 'warn'} row between`} role={p.downloading ? 'status' : 'alert'} style={{ marginBottom: 10 }}>
              <span>{p.text}</span>
              <button className="btn sm" onClick={p.fix}>{p.downloading ? '查看' : '去设置'}</button>
            </div>
          ))}
          {/* Can the other side hear me? Checked in the meeting app itself (its microphone level). */}
          {settings.devices.virtualMic && (
            <div className="row" style={{ marginBottom: 12, gap: 8 }}>
              <FlashButton
                label="对方能听到吗？发测试音"
                done="测试音已送进虚拟麦克风：看会议软件里麦克风的音量条有没有跳。没跳的话，在会议软件里把麦克风选成虚拟声卡"
                action={() => api.audio.testTone('virtualMic')}
              />
              <span className="muted small">请戴耳机：外放的中文会被麦克风收进去再翻一遍。会议软件的降噪调低一些，译音更清楚。</span>
            </div>
          )}
          <div className="grid2">
            <Field label="对方说">
              <select value={lang(settings.languages.remote).base} onChange={(e) => void api.settings.set({ languages: { remote: withRemoteBase(settings.languages.remote, e.target.value as 'es' | 'en') }, out: { voice: '' }, in: { voice: '' } })}>
                {REMOTE_CHOICES.map((c) => (
                  <option key={c.base} value={c.base}>{c.name}</option>
                ))}
              </select>
            </Field>
            <Field label="会议名称">
              <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
            </Field>
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <Toggle checked={settings.recording.audio} onChange={(v) => void api.settings.set({ recording: { audio: v } })} label="录音" />
            <Toggle checked={settings.recording.screen} onChange={(v) => void api.settings.set({ recording: { screen: v } })} label="录屏" />
            {settings.recording.screen && <ScreenPicker selected={settings.recording.screenSourceId} />}
            {(settings.recording.audio || settings.recording.screen) && <span className="muted small">请先征得参会者同意</span>}
          </div>
          <p className="small" style={{ margin: '10px 0 0' }}>
            <a href="#guide" data-test="safe" onClick={(e) => (e.preventDefault(), go('guide'))}>在会议软件里怎么设置</a>
          </p>
        </section>
      )}

      {active && state && (
        <div className="grid2">
          <div className={`dir-card ${state.out.enabled ? '' : 'off'}`}>
            <div className="row between" style={{ flexWrap: 'nowrap' }}>
              <h2 className="title" id="dir-out">
                我说{selfName} → 对方听{remoteName} <StateBadge state={state.out.state} message={state.out.message} />
              </h2>
              <Toggle checked={state.out.enabled} onChange={(v) => void api.meeting.setOut(v)} ariaLabel={`翻译我说的${selfName}`} />
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <Level db={levels.mic} label="麦克风音量" />
              {state.out.backlog > 1 && <span className="badge warn">译音排队 {state.out.backlog.toFixed(0)} 秒</span>}
              {state.out.backlog > 8 && (
                <button className="btn sm" onClick={() => void api.meeting.skip('out')}>
                  跳到最新
                </button>
              )}
            </div>
            <div className="partial" aria-live="polite">{partials.out}</div>
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
              <Toggle checked={state.out.passthrough} onChange={(v) => void api.meeting.setPassthrough(v)} label={`我自己说${remoteName}`} />
            </div>
            {state.out.message && state.out.state === 'error' && <div className="callout err" role="alert" style={{ marginTop: 8 }}>{state.out.message}</div>}
          </div>
          <div className={`dir-card ${state.in.enabled ? '' : 'off'}`}>
            <div className="row between" style={{ flexWrap: 'nowrap' }}>
              <h2 className="title" id="dir-in">
                对方说{remoteName} → 我听{selfName} <StateBadge state={state.in.state} message={state.in.message} />
              </h2>
              <Toggle checked={state.in.enabled} onChange={(v) => void api.meeting.setIn(v)} ariaLabel={`翻译对方说的${remoteName}`} />
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <Level db={levels.meeting} label="会议声音音量" />
              {state.in.backlog > 1 && <span className="badge warn">译音排队 {state.in.backlog.toFixed(0)} 秒</span>}
              {state.in.backlog > 8 && (
                <button className="btn sm" onClick={() => void api.meeting.skip('in')}>
                  跳到最新
                </button>
              )}
            </div>
            <div className="partial" aria-live="polite">{partials.in}</div>
            <div className="row" style={{ marginTop: 8 }}>
              <Toggle checked={state.in.speak} onChange={(v) => void api.meeting.setInSpeak(v)} label={`朗读${selfName}译音`} />
              <button className="btn sm" onClick={() => void api.app.showWindow('overlay')}>
                字幕窗
              </button>
            </div>
            {state.in.message && state.in.state === 'error' && <div className="callout err" role="alert" style={{ marginTop: 8 }}>{state.in.message}</div>}
          </div>
        </div>
      )}

      {lastMeeting && !active && (
        <div className="callout info row between" role="status" style={{ margin: '12px 0' }}>
          <span>会议已结束</span>
          <button className="btn sm" onClick={() => go('history')}>
            查看会议记录
          </button>
        </div>
      )}
      {/* Minutes and after-meeting learning need an LLM: say so instead of silently doing nothing. */}
      {lastMeeting && !active && llmReady === false && settings.preset !== 'demo' && (settings.summary.autoAtEnd || settings.interpretation.autoReview) && !settings.ui.dismissed.includes('llm-key') && (
        <div className="callout row between" role="note" style={{ margin: '0 0 12px' }}>
          <span>这场会没有生成纪要，也没有做会后自动学习：它们需要一个大模型 Key（智谱有免费的，1 分钟拿到）。</span>
          <div className="row">
            <button className="btn sm primary" onClick={() => go('settings')}>去填 Key</button>
            <button className="btn sm ghost" onClick={() => void api.settings.set({ ui: { dismissed: [...settings.ui.dismissed, 'llm-key'] } })}>不需要</button>
          </div>
        </div>
      )}
      {/* The meeting app now listens to the virtual mic: without this app running, nobody hears me. */}
      {lastMeeting && !active && settings.devices.virtualMic && !settings.ui.dismissed.includes('switch-back') && (
        <div className="callout row between" role="note" style={{ margin: '0 0 12px' }}>
          <span>不用同传开会时，记得把会议软件的麦克风改回你自己的麦克风，否则对方听不到你。</span>
          <button className="btn sm ghost" onClick={() => void api.settings.set({ ui: { dismissed: [...settings.ui.dismissed, 'switch-back'] } })}>
            知道了，不再提示
          </button>
        </div>
      )}

      {(active || segs.length > 0) && (
      <section className="card" style={{ marginTop: 16 }} aria-labelledby="live-title">
        <div className="row between">
          <h3 id="live-title">双语记录</h3>
          {active && state?.recording && (
            <div className="row">
              {state.recording.audio && <span className="badge live">录音</span>}
              {state.recording.screen && !state.recording.screenError && <span className="badge live">录屏</span>}
            </div>
          )}
        </div>
        <div ref={listRef} className="segments" style={{ maxHeight: 460, overflow: 'auto', paddingRight: 4 }}>
          {/* The live view keeps the latest 200 sentences; the full record is in 会议记录. */}
          {segs.slice(-200).map((s) => (
            <SegmentView key={s.id} seg={s} />
          ))}
        </div>
      </section>
      )}
    </div>
  );
}
