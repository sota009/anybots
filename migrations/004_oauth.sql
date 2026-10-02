CREATE TABLE oauth_clients (
  id text PRIMARY KEY, redirect_uris jsonb NOT NULL, name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE oauth_pairings (
  hash text PRIMARY KEY, binding_id uuid NOT NULL REFERENCES bindings,
  expires_at timestamptz NOT NULL, consumed boolean NOT NULL DEFAULT false
);
CREATE TABLE oauth_pending (
  hash text PRIMARY KEY, cookie_hash text NOT NULL, client_id text NOT NULL REFERENCES oauth_clients,
  redirect_uri text NOT NULL, resource text NOT NULL, state text NOT NULL, scope text NOT NULL,
  challenge text NOT NULL, attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
  expires_at timestamptz NOT NULL, consumed boolean NOT NULL DEFAULT false
);
CREATE TABLE oauth_families (
  id uuid PRIMARY KEY, binding_id uuid NOT NULL REFERENCES bindings,
  client_id text NOT NULL REFERENCES oauth_clients, resource text NOT NULL, scope text NOT NULL,
  expires_at timestamptz NOT NULL, revoked boolean NOT NULL DEFAULT false
);
CREATE TABLE oauth_codes (
  hash text PRIMARY KEY, binding_id uuid NOT NULL REFERENCES bindings,
  client_id text NOT NULL REFERENCES oauth_clients, redirect_uri text NOT NULL,
  resource text NOT NULL, scope text NOT NULL, challenge text NOT NULL,
  expires_at timestamptz NOT NULL, consumed boolean NOT NULL DEFAULT false,
  family_id uuid REFERENCES oauth_families ON DELETE SET NULL
);
CREATE TABLE oauth_tokens (
  hash text PRIMARY KEY, family_id uuid NOT NULL REFERENCES oauth_families ON DELETE CASCADE,
  kind text NOT NULL CHECK(kind IN ('access','refresh')), expires_at timestamptz NOT NULL,
  consumed boolean NOT NULL DEFAULT false
);
CREATE INDEX oauth_tokens_family ON oauth_tokens(family_id);
CREATE TABLE oauth_rates (bucket text PRIMARY KEY, hits integer NOT NULL, expires_at timestamptz NOT NULL);
