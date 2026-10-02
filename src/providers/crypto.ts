import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

export function signingKey(secret: string): Buffer {
  if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) throw new Error('invalid_signing_secret');
  const encoded = secret.slice(6); const key = Buffer.from(encoded, 'base64');
  if (key.length < 24 || key.length > 64 || key.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
    throw new Error('invalid_signing_secret');
  }
  return key;
}

export function webhookHeaders(id: string, subscriptionId: string, body: string, secrets: string[], now = new Date()): Record<string, string> {
  const timestamp = String(Math.floor(now.getTime() / 1000));
  const signatures = secrets.map(secret => `v1,${createHmac('sha256', signingKey(secret)).update(`${id}.${timestamp}.${body}`).digest('base64')}`);
  return { 'Content-Type': 'application/json', 'webhook-id': id, 'webhook-timestamp': timestamp,
    'webhook-signature': signatures.join(' '), 'X-MCP-Subscription-Id': subscriptionId };
}

export function encryptSecret(secret: string, key: Buffer, context: string): string {
  if (key.length !== 32) throw new Error('encryption_key_must_be_32_bytes');
  const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return [nonce, cipher.getAuthTag(), ciphertext].map(x => x.toString('base64')).join('.');
}

export function decryptSecret(value: string, key: Buffer, context: string): string {
  if (key.length !== 32) throw new Error('encryption_key_must_be_32_bytes');
  const parts = value.split('.');
  if (parts.length !== 3) throw new Error('invalid_encrypted_secret');
  const [nonce, tag, ciphertext] = parts.map(x => Buffer.from(x, 'base64')) as [Buffer, Buffer, Buffer];
  const cipher = createDecipheriv('aes-256-gcm', key, nonce); cipher.setAAD(Buffer.from(context)); cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(ciphertext), cipher.final()]).toString('utf8');
}
