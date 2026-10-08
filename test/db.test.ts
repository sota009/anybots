import { expect, it } from 'vitest';
import { createPool, poolConfig, STATEMENT_TIMEOUT_MS } from '../src/db.js';

const local = 'postgres://knotcat:local-development-only@127.0.0.1:55432/knotcat';
const remote = 'postgres://knotcat:redacted@db.example.test:5432/knotcat';

it('sets statement_timeout and refuses cleartext remote DATABASE_URL in production', () => {
  expect(poolConfig(local).statement_timeout).toBe(STATEMENT_TIMEOUT_MS);
  expect(poolConfig(local, { NODE_ENV: 'production' }).statement_timeout).toBe(STATEMENT_TIMEOUT_MS);
  expect(() => poolConfig(remote, { NODE_ENV: 'production' })).toThrow(/sslmode/);
  expect(() => poolConfig(`${remote}?sslmode=disable`, { NODE_ENV: 'production' })).toThrow(/sslmode/);
  expect(() => poolConfig(`${remote}?sslmode=prefer`, { NODE_ENV: 'production' })).toThrow(/sslmode/);
  expect(poolConfig(`${remote}?sslmode=require`, { NODE_ENV: 'production' }).statement_timeout).toBe(STATEMENT_TIMEOUT_MS);
  expect(poolConfig(`${remote}?sslmode=verify-full`, { NODE_ENV: 'production' }).connectionString).toContain('sslmode=verify-full');
  expect(poolConfig(remote, { NODE_ENV: 'test' }).statement_timeout).toBe(STATEMENT_TIMEOUT_MS);
});

it('applies statement_timeout on new connections', async () => {
  const pool = createPool(process.env.TEST_DATABASE_URL ?? local);
  try {
    const result = await pool.query('SHOW statement_timeout');
    expect(['30s', '30000ms']).toContain(result.rows[0].statement_timeout);
  } finally { await pool.end(); }
});
