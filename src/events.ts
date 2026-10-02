import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { lockRelay, withTransaction } from './db.js';
import { decryptSecret, encryptSecret, signingKey, webhookHeaders } from './providers/crypto.js';
import type { WebhookTransport } from './providers/transport.js';

export const MCP_EVENTS_VERSION = '2026-07-28';
export const INBOX_EVENT = 'inbox.ready';
export class EventError extends Error {
  constructor(public readonly code: number, public readonly reason: string) { super(reason); }
}
const identitySchema = z.object({
  name: z.literal(INBOX_EVENT), arguments: z.object({}).strict().default({}),
  delivery: z.object({ mode: z.literal('webhook'), url: z.url().max(2048) }).passthrough(),
}).passthrough();
const subscribeSchema = identitySchema.extend({
  delivery: z.object({ mode: z.literal('webhook'), url: z.url().max(2048), secret: z.string().max(128) }).strict(),
  ttlMs: z.number().int().positive().max(2_147_483_647).nullable().optional(),
  cursor: z.null().optional(),
});

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function subscriptionId(bindingId: string, name: string, url: string, args: unknown): string {
  return `sub_${createHash('sha256').update(canonicalJson([bindingId, url, name, args])).digest('hex')}`;
}

export interface EventOptions { transport: WebhookTransport; encryptionKey: Buffer; defaultTtlMs?: number }
export type EventAuthorization = (client: PoolClient) => Promise<{ oauthFamilyId?: string }>;

export class EventSubscriptions {
  private readonly verified = new Map<string, number>();
  constructor(private readonly pool: Pool, private readonly options: EventOptions) {
    if (options.encryptionKey.length !== 32) throw new Error('encryption_key_must_be_32_bytes');
  }
  catalog() {
    return { events: [{ name: INBOX_EVENT, description: 'New messages are available in this connection inbox. Read them using inbox_claim.',
      delivery: ['webhook'], inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      payloadSchema: { type: 'object', properties: { conversationId: { type: 'string' }, messageId: { type: 'string' } },
        required: ['conversationId', 'messageId'], additionalProperties: false } }] };
  }

  async subscribe(bindingId: string, input: unknown, authorize?: EventAuthorization) {
    const parsed = subscribeSchema.safeParse(input);
    if (!parsed.success) throw new EventError(-32602, 'invalid_subscription');
    const params = parsed.data;
    try { signingKey(params.delivery.secret); } catch { throw new EventError(-32602, 'invalid_signing_secret'); }
    const initial = await this.pool.query('SELECT id FROM bindings WHERE id=$1 AND active=true AND provider=\'dots\'', [bindingId]);
    if (!initial.rowCount) throw new EventError(-32001, 'binding_unavailable');
    const id = subscriptionId(bindingId, params.name, params.delivery.url, params.arguments);
    await this.verifyCallback(bindingId, id, params.delivery.url, params.delivery.secret);
    // This pilot always grants finite lifetimes, including requests for no expiry.
    const ttlMs = Math.min(params.ttlMs ?? this.options.defaultTtlMs ?? 3_600_000, 86_400_000);
    return withTransaction(this.pool, async client => {
      await lockRelay(client);
      // Callback verification awaits external HTTP. Revalidate the original caller
      // under the same ordering barrier used by revocation before committing.
      const authority = authorize ? await authorize(client) : {};
      const binding = await client.query('SELECT id FROM bindings WHERE id=$1 AND active=true AND provider=\'dots\' FOR UPDATE', [bindingId]);
      if (!binding.rowCount) throw new EventError(-32001, 'binding_unavailable');
      await client.query(`UPDATE event_subscriptions s SET active=false,updated_at=now()
        WHERE binding_id=$1 AND active AND (
          expires_at<=clock_timestamp() OR (oauth_family_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM oauth_families f WHERE f.id=s.oauth_family_id
              AND (f.revoked OR f.expires_at<=clock_timestamp())
          ))
        )`, [bindingId]);
      const other = await client.query('SELECT id FROM event_subscriptions WHERE binding_id=$1 AND active AND id<>$2', [bindingId, id]);
      if (other.rowCount) throw new EventError(-32602, 'subscription_context_already_bound');
      const existing = await client.query<{ secret_encrypted: string; previous_secret_encrypted: string | null; rotation_until: Date | null }>('SELECT secret_encrypted,previous_secret_encrypted,rotation_until FROM event_subscriptions WHERE id=$1', [id]);
      const previous = existing.rows[0]?.secret_encrypted;
      const rotated = previous && decryptSecret(previous, this.options.encryptionKey, id) !== params.delivery.secret;
      const expiration = new Date(Date.now() + ttlMs);
      await client.query(`INSERT INTO event_subscriptions
        (id,binding_id,event_name,arguments,callback_url,secret_encrypted,previous_secret_encrypted,rotation_until,expires_at,oauth_family_id)
        VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (id) DO UPDATE SET secret_encrypted=EXCLUDED.secret_encrypted,
          previous_secret_encrypted=EXCLUDED.previous_secret_encrypted,rotation_until=EXCLUDED.rotation_until,
          expires_at=EXCLUDED.expires_at,oauth_family_id=EXCLUDED.oauth_family_id,active=true,updated_at=now()`,
      [id, bindingId, params.name, JSON.stringify(params.arguments), params.delivery.url,
        encryptSecret(params.delivery.secret, this.options.encryptionKey, id), rotated ? previous : existing.rows[0]?.previous_secret_encrypted ?? null,
        rotated ? new Date(Date.now() + 300_000) : existing.rows[0]?.rotation_until ?? null, expiration, authority.oauthFamilyId ?? null]);
      return { id, refreshBefore: expiration.toISOString(), cursor: null, truncated: false };
    });
  }

