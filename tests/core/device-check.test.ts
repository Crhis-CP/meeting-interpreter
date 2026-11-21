import { describe, expect, it } from 'vitest';
import { checkDevices, isOtherEnd, physical, resolve, safeRouting, type DeviceConfig, type DeviceInfo } from '../../src/core/audio/device-check';

const inp = (deviceId: string, label: string, groupId = deviceId): DeviceInfo => ({ deviceId, kind: 'audioinput', label, groupId });
const outp = (deviceId: string, label: string, groupId = deviceId): DeviceInfo => ({ deviceId, kind: 'audiooutput', label, groupId });

/** Windows right after installing VB-CABLE: it became the default playback and recording device. */
const windowsAfterCable: DeviceInfo[] = [
  inp('default', 'Default - CABLE Output (VB-Audio Virtual Cable)', 'g-cable'),
  inp('communications', 'Communications - Microphone (Realtek(R) Audio)', 'g-rt'),
  inp('rt-mic', 'Microphone (Realtek(R) Audio)', 'g-rt'),
  inp('cable-out', 'CABLE Output (VB-Audio Virtual Cable)', 'g-cable'),
  outp('default', 'Default - CABLE Input (VB-Audio Virtual Cable)', 'g-cable'),
  outp('communications', 'Communications - Speakers (Realtek(R) Audio)', 'g-rt'),
  outp('rt-spk', 'Speakers (Realtek(R) Audio)', 'g-rt'),
  outp('cable-in', 'CABLE Input (VB-Audio Virtual Cable)', 'g-cable'),
];

/** A Mac with AirPods as the default and BlackHole installed (all fine). */
const macOk: DeviceInfo[] = [
  inp('default', 'Default - AirPods Pro (Bluetooth)', 'g-air'),
  inp('air-mic', 'AirPods Pro (Bluetooth)', 'g-air'),
  inp('mbp-mic', 'MacBook Pro Microphone (Built-in)', 'g-mbp'),
  inp('bh2-in', 'BlackHole 2ch (Virtual)', 'g-bh2'),
  inp('bh16-in', 'BlackHole 16ch (Virtual)', 'g-bh16'),
  outp('default', 'Default - AirPods Pro (Bluetooth)', 'g-air'),
  outp('air-out', 'AirPods Pro (Bluetooth)', 'g-air'),
  outp('mbp-spk', 'MacBook Pro Speakers (Built-in)', 'g-mbp'),
  outp('bh2-out', 'BlackHole 2ch (Virtual)', 'g-bh2'),
  outp('bh16-out', 'BlackHole 16ch (Virtual)', 'g-bh16'),
];

const cfg = (c: Partial<DeviceConfig>): DeviceConfig => ({ mic: '', virtualMic: '', meetingSource: 'loopback', meetingDevice: '', headphones: '', ...c });
const ids = (list: { id: string }[]) => list.map((i) => i.id);

describe('virtual cable ends', () => {
  it('pairs both ends of one cable, and only those', () => {
    expect(isOtherEnd('CABLE Output (VB-Audio Virtual Cable)', 'CABLE Input (VB-Audio Virtual Cable)')).toBe(true);
    expect(isOtherEnd('CABLE-A Output (VB-Audio Cable A)', 'CABLE-A Input (VB-Audio Cable A)')).toBe(true);
    expect(isOtherEnd('CABLE-A Output (VB-Audio Cable A)', 'CABLE Input (VB-Audio Virtual Cable)')).toBe(false);
    expect(isOtherEnd('BlackHole 2ch (Virtual)', 'BlackHole 2ch (Virtual)')).toBe(true);
    expect(isOtherEnd('BlackHole 16ch (Virtual)', 'BlackHole 2ch (Virtual)')).toBe(false);
    expect(isOtherEnd('Monitor of MI_Translated', 'MI_Translated')).toBe(true);
    expect(isOtherEnd('MI_Translated_Mic', 'MI_Translated')).toBe(true);
    // Real headsets are never "the other end", even with matching names.
    expect(isOtherEnd('Headset Microphone (Jabra Evolve)', 'Headset Earphone (Jabra Evolve)')).toBe(false);
    expect(isOtherEnd('AirPods Pro (Bluetooth)', 'AirPods Pro (Bluetooth)')).toBe(false);
  });

  it('resolves "system default" to the device behind it, also with a localized or bare default label', () => {
    expect(resolve(windowsAfterCable, 'audiooutput', '')).toEqual({ label: 'CABLE Input (VB-Audio Virtual Cable)', isDefault: true, missing: false });
    expect(resolve([outp('default', '默认 - Speakers (Realtek(R) Audio)'), outp('x', 'Speakers (Realtek(R) Audio)')], 'audiooutput', '').label).toBe('Speakers (Realtek(R) Audio)');
    expect(resolve([outp('default', 'Default', 'g1'), outp('x', 'BlackHole 2ch (Virtual)', 'g1')], 'audiooutput', '').label).toBe('BlackHole 2ch (Virtual)');
    expect(resolve(macOk, 'audioinput', 'gone')).toEqual({ label: 'AirPods Pro (Bluetooth)', isDefault: true, missing: true });
  });

  it('suggests a real device, preferring the same headset', () => {
    expect(physical(macOk, 'audioinput', 'AirPods Pro (Bluetooth)')?.deviceId).toBe('air-mic');
    expect(physical(windowsAfterCable, 'audiooutput')?.deviceId).toBe('rt-spk');
  });
});

