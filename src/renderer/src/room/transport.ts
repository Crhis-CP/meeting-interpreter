/**
 * The phone's connection to the room. WebSocket first; plain HTTPS when the browser will not open
 * one. Safari on iPhone/iPad refuses wss:// to the room's self-signed certificate even after the
 * person tapped "visit this website" for the page, while ordinary requests to the same address
 * work: then messages come down an event stream and go up as ordered POSTs (http-socket.ts).
 */
import { encodeUp } from '@core/room/protocol';

export interface RoomSocket {
  /** 0 connecting, 1 open, 3 closed (like WebSocket). */
  readonly readyState: number;
  readonly kind: 'ws' | 'http';
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((data: string | ArrayBuffer) => void) | null;
  onclose: (() => void) | null;
}

export function openWebSocket(): RoomSocket {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';
  const sock: RoomSocket = {
    kind: 'ws',
    get readyState() {
      return ws.readyState;
    },
    send: (d) => ws.send(d as string | ArrayBuffer),
    close: () => ws.close(),
    onopen: null,
    onmessage: null,
    onclose: null,
  };
  ws.onopen = () => sock.onopen?.();
  ws.onmessage = (e) => sock.onmessage?.(e.data as string | ArrayBuffer);
  ws.onclose = () => sock.onclose?.();
  return sock;
}

function fromBase64(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export function openHttp(token: string): RoomSocket {
  let state = 0;
  let sid = '';
  let es: EventSource | null = null;
  let queue: { binary: boolean; data: Uint8Array }[] = [];
  let sending = false;
  const enc = new TextEncoder();

  const sock: RoomSocket = {
    kind: 'http',
    get readyState() {
      return state;
    },
    send(d) {
      if (state !== 1) return;
      queue.push(typeof d === 'string' ? { binary: false, data: enc.encode(d) } : { binary: true, data: d instanceof Uint8Array ? d : new Uint8Array(d) });
      void flush();
    },
    close() {
      if (state === 3) return;
      if (sid) void fetch(`/rt/close?sid=${sid}`, { method: 'POST', keepalive: true }).catch(() => undefined);
      end();
    },
    onopen: null,
    onmessage: null,
    onclose: null,
  };

  const end = () => {
    if (state === 3) return;
    state = 3;
    es?.close();
    es = null;
    queue = [];
    setTimeout(() => sock.onclose?.(), 0);
  };

  // One upload at a time, so messages (and audio) arrive in order; what piles up meanwhile goes together.
  const flush = async () => {
    if (sending || !queue.length || state !== 1) return;
    sending = true;
    const batch = queue;
    queue = [];
    try {
      const body = encodeUp(batch);
      const res = await fetch(`/rt/up?sid=${sid}`, { method: 'POST', body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer, headers: { 'Content-Type': 'application/octet-stream' } });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      end();
    } finally {
      sending = false;
    }
    void flush();
  };

  void (async () => {
    try {
      const res = await fetch(`/rt/open?t=${encodeURIComponent(token)}`, { method: 'POST' });
      if (!res.ok) throw new Error(String(res.status));
      sid = ((await res.json()) as { sid: string }).sid;
      if (state === 3) return;
      es = new EventSource(`/rt/down?sid=${sid}`);
      es.onopen = () => {
        if (state !== 0) return;
        state = 1;
        sock.onopen?.();
      };
      es.onmessage = (e) => sock.onmessage?.(e.data as string);
      es.addEventListener('b', (e) => sock.onmessage?.(fromBase64((e as MessageEvent<string>).data)));
      // EventSource would quietly reconnect to a session the room may have dropped: the room
      // client reconnects instead, with a fresh session.
      es.onerror = () => end();
    } catch {
      end();
    }
  })();
  return sock;
}
