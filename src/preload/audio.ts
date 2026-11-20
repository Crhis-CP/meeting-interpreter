import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type FromAudio, type ToAudio } from '../shared/ipc';

contextBridge.exposeInMainWorld('audioBridge', {
  send(msg: FromAudio) {
    ipcRenderer.send(IPC.fromAudio, msg);
  },
  onMessage(fn: (msg: ToAudio) => void) {
    ipcRenderer.on(IPC.toAudio, (_e, msg: ToAudio) => fn(msg));
  },
});
contextBridge.exposeInMainWorld('platform', process.platform);
