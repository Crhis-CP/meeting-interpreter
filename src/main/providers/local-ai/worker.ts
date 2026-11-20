/**
 * Electron `utilityProcess` entry for the local AI translation model (node-llama-cpp), so a slow
 * or crashing model never blocks or takes down the app. Also loads under plain Node (tests).
 */
import type { ParentPortLike } from '../local-asr/worker';

export type AiRequest = { t: 'load'; modelPath: string; threads: number } | { t: 'complete'; id: number; prompt: string; maxTokens: number };
export type AiReply = { t: 'loaded'; gpu: string } | { t: 'result'; id: number; text: string } | { t: 'error'; id?: number; message: string };

type Lib = typeof import('node-llama-cpp');
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function attachAiWorker(port: ParentPortLike, loadLib: () => Promise<Lib> = () => import('node-llama-cpp')): void {
  let ready: Promise<{ lib: Lib; seq: import('node-llama-cpp').LlamaContextSequence }> | null = null;
  let chain: Promise<void> = Promise.resolve();
  const reply = (m: AiReply) => port.postMessage(m);

  port.on('message', (e) => {
    const m = e.data as AiRequest;
    if (m?.t === 'load') {
      ready = (async () => {
        const lib = await loadLib();
        // Prebuilt binaries only (never compile on the user's computer); Metal on Apple silicon.
        const llama = await lib.getLlama({ gpu: 'auto', build: 'never' });
        const model = await llama.loadModel({ modelPath: m.modelPath });
        const ctx = await model.createContext({ contextSize: 2048, threads: m.threads });
        return { lib, seq: ctx.getSequence(), gpu: String(llama.gpu) };
      })();
      ready.then(
        (r) => reply({ t: 'loaded', gpu: (r as unknown as { gpu: string }).gpu }),
        (err) => reply({ t: 'error', message: `本机 AI 翻译模型加载失败：${message(err)}` }),
      );
      return;
    }
    if (m?.t === 'complete') {
      // One sentence at a time on one context sequence; each starts from a clean history.
      chain = chain.then(async () => {
        if (!ready) return reply({ t: 'error', id: m.id, message: '模型还没有加载' });
        let session: import('node-llama-cpp').LlamaChatSession | null = null;
        try {
          const { lib, seq } = await ready;
          session = new lib.LlamaChatSession({ contextSequence: seq, autoDisposeSequence: false });
          const text = await session.prompt(m.prompt, { temperature: 0, maxTokens: m.maxTokens });
          reply({ t: 'result', id: m.id, text });
        } catch (err) {
          reply({ t: 'error', id: m.id, message: message(err) });
        } finally {
          session?.dispose({ disposeSequence: false });
          await ready?.then(({ seq }) => seq.clearHistory()).catch(() => undefined);
        }
      });
    }
  });
}

/**
 * The same worker inside the calling process (Linux: node-llama-cpp checks its Linux binaries by
 * starting a helper process, which only works from Electron's main process; tests).
 */
export function createInProcessAiWorker(): import('../local-asr/client').WorkerHandle {
  const toWorker: ((e: { data: unknown }) => void)[] = [];
  const toMain: ((m: unknown) => void)[] = [];
  attachAiWorker({ on: (_e, fn) => void toWorker.push(fn), postMessage: (m) => void setImmediate(() => toMain.forEach((f) => f(m))) });
  return {
    postMessage: (m: unknown) => void setImmediate(() => toWorker.forEach((f) => f({ data: m }))),
    on: (ev: string, fn: (m: any) => void) => void (ev === 'message' && toMain.push(fn)),
    kill: () => undefined,
  } as import('../local-asr/client').WorkerHandle;
}

const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort;
if (parentPort) attachAiWorker(parentPort);
