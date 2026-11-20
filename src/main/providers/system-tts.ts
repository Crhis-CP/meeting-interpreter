import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeWav, toMono } from '@core/audio/wav';
import { abortError, isAbortError } from '@core/events';
import { baseOf, lang as langInfo } from '@core/lang/languages';
import { ProviderError, type Tts, type TtsRequest, type VoiceInfo } from '@core/providers/types';
import type { LangCode, PcmChunk } from '@core/types';

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Runs a program; `input` goes to stdin. Rejects only when the program cannot be started (e.g. ENOENT). */
export type ExecFn = (cmd: string, args: string[], input?: string, signal?: AbortSignal) => Promise<ExecResult>;

export interface SystemTtsOptions {
  platform?: NodeJS.Platform;
  exec?: ExecFn;
  tmpDir?: string;
}

/** A voice installed on this computer. `id` is what `TtsRequest.voice` takes. */
export interface SystemVoice {
  id: string;
  name: string;
  /** BCP-47, e.g. `es-ES`. */
  lang: string;
  gender?: 'female' | 'male';
}

const PROVIDER = 'system';
const CHUNK_SECONDS = 0.5;
/** macOS `say` and espeak-ng both speak 175 words per minute at their default rate. */
const BASE_WPM = 175;
const TIMEOUT_MS = 60_000;

export const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'];

/** Well-known voices per platform (what ships with or is one click away in the OS). The first one per language is the default. */
const MAC_VOICES: VoiceInfo[] = [
  { id: 'Tingting', name: 'Tingting（婷婷）', lang: 'zh-CN', gender: 'female' },
  { id: 'Mónica', name: 'Mónica', lang: 'es-ES', gender: 'female' },
  { id: 'Jorge', name: 'Jorge', lang: 'es-ES', gender: 'male' },
  { id: 'Paulina', name: 'Paulina', lang: 'es-MX', gender: 'female' },
  { id: 'Juan', name: 'Juan', lang: 'es-MX', gender: 'male' },
  { id: 'Angélica', name: 'Angélica', lang: 'es-MX', gender: 'female' },
  { id: 'Diego', name: 'Diego', lang: 'es-AR', gender: 'male' },
  { id: 'Francisca', name: 'Francisca', lang: 'es-CL', gender: 'female' },
  { id: 'Soledad', name: 'Soledad', lang: 'es-CO', gender: 'female' },
];

const WINDOWS_VOICES: VoiceInfo[] = [
  { id: 'Microsoft Huihui Desktop', name: 'Huihui（慧慧）', lang: 'zh-CN', gender: 'female' },
  { id: 'Microsoft Helena Desktop', name: 'Helena', lang: 'es-ES', gender: 'female' },
  { id: 'Microsoft Sabina Desktop', name: 'Sabina', lang: 'es-MX', gender: 'female' },
];

const LINUX_VOICES: VoiceInfo[] = [
  { id: 'cmn', name: '普通话（espeak-ng）', lang: 'zh-CN' },
  { id: 'es', name: 'Español de España（espeak-ng）', lang: 'es-ES' },
  { id: 'es-419', name: 'Español latinoamericano（espeak-ng）', lang: 'es-419' },
];

function staticVoices(platform: NodeJS.Platform): VoiceInfo[] {
  if (platform === 'darwin') return MAC_VOICES;
  if (platform === 'win32') return WINDOWS_VOICES;
  if (platform === 'linux') return LINUX_VOICES;
  return [];
}

function baseOfTag(tag: string): string {
  return tag.split(/[-_]/)[0]!.toLowerCase();
}

/** Default voice per platform: macOS Tingting / Mónica (es-ES) / Paulina (other Spanish); Windows Huihui / Helena / Sabina; espeak-ng cmn / es / es-419. */
export function defaultVoice(platform: NodeJS.Platform, code: LangCode): string {
  const info = langInfo(code);
  const es = info.code === 'es-ES';
  if (platform === 'darwin') return info.base === 'zh' ? 'Tingting' : es ? 'Mónica' : 'Paulina';
  if (platform === 'win32') return info.base === 'zh' ? 'Microsoft Huihui Desktop' : es ? 'Microsoft Helena Desktop' : 'Microsoft Sabina Desktop';
  return info.base === 'zh' ? 'cmn' : es ? 'es' : 'es-419';
}

function clampRate(rate: number): number {
  return Number.isFinite(rate) && rate > 0 ? Math.min(3, Math.max(0.3, rate)) : 1;
}

/** Words per minute for `say` / espeak-ng: 1.0 → 175, linear. */
export function wpmFor(rate: number): number {
  return Math.round(BASE_WPM * clampRate(rate));
}

