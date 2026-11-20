import { useEffect, useRef, useState } from 'react';
import type { AppSettings } from '@core/config/schema';
import type { CalibrationOutcome, ProfileView } from '@shared/ipc';
import { api, errMsg, useEvent } from '../api';
import { Toggle } from './ui';
import { startRecording, type Recording } from '../../../browser/recorder';

/** Friendly names for accent patterns. */
const PAIR_NAMES: Record<string, string> = {
  'l-n': 'n / l（如“南”“兰”）',
  'f-h': 'f / h（如“发”“花”）',
  'z-zh': 'z / zh（如“资”“知”）',
  'c-ch': 'c / ch（如“采”“柴”）',
  's-sh': 's / sh（如“四”“是”）',
  'l-r': 'r / l（如“日”“力”）',
  'in-ing': 'in / ing（如“新”“星”）',
  'en-eng': 'en / eng（如“分”“风”）',
  'an-ang': 'an / ang（如“班”“帮”）',
};
const pairName = (p: string) => PAIR_NAMES[p] ?? p.replace('-', ' / ');
const pct = (x: number) => `${Math.round(x * 100)}%`;
const LANG_NAMES = { zh: '中文', es: '西语', en: '英语' } as const;
const SOURCE_NAMES = { calibration: '校准', edit: '我改的', review: '会后检查', manual: '手动添加' } as const;

type Step = { kind: 'idle' } | { kind: 'reading'; i: number; recording: Recording | null } | { kind: 'analysing'; done: number; total: number } | { kind: 'done'; outcome: CalibrationOutcome };

/** Optional accent calibration: read a few sentences, see how well each recogniser hears you. */
export function AccentCalibrationCard({ s, update }: { s: AppSettings; update: (patch: object) => Promise<unknown> }) {
  const [script, setScript] = useState<string[]>([]);
  const [step, setStep] = useState<Step>({ kind: 'idle' });
  const [error, setError] = useState('');
  const [level, setLevel] = useState(0);
  const audio = useRef<Int16Array[]>([]);
  useEvent('calibration-progress', (p) => setStep((st) => (st.kind === 'analysing' ? { kind: 'analysing', ...p } : st)));
  useEffect(() => {
    if (step.kind !== 'reading' || !step.recording) return;
    const t = setInterval(() => setLevel(step.recording!.level()), 100);
    return () => clearInterval(t);
  }, [step]);

  const begin = async () => {
    setError('');
    const sc = await api.profile.script();
    setScript(sc);
    audio.current = [];
    setStep({ kind: 'reading', i: 0, recording: null });
  };
  const record = async (i: number) => {
    setError('');
    try {
      setStep({ kind: 'reading', i, recording: await startRecording() });
    } catch (err) {
      setError(`无法使用麦克风：${errMsg(err)}`);
    }
  };
  const next = async () => {
    if (step.kind !== 'reading' || !step.recording) return;
    try {
      audio.current[step.i] = await step.recording.stop();
    } catch (err) {
      setError(errMsg(err));
      setStep({ kind: 'reading', i: step.i, recording: null });
      return;
    }
    if (step.i + 1 < script.length) return record(step.i + 1);
    setStep({ kind: 'analysing', done: 0, total: 1 });
    try {
      setStep({ kind: 'done', outcome: await api.profile.calibrate(audio.current) });
    } catch (err) {
      setError(errMsg(err));
      setStep({ kind: 'idle' });
    }
  };
  const cancel = () => {
    if (step.kind === 'reading') step.recording?.cancel();
    setStep({ kind: 'idle' });
  };

  return (
    <div className="card">
      <h3>口音校准</h3>
      {step.kind === 'idle' && (
        <div className="row">
          <button className="btn primary" onClick={() => void begin()}>开始校准（1 分钟）</button>
        </div>
      )}
      {step.kind === 'reading' && (
        <div className="stack">
          <div className="muted small">{step.i + 1} / {script.length}</div>
          <div className="callout info" style={{ fontSize: 20, lineHeight: 1.7 }} data-testid="calibration-sentence">{script[step.i]}</div>
          <div className="row">
            {step.recording ? (
              <>
                <button className="btn primary" onClick={() => void next()}>{step.i + 1 < script.length ? '读完了，下一句' : '读完了，开始分析'}</button>
                <div className="level" role="meter" aria-label="音量" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.min(100, level * 140))}><div style={{ width: `${Math.min(100, level * 140)}%` }} /></div>
              </>
            ) : (
              <button className="btn primary" onClick={() => void record(step.i)}>开始录音</button>
            )}
            <button className="btn ghost" onClick={cancel}>取消</button>
          </div>
        </div>
      )}
      {step.kind === 'analysing' && <div className="muted" role="status">正在分析… {step.total > 1 ? `${step.done} / ${step.total}` : ''}</div>}
      {step.kind === 'done' && <CalibrationResult outcome={step.outcome} s={s} update={update} again={() => void begin()} />}
      {error && <div className="callout err" role="alert" style={{ marginTop: 10 }}>{error}</div>}
    </div>
  );
}

