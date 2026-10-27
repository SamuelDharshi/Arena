export const SCHEMA = /* sql */ `
CREATE TABLE IF NOT EXISTS agents (
  id BIGINT PRIMARY KEY,
  owner TEXT NOT NULL,
  signer TEXT NOT NULL,
  vault TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  mandate_hash TEXT,
  allowlist_root TEXT,
  endpoint TEXT,
  metadata_uri TEXT,
  name TEXT,
  description TEXT,
  status INT NOT NULL DEFAULT 1,
  tier INT NOT NULL DEFAULT 0,
  effective_tier INT NOT NULL DEFAULT 0,
  score INT NOT NULL DEFAULT 0,
  valid_until BIGINT NOT NULL DEFAULT 0,
  gauntlet_deadline BIGINT NOT NULL DEFAULT 0,
  daily_limit NUMERIC NOT NULL DEFAULT 0,
  spent_window NUMERIC NOT NULL DEFAULT 0,
  bounty_pool NUMERIC NOT NULL DEFAULT 0,
  locked_bounty NUMERIC NOT NULL DEFAULT 0,
  treasury NUMERIC NOT NULL DEFAULT 0,
  credits INT NOT NULL DEFAULT 0,
  breaches INT NOT NULL DEFAULT 0,
  last_breach_at BIGINT,
  config_changed_at BIGINT,
  registered_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  id BIGINT PRIMARY KEY,
  agent_id BIGINT NOT NULL,
  attacker TEXT NOT NULL,
  opener TEXT NOT NULL,
  tier INT NOT NULL,
  locked NUMERIC NOT NULL,
  fee NUMERIC NOT NULL,
  state INT NOT NULL,
  opened_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  msg_count INT NOT NULL DEFAULT 0,
  transcript_root TEXT,
  payout NUMERIC NOT NULL DEFAULT 0,
  open_tx TEXT,
  breach_tx TEXT,
  close_tx TEXT,
  closed_at BIGINT
);
CREATE INDEX IF NOT EXISTS sessions_agent ON sessions(agent_id);
CREATE INDEX IF NOT EXISTS sessions_attacker ON sessions(attacker);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id BIGINT NOT NULL,
  seq INT NOT NULL,
  role TEXT NOT NULL,
  item JSONB,
  content TEXT NOT NULL,
  decision JSONB,
  tx_hash TEXT,
  error TEXT,
  latency_ms INT,
  ts BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, seq);

CREATE TABLE IF NOT EXISTS exploits (
  id BIGINT PRIMARY KEY,
  session_id BIGINT NOT NULL,
  victim_agent_id BIGINT NOT NULL,
  discoverer TEXT NOT NULL,
  transcript_hash TEXT,
  transcript_uri TEXT,
  fixture_hash TEXT,
  severity INT NOT NULL,
  bonus NUMERIC NOT NULL DEFAULT 0,
  published_at BIGINT NOT NULL,
  tx TEXT
);

CREATE TABLE IF NOT EXISTS gauntlet_results (
  exploit_id BIGINT NOT NULL,
  agent_id BIGINT NOT NULL,
  result TEXT NOT NULL,
  run_hash TEXT,
  tx TEXT,
  ts BIGINT NOT NULL,
  PRIMARY KEY (exploit_id, agent_id)
);

CREATE TABLE IF NOT EXISTS gauntlet_runs (
  id TEXT PRIMARY KEY,
  agent_id BIGINT NOT NULL,
  exploit_id BIGINT NOT NULL,
  config_hash TEXT,
  passed BOOLEAN NOT NULL,
  run_hash TEXT NOT NULL,
  runs JSONB NOT NULL,
  tx TEXT,
  ts BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  agent_id BIGINT NOT NULL,
  kind TEXT NOT NULL,
  to_addr TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  category TEXT,
  ref TEXT,
  escalated BOOLEAN NOT NULL DEFAULT FALSE,
  session_id BIGINT,
  tx TEXT NOT NULL,
  ts BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS payments_agent ON payments(agent_id);

CREATE TABLE IF NOT EXISTS standing_history (
  id TEXT PRIMARY KEY,
  agent_id BIGINT NOT NULL,
  tier INT NOT NULL,
  score INT NOT NULL,
  valid_until BIGINT NOT NULL,
  tx TEXT,
  ts BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS standing_agent ON standing_history(agent_id, ts);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  contract TEXT NOT NULL,
  name TEXT NOT NULL,
  agent_id BIGINT,
  args JSONB NOT NULL,
  block BIGINT NOT NULL,
  log_index INT NOT NULL,
  tx TEXT NOT NULL,
  ts BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_block ON events(block DESC, log_index DESC);

CREATE TABLE IF NOT EXISTS metrics (
  key TEXT PRIMARY KEY,
  value NUMERIC NOT NULL,
  ts BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS chain_cursor (
  name TEXT PRIMARY KEY,
  last_block BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_nonces (
  nonce TEXT PRIMARY KEY,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS attack_memory (
  id TEXT PRIMARY KEY,
  rec JSONB NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
`;
