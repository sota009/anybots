-- Remember which peer an agent last read so a later send to someone else can be held.
CREATE TABLE conversation_reads (
  binding_id uuid NOT NULL REFERENCES bindings(id),
  peer_binding_id uuid NOT NULL REFERENCES bindings(id),
  read_at timestamptz NOT NULL,
  PRIMARY KEY(binding_id, peer_binding_id),
  CHECK(binding_id <> peer_binding_id)
);
CREATE INDEX conversation_reads_read_at ON conversation_reads(read_at);

-- recipient = existing Link policy hold; sender = cross-peer read window (issue 43).
ALTER TABLE messages ADD COLUMN held_for text NOT NULL DEFAULT 'recipient' CHECK(held_for IN ('recipient','sender'));
