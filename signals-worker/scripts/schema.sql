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

-- Realized move size per asset per horizon (mean/stdev via running sum and
-- sum-of-squares), independent of any technique — a fixed aggregate keyed
-- by (symbol, horizon), not append-only, so it doesn't need pruning.
CREATE TABLE IF NOT EXISTS asset_move_stats (
  symbol TEXT NOT NULL,
  horizon_hours INTEGER NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  sum_pct REAL NOT NULL DEFAULT 0,
  sum_pct_sq REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (symbol, horizon_hours)
);

-- The predicted [low, high] band for every asset, logged every run at two
-- fixed horizons (24h and 168h, matching HORIZONS_HOURS in reliability.mjs)
-- regardless of which horizon the dashboard happens to display that hour —
-- so scoring is always an apples-to-apples 1-day-band-vs-1-day-later and
-- 7-day-band-vs-7-day-later comparison. Unlike technique_votes, each row
-- only ever matures once (its own horizon_hours), so there's no
-- evaluated_* flag: a row is scored then deleted in the same pass.
CREATE TABLE IF NOT EXISTS range_log (
  run_at TEXT NOT NULL,
  asset_class TEXT NOT NULL,
  symbol TEXT NOT NULL,
  horizon_hours INTEGER NOT NULL,
  low REAL NOT NULL,
  high REAL NOT NULL,
  PRIMARY KEY (run_at, symbol, horizon_hours)
);

-- Hit rate for range_log: was the realized price at maturity actually
-- inside the predicted band, not just on the right side of it. Mirrors
-- technique_reliability's shape (hits/total/accuracy instead of
-- correct/total/accuracy, since "hit" here means band containment, not
-- directional agreement).
CREATE TABLE IF NOT EXISTS range_reliability (
  asset_class TEXT NOT NULL,
  symbol TEXT NOT NULL,
  horizon_hours INTEGER NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  accuracy REAL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (symbol, horizon_hours)
);
