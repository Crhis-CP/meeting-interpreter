import { useEffect, useState } from 'react';
import logoUrl from '../assets/logo.png';
import { PRESETS, type PresetId } from '@core/config/presets';
import { lang, REMOTE_CHOICES, withRemoteBase } from '@core/lang/languages';
import type { SecretName } from '@core/config/schema';
import { api, useDevices, useSettings } from '../api';
import { ExternalLink } from '../components/ui';
import { DRIVER_GUIDES, guessMeetingDevice, guessVirtualMic } from '../content/guides';
import { TestPanel } from './Settings';
import { DriverInstaller } from '../components/DriverInstaller';

const KEY_INFO: Record<SecretName, { label: string; url: string; help: string }> = {
  llm: { label: '智谱 GLM（免费）API Key', url: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys', help: '注册智谱开放平台后在“API Keys”创建，GLM-4.7-Flash 免费。也可以在设置里换成 DeepSeek、通义或本机 Ollama。' },
  dashscope: { label: '阿里云百炼 API Key', url: 'https://bailian.console.aliyun.com/?tab=model#/api-key', help: '登录阿里云百炼控制台 › API Key 创建（sk- 开头）。新用户有免费额度。' },
  azure: { label: 'Azure 语音服务 Key', url: 'https://portal.azure.com', help: '在 Azure 门户创建“语音服务”，定价层选 F0（免费）。区域在设置里填写。' },
  azureTranslator: { label: 'Azure 翻译 Key', url: 'https://portal.azure.com', help: '在 Azure 门户创建“翻译”资源，定价层选 F0（每月 200 万字符免费）。' },
  deepl: { label: 'DeepL Key', url: 'https://www.deepl.com/pro-api', help: '' },
};

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
  const guide = DRIVER_GUIDES.find((g) => g.os === os)!;
  const vm = guessVirtualMic(outputs);

  const finishPlan = async () => {
    await api.settings.applyPreset(choice);
    setStep(p.needs.length ? 1 : 2);
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
        <div>
          欢迎使用会议同传助手
          <small>中文 ⇄ Español / English · 免费开源</small>
        </div>
      </div>
      <p className="muted">三步完成设置：选方案 → 填 Key → 装虚拟声卡。之后在任何会议软件里都能双向同传，也能开“现场房间”让大家用手机加入。</p>

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
          <h3>① 选择翻译方案（之后可在设置里随时更换）</h3>
          <div className="grid2">
            {PRESETS.map((x) => (
              <button key={x.id} className={`preset ${choice === x.id ? 'active' : ''}`} onClick={() => setChoice(x.id)}>
                <h4>
                  {x.name}
                  {x.id === 'free' && <span className="badge ok" style={{ marginLeft: 6 }}>推荐免费</span>}
                </h4>
                <p>{x.description}</p>
                <p className="muted small" style={{ marginTop: 6 }}>
                  费用：{x.cost}
                </p>
              </button>
            ))}
          </div>
          <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
            <button className="btn primary big" onClick={finishPlan}>
              下一步
            </button>
          </div>
        </div>
      )}

      {step === 1 && (
        <div className="card">
          <h3>② 填写 Key（只保存在本机，加密存储）</h3>
          <div className="stack">
            {p.needs.map((k) => (
              <div key={k} className="stack" style={{ gap: 4 }}>
                <b>{KEY_INFO[k].label}</b>
                <input type="password" placeholder="粘贴到这里" value={keys[k] ?? ''} onChange={(e) => setKeys({ ...keys, [k]: e.target.value })} />
                <span className="muted small">
                  {KEY_INFO[k].help} <ExternalLink href={KEY_INFO[k].url}>去获取</ExternalLink>
                </span>
              </div>
            ))}
            {choice === 'free' && (
              <div className="callout info">
                免费方案的语音识别在本机离线完成（首次开会自动下载约 500MB 模型），语音合成使用系统自带声音。Windows 若没有西班牙语或英语语音，请在“设置 › 时间和语言 › 语音”里添加。
              </div>
            )}
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
              <TestPanel scope="llm" label="测试一下（会先保存 Key）" beforeRun={storeKeys} />
            </div>
          )}
        </div>
      )}

      {step === 2 && (
        <div className="card">
          <h3>③ 让会议软件听到译音：安装虚拟声卡</h3>
          {vm ? (
            <div className="callout info">✅ 已装好虚拟麦克风：{vm.label}</div>
          ) : (
            <>
              <p className="muted" style={{ marginTop: 0 }}>用 Teams、飞书、腾讯会议等<b>电脑客户端</b>开会时需要它。只用网页版会议（装 Chrome 插件）或现场房间，可以跳过。</p>
              <DriverInstaller onDone={refresh} />
            </>
          )}
          {vm && (
            <p className="hint">最后一步：开会时在会议软件的“音频设置”里，把<b>麦克风</b>选成 <b>{os === 'mac' ? 'BlackHole 2ch' : os === 'win' ? 'CABLE Output' : 'MI_Translated_Mic'}</b>。</p>
          )}
          <div className="row" style={{ marginTop: 16, justifyContent: 'space-between' }}>
            <button className="btn" onClick={() => setStep(p.needs.length ? 1 : 0)}>
              上一步
            </button>
            <button className="btn primary big" onClick={finish}>
              完成，开始使用
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
