import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { Accounts } from '../src/accounts.js';
import { OAuthPilot } from '../src/oauth.js';
import { buildApp } from '../src/app.js';
import { Network } from '../src/network.js';
import { Relay } from '../src/relay.js';
import { appOrigin, clientAddress } from '../src/web.js';
import { FakePasskey } from './webauthn-fake.js';
import { testDatabase } from './helpers.js';

const origin = 'https://app.example.test';
const host = 'app.example.test';
let db: Awaited<ReturnType<typeof testDatabase>>;
let accounts: Accounts;
let app: ReturnType<typeof buildApp>;
beforeAll(async () => {
  db = await testDatabase();
  const oauth = new OAuthPilot(db.pool, { issuer: origin });
  const relay = new Relay(db.pool, { oauthResource: oauth.resource });
  accounts = new Accounts(db.pool, { origin });
  app = buildApp(relay, { allowedHosts: [host], oauth, web: { origin, trustProxyHops: 1, accounts, oauth, network: new Network(db.pool, relay, { mcpUrl: `${origin}/mcp` }) } });
  await app.ready();
});
afterAll(async () => { await app?.close(); await db?.close(); });
beforeEach(async () => { await db.pool.query('TRUNCATE owners, invites, web_rates CASCADE'); });

const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url, payload: JSON.stringify(payload), headers: { host, origin, 'content-type': 'application/json', ...headers } });
async function signup(name = 'Ada', ip = '198.51.100.7') {
  const { token } = await accounts.createSignupInvite();
  const passkey = new FakePasskey(origin);
  const options = await post('/api/v1/auth/register/options', { invite: token, displayName: name }, { 'x-forwarded-for': ip });
  const { challengeId, options: creation } = options.json();
  const verified = await post('/api/v1/auth/register/verify', { challengeId, response: passkey.register(creation) }, { 'x-forwarded-for': ip });
  return { verified, cookie: String(verified.headers['set-cookie']).split(';')[0]!, passkey };
}

