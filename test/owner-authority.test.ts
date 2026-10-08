import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { Accounts } from '../src/accounts.js';
import { OAuthPilot } from '../src/oauth.js';
import { buildApp } from '../src/app.js';
import { Network } from '../src/network.js';
import { Relay } from '../src/relay.js';
import { FakePasskey } from './webauthn-fake.js';
import { testDatabase } from './helpers.js';

const origin = 'https://app.example.test';
const host = 'app.example.test';

let db: Awaited<ReturnType<typeof testDatabase>>;
let accounts: Accounts;
let relay: Relay;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  db = await testDatabase();
  const oauth = new OAuthPilot(db.pool, { issuer: origin });
  relay = new Relay(db.pool, { oauthResource: oauth.resource });
  accounts = new Accounts(db.pool, { origin });
  app = buildApp(relay, {
    allowedHosts: [host],
    oauth,
    web: { origin, trustProxyHops: 1, accounts, oauth, network: new Network(db.pool, relay, { mcpUrl: `${origin}/mcp` }) },
  });
  await app.ready();
});
afterAll(async () => { await app?.close(); await db?.close(); });
beforeEach(async () => { await db.pool.query('TRUNCATE owners, invites, web_rates CASCADE'); });

const json = (method: string, url: string, payload: unknown, headers: Record<string, string>) =>
  app.inject({ method, url, payload: JSON.stringify(payload ?? {}), headers: { host, origin, 'content-type': 'application/json', ...headers } });

async function signup(name: string, ip: string) {
  const { token } = await accounts.createSignupInvite();
  const passkey = new FakePasskey(origin);
  const options = await json('POST', '/api/v1/auth/register/options', { invite: token, displayName: name }, { 'x-forwarded-for': ip });
  const { challengeId, options: creation } = options.json();
  const verified = await json('POST', '/api/v1/auth/register/verify', { challengeId, response: passkey.register(creation) }, { 'x-forwarded-for': ip });
  return { cookie: String(verified.headers['set-cookie']).split(';')[0]! };
}

async function linkedOwners() {
  const ada = await signup('Ada', '198.51.100.7');
  const bob = await signup('Bob', '198.51.100.9');
  const adaAgent = (await json('POST', '/api/v1/agents', { displayName: 'Ada bot' }, { cookie: ada.cookie })).json();
  const bobAgent = (await json('POST', '/api/v1/agents', { displayName: 'Bob bot' }, { cookie: bob.cookie })).json();
  const invite = await json('POST', '/api/v1/invites', { relationship: 'contact' }, { cookie: ada.cookie });
  await json('POST', '/api/v1/invites/accept', { invite: invite.json().url.split('#invite=')[1] }, { cookie: bob.cookie });
  const proposed = await json('POST', '/api/v1/links', { agentId: adaAgent.agent.id, peerAgentId: bobAgent.agent.id }, { cookie: ada.cookie });
  await json('POST', '/api/v1/links/:id/accept'.replace(':id', proposed.json().id), {}, { cookie: bob.cookie });
  return {
    ada, bob,
    adaAgentId: adaAgent.agent.id as string,
    bobAgentId: bobAgent.agent.id as string,
    adaToken: adaAgent.connect.token as string,
    bobToken: bobAgent.connect.token as string,
    linkId: proposed.json().id as string,
  };
}

async function rpc(token: string, name: string, args: Record<string, unknown> = {}) {
  const response = await app.inject({
    method: 'POST', url: '/mcp',
    headers: { host, authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
  });
  const payload = response.headers['content-type']?.includes('text/event-stream')
    ? JSON.parse(response.body.split('\n').find((line) => line.startsWith('data: '))!.slice(6))
    : response.json();
  return { response, payload };
}

function toolFailed(payload: { error?: unknown; result?: { isError?: boolean } }) {
  return Boolean(payload.error ?? payload.result?.isError);
}

it('does not let an authenticated MCP connection revoke a link or disable itself', async () => {
  const pair = await linkedOwners();
  const revoked = await rpc(pair.adaToken, 'contact_manage', { action: 'revoke', recipient_binding_id: pair.bobAgentId });
  expect(toolFailed(revoked.payload)).toBe(true);
  expect((await relay.agentsList(pair.adaToken)).map((agent) => agent.id)).toEqual([pair.bobAgentId]);

  const disabled = await rpc(pair.adaToken, 'connection_manage', { action: 'disable' });
  expect(toolFailed(disabled.payload)).toBe(true);
  const stillThere = await rpc(pair.adaToken, 'connection_manage', { action: 'status' });
  expect(stillThere.response.statusCode).toBe(200);
  expect(toolFailed(stillThere.payload)).toBe(false);
  expect((await rpc(pair.adaToken, 'agents_list')).response.statusCode).toBe(200);

  const listed = await app.inject({
    method: 'POST', url: '/mcp',
    headers: { host, authorization: `Bearer ${pair.adaToken}`, accept: 'application/json, text/event-stream' },
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  });
  const tools = (listed.headers['content-type']?.includes('text/event-stream')
    ? JSON.parse(listed.body.split('\n').find((line) => line.startsWith('data: '))!.slice(6))
    : listed.json()).result.tools as { name: string; inputSchema?: { properties?: { action?: { enum?: string[] } } } }[];
  expect(tools.map((tool) => tool.name)).not.toContain('contact_manage');
  const action = tools.find((tool) => tool.name === 'connection_manage')?.inputSchema?.properties?.action;
  expect(action?.enum ?? (action && 'const' in action ? [action.const] : [])).toEqual(['status']);
});

it('lets the signed-in owner revoke a link and disable an agent over the web session', async () => {
  const pair = await linkedOwners();
  const revoked = await json('DELETE', `/api/v1/links/${pair.linkId}`, {}, { cookie: pair.ada.cookie });
  expect(revoked.statusCode).toBe(200);
  expect(revoked.json()).toEqual({ id: pair.linkId, status: 'revoked' });
  expect(await relay.agentsList(pair.adaToken)).toEqual([]);
  expect((await rpc(pair.adaToken, 'agents_list')).response.statusCode).toBe(200);

  const disabled = await json('DELETE', `/api/v1/agents/${pair.adaAgentId}`, {}, { cookie: pair.ada.cookie });
  expect(disabled.statusCode).toBe(200);
  expect(disabled.json()).toEqual({ id: pair.adaAgentId, disabled: true });
  expect((await rpc(pair.adaToken, 'agents_list')).response.statusCode).toBe(401);
  expect((await rpc(pair.bobToken, 'agents_list')).response.statusCode).toBe(200);
});
