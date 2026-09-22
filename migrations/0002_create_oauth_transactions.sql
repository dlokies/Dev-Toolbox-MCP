CREATE TABLE oauth_transactions (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('consent', 'oidc')),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND json_type(payload_json) = 'object'),
  expires_at INTEGER NOT NULL
);
CREATE INDEX oauth_transactions_expiry ON oauth_transactions(expires_at);
