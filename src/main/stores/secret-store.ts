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
  private cache: Secrets;

  constructor(
    dataDir: string,
    private readonly safe: SafeStorageLike,
  ) {
    this.path = join(dataDir, 'secrets.json');
    this.cache = this.load();
  }

  private load(): Secrets {
    if (!existsSync(this.path)) return {};
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as { enc?: string; plain?: Secrets };
      if (raw.enc && this.safe.isEncryptionAvailable()) return JSON.parse(this.safe.decryptString(Buffer.from(raw.enc, 'base64'))) as Secrets;
      if (raw.plain) return raw.plain;
    } catch {
      /* unreadable (e.g. keychain changed): start empty */
    }
    return {};
  }

  private save(): void {
    if (this.safe.isEncryptionAvailable()) {
      writeJson(this.path, { enc: this.safe.encryptString(JSON.stringify(this.cache)).toString('base64') }, 0o600);
    } else {
      writeJson(this.path, { plain: this.cache }, 0o600);
    }
  }

  get(name: SecretName): string {
    return this.cache[name] ?? '';
  }

  all(): Secrets {
    return { ...this.cache };
  }

  set(name: SecretName, value: string): void {
    if (!SECRET_NAMES.includes(name)) throw new Error(`unknown secret ${name}`);
    const v = value.trim();
    if (v) this.cache[name] = v;
    else delete this.cache[name];
    this.save();
  }

  status(): Record<SecretName, boolean> {
    return Object.fromEntries(SECRET_NAMES.map((n) => [n, !!this.cache[n]])) as Record<SecretName, boolean>;
  }
}
