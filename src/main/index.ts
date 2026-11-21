import { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, Menu, nativeImage, net, protocol, safeStorage, session, shell, systemPreferences, Tray, utilityProcess } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { availableParallelism, constants as osConstants, homedir, release, setPriority, tmpdir, totalmem } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PresetId } from '../core/config/presets';
import { parseSettings, type AppSettings, type SecretName } from '../core/config/schema';
import { glossaryToCsv, parseGlossaryCsv } from '../core/glossary/csv';
import type { Glossary } from '../core/glossary/types';
import { baseOf, type LangBase } from '../core/lang/languages';
import { findHits, hotwordsFor } from '../core/glossary/match';
import { calibrationScript } from '../core/profile/calibration';
import { runCalibration } from '../core/profile/calibrate';
import { learnFromEdit } from '../core/profile/learn';
import { addCalibration, addCorrections, mergeProfiles, personalFor, profileHotwords, ProfileSchema, recordConfusions, removeCorrection, userPairs } from '../core/profile/profile';
import { reviewMeeting as reviewMeetingCore } from '../core/profile/review';
import { createLogger, setLogSink, type Logger } from '../core/log';
import { isAbortError } from '../core/events';
import { createProviders, makeLlm, type Providers } from '../core/providers/registry';
import { azureVoicesFor } from '../core/providers/azure';
import { DashscopeTts, createClonedVoice, deleteClonedVoice, waitForVoice } from '../core/providers/dashscope';
import type { SummaryTemplate } from '../core/session/summary';
import type { Direction, TranscriptSegment } from '../core/types';
import { IPC, type FromAudio, type ProfileView, type ReadinessItem, type RendererEvents, type StorageInfo, type UninstallResult, type StoredReview, type ToAudio } from '../shared/ipc';
import { detectMeetingApps } from './platform/meeting-apps';
import { restoreAudioDefaults, savedAudioDefaults } from './platform/audio-defaults';
import { KEY_NAMES, missingKeys } from '../core/config/readiness';
import { collectStorage } from './storage';
import { cleanupData, rotateLog } from './maintenance';
import { windowsDataDir } from './data-location';
import { afterExitCommand, planUninstall, safeToDelete, startAfterExit, writeBackup, type UninstallPlan } from './uninstall';
import { installedVirtualAudio, installVirtualAudio, removeVirtualAudio } from './platform/virtual-audio';
import { createNodeContext } from './platform/node-context';
import { testDirection, testLlm } from './provider-test';
import { LocalAsr } from './providers/local-asr/client';
import { ModelManager } from './providers/local-asr/model-manager';
import { modelsForLang, modelsSize, type ModelId } from './providers/local-asr/models';
import { SystemTts } from './providers/system-tts';
import { RoomHost } from './room/room-host';
import { AudioWindowMt } from './offline-mt';
import { OfflineTranslator } from '../core/providers/offline-translator';
import manifest from '../browser/offline-mt/manifest.json';

const OFFLINE_MT_TOTAL = manifest.files.reduce((n, f) => n + f.size, 0);
import { DesktopBridge } from './bridge/desktop-bridge';
import { audioConfig, SessionManager, writeTranscriptFiles } from './session/session-manager';
import { GlossaryStore } from './stores/glossary-store';
import { MeetingsStore } from './stores/meetings-store';
import { ProfileStore } from './stores/profile-store';
import { AI_MODELS, aiModelFile, type AiModelId } from './providers/local-ai/model';
import { LocalAiClient } from './providers/local-ai/client';
import { createInProcessAiWorker } from './providers/local-ai/worker';
import { SecretStore } from './stores/secret-store';
import { SettingsStore } from './stores/settings-store';
import { createAudioWindow, createMainWindow, createOverlayWindow } from './windows';
import { checkForUpdate, type UpdateInfo } from './update-check';
import { downloadUpdate } from './updater';
import { TRAY_IDLE, TRAY_LIVE, TRAY_TEMPLATE } from './assets/tray-icons';
import { APP_SCHEME, appFilePath, contentTypeOf, isAppUrl } from './app-protocol';
import { devRendererUrl } from './dev-url';

// Chromium mixes audio of *other* windows back into "exclude own audio" loopback captures unless
// this is disabled; we never want our own speech in the meeting capture.
app.commandLine.appendSwitch('disable-features', 'RestrictOwnAudioAddChromiumBack');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

