import type { Pool } from 'pg';
import Fastify from 'fastify';
import { testDatabase } from './helpers.js';
import { expect, it } from 'vitest';
import { notificationOptions } from '../src/config.js';
import { oauthFromEnvironment } from '../src/oauth-config.js';

it('cannot downgrade production OAuth or enable Grok delivery without OAuth authority', async () => {
  expect(() => oauthFromEnvironment({} as Pool, { NODE_ENV: 'production', OAUTH_ISSUER: 'http://localhost:3000', OAUTH_ALLOW_HTTP_LOCALHOST: 'true' })).toThrow();
  const config = { NOTIFICATION_ENCRYPTION_KEY: 'a'.repeat(64), WEBHOOK_ALLOWED_HOSTS: 'api2.cursor.sh', GROK_EXPERIMENTAL: 'true' };
  expect(() => notificationOptions(config)).toThrow('OAUTH_ISSUER');
  expect(() => notificationOptions({ ...config, OAUTH_ISSUER: 'http://localhost:3000' })).toThrow('HTTPS');
  expect(notificationOptions({ ...config, OAUTH_ISSUER: 'https://relay.example.test' })).toHaveProperty('oauthResource', 'https://relay.example.test/mcp');
});

it('rejects callbacks to the relay itself and invalid encryption-key configuration', async () => {
  expect(() => notificationOptions({ NOTIFICATION_ENCRYPTION_KEY: 'short', WEBHOOK_ALLOWED_HOSTS: 'callback.example' })).toThrow('32 bytes');
  expect(() => notificationOptions({ NOTIFICATION_ENCRYPTION_KEY: 'a'.repeat(64), WEBHOOK_ALLOWED_HOSTS: 'relay.example', ALLOWED_HOSTS: 'relay.example' })).toThrow('this service');
});


it('accepts any recognized redirect shape without a per-deployment allowlist', async () => {
  const db = await testDatabase();
  const app = Fastify();
  try {
    oauthFromEnvironment(db.pool, { NODE_ENV: 'production', OAUTH_ISSUER: 'https://relay.example.test' })!.register(app);
    for (const uri of ['http://127.0.0.1:52669/callback', 'https://claude.ai/api/mcp/auth_callback', 'https://poke.com/oauth/callback']) {
      const result = await app.inject({ method: 'POST', url: '/oauth/register', payload: { redirect_uris: [uri], client_name: 'Client' } });
      expect(result.statusCode).toBe(201);
    }
  } finally { await app.close(); await db.close(); }
});
