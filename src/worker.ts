import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { NotificationDispatcher, DeliveryResult } from './providers/index.js';

const MAX_ATTEMPTS = 3;
const DAILY_NOTIFICATION_BUDGET = 20;
const MONTHLY_NOTIFICATION_BUDGET = 100;
const LOCK_KEY = 718401;

/** Calendar windows use the DB timestamp and UTC, independent of host timezone. */
export function notificationBudgetWindows(at: Date) {
  const year = at.getUTCFullYear(), month = at.getUTCMonth(), day = at.getUTCDate();
  return {
    dayStart: new Date(Date.UTC(year, month, day)),
    dayEnd: new Date(Date.UTC(year, month, day + 1)),
    monthStart: new Date(Date.UTC(year, month, 1)),
    monthEnd: new Date(Date.UTC(year, month + 1, 1)),
  };
}

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
      provider: 'dots' | 'grok'; owner_id: string; attempts: number; created_at: Date; attempt_at: Date;
      valid: boolean;
    }>(`SELECT o.*, b.provider, b.owner_id, now() AS attempt_at,
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
    const window = notificationBudgetWindows(row.attempt_at);
    const budget = (await client.query<{ day_count: string; month_count: string }>(
      `SELECT count(*) FILTER(WHERE started_at >= $1 AND started_at < $2) AS day_count,
         count(*) AS month_count FROM delivery_attempts WHERE started_at >= $3 AND started_at < $4`,
      [window.dayStart, window.dayEnd, window.monthStart, window.monthEnd])).rows[0]!;
    if (Number(budget.day_count) >= DAILY_NOTIFICATION_BUDGET || Number(budget.month_count) >= MONTHLY_NOTIFICATION_BUDGET) {
      // Terminal: a budget rejection must not silently wake the AI tomorrow.
      // No attempt is charged because the dispatcher will not be called.
      await client.query("UPDATE outbox SET status='failed',last_error='budget_exceeded',updated_at=now() WHERE id=$1", [row.id]);
      await client.query('COMMIT'); inTransaction = false; return true;
    }
    const attemptId = randomUUID();
    await client.query(`INSERT INTO delivery_attempts(id,outbox_id,binding_id,owner_id,status,started_at) VALUES($1,$2,$3,$4,'uncertain',$5)`,
      [attemptId, row.id, row.binding_id, row.owner_id, row.attempt_at]);
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
