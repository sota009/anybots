import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Relay } from '../src/relay.js';
import { createOwner, provision, testDatabase } from './helpers.js';

describe('Postgres relay invariants', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>;
  let relay: Relay;
  let a: { bindingId: string; token: string }, b: typeof a;
  beforeAll(async () => { db = await testDatabase(); relay = new Relay(db.pool); });
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => {
    a = await provision(relay, db.pool, { provider: 'dots' });
    b = await provision(relay, db.pool, { provider: 'grok' });
    await relay.grantPair(a.bindingId, b.bindingId);
  });
  const open = (key: string = crypto.randomUUID(), expectsReply = true) => relay.conversationOpen(a.token, { recipientBindingId: b.bindingId, text: 'Question', expectsReply, idempotencyKey: key });

  it('atomically deduplicates concurrent opens and rejects payload reuse', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => open('open-1')));
    expect(new Set(results.map(r => r.conversationId)).size).toBe(1);
    const read = await relay.conversationRead(a.token, { conversationId: results[0]!.conversationId });
    expect(read.messages).toHaveLength(1);
    expect(read.outbox).toHaveLength(1);
    expect(read.outbox[0]!.lastError).toBeNull();
    expect(read.outbox[0]!.updatedAt).toBeInstanceOf(Date);
    await expect(relay.conversationOpen(a.token, { recipientBindingId: b.bindingId, text: 'Different', expectsReply: true, idempotencyKey: 'open-1' })).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });
  it('serializes claims per runtime and stores one reply for concurrent finishes', async () => {
    const c = await open();
    const claims = await Promise.all([relay.inboxClaim(b.token), relay.inboxClaim(b.token)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const turn = claims.find(Boolean)!;
    await expect(relay.conversationOpen(b.token, { recipientBindingId: a.bindingId, text: 'bypass', expectsReply: true, idempotencyKey: 'bypass' })).rejects.toMatchObject({ code: 'runtime_busy' });
    const input = { turnId: turn.turnId, result: 'replied' as const, text: 'Answer', expectsReply: false, idempotencyKey: 'finish-1' };
    const results = await Promise.all([relay.turnFinish(b.token, input), relay.turnFinish(b.token, input)]);
    expect(results[0]).toEqual(results[1]);
    const read = await relay.conversationRead(a.token, { conversationId: c.conversationId });
    expect(read.messages.map(m => m.sequence)).toEqual([1, 2]);
    expect(read.outbox).toHaveLength(2);
    const final = await relay.inboxClaim(a.token);
    await expect(relay.turnFinish(a.token, { turnId: final!.turnId, result: 'replied', text: 'ack loop', expectsReply: false, idempotencyKey: 'no-loop' })).rejects.toMatchObject({ code: 'reply_not_allowed' });
    await relay.turnFinish(a.token, { turnId: final!.turnId, result: 'no_reply', idempotencyKey: 'no-loop' });
  });
  it('stop invalidates a claimed turn and cancels all pending notifications', async () => {
    const c = await open();
    const turn = await relay.inboxClaim(b.token);
    await relay.conversationClose(a.token, { conversationId: c.conversationId });
    await expect(relay.turnFinish(b.token, { turnId: turn!.turnId, result: 'no_reply', idempotencyKey: 'late' })).rejects.toMatchObject({ code: 'conversation_stopped' });
    const read = await relay.conversationRead(a.token, { conversationId: c.conversationId });
    expect(read.status).toBe('closed');
    expect(read.epoch).toBe(1);
    expect(read.outbox.every(o => o.status === 'cancelled')).toBe(true);
    expect(await relay.inboxClaim(b.token)).toBeNull();
  });
  it('marks expired leases uncertain without replay or allowing late writes', async () => {
    const c = await open();
    const turn = await relay.inboxClaim(b.token);
    await db.pool.query("UPDATE turns SET lease_expires_at = now() - interval '1 second' WHERE id=$1", [turn!.turnId]);
    await expect(relay.turnFinish(b.token, { turnId: turn!.turnId, result: 'no_reply', idempotencyKey: 'late' })).rejects.toMatchObject({ code: 'lease_expired' });
    expect(await relay.inboxClaim(b.token)).toBeNull();
    const read = await relay.conversationRead(a.token, { conversationId: c.conversationId });
    expect(read.status).toBe('uncertain');
    expect(read.turns[0]!.status).toBe('uncertain');
  });
  it('returns only public contact identifiers without another owners runtime details', async () => {
    expect(await relay.agentsList(a.token)).toEqual([{ id: b.bindingId, provider: 'grok' }]);
  });

  it('requires active scoped credentials, membership and current bilateral consent', async () => {
    const c = await open();
    const outsider = await provision(relay, db.pool, { provider: 'dots', runtimeScope: 'outsider' });
    await expect(relay.conversationRead(outsider.token, { conversationId: c.conversationId })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(relay.conversationRead('wrong', { conversationId: c.conversationId })).rejects.toMatchObject({ code: 'unauthorized' });
    await relay.revokePair(a.bindingId, b.bindingId);
    await expect(relay.conversationRead(b.token, { conversationId: c.conversationId })).rejects.toMatchObject({ code: 'forbidden' });
    expect(await relay.inboxClaim(b.token)).toBeNull();
    await relay.disableBinding(a.bindingId);
    await expect(relay.agentsList(a.token)).rejects.toMatchObject({ code: 'unauthorized' });
    expect((await db.pool.query('SELECT token_hash FROM bindings WHERE id=$1', [a.bindingId])).rows[0].token_hash).not.toBe(a.token);
  });
  it('rejects oversized input and enforces one active binding per shared runtime', async () => {
    await expect(relay.conversationOpen(a.token, { recipientBindingId: b.bindingId, text: '界'.repeat(6000), expectsReply: true, idempotencyKey: 'large' })).rejects.toMatchObject({ code: 'invalid_input' });
    const binding = await relay.authenticate(a.token);
    await expect(provision(relay, db.pool, { provider: 'grok', runtimeScope: binding.runtimeScope })).rejects.toMatchObject({ code: 'runtime_in_use' });
  });
  it('rolls back the message and conversation when outbox insertion fails', async () => {
    await db.pool.query("CREATE FUNCTION fail_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected persistence failure'; END; $$");
    await db.pool.query('CREATE TRIGGER fail_outbox BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION fail_outbox()');
    try {
      await expect(open('atomic-failure')).rejects.toThrow('injected persistence failure');
      expect((await db.pool.query('SELECT count(*)::int AS count FROM conversations WHERE binding_a=$1', [a.bindingId])).rows[0].count).toBe(0);
      expect((await db.pool.query('SELECT count(*)::int AS count FROM messages WHERE sender_binding_id=$1', [a.bindingId])).rows[0].count).toBe(0);
    } finally {
      await db.pool.query('DROP TRIGGER fail_outbox ON outbox');
      await db.pool.query('DROP FUNCTION fail_outbox()');
    }
  });

  it('bounds each conversation at twelve claims and avoids an unprocessable thirteenth reply', async () => {
    const c = await open();
    for (let index = 0; index < 12; index++) {
      const actor = index % 2 === 0 ? b : a;
      const turn = await relay.inboxClaim(actor.token, { conversationId: c.conversationId });
      expect(turn).not.toBeNull();
      if (index < 11) await relay.turnFinish(actor.token, { turnId: turn!.turnId, result: 'replied', text: `reply ${index}`, expectsReply: true, idempotencyKey: `turn-${index}` });
      else {
        await expect(relay.turnFinish(actor.token, { turnId: turn!.turnId, result: 'replied', text: 'too late', idempotencyKey: 'over-limit' })).rejects.toMatchObject({ code: 'turn_limit' });
        await relay.turnFinish(actor.token, { turnId: turn!.turnId, result: 'no_reply', idempotencyKey: 'last' });
      }
    }
    const read = await relay.conversationRead(a.token, { conversationId: c.conversationId });
    expect(read.status).toBe('limited');
    expect(read.messages).toHaveLength(12);
    expect(read.turns).toHaveLength(12);
    expect(await relay.inboxClaim(b.token, { conversationId: c.conversationId })).toBeNull();
  });

  it('expires conversations and still returns an already committed identical finish', async () => {
    const c = await open();
    const turn = await relay.inboxClaim(b.token);
    const input = { turnId: turn!.turnId, result: 'no_reply' as const, idempotencyKey: 'done' };
    const finished = await relay.turnFinish(b.token, input);
    await db.pool.query("UPDATE conversations SET expires_at=now()-interval '1 second' WHERE id=$1", [c.conversationId]);
    expect(await relay.turnFinish(b.token, input)).toEqual(finished);
    const read = await relay.conversationRead(a.token, { conversationId: c.conversationId });
    expect(read.status).toBe('expired');
    expect(read.outbox.every(o => o.status === 'cancelled')).toBe(true);
  });

  it('limits new conversations across bindings owned by the same owner', async () => {
    const binding = await relay.authenticate(a.token);
    const sibling = await provision(relay, db.pool, { provider: 'dots', ownerId: binding.ownerId });
    await relay.grantPair(sibling.bindingId, b.bindingId);
    // Seed the already committed hourly history; test the boundary itself.
    for (let index = 0; index < 60; index++) {
      await db.pool.query('INSERT INTO conversations(id,binding_a,binding_b) VALUES($1,$2,$3)', [crypto.randomUUID(), sibling.bindingId, b.bindingId]);
    }
    await expect(open()).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('does not permit post-stop writes when finishing and closing race', async () => {
    const c = await open();
    const turn = await relay.inboxClaim(b.token);
    const finish = { turnId: turn!.turnId, result: 'replied' as const, text: 'race', expectsReply: false, idempotencyKey: 'race' };
    const results = await Promise.allSettled([
      relay.conversationClose(a.token, { conversationId: c.conversationId }),
      relay.turnFinish(b.token, finish),
    ]);
    expect(results[0]!.status).toBe('fulfilled');
    const read = await relay.conversationRead(a.token, { conversationId: c.conversationId });
    expect(read.status).toBe('closed');
    expect(read.outbox.every(o => o.status === 'cancelled')).toBe(true);
    expect(read.turns.every(t => t.status !== 'active')).toBe(true);
  });

  it('rolls back a finish and its reply together when reply delivery persistence fails', async () => {
    const c = await open();
    const turn = await relay.inboxClaim(b.token);
    const finish = { turnId: turn!.turnId, result: 'replied' as const, text: 'answer', idempotencyKey: 'retry-after-db-failure' };
    await db.pool.query("CREATE FUNCTION fail_reply_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected reply outbox failure'; END; $$");
    await db.pool.query('CREATE TRIGGER fail_reply_outbox BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION fail_reply_outbox()');
    try {
      await expect(relay.turnFinish(b.token, finish)).rejects.toThrow('injected reply outbox failure');
      const read = await relay.conversationRead(a.token, { conversationId: c.conversationId });
      expect(read.messages).toHaveLength(1);
      expect(read.turns[0]!.status).toBe('active');
    } finally {
      await db.pool.query('DROP TRIGGER fail_reply_outbox ON outbox');
      await db.pool.query('DROP FUNCTION fail_reply_outbox()');
    }
    await relay.turnFinish(b.token, finish);
    const read = await relay.conversationRead(a.token, { conversationId: c.conversationId });
    expect(read.messages.map(m => m.sequence)).toEqual([1, 2]);
    expect(read.turns[0]!.status).toBe('finished');
  });

  it('keeps a stopped external turn uncertain and blocks another claim after rebinding', async () => {
    const c = await open();
    const turn = await relay.inboxClaim(b.token);
    await relay.conversationClose(a.token, { conversationId: c.conversationId });
    const read = await relay.conversationRead(a.token, { conversationId: c.conversationId });
    expect(read.turns[0]!.status).toBe('uncertain');
    await expect(relay.turnFinish(b.token, { turnId: turn!.turnId, result: 'no_reply', idempotencyKey: 'stopped' })).rejects.toMatchObject({ code: 'conversation_stopped' });
    const next = await open();
    expect(await relay.inboxClaim(b.token, { conversationId: next.conversationId })).toBeNull();
    await expect(relay.conversationOpen(b.token, { recipientBindingId: a.bindingId, text: 'bypass', expectsReply: true, idempotencyKey: 'stopped-bypass' })).rejects.toMatchObject({ code: 'runtime_busy' });
    const original = await relay.authenticate(b.token);
    await relay.disableBinding(b.bindingId);
    const replacement = await provision(relay, db.pool, { provider: 'grok', ownerId: original.ownerId, runtimeScope: original.runtimeScope });
    await relay.grantPair(a.bindingId, replacement.bindingId);
    const newer = await relay.conversationOpen(a.token, { recipientBindingId: replacement.bindingId, text: 'new binding', expectsReply: true, idempotencyKey: 'replacement' });
    expect(await relay.inboxClaim(replacement.token, { conversationId: newer.conversationId })).toBeNull();
    await expect(relay.conversationOpen(replacement.token, { recipientBindingId: a.bindingId, text: 'replacement bypass', expectsReply: true, idempotencyKey: 'replacement-bypass' })).rejects.toMatchObject({ code: 'runtime_busy' });
  });

});