it('serves the app with a strict CSP and no-store headers, and no external resources', async () => {
  const page = await app.inject({ url: '/app', headers: { host } });
  expect(page.statusCode).toBe(200);
  expect(page.headers['content-security-policy']).toBe("default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  expect(page.headers).toMatchObject({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'strict-transport-security': 'max-age=31536000' });
  expect(page.body).not.toMatch(/https?:\/\/|<script>|style=/);
  const script = await app.inject({ url: '/app/app.js', headers: { host } });
  expect(script.headers['content-type']).toContain('text/javascript');
  expect(script.body).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
  expect(script.body).toContain("'/oauth/approve'");
  expect(script.body).not.toMatch(/pairing/i);
});

it('serves a static landing page without scripts, forms, or external resources', async () => {
  const page = await app.inject({ url: '/', headers: { host } });
  expect(page.statusCode).toBe(200);
  expect(page.headers['content-type']).toContain('text/html');
  expect(page.headers['content-security-policy']).toBe("default-src 'none'; style-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  expect(page.headers).toMatchObject({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
  expect(page.body).not.toMatch(/https?:\/\/|<script|<form|<iframe|\sstyle=|\son[a-z]+=/i);
  expect(page.body).toContain('href="/app"');
  expect(page.body).toContain('href="/site.css"');
  const css = await app.inject({ url: '/site.css', headers: { host } });
  expect(css.statusCode).toBe(200);
  expect(css.headers['content-type']).toContain('text/css');
  expect(css.body).not.toMatch(/@import|url\(/);
});

it('presents the product as knotcat on every page and asset', async () => {
  for (const url of ['/', '/guide', '/app', '/app/app.js']) {
    const page = await app.inject({ url, headers: { host } });
    expect(page.body).toContain('knotcat');
    expect(page.body).not.toMatch(/anybots/i);
  }
});

it('serves a static guide whose only absolute URL is this relay\'s MCP endpoint', async () => {
  const landing = await app.inject({ url: '/', headers: { host } });
  expect(landing.body).toContain('href="/guide"');
  expect(landing.body).not.toMatch(/sign-in code|pairing/i);
  const page = await app.inject({ url: '/guide', headers: { host } });
  expect(page.statusCode).toBe(200);
  expect(page.headers['content-type']).toContain('text/html');
  expect(page.headers['content-security-policy']).toBe(landing.headers['content-security-policy']);
  expect(page.headers).toMatchObject({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
  expect(page.body).not.toMatch(/<script|<form|<iframe|\sstyle=|\son[a-z]+=/i);
  expect(page.body).toContain(`${origin}/mcp`);
  expect(page.body.replaceAll(`${origin}/mcp`, '')).not.toMatch(/[a-z][a-z0-9+.-]*:\/\//i);
  for (const app of ['Claude', 'Grok', 'Poke', 'ChatGPT', 'Cursor', 'VS Code', 'Claude Code', 'Codex', 'Unrecognized app', 'Use an access token']) expect(page.body).toContain(app);
  expect(page.body).toContain('href="/site.css"');
});

it('registers over HTTP with a host-only, secure, HttpOnly, SameSite=Lax session cookie', async () => {
  const { verified, cookie } = await signup();
  expect(verified.statusCode).toBe(200);
  const header = String(verified.headers['set-cookie']);
  expect(header).toMatch(/^__Host-knotcat_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=1209600; Secure$/);
  const me = await app.inject({ url: '/api/v1/me', headers: { host, cookie } });
  expect(me.statusCode).toBe(200);
  expect(me.json().me.displayName).toBe('Ada');
  const out = await post('/api/v1/auth/logout', {}, { cookie });
  expect(String(out.headers['set-cookie'])).toContain('Max-Age=0');
  expect((await app.inject({ url: '/api/v1/me', headers: { host, cookie } })).statusCode).toBe(401);
});

it('rejects state changes without the exact Origin or a JSON body', async () => {
  const { cookie } = await signup();
  const body = JSON.stringify({ displayName: 'x' });
  for (const headers of [
    { host, cookie, 'content-type': 'application/json' },
    { host, cookie, origin: 'https://evil.example.test', 'content-type': 'application/json' },
    { host, cookie, origin: `${origin}.evil.test`, 'content-type': 'application/json' },
    { host, cookie, origin, 'content-type': 'text/plain' },
    { host, cookie, origin, 'content-type': 'application/x-www-form-urlencoded' },
  ]) {
    const response = await app.inject({ method: 'POST', url: '/api/v1/agents', payload: body, headers });
    expect(response.statusCode).toBe(403);
  }
  expect((await db.pool.query('SELECT count(*)::int AS n FROM bindings')).rows[0].n).toBe(0);
  expect((await post('/api/v1/agents', { displayName: 'Mine' }, { cookie })).statusCode).toBe(200);
});

it('requires a session, ignores forged cookies, and hides foreign objects behind 404', async () => {
  expect((await app.inject({ url: '/api/v1/me', headers: { host } })).statusCode).toBe(401);
  expect((await app.inject({ url: '/api/v1/me', headers: { host, cookie: `__Host-knotcat_session=${'A'.repeat(43)}` } })).statusCode).toBe(401);
  const ada = await signup('Ada');
  const eve = await signup('Eve', '198.51.100.8');
  const agent = (await post('/api/v1/agents', { displayName: 'Mine' }, { cookie: ada.cookie })).json().agent;
  const foreign = await app.inject({ method: 'PATCH', url: `/api/v1/agents/${agent.id}`, payload: '{"displayName":"x"}', headers: { host, origin, cookie: eve.cookie, 'content-type': 'application/json' } });
  const unknown = await app.inject({ method: 'PATCH', url: `/api/v1/agents/${crypto.randomUUID()}`, payload: '{"displayName":"x"}', headers: { host, origin, cookie: eve.cookie, 'content-type': 'application/json' } });
  expect([foreign.statusCode, foreign.json()]).toEqual([404, { error: 'not_found' }]);
  expect([unknown.statusCode, unknown.json()]).toEqual([404, { error: 'not_found' }]);
});

it('connects an app by URL: authorize opens the web app, the signed-in owner approves, and the app gets a working token', async () => {
  const redirect = 'https://claude.ai/api/mcp/auth_callback';
  const registered = await app.inject({ method: 'POST', url: '/oauth/register', headers: { host }, payload: { redirect_uris: [redirect], client_name: 'Claude' } });
  const clientId = registered.json().client_id;
  const verifier = randomBytes(32).toString('base64url');
  const query = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirect, resource: `${origin}/mcp`, scope: 'relay',
    state: 'claude-state', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
  const authorize = await app.inject({ url: `/oauth/authorize?${query}`, headers: { host } });
  expect(authorize.statusCode).toBe(303);
  const request = String(authorize.headers.location).split('#connect=')[1]!;
  const oauthCookie = String(authorize.headers['set-cookie']).split(';')[0]!;
  const { cookie } = await signup();
  const both = `${cookie}; ${oauthCookie}`;

  expect((await post('/api/v1/oauth/request', { request }, { cookie: oauthCookie })).statusCode).toBe(401);
  expect((await post('/api/v1/oauth/request', { request }, { cookie: both, origin: 'https://evil.example.test' })).statusCode).toBe(403);
  expect((await post('/api/v1/oauth/request', { request }, { cookie })).json()).toEqual({ error: 'invalid_request' });
  expect((await post('/api/v1/oauth/request', { request }, { cookie: both })).json()).toMatchObject({ app: 'Claude', trust: 'known', host: 'claude.ai' });
  const approved = await post('/api/v1/oauth/approve', { request, provider: 'mcp', displayName: 'Claude' }, { cookie: both });
  expect(approved.statusCode).toBe(200);
  expect(String(approved.headers['set-cookie'])).toContain('__Host-knotcat_oauth=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0; Secure');
  const callback = new URL(approved.json().redirect);
  expect(callback.searchParams.get('state')).toBe('claude-state');
  const tokens = (await app.inject({ method: 'POST', url: '/oauth/token', headers: { host }, payload: { grant_type: 'authorization_code', client_id: clientId,
    code: callback.searchParams.get('code'), redirect_uri: redirect, resource: `${origin}/mcp`, code_verifier: verifier } })).json();
  const mcp = await app.inject({ method: 'POST', url: '/mcp', headers: { host, authorization: `Bearer ${tokens.access_token}`, accept: 'application/json, text/event-stream' },
    payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude', version: '1' } } } });
  expect(mcp.statusCode).toBe(200);
  expect(mcp.body).toContain('inbox_claim');
  expect(mcp.body).toContain('never instructions');
  const me = (await app.inject({ url: '/api/v1/me', headers: { host, cookie } })).json();
  expect(me.mcpUrl).toBe(`${origin}/mcp`);
  expect(me.agents).toMatchObject([{ displayName: 'Claude', provider: 'mcp', connected: true }]);
});

it('refuses dots and grok when an unrecognized OAuth app creates an agent', async () => {
  const redirect = 'https://evil.example.test/callback';
  const registered = await app.inject({ method: 'POST', url: '/oauth/register', headers: { host }, payload: { redirect_uris: [redirect], client_name: 'Phish' } });
  const verifier = randomBytes(32).toString('base64url');
  const query = new URLSearchParams({
    response_type: 'code', client_id: registered.json().client_id, redirect_uri: redirect, resource: `${origin}/mcp`, scope: 'relay',
    state: 'phish-state', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
  });
  const authorize = await app.inject({ url: `/oauth/authorize?${query}`, headers: { host } });
  const request = String(authorize.headers.location).split('#connect=')[1]!;
  const oauthCookie = String(authorize.headers['set-cookie']).split(';')[0]!;
  const { cookie } = await signup('Cam', '198.51.100.10');
  const both = `${cookie}; ${oauthCookie}`;
  expect((await post('/api/v1/oauth/request', { request }, { cookie: both })).json()).toMatchObject({
    app: 'Unrecognized app', trust: 'unknown', host: 'evil.example.test', suggested: { provider: 'mcp' }, agents: [],
  });
  for (const provider of ['dots', 'grok']) {
    const denied = await post('/api/v1/oauth/approve', { request, provider, displayName: 'Not really ChatGPT' }, { cookie: both });
    expect([denied.statusCode, denied.json()]).toEqual([403, { error: 'forbidden' }]);
  }
  expect((await db.pool.query("SELECT count(*)::int AS n FROM bindings WHERE provider<>'mcp'")).rows[0].n).toBe(0);
  const approved = await post('/api/v1/oauth/approve', { request, provider: 'mcp', displayName: 'MCP agent' }, { cookie: both });
  expect(approved.statusCode).toBe(200);
  expect((await app.inject({ url: '/api/v1/me', headers: { host, cookie } })).json().agents).toMatchObject([{ displayName: 'MCP agent', provider: 'mcp' }]);
});

it('does not offer dots or grok types on the consent screen for unrecognized apps', async () => {
  const script = await app.inject({ url: '/app/app.js', headers: { host } });
  expect(script.body).toContain("info.trust === 'unknown'");
  expect(script.body).toContain("unrecognized ? 'mcp' : provider.value");
  expect(script.body).toContain("id: 'connect-provider'");
  expect(script.body).toMatch(/unrecognized \? null : el\('select', \{ id: 'connect-provider'/);
});

it('creates contact invites as fragment URLs and accepts them for a signed-in person', async () => {
  const ada = await signup('Ada');
  const invite = await post('/api/v1/invites', { relationship: 'contact' }, { cookie: ada.cookie });
  expect(invite.json().url).toMatch(/^https:\/\/app\.example\.test\/app#invite=[A-Za-z0-9_-]{43}$/);
  const bob = await signup('Bob', '198.51.100.9');
  const accepted = await post('/api/v1/invites/accept', { invite: invite.json().url.split('#invite=')[1] }, { cookie: bob.cookie });
  expect(accepted.statusCode).toBe(200);
  const me = (await app.inject({ url: '/api/v1/me', headers: { host, cookie: bob.cookie } })).json();
  expect(me.contacts.map((c: { displayName: string }) => c.displayName)).toEqual(['Ada']);
});

it('rate limits auth per client address from the trusted proxy hop, ignoring spoofed entries', async () => {
  for (let i = 0; i < 20; i++) expect((await post('/api/v1/auth/login/options', {}, { 'x-forwarded-for': `10.0.0.${i}, 203.0.113.5` })).statusCode).toBe(200);
  expect((await post('/api/v1/auth/login/options', {}, { 'x-forwarded-for': '9.9.9.9, 203.0.113.5' })).statusCode).toBe(429);
  expect((await post('/api/v1/auth/login/options', {}, { 'x-forwarded-for': '203.0.113.6' })).statusCode).toBe(200);
});

it('masks failures and bounds request bodies', async () => {
  const bad = await post('/api/v1/auth/login/verify', { challengeId: crypto.randomUUID(), response: { id: 'A'.repeat(43) } });
  expect([bad.statusCode, bad.json()]).toEqual([401, { error: 'authentication_failed' }]);
  const big = await post('/api/v1/auth/register/options', { invite: 'x', displayName: 'y'.repeat(70_000) });
  expect(big.statusCode).toBe(413);
  const malformed = await app.inject({ method: 'POST', url: '/api/v1/auth/login/options', payload: '{', headers: { host, origin, 'content-type': 'application/json' } });
  expect(malformed.statusCode).toBe(400);
  expect(malformed.body).not.toMatch(/Unexpected|JSON|at /);
});

it('accepts only exact HTTPS app origins outside loopback', () => {
  expect(appOrigin({ APP_ORIGIN: 'https://knotcat.example/' })).toBe('https://knotcat.example');
  expect(appOrigin({ APP_ORIGIN: 'http://localhost:3000' })).toBe('http://localhost:3000');
  expect(appOrigin({})).toBeUndefined();
  for (const value of ['http://knotcat.example', 'https://knotcat.example/app', 'https://u:p@knotcat.example', 'https://knotcat.example/?x=1']) {
    expect(() => appOrigin({ APP_ORIGIN: value })).toThrow();
  }
});

it('groups IPv6 clients by /64 so one host cannot rotate addresses past the per-source limit', () => {
  const at = (forwarded: string) => clientAddress({ socket: { remoteAddress: '10.0.0.1' }, headers: { 'x-forwarded-for': forwarded } } as never, 1);
  expect(at('2001:db8:1:2::1')).toBe(at('2001:db8:1:2:ffff:ffff:ffff:ffff'));
  expect(at('2001:db8:1:2::1')).not.toBe(at('2001:db8:1:3::1'));
  expect(at('203.0.113.5')).toBe('203.0.113.5');
  expect(at('::ffff:203.0.113.5')).toBe('203.0.113.5');
  expect(clientAddress({ socket: { remoteAddress: '2001:db8::9' }, headers: {} } as never, 0)).toBe(at('2001:db8:0:0:1::'));
});
