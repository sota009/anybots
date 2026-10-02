CREATE TABLE event_subscriptions (
  id text PRIMARY KEY,
  binding_id uuid NOT NULL REFERENCES bindings(id),
  event_name text NOT NULL,
  arguments jsonb NOT NULL,
  callback_url text NOT NULL,
  secret_encrypted text NOT NULL,
  previous_secret_encrypted text,
  rotation_until timestamptz,
  expires_at timestamptz NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX event_subscriptions_delivery ON event_subscriptions(binding_id, expires_at) WHERE active;
CREATE UNIQUE INDEX event_subscriptions_one_active_context ON event_subscriptions(binding_id) WHERE active;
