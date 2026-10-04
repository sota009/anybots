import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { withTransaction } from './db.js';
import { RelayError } from './errors.js';

const INVITE_TTL_MS = 7 * 24 * 3600_000;
const CHALLENGE_TTL_MS = 5 * 60_000;
const SESSION_TTL_MS = 14 * 24 * 3600_000;
const CONTACT_INVITES_PER_DAY = 20;

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const displayName = z.string().trim().min(1).max(64);
const uuidBytes = (id: string) => Buffer.from(id.replaceAll('-', ''), 'hex');
const invalidInvite = () => new RelayError('invalid_invite', 'Invite is invalid or expired', 400);
// One generic failure: callers cannot tell unknown credentials from bad signatures.
const failed = () => new RelayError('authentication_failed', 'Authentication failed', 401);

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new RelayError('invalid_input', 'Invalid arguments', 400);
  return result.data;
}

type Invite = { id: string; kind: 'signup' | 'contact'; issuer_owner_id: string | null; target_owner_id: string | null };

/** Passkey accounts, invitations, and web sessions. Secrets are stored only as SHA-256. */
export class Accounts {
  readonly rpId: string;
  constructor(private readonly pool: Pool, private readonly options: { origin: string; rpName?: string }) {
    this.rpId = new URL(options.origin).hostname;
  }

  async createSignupInvite(targetOwnerId?: string) {
    if (targetOwnerId !== undefined) parse(z.uuid(), targetOwnerId);
    return withTransaction(this.pool, async client => {
      if (targetOwnerId && !(await client.query('SELECT 1 FROM owners WHERE id=$1', [targetOwnerId])).rowCount) throw new RelayError('not_found', 'Not found', 404);
      return this.invite(client, 'signup', null, targetOwnerId ?? null);
    });
  }

  async createContactInvite(ownerId: string) {
    return withTransaction(this.pool, async client => {
      await client.query('SELECT 1 FROM owners WHERE id=$1 FOR UPDATE', [ownerId]);
      const today = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM invites WHERE issuer_owner_id=$1 AND created_at>clock_timestamp()-interval '1 day'", [ownerId]);
      if (today.rows[0]!.n >= CONTACT_INVITES_PER_DAY) throw new RelayError('rate_limited', 'Too many invites', 429);
      return this.invite(client, 'contact', ownerId, null);
    });
  }

  private async invite(client: PoolClient, kind: Invite['kind'], issuer: string | null, target: string | null) {
    const value = secret();
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
    await client.query('INSERT INTO invites(id,hash,kind,issuer_owner_id,target_owner_id,expires_at) VALUES($1,$2,$3,$4,$5,$6)', [id, hash(value), kind, issuer, target, expiresAt]);
    return { inviteId: id, token: value, expiresAt: expiresAt.toISOString() };
  }

  private async liveInvite(client: PoolClient, value: string, lock: boolean): Promise<Invite> {
    const found = await client.query<Invite>(`SELECT id,kind,issuer_owner_id,target_owner_id FROM invites
      WHERE hash=$1 AND used_at IS NULL AND expires_at>clock_timestamp()${lock ? ' FOR UPDATE' : ''}`, [hash(value)]);
    if (!found.rows[0]) throw invalidInvite();
    return found.rows[0];
  }

  async registerOptions(input: { invite: string; displayName: string }) {
    const data = parse(z.strictObject({ invite: token, displayName }), input);
    return withTransaction(this.pool, async client => {
      const invite = await this.liveInvite(client, data.invite, false);
      const ownerId = invite.target_owner_id ?? randomUUID();
      const existing = await client.query<{ id: string; transports: string[] }>('SELECT id,transports FROM passkeys WHERE owner_id=$1', [ownerId]);
      const options = await generateRegistrationOptions({
        rpName: this.options.rpName ?? 'Anybots', rpID: this.rpId, userID: uuidBytes(ownerId),
        userName: data.displayName, userDisplayName: data.displayName, attestationType: 'none',
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        excludeCredentials: existing.rows.map(row => ({ id: row.id, transports: row.transports })),
        timeout: CHALLENGE_TTL_MS,
      });
      const challengeId = randomUUID();
      await client.query("DELETE FROM webauthn_challenges WHERE expires_at<clock_timestamp()");
      await client.query("INSERT INTO webauthn_challenges(id,purpose,challenge,owner_id,invite_id,display_name,expires_at) VALUES($1,'register',$2,$3,$4,$5,$6)",
        [challengeId, options.challenge, ownerId, invite.id, data.displayName, new Date(Date.now() + CHALLENGE_TTL_MS)]);
      return { challengeId, options };
    });
  }

