import { ProviderError, type AsrSession, type AsrStartOptions, type StreamingAsr } from './types';

/**
 * Tries recognisers in order until one starts, then sticks with it. Used for DashScope, where a
 * newer model may not be enabled for an account or served on the legacy host. Authentication and
 * quota errors are not retried with another model (they would fail the same way).
 */
export class FallbackAsr implements StreamingAsr {
  private working = 0;

  constructor(
    private readonly chain: StreamingAsr[],
    private readonly onFallback?: (from: number, to: number, error: Error) => void,
  ) {
    if (!chain.length) throw new Error('FallbackAsr needs at least one recogniser');
  }

  get id(): string {
    return this.chain[this.working]!.id;
  }

  async start(opts: AsrStartOptions): Promise<AsrSession> {
    let lastError: Error | null = null;
    for (let i = this.working; i < this.chain.length; i++) {
      try {
        const session = await this.chain[i]!.start(opts);
        if (i !== this.working) {
          this.onFallback?.(this.working, i, lastError ?? new Error('fallback'));
          this.working = i;
        }
        return session;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const status = err instanceof ProviderError ? err.status : undefined;
        if (status === 401 || status === 403 || status === 429 || /Key|欠费|额度|余额|Arrearage|401|403/.test(lastError.message)) throw lastError;
      }
    }
    throw lastError ?? new Error('no recogniser could start');
  }
}