protocol.registerSchemesAsPrivileged([
  // The app's own pages (instead of file://, whose extra privileges are switched off in packaged builds).
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
  { scheme: 'mi-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);
const rendererDir = join(__dirname, '../renderer');

// Windows: data in %LOCALAPPDATA% (not the roaming profile); an earlier install's folder is moved
// over. Before the single-instance lock, which keeps a file open in the data folder.
let movedData: ReturnType<typeof windowsDataDir> | null = null;
if (process.platform === 'win32' && !process.env['MI_USER_DATA'] && process.env['LOCALAPPDATA']) {
  movedData = windowsDataDir({ roaming: app.getPath('appData'), local: process.env['LOCALAPPDATA'], name: app.getName(), fs: { exists: existsSync, rename: renameSync } });
  app.setPath('userData', movedData.dir);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// Tests (and portable setups) can point the app at another data directory.
if (process.env['MI_USER_DATA']) {
  app.setPath('userData', process.env['MI_USER_DATA']);
  // (and keeps backups such as the one before uninstalling out of the real Downloads folder)
  app.setPath('downloads', `${process.env['MI_USER_DATA']}-downloads`);
}
const dataDir = app.getPath('userData');
mkdirSync(dataDir, { recursive: true });
const logPath = join(dataDir, 'app.log');
// At most two logs of 5 MB (about 20 meetings each): checked now and every few hundred lines.
rotateLog(logPath);
let logLines = 0;
setLogSink((level, scope, line) => {
  const text = `${new Date().toISOString()} ${level.toUpperCase()} [${scope}] ${line}\n`;
  if (level !== 'debug') process.stdout.write(text);
  try {
    if (++logLines % 500 === 0) rotateLog(logPath);
    appendFileSync(logPath, text);
  } catch {
    /* ignore */
  }
});
const log = createLogger('main');
if (movedData?.moved) log.info(`moved the data folder to ${movedData.dir} (models, settings and keys came along)`);
if (movedData?.error) log.warn(`could not move the data folder to Local, keeping ${movedData.dir}: ${movedData.error}`);

// Never show Electron's modal error box in the middle of a meeting: log it and tell the window.
process.on('uncaughtException', (err) => {
  log.error('uncaught exception', err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err));
  try {
    broadcast('toast', { level: 'error', message: `内部错误：${err instanceof Error ? err.message : String(err)}（详情见日志 app.log）` });
  } catch {
    /* windows may not exist yet */
  }
});
process.on('unhandledRejection', (reason) => {
  log.error('unhandled rejection', reason instanceof Error ? `${reason.message}\n${reason.stack ?? ''}` : String(reason));
});

const settings = new SettingsStore(dataDir);
const secrets = new SecretStore(dataDir, safeStorage);
const glossaries = new GlossaryStore(dataDir);
const recordsDir = () => settings.get().recording.dir || join(app.getPath('documents'), 'MeetingInterpreter');
const meetings = new MeetingsStore(recordsDir);
/** The voice profile (accent calibration, learned corrections): a file in the records folder. */
const profileStore = new ProfileStore(recordsDir);
const personal = (base: LangBase) => personalFor(profileStore.get(), base);
const modelsDir = join(dataDir, 'models');
// In mainland China huggingface.co is usually unreachable: try the mirror first there.
const inChina = /^Asia\/(Shanghai|Chongqing|Harbin|Urumqi)$/.test(Intl.DateTimeFormat().resolvedOptions().timeZone ?? '');
const proxiedFetch: typeof fetch = (input, init) => net.fetch(input as string, init as RequestInit);
const models = new ModelManager(modelsDir, proxiedFetch, inChina ? { baseUrls: ['https://hf-mirror.com', 'https://huggingface.co'] } : {});
const ctx = createNodeContext(createLogger('provider'), proxiedFetch);
/** The local AI translation models (Hy-MT2), downloaded like the recognition models and checked by SHA-256. */
const aiModels = new ModelManager(modelsDir, proxiedFetch, { models: AI_MODELS, ...(inChina ? { baseUrls: ['https://hf-mirror.com', 'https://huggingface.co'] } : {}) });
let aiClient: { id: AiModelId; client: LocalAiClient } | null = null;
/** The model to translate with: the chosen one, else the other one if only that is downloaded. */
function aiModelInUse(): AiModelId | null {
  const chosen = settings.get().local.aiModel;
  if (aiModels.status(chosen) === 'ready') return chosen;
  const other: AiModelId = chosen === 'hy-mt2-7b' ? 'hy-mt2-1.8b' : 'hy-mt2-7b';
  return aiModels.status(other) === 'ready' ? other : null;
}
/** The model's worker, started on first use; null while no model is downloaded. */
/**
 * A worker in its own process (recognition, AI translation). Its console output and how it ended
 * go to app.log, so a worker that cannot load its native libraries says why.
 */
function forkWorker(file: string, name: string): Electron.UtilityProcess {
  const child = utilityProcess.fork(join(__dirname, file), [], {
    serviceName: name,
    stdio: 'pipe',
    // Native libraries (sherpa-onnx, llama.cpp) are not signed with our (ad-hoc) identity on macOS.
    ...(process.platform === 'darwin' ? { allowLoadingUnsignedLibraries: true } : {}),
  });
  const wlog = log.child(name);
  const lines = (level: 'info' | 'warn') => (d: Buffer) => {
    for (const line of d.toString('utf8').split('\n')) if (line.trim()) wlog[level](line.trimEnd());
  };
  child.stdout?.on('data', lines('info'));
  child.stderr?.on('data', lines('warn'));
  child.on('exit', (code) => (code ? wlog.warn(`process exited with code ${code}`) : wlog.info('process exited')));
  // Slightly below normal: when the computer is busy, the meeting app (video, audio) goes first and
  // we right after it — never the other way round.
  child.once('spawn', () => lowerPriority(child.pid, wlog));
  return child;
}

function lowerPriority(pid: number | undefined, l: Logger): void {
  if (!pid) return;
  try {
    setPriority(pid, osConstants.priority.PRIORITY_BELOW_NORMAL);
  } catch (err) {
    l.debug('could not lower the priority', err instanceof Error ? err.message : String(err));
  }
}

const localAi = (): LocalAiClient | null => {
  const id = aiModelInUse();
  if (!id) return null;
  if (aiClient?.id !== id) {
    aiClient?.client.dispose();
    aiClient = {
      id,
      client: new LocalAiClient({
        modelPath: aiModels.pathOf(id, aiModelFile(id)),
        // All math cores (measured on 4 cores: 0.7 s a sentence instead of 1.3 s with 2 threads;
        // recognition and translation mostly take turns, so sharing costs little).
        threads: 0,
        // Its own process on macOS / Windows; in the main process on Linux, where node-llama-cpp
        // checks its binaries with a helper process that only the main process may start.
        spawn: () =>
          process.platform === 'linux'
            ? createInProcessAiWorker()
            : forkWorker('local-ai-worker.js', 'local-ai'),
        onLoaded: (gpu) => log.info(`local AI translation loaded: ${id} (gpu: ${gpu})`),
        onLoadFailed: (message) => log.warn(`local AI translation failed to load: ${message}`),
        keepLoaded: () => sessionManager.active || room.active,
      }),
    };
  }
  return aiClient.client;
};

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
  if (msg.type === 'start' || msg.type === 'config' || msg.type === 'stop') {
    // getDisplayMedia (system-audio loopback) needs a user gesture; executeJavaScript can grant
    // one. Start, reconfigure (may restart capture) and stop share one ordered queue there.
    void audioWindow.webContents
      .executeJavaScript(`window.__miAudio && window.__miAudio.handle(${JSON.stringify(msg)})`, true)
      .catch((err) => {
        const m = err instanceof Error ? err.message : String(err);
        // While quitting (or when the audio window goes away) the last command can't finish: expected.
        if (quitting || !audioWindow || audioWindow.isDestroyed() || /disposed|destroyed/i.test(m)) log.debug('audio command dropped', m);
        else log.error('audio command failed', m);
      });
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
    // Whisper: 4 threads where there is room (6 s of Spanish: ~1.7 s instead of ~2.2 s).
    numThreads: availableParallelism() >= 6 ? 4 : 2,
    spawn: () => forkWorker('local-asr-worker.js', 'local-asr'),
  });
};

/** The Chrome extension's free tier: offline recognition and system voices on 127.0.0.1. */
const desktopBridge = new DesktopBridge({
  version: app.getVersion(),
  log: log.child('bridge'),
  enabled: () => settings.get().bridge.enabled,
  asr: () => localAsr('in'),
  tts: systemTts,
  modelsReady: (base) => modelsForLang(base, settings.get().local.esModel).every((id) => models.status(id) === 'ready'),
  ensureModels: (base, onStatus) =>
    models.ensureFor(base, settings.get().local.esModel, (p) => {
      onStatus(`正在下载本机识别模型 ${p.file} ${p.total ? Math.round((p.received / p.total) * 100) : 0}%`);
      broadcast('model-progress', p);
    }),
  onClients: (n) => log.info(`extension recognition sessions: ${n}`),
  localAi: () => localAi(),
});

/** Offline translation (Mozilla models), run in the hidden audio window. */
const offlineMt = new AudioWindowMt(
  (msg) => {
    if (!audioWindow || audioWindow.isDestroyed()) return false;
    audioWindow.webContents.send(IPC.toAudio, msg);
    return true;
  },
  (p) => broadcast('model-progress', { id: 'offline-mt', ...p }),
);

function providers(): Providers {
  return createProviders(settings.get(), secrets.all(), ctx, () => glossaries.active(), { systemTts, localAsr, offlineMt, localAi });
}

const sessionManager = new SessionManager({
  settings: () => settings.get(),
  glossary: () => glossaries.active(),
  personal,
  providers,
  draftTranslator: async () => ((await offlineMt.missingBytes().catch(() => 1)) === 0 ? new OfflineTranslator(offlineMt) : null),
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
  personal,
  toAudio,
  broadcast,
  log: createLogger('room'),
  dataDir,
  staticDir: () => join(__dirname, '../renderer'),
  devUrl: () => devRendererUrl(),
  fetch: proxiedFetch,
});

// ------------------------------------------------------------------ IPC

/** shell.openPath reports failure as a returned message; turn it into an error the UI shows. */
async function openPathOrThrow(path: string): Promise<void> {
  const err = await shell.openPath(path);
  if (err) throw new Error(`打不开：${err}`);
}

/**
 * 录屏 needs a screen to record and, on macOS, the Screen Recording permission. Without a chosen
 * (or a still existing) screen or window, the whole first screen is recorded.
 */
async function prepareScreenRecording(): Promise<void> {
  const rec = settings.get().recording;
  if (!rec.screen) return;
  if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
    throw new Error('录屏需要“屏幕录制”权限：请在 系统设置 › 隐私与安全性 › 屏幕录制 里允许本软件，然后重新打开软件。不想录屏可以先关掉“录屏”。');
  }
  const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
  if (rec.screenSourceId && sources.some((x) => x.id === rec.screenSourceId)) return;
  const screen = sources.find((x) => x.id.startsWith('screen'));
  if (!screen) throw new Error('没有找到可以录制的屏幕。不想录屏可以先关掉“录屏”。');
  if (rec.screenSourceId) broadcast('toast', { level: 'info', message: '之前选的录制窗口已经不在了，这场录整个屏幕。' });
  settings.set({ recording: { screenSourceId: screen.id } });
}

type Handler = (...args: never[]) => unknown;

