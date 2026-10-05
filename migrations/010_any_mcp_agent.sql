ALTER TABLE bindings DROP CONSTRAINT bindings_provider_check;
UPDATE bindings SET provider='mcp' WHERE provider='muse';
ALTER TABLE bindings ADD CONSTRAINT bindings_provider_check CHECK(provider IN ('dots','grok','mcp'));
