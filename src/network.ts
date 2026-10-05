import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { displayName } from './accounts.js';
import { lockRelay, withTransaction } from './db.js';
import { RelayError } from './errors.js';
import type { OAuthPilot } from './oauth.js';
import { encryptSecret } from './providers/crypto.js';
import { grokWebhook, grokWebhookUrl } from './providers/index.js';
import { PROVIDERS, type Policy, type Provider, type Relay } from './relay.js';

const MAX_AGENTS = 20;
const PAIRINGS_PER_HOUR = 10;
const uuid = z.uuid();
const decision = z.enum(['auto', 'approve', 'never']);
const policySchema = z.strictObject({ ask: decision, coordinate: decision, act: decision, dailyLimit: z.number().int().min(1).max(1000) });
const notFound = () => new RelayError('not_found', 'Not found', 404);

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new RelayError('invalid_input', 'Invalid arguments', 400);
  return result.data;
}

type LinkRow = { id: string; binding_a: string; binding_b: string; status: string; proposed_by: string | null; policy_a: Policy; policy_b: Policy; owner_a: string; owner_b: string };

export interface NetworkOptions {
  mcpUrl: string;
  oauth?: OAuthPilot;
  webhook?: { encryptionKey: Buffer; hosts: string[] };
}

/** Owner-scoped operations for the web app. Every lookup is filtered by the session owner. */
export class Network {
  constructor(private readonly pool: Pool, private readonly relay: Relay, private readonly options: NetworkOptions) {}

  private tx<T>(work: (client: PoolClient) => Promise<T>) {
    return withTransaction(this.pool, async client => { await lockRelay(client); return work(client); });
  }

  private async agent(client: PoolClient, ownerId: string, id: string) {
    parse(uuid, id);
    const found = await client.query<{ id: string; provider: Provider }>('SELECT id,provider FROM bindings WHERE id=$1 AND owner_id=$2 AND active', [id, ownerId]);
    if (!found.rows[0]) throw notFound();
    return found.rows[0];
  }

  private async link(client: PoolClient, ownerId: string, id: string, lock = false): Promise<LinkRow> {
    parse(uuid, id);
    const found = await client.query<LinkRow>(`SELECT g.id,g.binding_a,g.binding_b,g.status,g.proposed_by,g.policy_a,g.policy_b,a.owner_id AS owner_a,b.owner_id AS owner_b
      FROM grants g JOIN bindings a ON a.id=g.binding_a JOIN bindings b ON b.id=g.binding_b
      WHERE g.id=$1 AND (a.owner_id=$2 OR b.owner_id=$2)${lock ? ' FOR UPDATE OF g' : ''}`, [id, ownerId]);
    if (!found.rows[0]) throw notFound();
    return found.rows[0];
  }

