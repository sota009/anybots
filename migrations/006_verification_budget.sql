-- Callback challenges have their own budget; they are not inbox deliveries.
-- Global counters survive binding deletion. Expired buckets are pruned on use.
CREATE TABLE verification_budget (
  period text NOT NULL CHECK (period IN ('hour','day','month')),
  subject text NOT NULL,
  bucket_start timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL CHECK (attempts > 0),
  PRIMARY KEY (period,subject,bucket_start),
  CHECK (expires_at > bucket_start),
  CHECK ((period='hour' AND subject<>'') OR (period IN ('day','month') AND subject=''))
);
CREATE INDEX verification_budget_expiry ON verification_budget(expires_at);
