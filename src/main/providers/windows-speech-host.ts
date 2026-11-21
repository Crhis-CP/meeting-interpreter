/**
 * Windows system voices without starting PowerShell for every sentence: one long-running
 * PowerShell keeps System.Speech loaded and renders one sentence per stdin line, answering
 * `MI_DONE <id>` / `MI_FAIL <id> <message>` / `MI_NO_VOICE <id>` on stdout.
 *
 * Starting powershell.exe and loading System.Speech costs about a second; this pays it once.
 * If the host does not come up or misbehaves, SystemTts falls back to one process per sentence.
 */
import { constants as osConstants, setPriority } from 'node:os';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { POWERSHELL_ARGS } from './system-tts-args';

export interface SpeakJob {
  voice: string;
  culture: string;
  rate: number;
  out: string;
  textFile: string;
}

export class NoVoiceError extends Error {}

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

/** Loads System.Speech once; `$voices` and `$fmt` are reused by every job. One ASCII line (see system-tts). */
export function hostInitLine(): string {
  const body = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    '$voices = @($s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo })',
    '$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo -ArgumentList 22050, ([System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen), ([System.Speech.AudioFormat.AudioChannel]::Mono)',
    "[Console]::Out.WriteLine('MI_READY')",
    '[Console]::Out.Flush()',
  ].join('; ');
  return `try { ${body} } catch { [Console]::Out.WriteLine('MI_INIT_FAILED ' + $_.Exception.Message); [Console]::Out.Flush(); exit 1 }\n`;
}

/** One sentence: choose the voice (only of the right language), render to a WAV file, report. */
export function hostJobLine(id: number, job: SpeakJob): string {
  const p = `$p = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64(JSON.stringify(job))}')) | ConvertFrom-Json`;
  const body = [
    p,
    "$lang = $p.culture.Split('-')[0]",
    '$match = $voices | Where-Object { $_.Name -eq $p.voice } | Select-Object -First 1',
    "if (-not $match) { $match = $voices | Where-Object { $_.Culture.Name -eq $p.culture } | Select-Object -First 1 }",
    "if (-not $match) { $match = $voices | Where-Object { $_.Culture.TwoLetterISOLanguageName -eq $lang } | Select-Object -First 1 }",
    `if (-not $match) { [Console]::Out.WriteLine('MI_NO_VOICE ${id}'); [Console]::Out.Flush() } else { $s.SelectVoice($match.Name); $s.Rate = [int]$p.rate; $s.SetOutputToWaveFile($p.out, $fmt); $s.Speak([System.IO.File]::ReadAllText($p.textFile, [System.Text.Encoding]::UTF8)); $s.SetOutputToNull(); [Console]::Out.WriteLine('MI_DONE ${id}'); [Console]::Out.Flush() }`,
  ].join('; ');
  return `try { ${body} } catch { try { $s.SetOutputToNull() } catch {}; [Console]::Out.WriteLine('MI_FAIL ${id} ' + $_.Exception.Message); [Console]::Out.Flush() }\n`;
}

type Spawn = () => ChildProcessWithoutNullStreams;

export class WindowsSpeechHost {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private seq = 0;
  private buf = '';
  private waiting = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
  private chain: Promise<unknown> = Promise.resolve();
  private failures = 0;
  /** Gave up on the long-running host (the per-sentence path is used instead). */
  broken = false;

  constructor(
    private readonly spawnHost: Spawn = () => {
      const child = spawn('powershell.exe', POWERSHELL_ARGS, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      // Slightly below normal, like the other workers: the meeting app goes first when the computer is busy.
      child.once('spawn', () => {
        try {
          if (child.pid) setPriority(child.pid, osConstants.priority.PRIORITY_BELOW_NORMAL);
        } catch {
          /* not allowed: keep normal priority */
        }
      });
      return child;
    },
    // A cold PowerShell (first start after boot, antivirus scanning) took 24 s on a CI machine.
    private readonly timeouts = { startMs: 60_000, jobMs: 60_000 },
  ) {}

  /** Starts the process as a meeting starts, so the first sentence does not pay for it. */
  warmUp(): void {
    if (this.broken) return;
    this.start().catch(() => {
      this.failed();
      this.dispose();
    });
  }

  /** Renders one sentence (one at a time). Rejects with NoVoiceError, or any other error. */
  speak(job: SpeakJob): Promise<void> {
    const run = this.chain.then(() => this.run(job));
    this.chain = run.catch(() => undefined);
    return run;
  }

  dispose(): void {
    this.child?.kill();
    this.child = null;
    this.ready = null;
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    const child = this.spawnHost();
    this.child = child;
    this.buf = '';
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('系统语音进程没有响应')), this.timeouts.startMs);
      const onLine = (line: string) => {
        if (line === 'MI_READY') {
          clearTimeout(timer);
          resolve();
          return;
        }
        if (line.startsWith('MI_INIT_FAILED')) {
          clearTimeout(timer);
          reject(new Error(line.slice('MI_INIT_FAILED'.length).trim() || '系统语音初始化失败'));
          return;
        }
        const m = line.match(/^MI_(DONE|FAIL|NO_VOICE) (\d+) ?(.*)$/);
        if (!m) return;
        const w = this.waiting.get(Number(m[2]));
        if (!w) return;
        this.waiting.delete(Number(m[2]));
        if (m[1] === 'DONE') w.resolve();
        else if (m[1] === 'NO_VOICE') w.reject(new NoVoiceError('没有这种语言的语音'));
        else w.reject(new Error(m[3] || '系统语音合成失败'));
      };
      child.stdout.on('data', (d: Buffer) => {
        this.buf += d.toString('utf8');
        let i: number;
        while ((i = this.buf.indexOf('\n')) >= 0) {
          const line = this.buf.slice(0, i).replace(/\r$/, '').trim();
          this.buf = this.buf.slice(i + 1);
          if (line) onLine(line);
        }
      });
      child.stdin.on('error', () => undefined);
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on('exit', () => {
        clearTimeout(timer);
        reject(new Error('系统语音进程退出了'));
        for (const w of this.waiting.values()) w.reject(new Error('系统语音进程退出了'));
        this.waiting.clear();
        if (this.child === child) {
          this.child = null;
          this.ready = null;
        }
      });
    });
    child.stdin.write(hostInitLine());
    return this.ready;
  }

  private async run(job: SpeakJob): Promise<void> {
    try {
      await this.start();
    } catch (err) {
      this.failed(); // this sentence goes the per-sentence way; the next one tries the host again
      this.dispose();
      throw err;
    }
    const id = ++this.seq;
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.waiting.delete(id);
          reject(new Error('系统语音合成超时'));
        }, this.timeouts.jobMs);
        this.waiting.set(id, {
          resolve: () => (clearTimeout(timer), resolve()),
          reject: (e) => (clearTimeout(timer), reject(e)),
        });
        this.child!.stdin.write(hostJobLine(id, job));
      });
      this.failures = 0;
    } catch (err) {
      if (!(err instanceof NoVoiceError)) {
        this.failed();
        this.dispose();
      }
      throw err;
    }
  }

  /** Twice in a row (starting or speaking): something is off with the long-running host; stop using it. */
  private failed(): void {
    if (++this.failures >= 2) this.broken = true;
  }
}
