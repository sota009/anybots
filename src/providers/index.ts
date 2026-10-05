import type { Pool } from 'pg';
import { z } from 'zod';
import { decryptSecret, webhookHeaders } from './crypto.js';
import { validateWebhookUrl, type WebhookTransport } from './transport.js';
import type { Provider } from '../relay.js';

export interface Notification {
  id: string; bindingId: string; conversationId: string; messageId: string; provider: Provider; occurredAt: string; signal?: AbortSignal;
}
export interface DeliveryResult {
  status: 'accepted' | 'retry' | 'failed' | 'uncertain' | 'configuration_required'; retryAfterMs?: number;
}
export interface NotificationDispatcher { deliver(notification: Notification): Promise<DeliveryResult> }
export interface ProviderOptions {
  transport: WebhookTransport; encryptionKey: Buffer;
  webhookHosts?: string[]; grokExperimental?: boolean;
  oauthResource?: string;
}
interface SubscriptionRow {
  id: string; event_name: string; callback_url: string; secret_encrypted: string;
  previous_secret_encrypted: string | null; rotation_until: Date | null;
}

function classify(status: number, retryAfter?: string): DeliveryResult {
  if (status >= 200 && status < 300) return { status: 'accepted' };
  if (status === 429 || status === 408 || status >= 500) {
    const delay = retryAfter === undefined ? NaN : /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
    return { status: 'retry', ...(Number.isFinite(delay) ? { retryAfterMs: Math.max(0, delay) } : {}) };
  }
  return { status: 'failed' };
}

export class ProviderDispatcher implements NotificationDispatcher {
  constructor(private readonly pool: Pool, private readonly options: ProviderOptions) {}
  async deliver(notification: Notification): Promise<DeliveryResult> {
    // Generic MCP agents pull their inbox; never treat them as OpenAI event subscribers.
    if (notification.provider === 'mcp') return { status: 'configuration_required' };
    const database = this.pool;
    if (notification.provider === 'grok') {
      if (!this.options.grokExperimental) return { status: 'configuration_required' };
      const config = await this.grokWebhook(notification.bindingId);
      if (!config) return { status: 'configuration_required' };
      if (this.options.oauthResource !== undefined) {
        const authority = await database.query(`SELECT f.id FROM oauth_families f
          JOIN bindings b ON b.id=f.binding_id
          WHERE f.binding_id=$1 AND f.resource=$2 AND f.scope='relay'
            AND NOT f.revoked AND f.expires_at>clock_timestamp() AND b.active AND b.provider='grok'
          LIMIT 1`, [notification.bindingId, this.options.oauthResource]);
        if (!authority.rowCount) return { status: 'configuration_required' };
      }
      let url: URL;
      try { url = grokWebhookUrl(config.url, this.options.webhookHosts ?? []); } catch { return { status: 'configuration_required' }; }
      // Experimental application envelope, not a claimed xAI webhook standard.
      const body = JSON.stringify({ event: 'inbox.ready', notification_id: notification.id,
        conversation_id: notification.conversationId, message_id: notification.messageId });
      try {
        const result = await this.options.transport.post(url.href, body,
          { 'Content-Type': 'application/json', Authorization: `Bearer ${config.secret}` }, notification.signal);
        return classify(result.status, result.retryAfter);
      } catch { return { status: 'uncertain' }; }
    }
    const rows = await database.query<SubscriptionRow>(`SELECT s.* FROM event_subscriptions s
      JOIN bindings b ON b.id=s.binding_id
      WHERE s.binding_id=$1 AND s.active AND b.active AND s.expires_at>clock_timestamp()
        AND (s.oauth_family_id IS NULL OR EXISTS (
          SELECT 1 FROM oauth_families f WHERE f.id=s.oauth_family_id AND f.binding_id=s.binding_id
            AND NOT f.revoked AND f.expires_at>clock_timestamp()
        ))`, [notification.bindingId]);
    if (!rows.rowCount) return { status: 'configuration_required' };
    for (const subscription of rows.rows) {
      const body = JSON.stringify({ eventId: notification.id, name: subscription.event_name,
        timestamp: notification.occurredAt, data: { conversationId: notification.conversationId, messageId: notification.messageId }, cursor: null });
      const secrets = [decryptSecret(subscription.secret_encrypted, this.options.encryptionKey, subscription.id)];
      if (subscription.previous_secret_encrypted && subscription.rotation_until && subscription.rotation_until > new Date()) {
        secrets.push(decryptSecret(subscription.previous_secret_encrypted, this.options.encryptionKey, subscription.id));
      }
      try {
        const result = await this.options.transport.post(subscription.callback_url, body,
          webhookHeaders(notification.id, subscription.id, body, secrets), notification.signal);
        if (result.status === 410) await database.query('UPDATE event_subscriptions SET active=false WHERE id=$1', [subscription.id]);
        const outcome = classify(result.status, result.retryAfter);
        if (outcome.status !== 'accepted') return outcome;
      } catch { return { status: 'uncertain' }; }
    }
    return { status: 'accepted' };
  }

  private async grokWebhook(bindingId: string) {
    const row = (await this.pool.query<{ webhook_encrypted: string | null }>("SELECT webhook_encrypted FROM bindings WHERE id=$1 AND active AND provider='grok'", [bindingId])).rows[0];
    if (!row?.webhook_encrypted) return undefined;
    try { return grokWebhook.parse(JSON.parse(decryptSecret(row.webhook_encrypted, this.options.encryptionKey, bindingId))); }
    catch { return undefined; }
  }
}

export const grokWebhook = z.strictObject({ url: z.string().max(2048), secret: z.string().min(16).max(4096) });

/** Only Grok routine webhooks on an operator-allowed host; rejects queries, credentials, and other paths. */
export function grokWebhookUrl(value: string, allowedHosts: string[]): URL {
  const url = validateWebhookUrl(value, allowedHosts.filter(host => host === 'api2.cursor.sh'));
  if (!url.pathname.startsWith('/automations/webhook/') || url.pathname.length <= '/automations/webhook/'.length || url.search) throw new Error('invalid_webhook');
  return url;
}
