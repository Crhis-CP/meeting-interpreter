import { useEffect, useState } from 'react';
import { api, errMsg, useEvent } from '../api';

/**
 * A newer version: one click downloads this computer's installer, checks it against the release's
 * fingerprints and opens it. After an update, the first start shows what changed.
 */
export function UpdateBanner() {
  const [info, setInfo] = useState<{ version: string; notes: string } | null>(null);
  const [whatsNew, setWhatsNew] = useState<{ version: string; notes: string } | null>(null);
  const [pct, setPct] = useState<number | null>(null);
  const [stage, setStage] = useState<'idle' | 'downloading' | 'mac-drag' | 'installing'>('idle');
  const [later, setLater] = useState(false);
  const [showNotes, setShowNotes] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    void api.update.state().then(setInfo, () => undefined);
    void api.update.whatsNew().then(setWhatsNew, () => undefined);
  }, []);
  useEvent('update-available', setInfo);
  useEvent('update-progress', (p) => setPct(p.total ? Math.round((p.received / p.total) * 100) : null));

  const install = async () => {
    setError('');
    setStage('downloading');
    try {
      const r = await api.update.install();
      setStage(r === 'mac-drag' ? 'mac-drag' : 'installing');
    } catch (err) {
      setError(errMsg(err));
      setStage('idle');
    }
  };

  if (whatsNew)
    return (
      <div className="callout info" role="status" aria-label="这次更新了什么" style={{ marginBottom: 12 }}>
        <div className="row between">
          <b>已更新到 {whatsNew.version}</b>
          <button className="btn sm ghost" onClick={() => setWhatsNew(null)}>知道了</button>
        </div>
        {whatsNew.notes && <pre className="notes">{whatsNew.notes}</pre>}
      </div>
    );
  if (!info || later) return null;
  return (
    <div className="callout info" role="status" aria-label="有新版本" style={{ marginBottom: 12 }}>
      <div className="row between">
        <span>
          {stage === 'downloading' ? `正在下载新版 ${info.version}${pct !== null ? ` · ${pct}%` : '…'}`
            : stage === 'mac-drag' ? '安装盘已打开：把“会议同传助手”拖进“应用程序”文件夹替换旧版（会问是否替换，点“替换”）。拖之前先退出本软件。'
            : stage === 'installing' ? '安装程序已打开，本软件马上退出。'
            : `有新版本 ${info.version}。模型、术语、口音档案、会议记录和设置都会保留。`}
        </span>
        <div className="row">
          {stage === 'idle' && (
            <>
              {info.notes && <button className="btn sm ghost" onClick={() => setShowNotes((x) => !x)}>改了什么</button>}
              <button data-test="network" className="btn sm primary" onClick={() => void install()}>更新</button>
              <button className="btn sm ghost" onClick={() => setLater(true)}>稍后</button>
            </>
          )}
          {stage === 'mac-drag' && <button className="btn sm primary" onClick={() => void api.app.quit()}>退出软件</button>}
        </div>
      </div>
      {showNotes && info.notes && <pre className="notes">{info.notes}</pre>}
      {error && <div className="small" role="alert" style={{ color: 'var(--live)', marginTop: 6 }}>{error}</div>}
    </div>
  );
}
