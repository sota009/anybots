import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { admin } from '../src/admin.js';
import { Relay } from '../src/relay.js';
import { testDatabase } from './helpers.js';

let db: Awaited<ReturnType<typeof testDatabase>>;
let directory: string;
beforeAll(async () => { db = await testDatabase(); directory = await mkdtemp(join(tmpdir(), 'anybots-admin-')); });
afterAll(async () => { await db?.close(); if (directory) await rm(directory, { recursive: true }); });

it('writes operator credentials only to a private file, never the result', async () => {
  const relay = new Relay(db.pool);
  const result = await admin(relay, { action: 'provision', ownerId: 'test-owner', runtimeScope: 'test-runtime', provider: 'dots' }, directory);
  expect(result).not.toHaveProperty('token');
  if (!('credentialsFile' in result)) throw new Error('Expected provisioning result');
  const credentials = JSON.parse(await readFile(result.credentialsFile, 'utf8'));
  expect((await stat(result.credentialsFile)).mode & 0o777).toBe(0o600);
  expect((await relay.authenticate(credentials.token)).id).toBe(result.bindingId);
  await expect(admin(relay, { action: 'grant', a: credentials.bindingId, b: crypto.randomUUID(), consentConfirmed: false })).rejects.toThrow();
});

it('does not provision a binding when credential directory creation fails', async () => {
  const relay = new Relay(db.pool);
  const ownerId = crypto.randomUUID();
  const result = await admin(relay, { action: 'provision', ownerId, runtimeScope: ownerId, provider: 'dots' }, directory);
  if (!('credentialsFile' in result)) throw new Error('Expected provisioning result');
  await expect(admin(relay, { action: 'provision', ownerId: 'failed-owner', runtimeScope: 'failed-runtime', provider: 'grok' }, join(result.credentialsFile, 'invalid'))).rejects.toThrow();
  expect((await db.pool.query("SELECT 1 FROM bindings WHERE runtime_scope='failed-runtime'")).rowCount).toBe(0);
});
