import { createServer, type Server } from 'node:https';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import { WebSocketServer } from 'ws';
import type { AppSettings } from '../../core/config/schema';
import type { GlossaryEntry } from '../../core/glossary/types';
import { baseOf, lang, LANGUAGES, otherLanguage, type LangBase } from '../../core/lang/languages';
import type { CorrectionRule } from '../../core/profile/profile';
import type { Logger } from '../../core/log';
import type { DirectionPipeline } from '../../core/pipeline/pipeline';
import { createDirection } from '../../core/pipeline/direction';
import { Talk } from '../../core/pipeline/talk';
import type { Providers } from '../../core/providers/registry';
import { decodeFrame, encodeTtsFrame, ROOM_PROTOCOL_VERSION, type ClientMessage, type RoomPeer, type ServerMessage } from '../../core/room/protocol';
import type { Direction, TranscriptSegment } from '../../core/types';
import type { FromAudio, RendererEvents, RoomState, ToAudio } from '../../shared/ipc';
import type { SessionManager } from '../session/session-manager';
import { lanAddresses, roomCertificate } from './cert';
import { HttpSocket, type RoomConn } from './http-socket';
import { TunnelManager } from './tunnel';

export interface RoomDeps {
  settings: () => AppSettings;
  session: SessionManager;
  providers: () => Providers;
  glossary: () => GlossaryEntry[];
  personal?: (base: LangBase) => { rules: readonly CorrectionRule[]; pairs: readonly string[]; hotwords: readonly string[] };
  toAudio: (msg: ToAudio) => void;
  broadcast: <K extends keyof RendererEvents>(event: K, payload: RendererEvents[K]) => void;
  log: Logger;
  dataDir: string;
  /** Built renderer files (room.html and assets). */
  staticDir: () => string;
  devUrl: () => string | undefined;
  /** Test hook: plain HTTP instead of HTTPS. */
  insecure?: boolean;
  /** Used to download cloudflared (the app passes Electron's proxy-aware net.fetch). */
  fetch?: typeof fetch;
  /** Overrides of the room's limits (tests). */
  limits?: Partial<RoomLimits>;
}

/** Limits that keep a leaked room link from running up the host's bills or exhausting the computer. */
export interface RoomLimits {
  participants: number;
  /** People talking (each one runs recognition and translation) at the same time. */
  talkers: number;
  /** Sockets that have not joined yet. */
  pending: number;
  /** Wrong-link attempts from one address before it is locked out for the rest of the room. */
  badJoins: number;
  /** Audio a phone may send, bytes per second (16 kHz 16-bit speech is 32 000). */
  audioBytesPerSecond: number;
  /**
   * A participant who has not talked for this long gives back their pipeline (a local recogniser
   * holds a few hundred MB); it is created again when they talk.
   */
  idlePipelineMs: number;
}

const DEFAULT_LIMITS: RoomLimits = { participants: 30, talkers: 3, pending: 20, badJoins: 10, audioBytesPerSecond: 48_000, idlePipelineMs: 60_000 };

interface Participant {
  id: string;
  alive: boolean;
  /** WebSocket, or the plain-HTTPS fallback for browsers that refuse wss:// to a self-signed certificate. */
  ws: RoomConn;
  name: string;
  lang: string;
  talking: boolean;
  pipeline: DirectionPipeline | null;
  /** Pipelines made for this participant so far: a new one (after a quiet minute) numbers its sentences apart. */
  generation: number;
  /** Releases the pipeline (and its recogniser) after a quiet minute. */
  idleTimer?: ReturnType<typeof setTimeout>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

/**
 * On-site interpretation room: the desktop app serves a web page that phones on the same Wi-Fi
 * (or anywhere, through a free Cloudflare quick tunnel) open by scanning a QR code. Each phone
 * picks 中文 or the other language (Español / English); what one person says is recognised, translated and spoken to everyone
 * listening in the other language. The host's own microphone takes part through the meeting
 * session (`out` pipeline).
 */
export class RoomHost {
  private server: Server | import('node:http').Server | null = null;
  private wss: WebSocketServer | null = null;
  private httpSockets = new Map<string, HttpSocket>();
  private token = '';
  private readonly limits: RoomLimits;
  private badJoins = new Map<string, number>();
  private pendingSockets = 0;
  private port = 0;
  private participants = new Map<string, Participant>();
  /** What everyone in the room says, for the translations that depend on it (one per room). */
  private talk = new Talk();
  private startedSession = false;
  private tunnel: TunnelManager;
  private publicUrl: string | null = null;
  private publicStatus: RoomState['publicStatus'] = 'off';
  private publicError: string | undefined;
  private qr: Record<string, string> = {};
  private offs: (() => void)[] = [];
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  /** Play Chinese translations of phone speakers on the host computer too. */
  hostListen = true;