  async overview(ownerId: string) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const me = (await client.query<{ id: string; displayName: string }>('SELECT id,display_name AS "displayName" FROM owners WHERE id=$1', [ownerId])).rows[0];
      if (!me) throw new RelayError('unauthorized', 'Sign in again', 401);
      const agents = await client.query(`SELECT b.id,b.display_name AS "displayName",b.provider,b.created_at AS "createdAt",
          b.webhook_encrypted IS NOT NULL AS "webhookConfigured",
          EXISTS(SELECT 1 FROM oauth_families f WHERE f.binding_id=b.id AND NOT f.revoked AND f.expires_at>clock_timestamp()) AS connected,
          (SELECT max(m.created_at) FROM messages m WHERE m.sender_binding_id=b.id) AS "lastActiveAt"
        FROM bindings b WHERE b.owner_id=$1 AND b.active ORDER BY b.created_at`, [ownerId]);
      const contacts = await client.query(`SELECT o.id,o.display_name AS "displayName",c.created_at AS "since",
          COALESCE((SELECT json_agg(json_build_object('id',b.id,'displayName',b.display_name,'provider',b.provider) ORDER BY b.created_at)
            FROM bindings b WHERE b.owner_id=o.id AND b.active),'[]') AS agents
        FROM contacts c JOIN owners o ON o.id=CASE WHEN c.owner_a=$1 THEN c.owner_b ELSE c.owner_a END
        WHERE c.owner_a=$1 OR c.owner_b=$1 ORDER BY o.display_name`, [ownerId]);
      const links = await client.query(`SELECT g.id,g.status,g.proposed_by=$1 AS "proposedByMe",g.created_at AS "createdAt",
          CASE WHEN a.owner_id=$1 THEN a.id ELSE b.id END AS "agentId",
          CASE WHEN a.owner_id=$1 THEN b.id ELSE a.id END AS "peerAgentId",
          CASE WHEN a.owner_id=$1 THEN b.display_name ELSE a.display_name END AS "peerAgentName",
          CASE WHEN a.owner_id=$1 THEN b.provider ELSE a.provider END AS "peerProvider",
          CASE WHEN a.owner_id=$1 THEN ob.display_name ELSE oa.display_name END AS "peerOwnerName",
          CASE WHEN a.owner_id=$1 THEN g.policy_a ELSE g.policy_b END AS policy,
          (SELECT max(m.created_at) FROM messages m JOIN conversations c ON c.id=m.conversation_id
            WHERE (c.binding_a=g.binding_a AND c.binding_b=g.binding_b) OR (c.binding_a=g.binding_b AND c.binding_b=g.binding_a)) AS "lastMessageAt"
        FROM grants g JOIN bindings a ON a.id=g.binding_a JOIN bindings b ON b.id=g.binding_b
        JOIN owners oa ON oa.id=a.owner_id JOIN owners ob ON ob.id=b.owner_id
        WHERE (a.owner_id=$1 OR b.owner_id=$1) AND g.status<>'revoked' AND a.active AND b.active ORDER BY g.created_at`, [ownerId]);
      const approvals = await client.query(`SELECT m.id,m.text,m.intent,m.created_at AS "createdAt",m.conversation_id AS "conversationId",
          r.id AS "agentId",r.display_name AS "agentName",s.display_name AS "fromAgentName",s.provider AS "fromProvider",so.display_name AS "fromOwnerName"
        FROM messages m JOIN bindings r ON r.id=m.recipient_binding_id JOIN bindings s ON s.id=m.sender_binding_id JOIN owners so ON so.id=s.owner_id
        JOIN conversations c ON c.id=m.conversation_id
        WHERE r.owner_id=$1 AND m.approval='pending' AND c.status='open' ORDER BY m.created_at LIMIT 50`, [ownerId]);
      const recent = await client.query(`SELECT m.id,m.created_at AS "createdAt",m.intent,m.approval,left(m.text,200) AS preview,
          s.display_name AS "fromAgentName",s.owner_id=$1 AS "fromMe",r.display_name AS "toAgentName",
          c.status AS "conversationStatus",o.status AS delivery,t.result
        FROM messages m JOIN bindings s ON s.id=m.sender_binding_id JOIN bindings r ON r.id=m.recipient_binding_id
        JOIN conversations c ON c.id=m.conversation_id
        LEFT JOIN outbox o ON o.message_id=m.id LEFT JOIN turns t ON t.input_message_id=m.id
        WHERE s.owner_id=$1 OR r.owner_id=$1 ORDER BY m.created_at DESC LIMIT 20`, [ownerId]);
      await client.query('COMMIT');
      return { me, agents: agents.rows, contacts: contacts.rows, links: links.rows, approvals: approvals.rows, recent: recent.rows };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async createAgent(ownerId: string, input: unknown) {
    const data = parse(z.strictObject({ provider: z.enum(PROVIDERS), displayName }), input);
    const created = await this.relay.provisionBinding({ ownerId, runtimeScope: randomUUID(), provider: data.provider, displayName: data.displayName, maxActive: MAX_AGENTS });
    const connect = data.provider === 'mcp'
      ? { mcpUrl: this.options.mcpUrl, token: created.token }
      : { mcpUrl: this.options.mcpUrl, ...await this.issuePairing(created.bindingId) };
    return { agent: { id: created.bindingId, displayName: data.displayName, provider: data.provider }, connect };
  }

