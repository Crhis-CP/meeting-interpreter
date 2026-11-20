/** Setup guides shown in the app. Chinese, short, step by step. */

export interface MeetingAppGuide {
  id: string;
  name: string;
  steps: string[];
  tips: string[];
}

export const MEETING_APPS: MeetingAppGuide[] = [
  {
    id: 'teams',
    name: 'Microsoft Teams',
    steps: [
      '打开 Teams → 右上角“…” → 设置 → 设备（新版 Teams：设置 › 设备 / Settings › Devices）。',
      '麦克风：选“虚拟麦克风”的另一端 —— Mac 选 BlackHole 2ch，Windows 选 CABLE Output (VB-Audio Virtual Cable)。',
      '扬声器：想听中文译音并压低原声时选“虚拟扬声器”（Mac：BlackHole 16ch；Windows：CABLE-A / Hi-Fi Cable Input）；用“系统声音”模式时保持你的耳机即可。',
      '会议中也可以点“更多 › 设备设置”随时切换。',
    ],
    tips: ['设置 › 设备 › 降噪：改为“低”或“关闭”，否则 Teams 可能把译音当成噪声压掉。', '关闭“自动调整麦克风灵敏度”。'],
  },
  {
    id: 'feishu',
    name: '飞书 / Lark',
    steps: [
      '飞书会议中点左下角麦克风旁的“^” → 选择麦克风；或 设置 › 音视频 › 麦克风。',
      '麦克风：Mac 选 BlackHole 2ch；Windows 选 CABLE Output (VB-Audio Virtual Cable)。',
      '扬声器：用“系统声音”模式保持耳机；用“虚拟扬声器”模式选 BlackHole 16ch / CABLE-A Input。',
    ],
    tips: ['设置 › 音视频 › 关闭“智能降噪”或选“低”，避免译音被削弱。', '开启“原声/音乐模式”（如有）可提高译音清晰度。'],
  },
  {
    id: 'tencent',
    name: '腾讯会议 / VooV',
    steps: [
      '腾讯会议 → 设置 › 音频（会中：麦克风按钮旁“^” › 音频选项）。',
      '麦克风：Mac 选 BlackHole 2ch；Windows 选 CABLE Output (VB-Audio Virtual Cable)。',
      '扬声器：用“系统声音”模式保持耳机；用“虚拟扬声器”模式选 BlackHole 16ch / CABLE-A Input。',
    ],
    tips: ['设置 › 音频 › 关闭“自动调节麦克风音量”，“音频降噪”选“低”。', '如有“音乐模式/原声”请开启。'],
  },
  {
    id: 'zoom',
    name: 'Zoom',
    steps: ['设置 › 音频 › 麦克风选 BlackHole 2ch / CABLE Output；扬声器同上。'],
    tips: ['背景噪音抑制选“低”，或开启“原声（Original sound for musicians）”。'],
  },
  {
    id: 'dingtalk',
    name: '钉钉',
    steps: ['钉钉会议 → 设置 › 音频 › 麦克风选 BlackHole 2ch / CABLE Output；扬声器同上。'],
    tips: ['关闭“智能降噪”或调低。'],
  },
  {
    id: 'wecom',
    name: '企业微信',
    steps: ['会议中点“设置” › 音视频 › 麦克风选 BlackHole 2ch / CABLE Output。'],
    tips: ['关闭降噪增强。'],
  },
  {
    id: 'webex',
    name: 'Webex / Google Meet（浏览器）',
    steps: ['浏览器会议：在会议页面的音频设置里选择麦克风 BlackHole 2ch / CABLE Output；Chrome 也可在地址栏左侧的权限图标里切换。'],
    tips: ['浏览器里的会议同样适用“系统声音”模式。'],
  },
];

export interface DriverGuide {
  os: 'mac' | 'win' | 'linux';
  title: string;
  steps: string[];
  links: { label: string; url: string }[];
}

