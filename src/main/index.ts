import { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, Menu, nativeImage, net, protocol, safeStorage, session, shell, systemPreferences, Tray, utilityProcess } from 'electron';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { release } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PresetId } from '../core/config/presets';
import type { AppSettings, SecretName } from '../core/config/schema';
import { glossaryToCsv, parseGlossaryCsv } from '../core/glossary/csv';
import type { Glossary } from '../core/glossary/types';
import { baseOf } from '../core/lang/languages';
import { createLogger, setLogSink } from '../core/log';
import { createProviders, makeLlm, type Providers } from '../core/providers/registry';
import type { SummaryTemplate } from '../core/session/summary';
import type { Direction } from '../core/types';
import { IPC, type FromAudio, type RendererEvents, type ToAudio } from '../shared/ipc';
import { detectMeetingApps } from './platform/meeting-apps';
import { createNodeContext } from './platform/node-context';
import { testDirection, testLlm } from './provider-test';
import { LocalAsr } from './providers/local-asr/client';
import { ModelManager } from './providers/local-asr/model-manager';
import { modelsForLang, modelsSize, type ModelId } from './providers/local-asr/models';
import { SystemTts } from './providers/system-tts';
import { RoomHost } from './room/room-host';
import { audioConfig, SessionManager } from './session/session-manager';
import { GlossaryStore } from './stores/glossary-store';
import { MeetingsStore } from './stores/meetings-store';
import { SecretStore } from './stores/secret-store';
import { SettingsStore } from './stores/settings-store';
import { createAudioWindow, createMainWindow, createOverlayWindow } from './windows';
import { TRAY_IDLE, TRAY_LIVE, TRAY_TEMPLATE } from './assets/tray-icons';

// Chromium mixes audio of *other* windows back into "exclude own audio" loopback captures unless
// this is disabled; we never want our own speech in the meeting capture.
app.commandLine.appendSwitch('disable-features', 'RestrictOwnAudioAddChromiumBack');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

