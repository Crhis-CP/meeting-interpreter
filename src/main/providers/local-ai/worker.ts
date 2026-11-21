/**
 * Electron `utilityProcess` entry for the local AI translation model (node-llama-cpp), so a slow
 * or crashing model never blocks or takes down the app. Also loads under plain Node (tests).
 */
import type { ParentPortLike } from '../local-asr/worker';

/** `lane`: one per direction (0: into the other language, 1: into Chinese), each with its own cached prefix. */
export type AiRequest = { t: 'load'; modelPath: string; threads: number } | { t: 'complete'; id: number; prompt: string; maxTokens: number; lane?: number } | { t: 'cancel'; id: number };
export type AiReply = { t: 'loaded'; gpu: string } | { t: 'result'; id: number; text: string } | { t: 'error'; id?: number; message: string };

type Lib = typeof import('node-llama-cpp');
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Wires the worker to its port; returns a function that frees the model (for the in-process worker). */
const LANES = 2;

/**
 * Hy-MT's own chat format, exactly as its template writes one user turn (no system prompt: the
 * library's default English one is not what the model was trained with, and costs ~55 tokens a
 * sentence).
 */
const HY_TURN = (prompt: string) => `<｜hy_begin▁of▁sentence｜><｜hy_User｜>${prompt}<｜hy_Assistant｜>`;

export function attachAiWorker(port: ParentPortLike, loadLib: () => Promise<Lib> = () => import('node-llama-cpp')): () => Promise<void> {
  type Lane = { complete: (prompt: string, maxTokens: number, signal: AbortSignal) => Promise<string>; chain: Promise<void>; current: { id: number; stop: AbortController } | null };
  let loaded: { model: { dispose(): Promise<void> }; ctx: { dispose(): Promise<void> } } | null = null;
  let ready: Promise<{ lanes: Lane[]; gpu: string }> | null = null;
  /** Sentences the app gave up on (timed out) before their turn: skipped, never translated late. */
  const cancelled = new Set<number>();
  const reply = (m: AiReply) => port.postMessage(m);

  port.on('message', (e) => {
    const m = e.data as AiRequest;
    if (m?.t === 'load') {
      ready = (async () => {
        const lib = await loadLib();
        // Prebuilt binaries only (never compile on the user's computer); Metal on Apple silicon.
        const llama = await lib.getLlama({ gpu: 'auto', build: 'never' });
        const model = await llama.loadModel({ modelPath: m.modelPath });
        // A sequence per direction: each keeps its instruction evaluated, so a new sentence only
        // costs its own words (the library reuses the matching start of the previous prompt).
        const ctx = await model.createContext({ contextSize: 2048, threads: m.threads, sequences: LANES });
        loaded = { model, ctx };
        const meta = (model as { fileInfo?: { metadata?: { tokenizer?: { chat_template?: unknown } } } }).fileInfo?.metadata;
        const template = String(meta?.tokenizer?.chat_template ?? '');
        const hy = template.includes('<｜hy_User｜>');
        const lanes: Lane[] = [];
        for (let i = 0; i < LANES; i++) {
          const seq = ctx.getSequence();
          let complete: Lane['complete'];
          if (hy) {
            const completion = new lib.LlamaCompletion({ contextSequence: seq });
            complete = (prompt, maxTokens, signal) => completion.generateCompletion(model.tokenize(HY_TURN(prompt), true), { temperature: 0, maxTokens, signal });
          } else {
            // Another model family: its own chat template, still without the default system prompt.
            complete = async (prompt, maxTokens, signal) => {
              const session = new lib.LlamaChatSession({ contextSequence: seq, autoDisposeSequence: false, systemPrompt: '' });
              try {
                return await session.prompt(prompt, { temperature: 0, maxTokens, signal });
              } finally {
                session.dispose({ disposeSequence: false });
              }
            };
          }
          lanes.push({ complete, chain: Promise.resolve(), current: null });
        }
        return { lanes, gpu: String(llama.gpu) };
      })();
      ready.then(
        (r) => reply({ t: 'loaded', gpu: r.gpu }),
        (err) => reply({ t: 'error', message: `本机 AI 翻译模型加载失败：${message(err)}` }),
      );
      return;
    }
    if (m?.t === 'cancel') {
      // Cancelling the sentence being translated stops its generation: on a slow computer,
      // finishing translations nobody waits for would make every newer sentence time out too.
      void ready?.then(({ lanes }) => {
        const lane = lanes.find((l) => l.current?.id === m.id);
        if (lane) lane.current!.stop.abort();
        else cancelled.add(m.id);
      });
      return;
    }
    if (m?.t === 'complete') {
      if (!ready) return reply({ t: 'error', id: m.id, message: '模型还没有加载' });
      void ready.then(
        (r) => {
          // One sentence at a time per direction; the two directions run side by side.
          const lane = r.lanes[Math.max(0, Math.min(LANES - 1, m.lane ?? 0))]!;
          lane.chain = lane.chain.then(async () => {
            if (cancelled.delete(m.id)) return;
            const stop = new AbortController();
            lane.current = { id: m.id, stop };
            try {
              reply({ t: 'result', id: m.id, text: await lane.complete(m.prompt, m.maxTokens, stop.signal) });
            } catch (err) {
              reply({ t: 'error', id: m.id, message: stop.signal.aborted ? 'cancelled' : message(err) });
            } finally {
              lane.current = null;
            }
          });
        },
        (err) => reply({ t: 'error', id: m.id, message: message(err) }),
      );
    }
  });
  return async () => {
    await ready?.catch(() => undefined);
    const l = loaded;
    loaded = null;
    ready = null;
    await l?.ctx.dispose().catch(() => undefined);
    await l?.model.dispose().catch(() => undefined);
  };
}

/**
 * The same worker inside the calling process (Linux: node-llama-cpp checks its Linux binaries by
 * starting a helper process, which only works from Electron's main process; tests).
 */
export function createInProcessAiWorker(): import('../local-asr/client').WorkerHandle {
  const toWorker: ((e: { data: unknown }) => void)[] = [];
  const toMain: ((m: unknown) => void)[] = [];
  const onExit: ((code: number) => void)[] = [];
  const unload = attachAiWorker({ on: (_e, fn) => void toWorker.push(fn), postMessage: (m) => void setImmediate(() => toMain.forEach((f) => f(m))) });
  return {
    postMessage: (m: unknown) => void setImmediate(() => toWorker.forEach((f) => f({ data: m }))),
    on: (ev: string, fn: (m: any) => void) => void (ev === 'message' ? toMain.push(fn) : ev === 'exit' && onExit.push(fn)),
    // No process to end: free the model and its context instead (the idle unload must give memory back).
    kill: () => {
      toWorker.length = 0;
      void unload().finally(() => onExit.forEach((f) => f(0)));
    },
  } as import('../local-asr/client').WorkerHandle;
}

const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort;
if (parentPort) attachAiWorker(parentPort);
