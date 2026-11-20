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
      <h1 className="page-title">使用指南</h1>
      <p className="page-sub">原理：本应用把外语（西语/英语）译音送进一个“虚拟麦克风”，会议软件把它当成你的麦克风；同时听会议声音，把中文译音播到你的耳机。所以支持任何会议软件。</p>

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
                <button key={l.url} className="btn sm" onClick={() => void api.app.openExternal(l.url)}>
                  {l.label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="card">
        <h3>手机怎么用</h3>
        <ol className="steps">
          <li><b>现场开会 / 面对面：</b>在电脑上打开“现场房间”，大家扫码加入，各自选语言、戴耳机。</li>
          <li><b>对方在远程（视频会议）：</b>在“现场房间”打开“公网链接”，把链接发给对方，对方用手机或电脑浏览器打开即可加入。</li>
          <li>手机系统不允许 App 把声音送进别的会议 App，所以手机上的同传通过“房间”网页实现，不需要安装任何 App。</li>
        </ol>
      </div>

      <div className="card">
        <h3>常见问题</h3>
        <ul className="steps">
          <li><b>对方听不到译音？</b>检查会议软件的麦克风是否选了虚拟声卡的另一端（Mac：BlackHole 2ch；Windows：CABLE Output），并在设置里点“试音”。</li>
          <li><b>译音断断续续或很小声？</b>把会议软件的“降噪”调低或关闭，关闭“自动调节麦克风音量”。</li>
          <li><b>翻译了自己的译音 / 重复翻译？</b>请戴耳机；Mac 需 14.2 以上才能在“系统声音”模式下排除自己的声音，否则改用“虚拟扬声器”模式。</li>
          <li><b>原声和中文译音叠在一起听不清？</b>“系统声音”模式下原声由会议软件直接播放，本软件无法自动压低：把会议软件的音量调小一些，或改用“虚拟扬声器”模式（会在播放中文时自动压低原声）。</li>
          <li><b>延迟多少？</b>通常说完一句后 1.5–3 秒开始播放译音。长句会按分句提前翻译。</li>
          <li><b>费用？</b>软件免费。免费方案不花钱；阿里云百炼约每小时几元，新用户有免费额度。</li>
          <li><b>隐私？</b>记录和录音只保存在你的电脑。使用云服务时，语音/文字会发给你选择的服务商；免费方案的识别在本机完成。</li>
        </ul>
      </div>
    </div>
  );
}
