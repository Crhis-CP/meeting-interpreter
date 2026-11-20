import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, open, rename, rm, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { abortError, isAbortError } from '@core/events';
import { ProviderError } from '@core/providers/types';
import type { LangBase } from '@core/lang/languages';
import { MODEL_BASE_URLS, MODELS, modelsForLang, type ModelId, type ModelSpec, type WhisperModelId } from './models';

export type ModelStatus = 'missing' | 'ready';

/** One row of the model list in settings (`LocalModelStatus` in shared/ipc). */
export interface ModelStatusRow {
  id: string;
  name: string;
  ready: boolean;
  sizeMb: number;
}

export interface DownloadProgress {
  id: string;
  file: string;
  /** Bytes of this file on disk so far (includes a resumed part). */
  received: number;
  /** Expected bytes of this file. */
  total: number;
}

export interface ModelManagerOptions {
  /** Tried in order for every file. Default: Hugging Face, then hf-mirror.com. */
  baseUrls?: readonly string[];
  /** The manifest. Default: `MODELS`. */
  models?: Readonly<Record<string, ModelSpec>>;
  /** A connection that sends nothing for this long is dropped (and the next base URL tried). Default 30 s. */
  stallTimeoutMs?: number;
}

/** A finished file must be within these bounds of the manifest size (rejects HTML error pages, truncated files). */
function plausible(actual: number, expected: number): boolean {
  return actual >= expected * 0.5 && actual <= expected * 2;
}

function fileSize(path: string): number {
  try {
    const st = statSync(path);
    return st.isFile() ? st.size : -1;
  } catch {
    return -1;
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    const detail = cause instanceof Error && cause.message && !err.message.includes(cause.message) ? `（${cause.message}）` : '';
    return `${err.message}${detail}`;
  }
  return String(err);
}

/** SHA-256 of a file, streamed (models are hundreds of MB). */
export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

/** `<file>.sha256` records that a file was checked against the manifest. */
const markerOf = (path: string) => `${path}.sha256`;
function marked(path: string, sha256: string): boolean {
  try {
    return readFileSync(markerOf(path), 'utf8').trim() === sha256;
  } catch {
    return false;
  }
}

async function writeAll(fh: FileHandle, data: Uint8Array): Promise<void> {
  let off = 0;
  while (off < data.byteLength) {
    const { bytesWritten } = await fh.write(data, off, data.byteLength - off);
    off += bytesWritten;
  }
}

/**
 * Downloads and locates the offline recogniser's models. Files go to `<file>.part` first and are
 * renamed when complete, so a file with its final name is always whole. Interrupted downloads resume
 * (HTTP Range); a failing host falls back to the next base URL.
 */
export class ModelManager {
  private readonly fetchFn: typeof fetch;
  private readonly baseUrls: readonly string[];
  private readonly models: Readonly<Record<string, ModelSpec>>;
  private readonly stallMs: number;
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(
    readonly dir: string,
    fetchImpl: typeof fetch = fetch,
    opts: ModelManagerOptions = {},
  ) {
    this.fetchFn = ((input, init) => fetchImpl(input, init)) as typeof fetch;
    this.baseUrls = opts.baseUrls ?? MODEL_BASE_URLS;
    this.models = opts.models ?? MODELS;
    this.stallMs = opts.stallTimeoutMs ?? 30_000;
  }

  spec(id: string): ModelSpec {
    const spec = Object.prototype.hasOwnProperty.call(this.models, id) ? this.models[id] : undefined;
    if (!spec) throw new ProviderError(`未知的本机识别模型：${id}`, 'local');
    return spec;
  }

  pathOf(id: string, file: string): string {
    return join(this.dir, id, file);
  }

  /** Whole, and (when the manifest has a hash) checked against it. */
  private fileReady(id: string, f: { name: string; size: number; sha256?: string }): boolean {
    const path = this.pathOf(id, f.name);
    return plausible(fileSize(path), f.size) && (!f.sha256 || marked(path, f.sha256));
  }

  status(id: string): ModelStatus {
    const spec = this.spec(id);
    return spec.files.every((f) => this.fileReady(id, f)) ? 'ready' : 'missing';
  }

  /**
   * Checks files downloaded before hashes were recorded (once; no download): a match is marked as
   * checked, anything else is deleted so it is downloaded again.
   */
  async verifyExisting(ids: readonly string[]): Promise<void> {
    for (const id of new Set(ids)) {
      for (const f of this.spec(id).files) {
        const path = this.pathOf(id, f.name);
        if (!f.sha256 || this.fileReady(id, f) || !plausible(fileSize(path), f.size)) continue;
        if ((await sha256File(path)) === f.sha256) writeFileSync(markerOf(path), f.sha256);
        else await rm(path, { force: true });
      }
    }
  }

  /** Approximate bytes still to download for these models (for "需要下载约 240 MB"). */
  missingBytes(ids: readonly string[]): number {
    let n = 0;
    for (const id of new Set(ids)) {
      for (const f of this.spec(id).files) {
        if (!plausible(fileSize(this.pathOf(id, f.name)), f.size)) n += f.size;
      }
    }
    return n;
  }

  /** The models used with this Spanish model choice (VAD, Chinese, Spanish) and whether each is downloaded. */
  statusList(esModel: WhisperModelId): ModelStatusRow[] {
    const ids: ModelId[] = ['silero-vad', 'sensevoice', esModel];
    return ids.map((id) => {
      const spec = this.spec(id);
      const bytes = spec.files.reduce((n, f) => n + f.size, 0);
      return { id, name: spec.label, ready: this.status(id) === 'ready', sizeMb: Math.max(1, Math.round(bytes / 1_000_000)) };
    });
  }

