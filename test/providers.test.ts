import { createHmac, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { decryptSecret, encryptSecret, signingKey, webhookHeaders } from '../src/providers/crypto.js';
import { ProviderDispatcher } from '../src/providers/index.js';
import { isPublicAddress, PublicHttpsTransport, validateWebhookUrl } from '../src/providers/transport.js';

describe('provider transport boundaries', () => {
  it('blocks private, special, and transition IPs for both address families', () => {
    for (const ip of ['0.1.2.3','10.0.0.1','100.64.0.1','127.0.0.1','169.254.169.254','172.16.1.1','192.168.0.1','198.18.0.1','203.0.113.2','255.255.255.255','::1','::ffff:127.0.0.1','fc00::1','fe80::1','2001:db8::1','2002:7f00:1::']) expect(isPublicAddress(ip), ip).toBe(false);
    expect(isPublicAddress('8.8.8.8')).toBe(true); expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
  });
  it('requires exact allowed HTTPS host with no userinfo, nonstandard port, fragment, or literal IP', () => {
    for (const url of ['http://example.com','https://user:password@example.com','https://example.com:8443','https://example.com/#secret','https://evil.example.com','https://example.com.evil.test','https://127.0.0.1']) {
      expect(() => validateWebhookUrl(url, ['example.com'])).toThrow();
    }
    expect(validateWebhookUrl('https://example.com/callback', ['example.com']).hostname).toBe('example.com');
  });
  it('rejects oversized payloads before DNS or network', async () => {
    const transport = new PublicHttpsTransport(['example.com']);
    await expect(transport.post('https://example.com', 'x'.repeat(262_145), {})).rejects.toThrow('webhook_payload_too_large');
    await expect(transport.post('https://example.com', '{}', {}, AbortSignal.abort())).rejects.toThrow('webhook_aborted');
    await expect(new PublicHttpsTransport(['localhost']).post('https://localhost', '{}', {})).rejects.toThrow('webhook_destination_rejected');
  });
  it('matches Standard Webhooks HMAC signing bytes and verifies encryption context', () => {
    const key = randomBytes(32); const secret = `whsec_${key.toString('base64')}`;
    const body = '{"text":"日本語"}'; const time = new Date('2026-10-02T12:00:00Z');
    const headers = webhookHeaders('id', 'sub', body, [secret], time);
    const expected = createHmac('sha256', key).update(`id.${Math.floor(time.getTime()/1000)}.${body}`).digest('base64');
    expect(headers['webhook-signature']).toBe(`v1,${expected}`);
    expect(() => signingKey('whsec_a')).toThrow();
    const stored = encryptSecret(secret, key, 'sub');
    expect(decryptSecret(stored, key, 'sub')).toBe(secret);
    expect(() => decryptSecret(stored, key, 'different-sub')).toThrow();
  });
  it('requires explicit experimental Grok opt-in and classifies network uncertainty', async () => {
    const post = vi.fn(async () => ({ status: 200, body: '' }));
    const notification = { id: 'event', bindingId: 'binding', conversationId: 'conversation', messageId: 'message', provider: 'grok' as const, occurredAt: new Date().toISOString() };
    const options = { encryptionKey: randomBytes(32), transport: { post }, groks: { binding: { url: 'https://api2.cursor.sh/automations/webhook/test', secret: 'test-only' } } };
    expect(await new ProviderDispatcher({} as Pool, options).deliver(notification)).toEqual({ status: 'configuration_required' });
    expect(post).not.toHaveBeenCalled();
    expect(await new ProviderDispatcher({} as Pool, { ...options, grokExperimental: true }).deliver(notification)).toEqual({ status: 'accepted' });
    const args = post.mock.calls[0] as unknown as [string,string,Record<string,string>];
    expect(JSON.parse(args[1])).toEqual({ event: 'inbox.ready', notification_id: 'event', conversation_id: 'conversation', message_id: 'message' });
    post.mockRejectedValue(new Error('could have sent'));
    expect(await new ProviderDispatcher({} as Pool, { ...options, grokExperimental: true }).deliver(notification)).toEqual({ status: 'uncertain' });
  });
});
