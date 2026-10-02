import { createHash, randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OAuthPilot } from '../src/oauth.js';
import { Relay } from '../src/relay.js';
import { testDatabase } from './helpers.js';

const issuer = 'https://relay.example.test';
const redirect = 'https://chatgpt.com/connector_platform_oauth_redirect';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
describe('pilot OAuth authorization code + PKCE over real Postgres', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>;
  let app: FastifyInstance;
  let oauth: OAuthPilot;
  let relay: Relay;
  let binding: { bindingId: string; token: string };
  let clientId: string;
  beforeAll(async () => {
    db = await testDatabase(); relay = new Relay(db.pool);
    oauth = new OAuthPilot(db.pool, { issuer, redirectUris: [redirect, 'cursor://anysphere.cursor-mcp/oauth/callback'] });
    app = Fastify(); oauth.register(app); await app.ready();
  });
  afterAll(async () => { await app?.close(); await db?.close(); });
  beforeEach(async () => {
    await db.pool.query('TRUNCATE oauth_rates,oauth_pending,oauth_pairings,oauth_codes,oauth_tokens,oauth_families,oauth_clients CASCADE');
    binding = await relay.provisionBinding({ ownerId: randomUUID(), runtimeScope: randomUUID(), provider: 'dots' });
    const registration = await app.inject({ method: 'POST', url: '/oauth/register', payload: { redirect_uris: [redirect], client_name: '<script>malicious()</script>', token_endpoint_auth_method: 'none' } });
    expect(registration.statusCode).toBe(201); clientId = registration.json().client_id;
  });
  async function begin(overrides: Record<string, string> = {}) {
    const verifier = randomBytes(32).toString('base64url');
    const query = { response_type: 'code', client_id: clientId, redirect_uri: redirect, resource: oauth.resource,
      scope: 'relay', state: 'state-bound-to-request', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', ...overrides };
    const response = await app.inject({ method: 'GET', url: `/oauth/authorize?${new URLSearchParams(query)}` });
    const cookie = String(response.headers['set-cookie']).split(';')[0]!;
    const formToken = response.body.match(/name="form_token" value="([^"]+)"/)?.[1] ?? '';
    return { verifier, query, response, cookie, formToken };
  }
  async function consent(flow: Awaited<ReturnType<typeof begin>>, pairingCode?: string, cookie = flow.cookie) {
    const code = pairingCode ?? (await oauth.issuePairingCode(binding.bindingId)).pairingCode;
    return app.inject({ method: 'POST', url: '/oauth/authorize', headers: { origin: issuer, cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ form_token: flow.formToken, pairing_code: code, consent: 'connect' }).toString() });
  }
  async function authorize() {
    const flow = await begin(); const response = await consent(flow);
    expect(response.statusCode).toBe(303);
    const location = new URL(String(response.headers.location));
    expect(location.searchParams.get('state')).toBe(flow.query.state);
    expect(location.searchParams.get('iss')).toBe(issuer);
    return { ...flow, code: location.searchParams.get('code')! };
  }
  function exchange(code: string, verifier: string, overrides: Record<string, string> = {}) {
    return app.inject({ method: 'POST', url: '/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: redirect, resource: oauth.resource, code_verifier: verifier, ...overrides }).toString() });
  }
  function refresh(token: string) {
    return app.inject({ method: 'POST', url: '/oauth/token', payload: { grant_type: 'refresh_token', client_id: clientId, resource: oauth.resource, refresh_token: token } });
  }

  it('publishes exact audience and issuer metadata, S256, and public DCR with exact redirects only', async () => {
    expect((await app.inject('/.well-known/oauth-protected-resource/mcp')).json()).toMatchObject({ resource: `${issuer}/mcp`, authorization_servers: [issuer], scopes_supported: ['relay'] });
    expect((await app.inject('/.well-known/oauth-authorization-server')).json()).toMatchObject({ issuer, code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], authorization_response_iss_parameter_supported: true });
    for (const uri of ['https://evil.test/callback', `${redirect}/unexpected`, `${redirect}?evil=1`]) {
      expect((await app.inject({ method: 'POST', url: '/oauth/register', payload: { redirect_uris: [uri] } })).statusCode).toBe(400);
    }
    expect(() => new OAuthPilot(db.pool, { issuer: 'http://public.example', redirectUris: [redirect] })).toThrow();
    expect(() => new OAuthPilot(db.pool, { issuer: 'http://localhost:3000', redirectUris: [redirect] })).toThrow();
    expect(() => new OAuthPilot(db.pool, { issuer: 'http://localhost:3000', redirectUris: [redirect], allowInsecureLocalhost: true })).not.toThrow();
  });
  it('binds escaped consent to secure cookie and one-use form, and stores only credential hashes', async () => {
    const flow = await begin();
    expect(flow.response.statusCode).toBe(200);
    expect(flow.response.body).toContain('name="viewport"');
    expect(flow.response.body).toContain('&lt;script&gt;malicious()&lt;/script&gt;');
    expect(flow.response.body).not.toContain('<script>');
    expect(flow.response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(flow.response.headers['content-security-policy']).toContain("form-action 'self' https://chatgpt.com");
    expect(flow.response.headers['referrer-policy']).toBe('same-origin');
    expect(flow.response.headers['cache-control']).toBe('no-store');
    expect(flow.response.headers['set-cookie']).toContain('HttpOnly; SameSite=Lax');
    expect(flow.response.headers['set-cookie']).toContain('Secure');
    const pairing = await oauth.issuePairingCode(binding.bindingId);
    expect((await consent(flow, pairing.pairingCode, 'anybots_oauth=wrong')).statusCode).toBe(400);
    const response = await consent(flow, pairing.pairingCode);
    expect(response.statusCode).toBe(303);
    expect((await consent(flow, pairing.pairingCode)).statusCode).toBe(400);
    const other = await begin();
    expect((await consent(other, pairing.pairingCode)).statusCode).toBe(400);
    const saved = (await db.pool.query('SELECT hash FROM oauth_pairings')).rows[0].hash;
    expect(saved).toBe(sha(pairing.pairingCode));
    expect(JSON.stringify((await db.pool.query('SELECT * FROM oauth_pending')).rows)).not.toContain(flow.formToken);
  });
  it('rejects wrong PKCE, redirect, resource, client, and code replay; successful tokens have expiry and scope', async () => {
    const flow = await authorize();
    for (const extra of [{ redirect_uri: 'https://evil.test' }, { resource: `${issuer}/other` }, { client_id: 'wrong' }]) {
      expect((await exchange(flow.code, flow.verifier, extra)).statusCode).toBe(400);
    }
    expect((await exchange(flow.code, randomBytes(32).toString('base64url'))).json().error).toBe('invalid_grant');
    const response = await exchange(flow.code, flow.verifier);
    expect(response.statusCode).toBe(200);
    const tokens = response.json();
    expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: 900, scope: 'relay' });
    expect((await oauth.verifyAccessToken(tokens.access_token)).extra).toEqual({ bindingId: binding.bindingId });
    expect(JSON.stringify((await db.pool.query('SELECT * FROM oauth_tokens')).rows)).not.toContain(tokens.access_token);
    expect((await exchange(flow.code, flow.verifier)).json().error).toBe('invalid_grant');
    await expect(oauth.verifyAccessToken(tokens.access_token)).rejects.toMatchObject({ code: 'invalid_token' });
  });
  it('rotates refresh credentials and revokes the entire family on refresh reuse', async () => {
    const flow = await authorize(); const initial = (await exchange(flow.code, flow.verifier)).json();
    const rotatedResponse = await refresh(initial.refresh_token); expect(rotatedResponse.statusCode).toBe(200);
    const rotated = rotatedResponse.json(); expect(rotated.refresh_token).not.toBe(initial.refresh_token);
    await expect(oauth.verifyAccessToken(rotated.access_token)).resolves.toMatchObject({ scopes: ['relay'] });
    expect((await refresh(initial.refresh_token)).json().error).toBe('invalid_grant');
    await expect(oauth.verifyAccessToken(rotated.access_token)).rejects.toMatchObject({ code: 'invalid_token' });
    expect((await refresh(rotated.refresh_token)).json().error).toBe('invalid_grant');
  });
  it('honors access expiry, remote binding disable, and explicit revocation', async () => {
    const flow = await authorize(); const tokens = (await exchange(flow.code, flow.verifier)).json();
    await db.pool.query("UPDATE oauth_tokens SET expires_at=now()-interval '1 second' WHERE hash=$1", [sha(tokens.access_token)]);
    await expect(oauth.verifyAccessToken(tokens.access_token)).rejects.toMatchObject({ code: 'invalid_token' });
    const rotated = (await refresh(tokens.refresh_token)).json();
    await relay.disableBinding(binding.bindingId);
    await expect(oauth.verifyAccessToken(rotated.access_token)).rejects.toMatchObject({ code: 'invalid_token' });
    expect((await refresh(rotated.refresh_token)).json().error).toBe('invalid_grant');
  });
  it('revokes only the matching client family and makes repeated revocation harmless', async () => {
    const flow = await authorize(); const tokens = (await exchange(flow.code, flow.verifier)).json();
    const revoke = (client_id: string) => app.inject({ method: 'POST', url: '/oauth/revoke', payload: { client_id, token: tokens.refresh_token } });
    expect((await revoke('another-client')).statusCode).toBe(200);
    await expect(oauth.verifyAccessToken(tokens.access_token)).resolves.toMatchObject({ scopes: ['relay'] });
    expect((await revoke(clientId)).statusCode).toBe(200);
    expect((await revoke(clientId)).statusCode).toBe(200);
    await expect(oauth.verifyAccessToken(tokens.access_token)).rejects.toMatchObject({ code: 'invalid_token' });
    expect((await refresh(tokens.refresh_token)).json().error).toBe('invalid_grant');
  });
  it('caps wrong pairing attempts and rejects modified scope/resource or cross-origin consent', async () => {
    for (const override of [{ scope: 'admin' }, { resource: `${issuer}/different` }, { code_challenge_method: 'plain' }]) expect((await begin(override)).response.statusCode).toBe(400);
    const flow = await begin(); const pairing = await oauth.issuePairingCode(binding.bindingId);
    const crossOrigin = await app.inject({ method: 'POST', url: '/oauth/authorize', headers: { origin: 'https://evil.test', cookie: flow.cookie }, payload: { form_token: flow.formToken, pairing_code: pairing.pairingCode, consent: 'connect' } });
    expect(crossOrigin.statusCode).toBe(400);
    for (let i = 0; i < 5; i++) {
      const denied = await consent(flow, 'wrong'); expect(denied.statusCode).toBe(400);
      expect(denied.headers['content-type']).toContain('text/html');
      expect(denied.body).toContain('Connection not completed');
      expect(denied.body).not.toContain(pairing.pairingCode);
    }
    expect((await consent(flow, pairing.pairingCode)).statusCode).toBe(400);
    expect((await db.pool.query('SELECT attempts FROM oauth_pending WHERE hash=$1', [sha(flow.formToken)])).rows[0].attempts).toBe(5);
    await db.pool.query("UPDATE oauth_pending SET expires_at=now()-interval '1 second'");
    expect((await consent(flow, pairing.pairingCode)).statusCode).toBe(400);
  });
  it('checks expiration against wall time after waiting for the relay lock', async () => {
    const flow = await authorize();
    const locker = await db.pool.connect();
    await locker.query('SELECT pg_advisory_lock(718401)');
    try {
      await db.pool.query("UPDATE oauth_codes SET expires_at=clock_timestamp()+interval '250 milliseconds' WHERE hash=$1", [sha(flow.code)]);
      // Exercise the same token transaction directly, without the preceding HTTP rate transaction.
      // Its BEGIN happens before the lock wait, so PostgreSQL now() would incorrectly accept the code.
      const exchangeTransaction = oauth as unknown as { exchange(input: unknown): Promise<{ error?: string }> };
      const pending = exchangeTransaction.exchange({ grant_type: 'authorization_code', client_id: clientId, code: flow.code,
        redirect_uri: redirect, resource: oauth.resource, code_verifier: flow.verifier });
      await new Promise(resolve => setTimeout(resolve, 350));
      await locker.query('SELECT pg_advisory_unlock(718401)');
      expect(await pending).toMatchObject({ error: 'invalid_grant' });
      expect((await db.pool.query('SELECT count(*)::int AS n FROM oauth_tokens')).rows[0].n).toBe(0);
    } finally { await locker.query('SELECT pg_advisory_unlock_all()'); locker.release(); }
  });
  it('rejects duplicate form parameters and bounds public registration requests', async () => {
    const duplicate = await app.inject({ method: 'POST', url: '/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'grant_type=refresh_token&grant_type=authorization_code' });
    expect(duplicate.statusCode).toBe(400);
    for (let i = 0; i < 19; i++) {
      const repeated = await app.inject({ method: 'POST', url: '/oauth/register', payload: { redirect_uris: [redirect], client_name: `Other name ${i}` } });
      expect(repeated.statusCode).toBe(201); expect(repeated.json().client_id).toBe(clientId);
    }
    expect((await db.pool.query('SELECT count(*)::int AS n FROM oauth_clients')).rows[0].n).toBe(1);
    expect((await app.inject({ method: 'POST', url: '/oauth/register', payload: { redirect_uris: [redirect] } })).statusCode).toBe(429);
  });
});
