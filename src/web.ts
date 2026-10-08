import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Accounts } from './accounts.js';
import { RelayError } from './errors.js';
import type { Network } from './network.js';
import type { OAuthPilot } from './oauth.js';
import { AUTH_ATTEMPT_LIMITS } from './rates.js';

const SITE_CSP = "default-src 'none'; style-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const AUTH_LIMITS = AUTH_ATTEMPT_LIMITS;
const WRITE_LIMITS = { perSource: 60, global: 3000 };
const SESSION_MAX_AGE_S = 14 * 24 * 3600;

/** Exact origin only; plain HTTP is accepted for loopback development. */
export function appOrigin(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!env.APP_ORIGIN) return undefined;
  const url = new URL(env.APP_ORIGIN);
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password
    || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('APP_ORIGIN must be an exact https origin');
  }
  return url.origin;
}

/** IPv6 hosts commonly hold a whole /64, so throttling keys on that prefix. */
function sourceKey(address: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return mapped[1]!;
  if (isIP(address) !== 6) return address;
  const [head = '', tail = ''] = address.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = address.includes('::') ? (tail ? tail.split(':') : []) : [];
  const groups = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return `${groups.slice(0, 4).map(group => group.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/**
 * The right-most `hops` forwarded entries were appended by trusted proxies;
 * anything further left is client-controlled and ignored. Returns a throttling key.
 */
export function clientAddress(request: FastifyRequest, hops: number): string {
  const socket = request.socket.remoteAddress ?? 'unknown';
  if (hops <= 0) return sourceKey(socket);
  const header = request.headers['x-forwarded-for'];
  const chain = (Array.isArray(header) ? header.join(',') : header ?? '').split(',').map(value => value.trim()).filter(Boolean);
  return sourceKey(chain.length >= hops ? chain[chain.length - hops]! : socket);
}

function cookie(request: FastifyRequest, name: string): string | undefined {
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

export interface WebOptions { accounts: Accounts; network: Network; origin: string; trustProxyHops?: number; oauth?: OAuthPilot }

export function registerWeb(app: FastifyInstance, options: WebOptions) {
  const secure = options.origin.startsWith('https://');
  const sessionCookie = secure ? '__Host-knotcat_session' : 'knotcat_session';
  const assets = new URL('../web/', import.meta.url);
  const files = {
    html: readFileSync(new URL('app.html', assets), 'utf8'),
    js: readFileSync(new URL('app.js', assets), 'utf8'),
    css: readFileSync(new URL('app.css', assets), 'utf8'),
    site: readFileSync(new URL('index.html', assets), 'utf8'),
    guide: readFileSync(new URL('guide.html', assets), 'utf8').replaceAll('%MCP_URL%', `${options.origin}/mcp`),
    siteCss: readFileSync(new URL('site.css', assets), 'utf8'),
  };
  const { accounts, network } = options;
  const owners = new WeakMap<FastifyRequest, string>();

  const setSession = (reply: FastifyReply, value: string, maxAge = SESSION_MAX_AGE_S) =>
    reply.header('Set-Cookie', `${sessionCookie}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);

  app.register(async routes => {
    routes.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer')
        .header('Cross-Origin-Opener-Policy', 'same-origin').header('Cross-Origin-Resource-Policy', 'same-origin');
      if (secure) reply.header('Strict-Transport-Security', 'max-age=31536000');
      if (request.method === 'GET' || request.method === 'HEAD') return;
      // CSRF: exact origin and a JSON body, in addition to SameSite=Lax.
      const type = request.headers['content-type'] ?? '';
      if (request.headers.origin !== options.origin || !/^application\/json(;|$)/i.test(type)) {
        return reply.code(403).send({ error: 'forbidden' });
      }
    });
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof RelayError) return reply.code(error.statusCode).send({ error: error.code });
      if (error instanceof z.ZodError) return reply.code(400).send({ error: 'invalid_input' });
      const status = typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number'
        && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
      return reply.code(status).send({ error: status === 413 ? 'body_too_large' : status === 500 ? 'request_failed' : 'invalid_request' });
    });

    routes.get('/', async (_request, reply) => reply.type('text/html; charset=utf-8').header('Content-Security-Policy', SITE_CSP).send(files.site));
    routes.get('/guide', async (_request, reply) => reply.type('text/html; charset=utf-8').header('Content-Security-Policy', SITE_CSP).send(files.guide));
    routes.get('/site.css', async (_request, reply) => reply.type('text/css; charset=utf-8').send(files.siteCss));
    routes.get('/app', async (_request, reply) => reply.type('text/html; charset=utf-8').header('Content-Security-Policy', CSP).send(files.html));
    routes.get('/app/app.js', async (_request, reply) => reply.type('text/javascript; charset=utf-8').send(files.js));
    routes.get('/app/app.css', async (_request, reply) => reply.type('text/css; charset=utf-8').send(files.css));

    routes.register(async api => {
      api.addHook('onRoute', route => { route.bodyLimit ??= 64 * 1024; });
      api.addHook('onRequest', async (request, reply) => {
        if (request.url.startsWith('/api/v1/auth/')) {
          if (!await accounts.allow('auth', clientAddress(request, options.trustProxyHops ?? 0), AUTH_LIMITS)) return reply.code(429).send({ error: 'rate_limited' });
          return;
        }
        const ownerId = await accounts.session(cookie(request, sessionCookie));
        if (!ownerId) return reply.code(401).send({ error: 'unauthorized' });
        if (request.method !== 'GET' && !await accounts.allow('write', ownerId, WRITE_LIMITS)) return reply.code(429).send({ error: 'rate_limited' });
        owners.set(request, ownerId);
      });
      const owner = (request: FastifyRequest) => owners.get(request)!;
      const id = (request: FastifyRequest, name = 'id') => (request.params as Record<string, string>)[name]!;

      api.post('/auth/register/options', async request => accounts.registerOptions(request.body as never));
      api.post('/auth/register/verify', async (request, reply) => {
        const result = await accounts.registerVerify(request.body as never);
        setSession(reply, result.session);
        return { ownerId: result.ownerId };
      });
      api.post('/auth/login/options', async () => accounts.loginOptions());
      api.post('/auth/login/verify', async (request, reply) => {
        const result = await accounts.loginVerify(request.body as never);
        setSession(reply, result.session);
        return { ownerId: result.ownerId };
      });
      api.post('/auth/logout', async (request, reply) => {
        await accounts.logout(cookie(request, sessionCookie));
        setSession(reply, '', 0);
        return { signedOut: true };
      });

      api.get('/me', async request => network.overview(owner(request)));
      api.post('/agents', async request => network.createAgent(owner(request), request.body));
      api.patch('/agents/:id', async request => network.renameAgent(owner(request), id(request), request.body));
      api.put('/agents/:id/webhook', async request => network.setWebhook(owner(request), id(request), request.body));
      api.delete('/agents/:id', async request => network.disableAgent(owner(request), id(request)));
      api.post('/invites', async request => {
        z.strictObject({ relationship: z.literal('contact') }).parse(request.body);
        const invite = await accounts.createContactInvite(owner(request));
        return { url: `${options.origin}/app#invite=${invite.token}`, expiresAt: invite.expiresAt };
      });
      api.post('/invites/accept', async request => {
        const body = z.strictObject({ invite: z.string().max(64) }).parse(request.body);
        return accounts.acceptInvite(owner(request), body.invite);
      });
      api.delete('/contacts/:ownerId', async request => network.removeContact(owner(request), id(request, 'ownerId')));
      api.post('/links', async request => network.proposeLink(owner(request), request.body));
      api.post('/links/:id/accept', async request => network.acceptLink(owner(request), id(request)));
      api.patch('/links/:id/policy', async request => network.setPolicy(owner(request), id(request), request.body));
      api.delete('/links/:id', async request => network.revokeLink(owner(request), id(request)));
      api.get('/links/:id/timeline', async request => network.timeline(owner(request), id(request)));
      const { oauth } = options;
      if (oauth) {
        const connection = (request: FastifyRequest) => cookie(request, oauth.cookieName) ?? '';
        api.post('/oauth/request', async request => oauth.describe(owner(request), request.body, connection(request)));
        api.post('/oauth/approve', async (request, reply) => {
          const result = await oauth.approve(owner(request), request.body, connection(request));
          reply.header('Set-Cookie', oauth.cookie('', 0));
          return result;
        });
        api.post('/oauth/deny', async (request, reply) => {
          const result = await oauth.deny(owner(request), request.body, connection(request));
          reply.header('Set-Cookie', oauth.cookie('', 0));
          return result;
        });
      }
      api.post('/approvals/:messageId', async request => network.decide(owner(request), id(request, 'messageId'), request.body));
    }, { prefix: '/api/v1' });
  });
}
