import { useState } from 'react';
import type { ScreenSource } from '@shared/ipc';
import { api } from '../api';

/**
 * Which screen or window 录屏 records. Without a choice the whole (first) screen is recorded, so
 * recording never fails for want of one; this only lets the user pick something else.
 */
export function ScreenPicker({ selected }: { selected: string }) {
  const [sources, setSources] = useState<ScreenSource[] | null>(null);
  const current = sources?.find((s) => s.id === selected);
  return (
    <>
      <button className="btn sm" data-test="safe" onClick={() => void api.app.screenSources().then(setSources)}>
        {selected ? '更换录制画面' : '录制画面：整个屏幕'}
      </button>
      {sources && (
        <div className="card screen-picker" role="dialog" aria-label="选择要录制的屏幕或窗口">
          <div className="row between">
            <h3>选择要录制的屏幕或窗口</h3>
            <button className="btn sm" data-test="safe" onClick={() => setSources(null)}>
              关闭
            </button>
          </div>
          {sources.length === 0 && <p className="muted">没有找到可以录制的屏幕。Mac 请先在“系统设置 › 隐私与安全性 › 屏幕录制”里允许本软件。</p>}
          <div className="grid3">
            {sources.map((s) => (
              <button
                key={s.id}
                data-test="safe"
                aria-pressed={s.id === (current?.id ?? '')}
                className={`preset ${s.id === selected ? 'active' : ''}`}
                onClick={() => {
                  void api.settings.set({ recording: { screenSourceId: s.id } });
                  setSources(null);
                }}
              >
                <img src={s.thumbnail} alt="" style={{ width: '100%', borderRadius: 6 }} />
                <p>{s.name}</p>
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
