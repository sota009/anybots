import { PublicHttpsTransport } from './providers/transport.js';
import type { ProviderOptions } from './providers/index.js';

/** Secrets are supplied through the hosting secret store or a private file. */
export function notificationOptions(env: NodeJS.ProcessEnv = process.env): ProviderOptions {
  const rawKey = env.NOTIFICATION_ENCRYPTION_KEY;
  if (!rawKey || !/^[0-9a-f]{64}$/i.test(rawKey)) throw new Error('NOTIFICATION_ENCRYPTION_KEY must be 32 bytes encoded as hex');
  const hosts = env.WEBHOOK_ALLOWED_HOSTS?.split(',').map((host) => host.trim()).filter(Boolean) ?? [];
  if (!hosts.length || hosts.some((host) => !/^[a-z0-9][a-z0-9.-]+[a-z0-9]$/.test(host))) {
    throw new Error('WEBHOOK_ALLOWED_HOSTS must contain exact provider callback hostnames');
  }
  const ownHosts = env.ALLOWED_HOSTS?.split(',').map((host) => host.trim()) ?? [];
  if (hosts.some((host) => ownHosts.includes(host))) throw new Error('Webhook destinations must not target this service');
  const grokExperimental = env.GROK_EXPERIMENTAL === 'true';
  let oauthResource: string | undefined;
  if (grokExperimental) {
    if (!env.OAUTH_ISSUER) throw new Error('Grok delivery requires OAUTH_ISSUER and a live OAuth connection');
    const issuer = new URL(env.OAUTH_ISSUER);
    if (issuer.protocol !== 'https:' || issuer.pathname !== '/' || issuer.search || issuer.hash || issuer.username || issuer.password) {
      throw new Error('Grok delivery requires a public HTTPS OAuth origin');
    }
    oauthResource = `${issuer.origin}/mcp`;
  }
  return { encryptionKey: Buffer.from(rawKey, 'hex'), transport: new PublicHttpsTransport(hosts), webhookHosts: hosts, grokExperimental,
    ...(oauthResource ? { oauthResource } : {}) };
}
