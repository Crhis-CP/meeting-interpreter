import { describe, expect, it } from 'vitest';
import { createLogger } from '@core/log';
import { checkForUpdate, compareVersions } from '../../src/main/update-check';

describe('update check', () => {
  it('compares versions', () => {
    expect(compareVersions('v0.2.0', '0.1.9')).toBe(1);
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0);
    expect(compareVersions('0.1.0', '0.10.0')).toBe(-1);
  });

  it('reports a newer release and ignores older ones or failures', async () => {
    const reply = (tag: string) => (async () => new Response(JSON.stringify({ tag_name: tag, html_url: 'https://x/rel' }))) as unknown as typeof fetch;
    const log = createLogger('t');
    expect(await checkForUpdate('0.1.0', log, reply('v0.2.0'))).toEqual({ version: '0.2.0', url: 'https://x/rel' });
    expect(await checkForUpdate('0.2.0', log, reply('v0.2.0'))).toBeNull();
    expect(await checkForUpdate('0.1.0', log, (async () => { throw new Error('offline'); }) as unknown as typeof fetch)).toBeNull();
  });
});