const handlers: Record<string, Handler> = {
  'settings.get': () => settings.get(),
  'settings.set': (patch: unknown) => {
    // The records folder is only changed through the folder dialog (app.chooseRecordsDir).
    const p = patch && typeof patch === 'object' ? { ...(patch as Record<string, unknown>) } : {};
    if (p.recording && typeof p.recording === 'object') {
      const { dir: _ignored, ...rest } = p.recording as Record<string, unknown>;
      p.recording = rest;
    }
    const s = settings.set(p);
    sessionManager.refreshAudio();
    return s;
  },
  'settings.applyPreset': (id: PresetId) => {
    const s = settings.applyPreset(id);
    if (usesLocalAsr()) void prefetchModels();
    if (usesOfflineMt()) void prefetchOfflineMt();
    if (usesLocalAi()) void prefetchAi();
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
    await prepareScreenRecording();
    // The meeting app is noted in the record without asking (the first one found running).
    if (!opts?.platform) opts = { ...opts, platform: (await detectMeetingApps().catch(() => []))[0] };
    await requireLocalModels(opts?.mode ?? 'meeting');
    await requireLocalAi();
    await requireOfflineMt();
    await requireLocalAiLoaded();
    const state = await sessionManager.start(opts ?? {});
    warmUpTranslation();
    updateTray();
    syncShortcuts();
    if (settings.get().ui.overlay.enabled && opts?.mode !== 'room') showOverlay();
    return state;
  },
  'meeting.stop': async () => {
    // A room owns its session: closing it also tells the phones and stops their pipelines.
    if (room.active) {
      const meta = sessionManager.currentMeta;
      await room.stop();
      updateTray();
      return meta;
    }
    const meta = await sessionManager.stop();
    updateTray();
    return meta;
  },
  'meeting.state': () => sessionManager.state,
  'meeting.segments': () => (sessionManager.active ? sessionManager.segments().slice(-200) : []),
  'meeting.readiness': () => readiness(),
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
  /** Recording on/off: the default for meetings, and (mid-meeting) for the one running now. */
  'meeting.setRecording': async (opts: { audio?: boolean; screen?: boolean; screenSourceId?: string }) => {
    settings.set({ recording: opts });
    if (!sessionManager.active || sessionManager.state.mode !== 'meeting') return;
    if (opts.screen) await prepareScreenRecording();
    const r = settings.get().recording;
    sessionManager.setRecording({ audio: r.audio, screen: r.screen, screenSourceId: r.screenSourceId });
  },

  'meetings.list': () => meetings.list(),
  'meetings.get': (id: string) => meetings.get(id),
  'meetings.summarize': async (id: string, template: SummaryTemplate) => {
    const detail = meetings.get(id);
    if (!detail) throw new Error('会议不存在');
    const llm = makeLlm(settings.get(), secrets.all(), ctx, true);
    if (!llm) throw new Error('生成纪要需要大模型 Key：在 设置 › 翻译服务 里填写（智谱 GLM 有免费的）');
    return sessionManager.writeSummary(detail.folder, detail.meta, detail.segments, llm, template);
  },
  'meetings.rename': (id: string, title: string) => meetings.rename(id, title),
  'meetings.remove': async (id: string) => {
    await shell.trashItem(meetings.folder(id));
  },
  'meetings.openFolder': (id: string) => openPathOrThrow(meetings.folder(id)),
  'meetings.openFile': (id: string, rel: string) => {
    const path = meetings.filePath(id, rel);
    // Only open record files with their app; anything else is just shown in its folder.
    if (/\.(md|srt|txt|json|wav|webm|m4a|mp4|mp3|ogg)$/i.test(path)) return openPathOrThrow(path);
    shell.showItemInFolder(path);
  },
  'meetings.fileUrl': (id: string, rel: string) => `mi-media://file/${encodeURIComponent(id)}/${rel.split('/').map(encodeURIComponent).join('/')}`,

  'meetings.editSegment': (id: string, segId: string, srcText: string) => editSegment(id, segId, srcText),
  'meetings.review': async (id: string) => reviewMeeting(id),
  'meetings.undo': async (id: string, segId: string, heard: string) => {
    const detail = meetings.get(id);
    const review = detail?.review;
    const item = review?.suggestions.find((s) => s.segId === segId && s.heard === heard);
    if (!detail || !review || !item || item.decision !== 'accepted') return detail;
    const seg = detail.segments.find((s) => s.id === segId);
    if (seg) {
      profileStore.update((p) => removeCorrection(p, baseOf(seg.srcLang), item.heard));
      if (item.before !== undefined && seg.srcText === item.after) {
        await editSegment(id, segId, item.before, { learn: false });
      } else {
        // Edited since (or saved by an older version): put back the fixed place only.
        const i = seg.srcText.indexOf(item.meant);
        if (i >= 0) await editSegment(id, segId, seg.srcText.slice(0, i) + item.heard + seg.srcText.slice(i + item.meant.length), { learn: false });
      }
    }
    item.decision = 'undone';
    meetings.saveReview(id, review);
    return meetings.get(id);
  },
  'meetings.forgetTerm': (id: string, zh: string) => {
    glossaries.removeAutoTerm(String(zh));
    const detail = meetings.get(id);
    if (detail?.review?.terms) {
      detail.review.terms = detail.review.terms.filter((t) => t.zh !== zh);
      meetings.saveReview(id, detail.review);
    }
    return meetings.get(id);
  },
  'meetings.decide': async (id: string, segId: string, heard: string, accept: boolean) => {
    const detail = meetings.get(id);
    const review = detail?.review;
    const item = review?.suggestions.find((s) => s.segId === segId && s.heard === heard);
    if (!detail || !review || !item) return detail;
    item.decision = accept ? 'accepted' : 'ignored';
    meetings.saveReview(id, review);
    const seg = detail.segments.find((s) => s.id === segId);
    if (accept && seg) {
      const base = baseOf(seg.srcLang);
      profileStore.update((p) => addCorrections(p, [{ heard: item.heard, meant: item.meant }], base, 'review'));
      if (seg.srcText.includes(item.heard)) await editSegment(id, segId, seg.srcText.split(item.heard).join(item.meant));
    }
    return meetings.get(id);
  },

  'profile.get': () => profileView(),
  'profile.script': () => calibrationScript(glossaries.active().map((e) => e.zh)),
  'profile.calibrate': async (audio: Int16Array[]) => {
    if (!Array.isArray(audio) || !audio.length || audio.length > 12) throw new Error('录音无效');
    const pcm = audio.map((a) => (a instanceof Int16Array ? a : new Int16Array(a as ArrayLike<number>)));
    const total = pcm.reduce((n, a) => n + a.length, 0);
    if (total < 16000 * 3 || total > 16000 * 600) throw new Error('录音太短或太长，请重新校准');
    const s = settings.get();
    const terms = glossaries.active().map((e) => e.zh).filter(Boolean);
    const sentences = calibrationScript(terms);
    if (sentences.length !== pcm.length) throw new Error('术语表在校准时变了，请重新校准');
    const status = secrets.status();
    const zhLocalReady = modelsForLang('zh', s.local.esModel).every((m) => models.status(m) === 'ready');
    const ids = [
      ...(zhLocalReady ? ['local'] : []),
      ...(status.dashscope ? ['dashscope'] : []),
      ...(status.azure ? ['azure'] : []),
      ...(s.out.asr === 'demo' ? ['demo'] : []),
    ];
    const names: Record<string, string> = { local: '本机离线识别（免费）', dashscope: '阿里云百炼', azure: 'Azure', demo: '演示' };
    const hotwords = [...new Set([...hotwordsFor('zh', glossaries.active()), ...profileHotwords(profileStore.get(), 'zh')])];
    const candidates = ids.map((id) => ({
      id,
      name: names[id] ?? id,
      hotwords,
      asr: createProviders(parseSettings({ ...s, out: { ...s.out, asr: id } }), secrets.all(), ctx, () => glossaries.active(), { systemTts, localAsr, offlineMt }).asr('out'),
    }));
    const run = await runCalibration({ sentences, audio: pcm, lang: 'zh-CN', terms, current: s.out.asr }, candidates, {
      onProgress: (done, all) => broadcast('calibration-progress', { done, total: all }),
    });
    profileStore.update((p) =>
      addCalibration(recordConfusions(addCorrections(p, run.corrections, 'zh', 'calibration'), run.confusions), {
        at: Date.now(),
        lang: 'zh',
        results: run.results.map(({ asr, accuracy, ms, error }) => ({ asr, accuracy, ms, ...(error ? { error } : {}) })),
      }),
    );
    return {
      results: run.results.map(({ asr, name, accuracy, ms, error }) => ({ asr, name, accuracy, ms, ...(error ? { error } : {}) })),
      best: run.best,
      current: s.out.asr,
      learnedTerms: run.corrections,
      pairs: [...new Set(run.confusions)].filter((c) => run.confusions.filter((x) => x === c).length >= 2),
      profile: profileView(),
    };
  },
  'profile.addCorrection': (lang: LangBase, heard: string, meant: string) => {
    if (!['zh', 'es', 'en'].includes(lang)) throw new Error('语言无效');
    profileStore.update((p) => addCorrections(p, [{ heard: String(heard), meant: String(meant) }], lang, 'manual'));
    return profileView();
  },
  'profile.removeCorrection': (lang: LangBase, heard: string) => {
    profileStore.update((p) => removeCorrection(p, lang, String(heard)));
    return profileView();
  },
  'profile.exportFile': async () => {
    const res = await dialog.showSaveDialog(mainWindow!, { title: '导出口音档案', defaultPath: 'voice-profile.json', filters: [{ name: '口音档案', extensions: ['json'] }] });
    if (res.canceled || !res.filePath) return false;
    writeFileSync(res.filePath, JSON.stringify(profileStore.get(), null, 2), { encoding: 'utf8', mode: 0o600 });
    return true;
  },
  'profile.importFile': async () => {
    const res = await dialog.showOpenDialog(mainWindow!, { title: '导入口音档案', filters: [{ name: '口音档案', extensions: ['json'] }], properties: ['openFile'] });
    if (res.canceled || !res.filePaths[0]) return null;
    const raw = readFileSync(res.filePaths[0], 'utf8').replace(/^\uFEFF/, '');
    if (raw.length > 5_000_000) throw new Error('文件太大，不是口音档案');
    const other = ProfileSchema.safeParse((() => { try { return JSON.parse(raw); } catch { return null; } })());
    if (!other.success) throw new Error('这个文件不是会议同传的口音档案');
    profileStore.update((p) => mergeProfiles(p, other.data));
    return profileView();
  },
  'profile.reset': () => {
    profileStore.reset();
    return profileView();
  },
  'profile.openFolder': () => {
    const f = profileStore.file();
    if (existsSync(f)) shell.showItemInFolder(f);
    else {
      mkdirSync(recordsDir(), { recursive: true });
      void shell.openPath(recordsDir());
    }
  },

  'voice.create': async (wav: Uint8Array) => {
    const s = settings.get();
    const key = secrets.all().dashscope;
    if (!key) throw new Error('先在“翻译服务”里填写阿里云百炼 Key');
    const cfg = { apiKey: key, region: s.dashscope.region, host: s.dashscope.host || undefined };
    const id = await createClonedVoice(ctx, cfg, new Uint8Array(wav), s.languages.self);
    await waitForVoice(ctx, cfg, id);
    const old = s.dashscope.myVoiceId;
    settings.set({ dashscope: { myVoiceId: id, useMyVoice: true } });
    if (old && old !== id) void deleteClonedVoice(ctx, cfg, old).catch(() => undefined);
    return id;
  },
  'voice.remove': async () => {
    const s = settings.get();
    const key = secrets.all().dashscope;
    const old = s.dashscope.myVoiceId;
    settings.set({ dashscope: { myVoiceId: '', useMyVoice: false } });
    if (old && key) await deleteClonedVoice(ctx, { apiKey: key, region: s.dashscope.region, host: s.dashscope.host || undefined }, old).catch(() => undefined);
  },
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
      // Voice lists are static for the cloud providers: show them even before a key is saved.
      if (provider === 'azure') return azureVoicesFor(langCode);
      if (provider === 'dashscope') return new DashscopeTts({ apiKey: 'list-only', region: s.dashscope.region }, ctx).voices(langCode);
      const p = createProviders({ ...s, out: { ...s.out, tts: provider as AppSettings['out']['tts'] } }, secrets.all(), ctx, () => [], { systemTts, localAsr });
      return p.tts('out')?.voices(langCode) ?? [];
    } catch {
      return [];
    }
  },

  'local.status': () => models.statusList(settings.get().local.esModel),
  'local.download': async (base: 'zh' | 'es' | 'en') => {
    await models.ensureFor(base, settings.get().local.esModel, (p) => broadcast('model-progress', p));
  },

  'mt.status': async () => ({ missingBytes: await offlineMt.missingBytes(), totalBytes: OFFLINE_MT_TOTAL }),
  // 存储空间: see, delete, download (and cancel) every model; open the folders.
  'storage.info': () => storageInfo(),
  'storage.remove': (id: string) => removeStored(id),
  'storage.download': (id: string) => downloadStored(id),
  'storage.cancel': (id: string) => {
    asrDownloads.get(id)?.abort();
    if (localAsrNeeded('meeting').includes(id as ModelId)) prefetchAbort?.abort();
    if (aiPrefetch?.id === id) aiPrefetch.abort.abort();
  },
  'storage.openFolder': (which: 'data' | 'records') => openPathOrThrow(which === 'records' ? recordsDir() : dataDir),
  'update.state': () => (latestUpdate ? { version: latestUpdate.version, notes: latestUpdate.notes } : null),
  'update.install': () => installUpdate(),
  'update.whatsNew': () => {
    const f = join(dataDir, 'whats-new.json');
    if (!existsSync(f)) return null;
    try {
      const w = JSON.parse(readFileSync(f, 'utf8')) as { version?: string; notes?: string };
      // Shown once, by the version it describes.
      rmSync(f, { force: true });
      return w.version === app.getVersion() ? { version: w.version, notes: w.notes ?? '' } : null;
    } catch {
      return null;
    }
  },
  'app.quit': () => {
    quitting = true;
    app.quit();
  },
  'uninstall.plan': () => uninstallPlan(),
  'uninstall.run': (opts: { records: boolean; driver: boolean; dryRun?: boolean }) => runUninstall(opts),
  'ai.status': async () => {
    const ids = Object.keys(AI_MODELS) as AiModelId[];
    for (const id of ids) if (aiModels.status(id) !== 'ready' && aiModels.missingBytes([id]) === 0) await aiModels.verifyExisting([id]);
    return {
      chosen: settings.get().local.aiModel,
      models: ids.map((id) => ({ id, ready: aiModels.status(id) === 'ready', sizeMb: Math.round(AI_MODELS[id].files[0]!.size / 1_000_000), downloading: aiPrefetch?.id === id })),
    };
  },
  'ai.download': (id?: AiModelId) => {
    const want = id && id in AI_MODELS ? id : settings.get().local.aiModel;
    // The 7B model takes about 6 GB while it runs: on a smaller computer everything would swap.
    if (want === 'hy-mt2-7b' && totalmem() < 15 * 1024 ** 3) throw new Error(`这台电脑内存 ${Math.round(totalmem() / 1024 ** 3)} GB，“更准”的模型需要 16 GB 以上，会拖慢整台电脑（包括会议软件）。“标准”模型已经足够准。`);
    return prefetchAi(want);
  },
  'mt.download': () => offlineMt.download(),
  'audio.installDriver': () => {
    // Installing makes the system's sound drop for a moment (and may switch devices): never mid-meeting.
    if (sessionManager.active || room.active) throw new Error('会议进行中不能安装虚拟声卡，请先结束会议');
    return installVirtualAudio(proxiedFetch, log.child('driver'), app.getPath('userData'), (text) => broadcast('driver-progress', { text }));
  },
  'audio.canRestoreSystemDefaults': () => process.platform === 'win32' && !!savedAudioDefaults(app.getPath('userData')),
  'audio.restoreSystemDefaults': async () => {
    const back = await restoreAudioDefaults(app.getPath('userData'));
    return back.length ? `已改回：${back.join('、')}` : '默认设备已经是原来的了';
  },
  'audio.testTone': (target: 'virtualMic' | 'headphones') => {
    toAudio({ type: 'testTone', target, config: audioConfig(settings.get(), 'meeting') });
  },

  'room.start': async () => {
    await requireLocalModels('room');
    await requireLocalAi();
    await requireOfflineMt();
    await requireLocalAiLoaded();
    const st = await room.start();
    syncShortcuts();
    return st;
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
    memoryGb: Math.round(totalmem() / 1024 ** 3),
  }),
  'app.openExternal': (url: string) => {
    // Web links, and the OS privacy/sound/firewall settings pages we point people to.
    if (/^https?:\/\//.test(url) || /^x-apple\.systempreferences:/.test(url) || /^ms-settings:/.test(url) || url === 'windowsdefender://network/') return shell.openExternal(url);
    throw new Error('不能打开这个链接');
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
  'app.openRecordsDir': async () => {
    mkdirSync(recordsDir(), { recursive: true });
    await openPathOrThrow(recordsDir());
  },
  'app.showWindow': (name: 'main' | 'overlay') => (name === 'main' ? showMain() : showOverlay(true)),
  'app.setOverlayClickThrough': (on: boolean) => {
    settings.set({ ui: { overlay: { clickThrough: on } } });
    overlayWindow?.setIgnoreMouseEvents(on, { forward: true });
  },
  /** The pointer is over the subtitle window's buttons: they always take clicks, even in click-through mode. */
  'app.overlayPointer': (overButtons: boolean) => {
    if (!settings.get().ui.overlay.clickThrough || !overlayWindow || overlayWindow.isDestroyed()) return;
    overlayWindow.setIgnoreMouseEvents(!overButtons, { forward: true });
  },
  'app.hideOverlay': () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide();
  },
};

