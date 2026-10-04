import type { Pool, PoolClient } from 'pg';

export const INBOX_CHANNEL = 'anybots_inbox';
export const OUTBOX_CHANNEL = 'anybots_outbox';

export interface Waiter { wait(ms: number): Promise<boolean>; dispose(): void }
export interface SignalLimits { perBinding: number; total: number }

/**
 * One LISTEN connection per process. Waiting holds neither a pool slot nor a
 * relay lock. Every wake is only a hint: callers must re-check the database.
 */
export class Signals {
  private client: PoolClient | undefined;
  private stopped = false;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly outbox = new Set<() => void>();
  private total = 0;

  constructor(private readonly pool: Pool, private readonly limits: SignalLimits = { perBinding: 2, total: 200 }) {}

  /** Never throws: without LISTEN, waits degrade to immediate claims and delivery to the sweep. */
  async start(): Promise<void> {
    this.stopped = false;
    try { await this.connect(); } catch { this.schedule(); }
  }

  private async connect(): Promise<void> {
    const client = await this.pool.connect();
    const lost = () => {
      if (this.client !== client) return;
      this.client = undefined;
      client.release(true);
      this.wakeAll();
      this.schedule();
    };
    client.on('error', lost);
    client.on('end', lost);
    client.on('notification', message => {
      if (message.channel === OUTBOX_CHANNEL) this.emitOutbox();
      else if (message.channel === INBOX_CHANNEL && message.payload) this.wake(message.payload);
    });
    try {
      await client.query(`LISTEN ${INBOX_CHANNEL}`);
      await client.query(`LISTEN ${OUTBOX_CHANNEL}`);
    } catch (error) {
      client.release(true);
      throw error;
    }
    if (this.stopped) { client.release(true); return; }
    this.client = client;
    // Anything committed while disconnected is found by re-checking.
    this.wakeAll();
  }

  private schedule() {
    if (!this.stopped) this.retry = setTimeout(() => { void this.connect().catch(() => this.schedule()); }, 1000);
  }

  get listening(): boolean { return this.client !== undefined; }

  onOutbox(listener: () => void): () => void {
    this.outbox.add(listener);
    return () => { this.outbox.delete(listener); };
  }

  /** Register before checking the database so a commit in between is not missed. */
  tryWait(bindingId: string): Waiter | undefined {
    const set = this.waiters.get(bindingId) ?? new Set<() => void>();
    if (!this.client || set.size >= this.limits.perBinding || this.total >= this.limits.total) return undefined;
    let fired = false;
    let resolve: ((woken: boolean) => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fire = () => { fired = true; resolve?.(true); };
    set.add(fire);
    this.waiters.set(bindingId, set);
    this.total++;
    let disposed = false;
    return {
      wait: (ms: number) => new Promise<boolean>(done => {
        if (fired) return done(true);
        resolve = woken => { if (timer) clearTimeout(timer); resolve = undefined; done(woken); };
        timer = setTimeout(() => resolve?.(false), Math.max(0, ms));
      }),
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (timer) clearTimeout(timer);
        resolve?.(false);
        set.delete(fire);
        if (!set.size) this.waiters.delete(bindingId);
        this.total--;
      },
    };
  }

  private wake(bindingId: string) {
    for (const fire of this.waiters.get(bindingId) ?? []) fire();
  }

  private wakeAll() {
    for (const set of this.waiters.values()) for (const fire of set) fire();
    this.emitOutbox();
  }

  private emitOutbox() {
    for (const listener of this.outbox) { try { listener(); } catch { /* A listener must not break delivery hints. */ } }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    const client = this.client;
    this.client = undefined;
    this.wakeAll();
    if (client) {
      try { await client.query(`UNLISTEN *`); } catch { /* Connection may already be gone. */ }
      client.release(true);
    }
  }
}
