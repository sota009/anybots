import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { lockRelay, withTransaction } from './db.js';
import { RelayError } from './errors.js';
import { INBOX_CHANNEL, OUTBOX_CHANNEL, type Signals } from './signals.js';
export { RelayError } from './errors.js';

export type Binding = { id: string; ownerId: string; runtimeScope: string; provider: 'dots' | 'grok' | 'muse'; oauthFamilyId?: string };
type Conversation = { id: string; binding_a: string; binding_b: string; status: string; epoch: number; expires_at: Date; turn_count: number };
export type Intent = 'ask' | 'coordinate' | 'act';
export type Message = { id: string; sequence: number; text: string; expectsReply: boolean; intent: Intent; senderBindingId: string; recipientBindingId: string; replyTo: string | null };
export type Decision = 'auto' | 'approve' | 'never';
export type Policy = { ask: Decision; coordinate: Decision; act: Decision; daily_limit: number };
const bindingColumns = 'id, owner_id AS "ownerId", runtime_scope AS "runtimeScope", provider';
const messageColumns = 'id, sequence, text, expects_reply AS "expectsReply", intent, sender_binding_id AS "senderBindingId", recipient_binding_id AS "recipientBindingId", reply_to AS "replyTo"';
const uuid = z.uuid();
const key = z.string().min(1).max(128);
const body = z.string().min(1).refine(text => Buffer.byteLength(text, 'utf8') <= 16384);
const intent = z.enum(['ask', 'coordinate', 'act']);
const openSchema = z.object({ recipientBindingId: uuid, text: body, expectsReply: z.boolean(), intent: intent.optional(), idempotencyKey: key }).strict();
const MAX_WAIT_S = 25;
const waitS = z.number().int().min(0).max(MAX_WAIT_S);
const claimSchema = z.object({ conversationId: uuid.optional(), waitS: waitS.optional() }).strict();
const finishSchema = z.object({ turnId: uuid, result: z.enum(['replied', 'no_reply', 'blocked', 'declined']), text: body.optional(), expectsReply: z.boolean().optional(), intent: intent.optional(), idempotencyKey: key }).strict().superRefine((value, ctx) => {
  if ((value.result === 'replied') !== (value.text !== undefined) || (value.result !== 'replied' && (value.expectsReply !== undefined || value.intent !== undefined))) ctx.addIssue({ code: 'custom', message: 'Only replied results have text, expectsReply, and intent' });
});
export type OpenInput = z.infer<typeof openSchema>;
export type FinishInput = z.infer<typeof finishSchema> & { next?: { waitS?: number } };
export type ClaimInput = z.infer<typeof claimSchema>;
export type FinishResult = { turnId: string; result: FinishInput['result']; messageId?: string; approval?: 'none' | 'pending' };
export type Claim = { turnId: string; conversationId: string; epoch: number; leaseExpiresAt: Date; message: Message };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new RelayError('invalid_input', 'Invalid arguments', 400);
  return result.data;
}

export class Relay {
  constructor(private readonly pool: Pool, private readonly options: { oauthResource?: string; signals?: Signals } = {}) {}