/** After a meeting, quietly look for mis-heard words when the user has an LLM key (never in the demo). */
function autoReview(id: string): void {
  const s = settings.get();
  if (!s.interpretation.autoReview || s.preset === 'demo' || !makeLlm(s, secrets.all(), ctx, false)) return;
  const mine = meetings.get(id)?.segments.filter((x) => x.dir === 'out' && x.srcText).length ?? 0;
  if (mine < 3) return;
  void reviewMeeting(id)
    .then((r) => {
      const n = r.suggestions.filter((s) => s.decision === 'accepted').length;
      const t = r.terms?.length ?? 0;
      if (n || t) broadcast('review-ready', { id, count: n, terms: t });
    })
    .catch((err) => log.warn('after-meeting review failed', err instanceof Error ? err.message : String(err)));
}

/** Corrects one recognised sentence: re-translate, rewrite the transcript files, learn from the fix. */
async function editSegment(id: string, segId: string, srcText: string, opts: { learn?: boolean } = {}): Promise<{ segment: TranscriptSegment; learned: { heard: string; meant: string }[] }> {
  const detail = meetings.get(id);
  const seg = detail?.segments.find((s) => s.id === segId);
  if (!detail || !seg) throw new Error('找不到这句话');
  const text = String(srcText ?? '').trim().slice(0, 2000);
  if (!text || text === seg.srcText) return { segment: seg, learned: [] };
  const base = baseOf(seg.srcLang);
  const learned = opts.learn === false ? [] : learnFromEdit(seg.srcText, text, base);
  let dstText = seg.dstText;
  try {
    const entries = glossaries.active();
    const dir: Direction = seg.dir === 'in' ? 'in' : 'out';
    dstText = await providers().mt(dir).translate({ text, from: seg.srcLang, to: seg.dstLang, hits: findHits(text, base, entries, baseOf(seg.dstLang)), context: [] });
  } catch (err) {
    log.warn('re-translation after a correction failed', err instanceof Error ? err.message : String(err));
  }
  const segment: TranscriptSegment = { ...seg, srcText: text, dstText, status: dstText ? 'done' : seg.status, draft: undefined };
  meetings.updateSegment(id, segment);
  const segs = detail.segments.map((s) => (s.id === segId ? segment : s));
  try {
    writeTranscriptFiles(detail.folder, detail.meta, segs);
    meetings.patchMeta(id, (m) => ({ ...m, files: { ...m.files, ...detail.meta.files } }));
  } catch (err) {
    log.warn('could not rewrite transcript files', err instanceof Error ? err.message : String(err));
  }
  if (learned.length) profileStore.update((p) => addCorrections(p, learned, base, 'edit'));
  return { segment, learned };
}

