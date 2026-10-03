import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Relay } from '../src/relay.js';
import { dispatchOne, notificationBudgetWindows } from '../src/worker.js';
import { testDatabase } from './helpers.js';
import { notificationBudgetOptions } from '../src/notification-budget.js';

describe('global persistent notification budgets', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>; let relay: Relay;
  let pair: Awaited<ReturnType<typeof newPair>>;
  beforeAll(async () => { db = await testDatabase(); relay = new Relay(db.pool); });
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => { await db.pool.query('TRUNCATE bindings CASCADE'); pair = await newPair(); });

  async function newPair() {
    const a = await relay.provisionBinding({ ownerId: randomUUID(), runtimeScope: randomUUID(), provider: 'dots' });
    const b = await relay.provisionBinding({ ownerId: randomUUID(), runtimeScope: randomUUID(), provider: 'grok' });
    await relay.grantPair(a.bindingId, b.bindingId);
    const conversation = await relay.conversationOpen(a.token, {
      recipientBindingId: b.bindingId, text: 'Budget test', expectsReply: true, idempotencyKey: randomUUID(),
    });
    const outbox = (await db.pool.query<{ id: string }>('SELECT id FROM outbox WHERE message_id=$1', [conversation.messageId])).rows[0]!;
    return { a, b, ...conversation, outboxId: outbox.id };
  }
  async function history(count: number, timestamp = new Date(), owner = pair.b.bindingId) {
    // Every persisted status consumes capacity; outcomes cannot refund a send.
    await db.pool.query(`INSERT INTO delivery_attempts(id,outbox_id,binding_id,owner_id,status,started_at)
      SELECT gen_random_uuid(),$1,$2,$3,
        (ARRAY['accepted','failed','retry','uncertain','configuration_required'])[1+(n%5)],$4
      FROM generate_series(1,$5::integer) n`, [pair.outboxId, pair.b.bindingId, owner, timestamp, count]);
  }
  const accepted = () => vi.fn(async () => ({ status: 'accepted' as const }));
  const state = async (id: string) => (await db.pool.query('SELECT status,last_error,attempts FROM outbox WHERE id=$1', [id])).rows[0];
  const attemptCount = async () => Number((await db.pool.query('SELECT count(*) FROM delivery_attempts')).rows[0].count);

  it('applies the configured daily cap across concurrent workers and retains exhausted notifications after an increase', async () => {
    const limits = notificationBudgetOptions({ NOTIFICATION_DAILY_LIMIT: '200', NOTIFICATION_MONTHLY_LIMIT: '2000' });
    await history(199);
    const other = await newPair();
    const deliver = accepted();
    const restartedPool = new pg.Pool({ ...db.pool.options, max: 1 });
    try {
      await Promise.all([dispatchOne(db.pool, { deliver }, limits), dispatchOne(restartedPool, { deliver }, limits)]);
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(await attemptCount()).toBe(200);
      const states = [await state(pair.outboxId), await state(other.outboxId)];
      expect(states.map(row => row.status).sort()).toEqual(['accepted', 'failed']);
      expect(states.find(row => row.status === 'failed')).toMatchObject({ last_error: 'budget_exceeded', attempts: 0 });
      expect(await dispatchOne(restartedPool, { deliver }, { daily: 201, monthly: 2000 })).toBe(false);
      await newPair();
      await dispatchOne(restartedPool, { deliver }, { daily: 201, monthly: 2000 });
      expect(await attemptCount()).toBe(201);
      expect(deliver).toHaveBeenCalledTimes(2);
    } finally { await restartedPool.end(); }
  });

  it('enforces the configured monthly cap before sending', async () => {
    const limits = notificationBudgetOptions({ NOTIFICATION_DAILY_LIMIT: '3000', NOTIFICATION_MONTHLY_LIMIT: '2000' });
    await history(1999);
    const deliver = accepted();
    await dispatchOne(db.pool, { deliver }, limits);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(await attemptCount()).toBe(2000);
    const next = await newPair();
    await dispatchOne(db.pool, { deliver }, limits);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(await state(next.outboxId)).toMatchObject({ status: 'failed', last_error: 'budget_exceeded', attempts: 0 });
  });

  it('rejects invalid dispatch limits before database access or external sends', async () => {
    const deliver = accepted();
    for (const daily of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(dispatchOne({} as pg.Pool, { deliver }, { daily, monthly: 100 })).rejects.toThrow('Invalid notification budget');
      await expect(dispatchOne({} as pg.Pool, { deliver }, { daily: 20, monthly: daily })).rejects.toThrow('Invalid notification budget');
    }
    expect(deliver).not.toHaveBeenCalled();
  });

  it('reserves the twentieth daily attempt before HTTP and permanently rejects the next notification', async () => {
    await history(19);
    const deliver = vi.fn(async () => {
      expect(await attemptCount()).toBe(20);
      expect(await state(pair.outboxId)).toMatchObject({ status: 'uncertain', attempts: 1 });
      return { status: 'accepted' as const };
    });
    await dispatchOne(db.pool, { deliver });
    expect(deliver).toHaveBeenCalledTimes(1);
    const second = await newPair();
    const blocked = accepted();
    await dispatchOne(db.pool, { deliver: blocked });
    expect(blocked.mock.calls.length).toBe(0);
    expect(await state(second.outboxId)).toEqual({ status: 'failed', last_error: 'budget_exceeded', attempts: 0 });
    expect(await attemptCount()).toBe(20);
    // Once the quota period changes, the rejected message must still not replay.
    await db.pool.query("UPDATE delivery_attempts SET started_at=now()-interval '40 days'");
    expect(await dispatchOne(db.pool, { deliver: blocked })).toBe(false);
    expect(blocked.mock.calls.length).toBe(0);
  });

  it('counts other owners and both providers instead of granting a separate daily allowance', async () => {
    await history(20);
    await db.pool.query("UPDATE outbox SET status='cancelled' WHERE id=$1", [pair.outboxId]);
    const other = await newPair();
    // Reverse the direction so history belongs to Grok but the new wake targets dots.
    await db.pool.query("UPDATE outbox SET status='cancelled' WHERE id=$1", [other.outboxId]);
    const inbound = await relay.conversationOpen(other.b.token, {
      recipientBindingId: other.a.bindingId, text: 'Other owner/provider', expectsReply: true, idempotencyKey: randomUUID(),
    });
    const id = (await db.pool.query('SELECT id FROM outbox WHERE message_id=$1', [inbound.messageId])).rows[0].id;
    const deliver = accepted();
    await dispatchOne(db.pool, { deliver });
    expect(deliver.mock.calls.length).toBe(0);
    expect(await state(id)).toMatchObject({ status: 'failed', last_error: 'budget_exceeded' });
  });

  it('serializes concurrent workers at the last daily slot and keeps the budget after a new pool starts', async () => {
    await history(19); const other = await newPair();
    const deliver = accepted();
    const restartedPool = new pg.Pool({ ...db.pool.options, max: 1 });
    try {
      await Promise.all([dispatchOne(db.pool, { deliver }), dispatchOne(restartedPool, { deliver })]);
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(await attemptCount()).toBe(20);
      const states = [await state(pair.outboxId), await state(other.outboxId)];
      expect(states.map(row => row.status).sort()).toEqual(['accepted', 'failed']);
      expect(states.find(row => row.status === 'failed').last_error).toBe('budget_exceeded');
      const third = await newPair();
      await dispatchOne(restartedPool, { deliver });
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(await state(third.outboxId)).toMatchObject({ status: 'failed', last_error: 'budget_exceeded' });
    } finally { await restartedPool.end(); }
  });

  it('charges retry attempts and stops a pending retry when it exhausts the day', async () => {
    await history(18);
    const deliver = vi.fn(async () => ({ status: 'retry' as const, retryAfterMs: 1000 }));
    await dispatchOne(db.pool, { deliver });
    await db.pool.query('UPDATE outbox SET next_attempt_at=now() WHERE id=$1', [pair.outboxId]);
    await dispatchOne(db.pool, { deliver });
    expect(await attemptCount()).toBe(20);
    await db.pool.query('UPDATE outbox SET next_attempt_at=now() WHERE id=$1', [pair.outboxId]);
    await dispatchOne(db.pool, { deliver });
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(await state(pair.outboxId)).toEqual({ status: 'failed', last_error: 'budget_exceeded', attempts: 2 });
    expect(await attemptCount()).toBe(20);
  });

  it('enforces the monthly total even when earlier attempts fall outside the UTC day', async () => {
    const now = (await db.pool.query<{ at: Date }>('SELECT now() AS at')).rows[0]!.at;
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    await history(100, monthStart);
    const deliver = accepted();
    await dispatchOne(db.pool, { deliver });
    expect(deliver.mock.calls.length).toBe(0);
    expect(await state(pair.outboxId)).toEqual({ status: 'failed', last_error: 'budget_exceeded', attempts: 0 });
    expect(await attemptCount()).toBe(100);
  });

  it('uses UTC day boundaries even when PostgreSQL connections use another timezone', async () => {
    const now = (await db.pool.query<{ at: Date }>('SELECT now() AS at')).rows[0]!.at;
    const window = notificationBudgetWindows(now);
    const offsetPool = new pg.Pool({ ...db.pool.options, options: `${db.pool.options.options} -c timezone=Pacific/Auckland`, max: 1 });
    try {
      await history(20, new Date(window.dayStart.getTime() - 1));
      const deliver = accepted();
      await dispatchOne(offsetPool, { deliver });
      expect(deliver.mock.calls.length).toBe(1);
      await db.pool.query('TRUNCATE delivery_attempts');
      await history(20, window.dayStart);
      const next = await newPair();
      await dispatchOne(offsetPool, { deliver });
      expect(deliver.mock.calls.length).toBe(1);
      expect(await state(next.outboxId)).toMatchObject({ status: 'failed', last_error: 'budget_exceeded' });
    } finally { await offsetPool.end(); }
  });

  it('excludes attempts immediately before the UTC month begins', async () => {
    const now = (await db.pool.query<{ at: Date }>('SELECT now() AS at')).rows[0]!.at;
    await history(100, new Date(notificationBudgetWindows(now).monthStart.getTime() - 1));
    const deliver = accepted();
    await dispatchOne(db.pool, { deliver });
    expect(deliver.mock.calls.length).toBe(1);
    expect(await attemptCount()).toBe(101);
  });

  it.each([
    ['2026-12-31T23:59:59.999Z', '2026-12-31T00:00:00.000Z', '2027-01-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z'],
    ['2027-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z', '2027-01-02T00:00:00.000Z', '2027-01-01T00:00:00.000Z', '2027-02-01T00:00:00.000Z'],
    ['2028-02-29T23:59:59.999Z', '2028-02-29T00:00:00.000Z', '2028-03-01T00:00:00.000Z', '2028-02-01T00:00:00.000Z', '2028-03-01T00:00:00.000Z'],
    ['2026-10-03T23:30:00-07:00', '2026-10-04T00:00:00.000Z', '2026-10-05T00:00:00.000Z', '2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z'],
  ])('computes calendar windows at %s', (at, dayStart, dayEnd, monthStart, monthEnd) => {
    const window = notificationBudgetWindows(new Date(at));
    expect(Object.fromEntries(Object.entries(window).map(([name, date]) => [name, date.toISOString()])))
      .toEqual({ dayStart, dayEnd, monthStart, monthEnd });
  });
});
