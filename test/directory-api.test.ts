import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { DirectoryRegistry } from '../src/directory.js';
import { directoryResponseSchema } from '../src/directory-inventory.js';
import { Relay } from '../src/relay.js';
import { createOwner, provision, testDatabase } from './helpers.js';

const audience = 'https://directory.example';

describe('owner connection directory API', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>;
  let relay: Relay;
  let directory: DirectoryRegistry;
  beforeAll(async () => {
    db = await testDatabase();
    relay = new Relay(db.pool);
    directory = new DirectoryRegistry(db.pool);
  });
  afterAll(async () => { await db?.close(); });
  beforeEach(async () => {
    await db.pool.query('TRUNCATE directory_credentials, bindings, grants, owners CASCADE');
  });

  async function issue(ownerId: string) {
    return directory.issue({ ownerId, audience });
  }

  function app() {
    return buildApp(relay, { directory: { pool: db.pool, audience } });
  }

  it('returns only one hop of contacts for the authenticated owner', async () => {
    const ownerA = await createOwner(db.pool);
    const ownerB = await createOwner(db.pool);
    const a1 = await provision(relay, db.pool, { provider: 'dots', ownerId: ownerA });
    const a2 = await provision(relay, db.pool, { provider: 'grok', ownerId: ownerA });
    const b1 = await provision(relay, db.pool, { provider: 'muse', ownerId: ownerB });
    const stranger = await provision(relay, db.pool, { provider: 'dots', ownerId: await createOwner(db.pool) });
    await relay.grantPair(a1.bindingId, a2.bindingId);
    await relay.grantPair(a2.bindingId, b1.bindingId);
    await relay.grantPair(b1.bindingId, stranger.bindingId);
    const cred = await issue(ownerA);

    const response = await app().inject({
      method: 'GET',
      url: '/v1/me/connections',
      headers: { authorization: `Bearer ${cred.secret}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = directoryResponseSchema.parse(response.json());
    expect(body.complete).toBe(true);
    expect(body.scope.connectionId).toBeNull();
    expect(body.connections.map((row) => row.connectionId)).toEqual([a1.bindingId, a2.bindingId].sort());
    const dots = body.connections.find((row) => row.connectionId === a1.bindingId)!;
    expect(dots.contacts).toEqual([{
      connectionId: a2.bindingId,
      provider: 'grok',
      sameOwner: true,
      permission: 'recorded',
      recordedVia: 'operator',
      registrationAllowsCommunication: true,
    }]);
    const grok = body.connections.find((row) => row.connectionId === a2.bindingId)!;
    expect(grok.contacts.map((c) => c.connectionId).sort()).toEqual([a1.bindingId, b1.bindingId].sort());
    expect(grok.contacts.find((c) => c.connectionId === b1.bindingId)).toMatchObject({
      sameOwner: false,
      provider: 'muse',
    });
    const dumped = JSON.stringify(body);
    expect(dumped).not.toContain(ownerA);
    expect(dumped).not.toContain(ownerB);
    expect(dumped).not.toContain(stranger.bindingId);
    expect(dumped).not.toContain(a1.token);
    expect(dumped).not.toContain(cred.secret);
  });

  it('rejects binding tokens, foreign connection ids, and disabled directory access the same way', async () => {
    const ownerA = await createOwner(db.pool);
    const ownerB = await createOwner(db.pool);
    const a = await provision(relay, db.pool, { provider: 'dots', ownerId: ownerA });
    const b = await provision(relay, db.pool, { provider: 'grok', ownerId: ownerB });
    const cred = await issue(ownerA);
    const server = app();

    const bindingToken = await server.inject({
      method: 'GET', url: '/v1/me/connections', headers: { authorization: `Bearer ${a.token}` },
    });
    expect(bindingToken.statusCode).toBe(401);
    expect(bindingToken.json()).toMatchObject({ error: 'unauthorized' });
    expect(bindingToken.headers['www-authenticate']).toBe('Bearer');

    const foreign = await server.inject({
      method: 'GET',
      url: `/v1/me/connections?connection_id=${b.bindingId}`,
      headers: { authorization: `Bearer ${cred.secret}` },
    });
    const missing = await server.inject({
      method: 'GET',
      url: `/v1/me/connections?connection_id=${randomUUID()}`,
      headers: { authorization: `Bearer ${cred.secret}` },
    });
    expect(foreign.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(foreign.json()).toMatchObject({ error: 'connection_not_found' });
    expect(missing.json()).toMatchObject({ error: 'connection_not_found' });

    await directory.disableDirectory({ ownerId: ownerA });
    const disabled = await server.inject({
      method: 'GET', url: '/v1/me/connections', headers: { authorization: `Bearer ${cred.secret}` },
    });
    expect(disabled.statusCode).toBe(401);
  });

  it('keeps disabled own connections, hides revoked peers, and counts same-owner pairs once each way', async () => {
    const owner = await createOwner(db.pool);
    const a = await provision(relay, db.pool, { provider: 'dots', ownerId: owner });
    const b = await provision(relay, db.pool, { provider: 'grok', ownerId: owner });
    await relay.grantPair(a.bindingId, b.bindingId);
    // Keep the grant active while the registration itself is disabled.
    await db.pool.query('UPDATE bindings SET active=false WHERE id=$1', [a.bindingId]);
    const cred = await issue(owner);
    const server = app();

    const listed = directoryResponseSchema.parse((await server.inject({
      method: 'GET', url: '/v1/me/connections', headers: { authorization: `Bearer ${cred.secret}` },
    })).json());
    expect(listed.connections).toHaveLength(2);
    expect(listed.connections.find((row) => row.connectionId === a.bindingId)?.registration).toBe('disabled');
    expect(listed.connections.find((row) => row.connectionId === a.bindingId)?.contacts[0]).toMatchObject({
      connectionId: b.bindingId,
      registrationAllowsCommunication: false,
    });

    await relay.revokePair(a.bindingId, b.bindingId);
    const afterRevoke = directoryResponseSchema.parse((await server.inject({
      method: 'GET', url: '/v1/me/connections', headers: { authorization: `Bearer ${cred.secret}` },
    })).json());
    expect(afterRevoke.connections.every((row) => row.contacts.length === 0)).toBe(true);
  });

  it('returns inventory_too_large without partial data when contact rows exceed the cap', async () => {
    const owner = await createOwner(db.pool);
    const hub = await provision(relay, db.pool, { provider: 'dots', ownerId: owner });
    for (let index = 0; index < 1001; index += 1) {
      const peer = await provision(relay, db.pool, {
        provider: index % 2 === 0 ? 'grok' : 'muse',
        ownerId: await createOwner(db.pool),
      });
      await relay.grantPair(hub.bindingId, peer.bindingId);
    }
    const cred = await issue(owner);
    const response = await app().inject({
      method: 'GET',
      url: `/v1/me/connections?connection_id=${hub.bindingId}`,
      headers: { authorization: `Bearer ${cred.secret}` },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: 'inventory_too_large' });
    expect(response.json()).not.toHaveProperty('connections');
  }, 120_000);

  it('does not mutate relay state or accept unknown query keys', async () => {
    const owner = await createOwner(db.pool);
    const a = await provision(relay, db.pool, { provider: 'dots', ownerId: owner });
    const b = await provision(relay, db.pool, { provider: 'grok', ownerId: owner });
    await relay.grantPair(a.bindingId, b.bindingId);
    const before = await db.pool.query('SELECT count(*)::int AS n FROM grants');
    const cred = await issue(owner);
    const bad = await app().inject({
      method: 'GET',
      url: '/v1/me/connections?owner=1',
      headers: { authorization: `Bearer ${cred.secret}` },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: 'invalid_request' });
    const after = await db.pool.query('SELECT count(*)::int AS n FROM grants');
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('stays unregistered when the directory feature flag is off', async () => {
    const response = await buildApp(relay).inject({ method: 'GET', url: '/v1/me/connections' });
    expect(response.statusCode).toBe(404);
  });
});
