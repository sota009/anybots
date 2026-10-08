import { expect, it, vi } from 'vitest';
import { createPool, poolConfig, STATEMENT_TIMEOUT_MS } from '../src/db.js';

const local = 'postgres://knotcat:local-development-only@127.0.0.1:55432/knotcat';
const remote = 'postgres://knotcat:redacted@db.example.test:5432/knotcat';
const renderInternal = 'postgresql://appuser:redacted@dpg-xxxxexample-a/knotcat';

it('sets statement_timeout on loopback without TLS warnings', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    expect(poolConfig(local).statement_timeout).toBe(STATEMENT_TIMEOUT_MS);
    expect(poolConfig(local, { NODE_ENV: 'production' }).statement_timeout).toBe(STATEMENT_TIMEOUT_MS);
    expect(warn).not.toHaveBeenCalled();
  } finally { warn.mockRestore(); }
});

it('warns on production Render-internal DATABASE_URL without sslmode and still starts', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const cfg = poolConfig(renderInternal, { NODE_ENV: 'production' });
    expect(cfg.statement_timeout).toBe(STATEMENT_TIMEOUT_MS);
    expect(cfg.connectionString).toBe(renderInternal);
    expect(warn).toHaveBeenCalledOnce();
    const message = String(warn.mock.calls.at(0)?.at(0) ?? '');
    expect(message).toMatch(/internal-style/);
    expect(message).toMatch(/sslmode/);
    expect(message).not.toMatch(/redacted|appuser|dpg-xxxxexample-a|postgresql:\/\//i);
  } finally { warn.mockRestore(); }
});

it('refuses production DATABASE_URL without tls only when DATABASE_REQUIRE_TLS=true', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    expect(() => poolConfig(renderInternal, { NODE_ENV: 'production', DATABASE_REQUIRE_TLS: 'true' })).toThrow(/sslmode|DATABASE_REQUIRE_TLS/);
    expect(() => poolConfig(remote, { NODE_ENV: 'production', DATABASE_REQUIRE_TLS: 'true' })).toThrow(/sslmode|DATABASE_REQUIRE_TLS/);
    expect(() => poolConfig(`${remote}?sslmode=disable`, { NODE_ENV: 'production', DATABASE_REQUIRE_TLS: 'true' })).toThrow(/sslmode|DATABASE_REQUIRE_TLS/);
    expect(warn).not.toHaveBeenCalled();
  } finally { warn.mockRestore(); }
});

it('does not warn when production DATABASE_URL already has sslmode=require', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    expect(poolConfig(`${renderInternal}?sslmode=require`, { NODE_ENV: 'production' }).statement_timeout).toBe(STATEMENT_TIMEOUT_MS);
    expect(poolConfig(`${remote}?sslmode=require`, { NODE_ENV: 'production' }).statement_timeout).toBe(STATEMENT_TIMEOUT_MS);
    expect(poolConfig(`${remote}?sslmode=verify-full`, { NODE_ENV: 'production' }).connectionString).toContain('sslmode=verify-full');
    expect(poolConfig(remote, { NODE_ENV: 'test' }).statement_timeout).toBe(STATEMENT_TIMEOUT_MS);
    expect(warn).not.toHaveBeenCalled();
  } finally { warn.mockRestore(); }
});

it('applies statement_timeout on new connections', async () => {
  const pool = createPool(process.env.TEST_DATABASE_URL ?? local);
  try {
    const result = await pool.query('SHOW statement_timeout');
    expect(['30s', '30000ms']).toContain(result.rows[0].statement_timeout);
  } finally { await pool.end(); }
});
