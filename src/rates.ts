import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { withTransaction } from './db.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Web auth and MCP Bearer failures share this ceiling. */
export const AUTH_ATTEMPT_LIMITS = { perSource: 20, global: 1000 } as const;

/** Fixed one-minute windows. A rejected source does not spend the shared allowance. */
export async function admitRate(
  pool: Pool,
  endpoint: string,
  source: string,
  limits: { perSource: number; global: number },
): Promise<boolean> {
  const minute = Math.floor(Date.now() / 60_000);
  return withTransaction(pool, async client => {
    await client.query('DELETE FROM web_rates WHERE expires_at<clock_timestamp()');
    for (const [bucket, limit] of [[`src:${hash(source)}:${endpoint}:${minute}`, limits.perSource], [`all:${endpoint}:${minute}`, limits.global]] as const) {
      const hit = await client.query<{ hits: number }>(`INSERT INTO web_rates(bucket,hits,expires_at) VALUES($1,1,clock_timestamp()+interval '2 minutes')
        ON CONFLICT(bucket) DO UPDATE SET hits=web_rates.hits+1 RETURNING hits`, [bucket]);
      if (hit.rows[0]!.hits > limit) return false;
    }
    return true;
  });
}
