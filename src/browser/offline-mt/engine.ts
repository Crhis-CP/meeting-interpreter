/**
 * Offline translation with Mozilla's models (the engine Firefox uses), shared by the desktop app
 * (hidden audio window), the Chrome extension (offscreen page) and the phone app (WebView).
 * Models are downloaded once (our GitHub mirror first, Mozilla second), checked against SHA-256,
 * and kept in IndexedDB; translation then needs no network and no key.
 */
import manifestJson from './manifest.json';

export type MtPair = 'zh-en' | 'en-zh' | 'es-en' | 'en-es';
type Base = 'zh' | 'es' | 'en';

interface ManifestFile {
  pair: MtPair;
  role: 'model' | 'lex' | 'vocab' | 'srcvocab' | 'trgvocab';
  name: string;
  size: number;
  sha256: string;
  upstream: string;
}
const manifest = manifestJson as { version: number; mirror: string; files: ManifestFile[] };

export interface MtProgress {
  received: number;
  total: number;
  file: string;
}

/** Which models a direction needs; Chinese ⇄ Spanish goes through English. */
export function routeFor(from: Base, to: Base): MtPair[] {
  if (from === to) return [];
  if (from === 'en' || to === 'en') return [`${from}-${to}` as MtPair];
  return [`${from}-en` as MtPair, `en-${to}` as MtPair];
}

export const OFFLINE_MT_BYTES = manifest.files.reduce((n, f) => n + f.size, 0);

// ------------------------------------------------------------------ storage (IndexedDB)

const DB = 'meeting-interpreter-mt';
const STORE = 'files';

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function idbGet(key: string): Promise<ArrayBuffer | null> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const r = db.transaction(STORE).objectStore(STORE).get(key);
    r.onsuccess = () => resolve((r.result as ArrayBuffer | undefined) ?? null);
    r.onerror = () => reject(r.error);
  });
}

async function idbPut(key: string, value: ArrayBuffer): Promise<void> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbKeys(): Promise<Set<string>> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const r = db.transaction(STORE).objectStore(STORE).getAllKeys();
    r.onsuccess = () => resolve(new Set(r.result.map(String)));
    r.onerror = () => reject(r.error);
  });
}

async function idbDelete(keys: Iterable<string>): Promise<void> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const k of keys) store.delete(k);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

const storeKey = (f: ManifestFile) => `${f.name}:${f.sha256}`;

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function gunzip(buf: ArrayBuffer): Promise<ArrayBuffer> {
  return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}

// ------------------------------------------------------------------ engine

export interface OfflineMtOptions {
  /** URLs of the worker script, the engine glue and the wasm binary. */
  workerUrl: string;
  glueUrl: string;
  wasmUrl: string;
  fetchImpl?: typeof fetch;
}

export class OfflineMt {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private started: Promise<void> | null = null;

  constructor(private readonly o: OfflineMtOptions) {}

  /** Bytes still to download (0 = ready to use offline). */
  async missingBytes(): Promise<number> {
    const have = await idbKeys();
    return manifest.files.filter((f) => !have.has(storeKey(f))).reduce((n, f) => n + f.size, 0);
  }

  /** Downloads whatever is missing, from our mirror first and Mozilla second, verifying each file. */
  async download(onProgress?: (p: MtProgress) => void): Promise<void> {
    const have = await idbKeys();
    const todo = manifest.files.filter((f) => !have.has(storeKey(f)));
    const total = todo.reduce((n, f) => n + f.size, 0);
    let done = 0;
    for (const f of todo) {
      let lastErr: unknown = null;
      for (const url of [manifest.mirror + f.name, f.upstream]) {
        try {
          const buf = await this.fetchWithProgress(url, (n) => onProgress?.({ received: done + n, total, file: f.name }));
          if ((await sha256Hex(buf)) !== f.sha256) throw new Error(`校验失败：${f.name}`);
          await idbPut(storeKey(f), buf);
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
        }
      }
      if (lastErr) throw new Error(`离线翻译模型下载失败（${f.name}）：${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
      done += f.size;
      onProgress?.({ received: done, total, file: f.name });
    }
    // A newer version replaced some files: the old copies are not needed any more.
    await this.prune();
  }

  /** Removes stored files that are not part of the current models (left from earlier versions). Returns how many. */
  async prune(): Promise<number> {
    const want = new Set(manifest.files.map(storeKey));
    const stale = [...(await idbKeys())].filter((k) => !want.has(k));
    if (stale.length) await idbDelete(stale);
    return stale.length;
  }

  /** Deletes the stored models (downloaded again when needed). */
  async clear(): Promise<void> {
    this.stop();
    await idbDelete(await idbKeys());
  }

  private async fetchWithProgress(url: string, onBytes: (n: number) => void): Promise<ArrayBuffer> {
    const res = await (this.o.fetchImpl ?? fetch)(url);
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    const parts: Uint8Array[] = [];
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      n += value.length;
      onBytes(n);
    }
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out.buffer;
  }

  private call<T>(op: string, args: unknown, transfer: Transferable[] = []): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker!.postMessage({ id, op, args }, transfer);
    });
  }

  /** Loads the engine and every downloaded model (about 2 s, once). */
  start(): Promise<void> {
    this.started ??= (async () => {
      if (await this.missingBytes()) throw new Error('离线翻译模型还没有下载');
      const w = new Worker(this.o.workerUrl);
      this.worker = w;
      w.onmessage = ({ data }: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
        const p = this.pending.get(data.id);
        if (!p) return;
        this.pending.delete(data.id);
        if (data.error) p.reject(new Error(data.error));
        else p.resolve(data.result);
      };
      const wasm = await (await (this.o.fetchImpl ?? fetch)(this.o.wasmUrl)).arrayBuffer();
      await this.call('init', { wasm, glueUrl: this.o.glueUrl }, [wasm]);
      for (const pair of ['zh-en', 'en-zh', 'es-en', 'en-es'] as MtPair[]) {
        const files: Record<string, ArrayBuffer> = {};
        for (const f of manifest.files.filter((x) => x.pair === pair)) {
          const gz = await idbGet(storeKey(f));
          if (!gz) throw new Error(`缺少模型文件 ${f.name}`);
          files[f.role] = await gunzip(gz);
        }
        await this.call('load', { pair, files }, Object.values(files));
      }
    })();
    this.started.catch(() => (this.started = null));
    return this.started;
  }

  async translate(text: string, from: Base, to: Base): Promise<string> {
    const route = routeFor(from, to);
    if (!route.length || !text.trim()) return text;
    await this.start();
    return this.call<string>('translate', { route, text });
  }

  stop(): void {
    this.worker?.terminate();
    this.worker = null;
    this.started = null;
    for (const p of this.pending.values()) p.reject(new Error('stopped'));
    this.pending.clear();
  }
}
