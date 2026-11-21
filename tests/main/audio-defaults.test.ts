import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRELUDE, mergeSaved, readAudioDefaults, restoreAudioDefaults, runPowerShell, saveAudioDefaults, type AudioDefaults, type PsRunner } from '../../src/main/platform/audio-defaults';

const SPK = '{0.0.0.00000000}.{11111111-aaaa-bbbb-cccc-000000000001}';
const MIC = '{0.0.1.00000000}.{22222222-aaaa-bbbb-cccc-000000000002}';
const CABLE_IN = '{0.0.0.00000000}.{33333333-aaaa-bbbb-cccc-000000000003}';
const CABLE_OUT = '{0.0.1.00000000}.{44444444-aaaa-bbbb-cccc-000000000004}';
const names = { [SPK]: 'Speakers (Realtek(R) Audio)', [MIC]: 'Microphone (Realtek(R) Audio)', [CABLE_IN]: 'CABLE Input (VB-Audio Virtual Cable)', [CABLE_OUT]: 'CABLE Output (VB-Audio Virtual Cable)' };

/** A pretend Windows: answers the read script with its current defaults and applies the set calls. */
function fakeWindows(state: Omit<AudioDefaults, 'names'>) {
  const calls: string[] = [];
  const run: PsRunner = async (script) => {
    expect(script).toContain('Add-Type -TypeDefinition');
    const sets = [...script.matchAll(/\[MiAudio\]::Set\('([^']+)', (\d)\)/g)];
    if (sets.length) {
      for (const [, id, role] of sets) {
        calls.push(`${id}:${role}`);
        const render = id!.startsWith('{0.0.0');
        if (role === '2') state[render ? 'renderComm' : 'captureComm'] = id!;
        else state[render ? 'renderConsole' : 'captureConsole'] = id!;
      }
      return { code: 0, out: sets.map(() => 'MI_SET:0').join('\r\n') };
    }
    return { code: 0, out: `noise\r\nMI_JSON:${JSON.stringify({ ...state, names: Object.fromEntries(Object.entries(names).map(([k, v]) => [k.toUpperCase(), v])) })}\r\n` };
  };
  return { run, calls, state };
}

describe('Windows default audio devices around the VB-CABLE install', () => {
  it('remembers the defaults before, and puts back the ones the install changed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mi-ad-'));
    const win = fakeWindows({ renderConsole: SPK, renderComm: SPK, captureConsole: MIC, captureComm: MIC });
    expect(await saveAudioDefaults(dir, win.run)).toBe(true);
    // The install makes the cable the default playback and recording device (not the communications ones).
    win.state.renderConsole = CABLE_IN;
    win.state.captureConsole = CABLE_OUT;
    expect(await restoreAudioDefaults(dir, win.run)).toEqual(['Speakers (Realtek(R) Audio)', 'Microphone (Realtek(R) Audio)']);
    expect(win.calls).toEqual([`${SPK}:0`, `${SPK}:1`, `${MIC}:0`, `${MIC}:1`]);
    expect(win.state).toEqual({ renderConsole: SPK, renderComm: SPK, captureConsole: MIC, captureComm: MIC });
    // Nothing changed since: nothing to do.
    expect(await restoreAudioDefaults(dir, win.run)).toEqual([]);
  });

  it('installing twice never remembers the cable as "what it was before"', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mi-ad-'));
    const win = fakeWindows({ renderConsole: SPK, renderComm: SPK, captureConsole: MIC, captureComm: MIC });
    await saveAudioDefaults(dir, win.run);
    win.state.renderConsole = CABLE_IN;
    await saveAudioDefaults(dir, win.run);
    expect(JSON.parse(readFileSync(join(dir, 'audio-defaults.json'), 'utf8')).renderConsole).toBe(SPK);
  });

  it('keeps a real device the user chose since', () => {
    const old = { renderConsole: SPK, renderComm: SPK, captureConsole: MIC, captureComm: MIC, names };
    const HEADSET = '{0.0.0.00000000}.{55555555-aaaa-bbbb-cccc-000000000005}';
    expect(mergeSaved(old, { ...old, renderConsole: HEADSET, names: { ...names, [HEADSET.toLowerCase()]: 'Headset (Jabra)' } }).renderConsole).toBe(HEADSET);
  });

  it('ignores anything that is not an endpoint id, and says nothing without readable output', async () => {
    const bad: PsRunner = async () => ({ code: 0, out: `MI_JSON:${JSON.stringify({ renderConsole: "x'); rm -rf /", renderComm: '', captureConsole: '', captureComm: '', names: {} })}` });
    expect((await readAudioDefaults(bad))?.renderConsole).toBe('');
    expect(await readAudioDefaults(async () => ({ code: 1, out: 'Add-Type : error CS1002' }))).toBeNull();
  });
});

/** For real on CI's Windows machine (MI_REAL_VOICES=1): the C# compiles and the audio interfaces answer. */
describe.runIf(process.platform === 'win32' && process.env.MI_REAL_VOICES === '1')('on real Windows', () => {
  it('compiles and reads the defaults (empty on a machine without audio devices)', async () => {
    const r = await runPowerShell(`${PRELUDE}'MI_COMPILED'`);
    expect(r.out).toContain('MI_COMPILED');
    const d = await readAudioDefaults();
    console.log('audio defaults on this machine:', JSON.stringify(d));
  }, 90_000);
});
