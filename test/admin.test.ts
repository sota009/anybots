import { afterAll, beforeAll, expect, it } from 'vitest';
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { admin } from '../src/admin.js';
import { DirectoryRegistry } from '../src/directory.js';
import { Relay } from '../src/relay.js';
import { createOwner, testDatabase } from './helpers.js';

let db: Awaited<ReturnType<typeof testDatabase>>;
let directory: string;
let registry: DirectoryRegistry;
beforeAll(async () => {
  db = await testDatabase();
  directory = await mkdtemp(join(tmpdir(), 'anybots-admin-'));
  await chmod(directory, 0o700);
  registry = new DirectoryRegistry(db.pool);
});
afterAll(async () => { await db?.close(); if (directory) await rm(directory, { recursive: true }); });

it('writes operator credentials only to a private file, never the result', async () => {
  const relay = new Relay(db.pool);
  const ownerId = await createOwner(db.pool);
  const result = await admin(relay, { action: 'provision', ownerId, runtimeScope: 'test-runtime', provider: 'dots' }, directory, undefined, undefined, registry);
  expect(result).not.toHaveProperty('token');
  if (!('credentialsFile' in result)) throw new Error('Expected provisioning result');
  const credentials = JSON.parse(await readFile(result.credentialsFile, 'utf8'));
  expect((await stat(result.credentialsFile)).mode & 0o777).toBe(0o600);
  expect((await relay.authenticate(credentials.token)).id).toBe(result.bindingId);
  await expect(admin(relay, { action: 'grant', a: credentials.bindingId, b: crypto.randomUUID(), consentConfirmed: false })).rejects.toThrow();
});

it('does not provision a binding when credential directory creation fails', async () => {
  const relay = new Relay(db.pool);
  const ownerId = await createOwner(db.pool);
  const result = await admin(relay, { action: 'provision', ownerId, runtimeScope: ownerId, provider: 'dots' }, directory, undefined, undefined, registry);
  if (!('credentialsFile' in result)) throw new Error('Expected provisioning result');
  const failedOwner = await createOwner(db.pool);
  await expect(admin(relay, { action: 'provision', ownerId: failedOwner, runtimeScope: 'failed-runtime', provider: 'grok' }, join(result.credentialsFile, 'invalid'), undefined, undefined, registry)).rejects.toThrow();
  expect((await db.pool.query("SELECT 1 FROM bindings WHERE runtime_scope='failed-runtime'")).rowCount).toBe(0);
});

it('issues directory credentials to a private file without printing the secret', async () => {
  const relay = new Relay(db.pool);
  const ownerId = (await admin(relay, { action: 'create_owner' }, directory, undefined, undefined, registry) as { ownerId: string }).ownerId;
  const credentialsPath = join(directory, 'directory.json');
  const result = await admin(relay, {
    action: 'directory_issue',
    ownerId,
    audience: 'https://directory.example',
    credentialsPath,
  }, directory, undefined, undefined, registry);
  expect(result).not.toHaveProperty('secret');
  expect(result).toMatchObject({ status: 'active', credentialId: expect.any(String) });
  const saved = JSON.parse(await readFile(credentialsPath, 'utf8'));
  expect(saved.secret.length).toBeGreaterThanOrEqual(32);
  expect(JSON.stringify(result)).not.toContain(saved.secret);
});
