import { useEffect, useState } from 'react';
import { api } from '../api';
import { DRIVER_GUIDES, MEETING_APPS } from '../content/guides';

export function GuidePage() {
  const [platform, setPlatform] = useState('');
  const [app, setApp] = useState('teams');
  useEffect(() => {
    void api.app.info().then((i) => setPlatform(i.platform));
    void api.app.detectMeetingApps().then((apps) => apps[0] && setApp(apps[0]));
  }, []);
  const os = platform === 'darwin' ? 'mac' : platform === 'win32' ? 'win' : 'linux';
  const g = MEETING_APPS.find((x) => x.id === app)!;
  return (
    <div>
      <header className="row between" style={{ marginBottom: 16 }}>
        <h1 className="page-title">使用指南</h1>
        <button className="btn sm" onClick={() => void api.app.openExternal('https://crhis-cp.github.io/meeting-interpreter/guide.html')}>
          网页版新手上手
        </button>
      </header>

      <div className="card">
        <h3>声音怎么走</h3>
        <pre style={{ background: '#f6f7f9', padding: 12, borderRadius: 8, overflow: 'auto', fontSize: 12.5, lineHeight: 1.6 }}>
{`你说中文 ─► 麦克风 ─► 本应用（识别→翻译→合成外语）─► 虚拟麦克风 ─► 会议软件 ─► 对方听到西语/英语
对方说外语 ─► 会议软件 ─► 系统声音/虚拟扬声器 ─► 本应用（识别→翻译→合成中文）─► 你的耳机`}
        </pre>
      </div>

      <div className="card">
        <h3>在会议软件里怎么设置</h3>
        <div className="tabs">
          {MEETING_APPS.map((a) => (
            <button key={a.id} className={`tab ${app === a.id ? 'active' : ''}`} onClick={() => setApp(a.id)}>
              {a.name}
            </button>
          ))}
        </div>
        <ol className="steps">
          {g.steps.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ol>
        {g.tips.length > 0 && (
          <div className="callout">
            {g.tips.map((t) => (
              <div key={t}>💡 {t}</div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <h3>安装虚拟声卡</h3>
        {DRIVER_GUIDES.filter((d) => d.os === os || !platform).map((d) => (
          <div key={d.os}>
            <b>{d.title}</b>
            <ol className="steps">
              {d.steps.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ol>
            <div className="row">
              {d.links.map((l) => (
                <button key={l.url} data-test="safe" className="btn sm" onClick={() => void api.app.openExternal(l.url)}>
                  {l.label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <section className="card" aria-labelledby="g-room">
        <h3 id="g-room">现场房间（手机 / 面对面 / 远程的人）</h3>
        <p className="small muted">手机系统不允许 App 把声音送进别的会议 App，所以手机上的同传都通过“房间”网页：不用装 App，扫码就能用。</p>
        <ol className="steps">
          <li>电脑和手机连同一个 Wi-Fi（或手机热点）；不在现场的人（视频会议里的对方）用“公网链接”，把链接发给他们，用手机或电脑浏览器打开即可。</li>
          <li>点“开启房间”，大家用手机相机扫二维码，填名字、选语言、戴耳机。</li>
          <li>按住手机上的大按钮说话（或切到持续说话），其他语言的人会听到译音、看到双语字幕。</li>
          <li>电脑也可以直接说话（主持人）。关闭房间后，记录和录音保存在“会议记录”里。</li>
        </ol>
        <ul className="steps">
          <li><b>手机提示“连接不安全/证书无效”？</b>房间运行在你自己的电脑上：iPhone 点“显示详细信息 → 访问此网站”，安卓点“高级 → 继续前往”。公网链接没有这个提示。</li>
          <li><b>用微信扫码打不开、或者没法说话？</b>用手机自带的相机扫码，或在微信里点右上角“…”选“在浏览器打开”（微信里的网页常常用不了麦克风）。</li>
          <li><b>手机扫码打不开？</b>酒店、公司访客 Wi-Fi 常禁止设备互连：改用手机热点或公网链接。第一次开房间时系统询问是否允许网络连接，请允许（Windows 勾选“专用网络”）。</li>
        </ul>
      </section>

      <div className="card">
        <h3>常见问题</h3>
        <ul className="steps">
          <li><b>对方听不到译音？</b>检查会议软件的麦克风是否选了虚拟声卡的另一端（Mac：BlackHole 2ch；Windows：CABLE Output），并在设置里点“试音”。</li>
          <li><b>不用同传时对方听不到我？</b>会议软件的麦克风还选着虚拟声卡：改回你自己的麦克风。Teams、腾讯会议等可以在会议里临时切换设备，只对这场会生效，会后不用改回。</li>
          <li><b>装了虚拟声卡以后电脑没声音？</b>Windows 有时会把 VB-CABLE 设成默认设备。本软件会在装完后自动改回；如果还是没声音，会议页会提示，点“改回原来的设备”即可。</li>
          <li><b>译音断断续续或很小声？</b>把会议软件的“降噪”调低或关闭，关闭“自动调节麦克风音量”。</li>
          {window.platform === 'win32' && (
            <li>
              <b>Windows：一开会，你听到的中文译音就变小？</b>Windows 默认“检测到通话时把其他声音减小 80%”。在 声音 › 通信 里选“不执行任何操作”。{' '}
              <button data-test="safe" className="btn sm" onClick={() => void api.audio.openCommunicationsSettings()}>打开这个设置</button>
            </li>
          )}
          <li><b>翻译了自己的译音 / 重复翻译？</b>请戴耳机；Mac 需 14.2 以上才能在“系统声音”模式下排除自己的声音，否则改用“虚拟扬声器”模式。</li>
          <li><b>原声和中文译音叠在一起听不清？</b>“系统声音”模式下原声由会议软件直接播放，本软件无法自动压低：把会议软件的音量调小一些，或改用“虚拟扬声器”模式（会在播放中文时自动压低原声）。</li>
          <li><b>延迟多少？</b>通常说完一句后 1.5–3 秒开始播放译音。长句会按分句提前翻译。</li>
          <li><b>费用？</b>软件免费。免费方案（本机识别 + 本机 AI 翻译）不花钱；阿里云百炼约每小时几元，新用户有免费额度。</li>
          <li><b>隐私？</b>记录和录音只保存在你的电脑。使用云服务时，语音/文字会发给你选择的服务商；免费方案的识别和翻译都在本机完成。</li>
        </ul>
      </div>
    </div>
  );
}
