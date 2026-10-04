DROP TABLE directory_credentials;

ALTER TABLE owners DROP COLUMN directory_enabled;
ALTER TABLE owners ADD COLUMN display_name text NOT NULL DEFAULT '' CHECK(char_length(display_name) <= 64);

CREATE TABLE passkeys (
  id text PRIMARY KEY CHECK(char_length(id) BETWEEN 16 AND 1400),
  owner_id uuid NOT NULL REFERENCES owners(id),
  public_key bytea NOT NULL,
  counter bigint NOT NULL DEFAULT 0 CHECK(counter >= 0),
  transports text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX passkeys_owner ON passkeys(owner_id);

CREATE TABLE web_sessions (
  hash text PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES owners(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX web_sessions_owner ON web_sessions(owner_id);

CREATE TABLE invites (
  id uuid PRIMARY KEY,
  hash text NOT NULL UNIQUE,
  kind text NOT NULL CHECK(kind IN ('signup','contact')),
  issuer_owner_id uuid REFERENCES owners(id),
  target_owner_id uuid REFERENCES owners(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  used_by uuid REFERENCES owners(id),
  CHECK((kind = 'contact') = (issuer_owner_id IS NOT NULL)),
  CHECK(kind = 'signup' OR target_owner_id IS NULL)
);
CREATE INDEX invites_issuer ON invites(issuer_owner_id, created_at);

CREATE TABLE webauthn_challenges (
  id uuid PRIMARY KEY,
  purpose text NOT NULL CHECK(purpose IN ('register','login')),
  challenge text NOT NULL,
  owner_id uuid,
  invite_id uuid REFERENCES invites(id) ON DELETE CASCADE,
  display_name text CHECK(char_length(display_name) BETWEEN 1 AND 64),
  expires_at timestamptz NOT NULL,
  CHECK((purpose = 'register') = (invite_id IS NOT NULL AND owner_id IS NOT NULL))
);

CREATE TABLE contacts (
  owner_a uuid NOT NULL REFERENCES owners(id),
  owner_b uuid NOT NULL REFERENCES owners(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_a, owner_b),
  CHECK(owner_a < owner_b)
);
CREATE INDEX contacts_b ON contacts(owner_b);

CREATE TABLE web_rates (bucket text PRIMARY KEY, hits integer NOT NULL, expires_at timestamptz NOT NULL);

ALTER TABLE bindings ADD COLUMN display_name text NOT NULL DEFAULT '' CHECK(char_length(display_name) <= 64);
ALTER TABLE bindings ADD COLUMN webhook_encrypted text;

ALTER TABLE grants ADD COLUMN status text NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','active','revoked'));
-- A revoked permission must never come back as active.
UPDATE grants SET status = CASE WHEN active THEN 'active' ELSE 'revoked' END;
ALTER TABLE grants DROP COLUMN active;
ALTER TABLE grants ADD COLUMN id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid();
ALTER TABLE grants ADD COLUMN active boolean GENERATED ALWAYS AS (status = 'active') STORED;
ALTER TABLE grants ADD COLUMN proposed_by uuid REFERENCES owners(id);
ALTER TABLE grants ADD COLUMN policy_a jsonb NOT NULL DEFAULT '{"ask":"auto","coordinate":"auto","act":"approve","daily_limit":100}';
ALTER TABLE grants ADD COLUMN policy_b jsonb NOT NULL DEFAULT '{"ask":"auto","coordinate":"auto","act":"approve","daily_limit":100}';
CREATE INDEX grants_active_a ON grants(binding_a) WHERE active;
CREATE INDEX grants_active_b ON grants(binding_b) WHERE active;

ALTER TABLE messages ADD COLUMN intent text NOT NULL DEFAULT 'ask' CHECK(intent IN ('ask','coordinate','act'));
ALTER TABLE messages ADD COLUMN approval text NOT NULL DEFAULT 'none' CHECK(approval IN ('none','pending','approved','declined'));
CREATE INDEX messages_recipient_recent ON messages(recipient_binding_id, sender_binding_id, created_at);
CREATE INDEX messages_pending_approval ON messages(recipient_binding_id) WHERE approval = 'pending';