/** Loads the translation models (and, on Windows, the speech process) as a meeting starts, so the first sentence is not slow. */
function warmUpTranslation(): void {
  const s = settings.get();
  const mts = [s.out.mt, s.in.mt];
  if (mts.includes('offline') || mts.includes('local-ai')) void offlineMt.translate('你好', 'zh', 'es').catch(() => undefined);
  if (mts.includes('local-ai')) localAi()?.warmUp();
  if (s.out.tts === 'system' || s.in.tts === 'system') systemTts().warmUp();
}

function profileView(): ProfileView {
  const p = profileStore.get();
  return { file: profileStore.file(), corrections: p.corrections, pairs: userPairs(p), calibrations: p.calibrations };
}

/**
 * After a meeting (needs the user's LLM key): words the recogniser mis-heard in my sentences are
 * corrected and learned, and the meeting's names / products / industry terms go to the automatic
 * glossary — all by itself; each can be undone.
 */
async function reviewMeeting(id: string): Promise<StoredReview> {
  const detail = meetings.get(id);
  if (!detail) throw new Error('会议不存在');
  const llm = makeLlm(settings.get(), secrets.all(), ctx, false);
  if (!llm) throw new Error('需要先在 设置 › 翻译服务 里填写大模型 Key（例如免费的智谱），才能自动学习');
  const foreign: 'es' | 'en' = baseOf(detail.meta.remoteLang) === 'en' ? 'en' : 'es';
  const known = glossaries.active().flatMap((e) => [e.zh, foreign === 'en' ? (e.en ?? '') : e.es]).filter(Boolean);
  const r = await reviewMeetingCore(llm, detail.segments, { terms: known, foreign });
  const review: StoredReview = { at: Date.now(), suggestions: r.suggestions, terms: [] };
  for (const sg of review.suggestions) {
    const seg = meetings.get(id)?.segments.find((s) => s.id === sg.segId);
    if (!seg || !seg.srcText.includes(sg.heard)) continue;
    profileStore.update((p) => addCorrections(p, [{ heard: sg.heard, meant: sg.meant }], baseOf(seg.srcLang), 'review'));
    // Only the place the review pointed at (the first occurrence), and remembered for an exact undo.
    sg.before = seg.srcText;
    sg.after = seg.srcText.replace(sg.heard, sg.meant);
    await editSegment(id, sg.segId, sg.after, { learn: false }).catch((err) => log.warn('auto correction failed', err instanceof Error ? err.message : String(err)));
    sg.decision = 'accepted';
    sg.auto = true;
  }
  review.terms = glossaries.addAutoTerms(r.terms, foreign);
  meetings.saveReview(id, review);
  return review;
}

/** The Mozilla models are needed for 'offline', and as the instant draft / fallback of 'local-ai'. */
const STORAGE_NAMES: Record<string, string> = {
  'silero-vad': '语音检测（识别都要用）',
  sensevoice: '中文识别（SenseVoice）',
  'whisper-small': '西语 / 英语识别（标准）',
  'whisper-base': '西语 / 英语识别（轻量）',
  'hy-mt2-1.8b': '本机 AI 翻译（标准）',
  'hy-mt2-7b': '本机 AI 翻译（更准）',
};
/** Recognition models downloaded from the 存储空间 page (each can be cancelled). */
const asrDownloads = new Map<string, AbortController>();

function storageInfo(): StorageInfo {
  const s = settings.get();
  const inUse = new Set<string>(localAsrNeeded('meeting'));
  if (usesLocalAi()) inUse.add(s.local.aiModel);
  const bigMac = process.platform === 'darwin' && process.arch === 'arm64' && totalmem() >= 15 * 1024 ** 3;
  return collectStorage({
    dataDir,
    recordsDir: recordsDir(),
    asr: models,
    ai: aiModels,
    inUse,
    names: STORAGE_NAMES,
    onlyIfPresent: bigMac ? new Set() : new Set(['hy-mt2-7b']),
    offlineMt: { totalBytes: OFFLINE_MT_TOTAL, inUse: usesOfflineMt(), downloading: !!mtPrefetch || asrDownloads.has('offline-mt') },
  });
}

async function removeStored(id: string): Promise<void> {
  const busy = sessionManager.active || room.active;
  const inUse = () => new Error('会议进行中，正在用的模型不能删除；会后再删');
  if (models.ids().includes(id)) {
    if (busy && localAsrNeeded('meeting').includes(id as ModelId)) throw inUse();
    await models.remove(id);
  } else if (aiModels.ids().includes(id)) {
    if (busy && aiModelInUse() === id) throw inUse();
    // The translation process keeps the model file open (Windows would refuse to delete it).
    if (aiClient?.id === id) {
      aiClient.client.dispose();
      aiClient = null;
    }
    await aiModels.remove(id);
  } else if (id === 'offline-mt') {
    if (busy && usesOfflineMt()) throw inUse();
    await offlineMt.clear();
  } else if (id === 'cache') {
    await session.defaultSession.clearCache();
    await session.defaultSession.clearCodeCaches({}).catch(() => undefined);
  } else if (id === 'tools') {
    if (room.active) throw new Error('现场房间开着时不能删除公网链接工具');
    await rm(join(dataDir, 'bin'), { recursive: true, force: true });
  } else throw new Error('这一项不能在这里删除');
  log.info(`storage: removed ${id}`);
}

async function downloadStored(id: string): Promise<void> {
  if (models.ids().includes(id)) {
    if (asrDownloads.has(id)) return;
    const abort = new AbortController();
    asrDownloads.set(id, abort);
    try {
      await models.ensure([id], (p) => broadcast('model-progress', p), abort.signal);
    } catch (err) {
      if (!isAbortError(err)) throw err;
    } finally {
      asrDownloads.delete(id);
    }
  } else if (aiModels.ids().includes(id)) await (handlers['ai.download'] as (id: AiModelId) => Promise<void>)(id as AiModelId);
  else if (id === 'offline-mt') await prefetchOfflineMt();
  else throw new Error('这一项不需要下载');
}

/**
 * Mac: opened from Downloads or straight from the disk image, the app offers to move itself to
 * Applications (replacing an older copy there) — one copy on the computer, and permissions that
 * stay put. "不再提示" is remembered.
 */
