<p align="center">
  <img src="build/icon.png" width="120" alt="会议同传助手">
</p>

<h1 align="center">会议同传助手 · Meeting Interpreter</h1>

<p align="center">
  <b>中文 ⇄ 西班牙语 / 英语 实时同声传译</b><br>
  你说中文，对方在会议里直接听到西班牙语或英语；对方说外语，你直接听到中文、看到中文字幕。<br>
  支持 Teams、飞书、腾讯会议、Zoom、钉钉等任何会议软件，也能开“现场房间”让大家用手机扫码加入。<br>
  免费开源 · macOS / Windows / Linux
</p>

<p align="center">
  <a href="https://github.com/Crhis-CP/meeting-interpreter/releases/latest"><b>⬇ 下载最新版</b></a>
  ·
  <a href="#三分钟上手">三分钟上手</a>
  ·
  <a href="#手机怎么用">手机怎么用</a>
  ·
  <a href="#常见问题">常见问题</a>
</p>

---

## 它能做什么

| 功能 | 说明 |
|---|---|
| 🎧 **会议里的双向语音同传** | 你说中文 → 对方在会议里听到西语或英语；对方说外语 → 你在耳机里听到中文（原声自动压低）。两个方向可分别开关。 |
| 💬 **实时双语字幕** | 置顶的字幕窗，默认不会出现在屏幕共享和录屏里。 |
| 📱 **现场房间（手机）** | 面对面开会或拜访客户时，电脑开一个房间，大家用手机扫码加入、选语言、戴耳机，就是同声传译。手机不用装 App。还能生成公网链接，远程参会的人也能加入。 |
| 📖 **术语表** | 公司名、产品名、人名、行业词的固定译法；用于识别热词、识别纠错（含拼音近音纠错）、翻译和纪要。支持 Excel/CSV 导入导出。 |
| 📝 **会议记录** | 每句话的原文和译文、时间、说话方；导出 Markdown 和中文/西文/双语 SRT 字幕。 |
| 🧾 **双语会议纪要** | 会后自动生成中文和西班牙文（或英文）两份纪要：摘要、议题、结论、待办（负责人、截止时间），每条都能对应到原话。 |
| 🎙️ **录音录屏** | 全程混音录音（双方原声 + 双方译音），可选录屏（带混音音轨），另存两路原声 WAV。 |
| 💰 **可以完全免费** | 本机离线识别 + 免费大模型翻译 + 系统自带语音；也可以用阿里云百炼、Azure 获得更好的效果。 |

## 下载安装