function CalibrationResult({ outcome, s, update, again }: { outcome: CalibrationOutcome; s: AppSettings; update: (patch: object) => Promise<unknown>; again: () => void }) {
  const cur = outcome.results.find((r) => r.asr === outcome.current && !r.error);
  const best = outcome.results.find((r) => r.asr === outcome.best);
  const better = best && best.asr !== outcome.current && (!cur || best.accuracy - cur.accuracy >= 0.03);
  return (
    <div className="stack" data-testid="calibration-result">
      <table className="table">
        <thead>
          <tr><th>识别方式</th><th>听懂你的准确率</th></tr>
        </thead>
        <tbody>
          {outcome.results.map((r) => (
            <tr key={r.asr}>
              <td>{r.name}{r.asr === outcome.current ? '（正在用）' : ''}</td>
              <td>{r.error ? <span className="muted">没测成：{r.error}</span> : <b>{pct(r.accuracy)}</b>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {better && best && (
        <div className="callout info row between">
          <span>{best.name}听你说话更准（{pct(best.accuracy)}{cur ? ` vs ${pct(cur.accuracy)}` : ''}）。</span>
          <button className="btn primary sm" onClick={() => void update({ out: { asr: best.asr }, preset: 'custom' })} disabled={s.out.asr === best.asr}>
            {s.out.asr === best.asr ? '已改用' : `我的发言改用${best.name}`}
          </button>
        </div>
      )}
      {outcome.pairs.length > 0 && <div>你的口音特点：{[...new Set(outcome.pairs)].map(pairName).join('、')}</div>}
      {outcome.learnedTerms.length > 0 && (
        <div>记住了：{outcome.learnedTerms.map((c) => `“${c.heard}”→“${c.meant}”`).join('，')}</div>
      )}
      {!outcome.pairs.length && !outcome.learnedTerms.length && <div className="muted">没有明显的误听</div>}
      <div className="row">
        <button className="btn" onClick={again}>重新校准</button>
      </div>
    </div>
  );
}

/** Learned corrections, where the profile file is, export / import / reset. */
export function MyCorrectionsCard({ s, update, llmReady = true, setTab }: { s: AppSettings; update: (patch: object) => Promise<unknown>; llmReady?: boolean; setTab?: (tab: string) => void }) {
  const [p, setP] = useState<ProfileView | null>(null);
  const [heard, setHeard] = useState('');
  const [meant, setMeant] = useState('');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const refresh = () => void api.profile.get().then(setP);
  useEffect(refresh, [s.recording.dir]);
  useEvent('review-ready', refresh);
  const run = async (fn: () => Promise<ProfileView | null | boolean | void>, ok = '') => {
    setError('');
    setMsg('');
    try {
      const r = await fn();
      if (r && typeof r === 'object') setP(r);
      else refresh();
      if (ok && r !== null && r !== false) setMsg(ok);
    } catch (err) {
      setError(errMsg(err));
    }
  };
  const isZh = /\p{Script=Han}/u.test(heard + meant);
  if (!p) return null;
  return (
    <div className="card">
      <h3>我的纠错词表</h3>
      <Toggle checked={s.interpretation.autoReview} onChange={(v) => void update({ interpretation: { autoReview: v } })} label="会后自动学习" />
      {s.interpretation.autoReview && !llmReady && (
        <div className="callout warn row between" style={{ marginTop: 8 }}>
          <span>自动学习要用大模型</span>
          <button className="btn sm" onClick={() => setTab?.('providers')}>去填 Key</button>
        </div>
      )}
      {p.pairs.length > 0 && <div className="small" style={{ marginTop: 8 }}>你的口音特点：{p.pairs.map(pairName).join('、')}</div>}
      {p.corrections.length > 0 && (
        <table className="table" style={{ marginTop: 10 }}>
          <thead>
            <tr><th>听成</th><th>其实是</th><th>来源</th><th /></tr>
          </thead>
          <tbody>
            {p.corrections.map((c) => (
              <tr key={`${c.lang}:${c.heard}`}>
                <td>{c.heard}{c.lang !== 'zh' ? <span className="muted small">（{LANG_NAMES[c.lang]}）</span> : null}</td>
                <td>{c.meant}</td>
                <td className="muted small">{SOURCE_NAMES[c.source]}{c.count > 1 ? ` ×${c.count}` : ''}</td>
                <td><button className="btn ghost sm" onClick={() => void run(() => api.profile.removeCorrection(c.lang, c.heard))}>删除</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="row" style={{ marginTop: 10 }}>
        <input type="text" aria-label="听成" placeholder="听成" value={heard} onChange={(e) => setHeard(e.target.value)} style={{ maxWidth: 170 }} />
        <span aria-hidden="true">→</span>
        <input type="text" aria-label="其实是" placeholder="其实是" value={meant} onChange={(e) => setMeant(e.target.value)} style={{ maxWidth: 170 }} />
        <button
          className="btn sm"
          disabled={!heard.trim() || !meant.trim()}
          onClick={() =>
            void run(async () => {
              const r = await api.profile.addCorrection(isZh ? 'zh' : s.languages.remote.startsWith('en') ? 'en' : 'es', heard, meant);
              setHeard('');
              setMeant('');
              return r;
            })
          }
        >
          添加
        </button>
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn sm" onClick={() => void api.profile.openFolder()}>打开所在文件夹</button>
        <button className="btn sm" onClick={() => void run(() => api.profile.exportFile(), '已导出')}>导出</button>
        <button className="btn sm" onClick={() => void run(() => api.profile.importFile(), '已导入并合并')}>导入</button>
        <button className="btn sm danger" onClick={() => window.confirm('确定清除口音档案吗？学到的纠错和校准结果都会删除。') && void run(() => api.profile.reset(), '已清除')}>清除</button>
        {msg && <span className="muted small" role="status">{msg}</span>}
      </div>
      <div className="muted small" style={{ marginTop: 6 }}><code>{p.file}</code></div>
      {error && <div className="callout err" role="alert" style={{ marginTop: 10 }}>{error}</div>}
    </div>
  );
}
