import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tone } from '@core/audio/pcm';
import { encodeWav } from '@core/audio/wav';
import { collectPcm, ProviderError } from '@core/providers/types';
import type { PcmChunk } from '@core/types';
import {
  defaultExec,
  parseSayVoices,
  parseWindowsVoices,
  POWERSHELL_ARGS,
  SystemTts,
  type ExecFn,
  type ExecResult,
} from '../../src/main/providers/system-tts';

const SAY_VOICES = [
  'Albert              en_US    # Hello! My name is Albert.',
  'Eddy (Spanish (Spain)) es_ES    # ¡Hola! Me llamo Eddy.',
  'Jorge               es_ES    # ¡Hola! Me llamo Jorge.',
  'Mónica              es_ES    # Hola, me llamo Mónica y soy una voz española.',
  'Paulina             es_MX    # Hola, me llamo Paulina y soy una voz mexicana.',
  'Tingting            zh_CN    # 你好！我叫婷婷。',
  'Fiona (Enhanced)    en_GB-u-sd-gbsct # Hello! My name is Fiona.',
  '',
].join('\n');

const WINDOWS_JSON =
  '[{"name":"Microsoft Huihui Desktop","lang":"zh-CN","gender":"Female"},{"name":"Microsoft Zira Desktop","lang":"en-US","gender":"Female"},{"name":"Microsoft Helena Desktop","lang":"es-ES","gender":"Female"}]';

interface Call {
  cmd: string;
  args: string[];
  input?: string;
  /** Contents of the text file the program was asked to read. */
  text?: string;
  /** Windows: the parameters decoded from the script. */
  params?: { voice: string; culture: string; rate: number; out: string; textFile: string };
}

const SECONDS = 1.2;
const RATE = 22050;

/** A fake `exec` that writes a real WAV (1.2 s tone at 22.05 kHz) wherever the program was told to. */
function fakeExec(handler?: (call: Call) => ExecResult | undefined): { exec: ExecFn; calls: Call[] } {
  const calls: Call[] = [];
  const exec: ExecFn = async (cmd, args, input) => {
    const call: Call = { cmd, args, input };
    calls.push(call);
    const custom = handler?.(call);
    if (custom) return custom;
    let out: string | undefined;
    if (cmd === 'say') {
      if (args[1] === '?') return { stdout: SAY_VOICES, stderr: '', code: 0 };
      out = args[args.indexOf('-o') + 1];
      call.text = readFileSync(args[args.indexOf('-f') + 1]!, 'utf8');
    } else if (cmd === 'espeak-ng') {
      out = args[args.indexOf('-w') + 1];
      call.text = readFileSync(args[args.indexOf('-f') + 1]!, 'utf8');
    } else if (cmd === 'powershell.exe') {
      const m = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(input ?? '');
      if (!m) return { stdout: `MI_JSON ${WINDOWS_JSON}\r\n`, stderr: '', code: 0 };
      call.params = JSON.parse(Buffer.from(m[1]!, 'base64').toString('utf8'));
      out = call.params!.out;
      call.text = readFileSync(call.params!.textFile, 'utf8');
    }
    writeFileSync(out!, encodeWav(tone(SECONDS, 440, RATE), RATE));
    return { stdout: '', stderr: '', code: 0 };
  };
  return { exec, calls };
}

const tmp = () => mkdtempSync(join(tmpdir(), 'mi-tts-test-'));

async function chunksOf(tts: SystemTts, text: string, lang: string, rate = 1, voice?: string): Promise<PcmChunk[]> {
  const out: PcmChunk[] = [];
  for await (const c of tts.synthesize({ text, lang, rate, voice })) out.push(c);
  return out;
}

