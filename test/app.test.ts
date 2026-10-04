import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { buildApp } from '../src/app.js';
import { Relay } from '../src/relay.js';
import { EventSubscriptions } from '../src/events.js';
import { createOwner, provision, testDatabase } from './helpers.js';

describe('authenticated stateless MCP over PostgreSQL', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>;
  let relay: Relay;
  let app: ReturnType<typeof buildApp>;
  let address: string;
  let a: { bindingId: string; token: string };
  let b: typeof a;
  let outsider: typeof a;
  const clients: Client[] = [];
  beforeAll(async () => {
    db = await testDatabase();
    relay = new Relay(db.pool);
    app = buildApp(relay);
    address = await app.listen({ host: '127.0.0.1', port: 0 });
  });
  afterAll(async () => {
    await Promise.all(clients.map((client) => client.close()));
    await app?.close();
    await db?.close();
  });
  beforeEach(async () => {
    a = await provision(relay, db.pool, { provider: 'dots' });
    b = await provision(relay, db.pool, { provider: 'grok' });
    outsider = await provision(relay, db.pool, { provider: 'dots' });
    await relay.grantPair(a.bindingId, b.bindingId);
  });
  async function connect(token: string) {
    const client = new Client({ name: 'anybots-test', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${address}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }));
    return client;
  }
  async function rpc(token: string | undefined, name: string, args: Record<string, unknown> = {}) {
    const response = await app.inject({
      method: 'POST', url: '/mcp',
      headers: { accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    });
    const payload = response.headers['content-type']?.includes('text/event-stream')
      ? JSON.parse(response.body.split('\n').find((line) => line.startsWith('data: '))!.slice(6))
      : response.json();
    return { response, payload };
  }
  function value(result: unknown): Record<string, any> {
    return JSON.parse((result as { content: { text: string }[] }).content[0]!.text);
  }

  it('connects official clients, lists strict schemas, and completes a persisted round trip', async () => {
    const alice = await connect(a.token);
    const bob = await connect(b.token);
    const listed = await alice.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'agents_list', 'conversation_open', 'conversation_read', 'conversation_close',
      'inbox_claim', 'turn_finish', 'connection_manage', 'contact_manage',
    ]));
    const openSchema = listed.tools.find((tool) => tool.name === 'conversation_open')!.inputSchema;
    expect(openSchema.additionalProperties).toBe(false);
    expect(openSchema.properties).not.toHaveProperty('sender_binding_id');
    const opened = value(await alice.callTool({ name: 'conversation_open', arguments: {
      recipient_binding_id: b.bindingId, text: 'Question from Alice', expects_reply: true, idempotency_key: 'open',
    } }));
    const claimed = value(await bob.callTool({ name: 'inbox_claim', arguments: { conversation_id: opened.conversationId } }));
    expect(claimed.message.text).toBe('Question from Alice');
    expect(claimed.message.senderBindingId).toBe(a.bindingId);
    const finish = { turn_id: claimed.turnId, result: 'replied', text: 'Answer from Bob', expects_reply: false, idempotency_key: 'finish' };
    const first = value(await bob.callTool({ name: 'turn_finish', arguments: finish }));
    expect(value(await bob.callTool({ name: 'turn_finish', arguments: finish }))).toEqual(first);
    const read = value(await alice.callTool({ name: 'conversation_read', arguments: { conversation_id: opened.conversationId } }));
    expect(read.messages.map((message: { text: string }) => message.text)).toEqual(['Question from Alice', 'Answer from Bob']);
    expect(read.outbox).toHaveLength(2);
  });

  it('advertises and dispatches authenticated MCP Events through modern SDK requests', async () => {
    const events = new EventSubscriptions(db.pool, {
      encryptionKey: Buffer.alloc(32, 7),
      transport: { async post(_url, body) { return { status: 200, body: JSON.stringify({ challenge: JSON.parse(body).challenge }) }; } },
    });
    const eventApp = buildApp(relay, { events });
    const url = await eventApp.listen({ host: '127.0.0.1', port: 0 });
    const client = new Client({ name: 'events-test', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    let discovery: Record<string, any> | undefined;
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${a.token}` } },
        fetch: async (input, init) => {
          const response = await fetch(input, init);
          if (typeof init?.body === 'string' && JSON.parse(init.body).method === 'server/discover') discovery = await response.clone().json();
          return response;
        },
      }));
      // The generic SDK client strips extension capability names; assert the actual wire response.
      expect(discovery?.result.capabilities).toHaveProperty('events');
      const resultSchema = z.record(z.string(), z.unknown());
      const catalog = await client.request({ method: 'events/list', params: {} }, resultSchema);
      expect(catalog.events).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'inbox.ready' })]));
      const params = { name: 'inbox.ready', arguments: {}, delivery: { mode: 'webhook', url: 'https://callbacks.example.test/inbox', secret: `whsec_${Buffer.alloc(32, 9).toString('base64')}` } };
      const subscription = await client.request({ method: 'events/subscribe', params }, resultSchema);
      expect(subscription.id).toMatch(/^sub_/);
      expect(JSON.stringify(subscription)).not.toContain(params.delivery.secret);
      const stored = await db.pool.query('SELECT binding_id,active FROM event_subscriptions WHERE id=$1', [subscription.id]);
      expect(stored.rows[0]).toEqual({ binding_id: a.bindingId, active: true });
      await client.request({ method: 'events/unsubscribe', params: { ...params, delivery: { mode: 'webhook', url: params.delivery.url } } }, resultSchema);
      expect((await db.pool.query('SELECT active FROM event_subscriptions WHERE id=$1', [subscription.id])).rows[0].active).toBe(false);
      await expect(client.request({ method: 'events/subscribe', params: { name: 'not-an-event' } }, resultSchema)).rejects.toMatchObject({ code: -32602 });
    } finally { await client.close(); await eventApp.close(); }
  });

  it('rejects missing and invalid bearer credentials before MCP dispatch', async () => {
    for (const token of [undefined, 'not-a-valid-token']) {
      const { response, payload } = await rpc(token, 'agents_list');
      expect(response.statusCode).toBe(401);
      expect(response.headers['www-authenticate']).toContain('Bearer');
      expect(payload).toEqual({ error: 'unauthorized' });
      expect(response.body).not.toContain('not-a-valid-token');
    }
  });

  it('rejects unknown tools and invalid or caller-supplied identity parameters', async () => {
    const unknown = await rpc(a.token, 'grant_anything');
    expect(unknown.payload.error ?? unknown.payload.result?.isError).toBeTruthy();
    for (const args of [
      { recipient_binding_id: b.bindingId, text: 'Hello', expects_reply: true, idempotency_key: 'bad', sender_binding_id: b.bindingId },
      { recipient_binding_id: 'not-a-uuid', text: 'Hello', expects_reply: true, idempotency_key: 'bad' },
      { recipient_binding_id: b.bindingId, text: 'あ'.repeat(5500), expects_reply: true, idempotency_key: 'bad' },
    ]) {
      const invalid = await rpc(a.token, 'conversation_open', args);
      expect(invalid.payload.error ?? invalid.payload.result?.isError).toBeTruthy();
    }
    expect((await relay.agentsList(a.token)).map((agent) => agent.id)).toEqual([b.bindingId]);
  });

  it('does not share identity across requests and denies non-participant history or claims', async () => {
    const opened = await relay.conversationOpen(a.token, { recipientBindingId: b.bindingId, text: 'Private', expectsReply: true, idempotencyKey: 'private' });
    for (const tool of ['conversation_read', 'conversation_close', 'inbox_claim']) {
      const { payload } = await rpc(outsider.token, tool, { conversation_id: opened.conversationId });
      expect(payload.result?.isError).toBe(true);
      expect(JSON.stringify(payload)).not.toContain('Private');
    }
    const { payload } = await rpc(b.token, 'conversation_read', { conversation_id: opened.conversationId });
    expect(value(payload.result).messages[0].text).toBe('Private');
    const denied = await rpc(outsider.token, 'conversation_open', { recipient_binding_id: b.bindingId, text: 'No permission', expects_reply: true, idempotency_key: 'no-grant' });
    expect(denied.payload.result?.isError).toBe(true);
  });

  it('limits connection and contact changes to the authenticated actor', async () => {
    const injected = await rpc(a.token, 'connection_manage', { action: 'disable', binding_id: b.bindingId });
    expect(injected.payload.error ?? injected.payload.result?.isError).toBeTruthy();
    const grantAttempt = await rpc(a.token, 'contact_manage', { action: 'grant', recipient_binding_id: outsider.bindingId });
    expect(grantAttempt.payload.error ?? grantAttempt.payload.result?.isError).toBeTruthy();
    const revoked = await rpc(a.token, 'contact_manage', { action: 'revoke', recipient_binding_id: b.bindingId });
    expect(revoked.payload.result?.isError).not.toBe(true);
    expect(await relay.agentsList(a.token)).toEqual([]);
    const disabled = await rpc(a.token, 'connection_manage', { action: 'disable' });
    expect(disabled.payload.result?.isError).not.toBe(true);
    expect((await rpc(a.token, 'agents_list')).response.statusCode).toBe(401);
    expect((await rpc(b.token, 'agents_list')).response.statusCode).toBe(200);
  });

  it('rejects hostile Host and Origin headers and oversized bodies', async () => {
    for (const headers of [{ host: 'attacker.invalid' }, { origin: 'https://attacker.invalid' }, { origin: 'null' }]) {
      const response = await app.inject({ method: 'POST', url: '/mcp', headers: {
        authorization: `Bearer ${a.token}`, accept: 'application/json, text/event-stream', ...headers,
      }, payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
      expect(response.statusCode).toBe(403);
    }
    const response = await app.inject({ method: 'POST', url: '/mcp', headers: {
      authorization: `Bearer ${a.token}`, 'content-type': 'application/json',
    }, payload: JSON.stringify({ text: 'x'.repeat(128 * 1024) }) });
    expect(response.statusCode).toBe(413);
    expect(response.body).toBe('{"error":"body_too_large"}');
  });
});
