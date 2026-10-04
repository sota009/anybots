CREATE TABLE directory_credentials (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES owners(id),
  secret_hash text NOT NULL UNIQUE,
  scope text NOT NULL CHECK (scope = 'directory:read'),
  audience text NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > issued_at)
);
CREATE UNIQUE INDEX directory_credentials_one_live ON directory_credentials(owner_id) WHERE revoked_at IS NULL;
CREATE INDEX directory_credentials_owner ON directory_credentials(owner_id, issued_at DESC);
