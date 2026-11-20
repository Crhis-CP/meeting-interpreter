import { BrowserWindow, screen, shell } from 'electron';
import { join } from 'node:path';

const preload = (name: string) => join(__dirname, '../preload', `${name}.js`);

function load(win: BrowserWindow, page: 'index' | 'overlay' | 'audio' | 'room'): void {
  const dev = process.env['ELECTRON_RENDERER_URL'];
  if (dev) void win.loadURL(`${dev}/${page}.html`);
  else void win.loadFile(join(__dirname, '../renderer', `${page}.html`));
}

function harden(win: BrowserWindow): void {
  // Open external links in the browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    const dev = process.env['ELECTRON_RENDERER_URL'];
    if (!(dev && url.startsWith(dev)) && !url.startsWith('file://')) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    }
  });
}

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 940,
    minHeight: 620,
    show: false,
    title: '会议同传助手',
    backgroundColor: '#f5f6f8',
    autoHideMenuBar: true,
    webPreferences: {
      preload: preload('index'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  harden(win);
  win.once('ready-to-show', () => win.show());
  load(win, 'index');
  return win;
}

/**
 * The hidden window that owns every microphone, loopback capture, playback and MediaRecorder.
 * TTS must be played from here: Chromium only excludes the capturing page's own audio from
 * system loopback.
 */
export function createAudioWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 400,
    height: 300,
    show: false,
    webPreferences: {
      preload: preload('audio'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  load(win, 'audio');
  return win;
}

export function createOverlayWindow(opts: { contentProtection: boolean; clickThrough: boolean }): BrowserWindow {
  const area = screen.getPrimaryDisplay().workArea;
  const width = Math.min(1000, Math.round(area.width * 0.7));
  const height = 190;
  const win = new BrowserWindow({
    x: Math.round(area.x + (area.width - width) / 2),
    y: area.y + area.height - height - 40,
    width,
    height,
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    focusable: true,
    show: false,
    title: '同传字幕',
    webPreferences: {
      preload: preload('index'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Keep subtitles out of screen sharing and our own screen recording unless the user opts in.
  win.setContentProtection(opts.contentProtection);
  if (opts.clickThrough) win.setIgnoreMouseEvents(true, { forward: true });
  harden(win);
  load(win, 'overlay');
  return win;
}
