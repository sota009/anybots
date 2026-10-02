import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { Relay } from '../src/relay.js';
import { dispatchOne } from '../src/worker.js';
import { testDatabase } from './helpers.js';
import { ProviderDispatcher, type Notification, type DeliveryResult } from '../src/providers/index.js';
import pg from 'pg';

let db: Awaited<ReturnType<typeof testDatabase>>;
let relay: Relay;
let a: { bindingId: string; token: string }, b: typeof a;
let conversation: { conversationId: string; messageId: string };
beforeAll(async () => { db = await testDatabase(); relay = new Relay(db.pool); });
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.pool.query("UPDATE outbox SET status='cancelled' WHERE status='pending'");
  a = await relay.provisionBinding({ ownerId: crypto.randomUUID(), runtimeScope: crypto.randomUUID(), provider: 'dots' });
  b = await relay.provisionBinding({ ownerId: crypto.randomUUID(), runtimeScope: crypto.randomUUID(), provider: 'grok' });
  await relay.grantPair(a.bindingId, b.bindingId);
  conversation = await relay.conversationOpen(a.token, { recipientBindingId: b.bindingId, text: 'private content', expectsReply: true, idempotencyKey: crypto.randomUUID() });
});
const read = () => relay.conversationRead(a.token, { conversationId: conversation.conversationId });

it('records receipt separately from replies and never sends message content', async () => {
  let sent: Notification | undefined;
  await dispatchOne(db.pool, { deliver: async (n) => { sent = n; return { status: 'accepted' }; } });
  expect(JSON.stringify(sent)).not.toContain('private content');
  expect(sent?.bindingId).toBe(b.bindingId);
  expect((await read()).outbox[0]!.status).toBe('accepted');
  expect((await read()).messages).toHaveLength(1);
  expect(await dispatchOne(db.pool, { deliver: async () => { throw new Error('no more sends'); } })).toBe(false);
});

it('serializes stop after a started send and cancels sends when stop wins', async () => {
  let release!: () => void, started!: () => void;
  const start = new Promise<void>((r) => { started = r; });
  const barrier = new Promise<void>((r) => { release = r; });
  const sending = dispatchOne(db.pool, { deliver: async () => { started(); await barrier; return { status: 'accepted' }; } });
  await start;
  // Attempt intent is durable before the network can finish.
  expect((await db.pool.query('SELECT status FROM outbox WHERE message_id=$1', [conversation.messageId])).rows[0].status).toBe('uncertain');
  let stopped = false;
  const close = relay.conversationClose(a.token, { conversationId: conversation.conversationId }).then(() => { stopped = true; });
  await new Promise((r) => setTimeout(r, 20));
  expect(stopped).toBe(false);
  release(); await sending; await close;
  expect(await dispatchOne(db.pool, { deliver: async () => { throw new Error('must not send'); } })).toBe(false);

  const next = await relay.conversationOpen(a.token, { recipientBindingId: b.bindingId, text: 'second', expectsReply: true, idempotencyKey: 'second' });
  await relay.conversationClose(b.token, { conversationId: next.conversationId });
  expect(await dispatchOne(db.pool, { deliver: async () => { throw new Error('must not send'); } })).toBe(false);
});

it('keeps ambiguous failures uncertain after worker restart', async () => {
  await dispatchOne(db.pool, { deliver: async () => { throw new Error('connection vanished after request'); } });
  expect((await read()).outbox[0]!.status).toBe('uncertain');
  expect(await dispatchOne(db.pool, { deliver: async () => { throw new Error('no replay'); } })).toBe(false);
});

it('retries only transient responses, keeps identity, and honors Retry-After', async () => {
  const ids: string[] = [];
  const deliver = async (n: Notification): Promise<DeliveryResult> => { ids.push(n.id); return { status: 'retry', retryAfterMs: 120_000 }; };
  await dispatchOne(db.pool, { deliver });
  const wait = await db.pool.query('SELECT extract(epoch from (next_attempt_at-now())) AS seconds FROM outbox WHERE message_id=$1', [conversation.messageId]);
  expect(Number(wait.rows[0].seconds)).toBeGreaterThan(119);
  for (let i = 0; i < 2; i++) {
    await db.pool.query("UPDATE outbox SET next_attempt_at=now() WHERE message_id=$1", [conversation.messageId]);
    await dispatchOne(db.pool, { deliver });
  }
  expect(new Set(ids).size).toBe(1);
  expect(ids).toHaveLength(3);
  expect((await read()).outbox[0]!.status).toBe('failed');
});

it('cancels expired work before sending', async () => {
  await db.pool.query("UPDATE conversations SET expires_at=now()-interval '1 second' WHERE id=$1", [conversation.conversationId]);
  await dispatchOne(db.pool, { deliver: async () => { throw new Error('expired'); } });
  expect((await read()).outbox[0]!.status).toBe('cancelled');
});

it('enforces owner-wide notification limits across bindings', async () => {
  const owner = (await relay.authenticate(b.token)).ownerId;
  await db.pool.query(`INSERT INTO delivery_attempts(id,outbox_id,binding_id,owner_id,status)
    SELECT gen_random_uuid(),o.id,o.binding_id,$2,'accepted' FROM outbox o CROSS JOIN generate_series(1,60)
    WHERE o.message_id=$1`, [conversation.messageId, owner]);
  let sent = false;
  await dispatchOne(db.pool, { deliver: async () => { sent = true; return { status: 'accepted' }; } });
  expect(sent).toBe(false);
  const row = (await db.pool.query('SELECT status,last_error,attempts FROM outbox WHERE message_id=$1', [conversation.messageId])).rows[0];
  expect(row).toEqual({ status: 'pending', last_error: 'rate_limited', attempts: 0 });
});

it('uses the held database connection during dispatch even with a single pool slot', async () => {
  await db.pool.query("UPDATE outbox SET status='cancelled' WHERE status='pending'");
  await relay.conversationOpen(b.token, { recipientBindingId: a.bindingId, text: 'toward dots', expectsReply: true, idempotencyKey: 'dots-direction' });
  const pool = new pg.Pool({ ...db.pool.options, max: 1 });
  try {
    const dispatcher = new ProviderDispatcher(pool, { encryptionKey: Buffer.alloc(32), transport: { post: async () => { throw new Error('unconfigured'); } } });
    expect(await dispatchOne(pool, dispatcher)).toBe(true);
    expect((await pool.query("SELECT last_error FROM outbox WHERE status='failed' ORDER BY created_at DESC LIMIT 1")).rows[0].last_error).toBe('configuration_required');
  } finally { await pool.end(); }
});
