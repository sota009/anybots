-- Connector authorization must remain live for the entire subscription lifetime.
-- Cascading deletion is intentional: SET NULL would turn deleted OAuth authority
-- into the static pilot authorization branch.
ALTER TABLE event_subscriptions ADD COLUMN oauth_family_id uuid
  REFERENCES oauth_families(id) ON DELETE CASCADE;
CREATE INDEX event_subscriptions_oauth_family ON event_subscriptions(oauth_family_id)
  WHERE oauth_family_id IS NOT NULL;
