import type { Pool } from 'pg';
import { expect, it } from 'vitest';
import { notificationOptions } from '../src/config.js';
import { oauthFromEnvironment } from '../src/oauth-config.js';

it('cannot downgrade production OAuth or enable Grok delivery without OAuth authority', async () => {
  const callbacks = JSON.stringify(['https://chatgpt.com/connector_platform_oauth_redirect']);
  expect(() => oauthFromEnvironment({} as Pool, { NODE_ENV: 'production', OAUTH_ISSUER: 'http://localhost:3000', OAUTH_ALLOW_HTTP_LOCALHOST: 'true', OAUTH_REDIRECT_URIS: callbacks })).toThrow();
  const config = { NOTIFICATION_ENCRYPTION_KEY: 'a'.repeat(64), WEBHOOK_ALLOWED_HOSTS: 'api2.cursor.sh', GROK_EXPERIMENTAL: 'true' };
  await expect(notificationOptions(config)).rejects.toThrow('OAUTH_ISSUER');
  await expect(notificationOptions({ ...config, OAUTH_ISSUER: 'http://localhost:3000' })).rejects.toThrow('HTTPS');
  await expect(notificationOptions({ ...config, OAUTH_ISSUER: 'https://relay.example.test' })).resolves.toHaveProperty('oauthResource', 'https://relay.example.test/mcp');
});

it('rejects callbacks to the relay itself and invalid encryption-key configuration', async () => {
  await expect(notificationOptions({ NOTIFICATION_ENCRYPTION_KEY: 'short', WEBHOOK_ALLOWED_HOSTS: 'callback.example' })).rejects.toThrow('32 bytes');
  await expect(notificationOptions({ NOTIFICATION_ENCRYPTION_KEY: 'a'.repeat(64), WEBHOOK_ALLOWED_HOSTS: 'relay.example', ALLOWED_HOSTS: 'relay.example' })).rejects.toThrow('this service');
});
