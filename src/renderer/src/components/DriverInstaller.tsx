import { useState } from 'react';
import { api, errMsg, useEvent } from '../api';
import { guessVirtualMic, MEETING_APPS } from '../content/guides';

/**
 * One click: download the virtual audio device from its vendor, install it, select it as the
 * output for the translated voice, and play a test tone into it.
 */
export function DriverInstaller({ onDone }: { onDone?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  useEvent('driver-progress', (p) => setText(p.text));

  const install = async () => {
    // On a Mac the system's sound restarts to pick up the new device: calls drop for a few seconds.
    if (window.platform === 'darwin') {
      const running = (await api.app.detectMeetingApps().catch(() => [] as string[])).map((id) => MEETING_APPS.find((a) => a.id === id)?.name ?? id);
      const note = running.length ? `（${running.join('、')} 正在运行，里面的通话也会受影响）` : '';
      if (!confirm(`安装时电脑的声音会中断几秒${note}。如果正在通话，请先结束再装。\n\n现在安装吗？`)) return;
    }
    setBusy(true);
    setError('');
    try {
      const r = await api.audio.installDriver();
      if (!r.ok) {
        setText(r.message);
        return;
      }
      setText(`${r.message}，正在检测…`);
      // The new device can take a moment to appear.
      for (let i = 0; i < 10; i++) {
        await new Promise((res) => setTimeout(res, 1000));
        const vm = guessVirtualMic((await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput'));
        if (vm) {
          // Windows may make the cable the default device once it appears: put the old default back.
          if (window.platform === 'win32') await api.audio.restoreSystemDefaults().catch(() => '');
          await api.settings.set({ devices: { virtualMic: vm.deviceId } });
          await api.audio.testTone('virtualMic').catch(() => undefined);
          setText(`✅ 装好了：${vm.label}。已自动选好。`);
          onDone?.();
          return;
        }
      }
      setText(`${r.message}。如果下面还没出现，请重启电脑后再打开本软件。`);
      onDone?.();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <div className="row">
        <button data-test="admin" className="btn primary big" disabled={busy} onClick={() => void install()}>
          {busy ? '正在安装…' : '一键安装虚拟麦克风'}
        </button>
        {text && <span className="muted small" role="status">{text}</span>}
      </div>
      {error && <div className="callout err" role="alert">{error}</div>}
    </div>
  );
}
