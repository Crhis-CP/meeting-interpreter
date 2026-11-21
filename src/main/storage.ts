/**
 * What the app keeps on this computer, for the "存储空间" page: every model with its size and
 * whether it is used, downloading or only half there; tools, logs and caches; the meeting records
 * (in their own folder). Pure apart from reading folder sizes, so it is tested with fakes.
 */
import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { StorageInfo, StorageItem } from '../shared/ipc';
import { dirBytes } from './providers/local-asr/model-manager';

/** What a model manager tells about its models (ModelManager fits). */
export interface ModelSource {
  ids(): string[];
  spec(id: string): { label?: string };
  totalBytes(id: string): number;
  bytesOnDisk(id: string): number;
  status(id: string): 'ready' | 'missing';
  downloading(id: string): boolean;
}

export interface StorageDeps {
  dataDir: string;
  recordsDir: string;
  asr: ModelSource;
  ai: ModelSource;
  /** Models the current settings use. */
  inUse: Set<string>;
  /** Names to show (fallback: the model's label, then its id). */
  names?: Record<string, string>;
  /** Models that are not offered here and are listed only when on disk (e.g. the 7B model on a small computer). */
  onlyIfPresent?: Set<string>;
  offlineMt: { totalBytes: number; inUse: boolean; downloading: boolean };
}

/** Chromium's own caches in the data folder (safe to clear; rebuilt as needed). */
export const CACHE_DIRS = ['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'Shared Dictionary', join('Service Worker', 'CacheStorage')];

function modelItems(src: ModelSource, kind: 'asr' | 'ai', d: StorageDeps): StorageItem[] {
  const items: StorageItem[] = [];
  for (const id of src.ids()) {
    const bytes = src.bytesOnDisk(id);
    const inUse = d.inUse.has(id);
    const downloading = src.downloading(id);
    if (!bytes && !downloading && (!inUse || d.onlyIfPresent?.has(id))) continue;
    const ready = src.status(id) === 'ready';
    items.push({
      id,
      kind,
      name: d.names?.[id] ?? src.spec(id).label ?? id,
      bytes,
      totalBytes: src.totalBytes(id),
      state: downloading ? 'downloading' : ready ? 'ready' : bytes ? 'partial' : 'missing',
      inUse,
    });
  }
  return items;
}

export function collectStorage(d: StorageDeps): StorageInfo {
  const items: StorageItem[] = [...modelItems(d.asr, 'asr', d), ...modelItems(d.ai, 'ai', d)];
  // Offline translation lives in the app's browser storage (IndexedDB) inside the data folder.
  const mtBytes = dirBytes(join(d.dataDir, 'IndexedDB'));
  if (mtBytes || d.offlineMt.inUse || d.offlineMt.downloading) {
    const ready = mtBytes >= d.offlineMt.totalBytes * 0.9;
    items.push({ id: 'offline-mt', kind: 'mt', name: d.names?.['offline-mt'] ?? '离线翻译（草稿）', bytes: mtBytes, totalBytes: d.offlineMt.totalBytes, state: d.offlineMt.downloading ? 'downloading' : ready ? 'ready' : mtBytes ? 'partial' : 'missing', inUse: d.offlineMt.inUse });
  }
  const tool = dirBytes(join(d.dataDir, 'bin'));
  if (tool) items.push({ id: 'tools', kind: 'tool', name: '公网链接工具（cloudflared）', bytes: tool, totalBytes: null, state: 'ready', inUse: false });
  const logs = ['app.log', 'app.1.log'].reduce((n, f) => n + dirBytesOfFile(join(d.dataDir, f)), 0);
  if (logs) items.push({ id: 'logs', kind: 'logs', name: '日志', bytes: logs, totalBytes: null, state: 'ready', inUse: true });
  const cache = CACHE_DIRS.reduce((n, c) => n + dirBytes(join(d.dataDir, c)), 0);
  if (cache) items.push({ id: 'cache', kind: 'cache', name: '缓存', bytes: cache, totalBytes: null, state: 'ready', inUse: false });
  return {
    dataDir: d.dataDir,
    recordsDir: d.recordsDir,
    dataBytes: dirBytes(d.dataDir),
    recordsBytes: dirBytes(d.recordsDir),
    items,
  };
}

function dirBytesOfFile(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
