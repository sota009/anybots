import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

export const DIRECTORY_SCOPE = 'directory:read' as const;
export const MAX_CONNECTIONS = 100;
export const MAX_CONTACTS = 1000;

export class DirectoryError extends Error {
  constructor(
    public readonly code: 'unauthorized' | 'forbidden' | 'connection_not_found' | 'invalid_request' | 'inventory_too_large' | 'unavailable' | 'rate_limited',
    public readonly statusCode: 400 | 401 | 403 | 404 | 422 | 429 | 503,
  ) {
    super(code);
    this.name = 'DirectoryError';
  }
}

const contactSchema = z.strictObject({
  connectionId: z.uuid(),
  provider: z.enum(['dots', 'grok', 'muse']),
  sameOwner: z.boolean(),
  permission: z.literal('recorded'),
  recordedVia: z.literal('operator'),
  registrationAllowsCommunication: z.boolean(),
});

const connectionSchema = z.strictObject({
  connectionId: z.uuid(),
  provider: z.enum(['dots', 'grok', 'muse']),
  registration: z.enum(['active', 'disabled']),
  identityUnit: z.literal('connection'),
  contacts: z.array(contactSchema),
});

export const directoryResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  checkedAt: z.string().datetime(),
  scope: z.strictObject({ connectionId: z.uuid().nullable() }),
  complete: z.literal(true),
  connections: z.array(connectionSchema),
});

export type DirectoryResponse = z.infer<typeof directoryResponseSchema>;

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

type BindingRow = { id: string; provider: 'dots' | 'grok' | 'muse'; active: boolean; owner_id: string };
type ContactRow = {
  self_id: string;
  peer_id: string;
  peer_provider: 'dots' | 'grok' | 'muse';
  peer_owner_id: string;
  self_active: boolean;
  peer_active: boolean;
};

async function withDirectoryTransaction<T>(pool: Pool, work: (client: PoolClient, checkedAt: Date) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let finished = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout = '1s'");
    await client.query("SET LOCAL lock_timeout = '250ms'");
    const clock = await client.query<{ now: Date }>('SELECT clock_timestamp() AS now');
    const result = await work(client, clock.rows[0]!.now);
    await client.query('COMMIT');
    finished = true;
    return result;
  } catch (error) {
    if (!finished) {
      try { await client.query('ROLLBACK'); } catch { /* already failed */ }
    }
    throw error;
  } finally {
    // Cancel and discard the connection after local timeout / protocol failure.
    if (!finished) client.release(true);
    else client.release();
  }
}

export async function listConnections(
  pool: Pool,
  input: {
    secret: string;
    audience: string;
    connectionId?: string;
    onAuthenticated?: (ownerId: string) => void;
  },
): Promise<DirectoryResponse> {
  if (typeof input.secret !== 'string' || input.secret.length < 32 || input.secret.length > 256) {
    throw new DirectoryError('unauthorized', 401);
  }
  let audience: string;
  try { audience = z.string().url().parse(input.audience); }
  catch { throw new DirectoryError('unavailable', 503); }
  let filter: string | undefined;
  if (input.connectionId !== undefined) {
    const parsed = z.uuid().safeParse(input.connectionId);
    if (!parsed.success) throw new DirectoryError('invalid_request', 400);
    filter = parsed.data;
  }

  try {
    return await withDirectoryTransaction(pool, async (client, checkedAt) => {
      const auth = await client.query<{
        owner_id: string; scope: string; audience: string;
        expires_at: Date; revoked_at: Date | null; directory_enabled: boolean;
      }>(`SELECT c.owner_id, c.scope, c.audience, c.expires_at, c.revoked_at, o.directory_enabled
          FROM directory_credentials c JOIN owners o ON o.id=c.owner_id
          WHERE c.secret_hash=$1`, [hash(input.secret)]);
      const credential = auth.rows[0];
      if (!credential || credential.revoked_at || credential.expires_at.getTime() <= checkedAt.getTime()
        || !credential.directory_enabled || credential.audience !== audience) {
        throw new DirectoryError('unauthorized', 401);
      }
      if (credential.scope !== DIRECTORY_SCOPE) throw new DirectoryError('forbidden', 403);
      input.onAuthenticated?.(credential.owner_id);

      const bindings = await client.query<BindingRow>(
        `SELECT id, provider, active, owner_id FROM bindings
         WHERE owner_id=$1
         ORDER BY id
         LIMIT $2`,
        [credential.owner_id, MAX_CONNECTIONS + 1],
      );
      if (bindings.rowCount! > MAX_CONNECTIONS) throw new DirectoryError('inventory_too_large', 422);

      let selected = bindings.rows;
      if (filter !== undefined) {
        selected = bindings.rows.filter((row) => row.id === filter);
        if (selected.length === 0) throw new DirectoryError('connection_not_found', 404);
      }

      if (selected.length === 0) {
        return directoryResponseSchema.parse({
          schemaVersion: 1,
          checkedAt: checkedAt.toISOString(),
          scope: { connectionId: filter ?? null },
          complete: true,
          connections: [],
        });
      }

      const ids = selected.map((row) => row.id);
      const contacts = await client.query<ContactRow>(
        `SELECT b.id AS self_id, p.id AS peer_id, p.provider AS peer_provider, p.owner_id AS peer_owner_id,
                b.active AS self_active, p.active AS peer_active
         FROM bindings b
         JOIN grants g ON g.active AND (g.binding_a = b.id OR g.binding_b = b.id)
         JOIN bindings p ON p.id = CASE WHEN g.binding_a = b.id THEN g.binding_b ELSE g.binding_a END
         WHERE b.id = ANY($1::uuid[])
         ORDER BY b.id, p.id
         LIMIT $2`,
        [ids, MAX_CONTACTS + 1],
      );
      if (contacts.rowCount! > MAX_CONTACTS) throw new DirectoryError('inventory_too_large', 422);

      const bySelf = new Map<string, ContactRow[]>();
      for (const row of contacts.rows) {
        const list = bySelf.get(row.self_id) ?? [];
        list.push(row);
        bySelf.set(row.self_id, list);
      }

      return directoryResponseSchema.parse({
        schemaVersion: 1,
        checkedAt: checkedAt.toISOString(),
        scope: { connectionId: filter ?? null },
        complete: true,
        connections: selected.map((binding) => ({
          connectionId: binding.id,
          provider: binding.provider,
          registration: binding.active ? 'active' as const : 'disabled' as const,
          identityUnit: 'connection' as const,
          contacts: (bySelf.get(binding.id) ?? []).map((row) => ({
            connectionId: row.peer_id,
            provider: row.peer_provider,
            sameOwner: row.peer_owner_id === credential.owner_id,
            permission: 'recorded' as const,
            recordedVia: 'operator' as const,
            registrationAllowsCommunication: row.self_active && row.peer_active,
          })),
        })),
      });
    });
  } catch (error) {
    if (error instanceof DirectoryError) throw error;
    throw new DirectoryError('unavailable', 503);
  }
}

export function newRequestId(): string {
  return randomUUID();
}
