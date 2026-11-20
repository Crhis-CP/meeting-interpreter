# Chrome Web Store Listing — 会议同传助手 Meeting Interpreter

> Last Updated: 2026-11-20 · Extension source: `extension/` · Build: `npm run build:extension` → `release/meeting-interpreter-chrome-<version>.zip`

## Store Listing

**Extension Name**
会议同传助手 Meeting Interpreter

**Short Description** (≤132)
网页会议实时同传：你说中文，对方在会议里听到西班牙语或英语；对方说话，你看到中文悬浮字幕。

**Detailed Description**
在网页版会议里做中文 ⇄ 西班牙语 / 英语的实时同声传译。对方不用安装任何东西。

你说中文：对方在会议里直接听到翻译后的西班牙语或英语，你的原声不会传过去。
对方说话：会议页面上出现中文悬浮字幕，可以拖动、调大小。
术语表：公司名、产品名、人名按你定的译法翻译，常见的识别错误自动改正。
会议记录：会后下载双语逐句记录和字幕，一键生成中文和外文两份会议纪要。

支持：Microsoft Teams、Google Meet、飞书、腾讯会议、Zoom、Webex 的网页版。

用法：
1. 打开网页版会议并入会；
2. 点工具栏上的插件图标，选对方语言（西班牙语 / English）和方案；
3. 点“开始同传”。建议戴耳机。

方案：
免费版：配合电脑上的“会议同传助手”桌面客户端（免费开源），识别在本机离线完成，翻译用免费的智谱 GLM。
高级版：填一个阿里云百炼 Key，准确度最高、声音最自然。
也可以用 Azure、DeepL 等服务。

隐私：插件不收集任何数据，没有我们自己的服务器。会议声音只发给你自己选择并填写 Key 的语音和翻译服务（或你电脑上的桌面客户端）；Key、术语表和会议记录只保存在你的浏览器里。

开源地址和问题反馈：https://github.com/Crhis-CP/meeting-interpreter

**Category**
Productivity

**Single Purpose**
在网页会议中把用户的中文发言实时翻译成对方语言的语音，并把对方的发言实时翻译成中文字幕。

**Primary Language**
Chinese (Simplified)

## Graphics & Assets

| Asset | Dimensions | Status | Filename |
|-------|-----------|--------|----------|
| Store Icon | 128×128 PNG | ✅ Ready | `extension/public/icons/icon-128.png` |
| Screenshot 1 | 1280×800 | ⬜ Not created | 会议页面上的中文悬浮字幕（真实会议截图） |
| Screenshot 2 | 1280×800 | ⬜ Not created | 插件弹窗：选对方语言、免费版 / 高级版、开始同传 |
| Screenshot 3 | 1280×800 | ⬜ Not created | 设置页：术语表 |
| Screenshot 4 | 1280×800 | ⬜ Not created | 会议记录与中外文纪要 |
| Small Promo Tile | 440×280 | ⬜ Not created | |

## Permissions Justification

| Permission | Type | Justification |
|------------|------|---------------|
| `tabCapture` | permissions | 用户点“开始同传”后，采集当前会议标签页里对方的声音，识别并翻译成中文字幕。只采集用户启动同传的那个标签页，停止后立即释放。 |
| `offscreen` | permissions | 在后台页面里持续处理会议声音（识别、翻译、播放），并在采集期间把对方原声继续播放给用户听。 |
| `storage` | permissions | 在本机保存用户的设置、服务 Key、术语表和会议记录。 |
| `declarativeNetRequestWithHostAccess` | permissions | 阿里云百炼的实时语音接口要求在连接时携带用户自己的 Key；插件只给自己发往该语音接口的连接加上这个请求头，不读取、不修改任何网页的请求。 |
| `*://*.aliyuncs.com/*` | host_permissions | 用户选择阿里云百炼时：语音识别、翻译和语音合成。 |
| `*://*.speech.microsoft.com/*`, `https://api.cognitive.microsofttranslator.com/*`, `https://*.cognitiveservices.azure.com/*`, `*://*.azure.cn/*` | host_permissions | 用户选择微软 Azure 时：语音识别、语音合成和翻译（含 Azure 中国区）。 |
| `https://open.bigmodel.cn/*`, `https://api.deepseek.com/*`, `https://ark.cn-beijing.volces.com/*`, `https://api.openai.com/*`, `https://openrouter.ai/*` | host_permissions | 用户选择对应的大模型做翻译和会议纪要时调用。 |
| `https://api.deepl.com/*`, `https://api-free.deepl.com/*` | host_permissions | 用户选择 DeepL 翻译时调用。 |
| `https://api.github.com/*` | host_permissions | 每天最多两次查看 GitHub 上是否有新版本，有就在弹窗里提示用户去下载。 |
| `http://localhost/*`, `http://127.0.0.1/*` | host_permissions | 免费版：连接用户电脑上的“会议同传助手”桌面客户端（离线识别、系统语音），或用户自己的本机大模型（Ollama）。 |
| `https://*/*` | optional_host_permissions | 仅当用户在设置里填写自定义的 OpenAI 兼容翻译接口时，才请求该接口所在网站的权限。 |
| content scripts on Teams / Meet / 飞书 / 腾讯会议 / Zoom / Webex | content_scripts | 在会议页面里：把会议使用的麦克风换成翻译后的声音（对方只听到译音），并显示中文悬浮字幕。只在这些会议网站上运行。 |

## Privacy & Data Use

**Does the extension collect user data?** No (the developer receives nothing). Audio and text go only to services the user chooses and configures with their own key.

| Data Type | Collected? | Transmitted Off-Device? | Purpose | Shared with Third Parties? |
|-----------|-----------|------------------------|---------|---------------------------|
| Personal communications (meeting audio, transcripts) | Processed, stored locally | Yes, to the speech/translation service the user selected (or the user's own desktop app) | Interpretation | Only the user-selected service |
| Authentication info (service API keys) | Stored locally | Only to the matching service | Calling that service | No |
| Website content | No | No | — | No |
| Web history / user activity / location / financial / health / PII | No | No | — | No |

### Data Use Certification
- [x] Data is NOT sold to third parties
- [x] Data is NOT used or transferred for purposes unrelated to the single purpose
- [x] Data is NOT used to determine creditworthiness or for lending

**Privacy policy URL**: https://github.com/Crhis-CP/meeting-interpreter/blob/main/docs/privacy.md

## Pre-publish checklist

- [ ] Developer account (one-time US$5) at https://chrome.google.com/webstore/devconsole
- [ ] Upload `release/meeting-interpreter-chrome-<version>.zip`
- [ ] Real screenshots from a live meeting (1280×800)
- [ ] Verify in real Teams / Meet / 飞书 / 腾讯会议 web meetings

## Version History

| Version | Date | Notes |
|---------|------|-------|
| 0.3.0 | 2026-11-20 | First version: translated voice into the meeting, floating Chinese subtitles, glossary, records and minutes; free tier via the desktop app. |
