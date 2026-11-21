import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectStorage, type ModelSource } from '../../src/main/storage';

/** A model source over a few fake models: id → [bytes on disk, total, ready, downloading]. */
function source(models: Record<string, [number, number, boolean, boolean?]>): ModelSource {
  return {
    ids: () => Object.keys(models),
    spec: (id) => ({ label: `label:${id}` }),
    totalBytes: (id) => models[id]![1],
    bytesOnDisk: (id) => models[id]![0],
    status: (id) => (models[id]![2] ? 'ready' : 'missing'),
    downloading: (id) => !!models[id]![3],
  };
}

function file(path: string, bytes: number): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, new Uint8Array(bytes));
}

describe('存储空间', () => {
  it('lists what is on disk with its state, what the settings use, and what downloads', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mi-store-'));
    const recordsDir = mkdtempSync(join(tmpdir(), 'mi-rec-'));
    file(join(dataDir, 'IndexedDB', 'mi-app_0.indexeddb.leveldb', '000003.log'), 5000);
    file(join(dataDir, 'bin', 'cloudflared'), 300);
    file(join(dataDir, 'app.log'), 120);
    file(join(dataDir, 'Code Cache', 'js', 'x'), 70);
    file(join(recordsDir, '2026-11-21 会议', 'audio', 'mix.m4a'), 900);

    const info = collectStorage({
      dataDir,
      recordsDir,
      asr: source({ 'silero-vad': [10, 10, true], sensevoice: [400, 1000, false, true], 'whisper-small': [0, 2000, false], 'whisper-base': [800, 800, true] }),
      ai: source({ 'hy-mt2-1.8b': [0, 1100, false], 'hy-mt2-7b': [0, 4600, false] }),
      inUse: new Set(['silero-vad', 'sensevoice', 'whisper-small', 'hy-mt2-1.8b']),
      names: { sensevoice: '中文识别' },
      onlyIfPresent: new Set(['hy-mt2-7b']),
      offlineMt: { totalBytes: 140_000, inUse: false, downloading: false },
    });
    const by = Object.fromEntries(info.items.map((i) => [i.id, i]));
    expect(by['silero-vad']).toMatchObject({ state: 'ready', inUse: true, bytes: 10 });
    expect(by.sensevoice).toMatchObject({ name: '中文识别', state: 'downloading', bytes: 400, totalBytes: 1000 });
    // Needed but not downloaded yet: listed (so it can be downloaded from here)…
    expect(by['whisper-small']).toMatchObject({ state: 'missing', inUse: true });
    // …a downloaded model the settings no longer use: listed, so it can be deleted.
    expect(by['whisper-base']).toMatchObject({ state: 'ready', inUse: false });
    expect(by['hy-mt2-1.8b']).toMatchObject({ state: 'missing', inUse: true });
    expect(by['hy-mt2-7b']).toBeUndefined(); // not offered on this computer and not on disk
    expect(by['offline-mt']).toMatchObject({ kind: 'mt', state: 'partial', bytes: 5000 });
    expect(by.tools).toMatchObject({ bytes: 300 });
    expect(by.logs).toMatchObject({ bytes: 120 });
    expect(by.cache).toMatchObject({ bytes: 70 });
    expect(info.recordsBytes).toBe(900);
    expect(info.dataBytes).toBe(5000 + 300 + 120 + 70);
  });

  it('an empty data folder lists only what the settings need', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mi-store-'));
    const info = collectStorage({
      dataDir,
      recordsDir: join(dataDir, 'none'),
      asr: source({ sensevoice: [0, 1000, false] }),
      ai: source({}),
      inUse: new Set(),
      offlineMt: { totalBytes: 1, inUse: false, downloading: false },
    });
    expect(info.items).toEqual([]);
    expect(info.recordsBytes).toBe(0);
  });
});
