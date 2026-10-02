import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { PublicHttpsTransport } from './providers/transport.js';
import type { ProviderOptions } from './providers/index.js';

/** Secrets are supplied through the hosting secret store or a private file. */
export async function notificationOptions(env: NodeJS.ProcessEnv = process.env): Promise<ProviderOptions> {
  const rawKey = env.NOTIFICATION_ENCRYPTION_KEY;
  if (!rawKey || !/^[0-9a-f]{64}$/i.test(rawKey)) throw new Error('NOTIFICATION_ENCRYPTION_KEY must be 32 bytes encoded as hex');
  const hosts = env.WEBHOOK_ALLOWED_HOSTS?.split(',').map((host) => host.trim()).filter(Boolean) ?? [];
  if (!hosts.length || hosts.some((host) => !/^[a-z0-9][a-z0-9.-]+[a-z0-9]$/.test(host))) {
    throw new Error('WEBHOOK_ALLOWED_HOSTS must contain exact provider callback hostnames');
  }
  const ownHosts = env.ALLOWED_HOSTS?.split(',').map((host) => host.trim()) ?? [];
  if (hosts.some((host) => ownHosts.includes(host))) throw new Error('Webhook destinations must not target this service');
  const grokExperimental = env.GROK_EXPERIMENTAL === 'true';
  let groks: ProviderOptions['groks'];
  if (env.GROK_CONFIG_FILE) {
    if (!grokExperimental) throw new Error('GROK_EXPERIMENTAL must explicitly enable the unverified Grok adapter');
    try {
      const raw: unknown = JSON.parse(await readFile(env.GROK_CONFIG_FILE, 'utf8'));
      groks = z.record(z.uuid(), z.strictObject({ url: z.url().max(2048), secret: z.string().min(16).max(4096) })).parse(raw);
    } catch { throw new Error('Grok configuration file is missing or invalid'); }
  }
  return { encryptionKey: Buffer.from(rawKey, 'hex'), transport: new PublicHttpsTransport(hosts), grokExperimental,
    ...(groks ? { groks } : {}) };
}
