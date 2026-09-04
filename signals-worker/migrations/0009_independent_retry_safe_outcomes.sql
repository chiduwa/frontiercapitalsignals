-- Accuracy was previously updated from every hourly forecast even when the
-- scored windows overlapped. A 24-hour call repeated hourly therefore looked
-- like 24 independent trials, and a 168-hour call could look like 168. That
-- invalidates Wilson bounds, significance tests, calibration, and any alert
-- that cites the resulting sample count.
--
-- This append-only ledger is the idempotency boundary for the corrected loop:
-- only non-overlapping forecasts enter it, and each ledger row is folded into
-- aggregates together with `aggregated = 1` in one D1 batch transaction.
-- Retried jobs can neither double-count a committed outcome nor lose one after
-- a partial aggregate update.
CREATE TABLE IF NOT EXISTS forecast_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_at TEXT NOT NULL,
  asset_class TEXT NOT NULL,
  symbol TEXT NOT NULL,
  horizon_minutes INTEGER NOT NULL,
  series_kind TEXT NOT NULL CHECK (series_kind IN ('technique', 'combo', 'market', 'range', 'intraday')),
  series_key TEXT NOT NULL,
  dir INTEGER,
  actual_dir INTEGER,
  correct INTEGER NOT NULL CHECK (correct IN (0, 1)),
  score REAL,
  regime TEXT,
  return_pct REAL,
  evaluated_at TEXT NOT NULL,
  aggregated INTEGER NOT NULL DEFAULT 0 CHECK (aggregated IN (-1, 0, 1)),
  CHECK (horizon_minutes > 0),
  CHECK (dir IS NULL OR dir IN (-1, 0, 1)),
  CHECK (actual_dir IS NULL OR actual_dir IN (-1, 0, 1))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_forecast_outcomes_unique
  ON forecast_outcomes(run_at, asset_class, symbol, horizon_minutes, series_kind, series_key);
CREATE INDEX IF NOT EXISTS idx_forecast_outcomes_latest
  ON forecast_outcomes(asset_class, symbol, horizon_minutes, series_kind, series_key, run_at DESC);
CREATE INDEX IF NOT EXISTS idx_forecast_outcomes_pending
  ON forecast_outcomes(aggregated, id) WHERE aggregated = 0;

-- All of these aggregates inherited the overlapping-trial defect and must
-- relearn from the independent ledger. Raw forecasts, raw prices, daily/hourly
-- bars, research findings, and paper trades are deliberately retained.
DELETE FROM technique_reliability;
DELETE FROM technique_regime_reliability;
DELETE FROM technique_combo_reliability;
DELETE FROM range_reliability;
DELETE FROM asset_move_stats;
DELETE FROM score_calibration;
DELETE FROM score_calibration_detail;
DELETE FROM direction_baseline;
DELETE FROM asset_score_snapshots;
DELETE FROM intraday_reliability;
-- These behavioral tables were also bootstrapped additively from the same
-- historical window on every retry (especially equities, whose 7-session
-- bars could never pass the old 12-bars/day swing gate). Rebuild once with
-- the asset-aware, atomic replacement path.
DELETE FROM time_of_day_stats;
DELETE FROM swing_time_stats;

-- Re-running this reset must be able to reconstruct every derived aggregate
-- from the retained ledger. Leaving rows at aggregated=1 would wipe the
-- counters permanently while preventing their outcomes from being replayed.
UPDATE forecast_outcomes SET aggregated = 0;

-- Reconsider any still-retained raw rows under the corrected independence
-- rule. Rows too close to an accepted forecast are marked evaluated without
-- entering the ledger; rows without an exact target-time price remain pending.
UPDATE technique_votes SET evaluated_24 = 0, evaluated_168 = 0;
UPDATE intraday_signal_log SET evaluated = 0;
