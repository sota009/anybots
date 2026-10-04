import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { OAuthPilot } from '../src/oauth.js';
import { Relay } from '../src/relay.js';
import { buildApp } from '../src/app.js';
import { admin } from '../src/admin.js';
import { createOwner, provision, testDatabase } from './helpers.js';

const issuer = 'https://relay.example.test';
const redirect = 'https://chatgpt.com/connector_platform_oauth_redirect';
let db: Awaited<ReturnType<typeof testDatabase>>;
let directory: string;
beforeAll(async () => { db = await testDatabase(); directory = await mkdtemp(join(tmpdir(), 'anybots-oauth-admin-')); });
afterAll(async () => { await db?.close(); if (directory) await rm(directory, { recursive: true }); });

it('connects operator pairing, browser consent, OAuth tokens and the real MCP authorization boundary', async () => {
  const oauth = new OAuthPilot(db.pool, { issuer, redirectUris: [redirect] });
  const relay = new Relay(db.pool, { oauthResource: oauth.resource });
  const binding = await provision(relay, db.pool, { provider: 'dots' });
  const app = buildApp(relay, { allowedHosts: ['relay.example.test'], oauth });
  const headers = { host: 'relay.example.test' };
  const verifier = randomBytes(32).toString('base64url');
  try {
    const denied = await app.inject({ method: 'POST', url: '/mcp', headers, payload: {} });
    expect(denied.statusCode).toBe(401);
    expect(denied.headers['www-authenticate']).toContain(oauth.resourceMetadataUrl);
    expect((await app.inject({ url: '/.well-known/oauth-protected-resource/mcp', headers })).json().resource).toBe(oauth.resource);
    const registration = await app.inject({ method: 'POST', url: '/oauth/register', headers, payload: { redirect_uris: [redirect], token_endpoint_auth_method: 'none' } });
    expect(registration.statusCode).toBe(201);
    const clientId: string = registration.json().client_id;
    const query = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirect, resource: oauth.resource,
      scope: 'relay', state: 'test-state', code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') });
    const page = await app.inject({ url: `/oauth/authorize?${query}`, headers });
    expect(page.statusCode).toBe(200);
    const formToken = page.body.match(/name="form_token" value="([^"]+)"/)?.[1];
    const cookie = String(page.headers['set-cookie']).split(';')[0]!;
    const provisioned = await admin(relay, { action: 'connect', bindingId: binding.bindingId }, directory, oauth);
    expect(provisioned).not.toHaveProperty('pairingCode');
    if (!('credentialsFile' in provisioned)) throw new Error('Missing private file');
    expect((await stat(provisioned.credentialsFile)).mode & 0o777).toBe(0o600);
    const pairing = JSON.parse(await readFile(provisioned.credentialsFile, 'utf8'));
    const consent = await app.inject({ method: 'POST', url: '/oauth/authorize', headers: { ...headers, origin: issuer, cookie },
      payload: { form_token: formToken, pairing_code: pairing.pairingCode, consent: 'connect' } });
    expect(consent.statusCode).toBe(200);
    expect(consent.headers.location).toBeUndefined();
    expect(consent.headers['cache-control']).toBe('no-store');
    expect(consent.headers['referrer-policy']).toBe('no-referrer');
    const href = consent.body.match(/<a href="([^"]+)">Return to your agent<\/a>/)?.[1];
    expect(href).toBeTruthy();
    const callback = new URL(href!.replace(/&amp;/g, '&'));
    expect(`${callback.origin}${callback.pathname}`).toBe(redirect);
    expect(callback.searchParams.get('state')).toBe('test-state');
    expect(callback.searchParams.get('iss')).toBe(issuer);
    const code = callback.searchParams.get('code');
    const exchange = await app.inject({ method: 'POST', url: '/oauth/token', headers,
      payload: { grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: redirect, resource: oauth.resource, code_verifier: verifier } });
    expect(exchange.statusCode).toBe(200);
    const tokens = exchange.json();
    expect((await relay.authenticate(tokens.access_token)).id).toBe(binding.bindingId);
    await expect(new Relay(db.pool, { oauthResource: 'https://another.example/mcp' }).authenticate(tokens.access_token)).rejects.toMatchObject({ code: 'unauthorized' });
    const call = () => app.inject({ method: 'POST', url: '/mcp', headers: { ...headers, authorization: `Bearer ${tokens.access_token}`, accept: 'application/json, text/event-stream' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'connection_manage', arguments: { action: 'status' } } } });
    const result = await call();
    expect(result.statusCode).toBe(200);
    expect(result.body).toContain(binding.bindingId);
    await app.inject({ method: 'POST', url: '/oauth/revoke', headers, payload: { client_id: clientId, token: tokens.refresh_token } });
    expect((await call()).statusCode).toBe(401);
  } finally { await app.close(); }
});
