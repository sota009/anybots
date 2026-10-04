import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';

const connectionString = process.env.TEST_DATABASE_URL ?? 'postgres://anybots:local-development-only@127.0.0.1:55432/anybots';
const schema = `test_${randomUUID().replaceAll('-', '')}`;
const directory = new URL('../migrations/', import.meta.url);
let admin: pg.Pool;
let pool: pg.Pool;
beforeAll(async () => {
  admin = new pg.Pool({ connectionString });
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` });
});
afterAll(async () => { await pool?.end(); await admin?.query(`DROP SCHEMA ${schema} CASCADE`); await admin?.end(); });

async function apply(filter: (name: string) => boolean) {
  for (const name of (await readdir(directory)).filter(name => name.endsWith('.sql') && filter(name)).sort()) await pool.query(await readFile(new URL(name, directory), 'utf8'));
}

it('keeps revoked grants revoked when upgrading an existing database', async () => {
  await apply(name => name < '009');
  const owner = randomUUID();
  await pool.query('INSERT INTO owners(id) VALUES($1)', [owner]);
  const ids = [randomUUID(), randomUUID(), randomUUID()].sort();
  for (const id of ids) await pool.query("INSERT INTO bindings(id,owner_id,runtime_scope,provider,token_hash) VALUES($1,$2,$3,'dots',$3)", [id, owner, id]);
  await pool.query('INSERT INTO grants(binding_a,binding_b,active) VALUES($1,$2,true),($1,$3,false)', ids);
  await apply(name => name.startsWith('009'));
  const grants = await pool.query('SELECT binding_b,status,active FROM grants ORDER BY binding_b');
  expect(grants.rows).toEqual([{ binding_b: ids[1], status: 'active', active: true }, { binding_b: ids[2], status: 'revoked', active: false }]);
});
