import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Network } from '../src/network.js';
import { Relay } from '../src/relay.js';
import { provision, testDatabase } from './helpers.js';

/**
 * Issue #43: an Agent with two auto Links can copy one conversation's text
 * to another linked peer. Option A denies other-conversation reads while a
 * turn is claimed. Option C1 holds a send to a different peer after
 * conversation_read, for the sending owner to approve.
 */
describe('cross-peer conversation forwarding (issue 43)', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>;
  let relay: Relay;
  let network: Network;
  let cam: { bindingId: string; token: string; ownerId: string };
  let victim: { bindingId: string; token: string; ownerId: string };
  let attacker: { bindingId: string; token: string; ownerId: string };
  let outsider: { bindingId: string; token: string; ownerId: string };

  beforeAll(async () => {
    db = await testDatabase();
    relay = new Relay(db.pool);
    network = new Network(db.pool, relay, { mcpUrl: 'https://relay.example.test/mcp' });
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

  async function camToVictim() {
    const fromCam = await relay.conversationOpen(cam.token, {
      recipientBindingId: victim.bindingId,
      text: 'PRIVATE_FROM_CAM',
      expectsReply: true,
      idempotencyKey: randomUUID(),
    });
    const claimed = await relay.inboxClaim(victim.token, { conversationId: fromCam.conversationId });
    expect(claimed?.message.text).toBe('PRIVATE_FROM_CAM');
    await relay.turnFinish(victim.token, { turnId: claimed!.turnId, result: 'no_reply', idempotencyKey: randomUUID() });
    return fromCam;
  }

  it('report sequence: after claim, finish, and conversation_read, open to another peer is pending and not in the inbox', async () => {
    const fromCam = await camToVictim();
    const history = await relay.conversationRead(victim.token, { conversationId: fromCam.conversationId });
    expect(history.messages.map((message) => message.text)).toContain('PRIVATE_FROM_CAM');

    const forwarded = await relay.conversationOpen(victim.token, {
      recipientBindingId: attacker.bindingId,
      text: 'forwarded:PRIVATE_FROM_CAM',
      expectsReply: false,
      idempotencyKey: randomUUID(),
    });
    expect(forwarded.approval).toBe('pending');
    expect(await relay.inboxClaim(attacker.token, { conversationId: forwarded.conversationId })).toBeNull();
    const attackerView = await relay.conversationRead(attacker.token, { conversationId: forwarded.conversationId });
    expect(attackerView.messages).toEqual([]);
    expect(JSON.stringify(attackerView)).not.toContain('PRIVATE_FROM_CAM');

    const denied = await relay.conversationRead(outsider.token, { conversationId: fromCam.conversationId }).catch((error: { code?: string }) => error);
    expect(denied).toMatchObject({ code: 'forbidden' });
    expect(JSON.stringify(denied)).not.toContain('PRIVATE_FROM_CAM');
    await expect(relay.inboxClaim(outsider.token, { conversationId: fromCam.conversationId })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(relay.conversationOpen(outsider.token, {
      recipientBindingId: victim.bindingId, text: 'unlinked', expectsReply: false, idempotencyKey: randomUUID(),
    })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('same-peer read then reply or open still follows ask=auto', async () => {
    const opened = await relay.conversationOpen(cam.token, {
      recipientBindingId: victim.bindingId,
      text: 'hello same peer',
      expectsReply: true,
      idempotencyKey: randomUUID(),
    });
    const claimed = await relay.inboxClaim(victim.token, { conversationId: opened.conversationId });
    const same = await relay.conversationRead(victim.token, { conversationId: opened.conversationId });
    expect(same.messages.map((message) => message.text)).toContain('hello same peer');
    const replied = await relay.turnFinish(victim.token, {
      turnId: claimed!.turnId, result: 'replied', text: 'answer same peer', expectsReply: false, idempotencyKey: randomUUID(),
    });
    expect(replied.approval).toBe('none');
    const back = await relay.inboxClaim(cam.token, { conversationId: opened.conversationId });
    expect(back?.message.text).toBe('answer same peer');
    await relay.turnFinish(cam.token, { turnId: back!.turnId, result: 'no_reply', idempotencyKey: randomUUID() });

    const reread = await relay.conversationRead(victim.token, { conversationId: opened.conversationId });
    expect(reread.messages.map((message) => message.text)).toEqual(['hello same peer', 'answer same peer']);
    const followUp = await relay.conversationOpen(victim.token, {
      recipientBindingId: cam.bindingId,
      text: 'new thread same peer',
      expectsReply: false,
      idempotencyKey: randomUUID(),
    });
    expect(followUp.approval).toBe('none');
    const received = await relay.inboxClaim(cam.token, { conversationId: followUp.conversationId });
    expect(received?.message.text).toBe('new thread same peer');
  });

  it('sending owner approving a C1 hold delivers it; the recipient owner cannot', async () => {
    const fromCam = await camToVictim();
    await relay.conversationRead(victim.token, { conversationId: fromCam.conversationId });
    const forwarded = await relay.conversationOpen(victim.token, {
      recipientBindingId: attacker.bindingId,
      text: 'forwarded:PRIVATE_FROM_CAM',
      expectsReply: false,
      idempotencyKey: randomUUID(),
    });
    expect(forwarded.approval).toBe('pending');
    expect((await network.overview(victim.ownerId)).approvals.map((row) => row.id)).toEqual([forwarded.messageId]);
    expect((await network.overview(attacker.ownerId)).approvals).toEqual([]);
    expect(JSON.stringify(await network.overview(attacker.ownerId))).not.toContain('PRIVATE_FROM_CAM');
    expect(JSON.stringify(await network.timeline(attacker.ownerId, (await network.overview(attacker.ownerId)).links[0]!.id))).not.toContain('PRIVATE_FROM_CAM');

    const blocked = await relay.decideApproval(attacker.ownerId, forwarded.messageId, 'approve').catch((error: { code?: string }) => error);
    expect(blocked).toMatchObject({ code: 'not_found' });
    expect(JSON.stringify(blocked)).not.toContain('PRIVATE_FROM_CAM');
    expect(await relay.inboxClaim(attacker.token, { conversationId: forwarded.conversationId })).toBeNull();

    await network.decide(victim.ownerId, forwarded.messageId, { decision: 'approve' });
    const stolen = await relay.inboxClaim(attacker.token, { conversationId: forwarded.conversationId });
    expect(stolen?.message.text).toBe('forwarded:PRIVATE_FROM_CAM');
    expect(stolen?.message.senderBindingId).toBe(victim.bindingId);
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

  it('still delivers a claimed body that is opened to another peer without conversation_read', async () => {
    await camToVictim();
    const forwarded = await relay.conversationOpen(victim.token, {
      recipientBindingId: attacker.bindingId,
      text: 'forwarded:PRIVATE_FROM_CAM',
      expectsReply: false,
      idempotencyKey: randomUUID(),
    });
    expect(forwarded.approval).toBe('none');
    const stolen = await relay.inboxClaim(attacker.token, { conversationId: forwarded.conversationId });
    expect(stolen?.message.text).toBe('forwarded:PRIVATE_FROM_CAM');
  });
});