function offerMoveToApplications(): void {
  if (process.platform !== 'darwin' || !app.isPackaged || process.env['MI_USER_DATA'] || app.isInApplicationsFolder()) return;
  if (settings.get().ui.dismissed.includes('move-to-applications') || !mainWindow) return;
  void dialog
    .showMessageBox(mainWindow, {
      type: 'question',
      message: '把会议同传助手移到“应用程序”文件夹？',
      detail: '直接从“下载”或安装盘里打开时，电脑上容易留下好几个版本，麦克风、录屏权限也容易失效。移过去后会自动重新打开，设置和记录都在。',
      buttons: ['移过去', '以后再说', '不再提示'],
      defaultId: 0,
      cancelId: 1,
    })
    .then(({ response }) => {
      if (response === 2) settings.set({ ui: { dismissed: [...settings.get().ui.dismissed, 'move-to-applications'] } });
      if (response !== 0) return;
      try {
        // An older copy in Applications is replaced; the app relaunches from there.
        app.moveToApplicationsFolder({ conflictHandler: () => true });
      } catch (err) {
        broadcast('toast', { level: 'warn', message: `没能移到“应用程序”：${err instanceof Error ? err.message : String(err)}。可以手动把它拖进“应用程序”文件夹。` });
      }
    });
}

let latestUpdate: UpdateInfo | null = null;

/**
 * One click: this computer's installer from the latest release, checked against its SHA256SUMS,
 * then opened (Mac: the disk image to drag into Applications; Windows: the installer, and the app
 * quits so its files can be replaced). Everything the user has stays where it is.
 */
async function installUpdate(): Promise<'mac-drag' | 'installing' | 'opened'> {
  const u = latestUpdate;
  if (!u) throw new Error('没有找到新版本');
  if (sessionManager.active || room.active) throw new Error('会议进行中不能更新，请先结束会议');
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    await shell.openExternal(u.url);
    return 'opened';
  }
  const file = await downloadUpdate({ info: u, platform: process.platform, arch: process.arch, dir: join(app.getPath('temp'), `mi-update-${u.version}`), fetch: proxiedFetch, onProgress: (p) => broadcast('update-progress', p) });
  writeFileSync(join(dataDir, 'whats-new.json'), JSON.stringify({ version: u.version, notes: u.notes }));
  log.info(`update ${u.version} downloaded and checked: ${file}`);
  if (process.platform === 'darwin') {
    const err = await shell.openPath(file);
    if (err) throw new Error(`打不开安装盘：${err}`);
    return 'mac-drag';
  }
  spawn(file, [], { detached: true, stdio: 'ignore' }).unref();
  setTimeout(() => {
    quitting = true;
    app.quit();
  }, 1000);
  return 'installing';
}

/** The app on disk: the .app bundle (Mac) or the folder with its uninstaller (Windows); null when run from source. */
function installedApp(): { path: string; uninstaller: string | null } | null {
  if (!app.isPackaged) return null;
  if (process.platform === 'darwin') return { path: resolve(process.execPath, '..', '..', '..'), uninstaller: null };
  if (process.platform === 'win32') {
    const u = join(dirname(process.execPath), `Uninstall ${app.getName()}.exe`);
    return existsSync(u) ? { path: dirname(process.execPath), uninstaller: u } : null;
  }
  return null;
}

function uninstallPlan(): UninstallPlan {
  return planUninstall({ dataDir, recordsDir: recordsDir(), downloadsDir: app.getPath('downloads'), appPath: installedApp()?.path ?? null, platform: process.platform, driverName: installedVirtualAudio() });
}

async function runUninstall(opts: { records: boolean; driver: boolean; dryRun?: boolean }): Promise<UninstallResult> {
  if (sessionManager.active || room.active) throw new Error('请先结束会议或关闭现场房间，再卸载');
  const plan = uninstallPlan();
  const profile = profileStore.file();
  const files = writeBackup(plan.backupDir, {
    glossaries: glossaries.list(),
    profileJson: existsSync(profile) ? readFileSync(profile, 'utf8') : null,
    settingsJson: JSON.stringify(settings.get(), null, 2),
  });
  const target = installedApp();
  const removed = [dataDir, ...(opts.records ? [recordsDir()] : []), ...(target ? [target.path] : [])];
  const notes: string[] = [];
  log.info(`uninstall${opts.dryRun ? ' (dry run)' : ''}: backup in ${plan.backupDir}; removing ${removed.join(', ')}`);
  if (opts.dryRun) return { backupDir: plan.backupDir, files, removed, notes };
  if (!safeToDelete(dataDir, homedir())) throw new Error(`数据文件夹的位置不寻常，为安全起见没有删除，请手动删除：${dataDir}`);
  if (opts.records && existsSync(recordsDir())) await shell.trashItem(recordsDir());
  if (opts.driver) notes.push((await removeVirtualAudio()).message);
  // The key that encrypts the saved keys (Mac keychain); the keys themselves go with the data folder.
  if (process.platform === 'darwin') await new Promise((r) => execFile('security', ['delete-generic-password', '-s', `${app.getName()} Safe Storage`], () => r(null)));
  if (target && process.platform === 'darwin') await shell.trashItem(target.path).catch((err) => notes.push(`软件没能移到废纸篓，请手动删除：${err instanceof Error ? err.message : String(err)}`));
  // The data folder (and the Windows uninstaller) once this process has quit.
  // (Tests keep a trace of the clean-up beside the test data folder.)
  const command = afterExitCommand(process.platform, process.pid, dataDir, target?.uninstaller ?? null, process.env['MI_USER_DATA'] ? `${dataDir}-uninstall.log` : undefined);
  const cleanupPid = await startAfterExit(process.platform, command).catch((err: unknown) => {
    const why = err instanceof Error ? err.message : String(err);
    log.error(`uninstall: ${why}`);
    shell.showItemInFolder(dataDir);
    throw new Error(`${why}。备份已经在“下载”文件夹里。请退出本软件，再手动删除这个文件夹：${dataDir}`);
  });
  log.info(`uninstall: clean-up running (pid ${cleanupPid}); quitting`);
  setTimeout(() => {
    quitting = true;
    app.quit();
  }, 1500);
  return { backupDir: plan.backupDir, files, removed, notes };
}

function usesOfflineMt(): boolean {
  const s = settings.get();
  return [s.out.mt, s.in.mt].some((m) => m === 'offline' || m === 'local-ai');
}

function usesLocalAi(): boolean {
  const s = settings.get();
  return s.out.mt === 'local-ai' || s.in.mt === 'local-ai';
}

let aiPrefetch: { id: AiModelId; job: Promise<void>; abort: AbortController } | null = null;
/** How far the AI model's download is (for "still downloading, N%"). */
let aiProgress: { id: string; received: number; total: number } | null = null;
/** Downloads a local AI translation model in the background, once. */
function prefetchAi(id: AiModelId = settings.get().local.aiModel): Promise<void> {
  if (aiPrefetch?.id === id) return aiPrefetch.job;
  // Another model is downloading: this one follows it (never silently drop the request).
  if (aiPrefetch) return aiPrefetch.job.finally(() => prefetchAi(id));
  const abort = new AbortController();
  const job = aiModels
    .ensure(
      [id],
      (p) => {
        aiProgress = p;
        broadcast('model-progress', p);
      },
      abort.signal,
    )
    .then(() => broadcast('toast', { level: 'info', message: '本机 AI 翻译模型已下载完成。' }))
    .catch((err) => {
      if (!isAbortError(err)) broadcast('toast', { level: 'warn', message: `本机 AI 翻译模型下载失败：${err instanceof Error ? err.message : String(err)}` });
    })
    .finally(() => (aiPrefetch = null));
  aiPrefetch = { id, job, abort };
  return job;
}

let mtPrefetch: Promise<void> | null = null;
/** Downloads the offline translation models in the background, once. */
function prefetchOfflineMt(): Promise<void> {
  mtPrefetch ??= offlineMt
    .missingBytes()
    .then((missing) => (missing ? offlineMt.download().then(() => broadcast('toast', { level: 'info', message: '离线翻译模型已下载完成，以后不联网也能翻译。' })) : undefined))
    .catch((err) => broadcast('toast', { level: 'warn', message: `离线翻译模型下载失败：${err instanceof Error ? err.message : String(err)}（可在 设置 › 翻译服务 里重试）` }))
    .finally(() => (mtPrefetch = null));
  return mtPrefetch;
}

/** Before a meeting with offline translation, make sure its models are there. */
/**
 * Accuracy first: with the free plan the translation is the local AI model. Until it is downloaded
 * no meeting starts on the much weaker offline models (a first meeting that translates badly is
 * the last one); the message says how far the download is and what else can be done.
 */
