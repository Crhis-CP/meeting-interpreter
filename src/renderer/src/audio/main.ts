import type { FromAudio, ToAudio } from '@shared/ipc';
import { AudioEngine } from './engine';
import { OfflineMt } from '../../../browser/offline-mt/engine';

const engine = new AudioEngine((msg) => window.audioBridge.send(msg));

// Every command runs after the previous one finished: a "stop" that arrives while "start" is
// still waiting for a device must not run first and leave the late start running.
let queue: Promise<void> = Promise.resolve();
function enqueue(msg: ToAudio): Promise<void> {
  const run = queue.then(() => engine.handle(msg));
  queue = run.catch((err) => window.audioBridge.send({ type: 'error', message: err instanceof Error ? err.message : String(err) }));
  return queue;
}

// Offline translation (Mozilla models) runs here, in a web worker, for the main process. Files are
// read and downloaded by the main process (no cross-origin limits) and handed over as blobs.
const bridge = window.audioBridge as typeof window.audioBridge & { fetchBytes(url: string): Promise<ArrayBuffer> };
const blobUrl = async (rel: string, type: string) =>
  URL.createObjectURL(new Blob([await bridge.fetchBytes(new URL(rel, location.href).href)], { type }));
let mtEngine: Promise<OfflineMt> | null = null;
const getMt = () =>
  (mtEngine ??= (async () =>
    new OfflineMt({
      workerUrl: await blobUrl('./offline-mt/worker.js', 'text/javascript'),
      glueUrl: await blobUrl('./offline-mt/bergamot-translator.js', 'text/javascript'),
      wasmUrl: await blobUrl('./offline-mt/bergamot-translator.wasm', 'application/wasm'),
      fetchImpl: async (input) => (String(input).startsWith('blob:') ? fetch(input) : new Response(await bridge.fetchBytes(String(input)))),
    }))());
async function handleMt(msg: Extract<ToAudio, { type: 'mt' | 'mtStatus' | 'mtDownload' | 'mtClear' }>) {
  const reply = (r: Omit<Extract<FromAudio, { type: 'mtReply' }>, 'type' | 'id'>) => window.audioBridge.send({ type: 'mtReply', id: msg.id, ...r });
  try {
    const mt = await getMt();
    if (msg.type === 'mt') reply({ text: await mt.translate(msg.text, msg.from, msg.to) });
    else if (msg.type === 'mtStatus') {
      // Copies left by an earlier version go first (the folder must not keep growing).
      await mt.prune().catch(() => 0);
      reply({ missingBytes: await mt.missingBytes() });
    } else if (msg.type === 'mtClear') {
      await mt.clear();
      reply({ missingBytes: await mt.missingBytes() });
    } else {
      await mt.download((p) => window.audioBridge.send({ type: 'mtProgress', ...p }));
      reply({ missingBytes: 0 });
    }
  } catch (err) {
    reply({ error: err instanceof Error ? err.message : String(err) });
  }
}

window.audioBridge.onMessage((msg: ToAudio) => {
  if (msg.type === 'mt' || msg.type === 'mtStatus' || msg.type === 'mtDownload' || msg.type === 'mtClear') {
    void handleMt(msg);
    return;
  }
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
