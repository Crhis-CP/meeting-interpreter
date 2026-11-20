import { useState } from 'react';
import logoUrl from './assets/logo.png';
import { Icon } from './components/icons';
import { useEvent, useMeetingState, useSettings } from './api';
import { GlossaryPage } from './pages/Glossary';
import { HistoryPage } from './pages/History';
import { MeetingPage } from './pages/Meeting';
import { Onboarding } from './pages/Onboarding';
import { RoomPage } from './pages/Room';
import { SettingsPage } from './pages/Settings';
import { GuidePage } from './pages/Guide';

export type Page = 'meeting' | 'room' | 'history' | 'glossary' | 'settings' | 'guide';

const NAV: { id: Page; label: string; icon: string }[] = [
  { id: 'meeting', label: '会议同传', icon: 'headphones' },
  { id: 'room', label: '现场房间', icon: 'people' },
  { id: 'history', label: '会议记录', icon: 'doc' },
  { id: 'glossary', label: '术语表', icon: 'book' },
  { id: 'settings', label: '设置', icon: 'gear' },
  { id: 'guide', label: '使用指南', icon: 'help' },
];

interface Toast {
  id: number;
  level: 'info' | 'warn' | 'error';
  message: string;
  /** A meeting to open when the toast is clicked. */
  meetingId?: string;
}

export function App() {
  const [settings] = useSettings();
  const meeting = useMeetingState();
  const [page, setPage] = useState<Page>('meeting');
  const [openMeeting, setOpenMeeting] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [skipOnboarding, setSkipOnboarding] = useState(false);
  const [download, setDownload] = useState<{ file: string; pct: number } | null>(null);


  useEvent('toast', (t) => {
    const id = Date.now() + Math.random();
    setToasts((x) => [...x, { id, ...t }]);
    setTimeout(() => setToasts((x) => x.filter((y) => y.id !== id)), t.level === 'error' ? 9000 : 6000);
  });
  useEvent('navigate', ({ page }) => setPage(page as Page));
  useEvent('review-ready', ({ id, count, terms }) => {
    const tid = Date.now() + Math.random();
    const what = [count ? `改正了 ${count} 处听错的词` : '', terms ? `学会了 ${terms} 个新术语` : ''].filter(Boolean).join('，');
    setToasts((x) => [...x, { id: tid, level: 'info', message: `会后自动学习：${what}，以后会自动用上。点这里查看（学错了可以撤销）`, meetingId: id }]);
    setTimeout(() => setToasts((x) => x.filter((y) => y.id !== tid)), 15000);
  });
  useEvent('model-progress', (p) => {
    const pct = p.total ? Math.round((p.received / p.total) * 100) : 0;
    setDownload(pct >= 100 ? null : { file: p.file, pct });
  });

  if (!settings) return null;
  if (!settings.onboarded && !skipOnboarding) return <Onboarding onDone={() => setSkipOnboarding(true)} />;

  const go = (p: Page) => {
    setPage(p);
    if (p !== 'history') setOpenMeeting(null);
  };

  return (
    <div className="app">
      <nav className="sidebar" aria-label="主菜单">
        <div className="brand">
          <img className="logo" src={logoUrl} alt="" />
          会议同传助手
        </div>
        {NAV.map((n) => {
          const live = meeting?.active && ((n.id === 'meeting' && meeting.mode === 'meeting') || (n.id === 'room' && meeting.mode === 'room'));
          return (
            <button key={n.id} className={`nav-item ${page === n.id ? 'active' : ''}`} aria-current={page === n.id ? 'page' : undefined} onClick={() => go(n.id)}>
              <span className="nav-icon" aria-hidden="true"><Icon name={n.icon} /></span>
              {n.label}
              {live && <span className="dot" aria-label="进行中" />}
            </button>
          );
        })}
      </nav>
      <main className="main">
        {download && (
          <div className="download-bar" role="status">
            <span>下载模型</span>
            <progress max={100} value={download.pct} aria-label="下载模型" />
            <span>{download.pct}%</span>
          </div>
        )}
        {page === 'meeting' && <MeetingPage settings={settings} state={meeting} go={go} />}
        {page === 'room' && <RoomPage settings={settings} state={meeting} go={go} />}
        {page === 'history' && <HistoryPage openId={openMeeting} setOpenId={setOpenMeeting} />}
        {page === 'glossary' && <GlossaryPage />}
        {page === 'settings' && <SettingsPage />}
        {page === 'guide' && <GuidePage />}
      </main>
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) =>
          t.meetingId ? (
            <button
              key={t.id}
              className={`toast ${t.level}`}
              onClick={() => {
                setPage('history');
                setOpenMeeting(t.meetingId!);
                setToasts((x) => x.filter((y) => y.id !== t.id));
              }}
            >
              {t.message}
            </button>
          ) : (
            <div key={t.id} className={`toast ${t.level}`} role={t.level === 'error' ? 'alert' : undefined}>
              {t.message}
            </div>
          ),
        )}
      </div>
    </div>
  );
}
