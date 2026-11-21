/**
 * The room's connection without WebSocket, for phones whose browser refuses wss:// to a
 * self-signed certificate even after the page itself was accepted (Safari on iPhone and iPad
 * does: the "visit this website" exception covers page loads, not WebSocket). Plain HTTPS
 * requests to the same origin go through: server → phone is one Server-Sent Events stream,
 * phone → server is ordered POSTs. The room code sees the same connection either way.
 */
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { decodeUp } from '../../core/room/protocol';

/** What the room needs from a phone's connection (a `ws` WebSocket fits it, and so does HttpSocket). */
export interface RoomConn {
  readonly readyState: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  ping(): void;
  on(event: 'message', cb: (data: Buffer | string, isBinary: boolean) => void): this;
  on(event: 'pong' | 'close' | 'error', cb: () => void): this;
}

const MAX_BUFFERED = 2 * 1024 * 1024;

export class HttpSocket extends EventEmitter implements RoomConn {
  readyState = 1;
  private res: ServerResponse | null = null;
  /** Messages sent while no stream is attached (between open and the first GET). */
  private queued: string[] = [];
  private queuedBytes = 0;

  constructor(readonly sid: string) {
    super();
  }

  /** The phone's event stream (GET). A newer stream replaces an older one. */
  attach(req: IncomingMessage, res: ServerResponse): void {
    if (this.readyState !== 1) return void res.writeHead(410).end();
    this.res?.end();
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(': open\n\n');
    for (const m of this.queued) res.write(m);
    this.queued = [];
    this.queuedBytes = 0;
    this.res = res;
    req.on('close', () => {
      if (this.res === res) this.res = null;
    });
  }

  send(data: string | Uint8Array): void {
    if (this.readyState !== 1) return;
    const chunk = typeof data === 'string' ? `data: ${data}\n\n` : `event: b\ndata: ${Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64')}\n\n`;
    if (this.res) this.res.write(chunk);
    else if (this.queuedBytes + chunk.length <= MAX_BUFFERED) {
      this.queued.push(chunk);
      this.queuedBytes += chunk.length;
    }
  }

  /** Alive while its stream is open (a phone asleep or off the Wi-Fi has none, and is dropped). */
  ping(): void {
    if (this.readyState === 1 && this.res) {
      this.res.write(': ping\n\n');
      this.emit('pong');
    }
  }

  /** One upload (POST body): its messages, in order. Returns false when the body is malformed. */
  receive(body: Uint8Array): boolean {
    if (this.readyState !== 1) return false;
    const items = decodeUp(body);
    if (!items) return false;
    for (const i of items) this.emit('message', i.binary ? Buffer.from(i.data) : Buffer.from(i.data).toString('utf8'), i.binary);
    return true;
  }

  close(): void {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.res?.end();
    this.res = null;
    this.emit('close');
  }

  terminate(): void {
    this.close();
  }
}
