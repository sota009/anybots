import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { z } from 'zod';
import { Relay } from './relay.js';

const provision = z.strictObject({
  action: z.literal('provision'), ownerId: z.string().min(1).max(200),
  runtimeScope: z.string().min(1).max(200), provider: z.enum(['dots', 'grok']),
});
const pair = z.strictObject({
  action: z.enum(['grant', 'revoke']), a: z.uuid(), b: z.uuid(),
  consentConfirmed: z.literal(true),
});
const disable = z.strictObject({ action: z.literal('disable'), bindingId: z.uuid() });

/** Operator-only: read input from stdin; credentials never go to stdout or an AI tool. */
export async function admin(relay: Relay, input: unknown, credentialsDirectory = '.local') {
  const command = z.union([provision, pair, disable]).parse(input);
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
    console.log(JSON.stringify(await admin(new Relay(pool), JSON.parse(raw))));
  } catch {
    console.error('Admin operation failed. Check configuration, input, and current binding state.');
    process.exitCode = 1;
  } finally { await pool.end(); }
}
