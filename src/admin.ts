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
import { DirectoryRegistry } from './directory.js';
import { writeDirectoryCredentialFile } from './directory-file.js';

const createOwner = z.strictObject({ action: z.literal('create_owner') });
const provision = z.strictObject({
  action: z.literal('provision'), ownerId: z.uuid(),
  runtimeScope: z.string().min(1).max(200), provider: z.enum(['dots', 'grok', 'muse']),
});
const pair = z.strictObject({
  action: z.enum(['grant', 'revoke']), a: z.uuid(), b: z.uuid(),
  consentConfirmed: z.literal(true),
});
const disable = z.strictObject({ action: z.literal('disable'), bindingId: z.uuid() });
const connect = z.strictObject({ action: z.literal('connect'), bindingId: z.uuid() });
const status = z.strictObject({ action: z.literal('status'), bindingId: z.uuid(), peerBindingId: z.uuid().optional() });
const directoryIssue = z.strictObject({
  action: z.literal('directory_issue'),
  ownerId: z.uuid(),
  audience: z.string().url().max(2048),
  credentialsPath: z.string().min(1).max(4096),
  credentialId: z.uuid().optional(),
});
const directoryRevoke = z.strictObject({ action: z.literal('directory_revoke'), credentialId: z.uuid() });
const directoryDisable = z.strictObject({ action: z.literal('directory_disable'), ownerId: z.uuid() });
const directoryStatus = z.strictObject({ action: z.literal('directory_status'), credentialId: z.uuid() });

function requireDirectory(directory?: DirectoryRegistry): DirectoryRegistry {
  if (!directory) throw new Error('Directory registry required');
  return directory;
}

/** Operator-only: read input from stdin; credentials never go to stdout or an AI tool. */
export async function admin(
  relay: Relay,
  input: unknown,
  credentialsDirectory = '.local',
  oauth?: OAuthPilot,
  readStatus?: ReadinessReader,
  directory?: DirectoryRegistry,
) {
  const command = z.union([
    createOwner, provision, pair, disable, connect, status,
    directoryIssue, directoryRevoke, directoryDisable, directoryStatus,
  ]).parse(input);

  if (command.action === 'create_owner') return requireDirectory(directory).createOwner();
  if (command.action === 'directory_status') return requireDirectory(directory).status({ credentialId: command.credentialId });
  if (command.action === 'directory_revoke') return requireDirectory(directory).revoke({ credentialId: command.credentialId });
  if (command.action === 'directory_disable') return requireDirectory(directory).disableDirectory({ ownerId: command.ownerId });

  if (command.action === 'directory_issue') {
    const registry = requireDirectory(directory);
    const issued = await registry.issue({
      ownerId: command.ownerId,
      audience: command.audience,
      ...(command.credentialId ? { credentialId: command.credentialId } : {}),
    });
    if (issued.status !== 'active') {
      return {
        credentialId: issued.credentialId,
        credentialsFile: command.credentialsPath,
        status: issued.status,
        expiresAt: issued.expiresAt,
      };
    }
    try {
      const file = await writeDirectoryCredentialFile(command.credentialsPath, {
        credentialId: issued.credentialId,
        secret: issued.secret,
        expiresAt: issued.expiresAt,
        audience: command.audience,
      });
      const confirmed = await registry.status({ credentialId: issued.credentialId });
      if (confirmed.status !== 'active') {
        await registry.revoke({ credentialId: issued.credentialId });
        throw new Error('directory_credential_race');
      }
      return {
        credentialId: issued.credentialId,
        credentialsFile: file,
        status: confirmed.status,
        expiresAt: issued.expiresAt,
      };
    } catch (error) {
      await registry.revoke({ credentialId: issued.credentialId }).catch(() => undefined);
      throw error;
    }
  }

  if (command.action === 'status') {
    if (!readStatus) throw new Error('Operator status reader required');
    return readStatus({
      bindingId: command.bindingId,
      ...(command.peerBindingId ? { peerBindingId: command.peerBindingId } : {}),
    });
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
    const result = await relay.provisionBinding({
      ownerId: command.ownerId,
      runtimeScope: command.runtimeScope,
      provider: command.provider,
    });
    const file = resolve(credentialsDirectory, `${result.bindingId}.json`);
    try {
      await writeFile(
        file,
        JSON.stringify({ bindingId: result.bindingId, token: result.token, ownerId: result.ownerId }) + '\n',
        { flag: 'wx', mode: 0o600 },
      );
    } catch (error) {
      await relay.disableBinding(result.bindingId);
      throw error;
    }
    return { bindingId: result.bindingId, credentialsFile: file, ownerId: result.ownerId };
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
    const directory = new DirectoryRegistry(pool);
    console.log(JSON.stringify(await admin(new Relay(pool), JSON.parse(raw), '.local', oauth, async input => {
      const notifications = process.env.NOTIFICATIONS_ENABLED === 'true' ? await notificationOptions() : undefined;
      return readiness(pool, input, {
        ...(oauth ? { oauthResource: oauth.resource } : {}),
        ...(notifications ? { notifications } : {}),
      });
    }, directory)));
  } catch {
    console.error('Admin operation failed. Check configuration, input, and current binding state.');
    process.exitCode = 1;
  } finally { await pool.end(); }
}