/** System.Speech rate: round((rate − 1) × 10), clamped to −10..10. */
export function sapiRateFor(rate: number): number {
  return Math.max(-10, Math.min(10, Math.round((clampRate(rate) - 1) * 10)));
}

function languageZh(code: LangCode): string {
  return baseOf(code) === 'zh' ? '中文' : '西班牙语';
}

/** Parses `say -v ?` lines: `Mónica              es_ES    # Hola, me llamo Mónica…`. */
export function parseSayVoices(stdout: string): SystemVoice[] {
  const out: SystemVoice[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const hash = line.indexOf('#');
    const left = (hash >= 0 ? line.slice(0, hash) : line).trim();
    const m = /^(.*\S)\s+([a-z]{2,3}(?:[_-][A-Za-z0-9]+)*)$/.exec(left);
    if (!m) continue;
    out.push({ id: m[1]!, name: m[1]!, lang: m[2]!.replace(/_/g, '-') });
  }
  return out;
}

/** Parses the JSON printed by the Windows voice-list script (an array, or a single object). */
export function parseWindowsVoices(json: string): SystemVoice[] {
  const data: unknown = JSON.parse(json);
  const items = Array.isArray(data) ? data : data && typeof data === 'object' ? [data] : [];
  const out: SystemVoice[] = [];
  for (const item of items as { name?: unknown; lang?: unknown; gender?: unknown }[]) {
    if (typeof item?.name !== 'string' || !item.name) continue;
    const gender = typeof item.gender === 'string' ? item.gender.toLowerCase() : '';
    out.push({
      id: item.name,
      name: item.name,
      lang: typeof item.lang === 'string' ? item.lang : '',
      ...(gender === 'female' || gender === 'male' ? { gender } : {}),
    });
  }
  return out;
}

/** Parses `espeak-ng --voices`: `Pty Language Age/Gender VoiceName File Other Languages`. */
export function parseEspeakVoices(stdout: string): SystemVoice[] {
  const out: SystemVoice[] = [];
  for (const line of stdout.split(/\r?\n/).slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    const [, code, ageGender, name] = cols as [string, string, string, string];
    const g = ageGender.split('/')[1];
    out.push({
      id: code,
      name: name.replace(/_/g, ' '),
      lang: code === 'cmn' ? 'zh-CN' : code,
      ...(g === 'F' ? { gender: 'female' as const } : g === 'M' ? { gender: 'male' as const } : {}),
    });
  }
  return out;
}

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/**
 * The PowerShell script is piped on stdin, where each line runs on its own and stdin is read in the
 * OEM code page. So it is one ASCII line inside try/catch, and every value (paths may contain
 * Chinese user names) travels as Base64-encoded UTF-8 JSON.
 */
function powershellLine(params: Record<string, unknown> | null, statements: string[]): string {
  const head = ["$ErrorActionPreference = 'Stop'", '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8'];
  if (params) head.push(`$p = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64(JSON.stringify(params))}')) | ConvertFrom-Json`);
  const body = [...head, 'Add-Type -AssemblyName System.Speech', '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer', ...statements].join('; ');
  return `try { ${body} } catch { [Console]::Error.WriteLine('MI_ERROR ' + $_.Exception.Message); exit 1 }\n`;
}

export function windowsSpeakScript(params: { voice: string; culture: string; rate: number; out: string; textFile: string }): string {
  return powershellLine(params, [
    '$voices = @($s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo })',
    "$lang = $p.culture.Split('-')[0]",
    '$match = $voices | Where-Object { $_.Name -eq $p.voice } | Select-Object -First 1',
    'if ($match) { $s.SelectVoice($match.Name) } else { $s.SelectVoiceByHints([System.Speech.Synthesis.VoiceGender]::NotSet, [System.Speech.Synthesis.VoiceAge]::NotSet, 0, [System.Globalization.CultureInfo]::GetCultureInfo($p.culture)) }',
    // SelectVoiceByHints silently falls back to the default (often English) voice: accept only the right language.
    "if ($s.Voice.Culture.TwoLetterISOLanguageName -ne $lang) { $any = $voices | Where-Object { $_.Culture.TwoLetterISOLanguageName -eq $lang } | Select-Object -First 1; if ($any) { $s.SelectVoice($any.Name) } else { [Console]::Error.WriteLine('MI_NO_VOICE'); exit 3 } }",
    '$s.Rate = [int]$p.rate',
    '$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo -ArgumentList 22050, ([System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen), ([System.Speech.AudioFormat.AudioChannel]::Mono)',
    '$s.SetOutputToWaveFile($p.out, $fmt)',
    '$s.Speak([System.IO.File]::ReadAllText($p.textFile, [System.Text.Encoding]::UTF8))',
    '$s.SetOutputToNull()',
    '$s.Dispose()',
  ]);
}

