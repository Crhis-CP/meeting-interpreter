/**
 * Which audio device each path really uses, and whether that would harm the meeting or other apps.
 *
 * Settings keep '' for "follow the system default" (it follows the headset the user plugs in), so
 * the danger is not what was chosen but what the default is right now: installing VB-CABLE often
 * makes it the default playback and recording device. Then the translation meant for my ears goes
 * into the meeting, and the "microphone" is the other end of the virtual cable — the app hears
 * its own translated voice. Pure functions so the engine, the meeting page and settings agree.
 */

export interface DeviceInfo {
  deviceId: string;
  kind: string;
  label: string;
  groupId?: string;
}

export interface DeviceConfig {
  mic: string;
  virtualMic: string;
  meetingSource: 'device' | 'loopback' | 'none';
  meetingDevice: string;
  headphones: string;
}

/** Virtual devices by label: playback ends (where apps send sound) and recording ends. */
export const VIRTUAL_OUT = /(CABLE[- ]?(A |B )?Input|VB-Audio|BlackHole|Voicemeeter (Aux )?Input|VoiceMeeter|Hi-Fi Cable Input|MI_Translated|Loopback Audio|Soundflower|null sink)/i;
export const VIRTUAL_IN = /(CABLE[- ]?(A |B )?Output|BlackHole|Voicemeeter Out|Hi-Fi Cable Output|MI_Mic|MI_Translated|Loopback Audio|Soundflower|Monitor of)/i;

const SYSTEM_ENTRY = new Set(['default', 'communications']);

/** The device behind a "Default - X" / "默认 - X" entry; other labels unchanged. */
export function realLabel(d: DeviceInfo): string {
  if (!SYSTEM_ENTRY.has(d.deviceId)) return d.label;
  const i = d.label.indexOf(' - ');
  return i >= 0 ? d.label.slice(i + 3) : d.label;
}

