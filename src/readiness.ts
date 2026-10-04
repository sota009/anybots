import type { Pool } from 'pg';
import { z } from 'zod';
import type { ProviderOptions } from './providers/index.js';
import { validateWebhookUrl } from './providers/transport.js';

export interface ReadinessInput { bindingId: string; peerBindingId?: string }
interface ReadinessOptions {
  oauthResource?: string;
  // Supplied by the operator's validated notification configuration, never HTTP input.
  notifications?: Pick<ProviderOptions, 'groks' | 'grokExperimental'>;
}
const selection = z.strictObject({ bindingId: z.uuid(), peerBindingId: z.uuid().optional() })
  .refine(input => input.bindingId !== input.peerBindingId, 'Peer must be a different binding');
const outboxStates = ['pending', 'accepted', 'failed', 'uncertain', 'cancelled', 'not_required'] as const;
type OutboxState = typeof outboxStates[number];
interface NotificationStatus {
  configured: boolean;
  mode?: 'poll';
  activeSubscriptions?: number;
  experimentalEnabled?: boolean;
  webhookConfigured?: boolean;
}

/** Operator-only snapshot. No sweep, mutation, external request, or global relay lock. */
export async function readiness(pool: Pool, input: ReadinessInput, options: ReadinessOptions = {}) {
  const { bindingId, peerBindingId } = selection.parse(input);
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const at = (await client.query<{ at: Date }>('SELECT clock_timestamp() AS at')).rows[0]!.at;
    const found = (await client.query<{ active: boolean; provider: 'dots' | 'grok' | 'muse' }>(
      'SELECT active,provider FROM bindings WHERE id=$1', [bindingId])).rows[0];
    const binding = { exists: Boolean(found), active: found?.active ?? false, provider: found?.provider ?? null };
    const activeFamilies = options.oauthResource && binding.active
      ? (await client.query<{ count: number }>(`SELECT count(*)::int AS count FROM oauth_families
          WHERE binding_id=$1 AND NOT revoked AND expires_at>$2 AND resource=$3 AND scope='relay'`,
        [bindingId, at, options.oauthResource])).rows[0]!.count : 0;
    let peer: { exists: boolean; active: boolean; granted: boolean } | null = null;
    if (peerBindingId) {
      const other = (await client.query<{ active: boolean }>('SELECT active FROM bindings WHERE id=$1', [peerBindingId])).rows[0];
      const grant = await client.query(`SELECT 1 FROM grants WHERE binding_a=LEAST($1::uuid,$2::uuid)
        AND binding_b=GREATEST($1::uuid,$2::uuid) AND active`, [bindingId, peerBindingId]);
      peer = { exists: Boolean(other), active: other?.active ?? false,
        granted: binding.active && Boolean(other?.active) && Boolean(grant.rowCount) };
    }
    const notification: NotificationStatus = { configured: options.notifications !== undefined };
    if (binding.provider === 'muse') {
      notification.configured = false;
      notification.mode = 'poll';
    } else if (binding.provider === 'dots') {
      notification.activeSubscriptions = binding.active
        ? (await client.query<{ count: number }>(`SELECT count(*)::int AS count FROM event_subscriptions s
            WHERE s.binding_id=$1 AND s.active AND s.expires_at>$2 AND (s.oauth_family_id IS NULL OR EXISTS (
              SELECT 1 FROM oauth_families f WHERE f.id=s.oauth_family_id AND f.binding_id=s.binding_id
              AND NOT f.revoked AND f.expires_at>$2 AND f.resource=$3 AND f.scope='relay'))`,
          [bindingId, at, options.oauthResource ?? null])).rows[0]!.count : 0;
    } else if (binding.provider === 'grok') {
      notification.experimentalEnabled = options.notifications?.grokExperimental === true;
      notification.webhookConfigured = false;
      const config = options.notifications?.groks?.[bindingId];
      if (config) {
        try {
          const url = validateWebhookUrl(config.url, ['api2.cursor.sh']);
          notification.webhookConfigured = url.pathname.startsWith('/automations/webhook/') && !url.search;
        } catch { /* Report only missing configuration, never the rejected URL. */ }
      }
    }
    const messages = (await client.query<{ sent: number; received: number }>(`SELECT
      count(*) FILTER (WHERE sender_binding_id=$1)::int AS sent,
      count(*) FILTER (WHERE recipient_binding_id=$1)::int AS received FROM messages
      WHERE (sender_binding_id=$1 OR recipient_binding_id=$1)
        AND ($2::uuid IS NULL OR sender_binding_id=$2 OR recipient_binding_id=$2)`,
    [bindingId, peerBindingId ?? null])).rows[0]!;
    const outbox = Object.fromEntries(outboxStates.map(status => [status, 0])) as Record<OutboxState, number>;
    const counts = await client.query<{ status: OutboxState; count: number }>(`SELECT o.status,count(*)::int AS count
      FROM outbox o JOIN messages m ON m.id=o.message_id
      WHERE (m.sender_binding_id=$1 OR m.recipient_binding_id=$1)
        AND ($2::uuid IS NULL OR m.sender_binding_id=$2 OR m.recipient_binding_id=$2) GROUP BY o.status`,
    [bindingId, peerBindingId ?? null]);
    for (const row of counts.rows) outbox[row.status] = row.count;
    await client.query('COMMIT');
    return { checkedAt: at.toISOString(), binding, oauth: { configured: Boolean(options.oauthResource), activeFamilies },
      peer, notification, messages, outbox, liveVerification: 'not_verified' as const };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export type ReadinessReader = (input: ReadinessInput) => ReturnType<typeof readiness>;