export function windowsVoicesScript(): string {
  return powershellLine(null, [
    '$list = @($s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { [pscustomobject]@{ name = $_.VoiceInfo.Name; lang = $_.VoiceInfo.Culture.Name; gender = [string]$_.VoiceInfo.Gender } })',
    '$s.Dispose()',
    "[Console]::Out.WriteLine('MI_JSON ' + (ConvertTo-Json -InputObject $list -Compress))",
  ]);
}

/** child_process.spawn with UTF-8 stdio. */
export const defaultExec: ExecFn = (cmd, args, input, signal) =>
  new Promise<ExecResult>((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const onAbort = () => child.kill();
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.stdin.on('error', () => undefined); // the program may exit before reading stdin
    child.on('error', (e) => {
      signal?.removeEventListener('abort', onAbort);
      reject(e);
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(abortError());
      resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), code: code ?? -1 });
    });
    child.stdin.end(input ?? '', 'utf8');
  });

/**
 * Speech synthesis with the voices built into the OS — free and offline: macOS `say`, Windows
 * System.Speech (via PowerShell), Linux espeak-ng. Each request runs the program into a temporary WAV.
 */
export class SystemTts implements Tts {
  readonly id = 'system';
  private readonly platform: NodeJS.Platform;
  private readonly exec: ExecFn;
  private readonly tmpDir: string;
  /** macOS: replacement for a voice that is not installed, per requested voice. */
  private readonly macFallback = new Map<string, string>();

  constructor(opts: SystemTtsOptions = {}) {
    this.platform = opts.platform ?? process.platform;
    this.exec = opts.exec ?? defaultExec;
    this.tmpDir = opts.tmpDir ?? tmpdir();
  }

  /** Well-known voices for the language's base (zh / es), exact region first, the default first of all. */
  voices(lang: LangCode): VoiceInfo[] {
    let def: string;
    let base: string;
    try {
      def = defaultVoice(this.platform, lang);
      base = baseOf(lang);
    } catch {
      return [];
    }
    const all = staticVoices(this.platform).filter((v) => v.lang !== 'multi' && baseOfTag(v.lang) === base);
    const rank = (v: VoiceInfo) => (v.id === def ? 0 : v.lang.toLowerCase() === lang.toLowerCase() ? 1 : 2);
    return [...all].sort((a, b) => rank(a) - rank(b));
  }

  /** Voices actually installed (asks the OS), filtered to a language's base (zh / es) when `lang` is given. */
  listVoices(lang?: LangCode): Promise<VoiceInfo[]> {
    return this.listSystemVoices(lang);
  }

  /** Same as `listVoices`, with the platform's own language tags (e.g. `es-419` from espeak-ng). */
  async listSystemVoices(lang?: LangCode): Promise<SystemVoice[]> {
    let voices: SystemVoice[];
    if (this.platform === 'darwin') {
      const r = await this.run('say', ['-v', '?']);
      voices = parseSayVoices(r.stdout);
    } else if (this.platform === 'win32') {
      const r = await this.run('powershell.exe', POWERSHELL_ARGS, windowsVoicesScript());
      const line = r.stdout.split(/\r?\n/).find((l) => l.startsWith('MI_JSON '));
      if (r.code !== 0 || !line) throw this.failure('读取 Windows 语音列表失败', r);
      voices = parseWindowsVoices(line.slice('MI_JSON '.length));
    } else if (this.platform === 'linux') {
      const r = await this.run('espeak-ng', ['--voices']);
      voices = parseEspeakVoices(r.stdout);
    } else {
      throw new ProviderError('当前系统不支持系统语音', PROVIDER);
    }
    if (!lang) return voices;
    const base = baseOf(lang);
    return voices.filter((v) => baseOfTag(v.lang) === base);
  }