  constructor(private readonly d: RoomDeps) {
    this.limits = { ...DEFAULT_LIMITS, ...(d.limits ?? {}) };
    this.tunnel = new TunnelManager(join(d.dataDir, 'bin'), d.log.child('tunnel'), d.fetch);
  }

  get active(): boolean {
    return this.server !== null;
  }

  private urls(): string[] {
    if (!this.server) return [];
    const scheme = this.d.insecure ? 'http' : 'https';
    const hosts = lanAddresses();
    return (hosts.length ? hosts : ['localhost']).map((h) => `${scheme}://${h}:${this.port}/?t=${this.token}&l=${this.d.settings().languages.remote}`);
  }

  async state(): Promise<RoomState> {
    const urls = this.urls();
    const all = [...urls, ...(this.publicUrl ? [this.publicUrl] : [])];
    for (const u of all) {
      if (!this.qr[u]) this.qr[u] = await QRCode.toDataURL(u, { margin: 1, width: 280, errorCorrectionLevel: 'M' });
    }
    return {
      active: this.active,
      urls,
      publicUrl: this.publicUrl,
      publicStatus: this.publicStatus,
      publicError: this.publicError,
      qr: Object.fromEntries(all.map((u) => [u, this.qr[u]!])),
      participants: [...this.participants.values()].map((p) => ({ id: p.id, name: p.name, lang: p.lang, talking: p.talking, connected: true })),
    };
  }

  private async publishState(): Promise<void> {
    this.d.broadcast('room', await this.state());
  }

  async start(): Promise<RoomState> {
    if (this.server) return this.state();
    const s = this.d.settings();
    // A room never shares an online meeting's transcript with the phones.
    if (this.d.session.active && this.d.session.currentMeta?.mode !== 'room') throw new Error('正在进行线上会议同传，请先结束会议，再开现场房间');
    if (!this.d.session.active) {
      await this.d.session.start({ mode: 'room' });
      this.startedSession = true;
    }
    this.token = randomBytes(16).toString('base64url');
    this.badJoins.clear();
    this.talk.reset();
    const handler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) =>
      (req.url ?? '').startsWith('/rt/') ? this.serveHttpConn(req, res) : this.serveStatic(req, res);
    if (this.d.insecure) {
      const { createServer: createHttp } = await import('node:http');
      this.server = createHttp(handler);
    } else {
      const { key, cert } = await roomCertificate(this.d.dataDir);
      this.server = createServer({ key, cert }, handler);
    }
    this.wss = new WebSocketServer({ server: this.server as Server, path: '/ws', maxPayload: 1 << 20 });
    this.wss.on('connection', (ws, req) => this.onConnection(ws as unknown as RoomConn, req.socket.remoteAddress ?? ''));
    // Phones that went to sleep or lost Wi-Fi never close their socket: ping and drop them.
    this.heartbeat = setInterval(() => {
      for (const p of this.participants.values()) {
        if (!p.alive) {
          p.ws.terminate();
          continue;
        }
        p.alive = false;
        try {
          p.ws.ping();
        } catch {
          p.ws.terminate();
        }
      }
    }, 20000);
    try {
      this.port = await this.listen(s.room.port);
    } catch (err) {
      // Nothing half-open is left behind: no meeting with the microphone on, no timer, no server.
      await this.stop().catch(() => undefined);
      const code = (err as NodeJS.ErrnoException).code;
      throw new Error(`现场房间没能开始：电脑不让本软件使用网络端口（${code ?? (err instanceof Error ? err.message : String(err))}）。可以重启电脑后再试。`);
    }
    this.offs.push(
      this.d.session.on('segment', (seg) => this.send('*', { t: 'segment', seg })),
      this.d.session.on('tts', ({ dir, segmentId, samples, sampleRate }) => {
        // The host's own speech (Chinese → Spanish) goes to everyone listening in Spanish.
        if (dir === 'out') this.sendTts(this.d.settings().languages.remote, segmentId, sampleRate, samples, null);
      }),
      this.d.session.on('ttsEnd', ({ dir, segmentId }) => {
        if (dir === 'out') this.sendToLang(this.d.settings().languages.remote, { t: 'audioEnd', segmentId }, null);
      }),
    );
    this.d.log.info(`room on port ${this.port}`);
    if (s.room.publicLink) void this.setPublic(true);
    await this.publishState();
    return this.state();
  }

