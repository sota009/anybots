import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { DirectoryAdmission, DirectoryRateLimit } from './directory-rate-limit.js';
import { DirectoryError, listConnections, newRequestId } from './directory-inventory.js';
import { registerDirectoryUi } from './directory-ui.js';

export interface DirectoryRouteOptions {
  pool: Pool;
  audience: string;
  rateLimit?: DirectoryRateLimit;
  admission?: DirectoryAdmission;
  handlerTimeoutMs?: number;
}

function requestId(reply: FastifyReply): string {
  const existing = reply.getHeader('x-request-id');
  if (typeof existing === 'string' && existing.length > 0) return existing;
  const id = newRequestId();
  reply.header('x-request-id', id);
  return id;
}

function fail(reply: FastifyReply, status: number, code: string) {
  const id = requestId(reply);
  reply.header('cache-control', 'no-store');
  if (status === 401) reply.header('www-authenticate', 'Bearer');
  if (status === 429) reply.header('retry-after', '1');
  return reply.code(status).send({ error: code, requestId: id });
}

function bearer(header: unknown): string | undefined {
  if (typeof header !== 'string' || header.length > 256) return undefined;
  const match = header.match(/^Bearer ([^\s]+)$/);
  return match?.[1];
}

export function registerDirectoryRoutes(app: FastifyInstance, options: DirectoryRouteOptions) {
  const rateLimit = options.rateLimit ?? new DirectoryRateLimit();
  const admission = options.admission ?? new DirectoryAdmission();
  const handlerTimeoutMs = options.handlerTimeoutMs ?? 3_000;
  registerDirectoryUi(app);

  app.get('/v1/me/connections', async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header('cache-control', 'no-store');
    requestId(reply);
    if (request.headers['content-length'] && request.headers['content-length'] !== '0') {
      return fail(reply, 400, 'invalid_request');
    }
    if (!rateLimit.allowGlobal()) return fail(reply, 429, 'rate_limited');

    const secret = bearer(request.headers.authorization);
    if (!secret) return fail(reply, 401, 'unauthorized');

    const url = new URL(request.url, 'http://directory.invalid');
    if (Buffer.byteLength(`${url.pathname}${url.search}`) > 2048) return fail(reply, 400, 'invalid_request');
    const keys = [...url.searchParams.keys()];
    if (keys.some((key) => key !== 'connection_id') || keys.length !== new Set(keys).size) {
      return fail(reply, 400, 'invalid_request');
    }
    let connectionId: string | undefined;
    if (url.searchParams.has('connection_id')) {
      const parsed = z.uuid().safeParse(url.searchParams.get('connection_id'));
      if (!parsed.success) return fail(reply, 400, 'invalid_request');
      connectionId = parsed.data;
    }

    let release: (() => void) | undefined;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (!reply.sent) void fail(reply, 503, 'unavailable');
    }, handlerTimeoutMs);
    try {
      release = await admission.enter();
      if (timedOut) return;
      const body = await listConnections(options.pool, {
        secret,
        audience: options.audience,
        ...(connectionId ? { connectionId } : {}),
        onAuthenticated: (ownerId) => {
          if (!rateLimit.allowOwner(ownerId)) throw new DirectoryError('rate_limited', 429);
        },
      });
      if (timedOut || reply.sent) return;
      return reply.code(200).send(body);
    } catch (error) {
      if (timedOut || reply.sent) return;
      if (error instanceof DirectoryError) return fail(reply, error.statusCode, error.code);
      if (error instanceof Error && error.message === 'admission_timeout') return fail(reply, 503, 'unavailable');
      return fail(reply, 503, 'unavailable');
    } finally {
      clearTimeout(timer);
      release?.();
    }
  });
}
