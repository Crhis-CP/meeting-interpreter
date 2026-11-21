import { useEffect, useState } from 'react';
import type { AppSettings, SecretName } from '@core/config/schema';
import { PRESETS } from '@core/config/presets';
import { accentsOf, lang, REMOTE_CHOICES, withRemoteBase } from '@core/lang/languages';
import { LLM_PRESETS, llmPreset } from '@core/providers/openai-compatible';
import type { VoiceInfo } from '@core/providers/types';
import type { AiStatus, AppInfo, LocalModelStatus, ProviderTestStep } from '@shared/ipc';
import { api, errMsg, useDevices, useEvent, useSettings } from '../api';
import { ExternalLink, Field, Toggle, FlashButton } from '../components/ui';
import { ScreenPicker } from '../components/ScreenPicker';
import { acceleratorOf } from '../lib/accelerator';
import { DRIVER_GUIDES, guessMeetingDevice, guessVirtualMic } from '../content/guides';
import { checkDevices } from '@core/audio/device-check';
import { DeviceCheck } from '../components/DeviceCheck';
import { recordVoiceSample, SAMPLE_SCRIPT, SAMPLE_SECONDS } from '../../../browser/voice-sample';
import { DriverInstaller } from '../components/DriverInstaller';
import { AccentCalibrationCard, MyCorrectionsCard } from '../components/AccentCard';

type Tab = 'providers' | 'devices' | 'interp' | 'record' | 'overlay' | 'shortcuts' | 'about';

const TABS: [Tab, string][] = [
  ['providers', '翻译服务'],
  ['devices', '音频设备'],
  ['interp', '同传与语言'],
  ['record', '录制与纪要'],
  ['overlay', '字幕窗'],
  ['shortcuts', '快捷键'],
  ['about', '关于'],
];

/** The other side's language base. */
function foreignOf(s: AppSettings): 'es' | 'en' {
  return lang(s.languages.remote).base === 'en' ? 'en' : 'es';
}

export function SettingsPage() {
  const [s, update] = useSettings();
  const [tab, setTab] = useState<Tab>('providers');
  if (!s) return null;
  return (
    <div>
      <h1 className="page-title">设置</h1>
      <div className="tabs" role="tablist" aria-label="设置">
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'providers' && <ProvidersTab s={s} update={update} />}
      {tab === 'devices' && <DevicesTab s={s} update={update} />}
      {tab === 'interp' && <InterpTab s={s} update={update} go={setTab} />}
      {tab === 'record' && <RecordTab s={s} update={update} />}
      {tab === 'overlay' && <OverlayTab s={s} update={update} />}
      {tab === 'shortcuts' && <ShortcutsTab s={s} update={update} />}
      {tab === 'about' && <AboutTab />}
    </div>
  );
}

type TabProps = { s: AppSettings; update: (patch: object) => Promise<AppSettings>; go?: (tab: Tab) => void };

// ------------------------------------------------------------------ providers

function SecretInput({ name, label, placeholder, status, onSaved, getUrl }: { name: SecretName; label: string; placeholder?: string; status: Record<string, boolean>; onSaved: () => void; getUrl?: string }) {
  const [v, setV] = useState('');
  const save = async () => {
    if (!v.trim()) return;
    await api.secrets.set(name, v.trim());
    setV('');
    onSaved();
  };
  return (
    <Field label={<span>{label} {status[name] ? <span className="badge ok">已保存</span> : getUrl ? <ExternalLink href={getUrl}>获取 ↗</ExternalLink> : null}</span>}>
      <div className="row">
        <input type="password" style={{ flex: 1 }} placeholder={status[name] ? '••••••' : placeholder} value={v} onChange={(e) => setV(e.target.value)} onBlur={() => void save()} onKeyDown={(e) => e.key === 'Enter' && void save()} />
        <button className="btn" onClick={save} disabled={!v}>
          保存
        </button>
        {status[name] && (
          <button className="btn ghost sm" data-test="destructive" onClick={() => void api.secrets.set(name, '').then(onSaved)}>
            清除
          </button>
        )}
      </div>
    </Field>
  );
}

