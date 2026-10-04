import { afterAll, beforeAll, expect, it } from 'vitest';
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { admin } from '../src/admin.js';
import { Accounts } from '../src/accounts.js';
import { Relay } from '../src/relay.js';
import { createOwner, provision, testDatabase } from './helpers.js';

const origin = 'https://app.example.test';
let db: Awaited<ReturnType<typeof testDatabase>>;
let directory: string;
let relay: Relay;
let accounts: Accounts;
beforeAll(async () => {
  db = await testDatabase();
  directory = await mkdtemp(join(tmpdir(), 'anybots-admin-'));
  await chmod(directory, 0o700);
  relay = new Relay(db.pool);
  accounts = new Accounts(db.pool, { origin });
});
afterAll(async () => { await db?.close(); if (directory) await rm(directory, { recursive: true }); });

it('writes a signup invite URL only to a private file, never the result', async () => {
  const result = await admin({ relay, accounts, origin }, { action: 'signup_invite' }, directory);
  if (!('credentialsFile' in result)) throw new Error('Expected an invite file');
  expect((await stat(result.credentialsFile)).mode & 0o777).toBe(0o600);
  const saved = JSON.parse(await readFile(result.credentialsFile, 'utf8'));
  const token = saved.url.match(/^https:\/\/app\.example\.test\/app#invite=([A-Za-z0-9_-]{43})$/)?.[1];
  expect(token).toBeDefined();
  expect(JSON.stringify(result)).not.toContain(token);
  await expect(accounts.registerOptions({ invite: token, displayName: 'Ada' })).resolves.toHaveProperty('challengeId');
});

it('targets an existing owner for recovery and rejects unknown owners', async () => {
  const ownerId = await createOwner(db.pool);
  await expect(admin({ relay, accounts, origin }, { action: 'signup_invite', ownerId }, directory)).resolves.toHaveProperty('inviteId');
  await expect(admin({ relay, accounts, origin }, { action: 'signup_invite', ownerId: crypto.randomUUID() }, directory)).rejects.toMatchObject({ code: 'not_found' });
  await expect(admin({ relay }, { action: 'signup_invite' }, directory)).rejects.toThrow('APP_ORIGIN required');
});

it('keeps only emergency disable and revoke, and rejects removed manual onboarding', async () => {
  const a = await provision(relay, db.pool, { provider: 'dots' });
  const b = await provision(relay, db.pool, { provider: 'grok' });
  await relay.grantPair(a.bindingId, b.bindingId);
  expect(await admin({ relay }, { action: 'revoke', a: a.bindingId, b: b.bindingId })).toEqual({ status: 'revoked' });
  expect((await relay.agentsList(a.token))).toEqual([]);
  expect(await admin({ relay }, { action: 'disable', bindingId: a.bindingId })).toEqual({ status: 'disabled' });
  await expect(relay.authenticate(a.token)).rejects.toMatchObject({ code: 'unauthorized' });
  for (const removed of [{ action: 'create_owner' }, { action: 'grant', a: a.bindingId, b: b.bindingId, consentConfirmed: true },
    { action: 'provision', ownerId: a.ownerId, runtimeScope: 'x', provider: 'dots' }, { action: 'connect', bindingId: b.bindingId }]) {
    await expect(admin({ relay }, removed)).rejects.toThrow();
  }
});