/** Both ends of one virtual cable share this key ("CABLE Input" / "CABLE Output" → "cable"). */
function pairKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/^\s*monitor of\s+/, '')
    .replace(/_mic\b/g, '')
    .replace(/\b(input|output)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Recording device `input` hears whatever is played into `output` (both ends of one virtual cable). */
export function isOtherEnd(inputLabel: string, outputLabel: string): boolean {
  if (!inputLabel || !outputLabel || !VIRTUAL_IN.test(inputLabel) || !VIRTUAL_OUT.test(outputLabel)) return false;
  const k = pairKey(inputLabel);
  return !!k && k === pairKey(outputLabel);
}

export interface Resolved {
  /** Label of the device really used ('' when unknown, e.g. no permission to read labels yet). */
  label: string;
  /** Follows the system default. */
  isDefault: boolean;
  /** The chosen device is not connected now (the system default is used instead). */
  missing: boolean;
}

/** The device a setting really uses now: the chosen one, or what the system default currently is. */
export function resolve(devices: DeviceInfo[], kind: 'audioinput' | 'audiooutput', id: string): Resolved {
  const list = devices.filter((d) => d.kind === kind);
  if (id) {
    const d = list.find((x) => x.deviceId === id);
    if (d) return { label: d.label, isDefault: false, missing: false };
  }
  const def = list.find((x) => x.deviceId === 'default');
  const real = list.filter((x) => !SYSTEM_ENTRY.has(x.deviceId));
  let label = '';
  if (def) {
    const named = realLabel(def);
    const sameGroup = def.groupId ? real.filter((x) => x.groupId === def.groupId) : [];
    label = real.some((x) => x.label === named) ? named : sameGroup.length === 1 ? sameGroup[0]!.label : named;
  } else label = real[0]?.label ?? '';
  return { label, isDefault: true, missing: !!id };
}

const sameDevice = (a: string, b: string) => !!a && a === b;

/** A real (not virtual, not a "default" entry) device, preferring one that matches `near` (e.g. AirPods for AirPods). */
export function physical(devices: DeviceInfo[], kind: 'audioinput' | 'audiooutput', near = ''): DeviceInfo | undefined {
  const virtual = kind === 'audioinput' ? VIRTUAL_IN : VIRTUAL_OUT;
  const list = devices.filter((d) => d.kind === kind && !SYSTEM_ENTRY.has(d.deviceId) && d.label && !virtual.test(d.label));
  const word = near.split(/[\s(（]/)[0]?.toLowerCase();
  return (word && list.find((d) => d.label.toLowerCase().startsWith(word))) || list[0];
}

export type IssueId =
  | 'mic-loop'
  | 'mic-virtual'
  | 'headphones-into-meeting'
  | 'headphones-loop'
  | 'headphones-virtual'
  | 'meeting-loop'
  | 'system-output-virtual'
  | 'system-input-virtual';

export interface DeviceIssue {
  id: IssueId;
  /** 'block': the app would feed itself or send my audio into the meeting; 'warn': likely a mistake. */
  level: 'block' | 'warn';
  text: string;
  /** One click that fixes it inside this app. */
  fix?: { label: string; devices: Partial<DeviceConfig> };
  /** The system's own default device is the problem (fixed in the system's sound settings). */
  system?: boolean;
  /** Key for "this is on purpose, don't tell me again" (includes the device, so a new one warns again). */
  dismissKey?: string;
}

/**
 * Problems with the devices as they would be used now. Loops are 'block' (the engine refuses them
 * too); likely mistakes are 'warn' and can be dismissed.
 */
export function checkDevices(devices: DeviceInfo[], cfg: DeviceConfig, foreign = '西语'): DeviceIssue[] {
  if (!devices.some((d) => d.label)) return []; // labels unknown: nothing can be judged
  const issues: DeviceIssue[] = [];
  const mic = resolve(devices, 'audioinput', cfg.mic);
  const hp = resolve(devices, 'audiooutput', cfg.headphones);
  const vm = cfg.virtualMic ? resolve(devices, 'audiooutput', cfg.virtualMic) : null;
  const vmLabel = vm && !vm.missing ? vm.label : '';
  const meeting = cfg.meetingSource === 'device' && cfg.meetingDevice ? resolve(devices, 'audioinput', cfg.meetingDevice) : null;
  const meetingLabel = meeting && !meeting.missing ? meeting.label : '';
  const micFix = (): DeviceIssue['fix'] => {
    const p = physical(devices, 'audioinput', hp.label);
    return p ? { label: `改用 ${p.label}`, devices: { mic: p.deviceId } } : undefined;
  };
  const hpFix = (): DeviceIssue['fix'] => {
    const p = physical(devices, 'audiooutput', mic.label);
    return p ? { label: `改用 ${p.label}`, devices: { headphones: p.deviceId } } : undefined;
  };
  const whose = (r: Resolved, what: string) => (r.isDefault ? `${what}（跟随系统默认）现在是` : `${what}选的是`);

  // Microphone.
  if (mic.label && vmLabel && isOtherEnd(mic.label, vmLabel)) {
    issues.push({ id: 'mic-loop', level: 'block', text: `${whose(mic, '麦克风')}“${mic.label}”，它是虚拟麦克风的另一端：软件会把自己的${foreign}译音当成你说的话。`, fix: micFix() });
  } else if (mic.label && VIRTUAL_IN.test(mic.label)) {
    issues.push({ id: 'mic-virtual', level: 'warn', text: `${whose(mic, '麦克风')}虚拟声卡“${mic.label}”：它收不到你说的话。`, fix: micFix(), dismissKey: `mic-virtual:${mic.label}` });
  }

  // My headphones.
  if (hp.label && vmLabel && sameDevice(hp.label, vmLabel)) {
    issues.push({ id: 'headphones-into-meeting', level: 'block', text: `${whose(hp, '耳机')}“${hp.label}”，和虚拟麦克风是同一个设备：给你听的中文会被送进会议。`, fix: hpFix() });
  } else if (hp.label && meetingLabel && isOtherEnd(meetingLabel, hp.label)) {
    issues.push({ id: 'headphones-loop', level: 'block', text: `${whose(hp, '耳机')}“${hp.label}”，会议声音也从它采集：给你听的中文会被当成对方说的话。`, fix: hpFix() });
  } else if (hp.label && VIRTUAL_OUT.test(hp.label)) {
    issues.push({ id: 'headphones-virtual', level: 'warn', text: `${whose(hp, '耳机')}虚拟声卡“${hp.label}”：你会听不到中文译音。`, fix: hpFix(), dismissKey: `headphones-virtual:${hp.label}` });
  }

  // Meeting audio.
  if (meetingLabel && vmLabel && isOtherEnd(meetingLabel, vmLabel)) {
    issues.push({ id: 'meeting-loop', level: 'block', text: `“会议声音”选的是虚拟麦克风的另一端“${meetingLabel}”：你的${foreign}译音会被当成对方说的话再翻回来。` });
  }

  // The system defaults (they affect every other app, not only this one).
  const sysOut = resolve(devices, 'audiooutput', '');
  if (sysOut.label && VIRTUAL_OUT.test(sysOut.label)) {
    issues.push({ id: 'system-output-virtual', level: 'warn', system: true, text: `电脑的默认播放设备是虚拟声卡“${sysOut.label}”：其他软件（包括用“默认设备”的会议软件）会没有声音。`, dismissKey: `system-output-virtual:${sysOut.label}` });
  }
  const sysIn = resolve(devices, 'audioinput', '');
  if (sysIn.label && VIRTUAL_IN.test(sysIn.label)) {
    issues.push({ id: 'system-input-virtual', level: 'warn', system: true, text: `电脑的默认麦克风是虚拟声卡“${sysIn.label}”：其他软件会收不到你的声音。`, dismissKey: `system-input-virtual:${sysIn.label}` });
  }
  return issues;
}

export interface SafeRouting {
  /** Device to open ('' = system default), or null: do not open (it would loop). */
  mic: string | null;
  headphones: string | null;
  meetingDevice: string | null;
  /** The raw microphone may be mixed into the meeting (never when the "microphone" is a virtual device). */
  micToMeeting: boolean;
  warnings: string[];
}

/**
 * What the audio engine may actually open. A chosen device that is not connected falls back to the
 * system default; a path that would feed the app its own output is not opened at all.
 */
export function safeRouting(devices: DeviceInfo[], cfg: DeviceConfig, foreign = '西语'): SafeRouting {
  const warnings: string[] = [];
  const known = devices.some((d) => d.label);
  const out: SafeRouting = { mic: cfg.mic, headphones: cfg.headphones, meetingDevice: cfg.meetingDevice, micToMeeting: true, warnings };
  if (!known) return out;
  const mic = resolve(devices, 'audioinput', cfg.mic);
  const hp = resolve(devices, 'audiooutput', cfg.headphones);
  if (mic.missing) {
    out.mic = '';
    warnings.push(`选的麦克风没有连接，改用系统默认麦克风（${mic.label || '未知'}）。`);
  }
  if (hp.missing) {
    out.headphones = '';
    warnings.push(`选的耳机没有连接，改用系统默认输出（${hp.label || '未知'}）。`);
  }
  for (const i of checkDevices(devices, cfg, foreign)) {
    if (i.id === 'mic-loop') {
      out.mic = null;
      warnings.push(`没有打开麦克风：${i.text}请在设置里换成真正的麦克风。`);
    } else if (i.id === 'headphones-into-meeting' || i.id === 'headphones-loop') {
      out.headphones = null;
      warnings.push(`中文译音不播放（只显示字幕）：${i.text}请在设置里换成你的耳机。`);
    } else if (i.id === 'meeting-loop') {
      out.meetingDevice = null;
      warnings.push(`没有采集会议声音：${i.text}`);
    }
  }
  if (mic.label && VIRTUAL_IN.test(mic.label)) out.micToMeeting = false;
  return out;
}
