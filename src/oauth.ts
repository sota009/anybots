import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { buildOAuthProtectedResourceMetadata, getOAuthProtectedResourceMetadataUrl, OAuthError, type AuthInfo } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { lockRelay, withTransaction } from './db.js';
import { clientAddress } from './web.js';

const scope = 'relay';
const opaque = () => randomBytes(32).toString('base64url');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const browserPolicy = "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
class Failure extends Error { constructor(readonly error: string, readonly status = 400) { super(error); } }
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new Failure('invalid_request');
  return result.data;
}
const scalar = z.string().min(1).max(2048);
interface Pending { client_id: string; redirect_uri: string; resource: string; state: string; scope: string; challenge: string; cookie_hash: string; attempts: number }
interface Code extends Pending { binding_id: string; consumed: boolean; family_id: string | null }
interface Family { id: string; binding_id: string; client_id: string; resource: string; scope: string; expires_at: Date; revoked: boolean }
export interface OAuthOptions { issuer: string; redirectUris: string[]; allowInsecureLocalhost?: boolean; allowNativeLoopback?: boolean; trustProxyHops?: number }

/** Deliberately bounded operator-provisioned pilot, not a general identity provider. */
export class OAuthPilot {
  readonly issuer: string;
  readonly resource: string;
  readonly resourceMetadataUrl: string;
  private readonly secure: boolean;
  private readonly redirects: Set<string>;
  private readonly allowNativeLoopback: boolean;
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
    this.allowNativeLoopback = options.allowNativeLoopback ?? false;
    this.trustProxyHops = options.trustProxyHops ?? 0;
    if (!options.redirectUris.length || options.redirectUris.length > 4) throw new Error('Exact OAuth redirect allowlist required');
    this.redirects = new Set(options.redirectUris.map(value => {
      const url = new URL(value);
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (url.username || url.password || url.hash || (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && loopback) && value !== 'cursor://anysphere.cursor-mcp/oauth/callback')) throw new Error('Unsafe OAuth redirect');
      return value;
    }));
  }
  private redirectIdentity(uri: string): string | undefined {
    // Match the raw spelling before URL parsing can normalize aliases. Only the
    // OS-selected listener port varies; web callbacks retain exact matching.
    const native = this.allowNativeLoopback && uri.match(/^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/callback$/);
    if (native && native[0] === uri && Number(native[1]) <= 65535) return 'http://127.0.0.1/callback';
    return this.redirects.has(uri) ? uri : undefined;
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
      await client.query('DELETE FROM oauth_pairings WHERE expires_at<clock_timestamp()');
      await client.query("DELETE FROM oauth_tokens WHERE kind='access' AND expires_at<clock_timestamp()");
      await client.query("DELETE FROM oauth_codes WHERE expires_at<clock_timestamp()-interval '1 day'");
      await client.query('DELETE FROM oauth_families WHERE expires_at<clock_timestamp()');
      return work(client);
    });
  }
  async issuePairingCode(bindingId: string) {
    parse(z.uuid(), bindingId);
    return this.tx(async client => {
      if (!(await client.query('SELECT 1 FROM bindings WHERE id=$1 AND active', [bindingId])).rowCount) throw new Failure('invalid_binding');
      await client.query('DELETE FROM oauth_pairings WHERE binding_id=$1', [bindingId]);
      if ((await client.query('SELECT count(*)::int AS n FROM oauth_pairings')).rows[0].n >= 100) throw new Failure('temporarily_unavailable', 503);
      const pairingCode = opaque();
      const expiresAt = new Date(Date.now() + 600_000);
      await client.query('INSERT INTO oauth_pairings(hash,binding_id,expires_at) VALUES($1,$2,$3)', [hash(pairingCode), bindingId, expiresAt]);
      return { pairingCode, expiresAt: expiresAt.toISOString() };
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
          .header('X-Content-Type-Options', 'nosniff').header('Content-Security-Policy', browserPolicy);
      });
      const endpoint = (name: string, fn: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) => async (request: FastifyRequest, reply: FastifyReply) => {
        try { await self.throttle(request, name); return await fn(request, reply); }
        catch (error) {
          reply.code(error instanceof Failure ? error.status : 500);
          if (name === 'authorize' || name === 'consent') {
            return reply.type('text/html; charset=utf-8').send('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Connection not completed</title><h1>Connection not completed</h1><p>Return to the previous page to check your pairing code. After five failed attempts or ten minutes, restart the connection from your agent and request a fresh code from your operator.</p><p>Keep pairing codes in this browser form. Do not paste them into an AI chat.</p></html>');
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
        const result = await self.begin(request.query);
        // Chromium needs the same-origin referrer policy to retain Origin on the
        // consent POST. Cross-origin callbacks still receive no Referer.
        reply.header('Referrer-Policy', 'same-origin');
        reply.header('Set-Cookie', `anybots_oauth=${result.cookie}; HttpOnly; SameSite=Lax; Path=/oauth/authorize; Max-Age=600${self.secure ? '; Secure' : ''}`);
        return reply.type('text/html; charset=utf-8').send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect Anybots</title><h1>Connect your agent</h1><p>Client: ${escape(result.name)}</p><p>Redirect: ${escape(result.redirect)}</p><p>Permission: relay — read and send messages, stop conversations, revoke contacts, and disable this connection.</p><p>Enter the one-time pairing code from your private operator file. Never enter it into an AI chat.</p><form method="post" action="/oauth/authorize"><input type="hidden" name="form_token" value="${result.formToken}"><label>Pairing code <input name="pairing_code" type="password" autocomplete="off" required maxlength="43"></label><button name="consent" value="connect">Connect</button></form></html>`);
      }));
      routes.post('/oauth/authorize', { bodyLimit: 8192 }, endpoint('consent', async (request, reply) => {
        if (request.headers.origin !== self.issuer) throw new Failure('invalid_request');
        const result = await self.complete(request.body, request.headers.cookie ?? '');
        if (result instanceof Failure) throw result;
        reply.header('Set-Cookie', `anybots_oauth=; HttpOnly; SameSite=Lax; Path=/oauth/authorize; Max-Age=0${self.secure ? '; Secure' : ''}`);
        // A separate navigation avoids applying form-action to the provider's
        // subsequent login redirects. complete() supplies the exact validated callback.
        const callback = escape(result);
        return reply.type('text/html; charset=utf-8').send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="0;url=${callback}"><title>Return to your agent</title><h1>Authorization approved</h1><p>Returning to your agent to finish connecting.</p><p><a href="${callback}">Return to your agent</a></p></html>`);
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
    const identities = redirectUris.map(uri => this.redirectIdentity(uri));
    if (identities.some(uri => uri === undefined)) throw new Failure('invalid_redirect_uri');
    const registeredUris = [...new Set(identities)].sort();
    return this.tx(async client => {
      const existing = await client.query<{ id: string; name: string }>('SELECT id,name FROM oauth_clients WHERE redirect_uris=$1::jsonb', [JSON.stringify(registeredUris)]);
      if (!existing.rowCount && (await client.query('SELECT count(*)::int AS n FROM oauth_clients')).rows[0].n >= 32) throw new Failure('temporarily_unavailable', 503);
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
      const found = await client.query<{ name: string; redirect_uris: string[] }>('SELECT name,redirect_uris FROM oauth_clients WHERE id=$1', [data.client_id]);
      const identity = this.redirectIdentity(data.redirect_uri);
      if (!found.rows[0] || identity === undefined || !found.rows[0].redirect_uris.includes(identity)) throw new Failure('invalid_request');
      if ((await client.query('SELECT count(*)::int AS n FROM oauth_pending')).rows[0].n >= 256) throw new Failure('temporarily_unavailable', 503);
      const formToken = opaque(), cookie = opaque();
      await client.query(`INSERT INTO oauth_pending(hash,cookie_hash,client_id,redirect_uri,resource,state,scope,challenge,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()+interval '10 minutes')`, [hash(formToken), hash(cookie), data.client_id, data.redirect_uri, data.resource, data.state, data.scope, data.code_challenge]);
      return { formToken, cookie, name: found.rows[0].name, redirect: data.redirect_uri };
    });
  }
  private async complete(input: unknown, cookieHeader: string) {
    const data = parse(z.object({ form_token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), pairing_code: z.string().max(128), consent: z.literal('connect') }).strict(), input);
    const cookie = cookieHeader.split(';').map(value => value.trim()).find(value => value.startsWith('anybots_oauth='))?.slice(14) ?? '';
    return this.tx(async client => {
      const found = await client.query<Pending>('SELECT * FROM oauth_pending WHERE hash=$1 AND NOT consumed AND expires_at>clock_timestamp() FOR UPDATE', [hash(data.form_token)]);
      const pending = found.rows[0];
      if (!pending || pending.resource !== this.resource || this.redirectIdentity(pending.redirect_uri) === undefined || hash(cookie) !== pending.cookie_hash || pending.attempts >= 5) return new Failure('invalid_request');
      await client.query('UPDATE oauth_pending SET attempts=attempts+1 WHERE hash=$1', [hash(data.form_token)]);
      const pairing = await client.query<{ binding_id: string }>('SELECT p.binding_id FROM oauth_pairings p JOIN bindings b ON b.id=p.binding_id WHERE p.hash=$1 AND NOT p.consumed AND p.expires_at>clock_timestamp() AND b.active FOR UPDATE OF p', [hash(data.pairing_code)]);
      if (!pairing.rows[0]) return new Failure('access_denied');
      await client.query('UPDATE oauth_pairings SET consumed=true WHERE hash=$1', [hash(data.pairing_code)]);
      await client.query('UPDATE oauth_pending SET consumed=true WHERE hash=$1', [hash(data.form_token)]);
      const code = opaque();
      await client.query(`INSERT INTO oauth_codes(hash,binding_id,client_id,redirect_uri,resource,scope,challenge,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+interval '2 minutes')`, [hash(code), pairing.rows[0].binding_id, pending.client_id, pending.redirect_uri, pending.resource, pending.scope, pending.challenge]);
      const redirect = new URL(pending.redirect_uri);
      redirect.searchParams.set('code', code); redirect.searchParams.set('state', pending.state); redirect.searchParams.set('iss', this.issuer);
      return redirect.href;
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
        if (!code || this.redirectIdentity(data.redirect_uri) === undefined || code.client_id !== data.client_id || code.redirect_uri !== data.redirect_uri || code.resource !== data.resource || code.challenge !== createHash('sha256').update(data.code_verifier).digest('base64url')) return new Failure('invalid_grant');
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