async function requireLocalAi(): Promise<void> {
  if (!usesLocalAi() || aiModelInUse()) return;
  const id = settings.get().local.aiModel;
  // Downloaded by an earlier version: only needs its check.
  if (aiModels.missingBytes([id]) === 0) {
    await aiModels.verifyExisting([id]);
    if (aiModelInUse()) return;
  }
  void prefetchAi(id);
  const total = AI_MODELS[id].files.reduce((n, f) => n + f.size, 0);
  const done = aiProgress?.id === id ? aiProgress.received : total - aiModels.missingBytes([id]);
  const pct = Math.max(0, Math.min(99, Math.floor((done / total) * 100)));
  throw new Error(`本机 AI 翻译模型还在下载（${pct}%，还差约 ${Math.max(1, Math.round((total - done) / 1_000_000))} MB）。为了翻得准，下载完再开始。等不及的话，可以在 设置 › 翻译服务 换成云端方案。`);
}

/**
 * Accuracy first: the meeting starts once the AI model is loaded, so its first sentences are
 * translated by the model too (the meeting page loads it ahead; the first load on a Mac prepares
 * the GPU code and can take half a minute, later ones seconds).
 */
async function requireLocalAiLoaded(): Promise<void> {
  const ai = usesLocalAi() ? localAi() : null;
  if (!ai || ai.loadedNow) return;
  await ai.ready().catch((err: unknown) => {
    throw new Error(`本机 AI 翻译模型没能加载：${err instanceof Error ? err.message : String(err)}。可以重启软件再试；急用的话，在 设置 › 翻译服务 换成云端方案。`);
  });
}

async function requireOfflineMt(): Promise<void> {
  // Needed to start only when it is the translator: 'offline', or 'local-ai' before its model is there
  // (with the AI model ready, the Mozilla models are just the instant draft).
  const s = settings.get();
  const aiReady = !!aiModelInUse();
  if (![s.out.mt, s.in.mt].some((m) => m === 'offline' || (m === 'local-ai' && !aiReady))) {
    if (usesOfflineMt()) void prefetchOfflineMt();
    return;
  }
  const missing = await offlineMt.missingBytes().catch(() => 0);
  if (!missing) return;
  void prefetchOfflineMt();
  throw new Error(`正在下载离线翻译模型（约 ${Math.round(missing / 1_000_000)} MB），下载完成后即可开始。可在 设置 › 翻译服务 查看进度。`);
}

function usesLocalAsr(): boolean {
  const s = settings.get();
  return s.out.asr === 'local' || s.in.asr === 'local';
}

let prefetching: Promise<void> | null = null;
let prefetchAbort: AbortController | null = null;

/** Downloads the offline models the current settings need, in the background, once. */
function prefetchModels(): Promise<void> {
  if (prefetching) return prefetching;
  const s = settings.get();
  const bases = new Set<'zh' | 'es' | 'en'>();
  if (s.out.asr === 'local') bases.add(baseOf(s.languages.self));
  if (s.in.asr === 'local') bases.add(baseOf(s.languages.remote));
  const abort = new AbortController();
  prefetchAbort = abort;
  prefetching = (async () => {
    for (const base of bases) await models.ensureFor(base, s.local.esModel, (p) => broadcast('model-progress', p), abort.signal);
    broadcast('toast', { level: 'info', message: '本机离线识别模型已下载完成。' });
  })()
    .catch((err) => {
      if (!isAbortError(err)) broadcast('toast', { level: 'warn', message: `下载本机识别模型失败：${err instanceof Error ? err.message : String(err)}（可在 设置 › 翻译服务 里重试）` });
    })
    .finally(() => {
      prefetching = null;
      prefetchAbort = null;
    });
  return prefetching;
}

/** Before a meeting with offline recognition, make sure its models are on disk. */
/** The local recognition models a meeting (or room) with these settings uses. */
function localAsrNeeded(mode: 'meeting' | 'room'): ModelId[] {
  if (!usesLocalAsr()) return [];
  const s = settings.get();
  const needed = new Set<ModelId>();
  if (s.out.asr === 'local') modelsForLang(s.languages.self, s.local.esModel).forEach((id) => needed.add(id));
  if (s.in.asr === 'local') modelsForLang(s.languages.remote, s.local.esModel).forEach((id) => needed.add(id));
  return [...needed];
}

/**
 * What still stands between the user and a meeting that works as chosen: missing keys and models
 * still downloading (devices are checked in the page itself). Cheap: no file hashing.
 */
async function readiness(): Promise<ReadinessItem[]> {
  const s = settings.get();
  if (s.preset === 'demo') return [];
  const items: ReadinessItem[] = [];
  for (const k of missingKeys(s, secrets.status())) items.push({ id: `key:${k.name}`, text: `还没填${KEY_NAMES[k.name]}的 Key（${k.for}要用）`, fix: 'providers' });
  const asr = localAsrNeeded('meeting').filter((id) => models.status(id) !== 'ready');
  const asrMissing = asr.length ? models.missingBytes(asr) : 0;
  if (asrMissing) {
    if (!prefetching) void prefetchModels();
    items.push({ id: 'asr-models', text: `本机识别模型还在下载（还差约 ${Math.max(1, Math.round(asrMissing / 1_000_000))} MB）`, fix: 'providers', downloading: true });
  }
  if (usesLocalAi() && !aiModelInUse()) {
    const id = s.local.aiModel;
    const total = AI_MODELS[id].files.reduce((n, f) => n + f.size, 0);
    const left = aiModels.missingBytes([id]);
    if (left) {
      void prefetchAi(id);
      const done = aiProgress?.id === id ? aiProgress.received : total - left;
      items.push({ id: 'ai-model', text: `本机 AI 翻译模型还在下载（${Math.max(0, Math.min(99, Math.floor((done / total) * 100)))}%，还差约 ${Math.max(1, Math.round((total - done) / 1_000_000))} MB）`, fix: 'providers', downloading: true });
    }
  } else if (usesLocalAi()) {
    // Loaded ahead of the meeting (the meeting page asks for this list when it opens).
    const ai = localAi();
    if (ai?.loadError) items.push({ id: 'ai-load', text: `本机 AI 翻译模型没能加载：${ai.loadError}`, fix: 'providers' });
    else if (ai && !ai.loadedNow) {
      ai.warmUp();
      items.push({ id: 'ai-loading', text: '本机 AI 翻译模型正在加载（第一次可能要半分钟，以后几秒钟）', downloading: true });
    }
  }
  if ([s.out.mt, s.in.mt].includes('offline')) {
    const left = await offlineMt.missingBytes().catch(() => 0);
    if (left) {
      void prefetchOfflineMt();
      items.push({ id: 'offline-mt', text: `离线翻译模型还在下载（还差约 ${Math.max(1, Math.round(left / 1_000_000))} MB）`, fix: 'providers', downloading: true });
    }
  }
  return items;
}

async function requireLocalModels(mode: 'meeting' | 'room'): Promise<void> {
  if (!usesLocalAsr()) return;
  const s = settings.get();
  const needed = new Set<ModelId>();
  if (s.out.asr === 'local') modelsForLang(s.languages.self, s.local.esModel).forEach((id) => needed.add(id));
  if (s.in.asr === 'local' && mode === 'meeting') modelsForLang(s.languages.remote, s.local.esModel).forEach((id) => needed.add(id));
  if (mode === 'room' && s.in.asr === 'local') modelsForLang(s.languages.remote, s.local.esModel).forEach((id) => needed.add(id));
  let missing = [...needed].filter((id) => models.status(id) !== 'ready');
  // Files from before hashes were recorded only need a one-time check, not a download.
  if (missing.length && models.missingBytes(missing) === 0) {
    await models.verifyExisting(missing);
    missing = missing.filter((id) => models.status(id) !== 'ready');
  }
  if (!missing.length) return;
  if (!prefetching) void prefetchModels();
  const mb = Math.round(modelsSize(missing) / 1_000_000);
  throw new Error(`正在下载本机离线识别模型（约 ${mb} MB），下载完成后即可开始${mode === 'room' ? '房间' : '同传'}。可在 设置 › 翻译服务 查看进度，或改用其他方案。`);
}

/** IPC is answered only for our own pages (mi-app://, or the dev server while developing). */
function isOurUrl(url: string): boolean {
  const dev = devRendererUrl();
  return isAppUrl(url) || (!!dev && (url === dev || url.startsWith(`${dev}/`)));
}

function fromOurPage(e: { senderFrame?: { url: string } | null }): boolean {
  return isOurUrl(e.senderFrame?.url ?? '');
}

ipcMain.handle(IPC.invoke, async (e, method: string, ...args: unknown[]) => {
  if (!fromOurPage(e)) throw new Error('not allowed');
  const h = typeof method === 'string' && Object.hasOwn(handlers, method) ? handlers[method as keyof typeof handlers] : undefined;
  if (!h) throw new Error(`unknown method ${method}`);
  try {
    return await (h as (...a: unknown[]) => unknown)(...args);
  } catch (err) {
    log.warn(`${method} failed`, err instanceof Error ? err.message : String(err));
    throw err instanceof Error ? new Error(err.message) : new Error(String(err));
  }
});