  private listen(preferred: number): Promise<number> {
    return new Promise((resolvePort, reject) => {
      const srv = this.server!;
      const tryPort = (port: number, fallback: boolean) => {
        const onError = (err: NodeJS.ErrnoException) => {
          srv.off('listening', onListening);
          // In use, or in a range Windows reserves (Hyper-V, WSL2, Docker: EACCES): any free port.
          if ((err.code === 'EADDRINUSE' || err.code === 'EACCES') && fallback) tryPort(0, false);
          else reject(err);
        };
        const onListening = () => {
          srv.off('error', onError);
          const addr = srv.address();
          resolvePort(typeof addr === 'object' && addr ? addr.port : port);
        };
        srv.once('error', onError);
        srv.once('listening', onListening);
        srv.listen(port, '0.0.0.0');
      };
      tryPort(preferred, true);
    });
  }

  async setPublic(on: boolean): Promise<RoomState> {
    if (!on) {
      this.tunnel.stop();
      this.publicUrl = null;
      this.publicStatus = 'off';
      await this.publishState();
      return this.state();
    }
    if (!this.server) return this.state();
    this.publicStatus = 'starting';
    this.publicError = undefined;
    await this.publishState();
    try {
      const base = await this.tunnel.start(`${this.d.insecure ? 'http' : 'https'}://localhost:${this.port}`);
      this.publicUrl = `${base}/?t=${this.token}&l=${this.d.settings().languages.remote}`;
      this.publicStatus = 'on';
    } catch (err) {
      this.publicStatus = 'error';
      this.publicError = err instanceof Error ? err.message : String(err);
    }
    await this.publishState();
    return this.state();
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.send('*', { t: 'ended' });
    for (const p of this.participants.values()) {
      void p.pipeline?.stop(2000);
      p.ws.close(1001, 'room closed');
    }
    this.participants.clear();
    for (const off of this.offs) off();
    this.offs = [];
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.tunnel.stop();
    this.publicUrl = null;
    this.publicStatus = 'off';
    // The meeting record is written first: a locked phone must not keep it waiting.
    if (this.startedSession) {
      this.startedSession = false;
      await this.d.session.stop();
    }
    // A phone that is locked or in the background never answers the close handshake (the ws
    // library would wait 30 s): give everyone a moment, then cut what is left, joined or not.
    const wss = this.wss;
    const server = this.server;
    this.wss = null;
    this.server = null;
    await new Promise((r) => setTimeout(r, 300));
    for (const ws of wss?.clients ?? []) ws.terminate();
    for (const h of [...this.httpSockets.values()]) h.terminate();
    this.httpSockets.clear();
    wss?.close();
    (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
    await this.publishState();
  }

  handleAudio(_msg: FromAudio): void {
    // The host microphone reaches the room through the session's `out` pipeline.
  }

  // ------------------------------------------------------------------ HTTP

  /**
   * The connection over plain HTTPS (see http-socket.ts): POST /rt/open?t=TOKEN → { sid };
   * GET /rt/down?sid= (event stream); POST /rt/up?sid= (messages); POST /rt/close?sid=.
   */
  private serveHttpConn(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void {
    const noStore = { 'Cache-Control': 'no-store' };
    let u: URL;
    try {
      u = new URL(req.url ?? '/', 'http://x');
    } catch {
      return void res.writeHead(400, noStore).end();
    }
    if (u.pathname === '/rt/open' && req.method === 'POST') {
      // The room link's token: no connection (and no slot) for anyone without it.
      if (u.searchParams.get('t') !== this.token) return void res.writeHead(403, noStore).end();
      if (this.httpSockets.size >= this.limits.participants + this.limits.pending) return void res.writeHead(503, noStore).end();
      const sock = new HttpSocket(randomBytes(16).toString('base64url'));
      this.httpSockets.set(sock.sid, sock);
      sock.on('close', () => this.httpSockets.delete(sock.sid));
      this.onConnection(sock, req.socket.remoteAddress ?? '');
      if (sock.readyState !== 1) return void res.writeHead(503, noStore).end();
      return void res.writeHead(200, { 'Content-Type': 'application/json', ...noStore }).end(JSON.stringify({ sid: sock.sid }));
    }
    const sock = this.httpSockets.get(u.searchParams.get('sid') ?? '');
    if (!sock) return void res.writeHead(404, noStore).end();
    if (u.pathname === '/rt/down' && req.method === 'GET') return sock.attach(req, res);
    if (u.pathname === '/rt/up' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > (1 << 20) + 4096) req.destroy(); // same limit as a WebSocket message
        else chunks.push(c);
      });
      req.on('end', () => {
        const ok = sock.receive(new Uint8Array(Buffer.concat(chunks)));
        res.writeHead(ok ? 204 : 400, noStore).end();
      });
      return;
    }
    if (u.pathname === '/rt/close' && req.method === 'POST') {
      sock.close();
      return void res.writeHead(204, noStore).end();
    }
    res.writeHead(404, noStore).end();
  }

  private serveStatic(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    let rel: string;
    try {
      rel = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const root = resolve(this.d.staticDir());
    if (rel === '/' || rel === '/index.html') rel = '/room.html';
    const file = normalize(join(root, rel));
    if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': rel.startsWith('/assets/') ? 'public, max-age=86400' : 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') res.end();
    else res.end(readFileSync(file));
  }

  // ------------------------------------------------------------------ WebSocket

  private send(to: string | '*', msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const p of this.participants.values()) {
      if ((to === '*' || p.id === to) && p.ws.readyState === 1) p.ws.send(data);
    }
  }

  private sendToLang(code: string, msg: ServerMessage, except: string | null): void {
    const data = JSON.stringify(msg);
    for (const p of this.participants.values()) {
      if (p.id !== except && baseOf(p.lang) === baseOf(code) && p.ws.readyState === 1) p.ws.send(data);
    }
  }

  private sendTts(code: string, segmentId: string, sampleRate: number, samples: Int16Array, except: string | null): void {
    const frame = encodeTtsFrame(segmentId, sampleRate, samples);
    for (const p of this.participants.values()) {
      if (p.id !== except && baseOf(p.lang) === baseOf(code) && p.ws.readyState === 1) p.ws.send(frame);
    }
  }

  private peers(): RoomPeer[] {
    return [{ id: 'host', name: '主持人', lang: this.d.settings().languages.self, talking: false, host: true }, ...[...this.participants.values()].map((p) => ({ id: p.id, name: p.name, lang: p.lang, talking: p.talking }))];
  }

  private onConnection(ws: RoomConn, address: string): void {
    let me: Participant | null = null;
    const refuse = (message: string, code: number) => {
      ws.send(JSON.stringify({ t: 'error', message, fatal: true } satisfies ServerMessage));
      ws.close(code, 'refused');
    };
    if (this.pendingSockets >= this.limits.pending) return void ws.terminate();
    this.pendingSockets++;
    let pending = true;
    const settle = () => {
      if (pending) this.pendingSockets--;
      pending = false;
    };
    const timer = setTimeout(() => {
      if (!me) ws.close(4001, 'join timeout');
    }, 15000);
    // Audio budget per phone (token bucket): a steady rate, with a few seconds of burst for a
    // phone catching up after a network stall.
    const burst = this.limits.audioBytesPerSecond * 5;
    let budget = burst;
    let budgetAt = Date.now();
    ws.on('pong', () => {
      if (me) me.alive = true;
    });
    ws.on('message', (data, isBinary) => {
      if (me) me.alive = true;
      if (isBinary) {
        if (!me || !me.talking) return;
        const raw = data as Buffer | ArrayBuffer | Buffer[] | string;
        const buf = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.isBuffer(raw) ? raw : typeof raw === 'string' ? Buffer.from(raw) : Buffer.from(raw);
        const now = Date.now();
        budget = Math.min(burst, budget + ((now - budgetAt) / 1000) * this.limits.audioBytesPerSecond);
        budgetAt = now;
        if (buf.byteLength > budget) return; // faster than anyone can speak: dropped
        budget -= buf.byteLength;
        const frame = decodeFrame(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
        if (frame?.kind === 'audio') me.pipeline?.push(frame.pcm);
        return;
      }
      let msg: ClientMessage;
      try {
        msg = JSON.parse(data.toString()) as ClientMessage;
      } catch {
        return;
      }
      // Anything from the network may be malformed: never let it throw in the main process.
      if (!msg || typeof msg !== 'object' || typeof (msg as { t?: unknown }).t !== 'string') return;
      if (msg.t === 'join') {
        if (me) return;
        if ((this.badJoins.get(address) ?? 0) >= this.limits.badJoins) return refuse('尝试次数过多，请让主持人重新开房间 / Demasiados intentos', 4029);
        if (typeof msg.token !== 'string' || msg.token !== this.token) {
          this.badJoins.set(address, (this.badJoins.get(address) ?? 0) + 1);
          return refuse('房间链接已失效，请重新扫码 / El enlace de la sala ha caducado', 4003);
        }
        if (this.participants.size >= this.limits.participants) return refuse(`房间人数已满（最多 ${this.limits.participants} 人）/ La sala está llena`, 4008);
        if (msg.v !== ROOM_PROTOCOL_VERSION) {
          ws.send(JSON.stringify({ t: 'error', message: '请刷新页面 / Recarga la página / Please reload', fatal: true } satisfies ServerMessage));
          ws.close(4004, 'version');
          return;
        }
        clearTimeout(timer);
        settle();
        const reqLang = typeof msg.lang === 'string' ? msg.lang : '';
        const code = LANGUAGES[reqLang] ? reqLang : reqLang.toLowerCase().startsWith('zh') ? 'zh-CN' : this.d.settings().languages.remote;
        me = { id: randomBytes(3).toString('hex'), ws, name: String(msg.name ?? '').trim().slice(0, 24) || (baseOf(code) === 'zh' ? '参会者' : baseOf(code) === 'en' ? 'Guest' : 'Invitado'), lang: code, talking: false, pipeline: null, generation: 0, alive: true };
        this.participants.set(me.id, me);
        const remote = this.d.settings().languages.remote;
        const history = this.d.session.segments().slice(-50);
        ws.send(
          JSON.stringify({
            t: 'welcome',
            id: me.id,
            room: {
              title: this.d.session.currentMeta?.title ?? '现场会议',
              languages: [
                { code: 'zh-CN', name: '中文' },
                { code: remote, name: lang(remote).nameNative },
              ],
            },
            history,
          } satisfies ServerMessage),
        );
        this.send('*', { t: 'peers', peers: this.peers() });
        void this.publishState();
        return;
      }
      if (!me) return;
      if (msg.t === 'talk') {
        const talkers = [...this.participants.values()].filter((p) => p.talking && p !== me).length;
        if (msg.on === true && !me.talking && talkers >= this.limits.talkers) {
          ws.send(JSON.stringify({ t: 'error', message: `同时说话的人太多了（最多 ${this.limits.talkers} 人），请等别人说完 / Espere su turno` } satisfies ServerMessage));
          return;
        }
        me.talking = msg.on === true;
        if (me.idleTimer) clearTimeout(me.idleTimer);
        if (!me.talking && me.pipeline) {
          const p = me;
          p.idleTimer = setTimeout(() => {
            if (p.talking || !p.pipeline) return;
            const old = p.pipeline;
            p.pipeline = null;
            void old.stop(4000);
          }, this.limits.idlePipelineMs);
        }
        if (me.talking && !me.pipeline) {
          try {
            me.pipeline = this.makePipeline(me);
          } catch (err) {
            me.talking = false;
            ws.send(JSON.stringify({ t: 'error', message: `电脑端没有配置好翻译服务：${err instanceof Error ? err.message : String(err)}` } satisfies ServerMessage));
            return;
          }
        }
        me.pipeline?.setGate(me.talking);
        this.send('*', { t: 'peers', peers: this.peers() });
        void this.publishState();
      } else if (msg.t === 'ping') ws.send(JSON.stringify({ t: 'pong' } satisfies ServerMessage));
    });
    ws.on('close', () => {
      clearTimeout(timer);
      settle();
      if (!me) return;
      const p = me;
      if (p.idleTimer) clearTimeout(p.idleTimer);
      this.participants.delete(p.id);
      void p.pipeline?.stop(4000);
      this.send('*', { t: 'peers', peers: this.peers() });
      void this.publishState();
    });
    ws.on('error', () => ws.close());
  }

  private makePipeline(p: Participant): DirectionPipeline {
    const s = this.d.settings();
    const providers = this.d.providers();
    // A Chinese speaker uses the "out" providers (zh → es); a Spanish speaker the "in" ones.
    const dir: Direction = baseOf(p.lang) === baseOf(s.languages.self) ? 'out' : 'in';
    const dstLang = otherLanguage(p.lang, s.languages.remote);
    // Sentence ids must never repeat within the meeting, or a later sentence replaces an earlier one.
    p.generation++;
    const pipeline = createDirection({
      dir: 'room',
      speaker: p.name,
      talk: this.talk,
      idPrefix: p.generation > 1 ? `room-${p.id}.${p.generation}` : `room-${p.id}`,
      srcLang: p.lang,
      dstLang,
      asr: providers.asr(dir),
      translator: providers.mt(dir),
      tts: providers.tts(dir),
      voice: (dir === 'out' ? s.out.voice : s.in.voice) || undefined,
      glossary: this.d.glossary,
      personal: this.d.personal ? () => this.d.personal!(baseOf(p.lang)) : undefined,
      interpretation: s.interpretation,
      clock: () => this.d.session.clock(),
      log: this.d.log.child(p.id),
    });
    pipeline.on('segment', (seg: TranscriptSegment) => {
      this.d.session.recordExternalSegment(seg);
      // Session listeners forward it to every phone (see start()).
    });
    pipeline.on('partial', ({ text }) => this.send('*', { t: 'partial', from: p.id, name: p.name, text }));
    pipeline.on('audio', ({ segmentId, samples, sampleRate }) => {
      this.sendTts(dstLang, segmentId, sampleRate, samples, p.id);
      if (this.hostListen && baseOf(dstLang) === baseOf(s.languages.self)) {
        this.d.toAudio({ type: 'tts', dir: 'in', segmentId, sampleRate, pcm: samples.slice().buffer });
      }
    });
    pipeline.on('audioEnd', ({ segmentId }) => {
      this.sendToLang(dstLang, { t: 'audioEnd', segmentId }, p.id);
      if (this.hostListen && baseOf(dstLang) === baseOf(s.languages.self)) this.d.toAudio({ type: 'ttsEnd', dir: 'in', segmentId });
    });
    pipeline.on('status', ({ state, message }) => {
      if (state === 'error' && message) this.send(p.id, { t: 'error', message });
    });
    void pipeline.start();
    return pipeline;
  }
}
