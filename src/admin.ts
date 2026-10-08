import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { createPool } from './db.js';
import { Relay } from './relay.js';
import { Accounts } from './accounts.js';
import { oauthFromEnvironment } from './oauth-config.js';
import { readiness, type ReadinessReader } from './readiness.js';
import { notificationOptions } from './config.js';
import { appOrigin } from './web.js';

const command = z.union([
  z.strictObject({ action: z.literal('signup_invite'), ownerId: z.uuid().optional() }),
  z.strictObject({ action: z.literal('disable'), bindingId: z.uuid() }),
  z.strictObject({ action: z.literal('revoke'), a: z.uuid(), b: z.uuid() }),
  z.strictObject({ action: z.literal('status'), bindingId: z.uuid(), peerBindingId: z.uuid().optional() }),
]);

/** Operator-only: read input from stdin; invite URLs and credentials never go to stdout or an AI tool. */
export async function admin(
  dependencies: { relay: Relay; accounts?: Accounts; origin?: string; readStatus?: ReadinessReader },
  input: unknown,
  credentialsDirectory = '.local',
) {
  const data = command.parse(input);
  if (data.action === 'signup_invite') {
    if (!dependencies.accounts || !dependencies.origin) throw new Error('APP_ORIGIN required');
    await mkdir(credentialsDirectory, { recursive: true, mode: 0o700 });
    const invite = await dependencies.accounts.createSignupInvite(data.ownerId);
    const file = resolve(credentialsDirectory, `invite-${invite.inviteId}.json`);
    await writeFile(file, JSON.stringify({ url: `${dependencies.origin}/app#invite=${invite.token}`, expiresAt: invite.expiresAt }) + '\n', { flag: 'wx', mode: 0o600 });
    return { inviteId: invite.inviteId, credentialsFile: file, expiresAt: invite.expiresAt };
  }
  if (data.action === 'status') {
    if (!dependencies.readStatus) throw new Error('Operator status reader required');
    return dependencies.readStatus({ bindingId: data.bindingId, ...(data.peerBindingId ? { peerBindingId: data.peerBindingId } : {}) });
  }
  if (data.action === 'disable') {
    await dependencies.relay.disableBinding(data.bindingId);
    return { status: 'disabled' };
  }
  await dependencies.relay.revokePair(data.a, data.b);
  return { status: 'revoked' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
  const pool = createPool(process.env.DATABASE_URL);
  try {
    let raw = '';
    for await (const chunk of process.stdin) {
      raw += String(chunk);
      if (raw.length > 16_384) throw new Error('Input too large');
    }
    const oauth = oauthFromEnvironment(pool);
    const origin = appOrigin();
    console.log(JSON.stringify(await admin({
      relay: new Relay(pool),
      ...(origin ? { origin, accounts: new Accounts(pool, { origin }) } : {}),
      readStatus: async input => {
        const notifications = process.env.NOTIFICATIONS_ENABLED === 'true' ? await notificationOptions() : undefined;
        return readiness(pool, input, { ...(oauth ? { oauthResource: oauth.resource } : {}), ...(notifications ? { notifications } : {}) });
      },
    }, JSON.parse(raw))));
  } catch {
    console.error('Admin operation failed. Check configuration, input, and current binding state.');
    process.exitCode = 1;
  } finally { await pool.end(); }
}
