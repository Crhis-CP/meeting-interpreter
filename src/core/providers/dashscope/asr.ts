import { ASR_RATE, int16ToBytes } from '../../audio/pcm';
import { Emitter } from '../../events';
import { lang } from '../../lang/languages';
import type { Logger } from '../../log';
import { uuid } from '../http';
import { ProviderError, type AsrEvents, type AsrSession, type AsrStartOptions, type ProviderContext, type StreamingAsr, type WebSocketLike } from '../types';
import { DASHSCOPE_DEFAULTS, authHeaders, dashscopeError, dashscopeHost, errorText, resolveModel, type DashscopeConfig, type DashscopeFailure } from './common';

const START_TIMEOUT_MS = 10_000;
const FINISH_TIMEOUT_MS = 5_000;
/** 100 ms of 16 kHz mono PCM (3200 bytes), the packet size DashScope recommends. Larger pushes are split. */
const PACKET_SAMPLES = ASR_RATE / 10;
const MAX_VOCABULARY = 500;
const VOCABULARY_WEIGHT = 4;

/**
 * Inline hot words (`vocabulary`, qwen-audio models only): trimmed, deduplicated, at most 500, and
 * within DashScope's per-term limits — at most 15 characters for terms with non-ASCII characters,
 * at most 7 words for pure-ASCII terms. Longer terms are skipped rather than failing the task.
 */
export function dashscopeVocabulary(hotwords: readonly string[]): Record<string, number> {
  const terms = new Map<string, number>();
  for (const raw of hotwords) {
    if (terms.size >= MAX_VOCABULARY) break;
    const term = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
    if (!term || terms.has(term)) continue;
    const tooLong = /^[\x00-\x7f]+$/.test(term) ? term.split(' ').length > 7 : [...term].length > 15;
    if (tooLong) continue;
    terms.set(term, VOCABULARY_WEIGHT);
  }
  return Object.fromEntries(terms);
}

interface DuplexHeader {
  event?: string;
  task_id?: string;
  error_code?: string;
  error_message?: string;
}

interface Sentence {
  sentence_id?: number;
  begin_time?: number | null;
  end_time?: number | null;
  text?: string;
  sentence_end?: boolean;
  heartbeat?: boolean;
}

interface DuplexMessage {
  header?: DuplexHeader;
  payload?: { output?: { sentence?: Sentence } };
}

type State = 'connecting' | 'running' | 'finishing' | 'closed';

/**
 * Real-time recognition over DashScope's duplex task protocol (`/api-ws/v1/inference`):
 * run-task → task-started → binary PCM → finish-task → task-finished / task-failed.
 */
export class DashscopeAsr implements StreamingAsr {
  readonly id = 'dashscope';

  constructor(
    private readonly cfg: DashscopeConfig,
    private readonly ctx: ProviderContext,
  ) {}

  get model(): string {
    return resolveModel(this.cfg.asrModel, DASHSCOPE_DEFAULTS.asrModel);
  }

  get url(): string {
    return `wss://${dashscopeHost(this.cfg)}/api-ws/v1/inference`;
  }

  /** Resolves once the server answered `task-started`. */
  start(opts: AsrStartOptions): Promise<AsrSession> {
    return new DashscopeAsrSession(this.cfg, this.ctx, opts, this.model, this.url).open();
  }
}

class DashscopeAsrSession implements AsrSession {
  readonly events = new Emitter<AsrEvents>();
  private readonly taskId = uuid();
  private readonly log: Logger;
  private ws: WebSocketLike | null = null;
  private state: State = 'connecting';
  private runTaskSent = false;
  private transportError = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private errorTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingStart: { resolve: (s: AsrSession) => void; reject: (e: Error) => void } | null = null;
  private ended: Promise<void> | null = null;
  private resolveEnded: (() => void) | null = null;

  constructor(
    private readonly cfg: DashscopeConfig,
    private readonly ctx: ProviderContext,
    private readonly opts: AsrStartOptions,
    private readonly model: string,
    private readonly url: string,
  ) {
    this.log = ctx.log.child('dashscope-asr');
  }

