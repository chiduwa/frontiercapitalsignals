-- Per-asset model tournament (scripts/model-tournament.py, model-tournament-v1).
--
-- model_forecasts is the forward ledger: every candidate model's forecast for
-- each asset, written once, BEFORE its outcome exists, and scored later in
-- place. It is the only evidence a challenger can be promoted on -- history
-- may rank candidates, it may not crown them. Never backfill it: a forecast
-- reconstructed after the fact is not a forecast.
CREATE TABLE IF NOT EXISTS model_forecasts (
  model_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  target TEXT NOT NULL CHECK (target IN ('direction', 'magnitude', 'timing')),
  horizon INTEGER NOT NULL,
  as_of TEXT NOT NULL,
  target_date TEXT NOT NULL,
  forecast_json TEXT NOT NULL CHECK (json_valid(forecast_json)),
  issued_at TEXT NOT NULL,
  code_version TEXT NOT NULL,
  input_hash TEXT,
  outcome_json TEXT CHECK (outcome_json IS NULL OR json_valid(outcome_json)),
  loss REAL,
  scored_at TEXT,
  PRIMARY KEY (model_id, symbol, horizon, as_of)
);
CREATE INDEX IF NOT EXISTS idx_model_forecasts_unscored ON model_forecasts(loss, as_of);
CREATE INDEX IF NOT EXISTS idx_model_forecasts_symbol ON model_forecasts(symbol, target, horizon, as_of);

-- One row per model per slot (symbol or '*' for the pooled slot, horizon).
-- status: benchmark (production's method), challenger, champion, retired.
-- alpha_index orders the challengers of a slot for alpha spending; epoch_start
-- is the first forecast date that counts against the current incumbent.
CREATE TABLE IF NOT EXISTS model_registry (
  model_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  target TEXT NOT NULL,
  horizon INTEGER NOT NULL,
  spec_json TEXT NOT NULL CHECK (json_valid(spec_json)),
  status TEXT NOT NULL CHECK (status IN ('benchmark', 'challenger', 'champion', 'retired')),
  alpha_index INTEGER,
  admitted_at TEXT NOT NULL,
  epoch_start TEXT NOT NULL,
  incumbent_id TEXT,
  status_changed_at TEXT NOT NULL,
  e_value REAL,
  e_worse REAL,
  forward_n INTEGER NOT NULL DEFAULT 0,
  forward_mean_diff REAL,
  backtest_json TEXT CHECK (backtest_json IS NULL OR json_valid(backtest_json)),
  reason TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (model_id, symbol, horizon)
);
CREATE INDEX IF NOT EXISTS idx_model_registry_status ON model_registry(status, target, symbol);

-- Append-only: every admission, promotion, demotion and retirement, so the
-- tournament's decisions can be audited after the fact.
CREATE TABLE IF NOT EXISTS model_registry_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  horizon INTEGER NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  at TEXT NOT NULL,
  reason TEXT,
  e_value REAL,
  forward_n INTEGER
);
CREATE INDEX IF NOT EXISTS idx_model_registry_history ON model_registry_history(model_id, symbol, at DESC);
-- A re-run import adds nothing: one row per transition.
CREATE UNIQUE INDEX IF NOT EXISTS idx_model_registry_history_once
  ON model_registry_history(model_id, symbol, horizon, at, to_status);

-- The run summary build-signals reads (champions, challengers' progress,
-- per-asset input weights). The run row lands after everything else.
CREATE TABLE IF NOT EXISTS model_tournament_runs (
  run_id TEXT PRIMARY KEY,
  model_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  as_of TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  summary_json TEXT NOT NULL CHECK (json_valid(summary_json))
);
CREATE INDEX IF NOT EXISTS idx_model_tournament_latest ON model_tournament_runs(model_version, created_at DESC);
