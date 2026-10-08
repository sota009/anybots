import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import { createPool } from './db.js';

/** One-shot operator wipe for empty-schema cutovers. Requires ALLOW_SCHEMA_WIPE=true. */
export async function wipePublicSchema(pool: Pool): Promise<void> {
  if (process.env.ALLOW_SCHEMA_WIPE !== 'true') {
    throw new Error('ALLOW_SCHEMA_WIPE must be true');
  }
  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await pool.query('GRANT ALL ON SCHEMA public TO CURRENT_USER');
  await pool.query('GRANT ALL ON SCHEMA public TO public');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = createPool(process.env.DATABASE_URL);
  try {
    await wipePublicSchema(pool);
    console.log(JSON.stringify({ status: 'wiped' }));
  } catch {
    console.error('Schema wipe failed. Check ALLOW_SCHEMA_WIPE and DATABASE_URL.');
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
