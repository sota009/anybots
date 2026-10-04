import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventSubscriptions, INBOX_EVENT, subscriptionId } from '../src/events.js';
import { decryptSecret } from '../src/providers/crypto.js';
import { ProviderDispatcher } from '../src/providers/index.js';
import { createOwner, testDatabase } from './helpers.js';
import { buildApp } from '../src/app.js';
import { Relay } from '../src/relay.js';

describe('persistent event subscriptions', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>; let pool: Pool;
  let binding: string; const key = randomBytes(32); const secret = `whsec_${randomBytes(32).toString('base64')}`;
  const url = 'https://callbacks.example.com/events';
  const post = vi.fn(async (_url: string, body: string, _headers: Record<string, string>) => ({ status: 200, body: JSON.stringify({ challenge: JSON.parse(body).challenge }) }));
  let events: EventSubscriptions;
  const input = () => ({ name: INBOX_EVENT, arguments: {}, delivery: { mode: 'webhook', url, secret } });
  beforeAll(async () => { db = await testDatabase(); pool = db.pool; });
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => {
    await pool.query('TRUNCATE bindings CASCADE'); binding = randomUUID();
    const ownerId = await createOwner(pool);
    await pool.query('INSERT INTO bindings(id,owner_id,runtime_scope,provider,token_hash) VALUES($1,$2,$3,$4,$5)', [binding, ownerId, 'alice-dots', 'dots', 'hash']);
    post.mockClear(); post.mockImplementation(async (_url, body) => ({ status: 200, body: JSON.stringify({ challenge: JSON.parse(body).challenge }) }));
    events = new EventSubscriptions(pool, { encryptionKey: key, transport: { post } });
  });
  it('persists encrypted secrets, deterministic identity, and authenticated unsubscribe across restart', async () => {
    const first = await events.subscribe(binding, input());
    const second = await new EventSubscriptions(pool, { encryptionKey: key, transport: { post } }).subscribe(binding, input());
    expect(second.id).toBe(first.id);
    const row = (await pool.query('SELECT * FROM event_subscriptions')).rows[0];
    expect(row.secret_encrypted).not.toContain(secret);
    expect(decryptSecret(row.secret_encrypted, key, first.id)).toBe(secret);
    expect(await pool.query('SELECT count(*) FROM event_subscriptions').then(r => r.rows[0].count)).toBe('1');
    await expect(events.unsubscribe(randomUUID(), input())).rejects.toMatchObject({ reason: 'binding_unavailable' });
    await events.unsubscribe(binding, input()); await events.unsubscribe(binding, input());
    expect((await pool.query('SELECT active FROM event_subscriptions')).rows[0].active).toBe(false);
  });
  it('does not persist callbacks that fail challenge verification', async () => {
    post.mockResolvedValue({ status: 200, body: '{"challenge":"wrong"}' });
    await expect(events.subscribe(binding, input())).rejects.toMatchObject({ code: -32015 });
    expect((await pool.query('SELECT * FROM event_subscriptions')).rowCount).toBe(0);
  });
  it('rechecks revocation after callback verification before persistence', async () => {
    post.mockImplementation(async (_url, body) => {
      await pool.query('UPDATE bindings SET active=false WHERE id=$1', [binding]);
      return { status: 200, body: JSON.stringify({ challenge: JSON.parse(body).challenge }) };
    });
    await expect(events.subscribe(binding, input())).rejects.toMatchObject({ reason: 'binding_unavailable' });
    expect((await pool.query('SELECT * FROM event_subscriptions')).rowCount).toBe(0);
  });
  it('honors a short requested expiry and ignores inactive or expired subscriptions', async () => {
    const result = await events.subscribe(binding, { ...input(), ttlMs: 100 });
    expect(new Date(result.refreshBefore).getTime() - Date.now()).toBeLessThanOrEqual(100);
    await pool.query('UPDATE event_subscriptions SET expires_at=now()-interval \'1 second\'');
    const dispatcher = new ProviderDispatcher(pool, { encryptionKey: key, transport: { post } });
    post.mockClear();
    expect(await dispatcher.deliver({ id: randomUUID(), bindingId: binding, conversationId: randomUUID(), messageId: randomUUID(), provider: 'dots', occurredAt: new Date().toISOString() })).toEqual({ status: 'configuration_required' });
    expect(post).not.toHaveBeenCalled();
  });
  it('signs with old and new secrets during rotation and deactivates gone callbacks', async () => {
    await events.subscribe(binding, input());
    const fresh = `whsec_${randomBytes(32).toString('base64')}`;
    await events.subscribe(binding, { ...input(), delivery: { ...input().delivery, secret: fresh } });
    const dispatcher = new ProviderDispatcher(pool, { encryptionKey: key, transport: { post } });
    post.mockResolvedValue({ status: 410, body: '' });
    const notification = { id: randomUUID(), bindingId: binding, conversationId: randomUUID(), messageId: randomUUID(), provider: 'dots' as const, occurredAt: '2026-10-02T12:00:00Z' };
    expect(await dispatcher.deliver(notification)).toEqual({ status: 'failed' });
    const call = post.mock.calls.at(-1)!;
    expect(call[2]['webhook-signature']!.split(' ')).toHaveLength(2);
    expect(JSON.parse(call[1])).toMatchObject({ eventId: notification.id, timestamp: notification.occurredAt });
    expect((await pool.query('SELECT active FROM event_subscriptions')).rows[0].active).toBe(false);
  });
  it('rejects malformed secrets and unsupported filters without network calls', async () => {
    await expect(events.subscribe(binding, { ...input(), arguments: { owner: 'victim' } })).rejects.toMatchObject({ code: -32602 });
    await expect(events.subscribe(binding, { ...input(), delivery: { ...input().delivery, secret: 'whsec_short' } })).rejects.toMatchObject({ code: -32602 });
    expect(post).not.toHaveBeenCalled();
  });
  it('rejects ambiguous second contexts until the first is explicitly unsubscribed', async () => {
    await events.subscribe(binding, input());
    const second = { ...input(), delivery: { ...input().delivery, url: `${url}/second` } };
    await expect(events.subscribe(binding, second)).rejects.toMatchObject({ reason: 'subscription_context_already_bound' });
    await events.unsubscribe(binding, input());
    await expect(events.subscribe(binding, second)).resolves.toHaveProperty('id');
  });
  it('exposes discovery and a subscription through authenticated official SDK HTTP handling', async () => {
    const token = randomBytes(32).toString('hex');
    await pool.query('UPDATE bindings SET token_hash=$1 WHERE id=$2', [createHash('sha256').update(token).digest('hex'), binding]);
    const app = buildApp(new Relay(pool), { events });
    try {
      const rpc = (method: string, params: unknown) => app.inject({ method: 'POST', url: '/mcp',
        headers: { 'mcp-method': method, authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28' },
        payload: { jsonrpc: '2.0', id: 1, method, params: { ...(params as object), _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } } });
      const discovery = await rpc('server/discover', {});
      expect(discovery.json(), discovery.body).toHaveProperty('result');
      expect(discovery.json().result.capabilities).toHaveProperty('events');
      const catalog = await rpc('events/list', {});
      expect(catalog.json().result.events[0].name).toBe(INBOX_EVENT);
      const subscribed = await rpc('events/subscribe', input());
      expect(subscribed.json().result.id).toMatch(/^sub_/);
      expect((await rpc('events/unsubscribe', input())).json().result.resultType).toBe('complete');
      expect((await pool.query('SELECT active FROM event_subscriptions WHERE binding_id=$1', [binding])).rows[0].active).toBe(false);
    } finally { await app.close(); }
  });
  it('canonicalizes filter order without merging different principals', () => {
    expect(subscriptionId(binding, INBOX_EVENT, url, { a: 1, b: 2 })).toBe(subscriptionId(binding, INBOX_EVENT, url, { b: 2, a: 1 }));
    expect(subscriptionId(binding, INBOX_EVENT, url, {})).not.toBe(subscriptionId('someone-else', INBOX_EVENT, url, {}));
  });
});
