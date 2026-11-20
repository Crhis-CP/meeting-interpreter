import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, type ElectronApplication, type TestInfo } from '@playwright/test';
import { concatInt16, silence, tone } from '../src/core/audio/pcm';
import { encodeWav } from '../src/core/audio/wav';

/** A WAV with bursts of "speech" that Chromium plays as the fake microphone. */
export function speechWav(dir: string): string {
  const R = 48000;
  const audio = concatInt16([silence(1, R), tone(1.2, 300, R, 0.4), silence(1.5, R), tone(1.2, 350, R, 0.4), silence(2, R)]);
  const path = join(dir, 'speech.wav');
  writeFileSync(path, encodeWav(audio, R));
  return path;
}

const launchedDataDirs: string[] = [];

/**
 * For test.afterEach: when the test failed, attaches each app's log to the report and prints its
 * end, so a CI failure shows what the app itself saw (audio devices, levels, errors).
 */
export async function attachAppLogs(info: TestInfo): Promise<void> {
  const dirs = launchedDataDirs.splice(0);
  if (info.status === info.expectedStatus) return;
  for (const d of dirs) {
    const p = join(d, 'app.log');
    if (!existsSync(p)) continue;
    const text = readFileSync(p, 'utf8');
    await info.attach('app.log', { body: text, contentType: 'text/plain' });
    console.log(`--- app.log (last 60 lines) ---\n${text.trimEnd().split('\n').slice(-60).join('\n')}\n---`);
  }
}

export async function launchApp(settings: object = {}): Promise<{ app: ElectronApplication; dataDir: string; recordsDir: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'mi-e2e-data-'));
  launchedDataDirs.push(dataDir);
  const recordsDir = mkdtempSync(join(tmpdir(), 'mi-e2e-rec-'));
  writeFileSync(
    join(dataDir, 'settings.json'),
    JSON.stringify({
      onboarded: true,
      preset: 'demo',
      out: { enabled: true, asr: 'demo', mt: 'demo', tts: 'demo', voice: '' },
      in: { enabled: true, asr: 'demo', mt: 'demo', tts: 'demo', voice: '' },
      devices: { meetingSource: 'none' },
      recording: { audio: true, screen: false, dir: recordsDir },
      summary: { autoAtEnd: false },
      ui: { overlay: { enabled: false } },
      ...settings,
    }),
  );
  const wav = speechWav(dataDir);
  // MI_APP_EXECUTABLE runs a packaged build (e.g. the released AppImage, extracted) instead of the source.
  const packaged = process.env.MI_APP_EXECUTABLE;
  const app = await electron.launch({
    ...(packaged ? { executablePath: packaged } : {}),
    args: [
      ...(packaged ? ['--no-sandbox'] : ['.']),
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${wav}`,
      // macOS: the sandboxed audio-service process cannot read the WAV above and captures
      // silence; run the audio service inside the browser process for tests.
      ...(process.platform === 'darwin' ? ['--disable-features=AudioServiceOutOfProcess'] : []),
      '--disable-audio-output',
      '--disable-gpu',
    ],
    env: { ...process.env, MI_USER_DATA: dataDir },
  });
  return { app, dataDir, recordsDir };
}

/** The main window (the hidden audio window may be created first). */
export async function mainWindow(app: ElectronApplication) {
  for (let i = 0; i < 100; i++) {
    const w = app.windows().find((p) => p.url().includes('index.html'));
    if (w) return w;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('main window not found');
}
