import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { withTransaction } from './db.js';
import { RelayError } from './errors.js';

const DIRECTORY_SCOPE = 'directory:read' as const;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;

export type DirectoryCredentialRecord = {
  credentialId: string;
  ownerId: string;
  scope: typeof DIRECTORY_SCOPE;
  audience: string;
  expiresAt: string;
  status: 'active' | 'expired' | 'revoked';
};

const audienceSchema = z.string().url().max(2048).refine((value) => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
    && (url.pathname === '/' || url.pathname === '');
}, 'audience must be an https origin');

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new RelayError('invalid_input', 'Invalid arguments', 400);
  return result.data;
}

function statusOf(row: { revoked_at: Date | null; expires_at: Date }, now: Date): DirectoryCredentialRecord['status'] {
  if (row.revoked_at) return 'revoked';
  if (row.expires_at.getTime() <= now.getTime()) return 'expired';
  return 'active';
}

/** Owner registry and directory:read credentials. Never enters Relay.run / sweep. */
export class DirectoryRegistry {
  constructor(private readonly pool: Pool) {}

  createOwner() {
    return withTransaction(this.pool, async (client) => {
      const id = randomUUID();
      await client.query('INSERT INTO owners(id) VALUES($1)', [id]);
      return { ownerId: id };
    });
  }

  async requireOwner(client: PoolClient, ownerId: string) {
    const found = await client.query<{ id: string; directory_enabled: boolean }>(
      'SELECT id, directory_enabled FROM owners WHERE id=$1 FOR UPDATE', [ownerId]);
    if (!found.rows[0]) throw new RelayError('invalid_input', 'Unknown owner', 400);
    return found.rows[0];
  }

  issue(input: { ownerId: string; audience: string; credentialId?: string; secret?: string; now?: Date }) {
    const data = parse(z.object({
      ownerId: z.uuid(),
      audience: audienceSchema,
      credentialId: z.uuid().optional(),
      secret: z.string().min(32).max(512).optional(),
    }).strict(), input);
    const now = input.now ?? new Date();
    const credentialId = data.credentialId ?? randomUUID();
    const secret = data.secret ?? randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + MAX_TTL_MS);

    return withTransaction(this.pool, async (client) => {
      await this.requireOwner(client, data.ownerId);
      const existing = await client.query<{
        id: string; secret_hash: string; audience: string; scope: string;
        expires_at: Date; revoked_at: Date | null;
      }>('SELECT id, secret_hash, audience, scope, expires_at, revoked_at FROM directory_credentials WHERE id=$1 FOR UPDATE',
      [credentialId]);
      if (existing.rows[0]) {
        const row = existing.rows[0];
        if (row.secret_hash !== hash(secret) || row.audience !== data.audience || row.scope !== DIRECTORY_SCOPE) {
          throw new RelayError('idempotency_conflict', 'Directory credential mismatch', 409);
        }
        return {
          credentialId,
          secret,
          expiresAt: row.expires_at.toISOString(),
          status: statusOf(row, now),
          ownerId: data.ownerId,
        };
      }

      await client.query(
        `UPDATE directory_credentials SET revoked_at=$2
         WHERE owner_id=$1 AND revoked_at IS NULL`,
        [data.ownerId, now]);
      await client.query(
        `INSERT INTO directory_credentials(id, owner_id, secret_hash, scope, audience, issued_at, expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [credentialId, data.ownerId, hash(secret), DIRECTORY_SCOPE, data.audience, now, expiresAt]);
      return {
        credentialId,
        secret,
        expiresAt: expiresAt.toISOString(),
        status: 'active' as const,
        ownerId: data.ownerId,
      };
    });
  }

  revoke(input: { credentialId: string; now?: Date }) {
    const data = parse(z.object({ credentialId: z.uuid() }).strict(), input);
    const now = input.now ?? new Date();
    return withTransaction(this.pool, async (client) => {
      const found = await client.query<{ id: string; owner_id: string; revoked_at: Date | null }>(
        'SELECT id, owner_id, revoked_at FROM directory_credentials WHERE id=$1 FOR UPDATE', [data.credentialId]);
      if (!found.rows[0]) throw new RelayError('invalid_input', 'Unknown directory credential', 400);
      await client.query('SELECT id FROM owners WHERE id=$1 FOR UPDATE', [found.rows[0].owner_id]);
      if (!found.rows[0].revoked_at) {
        await client.query('UPDATE directory_credentials SET revoked_at=$2 WHERE id=$1', [data.credentialId, now]);
      }
      return { credentialId: data.credentialId, status: 'revoked' as const };
    });
  }

  disableDirectory(input: { ownerId: string; now?: Date }) {
    const data = parse(z.object({ ownerId: z.uuid() }).strict(), input);
    const now = input.now ?? new Date();
    return withTransaction(this.pool, async (client) => {
      await this.requireOwner(client, data.ownerId);
      await client.query('UPDATE owners SET directory_enabled=false WHERE id=$1', [data.ownerId]);
      await client.query(
        `UPDATE directory_credentials SET revoked_at=$2
         WHERE owner_id=$1 AND revoked_at IS NULL`,
        [data.ownerId, now]);
      return { ownerId: data.ownerId, directoryEnabled: false };
    });
  }

  status(input: { credentialId: string; now?: Date }): Promise<DirectoryCredentialRecord> {
    const data = parse(z.object({ credentialId: z.uuid() }).strict(), input);
    const now = input.now ?? new Date();
    return withTransaction(this.pool, async (client) => {
      const found = await client.query<{
        id: string; owner_id: string; scope: string; audience: string; expires_at: Date; revoked_at: Date | null;
      }>('SELECT id, owner_id, scope, audience, expires_at, revoked_at FROM directory_credentials WHERE id=$1',
      [data.credentialId]);
      if (!found.rows[0]) throw new RelayError('invalid_input', 'Unknown directory credential', 400);
      const row = found.rows[0];
      return {
        credentialId: row.id,
        ownerId: row.owner_id,
        scope: DIRECTORY_SCOPE,
        audience: row.audience,
        expiresAt: row.expires_at.toISOString(),
        status: statusOf(row, now),
      };
    });
  }
}
