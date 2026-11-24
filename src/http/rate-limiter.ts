import { Db } from '../db/db';
import type { RateRule } from '../config';
import { ApiError } from './errors';

/** DB-asosidagi fixed-window limiter. Limit oshsa 429 + Retry-After. */
export class RateLimiter {
  constructor(private readonly db: Db) {}
  async hit(key: string, rule: RateRule): Promise<void> {
    const r = await this.db.query<{ count: number; window_start: Date }>(
      `INSERT INTO rate_limits (key, window_start) VALUES ($1, to_timestamp(floor(extract(epoch from now()) / $2) * $2))
       ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + 1
       RETURNING count, window_start`, [key, rule.windowSec]);
    const { count, window_start } = r.rows[0];
    if (count > rule.limit) {
      const retry = Math.max(1, Math.ceil((window_start.getTime() + rule.windowSec * 1000 - Date.now()) / 1000));
      throw new ApiError(429, 'RATE_LIMITED', { retryAfterSec: retry });
    }
    if (Math.random() < 0.01) await this.db.query("DELETE FROM rate_limits WHERE window_start < now() - interval '2 days'");
  }
}
