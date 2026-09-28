-- Decoupling watch (scripts/decoupling-watch.mjs, decoupling-watch-v1): a
-- large coin pulling away from (or falling away from) the market on unusual
-- volume, logged at the close of the hour it appears, BEFORE the 24 hours it
-- is judged on, and scored in place afterwards against the same 24 hours'
-- share of every coin in the universe that moved that far from the market.
-- Never backfill it. docs/DECOUPLING.md has the evidence.
CREATE TABLE IF NOT EXISTS decoupling_watch (
  model_version TEXT NOT NULL,
  symbol TEXT NOT NULL,
  cast_at TEXT NOT NULL,              -- the hour's open, UTC ISO; the setup is read at its close
  side INTEGER NOT NULL CHECK (side IN (-1, 1)),
  close REAL NOT NULL,
  volume_ratio REAL NOT NULL,
  rel_volume REAL NOT NULL,           -- volume_ratio over the median coin's, same hour
  excess_z REAL NOT NULL,
  excess_pct REAL NOT NULL,
  market_pct REAL NOT NULL,
  beta REAL,
  threshold REAL NOT NULL,            -- log move that counts as big for this coin
  oi_change_pct REAL,                 -- 8h change in contracts, when the sampler covers the coin
  notified INTEGER NOT NULL DEFAULT 0 CHECK (notified IN (0, 1)),
  created_at TEXT NOT NULL,
  outcome_excess_pct REAL,
  big INTEGER CHECK (big IS NULL OR big IN (0, 1)),
  base_rate REAL,
  market_n INTEGER,
  scored_at TEXT,
  PRIMARY KEY (model_version, symbol, cast_at)
);
CREATE INDEX IF NOT EXISTS idx_decoupling_watch_open ON decoupling_watch(model_version, scored_at, cast_at);
CREATE INDEX IF NOT EXISTS idx_decoupling_watch_recent ON decoupling_watch(model_version, cast_at DESC);

-- One row per hourly run: proof the watch is alive even on hours with no setup.
CREATE TABLE IF NOT EXISTS decoupling_watch_runs (
  run_at TEXT PRIMARY KEY,
  model_version TEXT NOT NULL,
  evaluated INTEGER NOT NULL,
  setups INTEGER NOT NULL,
  notified INTEGER NOT NULL
);
