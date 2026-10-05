import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { lockRelay, withTransaction } from './db.js';
import type { NotificationDispatcher, DeliveryResult } from './providers/index.js';
import { DEFAULT_NOTIFICATION_BUDGET, validateNotificationBudget, type NotificationBudget } from './notification-budget.js';
import type { Signals } from './signals.js';
import type { Provider } from './relay.js';

const MAX_ATTEMPTS = 3;
const SEND_TIMEOUT_MS = 15_000;

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

type Reserved = {
  id: string; binding_id: string; conversation_id: string; message_id: string;
  provider: Provider; attempts: number; created_at: Date; attemptId: string;
};

/**
 * Reservation runs under the relay lock and commits `uncertain` BEFORE the
 * network: a crash never turns an ambiguous POST into a fresh retry, and the
 * budget is charged once. A stop committed after reservation can let at most
 * this one bodyless hint through; claim rechecks state, so no body leaks.
 */
async function reserve(pool: Pool, limits: NotificationBudget): Promise<Reserved | 'none' | 'skipped'> {
  return withTransaction(pool, async client => {
    await lockRelay(client);
    const rows = await client.query<Omit<Reserved, 'attemptId'> & { owner_id: string; attempt_at: Date; valid: boolean }>(
      `SELECT o.*, b.provider, b.owner_id, now() AS attempt_at,
       (b.active AND a.active AND z.active AND c.status='open' AND c.epoch=o.epoch
        AND c.expires_at>now() AND g.active) AS valid
       FROM outbox o JOIN bindings b ON b.id=o.binding_id
       JOIN conversations c ON c.id=o.conversation_id
       JOIN bindings a ON a.id=c.binding_a JOIN bindings z ON z.id=c.binding_b
       JOIN grants g ON g.binding_a=LEAST(c.binding_a,c.binding_b)
                    AND g.binding_b=GREATEST(c.binding_a,c.binding_b)
       WHERE o.status='pending' AND o.next_attempt_at<=now()
       ORDER BY o.created_at,o.id LIMIT 1`);
    const row = rows.rows[0];
    if (!row) return 'none';
    if (!row.valid || row.attempts >= MAX_ATTEMPTS) {
      await client.query('UPDATE outbox SET status=$2,updated_at=now() WHERE id=$1', [row.id, row.valid ? 'failed' : 'cancelled']);
      return 'skipped';
    }
    const window = notificationBudgetWindows(row.attempt_at);
    const usage = (await client.query<{ day_count: string; month_count: string }>(
      `SELECT count(*) FILTER(WHERE started_at >= $1 AND started_at < $2) AS day_count,
         count(*) AS month_count FROM delivery_attempts WHERE started_at >= $3 AND started_at < $4`,
      [window.dayStart, window.dayEnd, window.monthStart, window.monthEnd])).rows[0]!;
    if (Number(usage.day_count) >= limits.daily || Number(usage.month_count) >= limits.monthly) {
      // Terminal: a budget rejection must not silently wake the AI tomorrow.
      await client.query("UPDATE outbox SET status='failed',last_error='budget_exceeded',updated_at=now() WHERE id=$1", [row.id]);
      return 'skipped';
    }
    const attemptId = randomUUID();
    await client.query(`INSERT INTO delivery_attempts(id,outbox_id,binding_id,owner_id,status,started_at) VALUES($1,$2,$3,$4,'uncertain',$5)`,
      [attemptId, row.id, row.binding_id, row.owner_id, row.attempt_at]);
    await client.query("UPDATE outbox SET status='uncertain',attempts=attempts+1,last_error='delivery_in_progress',updated_at=now() WHERE id=$1", [row.id]);
    return { id: row.id, binding_id: row.binding_id, conversation_id: row.conversation_id, message_id: row.message_id,
      provider: row.provider, attempts: row.attempts, created_at: row.created_at, attemptId };
  });
}

