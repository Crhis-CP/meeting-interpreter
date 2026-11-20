/**
 * Electron `utilityProcess` entry for offline recognition: loads sherpa-onnx in its own process and
 * talks to `LocalAsr` (client.ts) over `process.parentPort`. Nothing here imports `electron`, so the
 * module also loads under plain Node (tests, CLI), where `process.parentPort` does not exist.
 */
import type { WorkerHandle, WorkerReply, WorkerRequest } from './client';
import { ModelManager } from './model-manager';
import { LocalRecognizer, loadSherpaOnnx, type ModelLocator, type SherpaOnnxModule } from './recognizer';

/** Electron's `process.parentPort` (a `MessageEvent` with `data` per message). */
export interface ParentPortLike {
  on(event: 'message', listener: (e: { data: unknown }) => void): unknown;
  postMessage(message: unknown): void;
}

export interface WorkerDeps {
  loadSherpa?: () => SherpaOnnxModule;
  createModels?: (modelsDir: string) => ModelLocator;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** PCM arrives as an ArrayBuffer (structured clone); typed-array views are accepted too. */
function toInt16(data: unknown): Int16Array {
  if (Object.prototype.toString.call(data) === '[object ArrayBuffer]') {
    const buf = data as ArrayBuffer;
    return new Int16Array(buf, 0, buf.byteLength >> 1);
  }
  if (ArrayBuffer.isView(data)) {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength & ~1);
    return new Int16Array(bytes.slice().buffer);
  }
  throw new Error('收到的音频数据格式不对');
}

/** Wires the recogniser to a message port. Returns a disposer (used by the in-process worker). */
export function attachWorker(port: ParentPortLike, deps: WorkerDeps = {}): { dispose(): void } {
  let recognizer: LocalRecognizer | null = null;
  let ended = false;
  let disposed = false;
  const send = (m: WorkerReply) => {
    if (!disposed) port.postMessage(m);
  };

  port.on('message', (e) => {
    const msg = (e as { data?: unknown } | null)?.data as WorkerRequest | undefined;
    if (disposed || !msg || typeof msg !== 'object') return;
    try {
      switch (msg.type) {
        case 'start': {
          if (recognizer) return;
          const models = deps.createModels ? deps.createModels(msg.modelsDir) : new ModelManager(msg.modelsDir);
          const sherpa = (deps.loadSherpa ?? loadSherpaOnnx)();
          recognizer = new LocalRecognizer({
            sherpa,
            lang: msg.lang,
            models,
            esModel: msg.esModel,
            numThreads: msg.numThreads,
            onFinal: (text, start, end) => send({ type: 'final', text, start, end }),
          });
          send({ type: 'ready' });
          break;
        }
        case 'pcm':
          if (recognizer && !ended) recognizer.feed(toInt16(msg.data));
          break;
        case 'end':
          if (ended) return;
          ended = true;
          recognizer?.flush();
          send({ type: 'ended' });
          break;
      }
    } catch (err) {
      send({ type: 'error', message: errorMessage(err) });
    }
  });

  return {
    dispose() {
      disposed = true;
      recognizer = null;
    },
  };
}

/**
 * Runs the worker inside this process, with messages delivered asynchronously and cloned like real
 * IPC. For the CLI and tests; the app uses a utility process so decoding never blocks the main process.
 */
export function createInProcessWorker(deps: WorkerDeps = {}): WorkerHandle {
  const messageFns: ((m: unknown) => void)[] = [];
  const exitFns: ((code: number) => void)[] = [];
  let portFn: ((e: { data: unknown }) => void) | null = null;
  let alive = true;
  const port: ParentPortLike = {
    on: (_event, listener) => {
      portFn = listener;
    },
    postMessage: (m) =>
      setImmediate(() => {
        if (alive) for (const fn of messageFns) fn(structuredClone(m));
      }),
  };
  const worker = attachWorker(port, deps);
  return {
    postMessage: (m: unknown) =>
      setImmediate(() => {
        if (alive) portFn?.({ data: structuredClone(m) });
      }),
    on: (ev: 'message' | 'exit', fn: (x: any) => void) => {
      (ev === 'message' ? messageFns : exitFns).push(fn);
    },
    kill: () => {
      if (!alive) return;
      alive = false;
      worker.dispose();
      setImmediate(() => {
        for (const fn of exitFns) fn(0);
      });
    },
  };
}

// ------------------------------------------------------------------ utility process entry
const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort;
if (parentPort) {
  attachWorker(parentPort);
  process.on('uncaughtException', (err) => {
    try {
      parentPort.postMessage({ type: 'error', message: `本机识别进程出错：${errorMessage(err)}` } satisfies WorkerReply);
    } finally {
      setTimeout(() => process.exit(1), 100);
    }
  });
}
