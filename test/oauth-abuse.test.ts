import { createHash, randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { OAuthPilot } from '../src/oauth.js';
import { Relay } from '../src/relay.js';
import { testDatabase } from './helpers.js';

const issuer = 'https://relay.example.test';
const redirect = 'https://chatgpt.com/connector_platform_oauth_redirect';

describe('OAuth rate-limit isolation', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>;
  let app: FastifyInstance;
  let oauth: OAuthPilot;
  beforeAll(async () => {
    db = await testDatabase();
    oauth = new OAuthPilot(db.pool, { issuer, redirectUris: [redirect] });
    app = Fastify(); oauth.register(app); await app.ready();
  });
  beforeEach(async () => {
    await db.pool.query('TRUNCATE oauth_rates,oauth_pending,oauth_pairings,oauth_codes,oauth_tokens,oauth_families,oauth_clients CASCADE');
    // Keep the minute bucket stable even when a test starts at a clock boundary.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now());
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { await app?.close(); await db?.close(); });

  const invalidTokenRequest = (remoteAddress: string) => app.inject({
    method: 'POST', url: '/oauth/token', remoteAddress, payload: {},
  });

  it('does not let already-rejected source requests exhaust another clients token allowance', async () => {
    const remoteAddress = '198.51.100.2';
    const relay = new Relay(db.pool);
    const binding = await relay.provisionBinding({ ownerId: randomUUID(), runtimeScope: randomUUID(), provider: 'dots' });
    const registration = await app.inject({ method: 'POST', url: '/oauth/register', remoteAddress,
      payload: { redirect_uris: [redirect] } });
    expect(registration.statusCode).toBe(201);
    const clientId = registration.json().client_id;
    const verifier = randomBytes(32).toString('base64url');
    const query = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirect,
      resource: oauth.resource, state: 'isolated-client', code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url') });
    const begin = await app.inject({ method: 'GET', url: `/oauth/authorize?${query}`, remoteAddress });
    expect(begin.statusCode).toBe(200);
    const formToken = begin.body.match(/name="form_token" value="([^"]+)"/)![1];
    const pairing = await oauth.issuePairingCode(binding.bindingId);
    const consent = await app.inject({ method: 'POST', url: '/oauth/authorize', remoteAddress,
      headers: { origin: issuer, cookie: String(begin.headers['set-cookie']).split(';')[0]! },
      payload: { form_token: formToken, pairing_code: pairing.pairingCode, consent: 'connect' } });
    expect(consent.statusCode).toBe(303);
    const code = new URL(String(consent.headers.location)).searchParams.get('code')!;

    const responses = [];
    for (let i = 0; i < 100; i++) responses.push(await invalidTokenRequest('198.51.100.1'));
    expect(responses.filter(response => response.statusCode === 400)).toHaveLength(20);
    expect(responses.filter(response => response.statusCode === 429)).toHaveLength(80);
    const exchange = await app.inject({ method: 'POST', url: '/oauth/token', remoteAddress,
      payload: { grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: redirect,
        resource: oauth.resource, code_verifier: verifier } });
    expect(exchange.statusCode).toBe(200);
    await expect(oauth.verifyAccessToken(exchange.json().access_token)).resolves.toMatchObject({ clientId });
    const global = await db.pool.query("SELECT hits FROM oauth_rates WHERE bucket LIKE 'all:token:%'");
    expect(global.rows[0].hits).toBe(21);
  });

  it('retains the global ceiling across concurrent requests from different sources', async () => {
    const responses = await Promise.all(Array.from({ length: 100 }, (_, i) =>
      invalidTokenRequest(`198.51.100.${10 + Math.floor(i / 20)}`)));
    expect(responses.every(response => response.statusCode === 400)).toBe(true);
    expect((await invalidTokenRequest('198.51.100.99')).statusCode).toBe(429);
  });
});
