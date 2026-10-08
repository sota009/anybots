import pg, { type Pool, type PoolClient, type PoolConfig } from 'pg';

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

export const STATEMENT_TIMEOUT_MS = 30_000;
const TLS_SSLMODES = new Set(['require', 'verify-ca', 'verify-full']);
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);

function hostKind(hostname: string): 'loopback' | 'internal-style' | 'public-style' {
  if (LOOPBACK.has(hostname)) return 'loopback';
  return hostname.includes('.') ? 'public-style' : 'internal-style';
}

export function poolConfig(connectionString: string, env: NodeJS.ProcessEnv = process.env): PoolConfig {
  let parsed: URL;
  try { parsed = new URL(connectionString); } catch { throw new Error('DATABASE_URL is invalid'); }
  const sslmode = parsed.searchParams.get('sslmode')?.toLowerCase();
  const kind = hostKind(parsed.hostname);
  if (env.NODE_ENV === 'production' && kind !== 'loopback' && !TLS_SSLMODES.has(sslmode ?? '')) {
    const message = `DATABASE_URL has no sslmode=require (or verify-ca/verify-full) for a non-loopback production host (${kind}). Startup continues unless DATABASE_REQUIRE_TLS=true.`;
    if (env.DATABASE_REQUIRE_TLS === 'true') throw new Error(message);
    console.warn(message);
  }
  return { connectionString, statement_timeout: STATEMENT_TIMEOUT_MS };
}

export function createPool(connectionString: string, env: NodeJS.ProcessEnv = process.env): Pool {
  return new pg.Pool(poolConfig(connectionString, env));
}
