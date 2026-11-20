import { createLogger } from '@core/log';
import type { OpenWebSocketOptions, ProviderContext, WebSocketLike } from '@core/providers/types';

/** A scriptable fake WebSocket: tests inspect `sent` and drive `serverSend` / `serverClose`. */
export class FakeWebSocket implements WebSocketLike {
  readyState = 0;
  sent: (string | Uint8Array)[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  onopen?: () => void;
  onmessage?: (data: string | Uint8Array) => void;
  onclose?: (code: number, reason: string) => void;
  onerror?: (err: Error) => void;
  constructor(
    readonly url: string,
    readonly opts: OpenWebSocketOptions = {},
  ) {}
  /** Simulates the handshake completing. */
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  send(data: string | Uint8Array): void {
    if (this.readyState !== 1) throw new Error('FakeWebSocket: send while not open');
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    if (this.readyState === 3) return;
    this.closedWith = { code, reason };
    this.readyState = 3;
    this.onclose?.(code ?? 1000, reason ?? '');
  }
  serverSend(data: string | Uint8Array | object): void {
    const payload = typeof data === 'string' || data instanceof Uint8Array ? data : JSON.stringify(data);
    this.onmessage?.(payload);
  }
  serverClose(code = 1000, reason = ''): void {
    this.readyState = 3;
    this.onclose?.(code, reason);
  }
  /** Sent text frames parsed as JSON. */
  json(): any[] {
    return this.sent.filter((s): s is string => typeof s === 'string').map((s) => JSON.parse(s));
  }
  binary(): Uint8Array[] {
    return this.sent.filter((s): s is Uint8Array => s instanceof Uint8Array);
  }
}

export interface FakeContext extends ProviderContext {
  sockets: FakeWebSocket[];
  requests: { url: string; init: RequestInit }[];
}

/**
 * A ProviderContext whose WebSockets are FakeWebSockets (opened on the next microtask unless
 * `autoOpen` is false) and whose fetch calls `handler`.
 */
export function fakeContext(
  handler: (url: string, init: RequestInit) => Response | Promise<Response> = () => new Response('not mocked', { status: 500 }),
  opts: { autoOpen?: boolean } = {},
): FakeContext {
  const sockets: FakeWebSocket[] = [];
  const requests: { url: string; init: RequestInit }[] = [];
  return {
    sockets,
    requests,
    log: createLogger('test'),
    now: () => Date.now(),
    fetch: (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      requests.push({ url, init });
      return handler(url, init);
    }) as typeof fetch,
    openWebSocket(url: string, o?: OpenWebSocketOptions) {
      const ws = new FakeWebSocket(url, o);
      sockets.push(ws);
      if (opts.autoOpen !== false) queueMicrotask(() => ws.open());
      return ws;
    },
  };
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** Waits until `cond()` is true or fails after `timeoutMs`. */
export async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out');
    await tick(5);
  }
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