export const DRIVER_GUIDES: DriverGuide[] = [
  {
    os: 'mac',
    title: 'macOS：安装 BlackHole（免费）',
    steps: [
      '下载并安装 BlackHole 2ch（让会议软件听到西语译音必需）。也可在终端运行：brew install blackhole-2ch',
      '可选：再装 BlackHole 16ch，作为“虚拟扬声器”采集会议声音并压低原声；macOS 14.2 及以上可以直接用“系统声音”，不必安装。',
      '安装后重启会议软件，回到这里点“刷新设备”。',
      '首次用“系统声音”时，在 系统设置 › 隐私与安全性 › 录屏与系统录音 中允许“MeetingInterpreter”。',
    ],
    links: [
      { label: 'BlackHole 官网', url: 'https://existential.audio/blackhole/' },
      { label: 'BlackHole GitHub', url: 'https://github.com/ExistentialAudio/BlackHole' },
    ],
  },
  {
    os: 'win',
    title: 'Windows：安装 VB-CABLE（免费，捐赠软件）',
    steps: [
      '下载 VB-CABLE Driver Pack，解压后右键“以管理员身份运行” VBCABLE_Setup_x64.exe，点 Install Driver，然后重启电脑。',
      '安装后会出现“CABLE Input”（播放设备，本应用往里送西语译音）和“CABLE Output”（录音设备，会议软件的麦克风选它）。',
      'Windows 11 可直接用“系统声音”采集会议；Windows 10 若要听中文译音，建议再装一个虚拟线（VB-Audio Hi-Fi Cable 或 VoiceMeeter）作为“虚拟扬声器”。',
    ],
    links: [
      { label: 'VB-CABLE 下载', url: 'https://vb-audio.com/Cable/' },
      { label: 'Hi-Fi Cable / VoiceMeeter', url: 'https://vb-audio.com/Voicemeeter/' },
    ],
  },
  {
    os: 'linux',
    title: 'Linux：创建虚拟麦克风（PulseAudio / PipeWire）',
    steps: [
      '终端运行：pactl load-module module-null-sink sink_name=mi_out sink_properties=device.description=MI_Translated',
      '再运行：pactl load-module module-remap-source master=mi_out.monitor source_name=mi_mic source_properties=device.description=MI_Mic',
      '本应用“虚拟麦克风”选 MI_Translated；会议软件麦克风选 MI_Mic。',
    ],
    links: [],
  },
];

/** Recognises virtual audio devices by label. */
export const VIRTUAL_OUT = /(CABLE[- ]?(A |B )?Input|VB-Audio|BlackHole|Voicemeeter (Aux )?Input|VoiceMeeter|Hi-Fi Cable Input|MI_Translated|Loopback Audio|Soundflower|null sink)/i;
export const VIRTUAL_IN = /(CABLE[- ]?(A |B )?Output|BlackHole|Voicemeeter Out|Hi-Fi Cable Output|MI_Mic|Loopback Audio|Soundflower|Monitor of)/i;

export function guessVirtualMic(outputs: MediaDeviceInfo[]): MediaDeviceInfo | undefined {
  return (
    outputs.find((d) => /BlackHole 2ch/i.test(d.label)) ??
    outputs.find((d) => /^CABLE Input/i.test(d.label)) ??
    outputs.find((d) => /MI_Translated/i.test(d.label)) ??
    outputs.find((d) => VIRTUAL_OUT.test(d.label))
  );
}

export function guessMeetingDevice(inputs: MediaDeviceInfo[], virtualMicLabel?: string): MediaDeviceInfo | undefined {
  const avoid = (d: MediaDeviceInfo) => {
    // The meeting device must not be the other end of the virtual mic.
    if (!virtualMicLabel) return false;
    if (/BlackHole 2ch/i.test(virtualMicLabel)) return /BlackHole 2ch/i.test(d.label);
    if (/^CABLE Input/i.test(virtualMicLabel)) return /^CABLE Output/i.test(d.label);
    return false;
  };
  return (
    inputs.find((d) => /BlackHole 16ch/i.test(d.label)) ??
    inputs.find((d) => /CABLE-A Output|Hi-Fi Cable Output|Voicemeeter Out/i.test(d.label)) ??
    inputs.find((d) => VIRTUAL_IN.test(d.label) && !avoid(d))
  );
}