describe('checkDevices', () => {
  it('a fine Mac setup has no issues', () => {
    expect(checkDevices(macOk, cfg({ virtualMic: 'bh2-out', meetingSource: 'device', meetingDevice: 'bh16-in' }))).toEqual([]);
  });

  it('Windows after VB-CABLE install with everything on "system default": loops are blocked with one-click fixes, the system is warned', () => {
    const issues = checkDevices(windowsAfterCable, cfg({ virtualMic: 'cable-in' }));
    expect(ids(issues)).toEqual(['mic-loop', 'headphones-into-meeting', 'system-output-virtual', 'system-input-virtual']);
    expect(issues[0]!.level).toBe('block');
    expect(issues[0]!.fix).toEqual({ label: '改用 Microphone (Realtek(R) Audio)', devices: { mic: 'rt-mic' } });
    expect(issues[1]!.fix).toEqual({ label: '改用 Speakers (Realtek(R) Audio)', devices: { headphones: 'rt-spk' } });
    expect(issues[2]!.system && issues[2]!.dismissKey).toBe('system-output-virtual:CABLE Input (VB-Audio Virtual Cable)');
  });

  it('the fixes really fix it (only the system warnings remain)', () => {
    const issues = checkDevices(windowsAfterCable, cfg({ virtualMic: 'cable-in', mic: 'rt-mic', headphones: 'rt-spk' }));
    expect(ids(issues)).toEqual(['system-output-virtual', 'system-input-virtual']);
  });

  it('choosing the other end of the virtual mic as microphone or meeting audio is a loop', () => {
    expect(ids(checkDevices(macOk, cfg({ virtualMic: 'bh2-out', mic: 'bh2-in' })))).toEqual(['mic-loop']);
    expect(ids(checkDevices(macOk, cfg({ virtualMic: 'bh2-out', meetingSource: 'device', meetingDevice: 'bh2-in' })))).toEqual(['meeting-loop']);
    // My headphones = where the meeting audio is captured from: my Chinese would be heard as the other side.
    expect(ids(checkDevices(macOk, cfg({ virtualMic: 'bh2-out', meetingSource: 'device', meetingDevice: 'bh16-in', headphones: 'bh16-out' })))).toEqual(['headphones-loop']);
  });

  it('another virtual device as microphone or headphones is a dismissable warning', () => {
    const [mic] = checkDevices(macOk, cfg({ virtualMic: 'bh2-out', mic: 'bh16-in' }));
    expect(mic).toMatchObject({ id: 'mic-virtual', level: 'warn', dismissKey: 'mic-virtual:BlackHole 16ch (Virtual)' });
    expect(ids(checkDevices(macOk, cfg({ virtualMic: 'bh2-out', headphones: 'bh16-out' })))).toEqual(['headphones-virtual']);
  });

  it('judges nothing without device labels (no permission yet)', () => {
    expect(checkDevices([inp('default', ''), outp('default', '')], cfg({ virtualMic: 'x' }))).toEqual([]);
  });
});

describe('safeRouting (what the audio engine may open)', () => {
  it('never opens a loop: no mic, no Chinese playback into the meeting', () => {
    const r = safeRouting(windowsAfterCable, cfg({ virtualMic: 'cable-in' }));
    expect(r.mic).toBeNull();
    expect(r.headphones).toBeNull();
    expect(r.micToMeeting).toBe(false);
    expect(r.warnings).toHaveLength(2);
  });

  it('a chosen device that is unplugged falls back to the system default', () => {
    const r = safeRouting(macOk, cfg({ virtualMic: 'bh2-out', mic: 'usb-mic-gone', headphones: 'usb-gone' }));
    expect(r).toMatchObject({ mic: '', headphones: '', micToMeeting: true });
    expect(r.warnings.join()).toMatch(/AirPods Pro/);
  });

  it('leaves a fine setup alone', () => {
    const c = cfg({ virtualMic: 'bh2-out', mic: 'air-mic', meetingSource: 'device', meetingDevice: 'bh16-in' });
    expect(safeRouting(macOk, c)).toEqual({ mic: 'air-mic', headphones: '', meetingDevice: 'bh16-in', micToMeeting: true, warnings: [] });
  });
});
