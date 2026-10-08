import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { Relay } from '../src/relay.js';
import { provision, testDatabase } from './helpers.js';

const fakeBearer = () => randomBytes(32).toString('base64url');
const initializeBody = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcp-auth-limit', version: '1' } },
};

async function notBlocked<T>(work: Promise<T>, ms = 300): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('blocked on relay lock')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe('MCP failed-auth isolation', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>;
  let relay: Relay;
  let app: ReturnType<typeof buildApp>;
  beforeAll(async () => {
    db = await testDatabase();
    relay = new Relay(db.pool);
    app = buildApp(relay, { trustProxyHops: 1 });
    await app.ready();
  });
  beforeEach(async () => {
    await db.pool.query('TRUNCATE web_rates CASCADE');
    vi.spyOn(Date, 'now').mockReturnValue(Date.now());
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { await app?.close(); await db?.close(); });

  const call = (token: string, forwarded: string) => app.inject({
    method: 'POST',
    url: '/mcp',
    remoteAddress: '10.0.0.1',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json, text/event-stream',
      'x-forwarded-for': forwarded,
    },
    payload: initializeBody,
  });

  it('rejects a forged bearer without waiting for the relay advisory lock', async () => {
    const locker = await db.pool.connect();
    await locker.query('SELECT pg_advisory_lock(718401)');
    try {
      await expect(notBlocked(relay.authenticate(fakeBearer()))).rejects.toMatchObject({ code: 'unauthorized' });
      const response = await notBlocked(call(fakeBearer(), '198.51.100.10'));
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'unauthorized' });
    } finally {
      await locker.query('SELECT pg_advisory_unlock_all()');
      locker.release();
    }
  });

  it('still authenticates a valid token while the relay lock is held', async () => {
    const agent = await provision(relay, db.pool, { provider: 'mcp' });
    const locker = await db.pool.connect();
    await locker.query('SELECT pg_advisory_lock(718401)');
    try {
      await expect(notBlocked(relay.authenticate(agent.token))).resolves.toMatchObject({ id: agent.bindingId });
    } finally {
      await locker.query('SELECT pg_advisory_unlock_all()');
      locker.release();
    }
  });

  it('rate-limits repeated forged bearers per source and does not spend the global bucket on already-rejected requests', async () => {
    const attacker = '198.51.100.1';
    const responses = [];
    for (let i = 0; i < 100; i++) responses.push(await call(fakeBearer(), attacker));
    expect(responses.filter(response => response.statusCode === 401)).toHaveLength(20);
    expect(responses.filter(response => response.statusCode === 429)).toHaveLength(80);
    expect(responses.find(response => response.statusCode === 429)?.json()).toEqual({ error: 'rate_limited' });

    const peer = await provision(relay, db.pool, { provider: 'mcp' });
    const ok = await call(peer.token, '198.51.100.2');
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain('inbox_claim');

    const sameSourceOk = await call(peer.token, attacker);
    expect(sameSourceOk.statusCode).toBe(200);

    const global = await db.pool.query("SELECT hits FROM web_rates WHERE bucket LIKE 'all:mcp:%'");
    expect(global.rows[0].hits).toBe(20);
  });

  it('throttles the trusted forwarded client, ignores spoofed left entries, and groups IPv6 by /64', async () => {
    for (let i = 0; i < 20; i++) {
      expect((await call(fakeBearer(), `192.0.2.${i}, 198.51.100.8`)).statusCode).toBe(401);
    }
    expect((await call(fakeBearer(), '192.0.2.99, 198.51.100.8')).statusCode).toBe(429);
    expect((await call(fakeBearer(), '198.51.100.9')).statusCode).toBe(401);

    for (let i = 0; i < 20; i++) {
      expect((await call(fakeBearer(), `2001:db8:1:2::${i + 1}`)).statusCode).toBe(401);
    }
    expect((await call(fakeBearer(), '2001:db8:1:2:ffff:ffff:ffff:ffff')).statusCode).toBe(429);
    expect((await call(fakeBearer(), '2001:db8:1:3::1')).statusCode).toBe(401);
  });
});
