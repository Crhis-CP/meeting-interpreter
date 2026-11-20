import type { ToAudio } from '@shared/ipc';
import { AudioEngine } from './engine';

const engine = new AudioEngine((msg) => window.audioBridge.send(msg));

// Every command runs after the previous one finished: a "stop" that arrives while "start" is
// still waiting for a device must not run first and leave the late start running.
let queue: Promise<void> = Promise.resolve();
function enqueue(msg: ToAudio): Promise<void> {
  const run = queue.then(() => engine.handle(msg));
  queue = run.catch((err) => window.audioBridge.send({ type: 'error', message: err instanceof Error ? err.message : String(err) }));
  return queue;
}

window.audioBridge.onMessage((msg: ToAudio) => {
  // Playback is time-critical and independent of device setup order.
  if (msg.type === 'tts' || msg.type === 'ttsEnd') {
    engine.handle(msg).catch(() => undefined);
    return;
  }
  void enqueue(msg);
});

// Commands that may open system-audio capture arrive through executeJavaScript with a user
// gesture, which getDisplayMedia requires.
(window as unknown as { __miAudio: { handle(msg: ToAudio): Promise<void> } }).__miAudio = { handle: enqueue };
