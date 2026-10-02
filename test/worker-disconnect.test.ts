import { afterAll, beforeAll, expect, it } from 'vitest';
import pg from 'pg';
import { Relay } from '../src/relay.js';
import { dispatchOne } from '../src/worker.js';
import { testDatabase } from './helpers.js';

let db: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => { db = await testDatabase(); });
afterAll(async () => { await db?.close(); });

it('aborts delivery after DB disconnect and preserves uncertain intent without replay', async () => {
  const relay = new Relay(db.pool);
  const a = await relay.provisionBinding({ ownerId: 'disconnect-a', runtimeScope: 'disconnect-a', provider: 'dots' });
  const b = await relay.provisionBinding({ ownerId: 'disconnect-b', runtimeScope: 'disconnect-b', provider: 'grok' });
  await relay.grantPair(a.bindingId, b.bindingId);
  const conversation = await relay.conversationOpen(a.token, {
    recipientBindingId: b.bindingId, text: 'Disconnect regression', expectsReply: true, idempotencyKey: 'disconnect',
  });
  // A separate pool can terminate the held connection even if the worker pool
  // has no available slot. Only this test's explicitly captured backend is killed.
  const control = new pg.Pool({ ...db.pool.options, max: 1, connectionTimeoutMillis: 2_000, query_timeout: 2_000 });
  let observedAbort = false;
  try {
    await dispatchOne(db.pool, {
      async deliver(notification, client) {
        if (!client || !notification.signal) throw new Error('Worker must pass its connection and abort signal');
        const signal = notification.signal;
        const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let onAbort: (() => void) | undefined;
        const aborted = new Promise<void>((resolve, reject) => {
          onAbort = () => { observedAbort = true; resolve(); };
          signal.addEventListener('abort', onAbort, { once: true });
          timer = setTimeout(() => reject(new Error('DB disconnect did not abort delivery')), 2_000);
        });
        // Attach the handler before asking PostgreSQL to terminate the socket.
        try {
          const terminated = await control.query<{ terminated: boolean }>('SELECT pg_terminate_backend($1) AS terminated', [pid]);
          expect(terminated.rows[0]!.terminated).toBe(true);
          await aborted;
          // Simulate a response arriving as the DB connection dies. It must not
          // turn the previously committed uncertain intent into a replayable row.
          return { status: 'accepted' };
        } finally {
          if (timer) clearTimeout(timer);
          if (onAbort) signal.removeEventListener('abort', onAbort);
        }
      },
    });
    expect(observedAbort).toBe(true);
    const read = await relay.conversationRead(a.token, { conversationId: conversation.conversationId });
    expect(read.outbox[0]).toMatchObject({ status: 'uncertain', attempts: 1 });
    let sends = 0;
    expect(await dispatchOne(db.pool, { async deliver() { sends++; return { status: 'accepted' }; } })).toBe(false);
    expect(sends).toBe(0);
  } finally {
    await control.end();
  }
});
