ALTER TABLE bindings DROP CONSTRAINT bindings_provider_check;
ALTER TABLE bindings ADD CONSTRAINT bindings_provider_check CHECK(provider IN ('dots','grok','muse'));

ALTER TABLE outbox DROP CONSTRAINT outbox_status_check;
ALTER TABLE outbox ADD CONSTRAINT outbox_status_check
  CHECK(status IN ('pending','accepted','failed','uncertain','cancelled','not_required'));
