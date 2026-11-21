/**
 * Windows: the computer's default playback and recording devices, saved before installing
 * VB-CABLE and put back afterwards. VB-Audio's own manual warns that Windows 10+ may make the
 * newly installed cable the default device, "so you will not hear any sound anymore" — in every
 * app, not only ours. The install is our doing, so undoing that side effect is too.
 *
 * Uses Windows' own audio interfaces (MMDevice API to read, the audio policy interface that the
 * Sound control panel itself uses to set) through PowerShell: nothing extra is installed.
 * Later changes (after a reboot, or made by the user) are only reported, with a one-click "改回".
 */
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { VIRTUAL_IN, VIRTUAL_OUT } from '../../core/audio/device-check';

export interface AudioDefaults {
  /** Endpoint ids ('' = none): default and communications device, for playback and recording. */
  renderConsole: string;
  renderComm: string;
  captureConsole: string;
  captureComm: string;
  /** Friendly names by lower-cased endpoint id. */
  names: Record<string, string>;
}

const SLOTS = ['renderConsole', 'renderComm', 'captureConsole', 'captureComm'] as const;
type Slot = (typeof SLOTS)[number];
/** Roles: eConsole 0, eMultimedia 1, eCommunications 2. */
const ROLES: Record<Slot, number[]> = { renderConsole: [0, 1], renderComm: [2], captureConsole: [0, 1], captureComm: [2] };
const ENDPOINT_ID = /^\{[0-9.]+\}\.\{[0-9a-fA-F-]+\}$/;

const CS = String.raw`
using System;
using System.Runtime.InteropServices;
public static class MiAudio {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator {}
  [ComImport, Guid("870af99c-171d-4f9e-af0d-e63df40c2bc9")] class PolicyConfigClient {}
  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
  }
  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr p, out IntPtr iface);
    [PreserveSig] int OpenPropertyStore(int access, out IntPtr props);
    [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
  }
  [ComImport, Guid("f8679f50-850a-41cf-9c72-430f290290c8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPolicyConfig {
    void GetMixFormat(); void GetDeviceFormat(); void ResetDeviceFormat(); void SetDeviceFormat();
    void GetProcessingPeriod(); void SetProcessingPeriod(); void GetShareMode(); void SetShareMode();
    void GetPropertyValue(); void SetPropertyValue();
    [PreserveSig] int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string id, int role);
  }
  static string Default(int flow, int role) {
    IMMDevice d;
    var e = (IMMDeviceEnumerator)new MMDeviceEnumerator();
    if (e.GetDefaultAudioEndpoint(flow, role, out d) != 0 || d == null) return "";
    string id;
    return d.GetId(out id) == 0 && id != null ? id : "";
  }
  public static string Get() { return Default(0, 0) + "|" + Default(0, 2) + "|" + Default(1, 0) + "|" + Default(1, 2); }
  public static int Set(string id, int role) { return ((IPolicyConfig)new PolicyConfigClient()).SetDefaultEndpoint(id, role); }
}
`;

export const PRELUDE = `$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition @'\n${CS}\n'@\n`;

export type PsRunner = (script: string) => Promise<{ code: number; out: string }>;

/** Runs a PowerShell script (passed encoded, so the C# needs no quoting; an encoded command is not subject to the execution policy). */
export const runPowerShell: PsRunner = (script) =>
  new Promise((resolve) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { timeout: 60_000, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ code: err ? 1 : 0, out: `${stdout ?? ''}${stderr ?? ''}` });
    });
  });

/** The current defaults, or null when they can't be read (not Windows, or no audio service). */
export async function readAudioDefaults(run: PsRunner = runPowerShell): Promise<AudioDefaults | null> {
  if (process.platform !== 'win32' && run === runPowerShell) return null;
  const script = `${PRELUDE}$d = [MiAudio]::Get().Split('|')
$names = @{}
try { Get-PnpDevice -Class AudioEndpoint -ErrorAction SilentlyContinue | ForEach-Object { $names[($_.InstanceId -replace '^SWD\\\\MMDEVAPI\\\\','').ToLower()] = $_.FriendlyName } } catch {}
$o = [ordered]@{ renderConsole = $d[0]; renderComm = $d[1]; captureConsole = $d[2]; captureComm = $d[3]; names = $names }
'MI_JSON:' + ($o | ConvertTo-Json -Compress)`;
  const r = await run(script);
  const line = r.out.split(/\r?\n/).find((l) => l.startsWith('MI_JSON:'));
  if (!line) return null;
  try {
    const j = JSON.parse(line.slice(8)) as Partial<AudioDefaults>;
    const names: Record<string, string> = {};
    for (const [k, v] of Object.entries(j.names ?? {})) if (typeof v === 'string') names[k.toLowerCase()] = v;
    const id = (v: unknown) => (typeof v === 'string' && ENDPOINT_ID.test(v) ? v : '');
    return { renderConsole: id(j.renderConsole), renderComm: id(j.renderComm), captureConsole: id(j.captureConsole), captureComm: id(j.captureComm), names };
  } catch {
    return null;
  }
}

const isVirtual = (d: AudioDefaults, slot: Slot) => {
  const name = d.names[d[slot].toLowerCase()] ?? '';
  return !!name && (slot.startsWith('render') ? VIRTUAL_OUT : VIRTUAL_IN).test(name);
};

/**
 * What to remember: the current defaults, except that a virtual device never replaces a real one
 * already remembered (installing twice must not remember the cable as "what it was before").
 */
export function mergeSaved(old: AudioDefaults | null, now: AudioDefaults): AudioDefaults {
  const out: AudioDefaults = { ...now, names: { ...(old?.names ?? {}), ...now.names } };
  for (const slot of SLOTS) if (old?.[slot] && (!now[slot] || isVirtual(now, slot))) out[slot] = old[slot];
  return out;
}

const file = (dir: string) => join(dir, 'audio-defaults.json');

export function savedAudioDefaults(dir: string): AudioDefaults | null {
  try {
    const j = JSON.parse(readFileSync(file(dir), 'utf8')) as AudioDefaults;
    return SLOTS.every((s) => typeof j[s] === 'string') ? j : null;
  } catch {
    return null;
  }
}

/** Remembers the current defaults (before installing the cable). */
export async function saveAudioDefaults(dir: string, run: PsRunner = runPowerShell): Promise<boolean> {
  const now = await readAudioDefaults(run);
  if (!now) return false;
  writeFileSync(file(dir), JSON.stringify(mergeSaved(savedAudioDefaults(dir), now), null, 2));
  return true;
}

/** Puts the remembered defaults back where they changed. Returns the names of the devices restored. */
export async function restoreAudioDefaults(dir: string, run: PsRunner = runPowerShell): Promise<string[]> {
  const saved = savedAudioDefaults(dir);
  const now = await readAudioDefaults(run);
  if (!saved || !now) return [];
  const changes = SLOTS.filter((s) => saved[s] && ENDPOINT_ID.test(saved[s]) && saved[s] !== now[s]);
  if (!changes.length) return [];
  const calls = changes.flatMap((s) => ROLES[s].map((role) => `'MI_SET:' + [MiAudio]::Set('${saved[s]}', ${role})`));
  const r = await run(`${PRELUDE}${calls.join('\n')}`);
  const ok = r.out.split(/\r?\n/).filter((l) => l.startsWith('MI_SET:')).every((l) => l.trim() === 'MI_SET:0');
  if (!ok || r.code !== 0) throw new Error('没能改回原来的默认设备，请在“声音设置”里手动选择');
  return [...new Set(changes.map((s) => saved.names[saved[s].toLowerCase()] ?? '原来的设备'))];
}
