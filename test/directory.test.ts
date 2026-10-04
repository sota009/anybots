import { afterAll, beforeAll, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DirectoryRegistry } from '../src/directory.js';
import { readDirectoryCredentialFile, writeDirectoryCredentialFile } from '../src/directory-file.js';
import { Relay } from '../src/relay.js';
import { createOwner, testDatabase } from './helpers.js';

let db: Awaited<ReturnType<typeof testDatabase>>;
let directory: DirectoryRegistry;
beforeAll(async () => {
  db = await testDatabase();
  directory = new DirectoryRegistry(db.pool);
});
afterAll(async () => { await db?.close(); });

it('rejects unknown owners and keeps bindings pinned to one owner uuid', async () => {
  const relay = new Relay(db.pool);
  await expect(relay.provisionBinding({
    ownerId: randomUUID(), runtimeScope: randomUUID(), provider: 'dots',
  })).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(relay.provisionBinding({
    ownerId: 'label-not-uuid', runtimeScope: randomUUID(), provider: 'dots',
  } as never)).rejects.toMatchObject({ code: 'invalid_input' });

  const ownerA = await createOwner(db.pool);
  const ownerB = await createOwner(db.pool);
  const a = await relay.provisionBinding({ ownerId: ownerA, runtimeScope: randomUUID(), provider: 'dots' });
  const b = await relay.provisionBinding({ ownerId: ownerB, runtimeScope: randomUUID(), provider: 'grok' });
  expect(a.ownerId).toBe(ownerA);
  expect(b.ownerId).toBe(ownerB);
  expect((await db.pool.query('SELECT owner_id FROM bindings WHERE id=$1', [a.bindingId])).rows[0].owner_id).toBe(ownerA);
});

it('issues one live directory credential and never resurrects revoked ids', async () => {
  const ownerId = await createOwner(db.pool);
  const audience = 'https://directory.example';
  const first = await directory.issue({ ownerId, audience, credentialId: randomUUID() });
  expect(first.status).toBe('active');
  expect(first.secret.length).toBeGreaterThanOrEqual(32);
  expect(JSON.stringify(first)).toContain(first.secret);

  const second = await directory.issue({ ownerId, audience });
  expect(second.credentialId).not.toBe(first.credentialId);
  expect((await directory.status({ credentialId: first.credentialId })).status).toBe('revoked');
  expect((await directory.status({ credentialId: second.credentialId })).status).toBe('active');

  const replay = await directory.issue({
    ownerId,
    audience,
    credentialId: first.credentialId,
    secret: first.secret,
  });
  expect(replay.status).toBe('revoked');
  expect((await directory.status({ credentialId: second.credentialId })).status).toBe('active');

  await expect(directory.issue({
    ownerId,
    audience,
    credentialId: first.credentialId,
    secret: second.secret,
  })).rejects.toMatchObject({ code: 'idempotency_conflict' });
});

it('disables directory access and revokes every live credential', async () => {
  const ownerId = await createOwner(db.pool);
  const issued = await directory.issue({ ownerId, audience: 'https://directory.example' });
  await directory.disableDirectory({ ownerId });
  expect((await directory.status({ credentialId: issued.credentialId })).status).toBe('revoked');
  expect((await db.pool.query('SELECT directory_enabled FROM owners WHERE id=$1', [ownerId])).rows[0].directory_enabled).toBe(false);
});

it('writes private credential files and rejects symlink secrets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anybots-dir-'));
  await chmod(root, 0o700);
  const file = join(root, 'directory.json');
  const issued = {
    credentialId: randomUUID(),
    secret: randomUUID() + randomUUID(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    audience: 'https://directory.example',
  };
  await writeDirectoryCredentialFile(file, issued);
  expect((await readDirectoryCredentialFile(file)).secret).toBe(issued.secret);
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(issued);

  const linked = join(root, 'linked.json');
  await symlink(file, linked);
  await expect(readDirectoryCredentialFile(linked)).rejects.toThrow(/credential_path_rejected|ELOOP/);
});

it('keeps delivery_attempts.owner_id aligned to owners.id', async () => {
  const relay = new Relay(db.pool);
  const ownerId = await createOwner(db.pool);
  const a = await relay.provisionBinding({ ownerId, runtimeScope: randomUUID(), provider: 'dots' });
  const b = await relay.provisionBinding({ ownerId: await createOwner(db.pool), runtimeScope: randomUUID(), provider: 'grok' });
  await relay.grantPair(a.bindingId, b.bindingId);
  const opened = await relay.conversationOpen(a.token, {
    recipientBindingId: b.bindingId, text: 'hello', expectsReply: true, idempotencyKey: randomUUID(),
  });
  const outbox = await db.pool.query<{ id: string }>('SELECT id FROM outbox WHERE conversation_id=$1', [opened.conversationId]);
  await db.pool.query(
    `INSERT INTO delivery_attempts(id,outbox_id,binding_id,owner_id,status) VALUES($1,$2,$3,$4,'uncertain')`,
    [randomUUID(), outbox.rows[0]!.id, b.bindingId, b.ownerId],
  );
  await expect(db.pool.query(
    `INSERT INTO delivery_attempts(id,outbox_id,binding_id,owner_id,status) VALUES($1,$2,$3,$4,'uncertain')`,
    [randomUUID(), outbox.rows[0]!.id, b.bindingId, 'not-a-uuid'],
  )).rejects.toThrow();
});
