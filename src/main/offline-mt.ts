import type { LangBase } from '../core/lang/languages';
import type { OfflineMtEngine } from '../core/providers/offline-translator';
import type { FromAudio, ToAudio } from '../shared/ipc';

type Reply = Extract<FromAudio, { type: 'mtReply' }>;

/**
 * The offline translation engine as the main process sees it: requests go to the hidden audio
 * window, which runs Mozilla's models in a web worker.
 */
export class AudioWindowMt implements OfflineMtEngine {
  private seq = 0;
  private pending = new Map<number, { resolve: (r: Reply) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(
    private readonly send: (msg: ToAudio) => boolean,
    private readonly onProgress: (p: { received: number; total: number; file: string }) => void,
  ) {}

  private request(msg: { type: 'mt'; text: string; from: LangBase; to: LangBase } | { type: 'mtStatus' } | { type: 'mtDownload' }, timeoutMs: number): Promise<Reply> {
    const id = ++this.seq;
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('离线翻译没有响应'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      if (!this.send({ ...msg, id } as ToAudio)) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('音频模块未就绪'));
      }
    });
  }

  handle(msg: FromAudio): void {
    if (msg.type === 'mtProgress') return this.onProgress(msg);
    if (msg.type !== 'mtReply') return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    p.resolve(msg);
  }

  async translate(text: string, from: LangBase, to: LangBase): Promise<string> {
    // The first sentence also loads the models (about 2 s).
    const r = await this.request({ type: 'mt', text, from, to }, 30_000);
    if (r.error) throw new Error(r.error);
    return r.text ?? '';
  }

  async missingBytes(): Promise<number> {
    const r = await this.request({ type: 'mtStatus' }, 15_000);
    if (r.error) throw new Error(r.error);
    return r.missingBytes ?? 0;
  }

  async download(): Promise<void> {
    const r = await this.request({ type: 'mtDownload' }, 30 * 60_000);
    if (r.error) throw new Error(r.error);
  }
}
