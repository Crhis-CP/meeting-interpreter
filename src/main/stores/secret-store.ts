import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SECRET_NAMES, type SecretName, type Secrets } from '../../core/config/schema';
import { writeJson } from './json-file';

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/**
 * API keys, encrypted with the OS keychain (Electron safeStorage: Keychain on macOS, DPAPI on
 * Windows, libsecret/kwallet on Linux). Stored apart from settings so exports never contain them.
 */
export class SecretStore {
  private readonly path: string;
  /** Null until the file could be read (on Windows/Linux the keychain only works once the app is ready). */
  private cache: Secrets | null = null;

  constructor(
    dataDir: string,
    private readonly safe: SafeStorageLike,
  ) {
    this.path = join(dataDir, 'secrets.json');
  }

  /**
   * Reads the file on first use. An encrypted file that cannot be decrypted yet (keychain not
   * available) is NOT treated as empty: nothing is cached, so it is read again next time and is
   * never overwritten with fewer keys.
   */
  private read(): Secrets {
    if (this.cache) return this.cache;
    if (!existsSync(this.path)) return (this.cache = {});
    let raw: { enc?: string; plain?: Secrets };
    try {
      raw = JSON.parse(readFileSync(this.path, 'utf8')) as { enc?: string; plain?: Secrets };
    } catch {
      return (this.cache = {}); // unreadable file: start empty
    }
    if (raw.enc) {
      if (!this.safe.isEncryptionAvailable()) return {};
      try {
        return (this.cache = JSON.parse(this.safe.decryptString(Buffer.from(raw.enc, 'base64'))) as Secrets);
      } catch {
        return (this.cache = {}); // the keychain changed (e.g. another computer): start empty
      }
    }
    return (this.cache = raw.plain ?? {});
  }

  private save(next: Secrets): void {
    if (this.safe.isEncryptionAvailable()) {
      writeJson(this.path, { enc: this.safe.encryptString(JSON.stringify(next)).toString('base64') }, 0o600);
    } else {
      writeJson(this.path, { plain: next }, 0o600);
    }
    this.cache = next;
  }

  get(name: SecretName): string {
    return this.read()[name] ?? '';
  }

  all(): Secrets {
    return { ...this.read() };
  }

  set(name: SecretName, value: string): void {
    if (!SECRET_NAMES.includes(name)) throw new Error(`unknown secret ${name}`);
    const current = this.read();
    if (!this.cache) throw new Error('系统钥匙串暂时不可用，Key 没有保存（已保存的 Key 不受影响）。请稍后再试。');
    const next = { ...current };
    const v = value.trim();
    if (v) next[name] = v;
    else delete next[name];
    this.save(next);
  }

  status(): Record<SecretName, boolean> {
    const c = this.read();
    return Object.fromEntries(SECRET_NAMES.map((n) => [n, !!c[n]])) as Record<SecretName, boolean>;
  }
}