/** Sends one due notification. No database connection or lock is held during the network call. */
export async function dispatchOne(pool: Pool, dispatcher: NotificationDispatcher, budget: NotificationBudget = DEFAULT_NOTIFICATION_BUDGET): Promise<boolean> {
  const row = await reserve(pool, validateNotificationBudget(budget));
  if (row === 'none') return false;
  if (row === 'skipped') return true;
  let outcome: DeliveryResult;
  try {
    outcome = await dispatcher.deliver({
      id: row.id, bindingId: row.binding_id, conversationId: row.conversation_id,
      messageId: row.message_id, provider: row.provider, occurredAt: row.created_at.toISOString(),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch { outcome = { status: 'uncertain' }; }
  const retry = outcome.status === 'retry' && row.attempts + 1 < MAX_ATTEMPTS;
  const status = retry ? 'pending' : outcome.status === 'accepted' ? 'accepted' : outcome.status === 'uncertain' ? 'uncertain' : 'failed';
  // Never shorten a provider's requested wait; validity is rechecked before every attempt.
  const requestedWait = outcome.retryAfterMs;
  const delay = requestedWait !== undefined && Number.isFinite(requestedWait) && requestedWait >= 0
    ? Math.max(1000, requestedWait) : 1000 * 2 ** row.attempts;
  await withTransaction(pool, async client => {
    await client.query(`UPDATE outbox SET status=$2,next_attempt_at=now()+($3::double precision * interval '1 millisecond'),
      last_error=$4,updated_at=now() WHERE id=$1 AND status='uncertain'`, [row.id, status, delay, outcome.status === 'accepted' ? null : outcome.status]);
    await client.query('UPDATE delivery_attempts SET status=$2,finished_at=now() WHERE id=$1', [row.attemptId, outcome.status]);
  });
  return true;
}

/**
 * In-process delivery: woken by NOTIFY after commit, with a periodic sweep
 * for retries and anything committed while LISTEN was disconnected.
 */
export class Dispatcher {
  private running = 0;
  private again = false;
  private stopped = true;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private unsubscribe: (() => void) | undefined;
  private readonly idle = new Set<() => void>();

  constructor(private readonly pool: Pool, private readonly dispatcher: NotificationDispatcher, private readonly options: {
    budget?: NotificationBudget; signals?: Signals; concurrency?: number; sweepMs?: number; onError?: () => void;
  } = {}) {}

  start() {
    this.stopped = false;
    this.unsubscribe = this.options.signals?.onOutbox(() => this.kick());
    this.kick();
  }

  kick() {
    if (this.stopped) return;
    // A hint that arrives while every slot is finishing must not wait for the sweep.
    if (this.running > 0) this.again = true;
    while (this.running < (this.options.concurrency ?? 4)) {
      this.running++;
      void this.loop();
    }
  }

  private async loop() {
    let due: number | undefined;
    try {
      while (!this.stopped && await dispatchOne(this.pool, this.dispatcher, this.options.budget ?? DEFAULT_NOTIFICATION_BUDGET)) { /* drain */ }
      if (!this.stopped) due = await this.nextDueMs();
    } catch {
      try { this.options.onError?.(); } catch { /* Diagnostics must not stop delivery. */ }
    } finally {
      this.running--;
      if (this.running === 0) {
        for (const done of this.idle) done();
        this.idle.clear();
        if (this.again && !this.stopped) { this.again = false; this.kick(); }
        else this.schedule(due);
      }
    }
  }

  private async nextDueMs(): Promise<number | undefined> {
    const row = (await this.pool.query<{ ms: number | null }>(
      "SELECT extract(epoch from (min(next_attempt_at)-now()))*1000 AS ms FROM outbox WHERE status='pending'")).rows[0];
    return row?.ms === null || row?.ms === undefined ? undefined : Math.max(0, Number(row.ms));
  }

  private schedule(dueMs: number | undefined) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    const sweep = this.options.sweepMs ?? 30_000;
    this.timer = setTimeout(() => { this.timer = undefined; this.kick(); }, Math.min(sweep, dueMs ?? sweep));
    this.timer.unref?.();
  }

  async stop() {
    this.stopped = true;
    this.unsubscribe?.();
    if (this.timer) clearTimeout(this.timer);
    if (this.running > 0) await new Promise<void>(done => this.idle.add(done));
  }
}