  async registerVerify(input: { challengeId: string; response: unknown }) {
    const data = parse(z.strictObject({ challengeId: z.uuid(), response: z.record(z.string(), z.unknown()) }), input);
    const challenge = await this.takeChallenge(data.challengeId, 'register');
    return withTransaction(this.pool, async client => {
      let info;
      try {
        const verified = await verifyRegistrationResponse({
          response: data.response as unknown as RegistrationResponseJSON, expectedChallenge: challenge.challenge,
          expectedOrigin: this.options.origin, expectedRPID: this.rpId, requireUserVerification: true,
        });
        if (!verified.verified) throw failed();
        info = verified.registrationInfo;
      } catch { throw failed(); }
      const invite = await this.inviteById(client, challenge.invite_id!);
      const ownerId = challenge.owner_id!;
      await client.query('INSERT INTO owners(id,display_name) VALUES($1,$2) ON CONFLICT(id) DO NOTHING', [ownerId, challenge.display_name]);
      const inserted = await client.query('INSERT INTO passkeys(id,owner_id,public_key,counter,transports) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING',
        [info.credential.id, ownerId, Buffer.from(info.credential.publicKey), info.credential.counter, info.credential.transports ?? []]);
      if (!inserted.rowCount) throw failed();
      await client.query('UPDATE invites SET used_at=clock_timestamp(),used_by=$2 WHERE id=$1', [invite.id, ownerId]);
      if (invite.kind === 'contact') await this.connect(client, invite.issuer_owner_id!, ownerId);
      return { ownerId, session: await this.startSession(client, ownerId) };
    });
  }

  private async inviteById(client: PoolClient, id: string): Promise<Invite> {
    const found = await client.query<Invite>(`SELECT id,kind,issuer_owner_id,target_owner_id FROM invites
      WHERE id=$1 AND used_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE`, [id]);
    if (!found.rows[0]) throw invalidInvite();
    return found.rows[0];
  }

  async loginOptions() {
    const options = await generateAuthenticationOptions({ rpID: this.rpId, userVerification: 'required', timeout: CHALLENGE_TTL_MS });
    const challengeId = randomUUID();
    await withTransaction(this.pool, async client => {
      await client.query("DELETE FROM webauthn_challenges WHERE expires_at<clock_timestamp()");
      await client.query("INSERT INTO webauthn_challenges(id,purpose,challenge,expires_at) VALUES($1,'login',$2,$3)",
        [challengeId, options.challenge, new Date(Date.now() + CHALLENGE_TTL_MS)]);
    });
    return { challengeId, options };
  }

  async loginVerify(input: { challengeId: string; response: unknown }) {
    const data = parse(z.strictObject({ challengeId: z.uuid(), response: z.record(z.string(), z.unknown()) }), input);
    const credentialId = parse(z.string().min(16).max(1400), (data.response as { id?: unknown }).id);
    const challenge = await this.takeChallenge(data.challengeId, 'login');
    return withTransaction(this.pool, async client => {
      const found = await client.query<{ owner_id: string; public_key: Buffer; counter: string; transports: string[] }>(
        'SELECT owner_id,public_key,counter,transports FROM passkeys WHERE id=$1 FOR UPDATE', [credentialId]);
      const passkey = found.rows[0];
      if (!passkey) throw failed();
      let counter: number;
      try {
        const verified = await verifyAuthenticationResponse({
          response: data.response as unknown as AuthenticationResponseJSON, expectedChallenge: challenge.challenge,
          expectedOrigin: this.options.origin, expectedRPID: this.rpId, requireUserVerification: true,
          credential: { id: credentialId, publicKey: new Uint8Array(passkey.public_key), counter: Number(passkey.counter), transports: passkey.transports as never },
        });
        if (!verified.verified) throw failed();
        counter = verified.authenticationInfo.newCounter;
      } catch { throw failed(); }
      await client.query('UPDATE passkeys SET counter=$2,last_used_at=clock_timestamp() WHERE id=$1', [credentialId, counter]);
      return { ownerId: passkey.owner_id, session: await this.startSession(client, passkey.owner_id) };
    });
  }

