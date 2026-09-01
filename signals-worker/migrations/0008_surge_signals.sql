-- Forward surge scanning (scripts/live-scan.mjs). User-requested
-- 2026-09-01: notify before the move, not after it.
--
-- The measurement behind these tables matters more than their shape, so
-- it is recorded here too. Over 176K hourly observations across 200
-- Binance-global symbols, mean forward 24h return falls MONOTONICALLY as
-- a volume spike grows: +0.28% at 2.5x, -0.17% at 5x, -1.69% at 12x,
-- -2.88% at 20x, against a +0.33% all-bar baseline. A volume spike into a
-- rising bar is an exhaustion marker, not an entry. Two cohorts looked
-- profitable pooled and both failed the chronological-half split that
-- research_registry (migration 0006) exists to enforce.
--
-- So surge_signal_log is not a list of trade ideas. It is the evidence
-- base that decides which configurations are ever ALLOWED to become trade
-- ideas: every configuration is cast and scored on live forward data,
-- proven or not, and an unproven one stays silent until its own record
-- clears a coin flip on a Wilson lower bound over at least 30 scored
-- casts. A candidate earns the right to interrupt; it is not granted it
-- because a backtest liked it.
--
-- Idempotent by construction: CREATE TABLE IF NOT EXISTS only.

CREATE TABLE IF NOT EXISTS surge_signal_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  config_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  -- What the configuration PREDICTED, which is not what the bar did:
  -- exhaustion fires on a rising bar and predicts weakness.
  dir INTEGER NOT NULL,
  -- The closed bar the cast was made on, never the forming one.
  cast_at TEXT NOT NULL,
  entry_price REAL NOT NULL,
  horizon_hours INTEGER NOT NULL,
  ratio REAL,
  trade_ratio REAL,
  bar_pct REAL,
  liquidity REAL,
  -- NULL until the horizon elapses. 'correct' | 'wrong' | 'flat', where
  -- flat means the market never moved past the deadband either way and
  -- so does not credit whichever side happened to be called.
  outcome TEXT,
  exit_price REAL,
  move_pct REAL,
  scored_at TEXT,
  notified INTEGER NOT NULL DEFAULT 0,
  UNIQUE (config_id, symbol, cast_at)
);

CREATE INDEX IF NOT EXISTS idx_surge_log_open ON surge_signal_log(outcome, cast_at);
CREATE INDEX IF NOT EXISTS idx_surge_log_config ON surge_signal_log(config_id, outcome);

-- One row per configuration: its live, forward-tested standing and
-- whether it is currently permitted to notify. Recomputed each run from
-- surge_signal_log, so it can never drift from the evidence.
CREATE TABLE IF NOT EXISTS surge_config_status (
  config_id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  dir INTEGER NOT NULL,
  horizon_hours INTEGER NOT NULL,
  -- Cleared significance AND held its sign in both chronological halves
  -- at discovery. Only exhaustion20 did.
  proven_at_discovery INTEGER NOT NULL DEFAULT 0,
  correct INTEGER NOT NULL DEFAULT 0,
  wrong INTEGER NOT NULL DEFAULT 0,
  flat INTEGER NOT NULL DEFAULT 0,
  -- correct + wrong: flat casts are excluded from accuracy rather than
  -- counted against it, since a market that did not move tested nothing.
  decided INTEGER NOT NULL DEFAULT 0,
  accuracy REAL,
  lower_bound REAL,
  avg_move_pct REAL,
  notifying INTEGER NOT NULL DEFAULT 0,
  status_note TEXT,
  updated_at TEXT NOT NULL
);
