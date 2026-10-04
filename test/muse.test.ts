import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { admin } from '../src/admin.js';
import { buildApp } from '../src/app.js';
import { EventSubscriptions } from '../src/events.js';
import { ProviderDispatcher } from '../src/providers/index.js';
import { readiness } from '../src/readiness.js';
import { Relay } from '../src/relay.js';
import { dispatchOne } from '../src/worker.js';
import { testDatabase } from './helpers.js';

let db: Awaited<ReturnType<typeof testDatabase>>;
let relay: Relay;
let muse: { bindingId: string; token: string };
let grok: typeof muse;
beforeAll(async () => { db = await testDatabase(); relay = new Relay(db.pool); });
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.pool.query('TRUNCATE bindings CASCADE');
  muse = await relay.provisionBinding({ ownerId: randomUUID(), runtimeScope: randomUUID(), provider: 'muse' });
  grok = await relay.provisionBinding({ ownerId: randomUUID(), runtimeScope: randomUUID(), provider: 'grok' });
});

it('provisions a Muse credential privately and reports polling without claiming notifications are configured', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anybots-muse-'));
  try {
    const result = await admin(relay, { action: 'provision', ownerId: randomUUID(), runtimeScope: randomUUID(), provider: 'muse' }, directory);
    expect(result).not.toHaveProperty('token');
    if (!('credentialsFile' in result)) throw new Error('Expected credentials file');
    const secret = JSON.parse(await readFile(result.credentialsFile, 'utf8'));
    expect((await stat(result.credentialsFile)).mode & 0o777).toBe(0o600);
    expect(await relay.authenticate(secret.token)).toMatchObject({ provider: 'muse', id: result.bindingId });
    expect(await readiness(db.pool, { bindingId: secret.bindingId }, { notifications: {} })).toMatchObject({
      binding: { provider: 'muse' }, notification: { configured: false, mode: 'poll' }, liveVerification: 'not_verified',
    });
  } finally { await rm(directory, { recursive: true }); }
});

// A real local MCP client and Postgres, with a simulated Grok webhook; not live AI evidence.
it('roundtrips through MCP while only Grok delivery consumes notification budget', async () => {
  await relay.grantPair(muse.bindingId, grok.bindingId);
  const post = vi.fn(async () => ({ status: 202, body: '' }));
  const dispatcher = new ProviderDispatcher(db.pool, { transport: { post }, encryptionKey: randomBytes(32),
    grokExperimental: true, groks: { [grok.bindingId]: {
      url: 'https://api2.cursor.sh/automations/webhook/local-test', secret: 'test-only',
    } } });
  const app = buildApp(relay);
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const client = new Client({ name: 'simulated-muse', version: '1.0.0' }, { versionNegotiation: { mode: 'legacy' } });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${address}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${muse.token}` } },
    }));
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).not.toBe(true);
      return JSON.parse((result.content[0] as { text: string }).text);
    };
    expect(await call('agents_list', {})).toEqual([{ bindingId: grok.bindingId, provider: 'grok' }]);
    const opened = await call('conversation_open', { recipient_binding_id: grok.bindingId,
      text: 'Hello, Grok', expects_reply: true, idempotency_key: randomUUID() });
    expect(await dispatchOne(db.pool, dispatcher)).toBe(true);
    const received = await relay.inboxClaim(grok.token, { conversationId: opened.conversationId });
    await relay.turnFinish(grok.token, { turnId: received!.turnId, result: 'replied', text: 'Hello, Muse',
      expectsReply: false, idempotencyKey: randomUUID() });
    expect(await dispatchOne(db.pool, dispatcher)).toBe(false);
    expect(post).toHaveBeenCalledTimes(1);
    expect((await db.pool.query('SELECT count(*)::int AS n FROM delivery_attempts')).rows[0].n).toBe(1);
    const beforeClaim = await call('conversation_read', { conversation_id: opened.conversationId });
    expect(beforeClaim.outbox.map((row: { status: string }) => row.status).sort()).toEqual(['accepted', 'not_required']);
    expect(beforeClaim.turns).toHaveLength(1);
    const claimed = await call('inbox_claim', { conversation_id: opened.conversationId });
    expect(claimed.message.text).toBe('Hello, Muse');
    const prohibited = await client.callTool({ name: 'turn_finish', arguments: {
      turn_id: claimed.turnId, result: 'replied', text: 'Unwanted loop', expects_reply: false, idempotency_key: randomUUID(),
    } });
    expect(prohibited.isError).toBe(true);
    await call('turn_finish', { turn_id: claimed.turnId, result: 'no_reply', idempotency_key: randomUUID() });
    expect(await call('inbox_claim', { conversation_id: opened.conversationId })).toBeNull();
    const status = await readiness(db.pool, { bindingId: muse.bindingId });
    expect(status.outbox.not_required).toBe(1);
    await call('conversation_close', { conversation_id: opened.conversationId });
  } finally { await client.close(); await app.close(); }
});

it('preserves pair consent, exclusive claiming, revocation and credential disable for Muse', async () => {
  const request = { recipientBindingId: muse.bindingId, text: 'Hello', expectsReply: true, idempotencyKey: randomUUID() };
  await expect(relay.conversationOpen(grok.token, request)).rejects.toMatchObject({ code: 'forbidden' });
  await relay.grantPair(muse.bindingId, grok.bindingId);
  const opened = await relay.conversationOpen(grok.token, request);
  const results = await Promise.all([relay.inboxClaim(muse.token), relay.inboxClaim(muse.token)]);
  const claimed = results.find(Boolean)!;
  expect(results.filter(Boolean)).toHaveLength(1);
  await expect(relay.turnFinish(grok.token, { turnId: claimed.turnId, result: 'no_reply', idempotencyKey: randomUUID() }))
    .rejects.toMatchObject({ code: 'forbidden' });
  await relay.revokePair(muse.bindingId, grok.bindingId);
  await expect(relay.conversationRead(muse.token, { conversationId: opened.conversationId }))
    .rejects.toMatchObject({ code: 'forbidden' });
  await expect(relay.turnFinish(muse.token, { turnId: claimed.turnId, result: 'replied', text: 'late', idempotencyKey: randomUUID() }))
    .rejects.toMatchObject({ code: 'forbidden' });
  await relay.disableBinding(muse.bindingId);
  await expect(relay.authenticate(muse.token)).rejects.toMatchObject({ code: 'unauthorized' });
});

it('does not let Muse subscribe to OpenAI events or dispatch as a dot', async () => {
  const post = vi.fn(async () => ({ status: 200, body: '{}' }));
  const options = { encryptionKey: randomBytes(32), transport: { post } };
  await expect(new EventSubscriptions(db.pool, options).subscribe(muse.bindingId, {
    name: 'inbox.ready', arguments: {}, delivery: { mode: 'webhook', url: 'https://callbacks.example.test/', secret: `whsec_${randomBytes(32).toString('base64')}` },
  })).rejects.toThrow();
  expect(await new ProviderDispatcher(db.pool, options).deliver({ id: randomUUID(), bindingId: muse.bindingId,
    conversationId: randomUUID(), messageId: randomUUID(), provider: 'muse', occurredAt: new Date().toISOString() }))
    .toEqual({ status: 'configuration_required' });
  expect(post).not.toHaveBeenCalled();
});