  /** Downloads what recognising a language needs: zh → VAD + SenseVoice; es → VAD + the chosen Whisper model. */
  ensureFor(base: LangBase, esModel: WhisperModelId, onProgress?: (p: DownloadProgress) => void, signal?: AbortSignal): Promise<void> {
    return this.ensure(modelsForLang(base, esModel), onProgress, signal);
  }

  /** Downloads whatever is missing, one file at a time. Rejects with a ProviderError (Chinese message) or an AbortError. */
  async ensure(ids: readonly string[], onProgress?: (p: DownloadProgress) => void, signal?: AbortSignal): Promise<void> {
    for (const id of ids) {
      const spec = this.spec(id);
      for (const f of spec.files) {
        const dest = this.pathOf(id, f.name);
        for (;;) {
          if (signal?.aborted) throw abortError();
          if (this.fileReady(id, f)) break;
          if (f.sha256 && plausible(fileSize(dest), f.size)) {
            await this.verifyExisting([id]);
            if (this.fileReady(id, f)) break;
          }
          let job = this.inflight.get(dest);
          const mine = !job;
          if (!job) {
            job = this.download(id, f.name, f.url, f.size, dest, onProgress, signal, f.sha256).finally(() => this.inflight.delete(dest));
            this.inflight.set(dest, job);
          }
          try {
            await job;
            break;
          } catch (err) {
            // Another caller's download was cancelled: try again ourselves.
            if (!mine && isAbortError(err) && !signal?.aborted) continue;
            throw err;
          }
        }
      }
    }
  }

  private async download(
    id: string,
    name: string,
    urlPath: string,
    expected: number,
    dest: string,
    onProgress: ((p: DownloadProgress) => void) | undefined,
    signal: AbortSignal | undefined,
    sha256?: string,
  ): Promise<void> {
    await mkdir(dirname(dest), { recursive: true });
    const part = `${dest}.part`;
    const failures: string[] = [];
    for (const base of this.baseUrls) {
      const url = `${base.replace(/\/+$/, '')}/${urlPath}`;
      try {
        await this.fetchToFile(url, part, expected, (received, total) => onProgress?.({ id, file: name, received, total }), signal);
        const size = fileSize(part);
        if (!plausible(size, expected)) {
          await rm(part, { force: true });
          throw new Error(`文件大小不对（${size} 字节，应约为 ${expected} 字节）`);
        }
        if (sha256 && (await sha256File(part)) !== sha256) {
          await rm(part, { force: true });
          throw new Error('文件校验不通过（内容和官方发布的不一致），已丢弃');
        }
        await rename(part, dest);
        if (sha256) writeFileSync(markerOf(dest), sha256);
        return;
      } catch (err) {
        if (signal?.aborted) throw abortError();
        let host = base;
        try {
          host = new URL(base).host;
        } catch {
          // keep the raw base
        }
        failures.push(`${host}：${describe(err)}`);
      }
    }
    throw new ProviderError(`本机识别模型 ${id} 的文件 ${name} 下载失败（${failures.join('；')}）。请检查网络后重试，已下载的部分会接着下载。`, 'local', {
      retryable: true,
    });
  }

  /** Streams `url` into `part`, resuming from what `part` already holds when the server allows it. */
  private async fetchToFile(
    url: string,
    part: string,
    expected: number,
    progress: (received: number, total: number) => void,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    let offset = Math.max(0, fileSize(part));
    if (offset > expected * 2) {
      await rm(part, { force: true });
      offset = 0;
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const ac = new AbortController();
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      // Cancel the body too: not every fetch implementation ends a pending read when its signal aborts.
      const stop = () => {
        ac.abort();
        reader?.cancel().catch(() => undefined);
      };
      signal?.addEventListener('abort', stop, { once: true });
      let stalled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          stalled = true;
          stop();
        }, this.stallMs);
      };
      const interrupted = () => {
        if (signal?.aborted) return abortError();
        return stalled ? new Error('连接超时') : null;
      };
      let fh: FileHandle | undefined;
      try {
        arm();
        const headers: Record<string, string> = {};
        if (offset > 0) headers.Range = `bytes=${offset}-`;
        const res = await this.fetchFn(url, { headers, signal: ac.signal, redirect: 'follow' });
        if (res.status === 416 && offset > 0) {
          // What we hold does not fit the file on the server: start over.
          await res.body?.cancel().catch(() => undefined);
          await rm(part, { force: true });
          offset = 0;
          continue;
        }
        if (!res.ok || ac.signal.aborted) {
          await res.body?.cancel().catch(() => undefined);
          throw interrupted() ?? new Error(`HTTP ${res.status}`);
        }
        const append = offset > 0 && res.status === 206;
        if (!append) offset = 0;
        const length = Number(res.headers.get('content-length') ?? '');
        const known = Number.isFinite(length) && length > 0;
        const total = known ? offset + length : Math.max(expected, offset);
        fh = await open(part, append ? 'a' : 'w');
        let received = offset;
        progress(received, total);
        if (res.body) {
          reader = res.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            arm();
            await writeAll(fh, value);
            received += value.byteLength;
            progress(received, Math.max(total, received));
          }
        }
        const handle = fh;
        fh = undefined;
        await handle.close();
        const stopped = interrupted();
        if (stopped) throw stopped;
        if (known && received !== total) throw new Error(`下载不完整（${received}/${total} 字节）`);
        return;
      } catch (err) {
        throw interrupted() ?? err;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', stop);
        await fh?.close().catch(() => undefined);
      }
    }
    throw new Error('服务器拒绝了续传请求');
  }
}
