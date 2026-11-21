import { useEffect, useState } from 'react';
import logoUrl from '../assets/logo.png';
import { PLANS, PRESETS, type PresetId } from '@core/config/presets';
import { lang, REMOTE_CHOICES, withRemoteBase } from '@core/lang/languages';
import type { SecretName } from '@core/config/schema';
import { api, useDevices, useSettings } from '../api';
import { ExternalLink } from '../components/ui';
import { guessMeetingDevice, guessVirtualMic } from '../content/guides';
import { TestPanel } from './Settings';
import { DriverInstaller } from '../components/DriverInstaller';

const KEY_INFO: Record<SecretName, { label: string; url: string; placeholder: string }> = {
  llm: { label: '智谱 GLM API Key', url: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys', placeholder: '' },
  dashscope: { label: '阿里云百炼 API Key', url: 'https://bailian.console.aliyun.com/?tab=model#/api-key', placeholder: 'sk-…' },
  // F0 (free tier) recognises one stream at a time: both directions at once need S0.
  azure: { label: 'Azure 语音服务 Key（双向同传需要标准层 S0，免费层 F0 只能翻一个方向）', url: 'https://portal.azure.com', placeholder: '' },
  azureTranslator: { label: 'Azure 翻译 Key（免费层 F0 即可）', url: 'https://portal.azure.com', placeholder: '' },
  deepl: { label: 'DeepL Key', url: 'https://www.deepl.com/pro-api', placeholder: '' },
};

const STEPS = ['选方案', '填 Key', '虚拟声卡'];

export function Onboarding({ onDone }: { onDone: () => void }) {
  const [s, update] = useSettings();
  const [step, setStep] = useState(0);
  const [choice, setChoice] = useState<PresetId>('free');
  const [keys, setKeys] = useState<Partial<Record<SecretName, string>>>({});
  const [platform, setPlatform] = useState('');
  const { inputs, outputs, refresh } = useDevices();
  useEffect(() => void api.app.info().then((i) => setPlatform(i.platform)), []);
  if (!s) return null;
  const p = PRESETS.find((x) => x.id === choice)!;
  const os = platform === 'darwin' ? 'mac' : platform === 'win32' ? 'win' : 'linux';
  const vm = guessVirtualMic(outputs);

  const finishPlan = async () => {
    await api.settings.applyPreset(choice);
    setStep(p.needs.length ? 1 : 2);
  };
  const startDemo = async () => {
    await api.settings.applyPreset('demo');
    await update({ onboarded: true });
    onDone();
  };
  const storeKeys = async () => {
    for (const [k, v] of Object.entries(keys)) if (v?.trim()) await api.secrets.set(k as SecretName, v.trim());
  };
  const saveKeys = async () => {
    await storeKeys();
    setStep(2);
  };
  const finish = async () => {
    const md = guessMeetingDevice(inputs, vm?.label);
    const loopbackOk = platform === 'darwin' || platform === 'win32';
    await update({
      onboarded: true,
      devices: {
        virtualMic: s.devices.virtualMic || vm?.deviceId || '',
        meetingSource: loopbackOk ? 'loopback' : md ? 'device' : 'none',
        meetingDevice: md?.deviceId ?? '',
      },
    });
    onDone();
  };

  return (
    <div style={{ maxWidth: 860, margin: '0 auto', padding: '36px 24px' }}>
      <div className="brand" style={{ fontSize: 20 }}>
        <img className="logo" src={logoUrl} alt="" />
        <h1 style={{ fontSize: 'inherit', margin: 0 }}>欢迎使用会议同传助手</h1>
      </div>
      <ol className="stepper" aria-label="设置步骤">
        {STEPS.map((name, i) => (
          <li key={name} className={i === step ? 'current' : i < step ? 'done' : ''} aria-current={i === step ? 'step' : undefined}>
            <span className="num">{i + 1}</span>
            {name}
          </li>
        ))}
      </ol>

      {step === 0 && (
        <div className="card">
          <h3>对方说什么语言？</h3>
          <div className="row" style={{ marginBottom: 18, flexWrap: 'wrap' }}>
            {REMOTE_CHOICES.map((c) => (
              <button
                key={c.base}
                className={`btn big ${lang(s.languages.remote).base === c.base ? 'primary' : ''}`}
                onClick={() => void update({ languages: { remote: withRemoteBase(s.languages.remote, c.base) }, out: { voice: '' }, in: { voice: '' } })}
              >
                {c.name}
              </button>
            ))}
          </div>
          <h3>翻译方案</h3>
          <div className="grid2">
            {PLANS().map((x) => (
              <button key={x.id} className={`preset ${choice === x.id ? 'active' : ''}`} onClick={() => setChoice(x.id)}>
                <h4>{x.name}</h4>
                {x.card && (
                  <dl className="plan-facts small">
                    <dt>准确</dt>
                    <dd>{x.card.accuracy}</dd>
                    <dt>声音</dt>
                    <dd>{x.card.voice}</dd>
                    <dt>需要</dt>
                    <dd>{x.card.takes}</dd>
                  </dl>
                )}
              </button>
            ))}
          </div>
          <div className="row between" style={{ marginTop: 16 }}>
            {/* The demo is not a plan: a way to look around first, never a meeting setup. */}
            <button data-test="safe" className="btn sm ghost" onClick={() => void startDemo()}>
              先看看演示（不会真的翻译）
            </button>
            <button className="btn primary big" onClick={finishPlan}>
              下一步
            </button>
          </div>
        </div>
      )}

      {step === 1 && (
        <div className="card">
          <h3>填写 Key</h3>
          <div className="stack">
            {p.needs.map((k) => (
              <label key={k} className="field">
                <span>
                  {KEY_INFO[k].label} <ExternalLink href={KEY_INFO[k].url}>获取 ↗</ExternalLink>
                </span>
                <input type="password" placeholder={KEY_INFO[k].placeholder} value={keys[k] ?? ''} onChange={(e) => setKeys({ ...keys, [k]: e.target.value })} />
              </label>
            ))}
          </div>
          <div className="row" style={{ marginTop: 16, justifyContent: 'space-between' }}>
            <button className="btn" onClick={() => setStep(0)}>
              上一步
            </button>
            <div className="row">
              <button className="btn ghost" onClick={() => setStep(2)}>
                稍后再填
              </button>
              <button className="btn primary big" onClick={saveKeys}>
                保存并继续
              </button>
            </div>
          </div>
          {Object.values(keys).some(Boolean) && (
            <div style={{ marginTop: 14 }}>
              {/* The plan just chosen, end to end (recognition → translation → voice), with the keys just typed. */}
              <TestPanel scope="out" label="测试一下：用这个方案翻译一句话" beforeRun={storeKeys} />
            </div>
          )}
        </div>
      )}

      {step === 2 && (
        <div className="card">
          <h3>虚拟声卡</h3>
          {vm ? (
            <dl className="facts">
              <dt>已装好</dt>
              <dd>{vm.label}</dd>
              <dt>会议软件的麦克风选</dt>
              <dd><b>{os === 'mac' ? 'BlackHole 2ch' : os === 'win' ? 'CABLE Output' : 'MI_Translated_Mic'}</b></dd>
            </dl>
          ) : (
            <DriverInstaller onDone={refresh} />
          )}
          <div className="row" style={{ marginTop: 16, justifyContent: 'space-between' }}>
            <button className="btn" onClick={() => setStep(p.needs.length ? 1 : 0)}>
              上一步
            </button>
            <button className={`btn big ${vm ? 'primary' : ''}`} onClick={finish}>
              {vm ? '完成' : '跳过，开始使用'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
