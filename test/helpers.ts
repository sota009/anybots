import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrate } from '../src/migrate.js';
import { Relay } from '../src/relay.js';
import { encryptSecret } from '../src/providers/crypto.js';

export async function testDatabase() {
  const connectionString = process.env.TEST_DATABASE_URL ?? 'postgres://anybots:local-development-only@127.0.0.1:55432/anybots';
  const admin = new pg.Pool({ connectionString });
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` });
  await migrate(pool);
  return {
    pool,
    async close() {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}

export async function createOwner(pool: pg.Pool): Promise<string> {
  const id = randomUUID();
  await pool.query('INSERT INTO owners(id) VALUES($1)', [id]);
  return id;
}

export async function provision(
  relay: Relay,
  pool: pg.Pool,
  input: { provider: 'dots' | 'grok' | 'mcp'; ownerId?: string; runtimeScope?: string },
) {
  const ownerId = input.ownerId ?? await createOwner(pool);
  const binding = await relay.provisionBinding({
    ownerId,
    runtimeScope: input.runtimeScope ?? randomUUID(),
    provider: input.provider,
  });
  return { ...binding, ownerId };
}

export async function setGrokWebhook(pool: pg.Pool, bindingId: string, key: Buffer, url: string, secret: string) {
  await pool.query('UPDATE bindings SET webhook_encrypted=$2 WHERE id=$1', [bindingId, encryptSecret(JSON.stringify({ url, secret }), key, bindingId)]);
}
