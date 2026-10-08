import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Relay } from '../src/relay.js';
import { provision, testDatabase } from './helpers.js';

/**
 * Issue #43: an Agent with two auto Links can copy one conversation's text
 * to another linked peer. The report sequence is claim → turn_finish →
 * conversation_read → conversation_open. Option A (deny other-conversation
 * reads while a turn is claimed) does not stop that post-turn path.
 */
describe('cross-peer conversation forwarding (issue 43)', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>;
  let relay: Relay;
  let cam: { bindingId: string; token: string };
  let victim: { bindingId: string; token: string };
  let attacker: { bindingId: string; token: string };
  let outsider: { bindingId: string; token: string };

  beforeAll(async () => {
    db = await testDatabase();
    relay = new Relay(db.pool);
  });
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => {
    cam = await provision(relay, db.pool, { provider: 'mcp' });
    victim = await provision(relay, db.pool, { provider: 'mcp' });
    attacker = await provision(relay, db.pool, { provider: 'mcp' });
    outsider = await provision(relay, db.pool, { provider: 'mcp' });
    await relay.grantPair(cam.bindingId, victim.bindingId);
    await relay.grantPair(victim.bindingId, attacker.bindingId);
  });

  it('report sequence: after claim and finish, conversation_read then conversation_open still delivers to another auto Link', async () => {
    const fromCam = await relay.conversationOpen(cam.token, {
      recipientBindingId: victim.bindingId,
      text: 'PRIVATE_FROM_CAM',
      expectsReply: true,
      idempotencyKey: randomUUID(),
    });
    expect(fromCam.approval).toBe('none');

    const claimed = await relay.inboxClaim(victim.token, { conversationId: fromCam.conversationId });
    expect(claimed?.message.text).toBe('PRIVATE_FROM_CAM');
    await relay.turnFinish(victim.token, { turnId: claimed!.turnId, result: 'no_reply', idempotencyKey: randomUUID() });

    const history = await relay.conversationRead(victim.token, { conversationId: fromCam.conversationId });
    expect(history.messages.map((message) => message.text)).toContain('PRIVATE_FROM_CAM');

    const forwarded = await relay.conversationOpen(victim.token, {
      recipientBindingId: attacker.bindingId,
      text: 'forwarded:PRIVATE_FROM_CAM',
      expectsReply: false,
      idempotencyKey: randomUUID(),
    });
    // Residual: post-turn forwarding to an auto Link is still delivered.
    expect(forwarded.approval).toBe('none');

    const stolen = await relay.inboxClaim(attacker.token, { conversationId: forwarded.conversationId });
    expect(stolen?.message.text).toBe('forwarded:PRIVATE_FROM_CAM');
    expect(stolen?.message.senderBindingId).toBe(victim.bindingId);

    const denied = await relay.conversationRead(outsider.token, { conversationId: fromCam.conversationId }).catch((error: { code?: string }) => error);
    expect(denied).toMatchObject({ code: 'forbidden' });
    expect(JSON.stringify(denied)).not.toContain('PRIVATE_FROM_CAM');
    await expect(relay.inboxClaim(outsider.token, { conversationId: fromCam.conversationId })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(relay.conversationOpen(outsider.token, {
      recipientBindingId: victim.bindingId, text: 'unlinked', expectsReply: false, idempotencyKey: randomUUID(),
    })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('denies conversation_read of a different conversation while a turn is claimed', async () => {
    const fromCam = await relay.conversationOpen(cam.token, {
      recipientBindingId: victim.bindingId,
      text: 'PRIVATE_FROM_CAM',
      expectsReply: true,
      idempotencyKey: randomUUID(),
    });
    const fromAttacker = await relay.conversationOpen(attacker.token, {
      recipientBindingId: victim.bindingId,
      text: 'ATTACKER_THREAD',
      expectsReply: true,
      idempotencyKey: randomUUID(),
    });

    const claimed = await relay.inboxClaim(victim.token, { conversationId: fromCam.conversationId });
    expect(claimed?.message.text).toBe('PRIVATE_FROM_CAM');

    const current = await relay.conversationRead(victim.token, { conversationId: fromCam.conversationId });
    expect(current.messages.map((message) => message.text)).toContain('PRIVATE_FROM_CAM');

    const blocked = await relay.conversationRead(victim.token, { conversationId: fromAttacker.conversationId }).catch((error: { code?: string }) => error);
    expect(blocked).toMatchObject({ code: 'runtime_busy' });
    expect(JSON.stringify(blocked)).not.toContain('ATTACKER_THREAD');

    await expect(relay.conversationOpen(victim.token, {
      recipientBindingId: attacker.bindingId, text: 'during-claim', expectsReply: false, idempotencyKey: randomUUID(),
    })).rejects.toMatchObject({ code: 'runtime_busy' });

    await relay.turnFinish(victim.token, { turnId: claimed!.turnId, result: 'no_reply', idempotencyKey: randomUUID() });
    const later = await relay.conversationRead(victim.token, { conversationId: fromAttacker.conversationId });
    expect(later.messages.map((message) => message.text)).toContain('ATTACKER_THREAD');
  });
});
