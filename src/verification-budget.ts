import type { PoolClient } from 'pg';

// Caller must hold lockRelay in a transaction and commit before external HTTP.
// Fixed UTC windows deliberately allow a burst on either side of a boundary.
export async function reserveVerification(client: PoolClient, bindingId: string): Promise<boolean> {
  await client.query('DELETE FROM verification_budget WHERE expires_at<=clock_timestamp()');
  const windows = await client.query<{
    period: string; subject: string; bucket_start: Date; expires_at: Date; attempts: number; maximum: number;
  }>(`WITH clock AS (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS at), windows AS (
    SELECT period,subject,maximum,
      date_trunc(period,at) AT TIME ZONE 'UTC' AS bucket_start,
      (date_trunc(period,at) + ('1 ' || period)::interval) AT TIME ZONE 'UTC' AS expires_at
    FROM clock CROSS JOIN (VALUES ('hour',$1::text,10),('day','',100),('month','',1000)) AS limits(period,subject,maximum)
  ) SELECT w.*,COALESCE(b.attempts,0) AS attempts FROM windows w LEFT JOIN verification_budget b
    USING (period,subject,bucket_start)`, [bindingId]);
  if (windows.rows.some(bucket => bucket.attempts >= bucket.maximum)) return false;
  for (const bucket of windows.rows) {
    await client.query(`INSERT INTO verification_budget(period,subject,bucket_start,expires_at,attempts)
      VALUES($1,$2,$3,$4,1) ON CONFLICT(period,subject,bucket_start)
      DO UPDATE SET attempts=verification_budget.attempts+1`,
    [bucket.period, bucket.subject, bucket.bucket_start, bucket.expires_at]);
  }
  return true;
}
