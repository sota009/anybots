import type { Pool, PoolClient } from 'pg';

// Service-wide ordering barrier for short transactions only. Never hold it
// across network I/O; partition before multi-tenant scale.
export async function lockRelay(client: PoolClient): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(718401)');
}

export async function withTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
