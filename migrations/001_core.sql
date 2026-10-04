CREATE TABLE owners (
  id uuid PRIMARY KEY,
  directory_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bindings (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES owners(id),
  runtime_scope text NOT NULL,
  provider text NOT NULL CHECK(provider IN ('dots','grok')),
  token_hash text NOT NULL UNIQUE,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX binding_active_runtime ON bindings(runtime_scope) WHERE active;
CREATE INDEX bindings_owner_id ON bindings(owner_id, id);

CREATE TABLE grants (
  binding_a uuid NOT NULL REFERENCES bindings,
  binding_b uuid NOT NULL REFERENCES bindings,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(binding_a, binding_b),
  CHECK(binding_a < binding_b)
);
CREATE INDEX grants_active_a ON grants(binding_a) WHERE active;
CREATE INDEX grants_active_b ON grants(binding_b) WHERE active;

CREATE TABLE conversations (
  id uuid PRIMARY KEY,
  binding_a uuid NOT NULL REFERENCES bindings,
  binding_b uuid NOT NULL REFERENCES bindings,
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed','expired','limited','uncertain')),
  epoch integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',
  turn_count integer NOT NULL DEFAULT 0 CHECK(turn_count BETWEEN 0 AND 12),
  next_sequence integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(binding_a <> binding_b)
);

CREATE TABLE messages (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations,
  sequence integer NOT NULL,
  sender_binding_id uuid NOT NULL REFERENCES bindings,
  recipient_binding_id uuid NOT NULL REFERENCES bindings,
  reply_to uuid REFERENCES messages,
  text text NOT NULL CHECK(octet_length(text) <= 16384),
  expects_reply boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(conversation_id, sequence)
);

CREATE TABLE turns (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations,
  binding_id uuid NOT NULL REFERENCES bindings,
  input_message_id uuid NOT NULL UNIQUE REFERENCES messages,
  epoch integer NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','finished','uncertain','cancelled')),
  lease_expires_at timestamptz NOT NULL,
  result text CHECK(result IN ('replied','no_reply','blocked','declined')),
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX turns_active_binding ON turns(binding_id) WHERE status='active';

CREATE TABLE outbox (
  id uuid PRIMARY KEY,
  message_id uuid NOT NULL UNIQUE REFERENCES messages,
  conversation_id uuid NOT NULL REFERENCES conversations,
  binding_id uuid NOT NULL REFERENCES bindings,
  epoch integer NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','failed','uncertain','cancelled')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_pending ON outbox(next_attempt_at) WHERE status='pending';

CREATE TABLE idempotency (
  binding_id uuid NOT NULL REFERENCES bindings,
  operation text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(binding_id, operation, key)
);
