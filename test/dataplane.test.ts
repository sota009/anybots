import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { Relay } from '../src/relay.js';
import { Signals } from '../src/signals.js';
import { Dispatcher } from '../src/dispatch.js';
import type { Notification } from '../src/providers/index.js';
import { provision, testDatabase } from './helpers.js';

let db: Awaited<ReturnType<typeof testDatabase>>;
let signals: Signals;
let relay: Relay;
let a: { bindingId: string; token: string }, b: typeof a;
beforeAll(async () => {
  db = await testDatabase();
  signals = new Signals(db.pool, { perBinding: 2, total: 3 });
  await signals.start();
  relay = new Relay(db.pool, { signals });
});
afterAll(async () => { await signals?.stop(); await db?.close(); });
beforeEach(async () => {
  await db.pool.query('TRUNCATE bindings CASCADE');
  a = await provision(relay, db.pool, { provider: 'dots' });
  b = await provision(relay, db.pool, { provider: 'mcp' });
  await relay.grantPair(a.bindingId, b.bindingId);
});
const open = (text = 'hello') => relay.conversationOpen(a.token, { recipientBindingId: b.bindingId, text, expectsReply: true, idempotencyKey: randomUUID() });

it('returns a waiting claim as soon as a message commits', async () => {
  expect(signals.listening).toBe(true);
  const started = Date.now();
  const waiting = relay.inboxClaim(b.token, { waitS: 10 });
  await new Promise(r => setTimeout(r, 100));
  await open('arrived');
  const claim = await waiting;
  expect(claim?.message.text).toBe('arrived');
  expect(Date.now() - started).toBeLessThan(3000);
});

it('returns null when the wait times out and rejects waits above 25 seconds', async () => {
  const started = Date.now();
  expect(await relay.inboxClaim(b.token, { waitS: 1 })).toBeNull();
  expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  await expect(relay.inboxClaim(b.token, { waitS: 26 })).rejects.toMatchObject({ code: 'invalid_input' });
});

it('ignores arrivals for other bindings while waiting', async () => {
  const waiting = relay.inboxClaim(a.token, { waitS: 1 });
  await open('for b');
  expect(await waiting).toBeNull();
});

it('caps waiters per binding and falls back to an immediate claim', async () => {
  const waits = [relay.inboxClaim(b.token, { waitS: 2 }), relay.inboxClaim(b.token, { waitS: 2 })];
  await new Promise(r => setTimeout(r, 100));
  const started = Date.now();
  expect(await relay.inboxClaim(b.token, { waitS: 2 })).toBeNull();
  expect(Date.now() - started).toBeLessThan(500);
  await Promise.all(waits);
});

it('finishes a turn and waits for the next input in one call', async () => {
  const first = await open('first');
  const claim = (await relay.inboxClaim(b.token))!;
  const finishing = relay.turnFinish(b.token, { turnId: claim.turnId, result: 'replied', text: 'answer', expectsReply: true, idempotencyKey: 'f1', next: { waitS: 5 } });
  const reply = await relay.inboxClaim(a.token, { waitS: 5 });
  expect(reply?.message.text).toBe('answer');
  await relay.turnFinish(a.token, { turnId: reply!.turnId, result: 'replied', text: 'again', expectsReply: false, idempotencyKey: 'f2' });
  const result = await finishing;
  expect(result.next?.message.text).toBe('again');
  expect(result.next?.conversationId).toBe(first.conversationId);
});

it('wakes a claim that waited behind a busy turn as soon as that turn finishes', async () => {
  await open('one'); await open('two');
  const busy = (await relay.inboxClaim(b.token))!;
  const waiting = relay.inboxClaim(b.token, { waitS: 10 });
  await new Promise(r => setTimeout(r, 100));
  const started = Date.now();
  await relay.turnFinish(b.token, { turnId: busy.turnId, result: 'no_reply', idempotencyKey: randomUUID() });
  expect((await waiting)?.message.text).toBe('two');
  expect(Date.now() - started).toBeLessThan(3000);
});

it('keeps next outside the idempotent request', async () => {
  await open();
  const claim = (await relay.inboxClaim(b.token))!;
  const input = { turnId: claim.turnId, result: 'no_reply' as const, idempotencyKey: 'same' };
  const first = await relay.turnFinish(b.token, input);
  const replay = await relay.turnFinish(b.token, { ...input, next: { waitS: 0 } });
  expect(replay).toEqual({ ...first, next: null });
});

it('delivers immediately after commit through LISTEN, without polling', async () => {
  const grok = await provision(relay, db.pool, { provider: 'grok' });
  await relay.grantPair(a.bindingId, grok.bindingId);
  const sent: Notification[] = [];
  let resolve!: () => void;
  const delivered = new Promise<void>(r => { resolve = r; });
  const dispatcher = new Dispatcher(db.pool, { deliver: async n => { sent.push(n); resolve(); return { status: 'accepted' }; } }, { signals, sweepMs: 60_000 });
  dispatcher.start();
  try {
    await new Promise(r => setTimeout(r, 100));
    const started = Date.now();
    await relay.conversationOpen(a.token, { recipientBindingId: grok.bindingId, text: 'secret body', expectsReply: true, idempotencyKey: randomUUID() });
    await delivered;
    expect(Date.now() - started).toBeLessThan(2000);
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent)).not.toContain('secret body');
  } finally { await dispatcher.stop(); }
});

it('degrades to an immediate claim when LISTEN is unavailable', async () => {
  const offline = new Relay(db.pool, { signals: new Signals(db.pool) });
  const started = Date.now();
  expect(await offline.inboxClaim(b.token, { waitS: 5 })).toBeNull();
  expect(Date.now() - started).toBeLessThan(1000);
});
