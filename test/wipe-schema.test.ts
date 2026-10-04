import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { wipePublicSchema } from '../src/wipe-schema.js';
import { testDatabase } from './helpers.js';

describe('schema wipe gate', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>;
  beforeAll(async () => { db = await testDatabase(); });
  afterAll(async () => { await db?.close(); });

  it('refuses without ALLOW_SCHEMA_WIPE', async () => {
    const previous = process.env.ALLOW_SCHEMA_WIPE;
    delete process.env.ALLOW_SCHEMA_WIPE;
    await expect(wipePublicSchema(db.pool)).rejects.toThrow('ALLOW_SCHEMA_WIPE');
    if (previous === undefined) delete process.env.ALLOW_SCHEMA_WIPE;
    else process.env.ALLOW_SCHEMA_WIPE = previous;
  });

  it('wipes public schema when allowed', async () => {
    process.env.ALLOW_SCHEMA_WIPE = 'true';
    await db.pool.query('CREATE TABLE wipe_probe(id int)');
    await wipePublicSchema(db.pool);
    const tables = await db.pool.query(
      `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename='wipe_probe'`,
    );
    expect(tables.rowCount).toBe(0);
    delete process.env.ALLOW_SCHEMA_WIPE;
  });
});