/** Bundled engine files and translation-model downloads for the audio window (no CORS here). */
const MT_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'storage.googleapis.com']);
ipcMain.handle('mi:fetch-bytes', async (e, url: string) => {
  if (!fromOurPage(e)) throw new Error('not allowed');
  const u = new URL(url);
  if (isAppUrl(url)) {
    const path = appFilePath(rendererDir, url);
    if (!path) throw new Error('not allowed');
    const b = readFileSync(path);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  }
  if (u.protocol === 'http:' && devRendererUrl() && url.startsWith(`${devRendererUrl()}/`)) {
    return (await fetch(url)).arrayBuffer();
  }
  if (u.protocol !== 'https:' || !MT_HOSTS.has(u.hostname)) throw new Error('not allowed');
  const res = await proxiedFetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.arrayBuffer();
});

ipcMain.on(IPC.fromAudio, (e, msg: FromAudio) => {
  if (!fromOurPage(e)) return;
  if (msg.type === 'mtReply' || msg.type === 'mtProgress') return offlineMt.handle(msg);
  sessionManager.handleAudio(msg);
  room.handleAudio(msg);
});

// ------------------------------------------------------------------ windows, tray, shortcuts

/** The hidden audio window; recreated (and the running meeting's audio restarted) if it dies. */
function openAudioWindow(): void {
  const win = createAudioWindow();
  audioWindow = win;
  win.on('closed', () => {
    if (audioWindow === win) audioWindow = null;
    if (!quitting) openAudioWindow();
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    log.error(`audio window gone: ${details.reason}`);
    if (quitting) return;
    broadcast('toast', { level: 'warn', message: '音频模块意外退出，正在自动恢复…' });
    audioWindow = null;
    win.destroy();
  });
  win.webContents.once('did-finish-load', () => {
    if (sessionManager.active && sessionManager.state.mode) sessionManager.restartAudio();
  });
}

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
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    const win = createOverlayWindow({ contentProtection: o.contentProtection, clickThrough: o.clickThrough, bounds: o.bounds });
    // Remember where the user puts it (saved once the move or resize settles).
    let timer: ReturnType<typeof setTimeout> | undefined;
    const remember = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!win.isDestroyed()) settings.set({ ui: { overlay: { bounds: win.getBounds() } } });
      }, 600);
    };
    win.on('move', remember);
    win.on('resize', remember);
    overlayWindow = win;
  }
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

/** 西 or 英, for the tray's labels. */
function foreignShort(): string {
  return baseOf(settings.get().languages.remote) === 'en' ? '英' : '西';
}

/** A tray action that failed: shown in the main window (the tray itself cannot show it). */
function trayFailed(err: unknown): void {
  showMain();
  broadcast('toast', { level: 'error', message: err instanceof Error ? err.message : String(err) });
}

function updateTray(): void {
  if (!tray) return;
  const st = sessionManager.state;
  const menu = Menu.buildFromTemplate([
    { label: '打开主窗口', click: showMain },
    { type: 'separator' },
    st.active
      ? { label: '结束会议', click: () => void Promise.resolve(handlers['meeting.stop']!()).catch(trayFailed) }
      : { label: '开始会议同传', click: () => void (handlers['meeting.start'] as (o: object) => Promise<unknown>)({}).catch(trayFailed) },
    { label: `翻译我的发言（中→${foreignShort()}）`, type: 'checkbox', checked: st.out.enabled, enabled: st.active, click: (i) => sessionManager.setOut(i.checked) },
    { label: `翻译会议声音（${foreignShort()}→中）`, type: 'checkbox', checked: st.in.enabled, enabled: st.active && st.mode === 'meeting', click: (i) => sessionManager.setIn(i.checked) },
    { label: '显示/隐藏字幕', click: toggleOverlay },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.setImage(trayIcon());
  tray.setToolTip(st.active ? '会议同传：进行中' : '会议同传助手');
}

/**
 * Global shortcuts are held only while a meeting or room runs: outside meetings other apps keep
 * every key combination (an always-registered shortcut steals it from every app on the computer).
 */
function syncShortcuts(): void {
  globalShortcut.unregisterAll();
  if (sessionManager.active || room.active) registerShortcuts();
}

function registerShortcuts(): void {
  const sc = settings.get().shortcuts;
  const tryReg = (accel: string, fn: () => void) => {
    if (!accel) return;
    try {
      if (!globalShortcut.register(accel, fn)) {
        log.warn(`shortcut ${accel} is taken`);
        broadcast('toast', { level: 'warn', message: `快捷键 ${accel.replace('CommandOrControl', process.platform === 'darwin' ? 'Cmd' : 'Ctrl')} 已被其他软件占用，这场会议里不能用。可以在 设置 › 快捷键 换一个。` });
      }
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
  protocol.handle(APP_SCHEME, async (req) => {
    const file = appFilePath(rendererDir, req.url);
    if (!file) return new Response('Not found', { status: 404 });
    try {
      return new Response(await readFile(file), { headers: { 'Content-Type': contentTypeOf(file), 'X-Content-Type-Options': 'nosniff' } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
  protocol.handle('mi-media', (req) => {
    // mi-media://file/<meeting id>/<relative path>
    const url = new URL(req.url);
    const [id, ...rest] = url.pathname.replace(/^\//, '').split('/').map(decodeURIComponent);
    const path = meetings.filePath(id!, rest.join('/'));
    return net.fetch(pathToFileURL(path).toString(), { headers: req.headers });
  });

  // System-audio loopback for "meeting audio from system sound": Electron swaps in Chromium's
  // loopbackWithoutChrome when the page asks for restrictOwnAudio (macOS 14.2+, Windows 11).
  // Microphone, screen and other permissions: only for our own pages.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback, details) => callback(isOurUrl(details.requestingUrl)));
  session.defaultSession.setPermissionCheckHandler((_wc, _permission, origin) => isOurUrl(origin));
  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      if (!isOurUrl(request.frame?.url ?? request.securityOrigin ?? '')) return callback({});
      desktopCapturer
        .getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
        .then((sources) => callback(sources[0] ? { video: sources[0], audio: 'loopback' } : {}))
        .catch(() => callback({}));
    },
    { useSystemPicker: false },
  );

  openAudioWindow();
  showMain();
  tray = new Tray(trayIcon());
  tray.on('click', showMain);
  updateTray();
  // Every settings change reaches every window, whichever handler made it (switches would
  // otherwise snap back to their old state).
  settings.on('changed', (s) => {
    updateTray();
    syncShortcuts();
    broadcast('settings', s);
  });
  sessionManager.on('ended', (meta) => {
    updateTray();
    syncShortcuts();
    // The subtitles belong to the meeting: they go away with it.
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide();
    autoReview(meta.id);
  });
  log.info(`started ${app.getVersion()} on ${process.platform} ${process.arch}`);
  // Week-old interrupted downloads, files earlier versions left, old driver installers (after
  // start-up, so it never slows the window down).
  setTimeout(() => {
    const r = cleanupData({ dataDir, tmpDir: tmpdir() });
    if (r.removed.length) log.info(`cleaned up ${r.removed.length} leftover file(s), ${Math.round(r.bytes / 1_000_000)} MB`);
  }, 20_000);
  void desktopBridge.start().catch((err) => log.warn('desktop bridge unavailable', err instanceof Error ? err.message : String(err)));
  setTimeout(offerMoveToApplications, 3000);
  // A quiet check for a newer release on GitHub (no auto-install: unsigned builds).
  setTimeout(() => {
    void checkForUpdate(app.getVersion(), log, proxiedFetch).then((u) => {
      if (!u) return;
      latestUpdate = u;
      broadcast('update-available', { version: u.version, notes: u.notes });
    });
  }, 8000);
});

app.on('activate', () => showMain());

let quitAfterStop = false;
app.on('before-quit', (e) => {
  quitting = true;
  // Stop the meeting while the audio window still exists, so recordings get their last chunks.
  if ((sessionManager.active || room.active) && !quitAfterStop) {
    e.preventDefault();
    quitAfterStop = true;
    void (room.active ? room.stop() : sessionManager.stop().then(() => undefined))
      .catch((err) => log.error('stop on quit failed', err instanceof Error ? err.message : String(err)))
      .finally(() => app.quit());
  }
});

app.on('window-all-closed', () => {
  // Stay in the tray on every platform while a meeting runs; otherwise quit (except macOS).
  if (process.platform !== 'darwin' && !sessionManager.active && !room.active) app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

