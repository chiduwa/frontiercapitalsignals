-- Research capsules and reports only. Never used as live authorization.
-- Source intents, original prices and account journals are never modified.
CREATE TABLE IF NOT EXISTS policy_history_events (
  event_id TEXT PRIMARY KEY,
  method_version TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  asset_class TEXT NOT NULL,
  source TEXT NOT NULL,
  side TEXT NOT NULL CHECK(side IN ('BUY','SELL')),
  horizon_hours INTEGER NOT NULL CHECK(horizon_hours IN (1,6,24)),
  reference_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('ready','unavailable')),
  reason TEXT,
  attempts INTEGER NOT NULL DEFAULT 1,
  retry_after INTEGER,
  updated_at TEXT NOT NULL,
  event_gzip_base64 TEXT,
  archive_bytes INTEGER NOT NULL DEFAULT 0,
  live_eligible INTEGER NOT NULL DEFAULT 0 CHECK(live_eligible=0),
  UNIQUE(method_version, intent_id, horizon_hours)
);
CREATE INDEX IF NOT EXISTS idx_policy_history_ready
  ON policy_history_events(method_version,status,reference_at);

CREATE TABLE IF NOT EXISTS policy_history_reports (
  method_version TEXT PRIMARY KEY,
  updated_at TEXT NOT NULL,
  report_json TEXT NOT NULL,
  live_eligible INTEGER NOT NULL DEFAULT 0 CHECK(live_eligible=0)
);

CREATE TABLE IF NOT EXISTS policy_history_runs (
  run_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  status TEXT NOT NULL,
  attempted INTEGER NOT NULL,
  archived INTEGER NOT NULL,
  unavailable INTEGER NOT NULL,
  api_requests INTEGER NOT NULL,
  archive_bytes INTEGER NOT NULL,
  details_json TEXT NOT NULL
);
