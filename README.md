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
| 🧩 **Chrome 插件** | 网页版会议装上插件就能用：对方在会议里听到译音，你看中文悬浮字幕，不用装虚拟声卡。 |
| 🎧 **会议里的双向语音同传** | 你说中文 → 对方在会议里听到西语或英语；对方说外语 → 你在耳机里听到中文（原声自动压低）。两个方向可分别开关。 |
| 💬 **实时双语字幕** | 置顶的字幕窗，默认不会出现在屏幕共享和录屏里。 |
| 📱 **现场房间（手机）** | 面对面开会或拜访客户时，电脑开一个房间，大家用手机扫码加入、选语言、戴耳机，就是同声传译。手机不用装 App。还能生成公网链接，远程参会的人也能加入。 |
| 📖 **术语表** | 公司名、产品名、人名、行业词的固定译法；用于识别热词、识别纠错（含拼音近音纠错）、翻译和纪要。支持 Excel/CSV 导入导出。 |
| 📝 **会议记录** | 每句话的原文和译文、时间、说话方；导出 Markdown 和中文/西文/双语 SRT 字幕。 |
| 🗣️ **用我的声音** | 可选：录 16 秒，对方听到的翻译就是你自己的音色（阿里云百炼声音复刻）。 |
| 🧾 **双语会议纪要** | 会后自动生成中文和西班牙文（或英文）两份纪要：摘要、议题、结论、待办（负责人、截止时间），每条都能对应到原话。 |
| 🎙️ **录音录屏** | 全程混音录音（双方原声 + 双方译音），可选录屏（带混音音轨），另存两路原声 WAV。 |
| 💰 **可以完全免费** | 本机离线识别 + 免费大模型翻译 + 系统自带语音；也可以用阿里云百炼、Azure 获得更好的效果。 |

## 下载安装

**下载网站：<https://crhis-cp.github.io/meeting-interpreter/>** · **[新手上手（按场景，三四步就能用）](https://crhis-cp.github.io/meeting-interpreter/guide.html)**（自动识别你的电脑，点一下就下载）。也可以到 [Releases 页面](https://github.com/Crhis-CP/meeting-interpreter/releases/latest) 下载对应的文件：

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
2. **安装虚拟声卡**（让会议软件“听到”译音）：软件里点 **“一键安装虚拟麦克风”** 即可自动下载安装。也可以手动安装：
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

## 网页版会议：Chrome 插件（装上就能用）

开网页版会议（Teams、Google Meet、飞书、腾讯会议、Zoom、Webex 网页版）时，用 Chrome 插件最省事：**不用装虚拟声卡，不用改会议设置，对方什么都不用装。**

- 你说中文 → 对方在会议里直接听到西班牙语或英语（你的原声不会传过去）
- 对方说话 → 会议页面上出现中文悬浮字幕（可拖动、调字号）
- 会后在插件“会议记录”里下载双语记录、生成中外文会议纪要

**安装**（上架 Chrome 应用商店之前）：
1. 在 [Releases](https://github.com/Crhis-CP/meeting-interpreter/releases/latest) 下载 `meeting-interpreter-chrome-版本号.zip`，解压成一个文件夹；
2. Chrome 地址栏打开 `chrome://extensions`，打开右上角 **开发者模式**；
3. 点 **加载已解压的扩展程序**，选刚才的文件夹。Edge 浏览器同理（`edge://extensions`）。

**用法**：打开会议网页、入会 → 点浏览器右上角插件图标 → 选对方语言和方案 → **开始同传**。（插件装好之前就已经在会议里的话，刷新页面重新入会。）

| 方案 | 需要什么 | 花费 |
|---|---|---|
| **免费版** | 电脑上同时打开本软件（桌面客户端），一个免费的智谱 Key | 免费 |
| **高级版** | 一个阿里云百炼 Key（准确度最高、声音最自然） | 新用户有免费额度，之后约 2–4 元/小时 |
| Azure / 自己组合 | 对应服务的 Key | 按服务计费 |

## 安卓手机：面对面对话

在 [下载网站](https://crhis-cp.github.io/meeting-interpreter/) 用安卓手机打开，点“下载安卓版”安装。把手机放在你们中间：

- **免按键**：一直在听，谁说都行。听出是中文就用外语念出来，听出是外语就用中文念出来；手机念的时候自动不收音，不会把自己的声音再翻一遍。
- **按住说话**：按住大按钮说，松开就翻（周围吵的时候用）。
- 需要一个阿里云百炼 Key（设置里点“去获取 Key”）。苹果手机请用电脑上的“现场房间”扫码使用。

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
npm run build:mobile && (cd android && ./gradlew assembleRelease)   # 安卓 APK（需要 Android SDK）
```

发布新版本：在 `CHANGELOG.md` 写好更新内容，把 `package.json` 的 `version` 改成新版本号并推送到 main，GitHub Actions 会自动打标签、构建 macOS / Windows / Linux 安装包并发布到 Releases（也可以推送 `v版本号` 标签触发）。

安卓 APK 默认用仓库里公开的 `android/app/community.keystore` 签名（这样每个新版本都能覆盖安装旧版本）；正式分发可以设置环境变量 `MI_KEYSTORE`、`MI_KEYSTORE_PASSWORD`、`MI_KEY_ALIAS` 换成自己的私有签名。

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
