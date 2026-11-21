import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SecretStore, type SafeStorageLike } from '../../src/main/stores/secret-store';

/** Like Electron's safeStorage on Windows/Linux: unavailable until the app is ready. */
function keychain(): SafeStorageLike & { ready: boolean } {
  return {
    ready: false,
    isEncryptionAvailable() {
      return this.ready;
    },
    encryptString: (plain) => Buffer.from(`enc:${plain}`),
    decryptString: (b) => b.toString().replace(/^enc:/, ''),
  };
}

describe('SecretStore', () => {
  it('keys saved encrypted survive a restart where the store is created before the keychain is ready', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mi-secrets-'));
    const k1 = keychain();
    k1.ready = true;
    const first = new SecretStore(dir, k1);
    first.set('dashscope', 'sk-one');
    first.set('llm', 'zp-two');

    // Restart: the store is created before app.whenReady (keychain not yet available)...
    const k2 = keychain();
    const second = new SecretStore(dir, k2);
    // ...and used after it.
    k2.ready = true;
    expect(second.all()).toEqual({ dashscope: 'sk-one', llm: 'zp-two' });
    second.set('deepl', 'dl-three');
    expect(new SecretStore(dir, k2).all()).toEqual({ dashscope: 'sk-one', llm: 'zp-two', deepl: 'dl-three' });
  });

  it('never overwrites encrypted keys it cannot read: saving is refused instead', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mi-secrets-'));
    const k = keychain();
    k.ready = true;
    new SecretStore(dir, k).set('dashscope', 'sk-one');
    const before = readFileSync(join(dir, 'secrets.json'), 'utf8');

    k.ready = false;
    const store = new SecretStore(dir, k);
    expect(store.status().dashscope).toBe(false);
    expect(() => store.set('llm', 'zp-two')).toThrow(/钥匙串/);
    expect(readFileSync(join(dir, 'secrets.json'), 'utf8')).toBe(before);

    k.ready = true; // later the keychain works: everything is still there
    expect(store.all()).toEqual({ dashscope: 'sk-one' });
  });

  it('works without a keychain at all (plain file, owner-only)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mi-secrets-'));
    const k = keychain();
    const store = new SecretStore(dir, k);
    store.set('llm', 'zp');
    expect(new SecretStore(dir, k).all()).toEqual({ llm: 'zp' });
    store.set('llm', '');
    expect(new SecretStore(dir, k).all()).toEqual({});
  });
});
