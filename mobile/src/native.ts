/**
 * Network for the phone app. Inside the Android app, requests and WebSockets go through the
 * native side (window.MiNative), which can send the headers cloud speech services require and is
 * not limited by the browser's cross-origin rules. In a plain browser (development, tests) the
 * browser's own fetch / WebSocket are used.
 */
import { base64ToBytes, bytesToBase64 } from '@core/audio/pcm';
import type { Logger } from '@core/log';
import type { OpenWebSocketOptions, ProviderContext, WebSocketLike } from '@core/providers/types';

interface NativeApi {
  wsOpen(id: string, url: string, headersJson: string): void;
  wsSendText(id: string, text: string): void;
  wsSendBinary(id: string, base64: string): void;
  wsClose(id: string, code: number, reason: string): void;
  http(id: string, method: string, url: string, headersJson: string, bodyBase64: string): void;
  keepAwake(on: boolean): void;
  openUrl(url: string): void;
}

type WsEvent = 'open' | 'text' | 'binary' | 'close' | 'error';

declare global {
  interface Window {
    MiNative?: NativeApi;
    MiNativeEvents?: {
      ws(id: string, type: WsEvent, payload: string, code?: number): void;
      http(id: string, status: number, headersJson: string, bodyBase64: string, error: string): void;
    };
  }
}

export const native = (): NativeApi | undefined => window.MiNative;

let seq = 0;
const sockets = new Map<string, WebSocketLike & { state: number }>();
const requests = new Map<string, { resolve: (r: Response) => void; reject: (e: Error) => void }>();

window.MiNativeEvents = {
  ws(id, type, payload, code) {
    const s = sockets.get(id);
    if (!s) return;
    switch (type) {
      case 'open':
        s.state = 1;
        s.onopen?.();
        break;
      case 'text':
        s.onmessage?.(payload);
        break;
      case 'binary':
        s.onmessage?.(base64ToBytes(payload));
        break;
      case 'error':
        s.onerror?.(new Error(payload || 'WebSocket 连接失败'));
        break;
      case 'close':
        s.state = 3;
        sockets.delete(id);
        s.onclose?.(code ?? 1006, payload);
        break;
    }
  },
  http(id, status, headersJson, bodyBase64, error) {
    const r = requests.get(id);
    if (!r) return;
    requests.delete(id);
    if (error) return r.reject(new TypeError(error));
    const body = base64ToBytes(bodyBase64);
    r.resolve(new Response(status === 204 || status === 304 ? null : (body as Uint8Array<ArrayBuffer>), { status, headers: JSON.parse(headersJson || '{}') as Record<string, string> }));
  },
};

function nativeWs(api: NativeApi, url: string, opts: OpenWebSocketOptions): WebSocketLike {
  const id = `ws${++seq}`;
  const s: WebSocketLike & { state: number } = {
    state: 0,
    get readyState() {
      return this.state;
    },
    send(data) {
      if (this.state !== 1) return;
      if (typeof data === 'string') api.wsSendText(id, data);
      else api.wsSendBinary(id, bytesToBase64(data));
    },
    close(code, reason) {
      if (this.state >= 2) return;
      this.state = 2;
      api.wsClose(id, code ?? 1000, reason ?? '');
    },
  };
  sockets.set(id, s);
  api.wsOpen(id, url, JSON.stringify(opts.headers ?? {}));
  return s;
}

async function nativeFetch(api: NativeApi, input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const req = new Request(input, init);
  const id = `h${++seq}`;
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => (headers[k] = v));
  const body = req.method === 'GET' || req.method === 'HEAD' ? new Uint8Array() : new Uint8Array(await req.arrayBuffer());
  return new Promise<Response>((resolve, reject) => {
    requests.set(id, { resolve, reject });
    init.signal?.addEventListener('abort', () => {
      requests.delete(id);
      reject(new DOMException('Aborted', 'AbortError'));
    });
    api.http(id, req.method, req.url, JSON.stringify(headers), bytesToBase64(body));
  });
}

function browserWs(url: string, opts: OpenWebSocketOptions): WebSocketLike {
  const ws = new WebSocket(url, opts.protocols);
  ws.binaryType = 'arraybuffer';
  const like: WebSocketLike = {
    get readyState() {
      return ws.readyState;
    },
    send: (d) => ws.send(d as string | Uint8Array<ArrayBuffer>),
    close: (c, r) => ws.close(c ?? 1000, r),
  };
  ws.onopen = () => like.onopen?.();
  ws.onmessage = (e) => like.onmessage?.(typeof e.data === 'string' ? e.data : new Uint8Array(e.data as ArrayBuffer));
  ws.onerror = () => like.onerror?.(new Error('WebSocket 连接失败'));
  ws.onclose = (e) => like.onclose?.(e.code, e.reason);
  return like;
}

export function createMobileContext(log: Logger): ProviderContext {
  const api = native();
  return {
    fetch: api ? (i, init) => nativeFetch(api, i, init) : (i, init) => fetch(i, init),
    openWebSocket: (url, opts = {}) => (api ? nativeWs(api, url, opts) : browserWs(url, opts)),
    log,
    now: () => Date.now(),
  };
}

export function openExternal(url: string): void {
  const api = native();
  if (api) api.openUrl(url);
  else window.open(url, '_blank');
}

export function keepAwake(on: boolean): void {
  native()?.keepAwake(on);
}
