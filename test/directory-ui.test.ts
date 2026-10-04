import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { DirectoryRegistry } from '../src/directory.js';
import { errorGuidance, sanitizeText, summarizeInventory } from '../src/directory-ui-format.js';
import { Relay } from '../src/relay.js';
import { createOwner, provision, testDatabase } from './helpers.js';

const audience = 'https://directory.example';

describe('directory UI helpers', () => {
  it('strips control characters and summarizes inventory without secrets', () => {
    expect(sanitizeText('ok\u0007id')).toBe('okid');
    const summary = summarizeInventory({
      schemaVersion: 1,
      checkedAt: '2026-10-04T07:00:00.000Z',
      scope: { connectionId: null },
      complete: true,
      connections: [{
        connectionId: '11111111-1111-4111-8111-111111111111',
        provider: 'dots',
        registration: 'active',
        identityUnit: 'connection',
        contacts: [{
          connectionId: '22222222-2222-4222-8222-222222222222',
          provider: 'grok',
          sameOwner: true,
          permission: 'recorded',
          recordedVia: 'operator',
          registrationAllowsCommunication: true,
        }],
      }, {
        connectionId: '22222222-2222-4222-8222-222222222222',
        provider: 'grok',
        registration: 'active',
        identityUnit: 'connection',
        contacts: [{
          connectionId: '11111111-1111-4111-8111-111111111111',
          provider: 'dots',
          sameOwner: true,
          permission: 'recorded',
          recordedVia: 'operator',
          registrationAllowsCommunication: true,
        }],
      }],
    });
    expect(summary.totals).toBe('2 connections · 1 relationship');
    expect(summary.emptyMessage).toBeNull();
    expect(errorGuidance('unauthorized')).toContain('reissue');
  });
});

describe('directory UI routes', () => {
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

  it('stays unregistered when the directory feature is off', async () => {
    const response = await buildApp(relay).inject({ method: 'GET', url: '/directory' });
    expect(response.statusCode).toBe(404);
  });

  it('serves a CSP-protected English page with achromatic chrome', async () => {
    const app = buildApp(relay, { directory: { pool: db.pool, audience } });
    const page = await app.inject({ method: 'GET', url: '/directory' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
    expect(page.headers['content-security-policy']).toContain("connect-src 'self'");
    expect(page.body).toContain('lang="en"');
    expect(page.body).toContain('Anybots');
    expect(page.body).toContain('Show connections');
    expect(page.body).toContain('Directory browsing key');
    expect(page.body).not.toContain('一覧');
    expect(page.body).not.toContain('閲覧鍵');
    expect(page.body).toContain('/directory/app.js');
    expect(page.body).not.toContain('sessionStorage');
    expect(page.body).not.toMatch(/Bearer /);

    const css = await app.inject({ method: 'GET', url: '/directory/app.css' });
    const js = await app.inject({ method: 'GET', url: '/directory/app.js' });
    expect(css.statusCode).toBe(200);
    expect(js.statusCode).toBe(200);
    expect(css.headers['cache-control']).toBe('no-store');
    expect(css.body).toContain('--ink: #0d0d0d');
    expect(css.body).toContain('--rail: #f8f8f8');
    expect(css.body).not.toMatch(/#0f766e|#0d9488|teal|0f766e/i);
    expect(js.body).toContain('/v1/me/connections');
    expect(js.body).toContain('sessionStorage');
    expect(js.body).toContain('Your connection');
    expect(js.body).not.toContain(audience);
    expect(js.body).not.toContain('一覧を表示');
  });

  it('loads inventory through the shared API without exposing secrets in HTML', async () => {
    const owner = await createOwner(db.pool);
    const a = await provision(relay, db.pool, { provider: 'dots', ownerId: owner });
    const b = await provision(relay, db.pool, { provider: 'grok', ownerId: owner });
    await relay.grantPair(a.bindingId, b.bindingId);
    const issued = await directory.issue({ ownerId: owner, audience });
    const app = buildApp(relay, { directory: { pool: db.pool, audience } });

    const api = await app.inject({
      method: 'GET',
      url: '/v1/me/connections',
      headers: { authorization: `Bearer ${issued.secret}` },
    });
    expect(api.statusCode).toBe(200);
    const body = api.json();
    expect(JSON.stringify(body)).not.toContain(issued.secret);
    expect(JSON.stringify(body)).not.toContain(owner);

    const page = await app.inject({ method: 'GET', url: '/directory' });
    expect(page.body).not.toContain(issued.secret);
    expect(page.body).not.toContain(a.token);
    expect(page.body).toContain('Directory browsing key');
  });

  it('keeps connection filter available to the client script', async () => {
    const js = await buildApp(relay, { directory: { pool: db.pool, audience } })
      .inject({ method: 'GET', url: '/directory/app.js' });
    expect(js.body).toContain('connection_id');
    expect(js.body).toContain('abort');
  });
});