  private async issuePairing(bindingId: string) {
    if (!this.options.oauth) return { pairing: 'unavailable' as const };
    const issued = await this.options.oauth.issuePairingCode(bindingId);
    return { pairingCode: issued.pairingCode, expiresAt: issued.expiresAt };
  }

  async renameAgent(ownerId: string, id: string, input: unknown) {
    const data = parse(z.strictObject({ displayName }), input);
    return this.tx(async client => {
      await this.agent(client, ownerId, id);
      await client.query('UPDATE bindings SET display_name=$2 WHERE id=$1', [id, data.displayName]);
      return { id, displayName: data.displayName };
    });
  }

  async pairing(ownerId: string, id: string) {
    await this.tx(async client => {
      await this.agent(client, ownerId, id);
      const hour = Math.floor(Date.now() / 3600_000);
      const hit = await client.query<{ hits: number }>(`INSERT INTO web_rates(bucket,hits,expires_at) VALUES($1,1,clock_timestamp()+interval '2 hours')
        ON CONFLICT(bucket) DO UPDATE SET hits=web_rates.hits+1 RETURNING hits`, [`pairing:${id}:${hour}`]);
      if (hit.rows[0]!.hits > PAIRINGS_PER_HOUR) throw new RelayError('rate_limited', 'Too many pairing codes', 429);
    });
    return { mcpUrl: this.options.mcpUrl, ...await this.issuePairing(id) };
  }

  /** The stored value is encrypted with the agent ID as context; only "configured" is ever returned. */
  async setWebhook(ownerId: string, id: string, input: unknown) {
    const data = parse(grokWebhook, input);
    const webhook = this.options.webhook;
    if (!webhook) throw new RelayError('unavailable', 'Notifications are not enabled', 409);
    try { grokWebhookUrl(data.url, webhook.hosts); } catch { throw new RelayError('invalid_input', 'Invalid webhook URL', 400); }
    return this.tx(async client => {
      const agent = await this.agent(client, ownerId, id);
      if (agent.provider !== 'grok') throw new RelayError('invalid_input', 'Only Grok agents use a webhook', 400);
      await client.query('UPDATE bindings SET webhook_encrypted=$2 WHERE id=$1', [id, encryptSecret(JSON.stringify(data), webhook.encryptionKey, id)]);
      return { id, webhookConfigured: true };
    });
  }

  async disableAgent(ownerId: string, id: string) {
    await this.tx(client => this.agent(client, ownerId, id));
    await this.relay.disableBinding(id);
    return { id, disabled: true };
  }

  async removeContact(ownerId: string, otherOwnerId: string) {
    parse(uuid, otherOwnerId);
    const pairs = await this.tx(async client => {
      const removed = await client.query('DELETE FROM contacts WHERE owner_a=$1 AND owner_b=$2', [ownerId, otherOwnerId].sort());
      if (!removed.rowCount) throw notFound();
      return (await client.query<{ binding_a: string; binding_b: string }>(`SELECT g.binding_a,g.binding_b FROM grants g
        JOIN bindings a ON a.id=g.binding_a JOIN bindings b ON b.id=g.binding_b
        WHERE g.status<>'revoked' AND ((a.owner_id=$1 AND b.owner_id=$2) OR (a.owner_id=$2 AND b.owner_id=$1))`, [ownerId, otherOwnerId])).rows;
    });
    for (const pair of pairs) await this.relay.revokePair(pair.binding_a, pair.binding_b);
    return { removed: true };
  }

