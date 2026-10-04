import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { Accounts } from '../src/accounts.js';
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
  const relay = new Relay(db.pool);
  accounts = new Accounts(db.pool, { origin });
  app = buildApp(relay, { allowedHosts: [host], web: { origin, trustProxyHops: 1, accounts, network: new Network(db.pool, relay, { mcpUrl: `${origin}/mcp` }) } });
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
});

it('registers over HTTP with a host-only, secure, HttpOnly, SameSite=Lax session cookie', async () => {
  const { verified, cookie } = await signup();
  expect(verified.statusCode).toBe(200);
  const header = String(verified.headers['set-cookie']);
  expect(header).toMatch(/^__Host-anybots_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=1209600; Secure$/);
  const me = await app.inject({ url: '/api/v1/me', headers: { host, cookie } });
  expect(me.statusCode).toBe(200);
  expect(me.json().me.displayName).toBe('Ada');
  const out = await post('/api/v1/auth/logout', {}, { cookie });
  expect(String(out.headers['set-cookie'])).toContain('Max-Age=0');
  expect((await app.inject({ url: '/api/v1/me', headers: { host, cookie } })).statusCode).toBe(401);
});

it('rejects state changes without the exact Origin or a JSON body', async () => {
  const { cookie } = await signup();
  const body = JSON.stringify({ provider: 'muse', displayName: 'x' });
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
  expect((await post('/api/v1/agents', { provider: 'muse', displayName: 'Mine' }, { cookie })).statusCode).toBe(200);
});

it('requires a session, ignores forged cookies, and hides foreign objects behind 404', async () => {
  expect((await app.inject({ url: '/api/v1/me', headers: { host } })).statusCode).toBe(401);
  expect((await app.inject({ url: '/api/v1/me', headers: { host, cookie: `__Host-anybots_session=${'A'.repeat(43)}` } })).statusCode).toBe(401);
  const ada = await signup('Ada');
  const eve = await signup('Eve', '198.51.100.8');
  const agent = (await post('/api/v1/agents', { provider: 'muse', displayName: 'Mine' }, { cookie: ada.cookie })).json().agent;
  const foreign = await app.inject({ method: 'PATCH', url: `/api/v1/agents/${agent.id}`, payload: '{"displayName":"x"}', headers: { host, origin, cookie: eve.cookie, 'content-type': 'application/json' } });
  const unknown = await app.inject({ method: 'PATCH', url: `/api/v1/agents/${crypto.randomUUID()}`, payload: '{"displayName":"x"}', headers: { host, origin, cookie: eve.cookie, 'content-type': 'application/json' } });
  expect([foreign.statusCode, foreign.json()]).toEqual([404, { error: 'not_found' }]);
  expect([unknown.statusCode, unknown.json()]).toEqual([404, { error: 'not_found' }]);
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
  expect(appOrigin({ APP_ORIGIN: 'https://anybots.example/' })).toBe('https://anybots.example');
  expect(appOrigin({ APP_ORIGIN: 'http://localhost:3000' })).toBe('http://localhost:3000');
  expect(appOrigin({})).toBeUndefined();
  for (const value of ['http://anybots.example', 'https://anybots.example/app', 'https://u:p@anybots.example', 'https://anybots.example/?x=1']) {
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
