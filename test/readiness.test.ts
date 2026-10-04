import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { admin } from '../src/admin.js';
import { Relay } from '../src/relay.js';
import { createOwner, provision, testDatabase } from './helpers.js';

const resource = 'https://relay.example.test/mcp';
const inspect = async (...args: Parameters<typeof import('../src/readiness.js').readiness>) =>
  (await import('../src/readiness.js')).readiness(...args);

describe('operator onboarding status over real Postgres', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>; let relay: Relay;
  let a: { bindingId: string; token: string; ownerId: string }; let b: typeof a;
  beforeAll(async () => { db = await testDatabase(); relay = new Relay(db.pool); });
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => {
    await db.pool.query('TRUNCATE bindings CASCADE');
    a = await provision(relay, db.pool, { provider: 'dots' });
    b = await provision(relay, db.pool, { provider: 'grok' });
  });

  it('delegates status to the operator reader without changing or completing a connection', async () => {
    const result = await admin(relay, { action: 'status', bindingId: a.bindingId }, '.local', undefined,
      input => inspect(db.pool, input));
    expect(result).toMatchObject({ binding: { exists: true, active: true, provider: 'dots' },
      oauth: { configured: false, activeFamilies: 0 }, peer: null, liveVerification: 'not_verified' });
    expect(await relay.authenticate(a.token)).toMatchObject({ id: a.bindingId });
    expect((await db.pool.query('SELECT count(*)::int AS n FROM oauth_pairings')).rows[0].n).toBe(0);
    await expect(admin(relay, { action: 'status', bindingId: a.bindingId })).rejects.toThrow();
  });

  it('limits counters to the requested pair and returns no message, identity, or credential values', async () => {
    await relay.grantPair(a.bindingId, b.bindingId);
    const sent = await relay.conversationOpen(a.token, { recipientBindingId: b.bindingId,
      text: 'private-message-canary', expectsReply: false, idempotencyKey: randomUUID() });
    await db.pool.query("UPDATE outbox SET status='accepted',last_error='private-error-canary' WHERE message_id=$1", [sent.messageId]);
    await relay.conversationOpen(b.token, { recipientBindingId: a.bindingId,
      text: 'private-reply-canary', expectsReply: false, idempotencyKey: randomUUID() });
    const unrelated = await provision(relay, db.pool, { provider: 'grok' });
    await relay.grantPair(a.bindingId, unrelated.bindingId);
    await relay.conversationOpen(a.token, { recipientBindingId: unrelated.bindingId,
      text: 'unrelated-message', expectsReply: false, idempotencyKey: randomUUID() });
    const result = await inspect(db.pool, { bindingId: a.bindingId, peerBindingId: b.bindingId });
    expect(result.peer).toEqual({ exists: true, active: true, granted: true });
    expect(result.messages).toEqual({ sent: 1, received: 1 });
    expect(result.outbox).toEqual({ pending: 1, accepted: 1, failed: 0, uncertain: 0, cancelled: 0, not_required: 0 });
    const output = JSON.stringify(result);
    for (const secret of [a.token, b.token, a.bindingId, b.bindingId, sent.messageId, sent.conversationId,
      a.ownerId, 'private-message-canary', 'private-reply-canary', 'private-error-canary']) expect(output).not.toContain(secret);
    expect((await inspect(db.pool, { bindingId: a.bindingId })).messages.sent).toBe(2);
    await relay.revokePair(a.bindingId, b.bindingId);
    expect((await inspect(db.pool, { bindingId: a.bindingId, peerBindingId: b.bindingId })).peer?.granted).toBe(false);
  });

  it('excludes expired, revoked, wrong-resource and wrong-scope OAuth authority and its subscriptions', async () => {
    const clientId = randomUUID(); const familyId = randomUUID();
    await db.pool.query("INSERT INTO oauth_clients(id,redirect_uris,name) VALUES($1,'[]','private-client')", [clientId]);
    for (const [revoked, scope, audience, expiry] of [
      [false, 'relay', resource, '1 hour'], [true, 'relay', resource, '1 hour'],
      [false, 'other', resource, '1 hour'], [false, 'relay', 'https://other.test/mcp', '1 hour'],
      [false, 'relay', resource, '-1 hour'],
    ] as const) {
      await db.pool.query(`INSERT INTO oauth_families(id,binding_id,client_id,resource,scope,expires_at,revoked)
        VALUES($1,$2,$3,$4,$5,clock_timestamp()+$6::interval,$7)`,
      [!revoked && scope === 'relay' && audience === resource && expiry === '1 hour' ? familyId : randomUUID(),
        a.bindingId, clientId, audience, scope, expiry, revoked]);
    }
    await db.pool.query(`INSERT INTO event_subscriptions(id,binding_id,event_name,arguments,callback_url,secret_encrypted,expires_at,oauth_family_id)
      VALUES('private-subscription',$1,'inbox.ready','{}','https://private-callback.test/secret','private-encrypted-secret',clock_timestamp()+interval '1 hour',$2)`,
    [a.bindingId, familyId]);
    const options = { oauthResource: resource, notifications: {} };
    const result = await inspect(db.pool, { bindingId: a.bindingId }, options);
    expect(result.oauth).toEqual({ configured: true, activeFamilies: 1 });
    expect(result.notification).toEqual({ configured: true, activeSubscriptions: 1 });
    expect(JSON.stringify(result)).not.toMatch(/private-|https:|secret/);
    await db.pool.query('UPDATE oauth_families SET revoked=true WHERE id=$1', [familyId]);
    const revoked = await inspect(db.pool, { bindingId: a.bindingId }, options);
    expect(revoked.oauth.activeFamilies).toBe(0);
    expect(revoked.notification.activeSubscriptions).toBe(0);
    await db.pool.query('UPDATE oauth_families SET revoked=false WHERE id=$1', [familyId]);
    await relay.disableBinding(a.bindingId);
    const disabled = await inspect(db.pool, { bindingId: a.bindingId }, options);
    expect(disabled.binding.active).toBe(false);
    expect(disabled.oauth.activeFamilies).toBe(0);
    expect(disabled.notification.activeSubscriptions).toBe(0);
  });

  it('reports only configuration evidence for Grok without emitting webhook credentials', async () => {
    const options = { notifications: { grokExperimental: true,
      groks: { [b.bindingId]: { url: 'https://api2.cursor.sh/automations/webhook/private-hook', secret: 'private-hook-secret' } } } };
    const result = await inspect(db.pool, { bindingId: b.bindingId }, options);
    expect(result.notification).toEqual({ configured: true, experimentalEnabled: true, webhookConfigured: true });
    expect(result.oauth.activeFamilies).toBe(0);
    expect(result.liveVerification).toBe('not_verified');
    expect(JSON.stringify(result)).not.toMatch(/private-|cursor|secret|https:/);
    options.notifications.groks[b.bindingId]!.url = 'https://unapproved.example.test/hook';
    expect((await inspect(db.pool, { bindingId: b.bindingId }, options)).notification.webhookConfigured).toBe(false);
  });

  it('distinguishes missing bindings and rejects invalid or self peer selection', async () => {
    const result = await inspect(db.pool, { bindingId: randomUUID(), peerBindingId: b.bindingId });
    expect(result.binding).toEqual({ exists: false, active: false, provider: null });
    expect(result.peer).toEqual({ exists: true, active: true, granted: false });
    expect(result.messages).toEqual({ sent: 0, received: 0 });
    await expect(inspect(db.pool, { bindingId: 'invalid' })).rejects.toThrow();
    await expect(inspect(db.pool, { bindingId: a.bindingId, peerBindingId: a.bindingId })).rejects.toThrow();
  });
});