  /** Committed on its own so that a failed verification still burns the challenge. */
  private async takeChallenge(id: string, purpose: 'register' | 'login') {
    const taken = await this.pool.query<{ challenge: string; owner_id: string | null; invite_id: string | null; display_name: string | null }>(
      'DELETE FROM webauthn_challenges WHERE id=$1 AND purpose=$2 AND expires_at>clock_timestamp() RETURNING challenge,owner_id,invite_id,display_name', [id, purpose]);
    if (!taken.rows[0]) throw failed();
    return taken.rows[0];
  }

  /** Always a fresh server-generated identifier: a client-supplied session is never adopted. */
  private async startSession(client: PoolClient, ownerId: string) {
    const value = secret();
    await client.query('INSERT INTO web_sessions(hash,owner_id,expires_at) VALUES($1,$2,$3)', [hash(value), ownerId, new Date(Date.now() + SESSION_TTL_MS)]);
    return value;
  }

  async session(value: string | undefined): Promise<string | undefined> {
    if (!value || !token.safeParse(value).success) return undefined;
    const found = await this.pool.query<{ owner_id: string }>(`UPDATE web_sessions SET last_seen_at=clock_timestamp()
      WHERE hash=$1 AND expires_at>clock_timestamp() AND last_seen_at>clock_timestamp()-interval '24 hours' RETURNING owner_id`, [hash(value)]);
    return found.rows[0]?.owner_id;
  }

  async logout(value: string | undefined) {
    if (value && token.safeParse(value).success) await this.pool.query('DELETE FROM web_sessions WHERE hash=$1', [hash(value)]);
  }

  async acceptInvite(ownerId: string, value: string) {
    const invite = parse(token, value);
    return withTransaction(this.pool, async client => {
      const found = await this.liveInvite(client, invite, true);
      if (found.kind !== 'contact' || found.issuer_owner_id === ownerId) throw invalidInvite();
      await client.query('UPDATE invites SET used_at=clock_timestamp(),used_by=$2 WHERE id=$1', [found.id, ownerId]);
      await this.connect(client, found.issuer_owner_id!, ownerId);
      return { contactOwnerId: found.issuer_owner_id! };
    });
  }

  private async connect(client: PoolClient, a: string, b: string) {
    await client.query('INSERT INTO contacts(owner_a,owner_b) VALUES($1,$2) ON CONFLICT DO NOTHING', [a, b].sort());
  }

  /** Fixed one-minute windows. A rejected source does not spend the shared allowance. */
  async allow(endpoint: string, source: string, limits: { perSource: number; global: number }): Promise<boolean> {
    const minute = Math.floor(Date.now() / 60_000);
    return withTransaction(this.pool, async client => {
      await client.query('DELETE FROM web_rates WHERE expires_at<clock_timestamp()');
      for (const [bucket, limit] of [[`src:${hash(source)}:${endpoint}:${minute}`, limits.perSource], [`all:${endpoint}:${minute}`, limits.global]] as const) {
        const hit = await client.query<{ hits: number }>(`INSERT INTO web_rates(bucket,hits,expires_at) VALUES($1,1,clock_timestamp()+interval '2 minutes')
          ON CONFLICT(bucket) DO UPDATE SET hits=web_rates.hits+1 RETURNING hits`, [bucket]);
        if (hit.rows[0]!.hits > limit) return false;
      }
      return true;
    });
  }
}
