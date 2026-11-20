import { useEffect, useState } from 'react';
import logoUrl from './assets/logo.png';
import { Icon } from './components/icons';
import { lang } from '@core/lang/languages';
import { api, useEvent, useMeetingState, useSettings } from './api';
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
}

export function App() {
  const [settings] = useSettings();
  const meeting = useMeetingState();
  const [page, setPage] = useState<Page>('meeting');
  const [openMeeting, setOpenMeeting] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [version, setVersion] = useState('');
  const [skipOnboarding, setSkipOnboarding] = useState(false);
  const [download, setDownload] = useState<{ file: string; pct: number } | null>(null);

  useEffect(() => {
    void api.app.info().then((i) => setVersion(i.version));
  }, []);

  useEvent('toast', (t) => {
    const id = Date.now() + Math.random();
    setToasts((x) => [...x, { id, ...t }]);
    setTimeout(() => setToasts((x) => x.filter((y) => y.id !== id)), t.level === 'error' ? 9000 : 6000);
  });
  useEvent('navigate', ({ page }) => setPage(page as Page));
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
      <aside className="sidebar">
        <div className="brand">
          <img className="logo" src={logoUrl} alt="" />
          <div>
            会议同传助手
            <small>{lang(settings.languages.remote).base === 'en' ? '中文 ⇄ English' : '中文 ⇄ Español'}</small>
          </div>
        </div>
        {NAV.map((n) => (
          <button key={n.id} className={`nav-item ${page === n.id ? 'active' : ''}`} onClick={() => go(n.id)}>
            <span className="nav-icon"><Icon name={n.icon} /></span>
            {n.label}
            {n.id === 'meeting' && meeting?.active && meeting.mode === 'meeting' && <span className="dot" />}
            {n.id === 'room' && meeting?.active && meeting.mode === 'room' && <span className="dot" />}
          </button>
        ))}
        <div className="spacer" />
        <div className="muted small" style={{ padding: '0 12px' }}>
          v{version} · 免费开源
        </div>
      </aside>
      <main className="main">
        {download && (
          <div className="callout info" style={{ marginBottom: 14 }}>
            正在下载本机离线识别模型（只需一次）：{download.file} {download.pct}%
          </div>
        )}
        {page === 'meeting' && <MeetingPage settings={settings} state={meeting} go={go} />}
        {page === 'room' && <RoomPage settings={settings} state={meeting} />}
        {page === 'history' && <HistoryPage openId={openMeeting} setOpenId={setOpenMeeting} />}
        {page === 'glossary' && <GlossaryPage />}
        {page === 'settings' && <SettingsPage />}
        {page === 'guide' && <GuidePage />}
      </main>
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.level}`}>
            {t.message}
          </div>
        ))}
      </div>
    </div>
  );
}
