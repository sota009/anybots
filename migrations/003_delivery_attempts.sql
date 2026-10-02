CREATE TABLE delivery_attempts (
  id uuid PRIMARY KEY,
  outbox_id uuid NOT NULL REFERENCES outbox(id),
  binding_id uuid NOT NULL REFERENCES bindings(id),
  owner_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('uncertain','accepted','retry','failed','configuration_required')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX attempts_binding_time ON delivery_attempts(binding_id, started_at);
CREATE INDEX attempts_owner_time ON delivery_attempts(owner_id, started_at);