/** `beforeRun` saves what was typed (e.g. a key not saved yet) so the test uses it. */
export function TestPanel({ scope, label, beforeRun }: { scope: 'out' | 'in' | 'llm'; label: string; beforeRun?: () => Promise<void> }) {
  const [steps, setSteps] = useState<ProviderTestStep[] | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    setSteps(null);
    try {
      await beforeRun?.();
      setSteps(await api.providers.test(scope));
    } catch (err) {
      setSteps([{ name: '测试', ok: false, ms: 0, detail: errMsg(err) }]);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack" style={{ gap: 4 }}>
      <button className="btn" data-test="network" onClick={run} disabled={busy}>
        {busy ? '测试中…' : label}
      </button>
      {steps?.map((st, i) => (
        <div key={i} className="step-result">
          <span className="icon">{st.ok ? '✅' : '❌'}</span>
          <div>
            <b>{st.name}</b> <span className="muted small">{st.ms} ms</span>
            <div className={st.ok ? 'muted small' : 'small'} style={st.ok ? undefined : { color: 'var(--live)' }}>
              {st.detail}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function VoiceSelect({ provider, langCode, value, onChange }: { provider: string; langCode: string; value: string; onChange: (v: string) => void }) {
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  useEffect(() => {
    if (provider === 'none' || provider === 'demo') return setVoices([]);
    void api.providers.voices(provider, langCode).then(setVoices);
  }, [provider, langCode]);
  if (provider === 'none') return null;
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">默认音色</option>
      {voices.map((v) => (
        <option key={v.id} value={v.id}>
          {v.name}
        </option>
      ))}
    </select>
  );
}

function LocalModels({ foreign }: { foreign: 'es' | 'en' }) {
  const [models, setModels] = useState<LocalModelStatus[]>([]);
  const [progress, setProgress] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const load = () => void api.local.status().then(setModels).catch(() => setModels([]));
  useEffect(load, []);
  useEvent('model-progress', (p) => setProgress(`${p.file} ${p.total ? Math.round((p.received / p.total) * 100) : 0}%`));
  const download = async (base: 'zh' | 'es' | 'en') => {
    setBusy(base);
    try {
      await api.local.download(base);
    } catch (err) {
      setProgress(errMsg(err));
    } finally {
      setBusy(null);
      load();
    }
  };
  return (
    <div className="stack">
      {models.map((m) => (
        <div key={m.id} className="row">
          <span>{m.ready ? '✅' : '⬜'}</span>
          <span style={{ flex: 1 }}>{m.name}</span>
          <span className="muted small">{m.sizeMb} MB</span>
        </div>
      ))}
      <div className="row">
        <button data-test="network" className="btn" disabled={!!busy} onClick={() => void download('zh')}>
          {busy === 'zh' ? '下载中…' : '下载中文识别模型'}
        </button>
        <button data-test="network" className="btn" disabled={!!busy} onClick={() => void download(foreign)}>
          {busy === foreign ? '下载中…' : `下载${foreign === 'en' ? '英语' : '西语'}识别模型`}
        </button>
      </div>
      {progress && <span className="muted small">{progress}</span>}
    </div>
  );
}

/** Offline translation models: status and one-click download. */
function OfflineMtCard() {
  const [st, setSt] = useState<{ missingBytes: number; totalBytes: number } | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const load = () => void api.mt.status().then(setSt).catch((e) => setError(errMsg(e)));
  useEffect(load, []);
  useEvent('model-progress', (p) => {
    if (p.id === 'offline-mt') setBusy(`下载中 ${p.total ? Math.round((p.received / p.total) * 100) : 0}%`);
  });
  const download = async () => {
    setError('');
    setBusy('下载中…');
    try {
      await api.mt.download();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy('');
      load();
    }
  };
  const mb = (n: number) => Math.round(n / 1_000_000);
  return (
    <div className="card">
      <div className="row between">
        <h3 style={{ margin: 0 }}>离线翻译（草稿）</h3>
        {st && !st.missingBytes ? (
          <span className="badge ok">已下载</span>
        ) : (
          <button data-test="network" className="btn sm" disabled={!!busy} onClick={() => void download()}>
            {busy || `下载 · ${mb(st?.missingBytes ?? st?.totalBytes ?? 140_000_000)} MB`}
          </button>
        )}
      </div>
      {error && <div className="callout err" style={{ marginTop: 8 }}>{error}</div>}
    </div>
  );
}

/**
 * Local AI translation (Hy-MT2): download, choose, use. The larger, more accurate model is offered
 * only where it runs fast (Apple-silicon Macs, on the GPU), so no explanation is needed.
 */
function AiMtCard({ s, update }: TabProps) {
  const [st, setSt] = useState<AiStatus | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [pct, setPct] = useState<Record<string, number>>({});
  const [error, setError] = useState('');
  const load = () => void api.ai.status().then(setSt).catch((e) => setError(errMsg(e)));
  useEffect(() => {
    load();
    void api.app.info().then(setInfo);
  }, []);
  useEvent('model-progress', (p) => {
    if (!p.id.startsWith('hy-mt2')) return;
    setPct((x) => ({ ...x, [p.id]: p.total ? Math.round((p.received / p.total) * 100) : 0 }));
    if (p.total && p.received >= p.total) load();
  });
  const download = (id: AiStatus['chosen']) => {
    setError('');
    setPct((x) => ({ ...x, [id]: 0 }));
    api.ai.download(id).catch((e) => setError(errMsg(e))).finally(load);
  };
  const appleSilicon = info?.platform === 'darwin' && info.arch === 'arm64';
  // The 7B model needs a fast GPU and about 6 GB while it runs: offered on Apple silicon with 16 GB+
  // (a downloaded one is still shown, so it can be used or removed).
  const bigEnough = appleSilicon && (info?.memoryGb ?? 0) >= 16;
  const rows = st?.models.filter((m) => m.id === 'hy-mt2-1.8b' || bigEnough || m.ready) ?? [];
  const using = s.out.mt === 'local-ai' && s.in.mt === 'local-ai';
  const anyReady = rows.some((m) => m.ready);
  return (
    <section className="card" aria-labelledby="ai-mt-title">
      <h3 id="ai-mt-title">本机 AI 翻译</h3>
      <div className="stack" role={rows.length > 1 ? 'radiogroup' : undefined} aria-labelledby="ai-mt-title">
        {rows.map((m) => (
          <div key={m.id} className="row between">
            <label className="row">
              {rows.length > 1 && <input type="radio" name="ai-model" checked={s.local.aiModel === m.id} disabled={!m.ready} onChange={() => void update({ local: { aiModel: m.id } })} />}
              <span>{m.id === 'hy-mt2-7b' ? '更准' : '标准'} · {m.sizeMb >= 1000 ? `${(m.sizeMb / 1000).toFixed(1)} GB` : `${m.sizeMb} MB`}</span>
            </label>
            {m.ready ? (
              <span className="badge ok">已下载</span>
            ) : m.id in pct || m.downloading ? (
              <span className="muted small" role="status">下载中 {pct[m.id] ?? 0}%</span>
            ) : (
              <button data-test="network" className="btn sm" onClick={() => download(m.id)}>下载</button>
            )}
          </div>
        ))}
      </div>
      {anyReady && !using && (
        <button data-test="network" className="btn primary" style={{ marginTop: 10 }} onClick={() => void update({ out: { mt: 'local-ai' }, in: { mt: 'local-ai' }, ...(s.preset === 'free' ? {} : { preset: 'custom' }) })}>
          用本机 AI 翻译
        </button>
      )}
      {error && <div className="callout err" style={{ marginTop: 8 }} role="alert">{error}</div>}
    </section>
  );
}

/** “用我的声音”: record a sample, clone it with 百炼, speak my translations in my own voice. */
function MyVoiceCard({ s, update }: TabProps) {
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const has = !!s.dashscope.myVoiceId;
  const record = async () => {
    setError('');
    try {
      const wav = await recordVoiceSample(SAMPLE_SECONDS, (left) => setBusy(left ? `正在录音，请朗读上面的文字… ${left} 秒` : '录好了'));
      setBusy('正在生成你的音色（约半分钟）…');
      await api.voice.create(wav);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy('');
    }
  };
  return (
    <div className="card">
      <h3>用我的声音</h3>
      {has ? (
        <div className="stack">
          <Toggle checked={s.dashscope.useMyVoice} onChange={(v) => void update({ dashscope: { useMyVoice: v } })} label="对方听到我的声音" />
          <div className="row">
            <button className="btn" disabled={!!busy} onClick={() => setConsent(true)}>重新录制</button>
            <button data-test="destructive" className="btn" disabled={!!busy} onClick={() => void api.voice.remove()}>删除我的音色</button>
          </div>
        </div>
      ) : null}
      {(!has || consent) && (
        <div className="stack" style={{ marginTop: has ? 12 : 0 }}>
          <div className="callout info" style={{ fontSize: 15, lineHeight: 1.7 }}>{SAMPLE_SCRIPT}</div>
          <label className="row small" style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            这是我本人的声音，我同意用它合成我的翻译语音
          </label>
          <div className="row">
            <button data-test="flow" className="btn primary" disabled={!consent || !!busy} onClick={() => void record()}>
              开始录音（16 秒）
            </button>
            {busy && <span className="muted small">{busy}</span>}
          </div>
        </div>
      )}
      {error && <div className="callout err" style={{ marginTop: 10 }}>{error}</div>}
    </div>
  );
}

function ProvidersTab({ s, update }: TabProps) {
  const foreign = foreignOf(s);
  const fz = foreign === 'en' ? '英语' : '西语';
  const [status, setStatus] = useState<Record<string, boolean>>({});
  const refresh = () => void api.secrets.status().then(setStatus);
  useEffect(refresh, []);
  const lp = llmPreset(s.llm.preset);
  const uses = (id: string) => [s.out.asr, s.out.mt, s.out.tts, s.in.asr, s.in.mt, s.in.tts].includes(id as never);
  const dir = (d: 'out' | 'in') => (d === 'out' ? s.out : s.in);

  return (
    <div>
      <div className="card">
        <h3>选择方案</h3>
        <div className="grid2">
          {PRESETS.map((p) => (
            <button key={p.id} data-test={p.id === 'free' ? 'network' : 'safe'} className={`preset ${s.preset === p.id ? 'active' : ''}`} onClick={() => void api.settings.applyPreset(p.id)}>
              <h4>
                {p.name} {s.preset === p.id && <span className="badge ok">当前</span>}
              </h4>
              <p>{p.cost}</p>
            </button>
          ))}
        </div>
      </div>

      {(uses('dashscope') || uses('qwen-mt') || s.llm.preset === 'qwen') && (
        <div className="card">
          <h3>阿里云百炼（DashScope）</h3>
          <div className="stack">
            <SecretInput name="dashscope" label="API Key" placeholder="sk-…" status={status} onSaved={refresh} getUrl="https://bailian.console.aliyun.com/?tab=model#/api-key" />
            <div className="grid2">
              <Field label="地域">
                <select value={s.dashscope.region} onChange={(e) => void update({ dashscope: { region: e.target.value } })}>
                  <option value="cn">中国（北京）</option>
                  <option value="intl">国际（新加坡）</option>
                </select>
              </Field>
              <Field label="识别模型">
                <select value={s.dashscope.asrModel} onChange={(e) => void update({ dashscope: { asrModel: e.target.value } })}>
                  <option value="qwen-audio-3.1-asr-flash-streaming">qwen-audio-3.1-asr-flash-streaming（推荐，支持热词）</option>
                  <option value="qwen-audio-3.0-asr-flash-streaming">qwen-audio-3.0-asr-flash-streaming</option>
                  <option value="fun-asr-realtime">fun-asr-realtime</option>
                </select>
              </Field>
              <Field label="翻译模型">
                <select value={s.dashscope.mtModel} onChange={(e) => void update({ dashscope: { mtModel: e.target.value } })}>
                  <option value="qwen-mt-flash">qwen-mt-flash（推荐）</option>
                  <option value="qwen-mt-plus">qwen-mt-plus（质量更高）</option>
                  <option value="qwen-mt-lite">qwen-mt-lite</option>
                </select>
              </Field>
            </div>
            <details>
              <summary>高级</summary>
              <Field label="业务空间主机">
                <input type="text" placeholder="llm-xxx.cn-beijing.maas.aliyuncs.com" value={s.dashscope.host} onChange={(e) => void update({ dashscope: { host: e.target.value.trim() } })} />
              </Field>
            </details>
          </div>
        </div>
      )}

      {(uses('azure') || uses('azure-translator')) && (
        <div className="card">
          <h3>Azure 语音 / 翻译</h3>
          <div className="stack">
            <SecretInput name="azure" label="语音服务 Key" status={status} onSaved={refresh} getUrl="https://portal.azure.com/#create/Microsoft.CognitiveServicesSpeechServices" />
            <div className="grid2">
              <Field label="区域">
                <input type="text" placeholder="eastasia" value={s.azure.region} onChange={(e) => void update({ azure: { region: e.target.value.trim() } })} />
              </Field>
              <Field label="资源终结点">
                <input type="text" placeholder="https://xxx.cognitiveservices.azure.cn" value={s.azure.endpoint} onChange={(e) => void update({ azure: { endpoint: e.target.value.trim() } })} />
              </Field>
            </div>
            {uses('azure-translator') && (
              <>
                <SecretInput name="azureTranslator" label="翻译服务 Key" status={status} onSaved={refresh} getUrl="https://portal.azure.com/#create/Microsoft.CognitiveServicesTextTranslation" />
                <Field label="翻译资源区域">
                  <input type="text" value={s.azure.translatorRegion} onChange={(e) => void update({ azure: { translatorRegion: e.target.value.trim() } })} />
                </Field>
              </>
            )}
          </div>
        </div>
      )}

      <div className="card">
        <h3>大模型</h3>
        <div className="grid2">
          <Field label="服务">
            <select
              value={s.llm.preset}
              onChange={(e) => {
                const p = llmPreset(e.target.value)!;
                void update({ llm: { preset: p.id, baseUrl: p.baseUrl || s.llm.baseUrl, model: p.model || s.llm.model } });
              }}
            >
              {LLM_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="模型">
            <input type="text" value={s.llm.model} onChange={(e) => void update({ llm: { model: e.target.value.trim() } })} />
          </Field>
          <Field label="接口地址（OpenAI 兼容）">
            <input type="text" value={s.llm.baseUrl} onChange={(e) => void update({ llm: { baseUrl: e.target.value.trim() } })} />
          </Field>
          <Field label="纪要用模型">
            <input type="text" placeholder={s.llm.model} value={s.llm.summaryModel} onChange={(e) => void update({ llm: { summaryModel: e.target.value.trim() } })} />
          </Field>
        </div>
        {!lp?.noKey && (
          <div style={{ marginTop: 10 }}>
            <SecretInput name="llm" label={`${lp?.name ?? '大模型'} 的 Key`} status={status} onSaved={refresh} getUrl={lp?.keyUrl} />
          </div>
        )}
        <div style={{ marginTop: 10 }}>
          <TestPanel scope="llm" label="测试大模型" />
        </div>
      </div>

      {uses('deepl') && (
        <div className="card">
          <h3>DeepL</h3>
          <SecretInput name="deepl" label="DeepL API Key" status={status} onSaved={refresh} getUrl="https://www.deepl.com/pro-api" />
          <div style={{ marginTop: 8 }}>
            <Toggle checked={s.deepl.useGlossary} onChange={(v) => void update({ deepl: { useGlossary: v } })} label="同步术语表到 DeepL" />
          </div>
        </div>
      )}

      {uses('local') && (
        <div className="card">
          <h3>本机离线识别（免费）</h3>
          <div className="grid2" style={{ marginBottom: 10 }}>
            <Field label={`${fz}识别模型（Whisper）`}>
              <select value={s.local.esModel} onChange={(e) => void update({ local: { esModel: e.target.value } })}>
                <option value="whisper-small">Whisper small（更准，约 360MB）</option>
                <option value="whisper-base">Whisper base（更快更小，约 150MB）</option>
              </select>
            </Field>
          </div>
          <LocalModels foreign={foreign} />
        </div>
      )}

      {(s.preset === 'free' || s.out.mt === 'local-ai' || s.in.mt === 'local-ai') && <AiMtCard s={s} update={update} />}
      {(s.out.mt === 'offline' || s.in.mt === 'offline' || s.out.mt === 'local-ai' || s.in.mt === 'local-ai') && <OfflineMtCard />}
      {s.out.tts === 'dashscope' && <MyVoiceCard s={s} update={update} />}

      <div className="card">
        <h3>Chrome 插件</h3>
        <Toggle checked={s.bridge.enabled} onChange={(v) => void update({ bridge: { enabled: v } })} label="让 Chrome 插件使用本机识别、AI 翻译和系统语音" />
      </div>

      <div className="card">
        <h3>每个方向分别选择</h3>
        {(['out', 'in'] as const).map((d) => {
          const c = dir(d);
          const dst = d === 'out' ? s.languages.remote : s.languages.self;
          return (
            <div key={d} className="stack" style={{ marginBottom: 14 }}>
              <b>{d === 'out' ? `我说中文 → 对方听${fz}` : `对方说${fz} → 我听中文`}</b>
              <div className="grid3">
                <Field label="语音识别">
                  <select value={c.asr} onChange={(e) => void update({ [d]: { asr: e.target.value }, preset: 'custom' })}>
                    <option value="dashscope">阿里云百炼</option>
                    <option value="azure">Azure</option>
                    <option value="local">本机离线（免费）</option>
                    <option value="demo">演示</option>
                  </select>
                </Field>
                <Field label="翻译">
                  <select value={c.mt} onChange={(e) => void update({ [d]: { mt: e.target.value }, preset: 'custom' })}>
                    <option value="qwen-mt">通义 Qwen-MT（百炼）</option>
                    <option value="local-ai">本机 AI 翻译（免费，准确率接近大模型）</option>
                    <option value="offline">离线翻译（免费，最快）</option>
                    <option value="llm">大模型（上面配置的）</option>
                    <option value="deepl">DeepL</option>
                    <option value="azure-translator">Azure 翻译</option>
                    <option value="demo">演示</option>
                  </select>
                </Field>
                <Field label="语音合成">
                  <select value={c.tts} onChange={(e) => void update({ [d]: { tts: e.target.value, voice: '' }, preset: 'custom' })}>
                    <option value="dashscope">阿里云百炼（自然人声）</option>
                    <option value="azure">Azure 神经网络语音</option>
                    <option value="system">系统自带语音（免费）</option>
                    <option value="none">不发声（只出字幕）</option>
                    <option value="demo">演示</option>
                  </select>
                </Field>
              </div>
              <Field label={`${lang(dst).nameZh}音色`}>
                <VoiceSelect provider={c.tts} langCode={dst} value={c.voice} onChange={(v) => void update({ [d]: { voice: v } })} />
              </Field>
              <TestPanel scope={d} label={d === 'out' ? '测试 中→西' : '测试 西→中'} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ devices

function DevicesTab({ s, update }: TabProps) {
  const foreign = foreignOf(s);
  const fz = foreign === 'en' ? '英语' : '西语';
  const { inputs, outputs, all, refresh } = useDevices();
  const [refused, setRefused] = useState('');
  // A choice that would make the app hear its own output is not saved (the engine would refuse it too).
  const choose = (patch: Partial<AppSettings['devices']>) => {
    const before = new Set(checkDevices(all, s.devices, fz).filter((i) => i.level === 'block').map((i) => i.id));
    const loop = checkDevices(all, { ...s.devices, ...patch }, fz).find((i) => i.level === 'block' && !before.has(i.id));
    if (loop) return setRefused(`没有改：${loop.text}`);
    setRefused('');
    void update({ devices: patch });
  };
  const [platform, setPlatform] = useState('');
  useEffect(() => void api.app.info().then((i) => setPlatform(i.platform)), []);
  const os = platform === 'darwin' ? 'mac' : platform === 'win32' ? 'win' : 'linux';
  const guide = DRIVER_GUIDES.find((g) => g.os === os);
  const label = (list: MediaDeviceInfo[], id: string) => list.find((d) => d.deviceId === id)?.label;
  const hasVirtual = outputs.some((d) => guessVirtualMic([d]));

  const autodetect = () => {
    const vm = guessVirtualMic(outputs);
    const md = guessMeetingDevice(inputs, vm?.label);
    void update({ devices: { virtualMic: vm?.deviceId ?? s.devices.virtualMic, meetingDevice: md?.deviceId ?? s.devices.meetingDevice } });
  };

  const missing = (id: string, list: MediaDeviceInfo[]) => id && !list.some((d) => d.deviceId === id);

  return (
    <div>
      {!hasVirtual && (
        <div className="card">
          <h3>还没有虚拟麦克风</h3>
          <DriverInstaller onDone={refresh} />
          {guide && (
            <details style={{ marginTop: 10 }}>
              <summary>手动安装</summary>
              <ol className="steps">
                {guide.steps.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ol>
            </details>
          )}
        </div>
      )}
      <div className="card">
        <div className="row between">
          <h3>音频设备</h3>
          <div className="row">
            <button className="btn sm" onClick={autodetect}>
              自动识别虚拟声卡
            </button>
            <button className="btn sm" onClick={refresh}>
              刷新
            </button>
          </div>
        </div>
        <DeviceCheck s={s} foreign={fz} />
        {refused && (
          <div className="callout err" role="alert" style={{ marginBottom: 10 }}>
            {refused}
          </div>
        )}
        <div className="grid2">
          <Field label="① 我的麦克风（我说中文）">
            <select value={s.devices.mic} onChange={(e) => choose({ mic: e.target.value })}>
              <option value="">系统默认麦克风</option>
              {inputs.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || d.deviceId}
                </option>
              ))}
            </select>
          </Field>
          <Field label={`② 虚拟麦克风（${fz}译音送进会议）`}>
            <div className="row">
              <select style={{ flex: 1 }} value={s.devices.virtualMic} onChange={(e) => choose({ virtualMic: e.target.value })}>
                <option value="">（未选择）</option>
                {outputs.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || d.deviceId}
                  </option>
                ))}
              </select>
              <FlashButton label="试音" done="测试音已送进虚拟麦克风：看会议软件里麦克风的音量条有没有跳" action={() => api.audio.testTone('virtualMic')} />
            </div>
            {missing(s.devices.virtualMic, outputs) && <span className="badge err">设备已不存在，请重新选择</span>}
          </Field>
          <Field label={`③ 会议声音来自（对方说${fz}）`}>
            <select value={s.devices.meetingSource} onChange={(e) => void update({ devices: { meetingSource: e.target.value } })}>
              <option value="loopback">系统声音</option>
              <option value="device">虚拟扬声器</option>
              <option value="none">不翻译会议声音</option>
            </select>
          </Field>
          {s.devices.meetingSource === 'device' && (
            <Field label="虚拟扬声器">
              <select value={s.devices.meetingDevice} onChange={(e) => choose({ meetingDevice: e.target.value })}>
                <option value="">（未选择）</option>
                {inputs.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || d.deviceId}
                  </option>
                ))}
              </select>
              {missing(s.devices.meetingDevice, inputs) && <span className="badge err">设备已不存在，请重新选择</span>}
            </Field>
          )}
          <Field label="④ 我的耳机（听中文译音）">
            <div className="row">
              <select style={{ flex: 1 }} value={s.devices.headphones} onChange={(e) => choose({ headphones: e.target.value })}>
                <option value="">系统默认输出</option>
                {outputs.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || d.deviceId}
                  </option>
                ))}
              </select>
              <FlashButton label="试音" done="正在播放测试音" action={() => api.audio.testTone('headphones')} />
            </div>
          </Field>
        </div>
        {s.devices.virtualMic && (
          <section className="meeting-app-setup" aria-label="会议软件里这样选">
            <h4>会议软件里这样选</h4>
            <dl className="facts">
              <dt>麦克风</dt>
              <dd>{/BlackHole/i.test(label(outputs, s.devices.virtualMic) ?? '') ? 'BlackHole 2ch' : 'CABLE Output'}</dd>
              {s.devices.meetingSource === 'device' && s.devices.meetingDevice && (
                <>
                  <dt>扬声器</dt>
                  <dd>{label(inputs, s.devices.meetingDevice)}</dd>
                </>
              )}
            </dl>
          </section>
        )}
        <div className="row" style={{ marginTop: 14 }}>
          <Toggle checked={s.devices.echoCancellation} onChange={(v) => void update({ devices: { echoCancellation: v } })} label="回声消除" />
          <Toggle checked={s.devices.noiseSuppression} onChange={(v) => void update({ devices: { noiseSuppression: v } })} label="降噪" />
          <Toggle checked={s.devices.autoGainControl} onChange={(v) => void update({ devices: { autoGainControl: v } })} label="自动增益" />
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ interpretation

function InterpTab({ s, update, go }: TabProps) {
  const i = s.interpretation;
  const [keys, setKeys] = useState<Record<string, boolean>>({});
  useEffect(() => void api.secrets.status().then(setKeys), []);
  const lp = llmPreset(s.llm.preset);
  const llmReady = !!(lp?.noKey || keys.llm || (lp?.usesDashscopeKey && keys.dashscope));
  return (
    <div>
      <div className="card">
        <h3>语言</h3>
        <div className="grid2">
          <Field label="对方说">
            <select value={lang(s.languages.remote).base} onChange={(e) => void update({ languages: { remote: withRemoteBase(s.languages.remote, e.target.value as 'es' | 'en') }, out: { voice: '' }, in: { voice: '' } })}>
              {REMOTE_CHOICES.map((c) => (
                <option key={c.base} value={c.base}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="口音">
            <select value={s.languages.remote} onChange={(e) => void update({ languages: { remote: e.target.value }, out: { voice: '' }, in: { voice: '' } })}>
              {accentsOf(lang(s.languages.remote).base).map((a) => (
                <option key={a.code} value={a.code}>
                  {a.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </div>
      <div className="card">
        <h3>我的发言</h3>
        <div className="stack">
          <Field label="翻译方式">
            <select value={i.outMode} onChange={(e) => void update({ interpretation: { outMode: e.target.value } })}>
              <option value="continuous">一直听</option>
              <option value="push-to-talk">按住才听</option>
            </select>
          </Field>
          <Toggle checked={i.lowLatency} onChange={(v) => void update({ interpretation: { lowLatency: v } })} label="长句分句提前翻译" />
          <Toggle checked={i.pinyinFuzzy} onChange={(v) => void update({ interpretation: { pinyinFuzzy: v } })} label="按拼音纠正术语" />
          <Field label={`对方听到我的原声：${Math.round(i.originalMixOut * 100)}%`}>
            <input type="range" min={0} max={0.5} step={0.05} value={i.originalMixOut} onChange={(e) => void update({ interpretation: { originalMixOut: Number(e.target.value) } })} />
          </Field>
        </div>
      </div>
      <AccentCalibrationCard s={s} update={update} />
      <MyCorrectionsCard s={s} update={update} llmReady={llmReady} setTab={(t) => go?.(t as Tab)} />
      {s.devices.meetingSource === 'device' && (
        <div className="card">
          <h3>对方的原声</h3>
          <div className="stack">
            <Toggle checked={i.playOriginalIn} onChange={(v) => void update({ interpretation: { playOriginalIn: v } })} label="播放原声" />
            <Field label={`音量：${Math.round(i.originalInVolume * 100)}%`}>
              <input type="range" min={0} max={1} step={0.05} value={i.originalInVolume} onChange={(e) => void update({ interpretation: { originalInVolume: Number(e.target.value) } })} />
            </Field>
            <Field label={`朗读中文时压低到：${Math.round(i.duckLevel * 100)}%`}>
              <input type="range" min={0} max={1} step={0.05} value={i.duckLevel} onChange={(e) => void update({ interpretation: { duckLevel: Number(e.target.value) } })} />
            </Field>
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ recording

function RecordTab({ s, update }: TabProps) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => void api.app.info().then(setInfo), [s.recording.dir]);
  return (
    <div>
      <div className="card">
        <h3>保存位置</h3>
        <div className="row">
          <span className="kbd" style={{ flex: 1 }}>{info?.recordsDir}</span>
          <button className="btn" onClick={() => void api.app.chooseRecordsDir().then(() => api.app.info().then(setInfo))}>
            更改
          </button>
        </div>
      </div>
      <div className="card">
        <h3>默认录制</h3>
        <div className="stack">
          <Toggle checked={s.recording.audio} onChange={(v) => void update({ recording: { audio: v } })} label="录音" />
          <Toggle checked={s.recording.screen} onChange={(v) => void update({ recording: { screen: v } })} label="录屏" />
          {s.recording.screen && <ScreenPicker selected={s.recording.screenSourceId} />}
        </div>
      </div>
      <div className="card">
        <h3>会议纪要</h3>
        <div className="stack">
          <Toggle checked={s.summary.autoAtEnd} onChange={(v) => void update({ summary: { autoAtEnd: v } })} label="会后自动生成纪要" />
          <Field label="默认模板">
            <select value={s.summary.template} onChange={(e) => void update({ summary: { template: e.target.value } })}>
              <option value="general">通用会议</option>
              <option value="business">商务谈判 / 客户会议</option>
              <option value="project">项目例会</option>
            </select>
          </Field>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ overlay

function OverlayTab({ s, update }: TabProps) {
  const o = s.ui.overlay;
  const set = (patch: object) => void update({ ui: { overlay: patch } });
  return (
    <div className="card">
      <h3>实时字幕窗</h3>
      <div className="stack">
        <Toggle checked={o.enabled} onChange={(v) => set({ enabled: v })} label="开始会议时自动显示字幕窗" />
        <Toggle checked={o.showOriginal} onChange={(v) => set({ showOriginal: v })} label="同时显示原文" />
        <Toggle checked={o.contentProtection} onChange={(v) => set({ contentProtection: v })} label="不出现在屏幕共享和录屏里" />
        <Toggle checked={o.clickThrough} onChange={(v) => void api.app.setOverlayClickThrough(v)} label="字幕窗不挡鼠标" />
        <Field label={`字号：${o.fontSize}px`}>
          <input type="range" min={14} max={40} value={o.fontSize} onChange={(e) => set({ fontSize: Number(e.target.value) })} />
        </Field>
        <Field label={`不透明度：${Math.round(o.opacity * 100)}%`}>
          <input type="range" min={0.3} max={1} step={0.05} value={o.opacity} onChange={(e) => set({ opacity: Number(e.target.value) })} />
        </Field>
        <button className="btn" onClick={() => void api.app.showWindow('overlay')} style={{ alignSelf: 'flex-start' }}>
          显示字幕窗
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ shortcuts

function shortcutLabel(accel: string): string {
  const mac = window.platform === 'darwin';
  return accel
    .replace('CommandOrControl', mac ? '⌘' : 'Ctrl')
    .replace('Alt', mac ? '⌥' : 'Alt')
    .replace('Shift', mac ? '⇧' : 'Shift')
    .replace('Space', '空格');
}

/** Press the combination to record it; Backspace clears (no shortcut). */
function ShortcutInput({ value, label, onChange }: { value: string; label: string; onChange: (v: string) => void }) {
  const [hint, setHint] = useState('');
  return (
    <Field label={label}>
      <input
        type="text"
        readOnly
        aria-label={label}
        value={value ? shortcutLabel(value) : '（无）'}
        onKeyDown={(e) => {
          if (e.key === 'Tab') return;
          e.preventDefault();
          if ((e.key === 'Backspace' || e.key === 'Delete') && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
            setHint('');
            return onChange('');
          }
          const a = acceleratorOf(e);
          if (a === null) return setHint('请同时按住 Cmd/Ctrl、Alt 或 Shift 再按一个键');
          if (a) {
            setHint('');
            onChange(a);
          }
        }}
      />
      {hint && <span className="muted small" role="status">{hint}</span>}
    </Field>
  );
}

function ShortcutsTab({ s, update }: TabProps) {
  const set = (k: string, v: string) => void update({ shortcuts: { [k]: v } });
  return (
    <div className="card">
      <h3>全局快捷键（只在开会时生效）</h3>
      <div className="stack">
        <ShortcutInput label="开关“翻译我的发言”" value={s.shortcuts.toggleOut} onChange={(v) => set('toggleOut', v)} />
        <ShortcutInput label="按键说话" value={s.shortcuts.pushToTalk} onChange={(v) => set('pushToTalk', v)} />
        <ShortcutInput label="显示/隐藏字幕窗" value={s.shortcuts.toggleOverlay} onChange={(v) => set('toggleOverlay', v)} />
      </div>
    </div>
  );
}

function AboutTab() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => void api.app.info().then(setInfo), []);
  return (
    <div className="card">
      <h3>会议同传助手 v{info?.version}</h3>
      <dl className="facts">
        <dt>协议</dt>
        <dd>MIT</dd>
        <dt>主页</dt>
        <dd><ExternalLink href="https://github.com/Crhis-CP/meeting-interpreter">github.com/Crhis-CP/meeting-interpreter</ExternalLink></dd>
        <dt>新版本</dt>
        <dd><ExternalLink href="https://github.com/Crhis-CP/meeting-interpreter/releases">GitHub Releases</ExternalLink></dd>
        <dt>系统</dt>
        <dd>{info?.platform} {info?.arch} {info?.osVersion}</dd>
        <dt>数据</dt>
        <dd className="kbd">{info?.dataDir}</dd>
      </dl>
    </div>
  );
}
