import { contextBridge, ipcRenderer } from 'electron';
import type { FromAudio, ToAudio } from '../shared/ipc';

// Sandboxed preloads cannot require other bundle chunks; must match IPC in src/shared/ipc.ts.
const IPC = { toAudio: 'mi:to-audio', fromAudio: 'mi:from-audio' } as const;

contextBridge.exposeInMainWorld('audioBridge', {
  send(msg: FromAudio) {
    ipcRenderer.send(IPC.fromAudio, msg);
  },
  onMessage(fn: (msg: ToAudio) => void) {
    ipcRenderer.on(IPC.toAudio, (_e, msg: ToAudio) => fn(msg));
  },
});
contextBridge.exposeInMainWorld('platform', process.platform);
