/** A tiny typed event emitter that works in Node and browsers. */
export class Emitter<E extends Record<string, unknown>> {
  private listeners: { [K in keyof E]?: Set<(payload: E[K]) => void> } = {};

  on<K extends keyof E>(event: K, fn: (payload: E[K]) => void): () => void {
    let set = this.listeners[event];
    if (!set) {
      set = new Set();
      this.listeners[event] = set;
    }
    set.add(fn);
    return () => this.off(event, fn);
  }

  once<K extends keyof E>(event: K, fn: (payload: E[K]) => void): () => void {
    const off = this.on(event, (p) => {
      off();
      fn(p);
    });
    return off;
  }

  off<K extends keyof E>(event: K, fn: (payload: E[K]) => void): void {
    this.listeners[event]?.delete(fn);
  }

  emit<K extends keyof E>(event: K, payload: E[K]): void {
    const set = this.listeners[event];
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        // A failing listener must not break the emitter's other listeners or the audio path.
        console.error(`[emitter] listener for ${String(event)} threw`, err);
      }
    }
  }

  removeAllListeners(): void {
    this.listeners = {};
  }
}

/** Resolves after `ms` milliseconds; rejects with an AbortError if `signal` aborts first. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

export function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}
