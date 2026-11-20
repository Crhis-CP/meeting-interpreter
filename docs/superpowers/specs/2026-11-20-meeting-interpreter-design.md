# 会议同传助手（Meeting Interpreter）设计文档

日期：2026-11-20 · 状态：v1 设计（用户已授权自主决策，本文中“我的决定”均可在评审时推翻）

## 1. 要做什么、为什么

用户（中文母语）经常和讲西班牙语的人开线上会，会议软件不固定：Microsoft Teams、飞书、腾讯会议，以后还有别的。需要一个装在自己电脑上的小工具：

- **我说中文 → 对方在会议里直接听到西班牙语**（同声传译语音，不是字幕）。
- **对方说西班牙语 → 我这边直接听到中文**（同时可看双语字幕）。
- 能**自定义术语**（公司名、产品名、行业词的固定译法）。
- 自动生成**会议对话记录**（双语逐句）、**中文 + 西班牙文会议总结**、**会议录音和录屏**。
- 第一版只做**中文 ⇄ 西班牙语**，架构上留好扩展到英语等其他语言。

成功标准：用户装好后，在 Teams / 飞书 / 腾讯会议里只改一下麦克风和扬声器选项，就能双向同传；会后在本地拿到双语记录、中西文纪要、录音录屏。

用户后续补充的要求（2026-11-20 晚）：
- **只要最终成品**：在 GitHub 仓库右侧 **Releases** 直接下载安装包安装，不需要自己编译。
- 用户自己用 **Mac**（所以 macOS 是第一优先平台），也希望**手机**上能用。
- **尽量免费**，让大家都能免费使用。
- 仓库和代码全权交给我。

## 2. 目标 / 非目标 / 反目标

**目标（v1）**
1. Windows 10/11 与 macOS 13+ 桌面应用（Linux 可用于开发和测试）。
2. 与任何会议软件配合：不接入会议平台 API，不往会里塞机器人；靠虚拟音频设备。
3. 双向语音同传（中→西、西→中），各自可单独开关；双语实时字幕悬浮窗。
4. 术语表：多套术语表、导入导出 CSV、影响识别、翻译、纠错和纪要。
5. 会议记录：逐句双语记录（JSON/Markdown/SRT/VTT）、中西文纪要（Markdown + JSON）、录音（各路原声 + 混音）、录屏（含混音音轨）。
6. 可插拔的服务商：阿里云百炼（国内首选）、Azure 语音（含 Azure 中国）、OpenAI、DeepL、任意 OpenAI 兼容大模型（DeepSeek、通义、Kimi、豆包、Ollama 等）；演示模式无需任何 key。
7. 中文界面；Key 加密保存在本机；记录只存本地。

**非目标（v1 不做）**
- 会议机器人 / 平台插件（Teams Bot、飞书应用等）——以后可作为“平台适配器”的深度集成。
- 声音克隆、说话人分离（diarization）、离线本地模型——列入路线图。
- 移动端。

**反目标（做出来也算失败的情况）**
- 把**没翻译的原话**或**错误语言的内容**说进会议（宁可不发声）。
- 自己的译音被自己再采集一遍，形成回授/循环翻译。
- 延迟越积越大（译音排队几十秒）却没有任何追赶手段。
- Key 出现在日志、导出文件或录音元数据里。

## 3. 调研：借鉴了哪些开源项目