protocol.registerSchemesAsPrivileged([{ scheme: 'mi-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } }]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// Tests (and portable setups) can point the app at another data directory.
if (process.env['MI_USER_DATA']) app.setPath('userData', process.env['MI_USER_DATA']);
const dataDir = app.getPath('userData');
mkdirSync(dataDir, { recursive: true });
const logPath = join(dataDir, 'app.log');
setLogSink((level, scope, line) => {
  const text = `${new Date().toISOString()} ${level.toUpperCase()} [${scope}] ${line}\n`;
  if (level !== 'debug') process.stdout.write(text);
  try {
    appendFileSync(logPath, text);
  } catch {
    /* ignore */
  }
});
const log = createLogger('main');

const settings = new SettingsStore(dataDir);
const secrets = new SecretStore(dataDir, safeStorage);
const glossaries = new GlossaryStore(dataDir);
const recordsDir = () => settings.get().recording.dir || join(app.getPath('documents'), 'MeetingInterpreter');
const meetings = new MeetingsStore(recordsDir);
const modelsDir = join(dataDir, 'models');
const models = new ModelManager(modelsDir);
const ctx = createNodeContext(createLogger('provider'));

let mainWindow: BrowserWindow | null = null;
let audioWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

function broadcast<K extends keyof RendererEvents>(event: K, payload: RendererEvents[K]): void {
  for (const w of [mainWindow, overlayWindow]) {
    if (w && !w.isDestroyed()) w.webContents.send(IPC.event, { event, payload });
  }
}

function toAudio(msg: ToAudio): void {
  if (!audioWindow || audioWindow.isDestroyed()) return;
  if (msg.type === 'start') {
    // getDisplayMedia (system-audio loopback) needs a user gesture; executeJavaScript can grant one.
    void audioWindow.webContents
      .executeJavaScript(`window.__miAudio && window.__miAudio.start(${JSON.stringify(msg.config)})`, true)
      .catch((err) => log.error('audio start failed', err instanceof Error ? err.message : String(err)));
    return;
  }
  audioWindow.webContents.send(IPC.toAudio, msg);
}

const systemTts = () => new SystemTts();
const localAsr = (dir: Direction) => {
  const s = settings.get();
  void dir;
  return new LocalAsr({
    modelsDir,
    esModel: s.local.esModel,
    spawn: () =>
      utilityProcess.fork(join(__dirname, 'local-asr-worker.js'), [], {
        serviceName: 'local-asr',
        // The sherpa-onnx dylibs are not signed with our (ad-hoc) identity on macOS.
        ...(process.platform === 'darwin' ? { allowLoadingUnsignedLibraries: true } : {}),
      }),
  });
};

function providers(): Providers {
  return createProviders(settings.get(), secrets.all(), ctx, () => glossaries.active(), { systemTts, localAsr });
}

const sessionManager = new SessionManager({
  settings: () => settings.get(),
  glossary: () => glossaries.active(),
  providers,
  recordsDir,
  toAudio,
  broadcast,
  log: createLogger('session'),
});

const room = new RoomHost({
  settings: () => settings.get(),
  session: sessionManager,
  providers,
  glossary: () => glossaries.active(),
  toAudio,
  broadcast,
  log: createLogger('room'),
  dataDir,
  staticDir: () => join(__dirname, '../renderer'),
  devUrl: () => process.env['ELECTRON_RENDERER_URL'],
});

// ------------------------------------------------------------------ IPC

type Handler = (...args: never[]) => unknown;

const handlers: Record<string, Handler> = {
  'settings.get': () => settings.get(),
  'settings.set': (patch: unknown) => {
    const s = settings.set(patch);
    sessionManager.refreshAudio();
    registerShortcuts();
    updateTray();
    broadcast('settings', s);
    return s;
  },
  'settings.applyPreset': (id: PresetId) => {
    const s = settings.applyPreset(id);
    broadcast('settings', s);
    if (usesLocalAsr()) void prefetchModels();
    return s;
  },
  'secrets.status': () => secrets.status(),
  'secrets.set': (name: SecretName, value: string) => secrets.set(name, value),

  'glossary.list': () => glossaries.list(),
  'glossary.save': (g: Glossary) => glossaries.save(g),
  'glossary.remove': (id: string) => glossaries.remove(id),
  'glossary.importCsv': async (targetId: string | null) => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      title: '导入术语表',
      filters: [{ name: '术语表', extensions: ['csv', 'txt', 'tsv'] }],
      properties: ['openFile'],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    const parsed = parseGlossaryCsv(readFileSync(res.filePaths[0], 'utf8'));
    const name = res.filePaths[0].split(/[\\/]/).pop()!.replace(/\.[^.]+$/, '');
    const list = glossaries.addEntries(targetId, parsed.entries, name);
    return { imported: parsed.entries.length, errors: parsed.errors, glossaries: list };
  },
  'glossary.exportCsv': async (id: string) => {
    const g = glossaries.list().find((x) => x.id === id);
    if (!g) return false;
    const res = await dialog.showSaveDialog(mainWindow!, { title: '导出术语表', defaultPath: `${g.name}.csv`, filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (res.canceled || !res.filePath) return false;
    writeFileSync(res.filePath, glossaryToCsv(g.entries), 'utf8');
    return true;
  },

  'meeting.start': async (opts: { title?: string; platform?: string; mode?: 'meeting' | 'room' }) => {
    if (process.platform === 'darwin') await systemPreferences.askForMediaAccess('microphone').catch(() => false);
    await requireLocalModels(opts?.mode ?? 'meeting');
    const state = await sessionManager.start(opts ?? {});
    updateTray();
    if (settings.get().ui.overlay.enabled && opts?.mode !== 'room') showOverlay();
    return state;
  },
  'meeting.stop': async () => {
    const meta = await sessionManager.stop();
    updateTray();
    return meta;
  },
  'meeting.state': () => sessionManager.state,
  'meeting.setOut': (on: boolean) => {
    sessionManager.setOut(on);
    updateTray();
  },
  'meeting.setIn': (on: boolean) => {
    sessionManager.setIn(on);
    updateTray();
  },
  'meeting.setInSpeak': (on: boolean) => sessionManager.setInSpeak(on),
  'meeting.setPassthrough': (on: boolean) => sessionManager.setPassthrough(on),
  'meeting.pushToTalk': (down: boolean) => sessionManager.pushToTalk(down),
  'meeting.skip': (dir: Direction) => sessionManager.skip(dir),
  'meeting.setRecording': (opts: { audio?: boolean; screen?: boolean; screenSourceId?: string }) => {
    settings.set({ recording: opts });
  },

  'meetings.list': () => meetings.list(),
  'meetings.get': (id: string) => meetings.get(id),
  'meetings.summarize': async (id: string, template: SummaryTemplate) => {
    const detail = meetings.get(id);
    if (!detail) throw new Error('会议不存在');
    const llm = makeLlm(settings.get(), secrets.all(), ctx, true);
    if (!llm) throw new Error('请先在“服务设置”里配置大模型（例如免费的智谱 GLM），才能生成纪要');
    return sessionManager.writeSummary(detail.folder, detail.meta, detail.segments, llm, template);
  },
  'meetings.rename': (id: string, title: string) => meetings.rename(id, title),
  'meetings.remove': async (id: string) => {
    await shell.trashItem(meetings.folder(id));
  },
  'meetings.openFolder': (id: string) => shell.openPath(meetings.folder(id)),
  'meetings.openFile': (id: string, rel: string) => shell.openPath(meetings.filePath(id, rel)),
  'meetings.fileUrl': (id: string, rel: string) => `mi-media://file/${encodeURIComponent(id)}/${rel.split('/').map(encodeURIComponent).join('/')}`,

  'providers.test': async (scope: 'out' | 'in' | 'llm') => {
    const s = settings.get();
    if (scope === 'llm') return testLlm(makeLlm(s, secrets.all(), ctx, true));
    let p: Providers;
    try {
      p = providers();
    } catch (err) {
      return [{ name: '准备', ok: false, ms: 0, detail: err instanceof Error ? err.message : String(err) }];
    }
    return scope === 'out' ? testDirection(p, 'out', s.languages.self, s.languages.remote) : testDirection(p, 'in', s.languages.remote, s.languages.self);
  },
  'providers.voices': async (provider: string, langCode: string) => {
    const s = settings.get();
    try {
      if (provider === 'system') return await new SystemTts().listVoices(langCode);
      const p = createProviders({ ...s, out: { ...s.out, tts: provider as AppSettings['out']['tts'] } }, secrets.all(), ctx, () => [], { systemTts, localAsr });
      return p.tts('out')?.voices(langCode) ?? [];
    } catch {
      return [];
    }
  },

  'local.status': () => models.statusList(settings.get().local.esModel),
  'local.download': async (base: 'zh' | 'es') => {
    await models.ensureFor(base, settings.get().local.esModel, (p) => broadcast('model-progress', p));
  },

  'audio.testTone': (target: 'virtualMic' | 'headphones') => {
    toAudio({ type: 'testTone', target, config: audioConfig(settings.get(), 'meeting') });
  },

  'room.start': async () => {
    await requireLocalModels('room');
    return room.start();
  },
  'room.stop': () => room.stop(),
  'room.state': () => room.state(),
  'room.setPublic': (on: boolean) => room.setPublic(on),

  'app.info': () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    recordsDir: recordsDir(),
    dataDir,
    osVersion: release(),
  }),
  'app.openExternal': (url: string) => {
    // Web links, and the OS privacy/sound settings pages we point people to.
    if (/^https?:\/\//.test(url) || /^x-apple\.systempreferences:/.test(url) || /^ms-settings:/.test(url)) return shell.openExternal(url);
  },
  'app.detectMeetingApps': () => detectMeetingApps(),
  'app.screenSources': async () => {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } });
    return sources.map((s) => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL(), kind: s.id.startsWith('screen') ? 'screen' : 'window' }));
  },
  'app.chooseRecordsDir': async () => {
    const res = await dialog.showOpenDialog(mainWindow!, { title: '选择会议记录保存位置', properties: ['openDirectory', 'createDirectory'] });
    if (res.canceled || !res.filePaths[0]) return null;
    settings.set({ recording: { dir: res.filePaths[0] } });
    return res.filePaths[0];
  },
  'app.showWindow': (name: 'main' | 'overlay') => (name === 'main' ? showMain() : showOverlay(true)),
  'app.setOverlayClickThrough': (on: boolean) => {
    settings.set({ ui: { overlay: { clickThrough: on } } });
    overlayWindow?.setIgnoreMouseEvents(on, { forward: true });
  },
};