  async *synthesize(req: TtsRequest): AsyncIterable<PcmChunk> {
    const text = req.text.trim();
    if (!text) return;
    if (req.signal?.aborted) throw abortError();
    const code = langInfo(req.lang).code;
    const dir = await mkdtemp(join(this.tmpDir, 'mi-tts-'));
    let audio: { samples: Int16Array; sampleRate: number };
    try {
      const textFile = join(dir, 'text.txt');
      const out = join(dir, 'speech.wav');
      await writeFile(textFile, text, 'utf8');
      await this.render(req, code, textFile, out);
      let bytes: Uint8Array;
      try {
        bytes = await readFile(out);
      } catch {
        throw new ProviderError('系统语音没有生成音频文件', PROVIDER);
      }
      const wav = decodeWav(bytes);
      audio = { samples: toMono(wav.samples, wav.channels), sampleRate: wav.sampleRate };
    } catch (err) {
      if (isAbortError(err) || err instanceof ProviderError) throw err;
      throw new ProviderError(`系统语音合成失败：${err instanceof Error ? err.message : String(err)}`, PROVIDER, { cause: err });
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
    const step = Math.max(1, Math.floor(audio.sampleRate * CHUNK_SECONDS));
    for (let i = 0; i < audio.samples.length; i += step) {
      if (req.signal?.aborted) throw abortError();
      yield { samples: audio.samples.slice(i, i + step), sampleRate: audio.sampleRate };
    }
  }

  private async render(req: TtsRequest, code: LangCode, textFile: string, out: string): Promise<void> {
    if (this.platform === 'darwin') return this.renderMac(req, code, textFile, out);
    if (this.platform === 'win32') return this.renderWindows(req, code, textFile, out);
    if (this.platform === 'linux') {
      const voice = req.voice || defaultVoice('linux', code);
      const r = await this.run('espeak-ng', ['-v', voice, '-s', String(wpmFor(req.rate)), '-w', out, '-f', textFile], undefined, req.signal);
      if (r.code !== 0) throw this.failure('espeak-ng 合成失败', r);
      return;
    }
    throw new ProviderError('当前系统不支持系统语音合成', PROVIDER);
  }

  private async renderMac(req: TtsRequest, code: LangCode, textFile: string, out: string): Promise<void> {
    const wanted = (req.voice || defaultVoice('darwin', code)).normalize('NFC');
    const say = (voice: string) =>
      this.run('say', ['-v', voice, '-r', String(wpmFor(req.rate)), '--file-format=WAVE', '--data-format=LEI16@22050', '-o', out, '-f', textFile], undefined, req.signal);
    const known = this.macFallback.get(wanted);
    let r = await say(known ?? wanted);
    if (r.code !== 0 && /not found|invalid voice/i.test(r.stderr) && !known) {
      // The voice is not installed: use any installed voice of the same language.
      const base = baseOf(code);
      const installed = (await this.listSystemVoices().catch(() => [] as SystemVoice[])).filter((v) => baseOfTag(v.lang) === base);
      const pick = installed.find((v) => v.lang.toLowerCase() === code.toLowerCase()) ?? installed[0];
      if (!pick) {
        throw new ProviderError(
          `这台 Mac 没有安装${languageZh(code)}语音（${wanted}）。请在 系统设置 › 辅助功能 › 朗读内容 › 系统声音 › 管理声音 中下载${languageZh(code)}语音。`,
          PROVIDER,
        );
      }
      this.macFallback.set(wanted, pick.id);
      r = await say(pick.id);
    }
    if (r.code !== 0) throw this.failure('macOS 系统语音合成失败', r);
  }

  private async renderWindows(req: TtsRequest, code: LangCode, textFile: string, out: string): Promise<void> {
    const script = windowsSpeakScript({
      voice: req.voice || defaultVoice('win32', code),
      culture: code,
      rate: sapiRateFor(req.rate),
      out,
      textFile,
    });
    const r = await this.run('powershell.exe', POWERSHELL_ARGS, script, req.signal);
    if (r.stderr.includes('MI_NO_VOICE')) {
      throw new ProviderError(`Windows 没有安装${languageZh(code)}语音。请在 Windows 设置 › 时间和语言 › 语音 中添加${languageZh(code)}语音。`, PROVIDER);
    }
    if (r.code !== 0) throw this.failure('Windows 系统语音合成失败', r);
  }

  /** Runs a program with a timeout; maps "not installed" to a Chinese ProviderError. */
  private async run(cmd: string, args: string[], input?: string, signal?: AbortSignal): Promise<ExecResult> {
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, TIMEOUT_MS);
    try {
      return await this.exec(cmd, args, input, ac.signal);
    } catch (err) {
      if (signal?.aborted) throw abortError();
      if (timedOut) throw new ProviderError(`系统语音合成超时（${cmd}）`, PROVIDER, { retryable: true });
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        if (cmd === 'espeak-ng') throw new ProviderError('没有找到 espeak-ng。请先安装：sudo apt install espeak-ng（或用发行版的包管理器安装 espeak-ng）', PROVIDER, { cause: err });
        throw new ProviderError(`没有找到系统程序 ${cmd}`, PROVIDER, { cause: err });
      }
      throw new ProviderError(`无法运行 ${cmd}：${err instanceof Error ? err.message : String(err)}`, PROVIDER, { cause: err });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private failure(what: string, r: ExecResult): ProviderError {
    const detail = (r.stderr || r.stdout).replace(/MI_ERROR\s*/g, '').trim().slice(0, 300);
    return new ProviderError(`${what}（退出码 ${r.code}）${detail ? `：${detail}` : ''}`, PROVIDER);
  }
}