  private async verifyCallback(bindingId: string, id: string, url: string, secret: string): Promise<void> {
    const cacheKey = createHash('sha256').update(canonicalJson([bindingId, url, secret])).digest('hex');
    const cachedUntil = this.verified.get(cacheKey);
    if (cachedUntil !== undefined && cachedUntil > Date.now()) return;
    const challenge = randomBytes(32).toString('base64url');
    const body = JSON.stringify({ type: 'verification', challenge });
    try {
      const response = await this.options.transport.post(url, body,
        webhookHeaders(`verification_${randomBytes(16).toString('hex')}`, id, body, [secret]));
      const echoed: unknown = JSON.parse(response.body);
      const received = typeof echoed === 'object' && echoed !== null && 'challenge' in echoed ? (echoed as { challenge: unknown }).challenge : undefined;
      const expectedBytes = Buffer.from(challenge);
      if (response.status < 200 || response.status >= 300 || typeof received !== 'string' ||
          Buffer.byteLength(received) !== expectedBytes.length || !timingSafeEqual(Buffer.from(received), expectedBytes)) {
        throw new Error('challenge_failed');
      }
    } catch { throw new EventError(-32015, 'challenge_failed'); }
    for (const [entry, expires] of this.verified) if (expires <= Date.now()) this.verified.delete(entry);
    if (this.verified.size >= 1000) this.verified.delete(this.verified.keys().next().value!);
    this.verified.set(cacheKey, Date.now() + 60_000);
  }

  async unsubscribe(bindingId: string, input: unknown, authorize?: EventAuthorization): Promise<Record<string, never>> {
    const parsed = identitySchema.safeParse(input);
    if (!parsed.success) throw new EventError(-32602, 'invalid_subscription');
    const p = parsed.data;
    const id = subscriptionId(bindingId, p.name, p.delivery.url, p.arguments);
    return withTransaction(this.pool, async client => {
      await lockRelay(client);
      if (authorize) await authorize(client);
      const binding = await client.query('SELECT id FROM bindings WHERE id=$1 AND active=true', [bindingId]);
      if (!binding.rowCount) throw new EventError(-32001, 'binding_unavailable');
      await client.query('UPDATE event_subscriptions SET active=false,updated_at=now() WHERE id=$1 AND binding_id=$2', [id, bindingId]);
      return {};
    });
  }
}
