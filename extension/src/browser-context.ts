import type { Logger } from '@core/log';
import type { OpenWebSocketOptions, ProviderContext, WebSocketLike } from '@core/providers/types';

/**
 * Browser WebSockets cannot send headers, and some services (百炼) authenticate the handshake
 * with `Authorization`. `addHeaders` asks the service worker to add them to the handshake with a
 * session rule that only applies to the extension's own requests; the socket opens once that is in
 * place. Without headers the browser socket opens directly.
 */
export function wrapBrowserWs(url: string, opts: OpenWebSocketOptions, addHeaders: (url: string, headers: Record<string, string>) => Promise<void>): WebSocketLike {
  let ws: WebSocket | null = null;
  let closed = false;
  let state = 0;
  const like: WebSocketLike = {
    get readyState() {
      return ws ? ws.readyState : state;
    },
    send(data) {
      if (ws?.readyState === 1) ws.send(data as string | Uint8Array<ArrayBuffer>);
    },
    close(code, reason) {
      closed = true;
      state = 3;
      try {
        ws?.close(code ?? 1000, reason);
      } catch {
        ws?.close();
      }
    },
  };
  const open = () => {
    if (closed) return;
    const s = new WebSocket(url, opts.protocols);
    s.binaryType = 'arraybuffer';
    ws = s;
    let opened = false;
    s.onopen = () => {
      opened = true;
      like.onopen?.();
    };
    s.onmessage = (e) => {
      if (!like.onmessage) return;
      if (typeof e.data === 'string') like.onmessage(e.data);
      else like.onmessage(new Uint8Array(e.data as ArrayBuffer));
    };
    // Browsers hide why a handshake failed; a rejected key shows up as an error before `open`.
    s.onerror = () => like.onerror?.(new Error(opened ? 'WebSocket 连接出错' : 'WebSocket 连接失败（请检查 Key、网络或代理）'));
    s.onclose = (e) => like.onclose?.(e.code, e.reason);
  };
  const headers = Object.fromEntries(Object.entries(opts.headers ?? {}).filter(([k]) => k.toLowerCase() !== 'user-agent'));
  if (Object.keys(headers).length) {
    addHeaders(url, headers).then(open, (err: unknown) => {
      state = 3;
      like.onerror?.(err instanceof Error ? err : new Error(String(err)));
      like.onclose?.(1006, 'headers');
    });
  } else queueMicrotask(open);
  return like;
}

export function createBrowserContext(log: Logger, addHeaders: (url: string, headers: Record<string, string>) => Promise<void>): ProviderContext {
  return {
    fetch: (input, init) => globalThis.fetch(input, init),
    openWebSocket: (url, opts = {}) => wrapBrowserWs(url, opts, addHeaders),
    log,
    now: () => Date.now(),
  };
}

/** A small console logger matching the core's Logger interface. */
export function consoleLogger(prefix = 'mi'): Logger {
  const make = (p: string): Logger => ({
    debug: (...a: unknown[]) => console.debug(`[${p}]`, ...a),
    info: (...a: unknown[]) => console.info(`[${p}]`, ...a),
    warn: (...a: unknown[]) => console.warn(`[${p}]`, ...a),
    error: (...a: unknown[]) => console.error(`[${p}]`, ...a),
    child: (name: string) => make(`${p}:${name}`),
  });
  return make(prefix);
}

/** The session rule that adds `headers` to the extension's own WebSocket handshakes for `url`. */
export function headerRule(id: number, url: string, headers: Record<string, string>): chrome.declarativeNetRequest.Rule {
  const u = new URL(url);
  return {
    id,
    priority: 1,
    action: {
      type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
      requestHeaders: Object.entries(headers).map(([header, value]) => ({ header, operation: 'set' as chrome.declarativeNetRequest.HeaderOperation, value })),
    },
    condition: {
      urlFilter: `|${u.protocol}//${u.host}${u.pathname}`,
      resourceTypes: ['websocket' as chrome.declarativeNetRequest.ResourceType],
      tabIds: [-1],
    },
  };
}
