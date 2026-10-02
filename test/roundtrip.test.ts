import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { buildApp } from '../src/app.js';
import { EventSubscriptions } from '../src/events.js';
import { ProviderDispatcher } from '../src/providers/index.js';
import type { WebhookTransport } from '../src/providers/transport.js';
import { Relay } from '../src/relay.js';
import { dispatchOne } from '../src/worker.js';
import { testDatabase } from './helpers.js';

// This is a local contract simulation. It does not contact OpenAI, xAI, or a real owner's agent.
describe('local simulated dots/Grok multi-turn relay (not live-provider verification)', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>;
  beforeAll(async () => { db = await testDatabase(); });
  afterAll(async () => { await db?.close(); });

  for (const initiatingProvider of ['dots', 'grok'] as const) {
    it(`${initiatingProvider} initiates; notification, authenticated claim, clarification, and terminal reply stay distinct`, async () => {
      const relay = new Relay(db.pool);
      const dots = await relay.provisionBinding({ ownerId: randomUUID(), runtimeScope: randomUUID(), provider: 'dots' });
      const grok = await relay.provisionBinding({ ownerId: randomUUID(), runtimeScope: randomUUID(), provider: 'grok' });
      await relay.grantPair(dots.bindingId, grok.bindingId);
      const encryptionKey = randomBytes(32);
      const signingKey = randomBytes(32);
      const dotsSecret = `whsec_${signingKey.toString('base64')}`;
      const grokSecret = randomBytes(32).toString('base64url');
      const dotsUrl = `https://callbacks.example.test/${dots.bindingId}`;
      const grokUrl = `https://api2.cursor.sh/automations/webhook/${grok.bindingId}`;
      const delivered: { url: string; body: string; headers: Record<string, string> }[] = [];
      const transport: WebhookTransport = {
        async post(url, body, headers) {
          const payload = JSON.parse(body);
          if (payload.type === 'verification') {
            expect(url).toBe(dotsUrl);
            return { status: 200, body: JSON.stringify({ challenge: payload.challenge }) };
          }
          delivered.push({ url, body, headers });
          // Acknowledge only. MCP processing starts after dispatchOne releases its ordering lock.
          return { status: 202, body: '' };
        },
      };
      const events = new EventSubscriptions(db.pool, { encryptionKey, transport });
      const dispatcher = new ProviderDispatcher(db.pool, {
        encryptionKey, transport, grokExperimental: true,
        groks: { [grok.bindingId]: { url: grokUrl, secret: grokSecret } },
      });
      const app = buildApp(relay, { events });
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      const clients: Client[] = [];
      async function connect(token: string, modern: boolean) {
        const client = new Client({ name: modern ? 'simulated-dot' : 'simulated-grok', version: '1.0.0' }, {
          versionNegotiation: { mode: modern ? { pin: '2026-07-28' } : 'legacy' },
        });
        clients.push(client);
        await client.connect(new StreamableHTTPClientTransport(new URL(`${address}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        }));
        return client;
      }
      async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError, `${name} should succeed`).not.toBe(true);
        return JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
      }
      try {
        const dotClient = await connect(dots.token, true);
        const grokClient = await connect(grok.token, false);
        const subscription = await dotClient.request({ method: 'events/subscribe', params: {
          name: 'inbox.ready', arguments: {}, delivery: { mode: 'webhook', url: dotsUrl, secret: dotsSecret },
        } }, z.object({ id: z.string() }).passthrough());
        const initiator = initiatingProvider === 'dots' ? dotClient : grokClient;
        const responder = initiatingProvider === 'dots' ? grokClient : dotClient;
        const recipient = initiatingProvider === 'dots' ? grok : dots;
        const texts = ['Private draft request', 'Private clarifying question', 'Private clarification', 'Private final answer'];
        const opened = await call(initiator, 'conversation_open', {
          recipient_binding_id: recipient.bindingId, text: texts[0], expects_reply: true, idempotency_key: randomUUID(),
        });
        const conversationId = opened.conversationId as string;
        for (let turn = 0; turn < 4; turn++) {
          const receiver = turn % 2 === 0 ? responder : initiator;
          const receiverBinding = turn % 2 === 0 ? recipient : initiatingProvider === 'dots' ? dots : grok;
          expect(await dispatchOne(db.pool, dispatcher)).toBe(true);
          const sent = delivered.at(-1)!;
          expect(delivered).toHaveLength(turn + 1);
          for (const privateText of texts) expect(sent.body).not.toContain(privateText);
          expect(sent.body).not.toContain(dots.token);
          expect(sent.body).not.toContain(grok.token);
          const payload = JSON.parse(sent.body);
          if (receiverBinding.bindingId === dots.bindingId) {
            expect(sent.url).toBe(dotsUrl);
            expect(payload).toMatchObject({ name: 'inbox.ready', data: { conversationId } });
            expect(sent.headers['X-MCP-Subscription-Id']).toBe(subscription.id);
            const expected = createHmac('sha256', signingKey)
              .update(`${sent.headers['webhook-id']}.${sent.headers['webhook-timestamp']}.${sent.body}`).digest('base64');
            expect(sent.headers['webhook-signature']).toBe(`v1,${expected}`);
          } else {
            expect(sent.url).toBe(grokUrl);
            expect(Object.keys(payload).sort()).toEqual(['conversation_id', 'event', 'message_id', 'notification_id']);
            expect(payload).toMatchObject({ event: 'inbox.ready', conversation_id: conversationId });
            expect(sent.headers.Authorization).toBe(`Bearer ${grokSecret}`);
          }
          // An HTTP acknowledgment has neither claimed the input nor created a reply.
          const accepted = await call(initiator, 'conversation_read', { conversation_id: conversationId });
          expect(accepted.messages).toHaveLength(turn + 1);
          expect(accepted.turns).toHaveLength(turn);
          expect(accepted.outbox.every((outbox: { status: string }) => outbox.status === 'accepted')).toBe(true);
          const claimed = await call(receiver, 'inbox_claim', { conversation_id: conversationId });
          expect(claimed.message.text).toBe(texts[turn]);
          expect(claimed.message.recipientBindingId).toBe(receiverBinding.bindingId);
          if (turn < 3) {
            await call(receiver, 'turn_finish', {
              turn_id: claimed.turnId, result: 'replied', text: texts[turn + 1],
              expects_reply: turn < 2, idempotency_key: randomUUID(),
            });
          } else {
            expect(claimed.message.expectsReply).toBe(false);
            const prohibitedAck = await receiver.callTool({ name: 'turn_finish', arguments: {
              turn_id: claimed.turnId, result: 'replied', text: 'Unwanted acknowledgment loop',
              expects_reply: false, idempotency_key: randomUUID(),
            } });
            expect(prohibitedAck.isError).toBe(true);
            await call(receiver, 'turn_finish', { turn_id: claimed.turnId, result: 'no_reply', idempotency_key: randomUUID() });
          }
        }
        const completed = await call(initiator, 'conversation_read', { conversation_id: conversationId });
        expect(completed.messages.map((message: { text: string }) => message.text)).toEqual(texts);
        expect(completed.messages.map((message: { sequence: number }) => message.sequence)).toEqual([1, 2, 3, 4]);
        expect(completed.turns.every((turn: { status: string }) => turn.status === 'finished')).toBe(true);
        expect(await dispatchOne(db.pool, dispatcher)).toBe(false);
        expect(delivered).toHaveLength(4);
        await call(initiator, 'conversation_close', { conversation_id: conversationId });
      } finally {
        await Promise.all(clients.map((client) => client.close()));
        await app.close();
      }
    });
  }
});
