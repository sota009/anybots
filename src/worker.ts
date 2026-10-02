import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { NotificationDispatcher, DeliveryResult } from './providers/index.js';

const MAX_ATTEMPTS = 3;
const HOURLY_LIMIT = 60;
const LOCK_KEY = 718401;

/**
 * Session lock orders stop/revoke against network activity. Persist uncertain
 * BEFORE sending: crash/DB loss never turns an ambiguous POST into a fresh retry.
 * Every dispatcher process and relay mutation must share this DB lock.
 * This is a bounded, low-throughput pilot; it is not remote execution fencing.
 */
export async function dispatchOne(pool: Pool, dispatcher: NotificationDispatcher): Promise<boolean> {
  const client = await pool.connect();
  const abort = new AbortController();
  const lost = () => abort.abort();
  client.on('error', lost);
  let locked = false;
  let inTransaction = false;
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    locked = true;
    await client.query('BEGIN'); inTransaction = true;
    const rows = await client.query<{
      id: string; binding_id: string; conversation_id: string; message_id: string;
      provider: 'dots' | 'grok'; owner_id: string; attempts: number; created_at: Date;
      valid: boolean;
    }>(`SELECT o.*, b.provider, b.owner_id,
       (b.active AND a.active AND z.active AND c.status='open' AND c.epoch=o.epoch
        AND c.expires_at>now() AND g.active) AS valid
       FROM outbox o JOIN bindings b ON b.id=o.binding_id
       JOIN conversations c ON c.id=o.conversation_id
       JOIN bindings a ON a.id=c.binding_a JOIN bindings z ON z.id=c.binding_b
       JOIN grants g ON g.binding_a=LEAST(c.binding_a,c.binding_b)
                    AND g.binding_b=GREATEST(c.binding_a,c.binding_b)
       WHERE o.status='pending' AND o.next_attempt_at<=now()
       ORDER BY o.created_at,o.id LIMIT 1 FOR UPDATE OF o`);
    const row = rows.rows[0];
    if (!row) { await client.query('COMMIT'); inTransaction = false; return false; }
    if (!row.valid || row.attempts >= MAX_ATTEMPTS) {
      await client.query("UPDATE outbox SET status=$2,updated_at=now() WHERE id=$1", [row.id, row.valid ? 'failed' : 'cancelled']);
      await client.query('COMMIT'); inTransaction = false; return true;
    }
    const counts = await client.query<{ binding_count: string; owner_count: string }>(
      `SELECT count(*) FILTER(WHERE binding_id=$1) AS binding_count, count(*) AS owner_count
       FROM delivery_attempts WHERE owner_id=$2 AND started_at>now()-interval '1 hour'`, [row.binding_id, row.owner_id]);
    const count = counts.rows[0]!;
    if (Number(count.binding_count) >= HOURLY_LIMIT || Number(count.owner_count) >= HOURLY_LIMIT) {
      await client.query("UPDATE outbox SET next_attempt_at=now()+interval '1 minute',last_error='rate_limited',updated_at=now() WHERE id=$1", [row.id]);
      await client.query('COMMIT'); inTransaction = false; return true;
    }
    const attemptId = randomUUID();
    await client.query(`INSERT INTO delivery_attempts(id,outbox_id,binding_id,owner_id,status) VALUES($1,$2,$3,$4,'uncertain')`,
      [attemptId, row.id, row.binding_id, row.owner_id]);
    await client.query("UPDATE outbox SET status='uncertain',attempts=attempts+1,last_error='delivery_in_progress',updated_at=now() WHERE id=$1", [row.id]);
    await client.query('COMMIT'); inTransaction = false;
    if (abort.signal.aborted) return true;
    let outcome: DeliveryResult;
    try {
      outcome = await dispatcher.deliver({
        id: row.id, bindingId: row.binding_id, conversationId: row.conversation_id,
        messageId: row.message_id, provider: row.provider, occurredAt: row.created_at.toISOString(), signal: abort.signal,
      }, client);
    } catch { outcome = { status: 'uncertain' }; }
    if (abort.signal.aborted) return true;
    const retry = outcome.status === 'retry' && row.attempts + 1 < MAX_ATTEMPTS;
    const status = retry ? 'pending' : outcome.status === 'accepted' ? 'accepted' : outcome.status === 'uncertain' ? 'uncertain' : 'failed';
    // Do not shorten a provider's requested wait. Long waits are safe: expiry is
    // rechecked immediately before the next attempt.
    const requestedWait = outcome.retryAfterMs;
    const delay = requestedWait !== undefined && Number.isFinite(requestedWait) && requestedWait >= 0
      ? Math.max(1000, requestedWait) : 1000 * 2 ** row.attempts;
    await client.query('BEGIN'); inTransaction = true;
    await client.query(`UPDATE outbox SET status=$2,next_attempt_at=now()+($3::double precision * interval '1 millisecond'),
      last_error=$4,updated_at=now() WHERE id=$1`, [row.id, status, delay, outcome.status === 'accepted' ? null : outcome.status]);
    await client.query('UPDATE delivery_attempts SET status=$2,finished_at=now() WHERE id=$1', [attemptId, outcome.status]);
    await client.query('COMMIT'); inTransaction = false;
    return true;
  } finally {
    try { if (inTransaction && !abort.signal.aborted) await client.query('ROLLBACK'); }
    finally {
      try { if (locked && !abort.signal.aborted) await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]); }
      finally { client.removeListener('error', lost); client.release(abort.signal.aborted); }
    }
  }
}