describe('SystemTts on macOS (say)', () => {
  it('runs say with the default voice, 175 wpm at rate 1.0 and WAV output read from a text file', async () => {
    const { exec, calls } = fakeExec();
    const tts = new SystemTts({ platform: 'darwin', exec, tmpDir: tmp() });
    await chunksOf(tts, '你好，欢迎参加会议', 'zh-CN');
    const { cmd, args, text } = calls[0]!;
    expect(cmd).toBe('say');
    expect(args.slice(0, 6)).toEqual(['-v', 'Tingting', '-r', '175', '--file-format=WAVE', '--data-format=LEI16@22050']);
    expect(args[6]).toBe('-o');
    expect(args[7]).toMatch(/\.wav$/);
    expect(args[8]).toBe('-f');
    expect(text).toBe('你好，欢迎参加会议');
  });

  it('scales the rate linearly and picks Mónica for es-ES, Paulina for other Spanish', async () => {
    const { exec, calls } = fakeExec();
    const tts = new SystemTts({ platform: 'darwin', exec, tmpDir: tmp() });
    await chunksOf(tts, 'Hola', 'es-ES', 1.2);
    await chunksOf(tts, 'Hola', 'es-MX', 0.8);
    await chunksOf(tts, 'Hola', 'es-AR');
    await chunksOf(tts, 'Hola', 'es-ES', 1, 'Jorge');
    const voiceRate = calls.map((c) => [c.args[1], c.args[3]]);
    expect(voiceRate).toEqual([
      ['Mónica', '210'],
      ['Paulina', '140'],
      ['Paulina', '175'],
      ['Jorge', '175'],
    ]);
  });

  it('yields mono chunks of at most 0.5 s and removes its temporary files', async () => {
    const dir = tmp();
    const { exec } = fakeExec();
    const tts = new SystemTts({ platform: 'darwin', exec, tmpDir: dir });
    const chunks = await chunksOf(tts, 'Hola a todos', 'es-ES');
    expect(chunks.map((c) => c.samples.length)).toEqual([11025, 11025, 4410]);
    expect(chunks.every((c) => c.sampleRate === RATE && c.samples.length <= RATE / 2)).toBe(true);
    const all = await collectPcm(tts.synthesize({ text: 'otra vez', lang: 'es-ES', rate: 1 }));
    expect(all.samples.length).toBe(Math.round(SECONDS * RATE));
    expect(readdirSync(dir)).toEqual([]);
  });

  it('yields nothing for blank text without running say', async () => {
    const { exec, calls } = fakeExec();
    const tts = new SystemTts({ platform: 'darwin', exec, tmpDir: tmp() });
    expect(await chunksOf(tts, '  \n ', 'zh-CN')).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('parses `say -v ?` into voices with BCP-47 language tags', async () => {
    expect(parseSayVoices(SAY_VOICES)).toEqual([
      { id: 'Albert', name: 'Albert', lang: 'en-US' },
      { id: 'Eddy (Spanish (Spain))', name: 'Eddy (Spanish (Spain))', lang: 'es-ES' },
      { id: 'Jorge', name: 'Jorge', lang: 'es-ES' },
      { id: 'Mónica', name: 'Mónica', lang: 'es-ES' },
      { id: 'Paulina', name: 'Paulina', lang: 'es-MX' },
      { id: 'Tingting', name: 'Tingting', lang: 'zh-CN' },
      { id: 'Fiona (Enhanced)', name: 'Fiona (Enhanced)', lang: 'en-GB-u-sd-gbsct' },
    ]);
    const { exec, calls } = fakeExec();
    const tts = new SystemTts({ platform: 'darwin', exec, tmpDir: tmp() });
    const es = await tts.listVoices('es-MX');
    expect(calls[0]!.args).toEqual(['-v', '?']);
    expect(es.map((v) => v.id)).toEqual(['Eddy (Spanish (Spain))', 'Jorge', 'Mónica', 'Paulina']);
    expect((await tts.listVoices('zh-CN')).map((v) => v.id)).toEqual(['Tingting']);
  });

  it('falls back to an installed voice of the same language when the requested one is missing', async () => {
    const installed = SAY_VOICES.split('\n').filter((l) => !l.startsWith('Mónica')).join('\n');
    const { exec, calls } = fakeExec((c) => {
      if (c.cmd === 'say' && c.args[1] === '?') return { stdout: installed, stderr: '', code: 0 };
      if (c.cmd === 'say' && c.args[1] === 'Mónica') return { stdout: '', stderr: "Voice `Mónica' not found.\n", code: 1 };
      return undefined;
    });
    const tts = new SystemTts({ platform: 'darwin', exec, tmpDir: tmp() });
    expect((await chunksOf(tts, 'Hola', 'es-ES')).length).toBeGreaterThan(0);
    await chunksOf(tts, 'Otra frase', 'es-ES');
    // Mónica fails once, the list is read once, and the replacement is remembered.
    expect(calls.map((c) => c.args[1])).toEqual(['Mónica', '?', 'Eddy (Spanish (Spain))', 'Eddy (Spanish (Spain))']);
  });

  it('explains in Chinese how to download a voice when none is installed for the language', async () => {
    const { exec } = fakeExec((c) => {
      if (c.cmd === 'say' && c.args[1] === '?') return { stdout: 'Albert              en_US    # Hello!\n', stderr: '', code: 0 };
      if (c.cmd === 'say') return { stdout: '', stderr: "Voice `Tingting' not found.\n", code: 1 };
      return undefined;
    });
    const tts = new SystemTts({ platform: 'darwin', exec, tmpDir: tmp() });
    await expect(chunksOf(tts, '你好', 'zh-CN')).rejects.toThrow(/没有安装中文语音.*系统设置/);
  });
});

describe('SystemTts on Windows (PowerShell + System.Speech)', () => {
  it('pipes a System.Speech script to powershell with voice, culture, rate and a 22.05 kHz mono WAV target', async () => {
    const { exec, calls } = fakeExec();
    const tts = new SystemTts({ platform: 'win32', exec, tmpDir: tmp() });
    const chunks = await chunksOf(tts, 'Buenos días, ¿cómo están?', 'es-MX', 1.35);
    expect(chunks.length).toBe(3);
    const { cmd, args, input, params, text } = calls[0]!;
    expect(cmd).toBe('powershell.exe');
    expect(args).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-']);
    expect(args).toEqual(POWERSHELL_ARGS);
    expect(params).toMatchObject({ voice: 'Microsoft Sabina Desktop', culture: 'es-MX', rate: 4 });
    expect(text).toBe('Buenos días, ¿cómo están?');
    // One ASCII line (stdin is read line by line in the OEM code page).
    expect(input!.trimEnd().split('\n')).toHaveLength(1);
    expect(/^[\x20-\x7e]*$/.test(input!.trimEnd())).toBe(true);
    expect(input).toContain('System.Speech.Synthesis.SpeechSynthesizer');
    expect(input).toContain('SelectVoiceByHints');
    expect(input).toContain('SpeechAudioFormatInfo -ArgumentList 22050, ([System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen), ([System.Speech.AudioFormat.AudioChannel]::Mono)');
    expect(input).toContain('SetOutputToWaveFile($p.out');
    expect(input).toContain('ReadAllText($p.textFile, [System.Text.Encoding]::UTF8)');
  });

  it('maps rate to −10..10 and uses the default voice per language', async () => {
    const { exec, calls } = fakeExec();
    const tts = new SystemTts({ platform: 'win32', exec, tmpDir: tmp() });
    await chunksOf(tts, '你好', 'zh-CN', 1);
    await chunksOf(tts, 'Hola', 'es-ES', 0.5);
    await chunksOf(tts, 'Hola', 'es-AR', 3);
    await chunksOf(tts, 'Hola', 'es-ES', 1.2, 'Microsoft Laura');
    expect(calls.map((c) => [c.params!.voice, c.params!.culture, c.params!.rate])).toEqual([
      ['Microsoft Huihui Desktop', 'zh-CN', 0],
      ['Microsoft Helena Desktop', 'es-ES', -5],
      ['Microsoft Sabina Desktop', 'es-AR', 10],
      ['Microsoft Laura', 'es-ES', 2],
    ]);
  });

  it('tells the user in Chinese to add a Spanish voice when none is installed', async () => {
    const { exec } = fakeExec((c) => (c.cmd === 'powershell.exe' ? { stdout: '', stderr: 'MI_NO_VOICE\r\n', code: 3 } : undefined));
    const tts = new SystemTts({ platform: 'win32', exec, tmpDir: tmp() });
    const err = await chunksOf(tts, 'Hola', 'es-ES').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as Error).message).toContain('请在 Windows 设置 › 时间和语言 › 语音 中添加西班牙语语音');
    await expect(chunksOf(tts, '你好', 'zh-CN')).rejects.toThrow('添加中文语音');
  });

  it('reports other PowerShell failures with the exit code and message', async () => {
    const { exec } = fakeExec(() => ({ stdout: '', stderr: 'MI_ERROR Access denied\r\n', code: 1 }));
    const tts = new SystemTts({ platform: 'win32', exec, tmpDir: tmp() });
    await expect(chunksOf(tts, 'Hola', 'es-ES')).rejects.toThrow(/Windows 系统语音合成失败（退出码 1）：Access denied/);
  });

  it('lists installed voices from the JSON the script prints', async () => {
    expect(parseWindowsVoices('{"name":"Microsoft Helena Desktop","lang":"es-ES","gender":"Female"}')).toEqual([
      { id: 'Microsoft Helena Desktop', name: 'Microsoft Helena Desktop', lang: 'es-ES', gender: 'female' },
    ]);
    const { exec, calls } = fakeExec();
    const tts = new SystemTts({ platform: 'win32', exec, tmpDir: tmp() });
    expect(await tts.listVoices()).toHaveLength(3);
    expect(await tts.listVoices('es-MX')).toEqual([{ id: 'Microsoft Helena Desktop', name: 'Microsoft Helena Desktop', lang: 'es-ES', gender: 'female' }]);
    expect(calls[0]!.input).toContain('GetInstalledVoices()');
    expect(calls[0]!.input).toContain('ConvertTo-Json');
  });
});

