import type { FastifyInstance, FastifyReply } from 'fastify';
import { directoryUiCss, directoryUiHtml, directoryUiJs } from './directory-ui-assets.js';

const CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'none'",
  "connect-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "object-src 'none'",
].join('; ');

function secureHtml(reply: FastifyReply) {
  return reply
    .header('cache-control', 'no-store')
    .header('referrer-policy', 'no-referrer')
    .header('x-content-type-options', 'nosniff')
    .header('content-security-policy', CSP);
}

/** Same-origin read-only inventory UI. Registered only with the directory API. */
export function registerDirectoryUi(app: FastifyInstance) {
  app.get('/directory', async (_request, reply) => {
    return secureHtml(reply).type('text/html; charset=utf-8').send(directoryUiHtml());
  });
  app.get('/directory/', async (_request, reply) => reply.redirect('/directory'));
  app.get('/directory/app.css', async (_request, reply) => {
    return reply
      .header('cache-control', 'no-store')
      .header('x-content-type-options', 'nosniff')
      .type('text/css; charset=utf-8')
      .send(directoryUiCss);
  });
  app.get('/directory/app.js', async (_request, reply) => {
    return reply
      .header('cache-control', 'no-store')
      .header('x-content-type-options', 'nosniff')
      .type('text/javascript; charset=utf-8')
      .send(directoryUiJs);
  });
}
