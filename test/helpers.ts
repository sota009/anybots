import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrate } from '../src/migrate.js';

export async function testDatabase() {
  const connectionString = process.env.TEST_DATABASE_URL ?? 'postgres://anybots:local-development-only@127.0.0.1:55432/anybots';
  const admin = new pg.Pool({ connectionString });
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` });
  await migrate(pool);
  return { pool, async close() { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); } };
}