  /** Links need a contact (or two of one's own agents). The other owner must accept. */
  async proposeLink(ownerId: string, input: unknown) {
    const data = parse(z.strictObject({ agentId: uuid, peerAgentId: uuid }), input);
    if (data.agentId === data.peerAgentId) throw new RelayError('invalid_input', 'Two different agents are required', 400);
    return this.tx(async client => {
      await this.agent(client, ownerId, data.agentId);
      const peer = (await client.query<{ owner_id: string }>('SELECT owner_id FROM bindings WHERE id=$1 AND active', [data.peerAgentId])).rows[0];
      if (!peer) throw notFound();
      const own = peer.owner_id === ownerId;
      if (!own && !(await client.query('SELECT 1 FROM contacts WHERE owner_a=$1 AND owner_b=$2', [ownerId, peer.owner_id].sort())).rowCount) throw notFound();
      const [a, b] = [data.agentId, data.peerAgentId].sort();
      const status = own ? 'active' : 'proposed';
      const saved = await client.query<{ id: string; status: string }>(`INSERT INTO grants(binding_a,binding_b,status,proposed_by) VALUES($1,$2,$3,$4)
        ON CONFLICT(binding_a,binding_b) DO UPDATE SET status=EXCLUDED.status,proposed_by=EXCLUDED.proposed_by WHERE grants.status='revoked'
        RETURNING id,status`, [a, b, status, ownerId]);
      if (!saved.rows[0]) throw new RelayError('already_linked', 'A link already exists', 409);
      return saved.rows[0];
    });
  }

  async acceptLink(ownerId: string, id: string) {
    return this.tx(async client => {
      const link = await this.link(client, ownerId, id, true);
      if (link.status !== 'proposed' || link.proposed_by === ownerId) throw new RelayError('not_pending', 'Nothing to accept', 409);
      await client.query("UPDATE grants SET status='active' WHERE id=$1", [id]);
      return { id, status: 'active' };
    });
  }

  /** Each owner controls only what their own agent receives; the peer's consent is not needed. */
  async setPolicy(ownerId: string, id: string, input: unknown) {
    const data = parse(policySchema, input);
    const policy: Policy = { ask: data.ask, coordinate: data.coordinate, act: data.act, daily_limit: data.dailyLimit };
    return this.tx(async client => {
      const link = await this.link(client, ownerId, id, true);
      if (link.status === 'revoked') throw notFound();
      await client.query(`UPDATE grants SET policy_a=CASE WHEN $2 THEN $4::jsonb ELSE policy_a END,
        policy_b=CASE WHEN $3 THEN $4::jsonb ELSE policy_b END WHERE id=$1`, [id, link.owner_a === ownerId, link.owner_b === ownerId, JSON.stringify(policy)]);
      return { id, policy };
    });
  }

  async revokeLink(ownerId: string, id: string) {
    const link = await this.tx(client => this.link(client, ownerId, id));
    await this.relay.revokePair(link.binding_a, link.binding_b);
    return { id, status: 'revoked' };
  }

  decide(ownerId: string, messageId: string, input: unknown) {
    const data = parse(z.strictObject({ decision: z.enum(['approve', 'decline']) }), input);
    return this.relay.decideApproval(ownerId, parse(uuid, messageId), data.decision);
  }

  async timeline(ownerId: string, id: string) {
    const link = await this.tx(client => this.link(client, ownerId, id));
    const rows = await this.pool.query(`SELECT m.id,m.created_at AS "createdAt",m.text,m.intent,m.approval,m.sequence,m.conversation_id AS "conversationId",
        s.owner_id=$3 AS "fromMe",s.display_name AS "fromAgentName",c.status AS "conversationStatus",o.status AS delivery,t.result
      FROM messages m JOIN bindings s ON s.id=m.sender_binding_id JOIN conversations c ON c.id=m.conversation_id
      LEFT JOIN outbox o ON o.message_id=m.id LEFT JOIN turns t ON t.input_message_id=m.id
      WHERE (c.binding_a=$1 AND c.binding_b=$2) OR (c.binding_a=$2 AND c.binding_b=$1)
      ORDER BY m.created_at DESC, m.sequence DESC LIMIT 100`, [link.binding_a, link.binding_b, ownerId]);
    return { linkId: id, messages: rows.rows };
  }
}
