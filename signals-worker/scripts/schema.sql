-- Reliability-learning schema for the confluence engine. Applied once via:
--   npx wrangler d1 execute frontier-capital-signals-reliability --file=scripts/schema.sql --remote
-- Idempotent (IF NOT EXISTS) so re-running it is harmless.

CREATE TABLE IF NOT EXISTS asset_price_log (
  run_at TEXT NOT NULL,
  asset_class TEXT NOT NULL,
  symbol TEXT NOT NULL,
  price REAL NOT NULL,
  PRIMARY KEY (run_at, symbol)
);

CREATE TABLE IF NOT EXISTS technique_votes (
  run_at TEXT NOT NULL,
  asset_class TEXT NOT NULL,
  symbol TEXT NOT NULL,
  technique_id TEXT NOT NULL,
  dir INTEGER NOT NULL,
  evaluated_24 INTEGER NOT NULL DEFAULT 0,
  evaluated_168 INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_at, symbol, technique_id)
);

CREATE TABLE IF NOT EXISTS technique_reliability (
  asset_class TEXT NOT NULL,
  symbol TEXT NOT NULL,
  technique_id TEXT NOT NULL,
  horizon_hours INTEGER NOT NULL,
  correct INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  accuracy REAL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (symbol, technique_id, horizon_hours)
);

CREATE INDEX IF NOT EXISTS idx_technique_votes_run_at ON technique_votes(run_at);
