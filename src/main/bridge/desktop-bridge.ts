import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { bytesToInt16, int16ToBytes, concatInt16 } from '../../core/audio/pcm';
import { bridgeOriginAllowed, DESKTOP_BRIDGE_APP, DESKTOP_BRIDGE_PORT, type BridgeAsrServerMessage, type BridgePing } from '../../core/bridge/desktop';
import { baseOf, LANGUAGES } from '../../core/lang/languages';
import type { Logger } from '../../core/log';
import type { AsrSession, StreamingAsr, Tts } from '../../core/providers/types';

export interface DesktopBridgeDeps {
  version: string;
  log: Logger;
  enabled: () => boolean;
  /** A fresh offline recogniser. */
  asr: () => StreamingAsr;
  tts: () => Tts;
  /** Whether a language's offline models are on disk. */
  modelsReady: (base: 'zh' | 'es' | 'en') => boolean;
  /** Downloads the models for a language (reports progress text). */
  ensureModels: (base: 'zh' | 'es' | 'en', onStatus: (text: string) => void) => Promise<void>;
  /** Called when the extension starts or stops using the bridge. */
  onClients?: (n: number) => void;
}

/**
 * Serves the free offline recognition and the computer's voices to the Chrome extension on
 * 127.0.0.1 only. Web pages cannot use it: requests carrying a web Origin are refused.
 */
export class DesktopBridge {
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();

  constructor(
    private readonly d: DesktopBridgeDeps,
    private readonly port = DESKTOP_BRIDGE_PORT,
  ) {}

  get listening(): boolean {
    return !!this.server?.listening;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((req, res) => void this.http(req, res).catch((err) => this.fail(res, 500, err)));
    const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (!this.d.enabled() || url.pathname !== '/asr' || !bridgeOriginAllowed(req.headers.origin)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => this.asr(ws, url));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.server = server;
    this.wss = wss;
    this.d.log.info(`desktop bridge on 127.0.0.1:${this.port}`);
  }

  async stop(): Promise<void> {
    for (const ws of this.clients) ws.terminate();
    this.clients.clear();
    this.wss?.close();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server = null;
    this.wss = null;
  }

  private cors(req: IncomingMessage, res: ServerResponse): boolean {
    const origin = req.headers.origin;
    if (!bridgeOriginAllowed(origin)) {
      res.writeHead(403).end();
      return false;
    }
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Expose-Headers', 'X-Sample-Rate');
      res.setHeader('Vary', 'Origin');
    }
    return true;
  }

  private fail(res: ServerResponse, status: number, err: unknown) {
    if (res.headersSent) return res.end();
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(err instanceof Error ? err.message : String(err));
  }

  private async http(req: IncomingMessage, res: ServerResponse) {
    if (!this.cors(req, res)) return;
    if (!this.d.enabled()) return void res.writeHead(503).end('disabled');
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'OPTIONS') return void res.writeHead(204).end();
    if (req.method === 'GET' && url.pathname === '/ping') {
      const body: BridgePing = {
        app: DESKTOP_BRIDGE_APP,
        version: this.d.version,
        models: { zh: this.d.modelsReady('zh'), es: this.d.modelsReady('es'), en: this.d.modelsReady('en') },
      };
      return void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    }
    if (req.method === 'GET' && url.pathname === '/voices') {
      const l = url.searchParams.get('lang') ?? '';
      const voices = LANGUAGES[l] ? this.d.tts().voices(l) : [];
      return void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(voices));
    }
    if (req.method === 'POST' && url.pathname === '/tts') {
      const body = JSON.parse(await readBody(req, 64 * 1024)) as { text?: string; lang?: string; voice?: string; rate?: number };
      if (!body.text || !body.lang || !LANGUAGES[body.lang]) return void res.writeHead(400).end('bad request');
      const chunks: Int16Array[] = [];
      let rate = 22050;
      for await (const c of this.d.tts().synthesize({ text: body.text.slice(0, 2000), lang: body.lang, voice: body.voice || undefined, rate: Number(body.rate) || 1 })) {
        chunks.push(c.samples);
        rate = c.sampleRate;
      }
      const pcm = int16ToBytes(concatInt16(chunks));
      return void res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'X-Sample-Rate': String(rate) }).end(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
    }
    res.writeHead(404).end();
  }

  private asr(ws: WebSocket, url: URL) {
    const send = (m: BridgeAsrServerMessage) => ws.readyState === 1 && ws.send(JSON.stringify(m));
    const l = url.searchParams.get('lang') ?? '';
    if (!LANGUAGES[l]) {
      send({ t: 'error', message: `不支持的语言 ${l}`, fatal: true });
      return ws.close();
    }
    let hotwords: string[] = [];
    try {
      const hw = JSON.parse(url.searchParams.get('hw') ?? '[]') as unknown;
      if (Array.isArray(hw)) hotwords = hw.filter((x): x is string => typeof x === 'string').slice(0, 200);
    } catch {
      // ignore malformed hot words
    }
    this.clients.add(ws);
    this.d.onClients?.(this.clients.size);
    let session: AsrSession | null = null;
    let closed = false;
    ws.on('close', () => {
      closed = true;
      this.clients.delete(ws);
      this.d.onClients?.(this.clients.size);
      session?.close();
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        session?.push(bytesToInt16(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)));
        return;
      }
      try {
        const m = JSON.parse(data.toString()) as { t?: string };
        if (m.t === 'end') void session?.end();
      } catch {
        // ignore
      }
    });
    void (async () => {
      try {
        const base = baseOf(l);
        if (!this.d.modelsReady(base)) {
          send({ t: 'status', text: '正在下载本机识别模型…' });
          await this.d.ensureModels(base, (text) => send({ t: 'status', text }));
        }
        if (closed) return;
        const s = await this.d.asr().start({ lang: l, hotwords, sampleRate: 16000 });
        if (closed) return s.close();
        session = s;
        s.events.on('partial', ({ text }) => send({ t: 'partial', text }));
        s.events.on('final', (f) => send({ t: 'final', ...f }));
        s.events.on('error', ({ error, fatal }) => send({ t: 'error', message: error.message, fatal }));
        s.events.on('closed', () => {
          send({ t: 'closed' });
          ws.close();
        });
        send({ t: 'ready' });
      } catch (err) {
        send({ t: 'error', message: err instanceof Error ? err.message : String(err), fatal: true });
        ws.close();
      }
    })();
  }
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
      } else parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}
