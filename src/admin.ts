import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { z } from 'zod';
import { Relay } from './relay.js';
import { randomUUID } from 'node:crypto';
import { oauthFromEnvironment } from './oauth-config.js';
import type { OAuthPilot } from './oauth.js';
import { readiness, type ReadinessReader } from './readiness.js';
import { notificationOptions } from './config.js';

const provision = z.strictObject({
  action: z.literal('provision'), ownerId: z.string().min(1).max(200),
  runtimeScope: z.string().min(1).max(200), provider: z.enum(['dots', 'grok', 'muse']),
});
const pair = z.strictObject({
  action: z.enum(['grant', 'revoke']), a: z.uuid(), b: z.uuid(),
  consentConfirmed: z.literal(true),
});
const disable = z.strictObject({ action: z.literal('disable'), bindingId: z.uuid() });
const connect = z.strictObject({ action: z.literal('connect'), bindingId: z.uuid() });
const status = z.strictObject({ action: z.literal('status'), bindingId: z.uuid(), peerBindingId: z.uuid().optional() });

/** Operator-only: read input from stdin; credentials never go to stdout or an AI tool. */
export async function admin(relay: Relay, input: unknown, credentialsDirectory = '.local', oauth?: OAuthPilot, readStatus?: ReadinessReader) {
  const command = z.union([provision, pair, disable, connect, status]).parse(input);
  if (command.action === 'status') {
    if (!readStatus) throw new Error('Operator status reader required');
    return readStatus({ bindingId: command.bindingId,
      ...(command.peerBindingId ? { peerBindingId: command.peerBindingId } : {}) });
  }
  if (command.action === 'connect') {
    if (!oauth) throw new Error('OAuth configuration required');
    await mkdir(credentialsDirectory, { recursive: true, mode: 0o700 });
    const pairing = await oauth.issuePairingCode(command.bindingId);
    const file = resolve(credentialsDirectory, `${command.bindingId}-connect-${randomUUID()}.json`);
    await writeFile(file, JSON.stringify({ ...pairing, bindingId: command.bindingId, issuer: oauth.issuer }) + '\n', { flag: 'wx', mode: 0o600 });
    return { bindingId: command.bindingId, credentialsFile: file, expiresAt: pairing.expiresAt };
  }
  if (command.action === 'provision') {
    await mkdir(credentialsDirectory, { recursive: true, mode: 0o700 });
    const result = await relay.provisionBinding({ ownerId: command.ownerId, runtimeScope: command.runtimeScope, provider: command.provider });
    const file = resolve(credentialsDirectory, `${result.bindingId}.json`);
    try {
      await writeFile(file, JSON.stringify(result) + '\n', { flag: 'wx', mode: 0o600 });
    } catch (error) {
      await relay.disableBinding(result.bindingId);
      throw error;
    }
    return { bindingId: result.bindingId, credentialsFile: file };
  }
  if (command.action === 'disable') {
    await relay.disableBinding(command.bindingId);
    return { status: 'disabled' };
  }
  if (command.action === 'grant') await relay.grantPair(command.a, command.b);
  else await relay.revokePair(command.a, command.b);
  return { status: command.action === 'grant' ? 'granted' : 'revoked' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
    let raw = '';
    for await (const chunk of process.stdin) {
      raw += String(chunk);
      if (raw.length > 16_384) throw new Error('Input too large');
    }
    const oauth = oauthFromEnvironment(pool);
    console.log(JSON.stringify(await admin(new Relay(pool), JSON.parse(raw), '.local', oauth, async input => {
      const notifications = process.env.NOTIFICATIONS_ENABLED === 'true' ? await notificationOptions() : undefined;
      return readiness(pool, input, { ...(oauth ? { oauthResource: oauth.resource } : {}),
        ...(notifications ? { notifications } : {}) });
    })));
  } catch {
    console.error('Admin operation failed. Check configuration, input, and current binding state.');
    process.exitCode = 1;
  } finally { await pool.end(); }
}
