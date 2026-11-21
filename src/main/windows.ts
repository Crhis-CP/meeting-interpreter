import { BrowserWindow, screen, shell } from 'electron';
import { join } from 'node:path';
import { appPageUrl, isAppUrl, type AppPage } from './app-protocol';
import { devRendererUrl } from './dev-url';
import { overlayDefaultBounds, visibleBounds, type Bounds } from './overlay-bounds';

const preload = (name: string) => join(__dirname, '../preload', `${name}.js`);

function load(win: BrowserWindow, page: AppPage): void {
  const dev = devRendererUrl();
  // Packaged / built app: our own mi-app:// scheme (see app-protocol.ts), never file://.
  void win.loadURL(dev ? `${dev}/${page}.html` : appPageUrl(page));
}

function harden(win: BrowserWindow): void {
  // Open external links in the browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    const dev = devRendererUrl();
    if (!(dev && url.startsWith(dev)) && !isAppUrl(url)) {
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
    autoHideMenuBar: true,
    // macOS: native translucent sidebar and inset traffic lights, like Apple's own apps.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, vibrancy: 'sidebar' as const, visualEffectState: 'followWindow' as const, backgroundColor: '#00000000' }
      : { backgroundColor: '#f5f5f7' }),
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

export function createOverlayWindow(opts: { contentProtection: boolean; clickThrough: boolean; bounds?: Bounds | null }): BrowserWindow {
  const areas = screen.getAllDisplays().map((d) => d.workArea);
  const b = visibleBounds(opts.bounds, areas) ?? overlayDefaultBounds(screen.getPrimaryDisplay().workArea);
  const win = new BrowserWindow({
    ...b,
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    // Clicking or dragging the subtitles never takes the keyboard from the meeting app (its
    // shortcuts, e.g. space to unmute, keep working). Linux needs focus to take clicks at all.
    focusable: process.platform === 'linux',
    // macOS: the first click on ✕ acts instead of only bringing the app forward.
    acceptFirstMouse: true,
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
  // Above normal windows (also a full-screen meeting), but below the system's menus, the meeting
  // app's share toolbar and notifications (the 'screen-saver' level covered all of those).
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Keep subtitles out of screen sharing and our own screen recording unless the user opts in.
  win.setContentProtection(opts.contentProtection);
  if (opts.clickThrough) win.setIgnoreMouseEvents(true, { forward: true });
  harden(win);
  load(win, 'overlay');
  return win;
}
