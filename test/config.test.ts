import type { Pool } from 'pg';
import Fastify from 'fastify';
import { testDatabase } from './helpers.js';
import { expect, it } from 'vitest';
import { notificationOptions } from '../src/config.js';
import { oauthFromEnvironment } from '../src/oauth-config.js';

it('cannot downgrade production OAuth or enable Grok delivery without OAuth authority', async () => {
  const callbacks = JSON.stringify(['https://chatgpt.com/connector_platform_oauth_redirect']);
  expect(() => oauthFromEnvironment({} as Pool, { NODE_ENV: 'production', OAUTH_ISSUER: 'http://localhost:3000', OAUTH_ALLOW_HTTP_LOCALHOST: 'true', OAUTH_REDIRECT_URIS: callbacks })).toThrow();
  const config = { NOTIFICATION_ENCRYPTION_KEY: 'a'.repeat(64), WEBHOOK_ALLOWED_HOSTS: 'api2.cursor.sh', GROK_EXPERIMENTAL: 'true' };
  expect(() => notificationOptions(config)).toThrow('OAUTH_ISSUER');
  expect(() => notificationOptions({ ...config, OAUTH_ISSUER: 'http://localhost:3000' })).toThrow('HTTPS');
  expect(notificationOptions({ ...config, OAUTH_ISSUER: 'https://relay.example.test' })).toHaveProperty('oauthResource', 'https://relay.example.test/mcp');
});

it('rejects callbacks to the relay itself and invalid encryption-key configuration', async () => {
  expect(() => notificationOptions({ NOTIFICATION_ENCRYPTION_KEY: 'short', WEBHOOK_ALLOWED_HOSTS: 'callback.example' })).toThrow('32 bytes');
  expect(() => notificationOptions({ NOTIFICATION_ENCRYPTION_KEY: 'a'.repeat(64), WEBHOOK_ALLOWED_HOSTS: 'relay.example', ALLOWED_HOSTS: 'relay.example' })).toThrow('this service');
});


it('enables native desktop registration only through its explicit environment flag', async () => {
  const db = await testDatabase();
  try {
    for (const enabled of [undefined, 'false', 'true']) {
      const app = Fastify();
      const oauth = oauthFromEnvironment(db.pool, {
        NODE_ENV: 'production', OAUTH_ISSUER: 'https://relay.example.test',
        OAUTH_REDIRECT_URIS: JSON.stringify(['https://chatgpt.com/connector_platform_oauth_redirect']),
        ...(enabled ? { OAUTH_ALLOW_NATIVE_LOOPBACK: enabled } : {}),
      })!;
      oauth.register(app);
      try {
        const result = await app.inject({ method: 'POST', url: '/oauth/register', payload: {
          redirect_uris: ['http://127.0.0.1:52669/callback'], application_type: 'native',
          client_name: 'Codex', token_endpoint_auth_method: 'none', scope: 'relay',
          grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
        } });
        expect(result.statusCode).toBe(enabled === 'true' ? 201 : 400);
      } finally { await app.close(); }
    }
  } finally { await db.close(); }
});
