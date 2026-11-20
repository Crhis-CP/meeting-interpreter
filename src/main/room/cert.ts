import { existsSync, readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import selfsigned from 'selfsigned';
import { writeJson } from '../stores/json-file';

/** IPv4 addresses phones on the same Wi-Fi can reach. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push(a.address);
    }
  }
  // Private ranges first (the Wi-Fi address is what people need).
  return out.sort((a, b) => Number(!/^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))/.test(a)) - Number(!/^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))/.test(b)));
}

interface StoredCert {
  key: string;
  cert: string;
  ips: string[];
  notAfter: string;
}

/**
 * A self-signed certificate for the room server (phones need HTTPS to use the microphone).
 * Regenerated when the machine's LAN addresses change or it is about to expire.
 */
export async function roomCertificate(dataDir: string): Promise<{ key: string; cert: string }> {
  const path = join(dataDir, 'room-cert.json');
  const ips = lanAddresses();
  if (existsSync(path)) {
    try {
      const c = JSON.parse(readFileSync(path, 'utf8')) as StoredCert;
      const fresh = new Date(c.notAfter).getTime() - Date.now() > 7 * 86400_000;
      if (fresh && ips.every((ip) => c.ips.includes(ip))) return { key: c.key, cert: c.cert };
    } catch {
      /* regenerate */
    }
  }
  const notAfter = new Date();
  notAfter.setFullYear(notAfter.getFullYear() + 1);
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'meeting-interpreter.local' }], {
    keyType: 'ec',
    curve: 'P-256',
    algorithm: 'sha256',
    notAfterDate: notAfter,
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }, ...ips.map((ip) => ({ type: 7, ip }))],
      },
    ],
  } as never);
  writeJson(path, { key: pems.private, cert: pems.cert, ips, notAfter: notAfter.toISOString() } satisfies StoredCert, 0o600);
  return { key: pems.private, cert: pems.cert };
}
