import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { buildOAuthProtectedResourceMetadata, getOAuthProtectedResourceMetadataUrl, OAuthError, type AuthInfo } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { isIP } from 'node:net';
import { displayName } from './accounts.js';
import { lockRelay, withTransaction } from './db.js';
import { RelayError } from './errors.js';
import { insertBinding, MAX_AGENTS, PROVIDERS, type Provider } from './relay.js';
import { clientAddress } from './web.js';

const scope = 'relay';
const opaque = () => randomBytes(32).toString('base64url');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const errorPolicy = "default-src 'none'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'";
class Failure extends Error { constructor(readonly error: string, readonly status = 400) { super(error); } }
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new Failure('invalid_request');
  return result.data;
}
const scalar = z.string().min(1).max(2048);
const requestToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const onlyRequest = z.strictObject({ request: requestToken });
const invalidRequest = () => new RelayError('invalid_request', 'Connection request is invalid or expired', 400);
interface Pending { client_id: string; client_name: string; redirect_uri: string; resource: string; state: string; scope: string; challenge: string; cookie_hash: string }
interface Code { binding_id: string; client_id: string; redirect_uri: string; resource: string; scope: string; challenge: string; consumed: boolean; family_id: string | null }
interface Family { id: string; binding_id: string; client_id: string; resource: string; scope: string; expires_at: Date; revoked: boolean }
export interface OAuthOptions { issuer: string; allowInsecureLocalhost?: boolean; trustProxyHops?: number }
export type Trust = 'known' | 'device' | 'unknown';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const NATIVE_CALLBACKS = new Map([['cursor://anysphere.cursor-mcp/oauth/callback', 'Cursor']]);
const KNOWN_APPS: [string, string][] = [['claude.ai', 'Claude'], ['claude.com', 'Claude'], ['chatgpt.com', 'ChatGPT'], ['grok.com', 'Grok'], ['x.ai', 'Grok'],
  ['poke.com', 'Poke'], ['cursor.com', 'Cursor'], ['perplexity.ai', 'Perplexity'], ['vscode.dev', 'VS Code']];

/**
 * The browser navigates to the callback after consent, so only https, loopback http, and fixed
 * native callbacks are allowed; script-capable schemes would run on this origin. The raw spelling
 * must equal the parsed form so aliases cannot slip past exact matching. Loopback identity omits
 * the port because native apps choose a free port per login.
 */
export function redirectIdentity(uri: string): string | undefined {
  if (NATIVE_CALLBACKS.has(uri)) return uri;
  let url: URL;
  try { url = new URL(uri); } catch { return undefined; }
  if (url.href !== uri || url.username || url.password || uri.includes('#') || url.pathname.includes('%')) return undefined;
  if (url.protocol === 'https:') return url.hostname.includes('.') && !isIP(url.hostname) && !url.hostname.startsWith('[') ? uri : undefined;
  if (url.protocol === 'http:' && LOOPBACK.has(url.hostname) && url.port && Number(url.port) > 0) return `http://${url.hostname}${url.pathname}${url.search}`;
  return undefined;
}

export function describeRedirect(uri: string): { app: string; trust: Trust; host: string } {
  const native = NATIVE_CALLBACKS.get(uri);
  if (native) return { app: native, trust: 'device', host: new URL(uri).host };
  const url = new URL(uri);
  if (url.protocol === 'http:') return { app: 'An app on this device', trust: 'device', host: url.host };
  const known = KNOWN_APPS.find(([domain]) => url.hostname === domain || url.hostname.endsWith(`.${domain}`));
  return known ? { app: known[1], trust: 'known', host: url.hostname } : { app: 'Unrecognized app', trust: 'unknown', host: url.hostname };
}

