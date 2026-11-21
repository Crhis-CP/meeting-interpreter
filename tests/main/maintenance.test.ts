import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanupData, rotateLog } from '../../src/main/maintenance';

const DAY = 24 * 60 * 60 * 1000;
function file(path: string, bytes = 10, ageDays = 0): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, new Uint8Array(bytes));
  const t = (Date.now() - ageDays * DAY) / 1000;
  utimesSync(path, t, t);
  return path;
}

describe('cleaning the data folder', () => {
  it('removes only week-old interrupted downloads, listed obsolete files and old driver installers', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mi-clean-'));
    const tmp = mkdtempSync(join(tmpdir(), 'mi-tmp-'));
    const oldPart = file(join(dataDir, 'models', 'sensevoice', 'model.int8.onnx.part'), 500, 8);
    const freshPart = file(join(dataDir, 'models', 'hy-mt2-1.8b', 'model.gguf.part'), 500, 1); // may still resume
    const model = file(join(dataDir, 'models', 'sensevoice', 'tokens.txt'), 50, 30);
    const unknown = file(join(dataDir, 'models', 'some-newer-model', 'x.bin'), 50, 30); // from a newer version: kept
    const obsolete = file(join(dataDir, 'models', 'whisper-tiny', 'tiny.onnx'), 70, 30);
    const mine = file(join(dataDir, 'notes.txt'), 5, 90); // the user's own: kept
    const driver = file(join(tmp, 'mi-driver-abc', 'BlackHole2ch.pkg'), 100, 2);
    const twoDaysAgo = (Date.now() - 2 * DAY) / 1000;
    utimesSync(join(tmp, 'mi-driver-abc'), twoDaysAgo, twoDaysAgo); // the folder was written then too
    const driverNow = file(join(tmp, 'mi-driver-new', 'VBCABLE.zip'), 100, 0); // installing right now
    const other = file(join(tmp, 'someone-else', 'x'), 100, 9);

    const r = cleanupData({ dataDir, tmpDir: tmp, obsolete: ['models/whisper-tiny', '../outside', '/etc'] });
    expect(existsSync(oldPart)).toBe(false);
    expect(existsSync(join(dataDir, 'models', 'whisper-tiny'))).toBe(false);
    expect(existsSync(join(tmp, 'mi-driver-abc'))).toBe(false);
    for (const kept of [freshPart, model, unknown, mine, driverNow, other]) expect(existsSync(kept), kept).toBe(true);
    expect(r.bytes).toBe(500 + 70 + 100);
    expect(obsolete).toBeTruthy();
    expect(driver).toBeTruthy();
  });
});

describe('the log', () => {
  it('rotates once it is full, keeping one older copy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mi-log-'));
    const log = join(dir, 'app.log');
    writeFileSync(log, 'first\n');
    expect(rotateLog(log, 100)).toBe(false);
    writeFileSync(log, 'x'.repeat(200));
    expect(rotateLog(log, 100)).toBe(true);
    expect(existsSync(log)).toBe(false);
    expect(readFileSync(join(dir, 'app.1.log'), 'utf8')).toHaveLength(200);
    expect(rotateLog(log, 100)).toBe(false); // nothing to rotate
  });
});