  open(): Promise<AsrSession> {
    return new Promise<AsrSession>((resolve, reject) => {
      this.pendingStart = { resolve, reject };
      let headers: Record<string, string>;
      let runTask: string;
      try {
        headers = authHeaders(this.cfg);
        runTask = JSON.stringify(this.runTask());
      } catch (err) {
        this.failStart(err instanceof ProviderError ? err : this.error({ message: errorText(err) }));
        return;
      }
      this.timer = setTimeout(() => this.failStart(this.error({ message: `等待 task-started 超时（${START_TIMEOUT_MS / 1000} 秒）` })), START_TIMEOUT_MS);
      let ws: WebSocketLike;
      try {
        ws = this.ctx.openWebSocket(this.url, { headers });
      } catch (err) {
        this.failStart(this.error({ message: errorText(err) }));
        return;
      }
      this.ws = ws;
      ws.onopen = () => this.onOpen(runTask);
      ws.onmessage = (data) => this.onMessage(data);
      ws.onerror = (err) => this.onTransportError(err);
      ws.onclose = (code, reason) => this.onClose(code, reason);
      if (ws.readyState === 1) this.onOpen(runTask);
    });
  }

  push(pcm: Int16Array): void {
    if (this.state !== 'running') return;
    for (let i = 0; i < pcm.length; i += PACKET_SAMPLES) {
      if (!this.send(int16ToBytes(pcm.subarray(i, i + PACKET_SAMPLES)))) return;
    }
  }

  end(): Promise<void> {
    if (this.ended) return this.ended;
    if (this.state !== 'running') {
      this.close();
      this.ended = Promise.resolve();
      return this.ended;
    }
    this.ended = new Promise<void>((resolve) => (this.resolveEnded = resolve));
    this.state = 'finishing';
    const finishTask = { header: { action: 'finish-task', task_id: this.taskId, streaming: 'duplex' }, payload: { input: {} } };
    if (!this.send(JSON.stringify(finishTask))) {
      this.finish('finished');
    } else {
      this.timer = setTimeout(() => {
        this.log.warn(`no task-finished within ${FINISH_TIMEOUT_MS / 1000} s, closing`);
        this.finish('finish-task timed out');
      }, FINISH_TIMEOUT_MS);
    }
    return this.ended;
  }

  close(): void {
    this.finish('closed by client');
  }

  // ---------------------------------------------------------------- protocol

  private runTask(): object {
    const parameters: Record<string, unknown> = {
      format: 'pcm',
      sample_rate: ASR_RATE,
      language_hints: [...new Set([this.opts.lang, ...(this.opts.alsoLangs ?? [])].map((l) => lang(l).codes.dashscope))],
      max_sentence_silence: 800,
      heartbeat: true,
    };
    if (this.model.toLowerCase().startsWith('qwen-audio')) {
      const vocabulary = dashscopeVocabulary(this.opts.hotwords ?? []);
      if (Object.keys(vocabulary).length) parameters.vocabulary = vocabulary;
    }
    return {
      header: { action: 'run-task', task_id: this.taskId, streaming: 'duplex' },
      payload: { task_group: 'audio', task: 'asr', function: 'recognition', model: this.model, parameters, input: {} },
    };
  }

  private onOpen(runTask: string): void {
    if (this.state !== 'connecting' || this.runTaskSent) return;
    this.runTaskSent = true;
    if (!this.send(runTask)) this.failStart(this.error({ message: '发送 run-task 失败，连接已断开' }));
  }

  private onMessage(data: string | Uint8Array): void {
    if (this.state === 'closed' || typeof data !== 'string') return;
    let msg: DuplexMessage;
    try {
      msg = JSON.parse(data) as DuplexMessage;
    } catch {
      this.log.warn('ignoring a non-JSON message');
      return;
    }
    const header = msg.header ?? {};
    switch (header.event) {
      case 'task-started':
        this.onStarted();
        break;
      case 'result-generated':
        this.onResult(msg.payload?.output?.sentence);
        break;
      case 'task-finished':
        if (this.state === 'connecting') this.failStart(this.error({ message: '任务在开始前就结束了（task-finished）' }));
        else this.finish('task-finished');
        break;
      case 'task-failed': {
        const error = this.error({ code: header.error_code, message: header.error_message });
        if (this.state === 'connecting') this.failStart(error);
        else this.finish(`task-failed ${header.error_code ?? ''}`.trim(), error);
        break;
      }
      default:
        break;
    }
  }