export class OAuthPilot {
  readonly issuer: string;
  readonly resource: string;
  readonly resourceMetadataUrl: string;
  readonly secure: boolean;
  readonly cookieName = 'anybots_oauth';
  private readonly trustProxyHops: number;
  constructor(private readonly pool: Pool, options: OAuthOptions) {
    const issuer = new URL(options.issuer);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(issuer.hostname);
    if (issuer.username || issuer.password || issuer.search || issuer.hash || issuer.pathname !== '/' ||
      (issuer.protocol !== 'https:' && !(options.allowInsecureLocalhost && local && issuer.protocol === 'http:'))) throw new Error('Invalid OAuth issuer');
    this.issuer = issuer.origin;
    this.resource = `${this.issuer}/mcp`;
    this.resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(new URL(this.resource));
    this.secure = issuer.protocol === 'https:';
    this.trustProxyHops = options.trustProxyHops ?? 0;
  }
  cookie(value: string, maxAge: number) {
    return `${this.cookieName}=${value}; HttpOnly; SameSite=Lax; Path=/api/v1/oauth; Max-Age=${maxAge}${this.secure ? '; Secure' : ''}`;
  }
  metadata() {
    return {
      issuer: this.issuer, authorization_endpoint: `${this.issuer}/oauth/authorize`, token_endpoint: `${this.issuer}/oauth/token`,
      registration_endpoint: `${this.issuer}/oauth/register`, revocation_endpoint: `${this.issuer}/oauth/revoke`,
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'],
      scopes_supported: [scope], authorization_response_iss_parameter_supported: true,
    };
  }
  private async tx<T>(work: (client: PoolClient) => Promise<T>) {
    return withTransaction(this.pool, async client => {
      await lockRelay(client);
      await client.query('DELETE FROM oauth_rates WHERE expires_at<clock_timestamp()');
      await client.query('DELETE FROM oauth_pending WHERE expires_at<clock_timestamp()');
      await client.query("DELETE FROM oauth_tokens WHERE kind='access' AND expires_at<clock_timestamp()");
      await client.query("DELETE FROM oauth_codes WHERE expires_at<clock_timestamp()-interval '1 day'");
      await client.query('DELETE FROM oauth_families WHERE expires_at<clock_timestamp()');
      return work(client);
    });
  }
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new OAuthError('invalid_token', 'Invalid access token');
    const result = await this.pool.query<Family & { token_expiry: Date }>(`SELECT f.*,t.expires_at AS token_expiry FROM oauth_tokens t
      JOIN oauth_families f ON f.id=t.family_id JOIN bindings b ON b.id=f.binding_id
      WHERE t.hash=$1 AND t.kind='access' AND NOT t.consumed AND t.expires_at>clock_timestamp()
      AND NOT f.revoked AND f.expires_at>clock_timestamp() AND b.active AND f.resource=$2 AND f.scope=$3`, [hash(token), this.resource, scope]);
    const family = result.rows[0];
    if (!family) throw new OAuthError('invalid_token', 'Invalid access token');
    return { token, clientId: family.client_id, scopes: [scope], expiresAt: Math.floor(family.token_expiry.getTime() / 1000), resource: new URL(this.resource),
      extra: { bindingId: family.binding_id } };
  }
  private async throttle(request: FastifyRequest, endpoint: string) {
    const accepted = await this.tx(async client => {
      if ((await client.query('SELECT count(*)::int AS n FROM oauth_rates')).rows[0].n >= 1024) return false;
      const minute = Math.floor(Date.now() / 60_000);
      // Rejected sources must not consume the shared allowance for other clients.
      // Both admissions remain atomic under the existing relay transaction lock.
      for (const [key, limit] of [[`ip:${hash(clientAddress(request, this.trustProxyHops))}:${endpoint}:${minute}`, 20], [`all:${endpoint}:${minute}`, 100]] as const) {
        const result = await client.query('INSERT INTO oauth_rates(bucket,hits,expires_at) VALUES($1,1,clock_timestamp()+interval \'2 minutes\') ON CONFLICT(bucket) DO UPDATE SET hits=oauth_rates.hits+1 RETURNING hits', [key]);
        if (result.rows[0].hits > limit) return false;
      }
      return true;
    });
    if (!accepted) throw new Failure('temporarily_unavailable', 429);
  }
  register(app: FastifyInstance) {
    const self = this;
    app.register(async routes => {
      routes.setErrorHandler((_error, _request, reply) => reply.code(400).send({ error: 'invalid_request' }));
      routes.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 8192 }, (_request, body, done) => {
        try {
          const values: Record<string, string> = Object.create(null);
          for (const [key, value] of new URLSearchParams(String(body))) {
            if (Object.hasOwn(values, key)) throw new Error('Duplicate parameter');
            values[key] = value;
          }
          done(null, values);
        } catch { done(new Failure('invalid_request')); }
      });
      routes.addHook('onRequest', async (_request, reply) => {
        reply.header('Cache-Control', 'no-store').header('Pragma', 'no-cache').header('Referrer-Policy', 'no-referrer')
          .header('X-Content-Type-Options', 'nosniff').header('Content-Security-Policy', errorPolicy);
      });
      const endpoint = (name: string, fn: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) => async (request: FastifyRequest, reply: FastifyReply) => {
        try { await self.throttle(request, name); return await fn(request, reply); }
        catch (error) {
          reply.code(error instanceof Failure ? error.status : 500);
          if (name === 'authorize') {
            return reply.type('text/html; charset=utf-8').send('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Connection not completed</title><h1>Connection not completed</h1><p>This connection request is invalid or expired. Start again from your AI app.</p></html>');
          }
          return reply.send({ error: error instanceof Failure ? error.error : 'server_error' });
        }
      };
      routes.get('/.well-known/oauth-authorization-server', async () => self.metadata());
      const protectedResource = buildOAuthProtectedResourceMetadata({ oauthMetadata: self.metadata(), resourceServerUrl: new URL(self.resource), scopesSupported: [scope], dangerouslyAllowInsecureIssuerUrl: !self.secure });
      routes.get('/.well-known/oauth-protected-resource/mcp', async () => protectedResource);
      routes.get('/.well-known/oauth-protected-resource', async () => protectedResource);
      routes.post('/oauth/register', { bodyLimit: 8192 }, endpoint('register', async (request, reply) => reply.code(201).send(await self.registerClient(request.body))));
      routes.get('/oauth/authorize', endpoint('authorize', async (request, reply) => {
        const { request: token, cookie } = await self.begin(request.query);
        // Consent happens in the web app; the fragment keeps the request token out of logs and referrers.
        return reply.code(303).header('Set-Cookie', self.cookie(cookie, 600)).header('Location', `${self.issuer}/app#connect=${token}`).send();
      }));
      routes.post('/oauth/token', { bodyLimit: 8192 }, endpoint('token', async (request) => {
        if (request.headers.authorization) throw new Failure('invalid_client', 401);
        const result = await self.exchange(request.body);
        if (result instanceof Failure) throw result;
        return result;
      }));
      routes.post('/oauth/revoke', { bodyLimit: 8192 }, endpoint('revoke', async request => {
        const input = parse(z.object({ token: scalar, client_id: scalar, token_type_hint: z.enum(['access_token', 'refresh_token']).optional() }).strict(), request.body);
        await self.tx(client => client.query(`UPDATE oauth_families SET revoked=true WHERE client_id=$1 AND id IN (SELECT family_id FROM oauth_tokens WHERE hash=$2)`, [input.client_id, hash(input.token)]));
        return {};
      }));
    });
  }
  private async registerClient(input: unknown) {
    const data = parse(z.object({ redirect_uris: z.array(z.string().max(2048)).min(1).max(10), client_name: z.string().min(1).max(100).default('Agent client'),
      token_endpoint_auth_method: z.literal('none').default('none'), grant_types: z.array(z.enum(['authorization_code', 'refresh_token'])).default(['authorization_code', 'refresh_token']),
      response_types: z.array(z.literal('code')).default(['code']), scope: z.literal(scope).optional() }).passthrough(), input);
    const redirectUris = [...new Set(data.redirect_uris)].sort();
    const identities = redirectUris.map(redirectIdentity);
    if (identities.some(uri => uri === undefined)) throw new Failure('invalid_redirect_uri');
    const registeredUris = [...new Set(identities)].sort();
    return this.tx(async client => {
      // Open registration: drop clients that never completed a connection so the bounded registry cannot fill up permanently.
      await client.query(`DELETE FROM oauth_clients c WHERE c.created_at<clock_timestamp()-interval '1 day'
        AND NOT EXISTS (SELECT 1 FROM oauth_families f WHERE f.client_id=c.id) AND NOT EXISTS (SELECT 1 FROM oauth_pending p WHERE p.client_id=c.id)
        AND NOT EXISTS (SELECT 1 FROM oauth_codes o WHERE o.client_id=c.id)`);
      const existing = await client.query<{ id: string; name: string }>('SELECT id,name FROM oauth_clients WHERE redirect_uris=$1::jsonb', [JSON.stringify(registeredUris)]);
      if (!existing.rowCount && (await client.query('SELECT count(*)::int AS n FROM oauth_clients')).rows[0].n >= 500) throw new Failure('temporarily_unavailable', 503);
      const clientId = existing.rows[0]?.id ?? opaque();
      if (!existing.rowCount) await client.query('INSERT INTO oauth_clients(id,redirect_uris,name) VALUES($1,$2,$3)', [clientId, JSON.stringify(registeredUris), data.client_name]);
      return { client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000), redirect_uris: redirectUris, client_name: existing.rows[0]?.name ?? data.client_name,
        token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope };
    });
  }
  private async begin(input: unknown) {
    const data = parse(z.object({ response_type: z.literal('code'), client_id: scalar, redirect_uri: scalar, resource: z.literal(this.resource),
      scope: z.literal(scope).default(scope), state: z.string().min(1).max(1024), code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/), code_challenge_method: z.literal('S256') }).passthrough(), input);
    return this.tx(async client => {
      const found = await client.query<{ redirect_uris: string[] }>('SELECT redirect_uris FROM oauth_clients WHERE id=$1', [data.client_id]);
      const identity = redirectIdentity(data.redirect_uri);
      if (!found.rows[0] || identity === undefined || !found.rows[0].redirect_uris.includes(identity)) throw new Failure('invalid_request');
      if ((await client.query('SELECT count(*)::int AS n FROM oauth_pending')).rows[0].n >= 256) throw new Failure('temporarily_unavailable', 503);
      const token = opaque(), cookie = opaque();
      await client.query(`INSERT INTO oauth_pending(hash,cookie_hash,client_id,redirect_uri,resource,state,scope,challenge,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()+interval '10 minutes')`, [hash(token), hash(cookie), data.client_id, data.redirect_uri, data.resource, data.state, data.scope, data.code_challenge]);
      return { request: token, cookie };
    });
  }
  /** The request token alone is not enough: the cookie set when the app started the flow must match. */
  private async pending<T extends { request: string }>(client: PoolClient, input: unknown, cookie: string, schema: z.ZodType<T>) {
    const parsed = schema.safeParse(input);
    if (!parsed.success) throw new RelayError('invalid_input', 'Invalid arguments', 400);
    const found = await client.query<Pending>(`SELECT p.*,c.name AS client_name FROM oauth_pending p JOIN oauth_clients c ON c.id=p.client_id
      WHERE p.hash=$1 AND NOT p.consumed AND p.expires_at>clock_timestamp() FOR UPDATE OF p`, [hash(parsed.data.request)]);
    const pending = found.rows[0];
    if (!pending || pending.cookie_hash !== hash(cookie) || pending.resource !== this.resource || redirectIdentity(pending.redirect_uri) === undefined) throw invalidRequest();
    return { pending, data: parsed.data, ...describeRedirect(pending.redirect_uri) };
  }
  private finish(pending: Pending, params: Record<string, string>) {
    const redirect = new URL(pending.redirect_uri);
    for (const [key, value] of Object.entries({ ...params, state: pending.state, iss: this.issuer })) redirect.searchParams.set(key, value);
    return { redirect: redirect.href };
  }
  async describe(ownerId: string, input: unknown, cookie: string) {
    return this.tx(async client => {
      const { pending, app, trust, host } = await this.pending(client, input, cookie, onlyRequest);
      const suggestedName = trust === 'known' ? app : trust === 'device' && displayName.safeParse(pending.client_name).success ? pending.client_name : 'MCP agent';
      const agents = trust === 'unknown' ? [] : (await client.query<{ id: string; displayName: string; provider: Provider }>(
        'SELECT id,display_name AS "displayName",provider FROM bindings WHERE owner_id=$1 AND active ORDER BY created_at', [ownerId])).rows;
      return { app, trust, host, clientName: pending.client_name, suggested: { provider: host === 'chatgpt.com' ? 'dots' : 'mcp', displayName: suggestedName }, agents };
    });
  }
  async approve(ownerId: string, input: unknown, cookie: string) {
    const schema = z.union([z.strictObject({ request: requestToken, agentId: z.uuid() }), z.strictObject({ request: requestToken, provider: z.enum(PROVIDERS), displayName })]);
    return this.tx(async client => {
      const { pending, trust, data } = await this.pending(client, input, cookie, schema);
      let bindingId: string;
      if ('agentId' in data) {
        // A code for an unrecognized callback may reach an attacker, so it must never carry an agent that already has links.
        if (trust === 'unknown') throw new RelayError('forbidden', 'Unrecognized apps can only create a new agent', 403);
        const found = await client.query('SELECT 1 FROM bindings WHERE id=$1 AND owner_id=$2 AND active', [data.agentId, ownerId]);
        if (!found.rowCount) throw new RelayError('not_found', 'Not found', 404);
        bindingId = data.agentId;
      } else {
        bindingId = (await insertBinding(client, { ownerId, runtimeScope: randomUUID(), provider: data.provider, displayName: data.displayName, maxActive: MAX_AGENTS })).bindingId;
      }
      await client.query('UPDATE oauth_pending SET consumed=true WHERE hash=$1', [hash(data.request)]);
      const code = opaque();
      await client.query(`INSERT INTO oauth_codes(hash,binding_id,client_id,redirect_uri,resource,scope,challenge,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+interval '2 minutes')`, [hash(code), bindingId, pending.client_id, pending.redirect_uri, pending.resource, pending.scope, pending.challenge]);
      return this.finish(pending, { code });
    });
  }
  async deny(_ownerId: string, input: unknown, cookie: string) {
    return this.tx(async client => {
      const { pending, data } = await this.pending(client, input, cookie, onlyRequest);
      await client.query('UPDATE oauth_pending SET consumed=true WHERE hash=$1', [hash(data.request)]);
      return this.finish(pending, { error: 'access_denied' });
    });
  }
  private async exchange(input: unknown) {
    const data = parse(z.discriminatedUnion('grant_type', [
      z.object({ grant_type: z.literal('authorization_code'), client_id: scalar, code: scalar, redirect_uri: scalar, resource: z.literal(this.resource), code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/) }).strict(),
      z.object({ grant_type: z.literal('refresh_token'), client_id: scalar, refresh_token: scalar, resource: z.literal(this.resource), scope: z.literal(scope).optional() }).strict(),
    ]), input);
    return this.tx(async client => {
      if ((await client.query('SELECT count(*)::int AS n FROM oauth_tokens')).rows[0].n + 2 > 50_000) return new Failure('temporarily_unavailable', 503);
      let family: Family;
      if (data.grant_type === 'authorization_code') {
        const result = await client.query<Code>('SELECT c.* FROM oauth_codes c JOIN bindings b ON b.id=c.binding_id WHERE c.hash=$1 AND c.expires_at>clock_timestamp() AND b.active FOR UPDATE OF c', [hash(data.code)]);
        const code = result.rows[0];
        if (!code || redirectIdentity(data.redirect_uri) === undefined || code.client_id !== data.client_id || code.redirect_uri !== data.redirect_uri || code.resource !== data.resource || code.challenge !== createHash('sha256').update(data.code_verifier).digest('base64url')) return new Failure('invalid_grant');
        if (code.consumed) {
          if (code.family_id) await client.query('UPDATE oauth_families SET revoked=true WHERE id=$1', [code.family_id]);
          return new Failure('invalid_grant');
        }
        if ((await client.query('SELECT count(*)::int AS n FROM oauth_families')).rows[0].n >= 1000) return new Failure('temporarily_unavailable', 503);
        family = { id: randomUUID(), binding_id: code.binding_id, client_id: code.client_id, resource: code.resource, scope: code.scope, expires_at: new Date(Date.now() + 30 * 86400_000), revoked: false };
        await client.query('INSERT INTO oauth_families(id,binding_id,client_id,resource,scope,expires_at) VALUES($1,$2,$3,$4,$5,$6)', [family.id, family.binding_id, family.client_id, family.resource, family.scope, family.expires_at]);
        await client.query('UPDATE oauth_codes SET consumed=true,family_id=$2 WHERE hash=$1', [hash(data.code), family.id]);
      } else {
        const result = await client.query<Family & { consumed: boolean }>(`SELECT f.*,t.consumed FROM oauth_tokens t JOIN oauth_families f ON f.id=t.family_id JOIN bindings b ON b.id=f.binding_id
          WHERE t.hash=$1 AND t.kind='refresh' AND t.expires_at>clock_timestamp() AND f.expires_at>clock_timestamp() AND b.active FOR UPDATE OF t,f`, [hash(data.refresh_token)]);
        const found = result.rows[0];
        if (!found || found.client_id !== data.client_id || found.resource !== data.resource || found.revoked) return new Failure('invalid_grant');
        if (found.consumed) { await client.query('UPDATE oauth_families SET revoked=true WHERE id=$1', [found.id]); return new Failure('invalid_grant'); }
        family = found;
        await client.query('UPDATE oauth_tokens SET consumed=true WHERE hash=$1', [hash(data.refresh_token)]);
      }
      const accessToken = opaque(), refreshToken = opaque();
      await client.query(`INSERT INTO oauth_tokens(hash,family_id,kind,expires_at) VALUES($1,$2,'access',LEAST($4,clock_timestamp()+interval '15 minutes')),($3,$2,'refresh',$4)`, [hash(accessToken), family.id, hash(refreshToken), family.expires_at]);
      return { access_token: accessToken, token_type: 'Bearer', expires_in: Math.min(900, Math.max(0, Math.floor((family.expires_at.getTime() - Date.now()) / 1000))), refresh_token: refreshToken, scope };
    });
  }
}
