import { contextBridge, ipcRenderer } from 'electron';
import type { RendererApi, RendererEvents } from '../shared/ipc';

// Sandboxed preloads cannot require other bundle chunks, so channel names are inlined here
// (they must match IPC in src/shared/ipc.ts).
const IPC = { invoke: 'mi:invoke', event: 'mi:event', toAudio: 'mi:to-audio', fromAudio: 'mi:from-audio' } as const;

/** Builds a namespaced proxy: api.settings.get(...) → invoke('settings.get', ...). */
function ns<T extends object>(name: string, methods: string[]): T {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const m of methods) out[m] = (...args: unknown[]) => ipcRenderer.invoke(IPC.invoke, `${name}.${m}`, ...args);
  return out as T;
}

const api: RendererApi = {
  settings: ns('settings', ['get', 'set', 'applyPreset']),
  secrets: ns('secrets', ['status', 'set']),
  glossary: ns('glossary', ['list', 'save', 'remove', 'importCsv', 'exportCsv']),
  meeting: ns('meeting', ['start', 'stop', 'state', 'setOut', 'setIn', 'setInSpeak', 'setPassthrough', 'pushToTalk', 'skip', 'setRecording']),
  meetings: ns('meetings', ['list', 'get', 'summarize', 'rename', 'remove', 'openFolder', 'openFile', 'fileUrl', 'editSegment', 'review', 'decide', 'undo', 'forgetTerm']),
  profile: ns('profile', ['get', 'script', 'calibrate', 'addCorrection', 'removeCorrection', 'exportFile', 'importFile', 'reset', 'openFolder']),
  providers: ns('providers', ['test', 'voices']),
  voice: ns('voice', ['create', 'remove']),
  mt: ns('mt', ['status', 'download']),
  ai: ns('ai', ['status', 'download']),
  local: ns('local', ['status', 'download']),
  audio: ns('audio', ['testTone', 'installDriver', 'canRestoreSystemDefaults', 'restoreSystemDefaults']),
  room: ns('room', ['start', 'stop', 'state', 'setPublic']),
  app: ns('app', ['info', 'openExternal', 'detectMeetingApps', 'screenSources', 'chooseRecordsDir', 'openRecordsDir', 'showWindow', 'setOverlayClickThrough', 'overlayPointer', 'hideOverlay']),
  on<K extends keyof RendererEvents>(event: K, fn: (payload: RendererEvents[K]) => void) {
    const listener = (_e: unknown, msg: { event: string; payload: unknown }) => {
      if (msg.event === event) fn(msg.payload as RendererEvents[K]);
    };
    ipcRenderer.on(IPC.event, listener);
    return () => ipcRenderer.removeListener(IPC.event, listener);
  },
};

contextBridge.exposeInMainWorld('api', api);
contextBridge.exposeInMainWorld('platform', process.platform);