  private onStarted(): void {
    if (this.state !== 'connecting') return;
    this.state = 'running';
    this.clearTimers();
    this.log.info(`task started (${this.model}, ${this.opts.lang})`);
    const pending = this.pendingStart;
    this.pendingStart = null;
    pending?.resolve(this);
  }

  private onResult(sentence: Sentence | undefined): void {
    if (this.state !== 'running' && this.state !== 'finishing') return;
    if (!sentence || sentence.heartbeat === true) return;
    const text = typeof sentence.text === 'string' ? sentence.text.trim() : '';
    if (sentence.sentence_end !== true) {
      this.events.emit('partial', { text });
      return;
    }
    if (!text) return;
    const final: AsrEvents['final'] = { text };
    if (typeof sentence.begin_time === 'number') final.start = sentence.begin_time / 1000;
    if (typeof sentence.end_time === 'number') final.end = sentence.end_time / 1000;
    this.events.emit('final', final);
  }

  private onTransportError(err: Error): void {
    this.transportError = errorText(err);
    this.log.warn('socket error', this.transportError);
    if (this.state === 'closed' || this.errorTimer) return;
    // A close event normally follows at once and may carry more detail; fall back if it never comes.
    this.errorTimer = setTimeout(() => {
      this.errorTimer = null;
      this.onClose(1006, '');
    }, 100);
  }

  private onClose(code: number, reason: string): void {
    if (this.state === 'closed') return;
    const failure: DashscopeFailure = { closeCode: code, closeReason: reason, message: this.transportError || undefined };
    if (this.state === 'connecting') {
      this.failStart(this.error(failure));
    } else if (this.state === 'finishing') {
      this.finish(`socket closed (${code})`);
    } else {
      const error = this.error(failure);
      this.log.warn('socket closed unexpectedly', error.message);
      this.finish(`socket closed (${code})`, error);
    }
  }

  // ---------------------------------------------------------------- lifecycle

  private failStart(error: ProviderError): void {
    if (this.state !== 'connecting') return;
    this.state = 'closed';
    this.teardown();
    this.log.warn('start failed', error.message);
    const pending = this.pendingStart;
    this.pendingStart = null;
    pending?.reject(error);
  }

  /** Ends the session once: optional fatal error, then `closed`, then settles `end()`. */
  private finish(reason: string, error?: ProviderError): void {
    if (this.state === 'closed') return;
    if (this.state === 'connecting') {
      this.failStart(error ?? this.error({ message: reason }));
      return;
    }
    this.state = 'closed';
    this.teardown();
    if (error) this.events.emit('error', { error, fatal: true });
    this.events.emit('closed', { reason });
    const resolve = this.resolveEnded;
    this.resolveEnded = null;
    resolve?.();
  }

  private send(data: string | Uint8Array): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return false;
    try {
      ws.send(data);
      return true;
    } catch (err) {
      this.log.warn('send failed', errorText(err));
      return false;
    }
  }

  private clearTimers(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.errorTimer) clearTimeout(this.errorTimer);
    this.timer = null;
    this.errorTimer = null;
  }

  private teardown(): void {
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.onopen = undefined;
    ws.onmessage = undefined;
    ws.onerror = undefined;
    ws.onclose = undefined;
    try {
      if (ws.readyState !== 3) ws.close(1000, 'done');
    } catch (err) {
      this.log.debug('close failed', errorText(err));
    }
  }

  private error(failure: DashscopeFailure): ProviderError {
    return dashscopeError('asr', { model: this.model, ...failure }, this.cfg);
  }
}
