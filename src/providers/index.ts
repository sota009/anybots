import type { Pool, PoolClient } from 'pg';
import { decryptSecret, webhookHeaders } from './crypto.js';
import { validateWebhookUrl, type WebhookTransport } from './transport.js';

export interface Notification {
  id: string; bindingId: string; conversationId: string; messageId: string; provider: 'dots' | 'grok'; occurredAt: string; signal?: AbortSignal;
}
export interface DeliveryResult {
  status: 'accepted' | 'retry' | 'failed' | 'uncertain' | 'configuration_required'; retryAfterMs?: number;
}
export interface NotificationDispatcher { deliver(notification: Notification, client?: PoolClient): Promise<DeliveryResult> }
export interface ProviderOptions {
  transport: WebhookTransport; encryptionKey: Buffer;
  groks?: Record<string, { url: string; secret: string }>; grokExperimental?: boolean;
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
  async deliver(notification: Notification, client?: PoolClient): Promise<DeliveryResult> {
    const database = client ?? this.pool;
    if (notification.provider === 'grok') {
      const config = this.options.groks?.[notification.bindingId];
      if (!this.options.grokExperimental || !config) return { status: 'configuration_required' };
      let url: URL;
      try { url = validateWebhookUrl(config.url, ['api2.cursor.sh']); } catch { return { status: 'configuration_required' }; }
      if (!url.pathname.startsWith('/automations/webhook/') || url.search) return { status: 'configuration_required' };
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
      JOIN bindings b ON b.id=s.binding_id WHERE s.binding_id=$1 AND s.active AND b.active AND s.expires_at>now()`, [notification.bindingId]);
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
}
