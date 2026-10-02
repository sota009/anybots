import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { EventSubscriptions } from '../src/events.js';
import { OAuthPilot } from '../src/oauth.js';
import { Relay } from '../src/relay.js';
import { testDatabase } from './helpers.js';

let db: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => { db = await testDatabase(); });
afterAll(async () => { await db?.close(); });

it.each(['revocation', 'expiry'] as const)('rejects an MCP subscription when OAuth %s happens during callback verification', async (mode) => {
  const oauth = new OAuthPilot(db.pool, {
    issuer: 'https://relay.example.test', redirectUris: ['https://client.example.test/callback'],
  });
  const relay = new Relay(db.pool, { oauthResource: oauth.resource });
  const binding = await relay.provisionBinding({ ownerId: randomUUID(), runtimeScope: randomUUID(), provider: 'dots' });
  const accessToken = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(accessToken).digest('hex');
  const familyId = randomUUID(), clientId = randomUUID();
  // Seed an issued access token; this regression targets the actual authenticated
  // MCP -> callback -> OAuth revoke interleaving, not the separately tested grant.
  await db.pool.query("INSERT INTO oauth_clients(id,redirect_uris,name) VALUES($1,'[]','race regression')", [clientId]);
  await db.pool.query("INSERT INTO oauth_families(id,binding_id,client_id,resource,scope,expires_at) VALUES($1,$2,$3,$4,'relay',clock_timestamp()+interval '1 day')", [familyId, binding.bindingId, clientId, oauth.resource]);
  await db.pool.query("INSERT INTO oauth_tokens(hash,family_id,kind,expires_at) VALUES($1,$2,'access',clock_timestamp()+interval '15 minutes')", [tokenHash, familyId]);
  let callbackReached = false, revokedThroughHttp = false;
  let app: ReturnType<typeof buildApp>;
  const events = new EventSubscriptions(db.pool, {
    encryptionKey: randomBytes(32),
    transport: {
      async post(_url, body) {
        callbackReached = true;
        if (mode === 'revocation') {
          const revoke = await app.inject({ method: 'POST', url: '/oauth/revoke', payload: { token: accessToken, client_id: clientId } });
          revokedThroughHttp = revoke.statusCode === 200;
        } else {
          await db.pool.query("UPDATE oauth_tokens SET expires_at=clock_timestamp()-interval '1 second' WHERE hash=$1", [tokenHash]);
        }
        return { status: 200, body: JSON.stringify({ challenge: JSON.parse(body).challenge }) };
      },
    },
  });
  app = buildApp(relay, { events, oauth });
  try {
    const method = 'events/subscribe';
    const response = await app.inject({
      method: 'POST', url: '/mcp',
      headers: {
        'mcp-method': method, authorization: `Bearer ${accessToken}`,
        accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28',
      },
      payload: {
        jsonrpc: '2.0', id: 1, method,
        params: {
          name: 'inbox.ready', arguments: {},
          delivery: { mode: 'webhook', url: 'https://callbacks.example.test/events', secret: `whsec_${randomBytes(32).toString('base64')}` },
          _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} },
        },
      },
    });
    expect(callbackReached).toBe(true);
    expect(response.json()).toHaveProperty('error');
    expect(response.json().result).toBeUndefined();
    expect((await db.pool.query('SELECT 1 FROM event_subscriptions WHERE binding_id=$1', [binding.bindingId])).rowCount).toBe(0);
    expect((await db.pool.query('SELECT active FROM bindings WHERE id=$1', [binding.bindingId])).rows[0].active).toBe(true);
    if (mode === 'revocation') {
      expect(revokedThroughHttp).toBe(true);
      expect((await db.pool.query('SELECT revoked FROM oauth_families WHERE id=$1', [familyId])).rows[0].revoked).toBe(true);
    }
    await expect(relay.authenticate(accessToken)).rejects.toMatchObject({ code: 'unauthorized' });
  } finally { await app.close(); }
});