describe('SystemTts on Linux (espeak-ng)', () => {
  it('runs espeak-ng with cmn / es / es-419 and words per minute', async () => {
    const { exec, calls } = fakeExec();
    const tts = new SystemTts({ platform: 'linux', exec, tmpDir: tmp() });
    await chunksOf(tts, '你好', 'zh-CN');
    await chunksOf(tts, 'Hola', 'es-ES', 1.2);
    await chunksOf(tts, 'Hola', 'es-MX', 0.8);
    const { cmd, args, text } = calls[0]!;
    expect(cmd).toBe('espeak-ng');
    expect(args.slice(0, 5)).toEqual(['-v', 'cmn', '-s', '175', '-w']);
    expect(args[6]).toBe('-f');
    expect(text).toBe('你好');
    expect(calls.map((c) => [c.args[1], c.args[3]])).toEqual([
      ['cmn', '175'],
      ['es', '210'],
      ['es-419', '140'],
    ]);
  });

  it('says how to install espeak-ng when it is missing', async () => {
    const exec: ExecFn = async () => {
      throw Object.assign(new Error('spawn espeak-ng ENOENT'), { code: 'ENOENT' });
    };
    const tts = new SystemTts({ platform: 'linux', exec, tmpDir: tmp() });
    await expect(chunksOf(tts, 'Hola', 'es-ES')).rejects.toThrow(/没有找到 espeak-ng.*apt install espeak-ng/);
  });
});

