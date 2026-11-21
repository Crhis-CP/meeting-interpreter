import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import type { AppSettings } from '@core/config/schema';
import type { TranscriptSegment } from '@core/types';

const api = window.api;

function Overlay() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [segs, setSegs] = useState<TranscriptSegment[]>([]);
  const [partial, setPartial] = useState<{ dir: string; text: string } | null>(null);

  useEffect(() => {
    void api.settings.get().then(setSettings);
    const offs = [
      api.on('settings', setSettings),
      api.on('segment', (s) =>
        setSegs((list) => {
          const i = list.findIndex((x) => x.id === s.id);
          const next = i >= 0 ? list.map((x, j) => (j === i ? s : x)) : [...list, s];
          return next.slice(-6);
        }),
      ),
      api.on('partial', (p) => setPartial(p.text ? p : null)),
      // A new meeting starts with an empty subtitle window.
      api.on('meeting-state', (st) => {
        if (st.active && st.startedAtMs && Date.now() - st.startedAtMs < 2000) {
          setSegs([]);
          setPartial(null);
        }
      }),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  if (!settings) return null;
  const o = settings.ui.overlay;
  const shown = segs.filter((s) => s.status !== 'translating' || s.srcText).slice(-2);

  return (
    <div
      style={{
        height: '100%',
        boxSizing: 'border-box',
        background: `rgba(16,18,24,${o.opacity})`,
        borderRadius: 14,
        padding: '10px 18px',
        color: '#fff',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-end',
        gap: 6,
        position: 'relative',
        ['WebkitAppRegion' as string]: 'drag',
      }}
    >
      {/* Always visible, and always clickable: in click-through mode the window takes clicks while
          the pointer is over these buttons. */}
      <div
        onMouseEnter={() => void api.app.overlayPointer(true)}
        onMouseLeave={() => void api.app.overlayPointer(false)}
        style={{ position: 'absolute', top: 6, right: 10, display: 'flex', gap: 6, ['WebkitAppRegion' as string]: 'no-drag' }}
      >
        <button onClick={() => void api.app.showWindow('main')} style={btn}>主窗口</button>
        <button onClick={() => void api.app.hideOverlay()} style={btn} aria-label="关闭字幕窗">✕</button>
      </div>
      {shown.length === 0 && !partial && <div style={{ opacity: 0.6, fontSize: 14 }}>同传字幕会显示在这里 · 拖动可移动位置</div>}
      {shown.map((s) => {
        const remote = s.speaker === 'them' || !s.srcLang.startsWith('zh');
        return (
          <div key={s.id} style={{ lineHeight: 1.35 }}>
            {o.showOriginal && <div style={{ fontSize: Math.round(o.fontSize * 0.62), opacity: 0.7 }}>{remote ? '🗣 ' : '🎙 '}{s.srcText}</div>}
            <div style={{ fontSize: o.fontSize, fontWeight: 600, color: remote ? '#fff' : '#9ec5ff', ...(s.draft ? { opacity: 0.6, fontStyle: 'italic' } : {}) }}>
              {s.status === 'translating' ? (s.draft && s.dstText ? s.dstText : '…') : s.status === 'failed' ? '（翻译失败）' : s.dstText}
            </div>
          </div>
        );
      })}
      {partial && (
        <div style={{ fontSize: Math.round(o.fontSize * 0.62), opacity: 0.55, fontStyle: 'italic' }}>
          {partial.dir === 'in' ? '🗣 ' : '🎙 '}
          {partial.text}
        </div>
      )}
    </div>
  );
}

const btn: React.CSSProperties = { background: 'rgba(255,255,255,0.18)', color: '#fff', border: 0, borderRadius: 6, padding: '3px 8px', cursor: 'pointer', fontSize: 12 };

createRoot(document.getElementById('root')!).render(<Overlay />);
