import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, type ElectronApplication } from '@playwright/test';
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

export async function launchApp(settings: object = {}): Promise<{ app: ElectronApplication; dataDir: string; recordsDir: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'mi-e2e-data-'));
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
