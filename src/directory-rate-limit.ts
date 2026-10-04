type Bucket = { tokens: number; updatedAt: number };

/** Bounded in-memory limiter; state resets on process restart. */
export class DirectoryRateLimit {
  private readonly global = new Map<string, Bucket>();
  private readonly owners = new Map<string, Bucket>();
  private readonly maxEntries = 4096;

  constructor(
    private readonly globalPerMinute = 120,
    private readonly globalBurst = 20,
    private readonly ownerPerMinute = 60,
    private readonly ownerBurst = 10,
  ) {}

  private take(map: Map<string, Bucket>, key: string, ratePerMinute: number, burst: number, now: number): boolean {
    if (map.size > this.maxEntries) {
      for (const [entry, bucket] of map) {
        if (now - bucket.updatedAt > 120_000) map.delete(entry);
        if (map.size <= this.maxEntries) break;
      }
      if (map.size > this.maxEntries) {
        const oldest = map.keys().next().value;
        if (oldest !== undefined) map.delete(oldest);
      }
    }
    const refillPerMs = ratePerMinute / 60_000;
    const current = map.get(key) ?? { tokens: burst, updatedAt: now };
    const elapsed = Math.max(0, now - current.updatedAt);
    const tokens = Math.min(burst, current.tokens + elapsed * refillPerMs);
    if (tokens < 1) {
      map.set(key, { tokens, updatedAt: now });
      return false;
    }
    map.set(key, { tokens: tokens - 1, updatedAt: now });
    return true;
  }

  allowGlobal(now = Date.now()): boolean {
    return this.take(this.global, 'global', this.globalPerMinute, this.globalBurst, now);
  }

  allowOwner(ownerId: string, now = Date.now()): boolean {
    return this.take(this.owners, ownerId, this.ownerPerMinute, this.ownerBurst, now);
  }
}

/** Simple admission gate for the directory pool. */
export class DirectoryAdmission {
  private active = 0;
  private readonly waiters: Array<{ resolve: (ok: boolean) => void; timer: NodeJS.Timeout }> = [];

  constructor(private readonly maxActive = 8, private readonly maxWaitMs = 500) {}

  async enter(): Promise<() => void> {
    if (this.active < this.maxActive) {
      this.active += 1;
      return () => this.leave();
    }
    const ok = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve(false);
      }, this.maxWaitMs);
      this.waiters.push({ resolve, timer });
    });
    if (!ok) throw new Error('admission_timeout');
    this.active += 1;
    return () => this.leave();
  }

  private leave() {
    this.active = Math.max(0, this.active - 1);
    const next = this.waiters.shift();
    if (!next) return;
    clearTimeout(next.timer);
    next.resolve(true);
  }
}