| 项目 | 协议 | 借鉴点 |
|---|---|---|
| [wquguru/cicada 知了](https://github.com/wquguru/cicada)（2.4k★） | Apache-2.0 | 产品形态几乎一致：听系统声音出双语字幕和纪要，按住说话把译音经 VB-Cable/BlackHole 说进会议。借鉴：分段规则（停顿 0.6s 切段、满 8s 在最后 2s 最安静处切）、“没翻译成功就不发声”、按住说话 + 免按键两种模式、纪要 JSON 结构（议题/要点/结论/待办都带原句证据 id）、翻译提示词（“只输出译文，不要回答问题”）、字幕窗不进屏幕共享 |
| [smitea/parrots](https://github.com/smitea/parrots) | MIT | 双向：虚拟麦克风（对方听译音）+ 虚拟扬声器（采集对方声音）两路虚拟设备；按分句提前提交（标点或 ≥400ms 微停顿且 ≥6 字）；拼音模糊匹配纠正专有名词 |
| [LingyiChen-AI/huiyi 会译](https://github.com/LingyiChen-AI/huiyi) | Apache-2.0 | 词库同时作用于识别纠错、翻译和纪要；纪要模板（周会、客户拜访等）；右 Ctrl 按住说话 |
| [alectrocute/electron-audio-loopback](https://github.com/alectrocute/electron-audio-loopback) | MIT | Electron 里无需驱动采集系统声音（Win/mac/Linux 的 Chromium 开关与 `setDisplayMediaRequestHandler` 用法） |
| [ConstantinopleMayor/gummy-translator](https://github.com/ConstantinopleMayor/gummy-translator) | MIT | 百炼 Gummy 实时翻译 + CosyVoice 流式合成的调用方式 |

结论：**不 fork**。知了是四套原生代码（Swift / C# / Python / Kotlin），且只做“说出去”方向的语音；我们要双向语音、录屏、双语纪要，用一套跨平台代码更省维护。借鉴其设计和规则，个别算法/提示词按 Apache-2.0 注明出处。

## 4. 方案比较（怎么做）

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| A. **Electron + TypeScript 桌面应用 + 虚拟音频设备** | 一套代码覆盖 Win/mac/Linux；Web Audio 可把声音送到指定输出设备（`setSinkId`）；MediaRecorder 自带录屏录音；界面开发快；能在 Linux CI 里用假音频跑端到端测试 | 安装包较大（~100MB）；“只采会议软件声音”需要原生辅助程序（路线图） | **采用** |
| B. 各平台原生（Swift + C#），学知了 | 最省资源、系统集成最好 | 两三套代码，一晚上做不完，也难测 | 不采用 |
| C. Python（PySide + sounddevice） | 音频/AI 生态好 | 打包脆弱、录屏要自带 ffmpeg、界面难看 | 不采用 |
| D. 会议机器人（Teams Bot / Zoom SDK） | 无需虚拟声卡 | 每个平台一套审批和 SDK，飞书/腾讯会议基本不开放媒体流 | 不采用（以后可做） |

## 5. 总体架构

```
┌────────────────── Electron 主进程（Node） ──────────────────┐
│ AppController：窗口、托盘、全局快捷键、IPC                  │
│ SettingsStore / SecretStore(safeStorage) / GlossaryStore     │
│ SessionManager：一场会议 = 一个文件夹                       │
│   ├─ Pipeline「出」：我方麦克风 → ASR(zh) → 翻译 → TTS(es)   │
│   ├─ Pipeline「入」：会议声音 → ASR(es) → 翻译 → TTS(zh)     │
│   ├─ TranscriptStore（transcript.jsonl，边开边写，防崩溃）  │
│   ├─ Recorder（原声 WAV、录屏/混音文件分块写盘）             │
│   └─ SummaryService（会后/手动：中西文纪要）                 │
│ Providers：百炼 / Azure / OpenAI / DeepL / OpenAI 兼容 / 演示 │
└───────────────▲──────────────────────────┬───────────────────┘
   PCM 16k 帧（MessagePort）               │ TTS 音频块、字幕事件
┌───────────────┴────────── 隐藏的音频窗口（渲染进程）───────────────┐
│ AudioEngine（Web Audio）                                            │
│   采集：getUserMedia(麦克风)、getUserMedia(虚拟扬声器) 或系统回环   │
│   AudioWorklet → 16kHz Int16 → 主进程                               │
│   播放：TTS(es) → 虚拟麦克风设备；TTS(zh)+压低的原声 → 耳机         │
│   录制：MediaRecorder(混音) + 屏幕视频轨 → 分块发给主进程写盘       │
└─────────────────────────────────────────────────────────────────────┘
   主窗口（React 界面）            字幕悬浮窗（置顶、透明、不进屏幕共享）
```

- **核心引擎放在 `src/core/`，纯 TypeScript、不依赖 Electron**：可在 Node 里单测，也给命令行工具复用（用 WAV 文件跑完整流程）。
- **音频放在隐藏窗口**：主界面关掉（缩到托盘）时同传不中断；`backgroundThrottling: false`。
- 我的决定：引擎先跑在主进程（都是网络 I/O，负担小）；以后有本地模型再挪到 `utilityProcess`。

## 6. 音频路由（关键）

### 6.1 出（我说中文 → 对方听西语）
物理麦克风（开启回声消除/降噪）→ 引擎 → 西语 TTS → 播放到**虚拟麦克风设备**的“输入端”：

| 系统 | 我们播放到 | 会议软件麦克风选 | 驱动 |
|---|---|---|---|
| Windows | `CABLE Input (VB-Audio Virtual Cable)` | `CABLE Output` | VB-CABLE（免费，捐赠软件，引导用户从官网下载） |
| macOS | `BlackHole 2ch` | `BlackHole 2ch` | BlackHole（GPL，不打包，引导安装 / `brew install blackhole-2ch`） |
| Linux | `mi_virtual_mic` null-sink | 对应的虚拟源 | 应用用 `pactl` 自动创建 |

可选：把原声以低音量混进去（“原声垫底”，默认关）；“原声直通”开关（自己想说西语/英语时，直接把麦克风原声送进会议）。

### 6.2 入（对方说西语 → 我听中文）
两种采集方式，设置里选：
1. **虚拟扬声器（推荐，听中文语音时用）**：会议软件的扬声器选第二个虚拟设备（Windows：VB-Audio Hi-Fi Cable / CABLE-A / VoiceMeeter AUX；macOS：BlackHole 16ch；Linux：自动建的第二个 null-sink），应用从它采集，再把**压低的原声 + 中文译音**播到真实耳机。完全不会采到自己的译音。
2. **系统声音回环（零配置）**：用 Chromium 的系统回环采集（electron-audio-loopback 的做法）。问题是它可能也采到我们自己播放的中文译音，具体处理见第 13 节调研结论；默认在此模式下只出字幕，中文语音需用户确认后开启。

### 6.3 防回授规则（硬规则）
- 我们自己的 TTS 永远不送进任何一路采集（路由层面保证）。
- 推荐戴耳机；麦克风默认开回声消除。
- 出方向的翻译只在“持续同传”或“按住说话”时发声；“静音”快捷键一键停止外发。
- 绝不把未翻译文本或语言不对的结果说进会议（语言校验失败就丢弃，只写入记录并标注）。

## 7. 同传引擎（每个方向一条 Pipeline）

```
PCM 帧 → [闸门：静音/按住说话/直通] → 流式 ASR（部分结果 + 断句结果）
      → Committer：决定“翻译单元”
          · ASR 给出句末（final）→ 提交剩余部分
          · 低延迟模式：部分结果出现分句标点且已稳定 ≥ 700ms、≥ 6 个字（西语 ≥ 4 词）→ 提前提交稳定前缀
          · 超过 12s 没有句末 → 强制提交
      → 纠错：术语别名替换 + 中文拼音模糊匹配（可关）
      → 翻译（带术语、带前 3 句上下文，提示词要求只输出译文）
      → 语言/文字校验（西语译文不能全是汉字，中文译文要含汉字）
      → TTS（流式；按积压时长自动加快语速 1.0→1.35）
      → 有序播放队列（按提交顺序播放，乱序完成的结果等待前序）
      → 记录：TranscriptSegment（原文、译文、时间、方向、状态）
```

- 两个方向完全独立、并行（全双工）。
- “按住说话”：全局快捷键按下时才把麦克风送进 ASR，松开后提交最后一句（学知了）。
- 积压控制：译音积压 > 6s 加速；> 15s 时界面提示“落后 N 秒”，可点“跳到最新”（被跳过的句子仍保留在记录里）。
- 一步式引擎（路线图）：多模态大模型“一次请求返回语言/原文/译文”（知了的 Ming 做法）、端到端实时同传模型（如 qwen3-livetranslate、gpt-realtime-translate）。接口已预留：`InterpretationEngine` 输入 PCM，输出与级联引擎相同的事件。

## 8. 服务商抽象

```ts
interface StreamingAsr { start(opts): AsrSession }            // push(pcm) / end() / on('partial'|'final'|'error')
interface Translator  { translate(req): Promise<string> }    // 带 glossary、context
interface Tts         { synthesize(req): AsyncIterable<PcmChunk> } // 流式
interface Llm         { chat(messages, opts): Promise<string> } // 纪要、翻译、纠错
```

v1 提供：
- **阿里云百炼（DashScope）**：实时语音识别、qwen-mt / 通义千问翻译（支持术语干预）、实时语音合成、纪要用通义千问。国内首选“一站式”预设。
- **Azure 语音**：流式识别（短语列表做热词）+ 神经网络语音合成；支持 Azure 中国区（自定义 endpoint/host）。
- **OpenAI**：实时转写 + TTS。
- **DeepL**：文本翻译 + 术语表。
- **OpenAI 兼容大模型**：翻译和纪要（DeepSeek、通义、Kimi、智谱、豆包、OpenRouter、Ollama…）。
- **演示模式**：不需要 key，脚本化的识别结果 + 伪翻译 + 本地提示音，用来试界面和跑测试。

每个方向的 ASR / 翻译 / TTS 可以分别选服务商；“快速配置”给出一站式预设。设置页有**连接测试**：合成一句话 → 识别回来 → 翻译，逐步显示成功/失败原因。

具体协议细节见第 13 节（调研结论）。

## 9. 术语表

- 结构：`{ id, zh, es, aliases_zh[], aliases_es[], note, enabled }`，多套术语表可分别启用（按客户/项目）。
- 作用点：
  1. **识别热词**：Azure 短语列表；百炼热词表（按术语表内容哈希缓存 vocabulary_id）；OpenAI `prompt`。
  2. **纠错**：别名（常见误识别写法）精确替换；中文可选拼音模糊匹配（`pinyin-pro`，2 字以上、编辑距离阈值）。
  3. **翻译**：只把本句命中的术语放进提示词（LLM），或用服务商原生术语功能（qwen-mt `terms`、DeepL glossary）。翻译后检查目标术语是否出现，未出现记一条警告。
  4. **纪要**：术语表作为“正确写法”提供给纪要模型。
- 导入导出：CSV（UTF-8 带 BOM，Excel 直接打开）、JSON。列：`中文,Español,中文别名,西语别名,备注`。

## 10. 会议记录、纪要、录音录屏

每场会议一个文件夹（默认 `文档/MeetingInterpreter/2026-11-20_1530_<标题>/`）：

| 文件 | 内容 |
|---|---|
| `meeting.json` | 元数据：标题、起止时间、语言、会议软件、服务商、文件清单 |
| `transcript.jsonl` | 每句一行：`{id, dir: "out"|"in", speaker, start, end, srcLang, srcText, dstLang, dstText, status}`，边开会边追加 |
| `transcript.md` / `.srt` / `.vtt` | 导出：双语逐句；字幕与录屏时间轴对齐（中文、西文、双语三份 SRT） |
| `audio/mic.wav`、`audio/meeting.wav` | 两路原声，16kHz 单声道（可用于会后重新转写） |
| `audio/mix.webm` | 全程混音（我方原声 + 西语译音 + 对方原声 + 中文译音），Opus |
| `screen.mp4`（不支持时 `.webm`） | 录屏（选整个屏幕或某个窗口）+ 混音音轨 |
| `summary.json`、`summary.zh.md`、`summary.es.md` | 纪要 |

**纪要**（借鉴知了的 JSON 结构）：`title, summary, topics[{start, title, summary, points[{text, evidence}]}], decisions[{text, evidence}], todos[{text, owner, due, evidence}], terms[]`，每个文本字段同时给 `zh` 和 `es`；`evidence` 是逐句记录的 id，界面上点击可跳回原句。长会议分段总结再合并（map-reduce）。模板：通用会议、商务谈判/客户会、项目例会。会议中可随时点“生成当前纪要”。

**录屏/录音**：开会前勾选；开始录制时提示“请征得参会者同意”。录制用 MediaRecorder，每秒一个分块经 IPC 写盘（2 小时会议不占内存，崩溃也保留已写部分）。

## 11. 界面

- **会议页**：开始/结束；两个方向的开关和状态灯（采集电平、识别中、积压秒数）；按住说话/持续同传切换；原声直通；录音、录屏开关；双语实时记录（我方/对方气泡，原文 + 译文）。
- **设备向导**：选麦克风、虚拟麦克风、会议声音来源、耳机；每个设备有“试听/电平”；检测不到虚拟声卡时给出下载链接和步骤。
- **会议软件指南**：Teams、飞书、腾讯会议、Zoom、钉钉、企业微信、Google Meet/Webex 分别说明在哪里改麦克风/扬声器，以及“把会议软件的降噪调低以免把译音当噪声”。检测到正在运行的会议软件时自动展开对应指南。
- **服务商**：一站式预设 + 高级（每个方向分别选）；Key 输入框；连接测试。
- **术语表**：表格编辑、导入导出、多套切换。
- **会议记录**：列表；详情页看双语记录、纪要（中/西切换）、播放录音录屏、导出、打开文件夹、重新生成纪要。
- **字幕悬浮窗**：置顶、半透明、可拖动、字号可调、可设鼠标穿透；`setContentProtection(true)` 不出现在屏幕共享和录屏里（可在设置里关闭）。
- **托盘**：开始/结束、出/入方向开关、显示字幕。
- **全局快捷键**（可改）：切换外发同传 `Ctrl/Cmd+Shift+M`；按住说话 `Ctrl/Cmd+Shift+Space`；显示/隐藏字幕 `Ctrl/Cmd+Shift+S`。

## 12. 工程与质量

- 技术栈：Electron 45、electron-vite 6、Vite 8、React 19、TypeScript（strict）、Vitest、Playwright（Electron 模式）、electron-builder。
- 测试：`src/core` 全部单测（分段、Committer、术语匹配与纠错、CSV、记录导出、纪要解析、管线用模拟服务商的完整流程、WAV 读写、各服务商的协议编解码用固定样例）；端到端：xvfb 下启动 Electron，Chromium 假音频文件当麦克风，演示模式下检查字幕和记录文件。
- CI：GitHub Actions（Ubuntu 跑类型检查 + 单测 + 端到端；打 tag 时在 Windows/macOS 打安装包上传 Release）。
- 安全：Key 用 `safeStorage` 加密，日志中脱敏；`contextIsolation: true`、`sandbox: true`、无 `nodeIntegration`；预加载脚本只暴露白名单 API。

## 13. 发布、免费使用、手机端

### 13.1 发布（Releases 直接下载）
- 打 tag `vX.Y.Z` 触发 GitHub Actions：macOS（Apple 芯片 + Intel 两个 DMG）、Windows（x64 安装程序 .exe）、Linux（AppImage）打包后自动上传到该版本的 Release。
- 没有付费的 Apple 开发者账号，无法公证：DMG 用 ad-hoc 签名。README 写清首次打开的方法（系统设置 › 隐私与安全性 › “仍要打开”，或终端 `xattr -cr`）。Windows 未签名，SmartScreen 点“更多信息 › 仍要运行”。
- macOS `Info.plist` 写好麦克风、屏幕录制用途说明。

### 13.2 免费使用
应用本身 MIT 开源免费。语音服务按“能免费就免费”的顺序提供预设：
1. **免费预设（默认推荐给不想花钱的人）**：
   - 识别：**本机离线识别**（sherpa-onnx：中文 SenseVoice / Paraformer，西语 Whisper），首次使用自动下载模型，不要 key、不联网、不花钱。
   - 翻译和纪要：**免费大模型 API**（如智谱 GLM Flash 系列免费模型，注册即得 key），或本机 Ollama。
   - 语音合成：**系统自带语音**（macOS `say`、Windows 自带语音）或本机离线神经网络语音（Piper）。
2. **免费额度预设**：Azure 语音免费层（每月若干小时识别 + 数十万字合成）、阿里云百炼新用户免费额度。
3. **效果最好预设**：阿里云百炼一站式（便宜，国内可用）。

### 13.3 手机端
手机系统不允许第三方 App 把声音送进会议 App，也不允许录别的 App 的声音，所以手机上做不到“会议里的同传”。手机端做“**面对面同传 + 记录纪要**”：
- 用 PWA（网页应用，GitHub Pages 免费托管），iPhone 和安卓用浏览器打开后“添加到主屏幕”即可，像 App 一样用，不需要应用商店。
- 复用同一套核心引擎（核心代码必须同时能跑在 Node 和浏览器里：网络只通过注入的 `fetch` / `WebSocket` 工厂，存储只通过接口）。
- 优先级低于桌面端；桌面端完成后再做。

## 14. 调研结论（服务商协议、系统回环）

（由并行调研填写，见下文更新。）

## 15. 我的决定清单（请评审）

1. 不 fork 知了，自研 Electron 跨平台应用，借鉴其设计。
2. 默认“持续同传”而不是“按住说话”（用户要的是同声传译）；按住说话作为可选模式。
3. 对方声音默认用“虚拟扬声器”采集（零回授），系统回环作为零配置备选。
4. 首次启动引导里让用户选：免费预设（本机识别 + 免费大模型 + 系统语音）/ 阿里云百炼一站式（效果最好）/ Azure / 演示模式；默认选中免费预设。
4a. macOS 为第一优先平台（用户用 Mac），Windows 第二，Linux 用于开发测试。
5. 西语默认 `es-ES`（西班牙），可选 `es-MX` 等拉美变体。
6. 记录默认存 `文档/MeetingInterpreter`，可改。
7. 录屏格式优先 MP4（H.264/AAC），不支持时 WebM。
8. 界面中文，英文界面作为第二语言。
9. 开源协议 MIT（借鉴的 Apache-2.0 代码在 NOTICE 中注明）。