describe('SystemTts voices and process runner', () => {
  it('returns a static list of well-known voices with the default first', () => {
    const ids = (platform: NodeJS.Platform, lang: string) => new SystemTts({ platform, exec: fakeExec().exec }).voices(lang).map((v) => v.id);
    expect(ids('darwin', 'zh-CN')).toEqual(['Tingting']);
    expect(ids('darwin', 'es-ES')[0]).toBe('Mónica');
    expect(ids('darwin', 'es-MX')[0]).toBe('Paulina');
    expect(ids('darwin', 'es-AR').slice(0, 2)).toEqual(['Paulina', 'Diego']);
    expect(ids('win32', 'zh-CN')).toEqual(['Microsoft Huihui Desktop']);
    expect(ids('win32', 'es-MX')).toEqual(['Microsoft Sabina Desktop', 'Microsoft Helena Desktop']);
    expect(ids('linux', 'es-CO')[0]).toBe('es-419');
    expect(ids('freebsd', 'es-ES')).toEqual([]);
  });

  it('the default runner pipes UTF-8 stdin/stdout and rejects when the program does not exist', async () => {
    const r = await defaultExec(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], 'Mónica 婷婷');
    expect(r).toEqual({ stdout: 'Mónica 婷婷', stderr: '', code: 0 });
    await expect(defaultExec('mi-no-such-program-xyz', [])).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('stops before running anything when the request is already aborted', async () => {
    const { exec, calls } = fakeExec();
    const tts = new SystemTts({ platform: 'darwin', exec, tmpDir: tmp() });
    const ac = new AbortController();
    ac.abort();
    const it = tts.synthesize({ text: 'Hola', lang: 'es-ES', rate: 1, signal: ac.signal })[Symbol.asyncIterator]();
    await expect(it.next()).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toEqual([]);
  });
});
