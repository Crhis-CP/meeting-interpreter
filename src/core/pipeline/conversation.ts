/**
 * Conversation mode: two people share one microphone (a phone on the table). One recogniser
 * listens for both languages; every sentence is routed by its language to the pipeline that
 * translates it (Chinese → the other language, the other language → Chinese).
 */
import { Emitter } from '../events';
import type { LangCode } from '../types';
import type { AsrEvents, AsrSession, AsrStartOptions, StreamingAsr } from '../providers/types';

const HAN = /[㐀-鿿豈-﫿]/g;
const LATIN_WORD = /[A-Za-zÀ-ÿ]+/g;

/** Which of the two languages a piece of recognised text is in (null when it cannot tell). */
export function textSide(text: string): 'zh' | 'foreign' | null {
  const han = text.match(HAN)?.length ?? 0;
  const latin = text.match(LATIN_WORD)?.length ?? 0;
  if (!han && !latin) return null;
  // A Chinese sentence may contain a Latin name, and a Spanish one a Chinese name: compare
  // Han characters with Latin words (a Han character carries about a word of meaning).
  return han >= latin ? 'zh' : 'foreign';
}

interface View {
  side: 'zh' | 'foreign';
  session: ViewSession;
}

class ViewSession implements AsrSession {
  readonly events = new Emitter<AsrEvents>();
  closed = false;
  constructor(
    private readonly owner: SharedAsr,
    readonly side: 'zh' | 'foreign',
  ) {}
  push(pcm: Int16Array): void {
    // Only the Chinese view carries the microphone; the other one just listens.
    if (this.side === 'zh') this.owner.push(pcm);
  }
  end(): Promise<void> {
    return this.owner.endFrom(this);
  }
  close(): void {
    this.owner.closeFrom(this);
  }
}

export class SharedAsr {
  private real: AsrSession | null = null;
  private starting: Promise<AsrSession> | null = null;
  private views = new Set<View>();

  constructor(
    private readonly asr: StreamingAsr,
    private readonly zhLang: LangCode,
    private readonly foreignLang: LangCode,
  ) {}

  /** A recogniser that only reports the sentences spoken in one of the two languages. */
  view(side: 'zh' | 'foreign'): StreamingAsr {
    return {
      id: `${this.asr.id}:${side}`,
      start: async (opts: AsrStartOptions) => {
        const session = new ViewSession(this, side);
        const v: View = { side, session };
        this.views.add(v);
        try {
          await this.ensureReal(opts);
        } catch (err) {
          this.views.delete(v);
          throw err;
        }
        return session;
      },
    };
  }

  push(pcm: Int16Array): void {
    this.real?.push(pcm);
  }

  private async ensureReal(opts: AsrStartOptions): Promise<AsrSession> {
    if (this.real) return this.real;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const s = await this.asr.start({ ...opts, lang: this.zhLang, alsoLangs: [this.foreignLang] });
      s.events.on('partial', ({ text }) => this.route(text, (v) => v.session.events.emit('partial', { text }), true));
      s.events.on('final', (f) => this.route(f.text, (v) => v.session.events.emit('final', f), false));
      s.events.on('error', (e) => {
        for (const v of this.views) v.session.events.emit('error', e);
      });
      s.events.on('closed', (c) => {
        if (this.real === s) this.real = null;
        for (const v of [...this.views]) this.finishView(v, c.reason);
      });
      this.real = s;
      return s;
    })();
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private lastSide: 'zh' | 'foreign' = 'zh';

  private route(text: string, emit: (v: View) => void, partial: boolean) {
    const side = textSide(text) ?? this.lastSide;
    if (!partial) this.lastSide = side;
    for (const v of this.views) {
      if (v.side === side) emit(v);
      // A partial that switched language: clear the stale partial on the other side.
      else if (partial) v.session.events.emit('partial', { text: '' });
    }
  }

  private finishView(v: View, reason?: string) {
    this.views.delete(v);
    if (v.session.closed) return;
    v.session.closed = true;
    v.session.events.emit('closed', { reason });
  }

  async endFrom(s: ViewSession): Promise<void> {
    const v = [...this.views].find((x) => x.session === s);
    if (!v) return;
    // The microphone's view flushes the shared recogniser; the listener just detaches.
    if (s.side === 'zh' && this.real) await this.real.end();
    else this.finishView(v);
  }

  closeFrom(s: ViewSession): void {
    const v = [...this.views].find((x) => x.session === s);
    if (!v) return;
    this.finishView(v);
    if (!this.views.size && this.real) {
      const r = this.real;
      this.real = null;
      r.close();
    }
  }
}
