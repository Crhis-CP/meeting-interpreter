import type { AudioConfig, ToAudio } from '@shared/ipc';
import { AudioEngine } from './engine';

const engine = new AudioEngine((msg) => window.audioBridge.send(msg));

window.audioBridge.onMessage((msg: ToAudio) => {
  engine.handle(msg).catch((err) => window.audioBridge.send({ type: 'error', message: err instanceof Error ? err.message : String(err) }));
});

// Starting goes through executeJavaScript with a user gesture, which getDisplayMedia (system
// audio loopback) requires.
(window as unknown as { __miAudio: { start(cfg: AudioConfig): Promise<void> } }).__miAudio = {
  start: (cfg: AudioConfig) =>
    engine.handle({ type: 'start', config: cfg }).catch((err) => window.audioBridge.send({ type: 'error', message: err instanceof Error ? err.message : String(err) })),
};
