import { useEffect, useState } from 'react';
import { checkDevices } from '@core/audio/device-check';
import type { AppSettings } from '@core/config/schema';
import { api, errMsg, useDevices } from '../api';

const SOUND_SETTINGS: Record<string, string> = {
  darwin: 'x-apple.systempreferences:com.apple.Sound-Settings.extension',
  win32: 'ms-settings:sound',
};

/**
 * Device problems as things stand now (the system default can change under us, e.g. installing
 * VB-CABLE makes it the default), each with its one-click fix. Loops are red: the audio engine
 * refuses them anyway, this says why and fixes it. Likely mistakes can be marked "on purpose".
 */
export function DeviceCheck({ s, foreign }: { s: AppSettings; foreign: string }) {
  const { all } = useDevices();
  const [canRestore, setCanRestore] = useState(false);
  const [msg, setMsg] = useState('');
  useEffect(() => void api.audio.canRestoreSystemDefaults().then(setCanRestore, () => setCanRestore(false)), []);
  const issues = checkDevices(all, s.devices, foreign).filter((i) => !i.dismissKey || !s.ui.dismissed.includes(i.dismissKey));
  if (!issues.length && !msg) return null;

  const restore = async () => {
    try {
      setMsg(await api.audio.restoreSystemDefaults());
    } catch (err) {
      setMsg(errMsg(err));
    }
  };
  const soundSettings = SOUND_SETTINGS[window.platform];

  return (
    <div className="stack" aria-label="设备检查" style={{ marginBottom: 10 }}>
      {issues.map((i) => (
        <div key={i.id} className={`callout ${i.level === 'block' ? 'err' : 'warn'}`} role="alert">
          <div>{i.text}</div>
          <div className="row" style={{ marginTop: 6 }}>
            {i.fix && (
              <button className="btn sm primary" onClick={() => void api.settings.set({ devices: i.fix!.devices })}>
                {i.fix.label}
              </button>
            )}
            {i.system && canRestore && (
              <button className="btn sm primary" onClick={() => void restore()}>
                改回原来的设备
              </button>
            )}
            {i.system && soundSettings && (
              <button data-test="safe" className="btn sm" onClick={() => void api.app.openExternal(soundSettings)}>
                打开声音设置
              </button>
            )}
            {i.dismissKey && (
              <button className="btn sm ghost" onClick={() => void api.settings.set({ ui: { dismissed: [...s.ui.dismissed, i.dismissKey!].slice(-100) } })}>
                这是我故意的
              </button>
            )}
          </div>
        </div>
      ))}
      {msg && <div className="muted small" role="status">{msg}</div>}
    </div>
  );
}