  // Expiry persists even when the triggering request is rejected. The savepoint
  // prevents a rejected command from committing any partial operation writes.
  private async run<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const outcome = await withTransaction(this.pool, async client => {
      await lockRelay(client);
      await this.sweep(client);
      await client.query('SAVEPOINT operation');
      try { return { value: await work(client) }; }
      catch (error) {
        if (!(error instanceof RelayError)) throw error;
        await client.query('ROLLBACK TO SAVEPOINT operation');
        return { error };
      }
    });
    if ('error' in outcome) throw outcome.error;
    return outcome.value;
  }

  private async sweep(client: PoolClient) {
    const expired = await client.query<{ conversation_id: string }>("UPDATE turns SET status='uncertain' WHERE status='active' AND lease_expires_at <= clock_timestamp() RETURNING conversation_id");
    for (const row of expired.rows) await this.stop(client, row.conversation_id, 'uncertain');
    const conversations = await client.query<{ id: string }>("SELECT id FROM conversations WHERE status='open' AND expires_at <= clock_timestamp()");
    for (const row of conversations.rows) await this.stop(client, row.id, 'expired');
  }

  private async auth(client: PoolClient, token: string): Promise<Binding> {
    if (typeof token !== 'string' || token.length < 32 || token.length > 512) throw new RelayError('unauthorized', 'Invalid credential', 401);
    const result = await client.query<Binding>(`SELECT ${bindingColumns} FROM bindings WHERE token_hash=$1 AND active`, [hash(token)]);
    if (result.rows[0]) return result.rows[0];
    if (this.options.oauthResource) {
      const access = await client.query<Binding>(`SELECT b.id,b.owner_id AS "ownerId",b.runtime_scope AS "runtimeScope",b.provider,f.id AS "oauthFamilyId"
        FROM oauth_tokens t JOIN oauth_families f ON f.id=t.family_id JOIN bindings b ON b.id=f.binding_id
        WHERE t.hash=$1 AND t.kind='access' AND NOT t.consumed AND t.expires_at>clock_timestamp()
        AND NOT f.revoked AND f.expires_at>clock_timestamp() AND f.resource=$2 AND f.scope='relay' AND b.active`,
      [hash(token), this.options.oauthResource]);
      if (access.rows[0]) return access.rows[0];
    }
    throw new RelayError('unauthorized', 'Invalid credential', 401);
  }
  authenticate(token: string) { return this.run(client => this.auth(client, token)); }

  /** Revalidate authority on a caller's existing transaction, never a second pool slot. */
  async revalidate(client: PoolClient, token: string, expectedBindingId: string): Promise<{ oauthFamilyId?: string }> {
    await lockRelay(client);
    const binding = await this.auth(client, token);
    if (binding.id !== expectedBindingId) throw new RelayError('unauthorized', 'Invalid credential', 401);
    return binding.oauthFamilyId ? { oauthFamilyId: binding.oauthFamilyId } : {};
  }

  async provisionBinding(input: { ownerId: string; runtimeScope: string; provider: 'dots' | 'grok' | 'muse'; displayName?: string; token?: string }) {
    const data = parse(z.object({
      ownerId: z.uuid(),
      runtimeScope: z.string().min(1).max(256),
      provider: z.enum(['dots', 'grok', 'muse']),
      displayName: z.string().trim().min(1).max(64).optional(),
      token: z.string().min(32).max(512).optional(),
    }).strict(), input);
    return this.run(async client => {
      const owner = await client.query('SELECT 1 FROM owners WHERE id=$1', [data.ownerId]);
      if (!owner.rowCount) throw new RelayError('invalid_input', 'Unknown owner', 400);
      const existing = await client.query('SELECT 1 FROM bindings WHERE runtime_scope=$1 AND active', [data.runtimeScope]);
      if (existing.rowCount) throw new RelayError('runtime_in_use');
      const token = data.token ?? randomBytes(32).toString('base64url');
      const bindingId = randomUUID();
      await client.query('INSERT INTO bindings(id,owner_id,runtime_scope,provider,token_hash,display_name) VALUES($1,$2,$3,$4,$5,$6)', [bindingId, data.ownerId, data.runtimeScope, data.provider, hash(token), data.displayName ?? '']);
      return { bindingId, token, ownerId: data.ownerId };
    });
  }

  async grantPair(a: string, b: string) {
    parse(uuid, a); parse(uuid, b);
    return this.run(async client => {
      await this.requirePair(client, a, b, false);
      const pair = [a, b].sort();
      await client.query("INSERT INTO grants(binding_a,binding_b,status) VALUES($1,$2,'active') ON CONFLICT(binding_a,binding_b) DO UPDATE SET status='active'", pair);
    });
  }

  private async requirePair(client: PoolClient, a: string, b: string, grant = true) {
    if (a === b) throw new RelayError('forbidden', 'Two distinct bindings are required', 403);
    const active = await client.query('SELECT 1 FROM bindings WHERE id=ANY($1::uuid[]) AND active', [[a, b]]);
    if (active.rowCount !== 2) throw new RelayError('forbidden', 'Inactive peer', 403);
    if (grant) {
      const allowed = await client.query('SELECT 1 FROM grants WHERE binding_a=$1 AND binding_b=$2 AND active', [a, b].sort());
      if (!allowed.rowCount) throw new RelayError('forbidden', 'Pair consent is required', 403);
    }
  }

  agentsList(token: string) {
    return this.run(async client => {
      const me = await this.auth(client, token);
      const result = await client.query<Pick<Binding, 'id' | 'provider'>>(`SELECT id, provider FROM bindings b WHERE b.active AND b.id IN (SELECT CASE WHEN binding_a=$1 THEN binding_b ELSE binding_a END FROM grants WHERE (binding_a=$1 OR binding_b=$1) AND active)`, [me.id]);
      return result.rows;
    });
  }

  private async conversation(client: PoolClient, me: Binding, id: string, writing = false) {
    const result = await client.query<Conversation>('SELECT * FROM conversations WHERE id=$1', [id]);
    const c = result.rows[0];
    if (!c || (c.binding_a !== me.id && c.binding_b !== me.id)) throw new RelayError('forbidden', 'Conversation is not accessible', 403);
    await this.requirePair(client, c.binding_a, c.binding_b);
    if (writing && c.status !== 'open') throw new RelayError('conversation_stopped');
    return c;
  }

  private async prior<T>(client: PoolClient, bindingId: string, operation: string, idempotencyKey: string, request: unknown): Promise<T | undefined> {
    const found = await client.query<{ request_hash: string; response: T }>('SELECT request_hash,response FROM idempotency WHERE binding_id=$1 AND operation=$2 AND key=$3', [bindingId, operation, idempotencyKey]);
    if (!found.rows[0]) return undefined;
    if (found.rows[0].request_hash !== hash(JSON.stringify(request))) throw new RelayError('idempotency_conflict');
    return found.rows[0].response;
  }
  private async remember(client: PoolClient, bindingId: string, operation: string, idempotencyKey: string, request: unknown, response: unknown) {
    await client.query('INSERT INTO idempotency(binding_id,operation,key,request_hash,response) VALUES($1,$2,$3,$4,$5)', [bindingId, operation, idempotencyKey, hash(JSON.stringify(request)), JSON.stringify(response)]);
  }

  /** The receiving side's policy decides delivery; intent is the sender's claim, not proof. */
  private async admit(client: PoolClient, sender: string, recipient: string, kind: Intent): Promise<'none' | 'pending'> {
    const [a, b] = [sender, recipient].sort() as [string, string];
    const grant = await client.query<{ policy: Policy }>(`SELECT CASE WHEN binding_a=$3 THEN policy_a ELSE policy_b END AS policy FROM grants WHERE binding_a=$1 AND binding_b=$2 AND active`, [a, b, recipient]);
    const policy = grant.rows[0]?.policy;
    if (!policy) throw new RelayError('forbidden', 'Pair consent is required', 403);
    if (policy[kind] === 'never') throw new RelayError('forbidden_by_policy', 'The recipient does not accept this intent', 403);
    const recent = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM messages WHERE recipient_binding_id=$1 AND sender_binding_id=$2 AND created_at>clock_timestamp()-interval '24 hours'", [recipient, sender]);
    if (recent.rows[0]!.n >= policy.daily_limit) throw new RelayError('rate_limited');
    return policy[kind] === 'approve' ? 'pending' : 'none';
  }

  private async message(client: PoolClient, c: Conversation, sender: string, recipient: string, text: string, expectsReply: boolean, kind: Intent, replyTo?: string) {
    const approval = await this.admit(client, sender, recipient, kind);
    const id = randomUUID();
    const seq = await client.query<{ sequence: number }>('UPDATE conversations SET next_sequence=next_sequence+1 WHERE id=$1 RETURNING next_sequence-1 AS sequence', [c.id]);
    await client.query('INSERT INTO messages(id,conversation_id,sequence,sender_binding_id,recipient_binding_id,text,expects_reply,reply_to,intent,approval) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [id, c.id, seq.rows[0]!.sequence, sender, recipient, text, expectsReply, replyTo ?? null, kind, approval]);
    if (approval === 'none') await this.deliver(client, id, c, recipient);
    return { id, approval };
  }

  private async deliver(client: PoolClient, messageId: string, c: Pick<Conversation, 'id' | 'epoch'>, recipient: string) {
    // Polling clients still get an atomic delivery record, without scheduling a webhook.
    await client.query(`INSERT INTO outbox(id,message_id,conversation_id,binding_id,epoch,status)
      SELECT $1,$2,$3,id,$5,CASE WHEN provider='muse' THEN 'not_required' ELSE 'pending' END
      FROM bindings WHERE id=$4`, [randomUUID(), messageId, c.id, recipient, c.epoch]);
    // Delivered only on commit; listeners treat it as a hint and re-check.
    await client.query(`SELECT pg_notify('${INBOX_CHANNEL}',$1), pg_notify('${OUTBOX_CHANNEL}','')`, [recipient]);
  }

  /** Only the receiving agent's owner decides; unknown and foreign messages look the same. */
  async decideApproval(ownerId: string, messageId: string, decision: 'approve' | 'decline') {
    parse(uuid, ownerId); parse(uuid, messageId); parse(z.enum(['approve', 'decline']), decision);
    return this.run(async client => {
      const found = await client.query<{ conversation_id: string; recipient_binding_id: string }>(`SELECT m.conversation_id,m.recipient_binding_id FROM messages m
        JOIN bindings r ON r.id=m.recipient_binding_id WHERE m.id=$1 AND r.owner_id=$2 AND m.approval='pending' FOR UPDATE OF m`, [messageId, ownerId]);
      const row = found.rows[0];
      if (!row) throw new RelayError('not_found', 'Not found', 404);
      const c = (await client.query<Conversation>('SELECT * FROM conversations WHERE id=$1', [row.conversation_id])).rows[0]!;
      if (c.status !== 'open') throw new RelayError('conversation_stopped');
      await this.requirePair(client, c.binding_a, c.binding_b);
      if (decision === 'decline') {
        await client.query("UPDATE messages SET approval='declined' WHERE id=$1", [messageId]);
        await this.stop(client, c.id, 'closed');
        return { messageId, approval: 'declined' as const };
      }
      await client.query("UPDATE messages SET approval='approved' WHERE id=$1", [messageId]);
      await this.deliver(client, messageId, c, row.recipient_binding_id);
      return { messageId, approval: 'approved' as const };
    });
  }

  async conversationOpen(token: string, input: OpenInput) {
    const data = parse(openSchema, input);
    return this.run(async client => {
      const me = await this.auth(client, token);
      await this.requirePair(client, me.id, data.recipientBindingId);
      const existing = await this.prior<{ conversationId: string; messageId: string; approval: 'none' | 'pending' }>(client, me.id, 'open', data.idempotencyKey, data);
      if (existing) return existing;
      const busy = await client.query("SELECT 1 FROM turns t JOIN bindings b ON b.id=t.binding_id WHERE b.runtime_scope=$1 AND t.status IN ('active','uncertain')", [me.runtimeScope]);
      if (busy.rowCount) throw new RelayError('runtime_busy');
      // Scope-wide budget blocks creating new conversations to reset turn limits.
      const budget = await client.query('SELECT count(*)::int AS count FROM conversations c JOIN bindings b ON b.id=c.binding_a WHERE (b.owner_id=$1 OR b.runtime_scope=$2) AND c.created_at>clock_timestamp()-interval \'1 hour\'', [me.ownerId, me.runtimeScope]);
      if (budget.rows[0].count >= 60) throw new RelayError('rate_limited');
      const id = randomUUID();
      const created = await client.query<Conversation>('INSERT INTO conversations(id,binding_a,binding_b) VALUES($1,$2,$3) RETURNING *', [id, me.id, data.recipientBindingId]);
      const sent = await this.message(client, created.rows[0]!, me.id, data.recipientBindingId, data.text, data.expectsReply, data.intent ?? 'ask');
      const result = { conversationId: id, messageId: sent.id, approval: sent.approval };
      await this.remember(client, me.id, 'open', data.idempotencyKey, data, result);
      return result;
    });
  }

  async conversationRead(token: string, input: { conversationId: string; afterSequence?: number; limit?: number }) {
    const data = parse(z.object({ conversationId: uuid, afterSequence: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(50) }).strict(), input);
    return this.run(async client => {
      const me = await this.auth(client, token);
      const c = await this.conversation(client, me, data.conversationId);
      // Held or declined input stays invisible to the receiving agent.
      const messages = await client.query<Message & { approval: string }>(`SELECT ${messageColumns}, approval FROM messages WHERE conversation_id=$1 AND sequence>$2 AND (approval IN ('none','approved') OR sender_binding_id=$4) ORDER BY sequence LIMIT $3`, [c.id, data.afterSequence, data.limit, me.id]);
      const turns = await client.query<{ id: string; status: string; leaseExpiresAt: Date; result: string | null }>('SELECT id,status,lease_expires_at AS "leaseExpiresAt",result FROM turns WHERE conversation_id=$1 ORDER BY created_at LIMIT 12', [c.id]);
      const outbox = await client.query<{ id: string; messageId: string; status: string; attempts: number; lastError: string | null; updatedAt: Date }>('SELECT id,message_id AS "messageId",status,attempts,last_error AS "lastError",updated_at AS "updatedAt" FROM outbox WHERE conversation_id=$1 ORDER BY created_at LIMIT 13', [c.id]);
      return { conversationId: c.id, status: c.status, epoch: c.epoch, expiresAt: c.expires_at, messages: messages.rows, turns: turns.rows, outbox: outbox.rows };
    });
  }

  /**
   * With waitS, the waiter is registered before each claim attempt so an
   * arrival committed in between is not missed. Waiting holds no pool slot.
   */
  async inboxClaim(token: string, input: ClaimInput = {}): Promise<Claim | null> {
    const data = parse(claimSchema, input);
    const signals = this.options.signals;
    if (!data.waitS || !signals) return this.claimOnce(token, data.conversationId);
    const me = await this.authenticate(token);
    const deadline = Date.now() + data.waitS * 1000;
    for (;;) {
      const waiter = signals.tryWait(me.id);
      try {
        const claim = await this.claimOnce(token, data.conversationId);
        if (claim || !waiter) return claim;
        const left = deadline - Date.now();
        if (left <= 0 || !await waiter.wait(left)) return null;
      } finally { waiter?.dispose(); }
    }
  }

  private claimOnce(token: string, conversationId?: string): Promise<Claim | null> {
    return this.run(async client => {
      const me = await this.auth(client, token);
      const busy = await client.query("SELECT 1 FROM turns t JOIN bindings b ON b.id=t.binding_id WHERE b.runtime_scope=$1 AND t.status IN ('active','uncertain')", [me.runtimeScope]);
      if (busy.rowCount) return null;
      if (conversationId) await this.conversation(client, me, conversationId);
      const candidate = await client.query<{ id: string; conversation_id: string }>(`SELECT m.id,m.conversation_id FROM messages m JOIN conversations c ON c.id=m.conversation_id JOIN grants g ON g.binding_a=LEAST(c.binding_a,c.binding_b) AND g.binding_b=GREATEST(c.binding_a,c.binding_b) JOIN bindings peer ON peer.id=m.sender_binding_id WHERE m.recipient_binding_id=$1 AND c.status='open' AND g.active AND peer.active AND m.approval IN ('none','approved') AND NOT EXISTS(SELECT 1 FROM turns t WHERE t.input_message_id=m.id) AND ($2::uuid IS NULL OR c.id=$2) ORDER BY m.created_at,m.sequence LIMIT 1`, [me.id, conversationId ?? null]);
      if (!candidate.rows[0]) return null;
      const row = candidate.rows[0];
      const c = await this.conversation(client, me, row.conversation_id, true);
      if (c.turn_count >= 12) { await this.stop(client, c.id, 'limited'); return null; }
      const turnId = randomUUID();
      const turn = await client.query<{ lease_expires_at: Date }>("INSERT INTO turns(id,conversation_id,binding_id,input_message_id,epoch,lease_expires_at) VALUES($1,$2,$3,$4,$5,LEAST($6::timestamptz,clock_timestamp()+interval '10 minutes')) RETURNING lease_expires_at", [turnId, c.id, me.id, row.id, c.epoch, c.expires_at]);
      await client.query('UPDATE conversations SET turn_count=turn_count+1 WHERE id=$1', [c.id]);
      const message = await client.query<Message>(`SELECT ${messageColumns} FROM messages WHERE id=$1`, [row.id]);
      return { turnId, conversationId: c.id, epoch: c.epoch, leaseExpiresAt: turn.rows[0]!.lease_expires_at, message: message.rows[0]! };
    });
  }

  /** `next` claims the following input in the same call; it is not part of the idempotent request. */
  async turnFinish(token: string, input: FinishInput): Promise<FinishResult & { next?: Claim | null }> {
    const { next, ...rest } = input;
    const wait = next === undefined ? undefined : parse(z.object({ waitS: waitS.optional() }).strict(), next);
    const result = await this.finish(token, rest);
    if (!wait) return result;
    return { ...result, next: await this.inboxClaim(token, wait.waitS === undefined ? {} : { waitS: wait.waitS }) };
  }

  private async finish(token: string, input: Omit<FinishInput, 'next'>) {
    const data = parse(finishSchema, input);
    return this.run(async client => {
      const me = await this.auth(client, token);
      const turns = await client.query<{ id: string; binding_id: string; conversation_id: string; input_message_id: string; epoch: number; status: string }>('SELECT * FROM turns WHERE id=$1', [data.turnId]);
      const turn = turns.rows[0];
      if (!turn || turn.binding_id !== me.id) throw new RelayError('forbidden', 'Turn is not accessible', 403);
      const c = await this.conversation(client, me, turn.conversation_id);
      const prior = await this.prior<FinishResult>(client, me.id, 'finish', data.idempotencyKey, data);
      if (prior) return prior;
      if (turn.status === 'uncertain' && c.status === 'uncertain') throw new RelayError('lease_expired');
      if (c.status !== 'open' || turn.epoch !== c.epoch) throw new RelayError('conversation_stopped');
      if (turn.status !== 'active') throw new RelayError('turn_finished');
      const message = await client.query<Message>(`SELECT ${messageColumns} FROM messages WHERE id=$1`, [turn.input_message_id]);
      if (data.result === 'replied' && !message.rows[0]!.expectsReply) throw new RelayError('reply_not_allowed');
      // A terminal turn can finish, but cannot create an unprocessable 13th input.
      if (c.turn_count >= 12 && data.result === 'replied') throw new RelayError('turn_limit');
      const result: FinishResult = { turnId: turn.id, result: data.result };
      if (data.result === 'replied') {
        const sent = await this.message(client, c, me.id, message.rows[0]!.senderBindingId, data.text!, data.expectsReply ?? false, data.intent ?? 'ask', turn.input_message_id);
        result.messageId = sent.id; result.approval = sent.approval;
      }
      const completed = await client.query("UPDATE turns SET status='finished',result=$2,finished_at=clock_timestamp() WHERE id=$1 AND lease_expires_at>clock_timestamp()", [turn.id, data.result]);
      if (!completed.rowCount) throw new RelayError('lease_expired');
      if (c.turn_count >= 12) await this.stop(client, c.id, 'limited');
      await this.remember(client, me.id, 'finish', data.idempotencyKey, data, result);
      return result;
    });
  }

  private async stop(client: PoolClient, id: string, status: 'closed' | 'expired' | 'limited' | 'uncertain') {
    await client.query("UPDATE conversations SET status=$2,epoch=epoch+1 WHERE id=$1 AND status='open'", [id, status]);
    // Stopping delivery cannot prove that the remote tool execution stopped.
    // Preserve runtime exclusion until an operator reconciles the external work.
    await client.query("UPDATE turns SET status='uncertain' WHERE conversation_id=$1 AND status='active'", [id]);
    await client.query("UPDATE outbox SET status='cancelled',updated_at=now() WHERE conversation_id=$1 AND status='pending'", [id]);
  }
  async conversationClose(token: string, input: { conversationId: string }) {
    const data = parse(z.object({ conversationId: uuid }).strict(), input);
    return this.run(async client => {
      const me = await this.auth(client, token);
      const c = await this.conversation(client, me, data.conversationId);
      await this.stop(client, c.id, 'closed');
      const stopped = await client.query<{ status: string; epoch: number }>('SELECT status,epoch FROM conversations WHERE id=$1', [c.id]);
      return { conversationId: c.id, ...stopped.rows[0]! };
    });
  }

  private async revoke(client: PoolClient, a: string, b: string) {
    await client.query("UPDATE grants SET status='revoked' WHERE binding_a=$1 AND binding_b=$2", [a, b].sort());
    const conversations = await client.query<{ id: string }>('SELECT id FROM conversations WHERE (binding_a=$1 AND binding_b=$2) OR (binding_a=$2 AND binding_b=$1)', [a, b]);
    for (const c of conversations.rows) await this.stop(client, c.id, 'closed');
  }
  async revokePair(a: string, b: string) {
    parse(uuid, a); parse(uuid, b);
    return this.run(client => this.revoke(client, a, b));
  }
  async contactRevoke(token: string, recipientBindingId: string) {
    parse(uuid, recipientBindingId);
    return this.run(async client => { const me = await this.auth(client, token); await this.revoke(client, me.id, recipientBindingId); return { revoked: true }; });
  }
  private async disable(client: PoolClient, id: string) {
    await client.query('UPDATE bindings SET active=false WHERE id=$1', [id]);
    await client.query("UPDATE grants SET status='revoked' WHERE binding_a=$1 OR binding_b=$1", [id]);
    const conversations = await client.query<{ id: string }>('SELECT id FROM conversations WHERE binding_a=$1 OR binding_b=$1', [id]);
    for (const c of conversations.rows) await this.stop(client, c.id, 'closed');
  }
  async disableBinding(id: string) { parse(uuid, id); return this.run(client => this.disable(client, id)); }
  async connectionDisable(token: string) {
    return this.run(async client => { const me = await this.auth(client, token); await this.disable(client, me.id); return { disabled: true }; });
  }
}
