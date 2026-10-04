import { randomBytes, randomUUID } from 'node:crypto';
import pg, { type Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventSubscriptions, INBOX_EVENT } from '../src/events.js';
import { lockRelay, withTransaction } from '../src/db.js';
import { createOwner, testDatabase } from './helpers.js';

describe('durable callback verification budgets', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>; let pool: Pool; let bindingId: string;
  const encryptionKey = randomBytes(32);
  const input = () => ({ name: INBOX_EVENT, arguments: {}, delivery: { mode: 'webhook',
    url: 'https://callbacks.example.com/events', secret: `whsec_${randomBytes(32).toString('base64')}` } });
  const post = vi.fn(async (_url: string, _body: string, _headers: Record<string, string>) => ({ status: 503, body: '{}' }));
  const instance = () => new EventSubscriptions(pool, { encryptionKey, transport: { post } });
  const binding = async () => {
    const id = randomUUID();
    const ownerId = await createOwner(pool);
    await pool.query(`INSERT INTO bindings(id,owner_id,runtime_scope,provider,token_hash)
      VALUES($1,$2,$3,'dots',$4)`, [id, ownerId, randomUUID(), randomUUID()]);
    return id;
  };
  const seed = async (period: 'hour' | 'day' | 'month', subject: string, attempts: number) => {
    await pool.query(`INSERT INTO verification_budget(period,subject,bucket_start,expires_at,attempts)
      SELECT $1,$2,date_trunc($1,clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
        (date_trunc($1,clock_timestamp() AT TIME ZONE 'UTC') + ('1 ' || $1)::interval) AT TIME ZONE 'UTC',$3
      ON CONFLICT(period,subject,bucket_start) DO UPDATE SET attempts=EXCLUDED.attempts`, [period, subject, attempts]);
  };
  beforeAll(async () => { db = await testDatabase(); pool = db.pool; });
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => {
    await pool.query('TRUNCATE bindings CASCADE');
    await pool.query('TRUNCATE verification_budget');
    bindingId = await binding();
    post.mockReset(); post.mockResolvedValue({ status: 503, body: '{}' });
  });

  it('counts failed challenges with changed URLs and secrets across new instances', async () => {
    for (let i = 0; i < 10; i++) {
      const params = input(); params.delivery.url += `/${i}`;
      await expect(instance().subscribe(bindingId, params)).rejects.toMatchObject({ reason: 'challenge_failed' });
    }
    await expect(instance().subscribe(bindingId, input())).rejects.toMatchObject({ reason: 'verification_budget_exceeded' });
    expect(post).toHaveBeenCalledTimes(10);
    expect((await pool.query('SELECT attempts FROM verification_budget ORDER BY period')).rows).toEqual([
      { attempts: 10 }, { attempts: 10 }, { attempts: 10 },
    ]);
    expect((await pool.query('SELECT id FROM event_subscriptions')).rowCount).toBe(0);
  });

  it('commits the reservation and releases the shared lock before HTTP', async () => {
    let committedBeforeHttp = false; let lockAvailableDuringHttp = false;
    post.mockImplementation(async () => {
      const rows = (await pool.query('SELECT attempts FROM verification_budget')).rows;
      committedBeforeHttp = rows.length === 3 && rows.every(row => row.attempts === 1);
      await withTransaction(pool, async client => {
        await client.query("SET LOCAL statement_timeout='500ms'");
        await lockRelay(client);
      });
      lockAvailableDuringHttp = true;
      return { status: 503, body: '{}' };
    });
    await expect(instance().subscribe(bindingId, input())).rejects.toMatchObject({ reason: 'challenge_failed' });
    expect(post).toHaveBeenCalledTimes(1);
    expect(committedBeforeHttp).toBe(true);
    expect(lockAvailableDuringHttp).toBe(true);
    expect((await pool.query('SELECT attempts FROM verification_budget')).rows.every(row => row.attempts === 1)).toBe(true);
  });

  it('reserves the final hourly slot once across concurrent instances', async () => {
    await seed('hour', bindingId, 9);
    const outcomes = await Promise.allSettled([instance().subscribe(bindingId, input()), instance().subscribe(bindingId, input())]);
    expect(outcomes.map(result => result.status === 'rejected' && result.reason.reason).sort()).toEqual(['challenge_failed', 'verification_budget_exceeded']);
    expect(post).toHaveBeenCalledTimes(1);
    expect((await pool.query("SELECT attempts FROM verification_budget WHERE period='hour'")).rows[0].attempts).toBe(10);
  });

  it('shares the final daily slot across different owners and instances', async () => {
    await seed('day', '', 99);
    const other = await binding();
    const outcomes = await Promise.allSettled([instance().subscribe(bindingId, input()), instance().subscribe(other, input())]);
    expect(outcomes.map(result => result.status === 'rejected' && result.reason.reason).sort()).toEqual(['challenge_failed', 'verification_budget_exceeded']);
    expect(post).toHaveBeenCalledTimes(1);
    expect((await pool.query("SELECT attempts FROM verification_budget WHERE period='day'")).rows[0].attempts).toBe(100);
  });

  it('allows the thousandth monthly attempt then stops all bindings without spending a notification attempt', async () => {
    await seed('month', '', 999);
    await expect(instance().subscribe(bindingId, input())).rejects.toMatchObject({ reason: 'challenge_failed' });
    await expect(instance().subscribe(await binding(), input())).rejects.toMatchObject({ reason: 'verification_budget_exceeded' });
    expect(post).toHaveBeenCalledTimes(1);
    expect((await pool.query("SELECT attempts FROM verification_budget WHERE period='month'")).rows[0].attempts).toBe(1000);
    expect((await pool.query('SELECT id FROM delivery_attempts')).rowCount).toBe(0);
  });

  it('limits one binding without consuming another binding allowance', async () => {
    await seed('hour', bindingId, 10);
    await expect(instance().subscribe(bindingId, input())).rejects.toMatchObject({ reason: 'verification_budget_exceeded' });
    await expect(instance().subscribe(await binding(), input())).rejects.toMatchObject({ reason: 'challenge_failed' });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('does not charge cached success, but charges rotation and a fresh process', async () => {
    post.mockImplementation(async (_url, body) => ({ status: 200, body: JSON.stringify({ challenge: JSON.parse(body).challenge }) }));
    const events = instance(); const params = input();
    await events.subscribe(bindingId, params);
    await events.subscribe(bindingId, params);
    expect(post).toHaveBeenCalledTimes(1);
    await events.subscribe(bindingId, { ...params, delivery: { ...params.delivery, secret: input().delivery.secret } });
    await instance().subscribe(bindingId, params);
    expect(post).toHaveBeenCalledTimes(3);
    expect((await pool.query('SELECT attempts FROM verification_budget')).rows.every(row => row.attempts === 3)).toBe(true);
    await seed('day', '', 100);
    await events.subscribe(bindingId, params);
    expect(post).toHaveBeenCalledTimes(3);
  });

  it('revalidates caller authority before reserving or sending, including cache hits', async () => {
    const events = instance(); const params = input();
    const revoked = async () => { throw new Error('authorization_revoked'); };
    await expect(events.subscribe(bindingId, params, revoked)).rejects.toThrow('authorization_revoked');
    expect(post).not.toHaveBeenCalled();
    expect((await pool.query('SELECT * FROM verification_budget')).rowCount).toBe(0);
    post.mockImplementation(async (_url, body) => ({ status: 200, body: JSON.stringify({ challenge: JSON.parse(body).challenge }) }));
    await events.subscribe(bindingId, params);
    await expect(events.subscribe(bindingId, params, revoked)).rejects.toThrow('authorization_revoked');
    expect(post).toHaveBeenCalledTimes(1);
    expect((await pool.query('SELECT attempts FROM verification_budget')).rows.every(row => row.attempts === 1)).toBe(true);
  });

  it('rejects a second live context before spending an attempt or sending HTTP', async () => {
    post.mockImplementation(async (_url, body) => ({ status: 200, body: JSON.stringify({ challenge: JSON.parse(body).challenge }) }));
    await instance().subscribe(bindingId, input());
    const other = input(); other.delivery.url += '/other';
    await expect(instance().subscribe(bindingId, other)).rejects.toMatchObject({ reason: 'subscription_context_already_bound' });
    expect(post).toHaveBeenCalledTimes(1);
    expect((await pool.query('SELECT attempts FROM verification_budget')).rows.every(row => row.attempts === 1)).toBe(true);
  });

  it('uses UTC buckets regardless of database timezone and cleans expired counters', async () => {
    const offsetPool = new pg.Pool({ ...pool.options, options: `${pool.options.options} -c timezone=Pacific/Honolulu`, max: 1 });
    const events = new EventSubscriptions(offsetPool, { encryptionKey, transport: { post } });
    try {
      expect((await offsetPool.query('SHOW timezone')).rows[0].TimeZone).toBe('Pacific/Honolulu');
      await offsetPool.query(`INSERT INTO verification_budget(period,subject,bucket_start,expires_at,attempts)
        VALUES('month','','2000-01-01T00:00:00Z','2000-02-01T00:00:00Z',1000)`);
      await expect(events.subscribe(bindingId, input())).rejects.toMatchObject({ reason: 'challenge_failed' });
      const rows = (await offsetPool.query('SELECT period,bucket_start,expires_at FROM verification_budget')).rows;
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.bucket_start.getUTCMinutes()).toBe(0);
        expect(row.bucket_start.getUTCSeconds()).toBe(0);
        if (row.period !== 'hour') expect(row.bucket_start.getUTCHours()).toBe(0);
        if (row.period === 'month') expect(row.bucket_start.getUTCDate()).toBe(1);
        expect(row.expires_at.getTime()).toBeGreaterThan(Date.now());
      }
    } finally { await offsetPool.end(); }
  });
});