function usesLocalAsr(): boolean {
  const s = settings.get();
  return s.out.asr === 'local' || s.in.asr === 'local';
}

let prefetching: Promise<void> | null = null;

/** Downloads the offline models the current settings need, in the background, once. */
function prefetchModels(): Promise<void> {
  if (prefetching) return prefetching;
  const s = settings.get();
  const bases = new Set<'zh' | 'es'>();
  if (s.out.asr === 'local') bases.add(baseOf(s.languages.self));
  if (s.in.asr === 'local') bases.add(baseOf(s.languages.remote));
  prefetching = (async () => {
    for (const base of bases) await models.ensureFor(base, s.local.esModel, (p) => broadcast('model-progress', p));
    broadcast('toast', { level: 'info', message: '本机离线识别模型已下载完成。' });
  })()
    .catch((err) => broadcast('toast', { level: 'warn', message: `下载本机识别模型失败：${err instanceof Error ? err.message : String(err)}（可在 设置 › 翻译服务 里重试）` }))
    .finally(() => {
      prefetching = null;
    });
  return prefetching;
}

/** Before a meeting with offline recognition, make sure its models are on disk. */
async function requireLocalModels(mode: 'meeting' | 'room'): Promise<void> {
  if (!usesLocalAsr()) return;
  const s = settings.get();
  const needed = new Set<ModelId>();
  if (s.out.asr === 'local') modelsForLang(s.languages.self, s.local.esModel).forEach((id) => needed.add(id));
  if (s.in.asr === 'local' && mode === 'meeting') modelsForLang(s.languages.remote, s.local.esModel).forEach((id) => needed.add(id));
  if (mode === 'room' && s.in.asr === 'local') modelsForLang(s.languages.remote, s.local.esModel).forEach((id) => needed.add(id));
  const missing = [...needed].filter((id) => models.status(id) !== 'ready');
  if (!missing.length) return;
  if (!prefetching) void prefetchModels();
  const mb = Math.round(modelsSize(missing) / 1_000_000);
  throw new Error(`正在下载本机离线识别模型（约 ${mb} MB），下载完成后即可开始${mode === 'room' ? '房间' : '同传'}。可在 设置 › 翻译服务 查看进度，或改用其他方案。`);
}

