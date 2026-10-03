import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { EventSubscriptions } from '../src/events.js';
import { PublicHttpsTransport } from '../src/providers/transport.js';
import { Relay } from '../src/relay.js';
import { testDatabase } from './helpers.js';

describe('callback onboarding diagnostics', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>;
  beforeAll(async () => { db = await testDatabase(); });
  afterAll(async () => { await db?.close(); });

  it('returns only an unlisted hostname through authenticated MCP and stores no subscription', async () => {
    const relay = new Relay(db.pool);
    const binding = await relay.provisionBinding({ ownerId: 'pilot', runtimeScope: 'diagnostics', provider: 'dots' });
    const events = new EventSubscriptions(db.pool, { encryptionKey: randomBytes(32), transport: new PublicHttpsTransport(['api2.cursor.sh']) });
    const diagnostics = vi.fn();
    const app = buildApp(relay, { events, onEventDiagnostic: diagnostics });
    const secret = `whsec_${randomBytes(32).toString('base64')}`;
    const call = async (url: string, authenticated = true) => app.inject({ method: 'POST', url: '/mcp',
      headers: { host: 'localhost', accept: 'application/json, text/event-stream', 'mcp-method': 'events/subscribe',
        'mcp-protocol-version': '2026-07-28', ...(authenticated ? { authorization: `Bearer ${binding.token}` } : {}) },
      payload: { jsonrpc: '2.0', id: 1, method: 'events/subscribe', params: { name: 'inbox.ready', arguments: {},
        _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} },
        delivery: { mode: 'webhook', url, secret } } } });
    try {
      const response = await call('https://callback.example.com/private-path?token=private-query');
      expect(response.json().error.data).toEqual({ reason: 'callback_host_not_allowed', callbackHost: 'callback.example.com' });
      expect(diagnostics).toHaveBeenLastCalledWith({ event: 'mcp_event_request', method: 'events/subscribe', outcome: 'failed',
        reason: 'callback_host_not_allowed', callbackHost: 'callback.example.com' });
      for (const sensitive of ['private-path', 'private-query', secret, binding.token, binding.bindingId]) {
        expect(JSON.stringify(diagnostics.mock.calls)).not.toContain(sensitive);
      }
      for (const sensitive of ['private-path', 'private-query', secret]) expect(response.body).not.toContain(sensitive);
      for (const url of ['https://user:secret@callback.example.com/path', 'https://callback.example.com:8443/path', 'https://127.0.0.1/path']) {
        const rejected = await call(url);
        expect(rejected.json().error.data).toEqual({ reason: 'challenge_failed' });
        expect(rejected.body).not.toContain('callbackHost');
      }
      const diagnosticCount = diagnostics.mock.calls.length;
      expect((await call('https://callback.example.com/private', false)).statusCode).toBe(401);
      expect(diagnostics).toHaveBeenCalledTimes(diagnosticCount);
      expect((await db.pool.query('SELECT count(*) FROM event_subscriptions')).rows[0].count).toBe('0');
    } finally { await app.close(); }
  });

  it('classifies unexpected failures without logging raw errors and tolerates a broken diagnostic sink', async () => {
    const relay = new Relay(db.pool);
    const binding = await relay.provisionBinding({ ownerId: 'pilot', runtimeScope: 'diagnostic-errors', provider: 'dots' });
    const diagnostics = vi.fn(() => { throw new Error('sink failed'); });
    const events = { catalog: () => ({}), subscribe: async () => { throw new Error('private-database-url'); },
      unsubscribe: async () => ({}) };
    const app = buildApp(relay, { events, onEventDiagnostic: diagnostics });
    const call = (method: string) => app.inject({ method: 'POST', url: '/mcp',
      headers: { host: 'localhost', accept: 'application/json, text/event-stream', 'mcp-method': method,
        'mcp-protocol-version': '2026-07-28', authorization: `Bearer ${binding.token}` },
      payload: { jsonrpc: '2.0', id: 1, method, params: {
        _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } } });
    try {
      const failed = await call('events/subscribe');
      expect(failed.json().error.code).toBe(-32603);
      expect(diagnostics).toHaveBeenLastCalledWith({ event: 'mcp_event_request', method: 'events/subscribe', outcome: 'failed', reason: 'request_failed' });
      expect(JSON.stringify(diagnostics.mock.calls)).not.toContain('private-database-url');
      const succeeded = await call('events/unsubscribe');
      expect(succeeded.json().error).toBeUndefined();
      expect(succeeded.json().result).toMatchObject({ resultType: 'complete' });
      expect(diagnostics).toHaveBeenLastCalledWith({ event: 'mcp_event_request', method: 'events/unsubscribe', outcome: 'succeeded' });
    } finally { await app.close(); }
  });
});