到 [Releases 页面](https://github.com/Crhis-CP/meeting-interpreter/releases/latest) 下载对应的文件：

| 电脑 | 下载哪个 |
|---|---|
| Mac（M1/M2/M3/M4 等 Apple 芯片） | `MeetingInterpreter-版本号-mac-arm64.dmg` |
| Mac（Intel 芯片） | `MeetingInterpreter-版本号-mac-x64.dmg` |
| Windows 10 / 11 | `MeetingInterpreter-版本号-windows-x64-setup.exe` |
| Linux | `MeetingInterpreter-版本号-linux-x86_64.AppImage` |

**Mac 第一次打开**：本软件免费开源，没有购买苹果开发者证书，所以第一次打开会提示“无法验证开发者”。
1. 把应用拖进“应用程序”文件夹后双击打开，出现提示时点“完成”；
2. 打开 **系统设置 › 隐私与安全性**，往下找到“已阻止打开 MeetingInterpreter”，点 **仍要打开**；
3. 如果提示“已损坏”，在终端运行：`xattr -cr /Applications/MeetingInterpreter.app`，再打开。

**Windows 第一次打开**：SmartScreen 提示时点“更多信息” › “仍要运行”。

## 三分钟上手

1. **选方案、填 Key**（首次启动的引导会带你做）
   - **免费方案**：语音识别在本机离线完成（首次自动下载模型），翻译和纪要用免费的智谱 GLM-4.7-Flash（[注册拿免费 Key](https://bigmodel.cn/usercenter/proj-mgmt/apikeys)），语音用系统自带声音。
   - **阿里云百炼（效果最好）**：一个 Key 搞定识别、翻译、自然人声、纪要，国内直连，延迟低。[获取 Key](https://bailian.console.aliyun.com/?tab=model#/api-key)，新用户有免费额度。
   - **Azure**：微软语音和翻译，支持 Azure 中国区。
   - **演示模式**：不填任何 Key，先看看界面和流程。
2. **安装虚拟声卡**（让会议软件“听到”译音）
   - Mac：安装 [BlackHole 2ch](https://existential.audio/blackhole/)（或终端 `brew install blackhole-2ch`）
   - Windows：安装 [VB-CABLE](https://vb-audio.com/Cable/)（解压后以管理员身份运行安装程序，重启电脑）
3. **在会议软件里改麦克风**：把 Teams / 飞书 / 腾讯会议的麦克风选成 **BlackHole 2ch**（Mac）或 **CABLE Output**（Windows）。扬声器保持你的耳机。
4. **在本软件里点“开始同传”**，戴上耳机开会。

> 应用里的“使用指南”页有 Teams、飞书、腾讯会议、Zoom、钉钉、企业微信的逐步设置说明。

### 声音是怎么走的

```
你说中文 ─► 麦克风 ─► 本软件（识别→翻译→合成外语）─► 虚拟麦克风 ─► 会议软件 ─► 对方听到西语/英语
对方说外语 ─► 会议软件 ─► 系统声音 / 虚拟扬声器 ─► 本软件（识别→翻译→合成中文）─► 你的耳机
```

- macOS 14.2+ 和 Windows 11 可以直接采集“系统声音”，并自动排除本软件自己播放的译音，不需要第二个虚拟声卡。
- Windows 10 / Linux，或想让对方原声在播放中文译音时自动变小，可以再装一个虚拟声卡当“虚拟扬声器”（Mac：BlackHole 16ch；Windows：VB-Audio Hi-Fi Cable / VoiceMeeter）。

## 手机怎么用

手机系统不允许任何 App 把声音送进别的会议 App，所以手机上的同传是通过 **现场房间** 网页实现的：

- **面对面开会 / 拜访客户**：电脑上打开“现场房间” → “开启房间”，大家用手机扫二维码，填名字、选“中文”或“Español / English”，戴上耳机。说话时按住手机上的大按钮，其他语言的人就会在耳机里听到翻译，同时看到双语字幕。
- **远程（视频会议里的人）**：在房间里打开“公网链接”（免费的 Cloudflare 临时链接），把链接发给对方，对方在手机或电脑浏览器打开即可。
- 第一次开启房间时，电脑可能询问是否允许“接受传入的网络连接”，请选择允许。酒店、公司访客 Wi-Fi 常禁止设备互连，扫码打不开时改用手机热点或公网链接。
- 手机第一次打开局域网链接会提示“连接不安全”：这是因为房间运行在你自己的电脑上。iPhone 点“显示详细信息 › 访问此网站”，安卓点“高级 › 继续前往”。公网链接没有这个提示。

## 费用

软件本身免费。翻译服务按你选的方案：

| 方案 | 费用 | 说明 |
|---|---|---|
| 免费方案 | 0 元 | 本机离线识别 + 智谱 GLM-4.7-Flash（免费，并发较低）+ 系统语音；也可把翻译换成本机 Ollama，完全离线 |
| 阿里云百炼 | 约 2–4 元/小时（双向） | 新用户有免费额度；效果和延迟最好 |
| Azure | 免费层 F0 每月有固定额度 | 免费层同一时间只能识别一路；双向同传用标准层 |

## 隐私

- 会议记录、录音、录屏、术语表都只保存在你的电脑上（默认在“文稿/MeetingInterpreter”）。
- API Key 用系统钥匙串加密保存，不会写进日志和导出文件。
- 使用云服务时，语音或文字会发送给你选择的服务商；免费方案的语音识别完全在本机进行。
- 录音录屏前请征得参会者同意。

## 常见问题

- **对方听不到译音？** 会议软件的麦克风要选虚拟声卡的另一端（Mac：BlackHole 2ch；Windows：CABLE Output）。在“设置 › 音频设备”点“试音”测试。
- **译音小声、断断续续？** 把会议软件的“降噪”调低或关闭，关闭“自动调节麦克风音量”。
- **我自己的译音又被翻译了一遍？** 请戴耳机；“系统声音”模式需要 macOS 14.2+ / Windows 11，否则改用“虚拟扬声器”。
- **延迟多少？** 一般说完一句后 1.5–3 秒开始播放译音；长句会按分句提前翻译。译音排队太多时会自动加快语速，也可以点“跳到最新”。
- **我想直接说外语？** 打开“原声直通”，你的原声会直接送进会议。
- **只想看字幕不想听中文语音？** 在会议页关掉“播放中文译音”。
- **怎么测试 Key 是否可用？** “设置 › 翻译服务”里每个方向都有“测试”按钮：先合成一句话、再识别、再翻译、再合成，逐步显示哪一步有问题。

## 开发

需要 Node.js 22+。

```bash
npm install
npm run dev          # 开发模式启动
npm test             # 单元测试
npm run typecheck    # 类型检查
npm run build && xvfb-run -a npx playwright test   # 端到端测试（Linux）
npm run dist         # 打包当前平台的安装包
```

发布新版本：在 `CHANGELOG.md` 写好更新内容，把 `package.json` 的 `version` 改成新版本号并推送到 main，GitHub Actions 会自动打标签、构建 macOS / Windows / Linux 安装包并发布到 Releases（也可以推送 `v版本号` 标签触发）。

项目结构和设计见 [docs/superpowers/specs](docs/superpowers/specs/2026-11-20-meeting-interpreter-design.md)。

## 路线图

- 端到端实时同传模型（通义 LiveTranslate、OpenAI gpt-realtime-translate）
- 只采集指定会议软件的声音（不需要任何虚拟声卡）
- 说话人区分、声音克隆
- 手机单机“面对面翻译”网页版

## 致谢

设计参考了这些优秀的开源项目：[知了 Cicada](https://github.com/wquguru/cicada)（Apache-2.0）、[Parrots](https://github.com/smitea/parrots)（MIT）、[会译 HuiYi](https://github.com/LingyiChen-AI/huiyi)（Apache-2.0）、[electron-audio-loopback](https://github.com/alectrocute/electron-audio-loopback)（MIT）。本机识别使用 [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)（Apache-2.0）和 SenseVoice / Whisper 模型。详见 [NOTICE](NOTICE)。

## 开源协议

[MIT](LICENSE)