ipcMain.handle(IPC.invoke, async (_e, method: string, ...args: unknown[]) => {
  const h = handlers[method];
  if (!h) throw new Error(`unknown method ${method}`);
  try {
    return await (h as (...a: unknown[]) => unknown)(...args);
  } catch (err) {
    log.warn(`${method} failed`, err instanceof Error ? err.message : String(err));
    throw err instanceof Error ? new Error(err.message) : new Error(String(err));
  }
});

ipcMain.on(IPC.fromAudio, (_e, msg: FromAudio) => {
  sessionManager.handleAudio(msg);
  room.handleAudio(msg);
});

// ------------------------------------------------------------------ windows, tray, shortcuts

function showMain(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow();
    mainWindow.on('close', (e) => {
      // Keep interpreting from the tray when a meeting is running.
      if (!quitting && (sessionManager.active || room.active)) {
        e.preventDefault();
        mainWindow?.hide();
      }
    });
  }
  mainWindow.show();
  mainWindow.focus();
}

function showOverlay(force = false): void {
  const o = settings.get().ui.overlay;
  if (!o.enabled && !force) return;
  if (!overlayWindow || overlayWindow.isDestroyed()) overlayWindow = createOverlayWindow({ contentProtection: o.contentProtection, clickThrough: o.clickThrough });
  overlayWindow.setContentProtection(o.contentProtection);
  overlayWindow.showInactive();
}

function toggleOverlay(): void {
  if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) overlayWindow.hide();
  else showOverlay(true);
}

