import WebSocket from 'ws';
import type { Logger } from '../../core/log';
import type { OpenWebSocketOptions, ProviderContext, WebSocketLike } from '../../core/providers/types';

/** Adapts the `ws` package (which can send auth headers) to the core's WebSocketLike. */
export function wrapWs(url: string, opts: OpenWebSocketOptions = {}): WebSocketLike {
  const ws = new WebSocket(url, opts.protocols, { headers: opts.headers, handshakeTimeout: 15000 });
  const like: WebSocketLike = {
    get readyState() {
      return ws.readyState;
    },
    send(data) {
      ws.send(data);
    },
    close(code, reason) {
      try {
        ws.close(code ?? 1000, reason);
      } catch {
        ws.terminate();
      }
    },
  };
  ws.on('open', () => like.onopen?.());
  ws.on('message', (data, isBinary) => {
    if (!like.onmessage) return;
    if (isBinary) {
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      like.onmessage(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
    } else like.onmessage(data.toString());
  });
  ws.on('close', (code, reason) => like.onclose?.(code, reason.toString()));
  ws.on('error', (err) => like.onerror?.(err));
  ws.on('unexpected-response', (_req, res) => {
    like.onerror?.(new Error(`WebSocket 握手失败：HTTP ${res.statusCode}${res.statusCode === 401 || res.statusCode === 403 ? '（Key 无效或无权限）' : ''}`));
    ws.terminate();
  });
  return like;
}

/**
 * `fetchImpl`: the app passes Electron's `net.fetch`, which follows the system proxy settings (so
 * overseas services work behind Clash and similar); the CLI and tests use Node's fetch.
 */
export function createNodeContext(log: Logger, fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init)): ProviderContext {
  return {
    fetch: fetchImpl,
    openWebSocket: wrapWs,
    log,
    now: () => Date.now(),
  };
}
