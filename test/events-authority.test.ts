import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventSubscriptions, INBOX_EVENT, type EventAuthorization } from '../src/events.js';
import { ProviderDispatcher, type Notification } from '../src/providers/index.js';
import { lockRelay, withTransaction } from '../src/db.js';
import { createOwner, testDatabase, setGrokWebhook } from './helpers.js';

describe('event subscriptions retain their connector authority', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>; let pool: Pool;
  let bindingId: string; let familyId: string;
  let events: EventSubscriptions; let dispatcher: ProviderDispatcher;
  const encryptionKey = randomBytes(32);
  const input = { name: INBOX_EVENT, arguments: {}, delivery: { mode: 'webhook',
    url: 'https://callback.example.com/events', secret: `whsec_${randomBytes(32).toString('base64')}` } };
  const post = vi.fn(async (_url: string, body: string, _headers: Record<string, string>) =>
    ({ status: 200, body: JSON.stringify({ challenge: JSON.parse(body).challenge }) }));
  const notification = (): Notification => ({ id: randomUUID(), bindingId, conversationId: randomUUID(),
    messageId: randomUUID(), provider: 'dots', occurredAt: new Date().toISOString() });
  const authorize: EventAuthorization = async (client: PoolClient) => {
    const family = await client.query(`SELECT id FROM oauth_families
      WHERE id=$1 AND binding_id=$2 AND NOT revoked AND expires_at>clock_timestamp()`, [familyId, bindingId]);
    if (!family.rowCount) throw new Error('authorization_revoked');
    return { oauthFamilyId: familyId };
  };
  beforeAll(async () => { db = await testDatabase(); pool = db.pool; });
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => {
    await pool.query('TRUNCATE bindings,oauth_clients CASCADE');
    bindingId = randomUUID(); familyId = randomUUID();
    const ownerId = await createOwner(pool);
    await pool.query(`INSERT INTO bindings(id,owner_id,runtime_scope,provider,token_hash)
      VALUES($1,$2,'runtime','dots','unused-test-token-hash')`, [bindingId, ownerId]);
    await pool.query(`INSERT INTO oauth_clients(id,redirect_uris,name) VALUES('test-client','[]','Test client')`);
    await pool.query(`INSERT INTO oauth_families(id,binding_id,client_id,resource,scope,expires_at)
      VALUES($1,$2,'test-client','https://relay.example.com/mcp','relay',clock_timestamp()+interval '1 day')`, [familyId, bindingId]);
    post.mockReset(); post.mockImplementation(async (_url, body) =>
      ({ status: 200, body: JSON.stringify({ challenge: JSON.parse(body).challenge }) }));
    events = new EventSubscriptions(pool, { transport: { post }, encryptionKey });
    dispatcher = new ProviderDispatcher(pool, { transport: { post }, encryptionKey });
  });

  it('rejects authority revoked while callback verification is in flight', async () => {
    post.mockImplementation(async (_url, body) => {
      await withTransaction(pool, async client => {
        await lockRelay(client);
        await client.query('UPDATE oauth_families SET revoked=true WHERE id=$1', [familyId]);
      });
      return { status: 200, body: JSON.stringify({ challenge: JSON.parse(body).challenge }) };
    });
    await expect(events.subscribe(bindingId, input, authorize)).rejects.toThrow('authorization_revoked');
    expect((await pool.query('SELECT id FROM event_subscriptions')).rowCount).toBe(0);
  });

  it('does not bypass authority revalidation on a cached refresh or unsubscribe', async () => {
    await events.subscribe(bindingId, input, authorize);
    await pool.query('UPDATE oauth_families SET revoked=true WHERE id=$1', [familyId]);
    post.mockClear();
    await expect(events.subscribe(bindingId, input, authorize)).rejects.toThrow('authorization_revoked');
    await expect(events.unsubscribe(bindingId, input, authorize)).rejects.toThrow('authorization_revoked');
    expect(post).not.toHaveBeenCalled();
    expect((await pool.query('SELECT active,oauth_family_id FROM event_subscriptions')).rows[0]).toEqual({ active: true, oauth_family_id: familyId });
  });

  it('stops deliveries after family revocation even when binding remains active', async () => {
    await events.subscribe(bindingId, input, authorize);
    expect(await dispatcher.deliver(notification())).toEqual({ status: 'accepted' });
    await pool.query('UPDATE oauth_families SET revoked=true WHERE id=$1', [familyId]);
    post.mockClear();
    expect(await dispatcher.deliver(notification())).toEqual({ status: 'configuration_required' });
    expect(post).not.toHaveBeenCalled();
    expect((await pool.query('SELECT active FROM bindings WHERE id=$1', [bindingId])).rows[0].active).toBe(true);
  });

  it('does not downgrade expired or deleted family authority into static authorization', async () => {
    await events.subscribe(bindingId, input, authorize);
    await pool.query(`UPDATE oauth_families SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [familyId]);
    post.mockClear();
    expect(await dispatcher.deliver(notification())).toEqual({ status: 'configuration_required' });
    expect((await pool.query('SELECT oauth_family_id FROM event_subscriptions')).rows[0].oauth_family_id).toBe(familyId);
    await pool.query('DELETE FROM oauth_families WHERE id=$1', [familyId]);
    expect((await pool.query('SELECT id FROM event_subscriptions')).rowCount).toBe(0);
    expect(await dispatcher.deliver(notification())).toEqual({ status: 'configuration_required' });
    expect(post).not.toHaveBeenCalled();
  });

  it('updates family authority on refresh and preserves explicit static pilot authorization', async () => {
    await events.subscribe(bindingId, input);
    expect((await pool.query('SELECT oauth_family_id FROM event_subscriptions')).rows[0].oauth_family_id).toBeNull();
    expect(await dispatcher.deliver(notification())).toEqual({ status: 'accepted' });
    await events.subscribe(bindingId, input, authorize);
    expect((await pool.query('SELECT oauth_family_id FROM event_subscriptions')).rows[0].oauth_family_id).toBe(familyId);
    await pool.query('UPDATE oauth_families SET revoked=true WHERE id=$1', [familyId]);
    expect(await dispatcher.deliver(notification())).toEqual({ status: 'configuration_required' });
  });

  it.each(['revoked', 'expired'])('allows a new authorized callback after the previous family is %s, without replacing a live context', async state => {
    const oldFamilyId = familyId;
    const old = await events.subscribe(bindingId, input, authorize);
    familyId = randomUUID();
    await pool.query(`INSERT INTO oauth_families(id,binding_id,client_id,resource,scope,expires_at)
      VALUES($1,$2,'test-client','https://relay.example.com/mcp','relay',clock_timestamp()+interval '1 day')`, [familyId, bindingId]);
    const replacement = { ...input, delivery: { ...input.delivery, url: 'https://callback.example.com/new-context' } };
    await expect(events.subscribe(bindingId, replacement, authorize)).rejects.toMatchObject({ reason: 'subscription_context_already_bound' });
    if (state === 'revoked') await pool.query('UPDATE oauth_families SET revoked=true WHERE id=$1', [oldFamilyId]);
    else await pool.query(`UPDATE oauth_families SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [oldFamilyId]);
    const current = await events.subscribe(bindingId, replacement, authorize);
    expect(current.id).not.toBe(old.id);
    const rows = (await pool.query('SELECT id,active,oauth_family_id FROM event_subscriptions ORDER BY active')).rows;
    expect(rows).toEqual([
      { id: old.id, active: false, oauth_family_id: oldFamilyId },
      { id: current.id, active: true, oauth_family_id: familyId },
    ]);
    post.mockClear();
    expect(await dispatcher.deliver(notification())).toEqual({ status: 'accepted' });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]![0]).toBe(replacement.delivery.url);
  });

  it.each(['revoked', 'expired', 'resource_mismatch', 'wrong_scope', 'inactive_binding', 'missing_family'])('does not wake Grok after connector authority becomes %s', async state => {
    await pool.query("UPDATE bindings SET provider='grok' WHERE id=$1", [bindingId]);
    await setGrokWebhook(pool, bindingId, encryptionKey, 'https://api2.cursor.sh/automations/webhook/test', 'test-only-webhook-key');
    const grokDispatcher = new ProviderDispatcher(pool, { encryptionKey, transport: { post }, grokExperimental: true,
      webhookHosts: ['api2.cursor.sh'], oauthResource: 'https://relay.example.com/mcp' });
    const wake = { ...notification(), provider: 'grok' as const };
    const client = await pool.connect();
    try {
      expect(await grokDispatcher.deliver(wake)).toEqual({ status: 'accepted' });
      expect(post).toHaveBeenCalledTimes(1);
      if (state === 'revoked') await client.query('UPDATE oauth_families SET revoked=true WHERE id=$1', [familyId]);
      if (state === 'expired') await client.query("UPDATE oauth_families SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [familyId]);
      if (state === 'resource_mismatch') await client.query("UPDATE oauth_families SET resource='https://other.example.com/mcp' WHERE id=$1", [familyId]);
      if (state === 'wrong_scope') await client.query("UPDATE oauth_families SET scope='different' WHERE id=$1", [familyId]);
      if (state === 'inactive_binding') await client.query('UPDATE bindings SET active=false WHERE id=$1', [bindingId]);
      if (state === 'missing_family') await client.query('DELETE FROM oauth_families WHERE id=$1', [familyId]);
      post.mockClear();
      expect(await grokDispatcher.deliver(wake)).toEqual({ status: 'configuration_required' });
      expect(post).not.toHaveBeenCalled();
    } finally { client.release(); }
  });
});