function trayIcon(): Electron.NativeImage {
  const active = sessionManager.active || room.active;
  // macOS menu bar wants a monochrome "template" image; elsewhere a coloured one.
  const url = process.platform === 'darwin' && !active ? TRAY_TEMPLATE : active ? TRAY_LIVE : TRAY_IDLE;
  const img = nativeImage.createFromDataURL(url).resize({ width: 18, height: 18 });
  if (process.platform === 'darwin' && !active) img.setTemplateImage(true);
  return img;
}

function updateTray(): void {
  if (!tray) return;
  const st = sessionManager.state;
  const menu = Menu.buildFromTemplate([
    { label: '打开主窗口', click: showMain },
    { type: 'separator' },
    st.active
      ? { label: '结束会议', click: () => void handlers['meeting.stop']!() }
      : { label: '开始会议同传', click: () => void (handlers['meeting.start'] as (o: object) => Promise<unknown>)({}) },
    { label: '翻译我的发言（中→西）', type: 'checkbox', checked: st.out.enabled, enabled: st.active, click: (i) => sessionManager.setOut(i.checked) },
    { label: '翻译会议声音（西→中）', type: 'checkbox', checked: st.in.enabled, enabled: st.active && st.mode === 'meeting', click: (i) => sessionManager.setIn(i.checked) },
    { label: '显示/隐藏字幕', click: toggleOverlay },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.setImage(trayIcon());
  tray.setToolTip(st.active ? '会议同传：进行中' : '会议同传助手');
}

function registerShortcuts(): void {
  globalShortcut.unregisterAll();
  const sc = settings.get().shortcuts;
  const tryReg = (accel: string, fn: () => void) => {
    if (!accel) return;
    try {
      if (!globalShortcut.register(accel, fn)) log.warn(`shortcut ${accel} is taken`);
    } catch (err) {
      log.warn(`invalid shortcut ${accel}`, err instanceof Error ? err.message : String(err));
    }
  };
  tryReg(sc.toggleOut, () => {
    if (!sessionManager.active) return;
    sessionManager.setOut(!sessionManager.state.out.enabled);
    updateTray();
  });
  tryReg(sc.toggleOverlay, toggleOverlay);
  // Global shortcuts have no key-up event: push-to-talk toggles talk on/off.
  tryReg(sc.pushToTalk, () => {
    if (!sessionManager.active) return;
    sessionManager.pushToTalk(!sessionManager.state.out.gate);
  });
}

function buildAppMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.on('second-instance', () => showMain());

app.whenReady().then(() => {
  buildAppMenu();
  protocol.handle('mi-media', (req) => {
    // mi-media://file/<meeting id>/<relative path>
    const url = new URL(req.url);
    const [id, ...rest] = url.pathname.replace(/^\//, '').split('/').map(decodeURIComponent);
    const path = meetings.filePath(id!, rest.join('/'));
    return net.fetch(pathToFileURL(path).toString(), { headers: req.headers });
  });

  // System-audio loopback for "meeting audio from system sound": Electron swaps in Chromium's
  // loopbackWithoutChrome when the page asks for restrictOwnAudio (macOS 14.2+, Windows 11).
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
        .then((sources) => callback(sources[0] ? { video: sources[0], audio: 'loopback' } : {}))
        .catch(() => callback({}));
    },
    { useSystemPicker: false },
  );

  audioWindow = createAudioWindow();
  audioWindow.on('closed', () => {
    audioWindow = null;
    if (!quitting) audioWindow = createAudioWindow();
  });
  showMain();
  tray = new Tray(trayIcon());
  tray.on('click', showMain);
  updateTray();
  registerShortcuts();
  settings.on('changed', () => updateTray());
  sessionManager.on('ended', () => updateTray());
  log.info(`started ${app.getVersion()} on ${process.platform} ${process.arch}`);
});

app.on('activate', () => showMain());

app.on('before-quit', () => {
  quitting = true;
});

app.on('window-all-closed', () => {
  // Stay in the tray on every platform while a meeting runs; otherwise quit (except macOS).
  if (process.platform !== 'darwin' && !sessionManager.active && !room.active) app.quit();
});

app.on('will-quit', async (e) => {
  globalShortcut.unregisterAll();
  if (sessionManager.active) {
    e.preventDefault();
    await sessionManager.stop().catch(() => undefined);
    app.quit();
  }
  void room.stop();
});

