-- Prospective, point-in-time seasonal lead/lag research for the retrospective.
--
-- The mover-only miss ledger is deliberately outcome-conditioned and cannot
-- estimate prediction accuracy. This companion lane records every eligible
-- daily outcome once, alongside compact predictor frames that existed before
-- the outcome window. Raw daily rows remain small; candidate expansion and
-- statistical testing happen in the Node retrospective job.
--
-- No row in this migration is a live signal. Even a replicated candidate must
-- later pass the project's dedicated after-cost promotion path before any
-- production weight can consume it. The CHECK below makes accidental direct
-- activation structurally impossible.

CREATE TABLE IF NOT EXISTS retrospective_lead_lag_daily (
  observation_date TEXT NOT NULL,
  run_at TEXT NOT NULL,
  window_start_at TEXT NOT NULL,
  window_end_at TEXT NOT NULL,
  outcome_provider TEXT NOT NULL,
  outcomes_json TEXT NOT NULL CHECK (json_valid(outcomes_json)),
  predictors_json TEXT NOT NULL CHECK (json_valid(predictors_json)),
  method_version TEXT NOT NULL,
  PRIMARY KEY (observation_date, method_version),
  CHECK (window_start_at < window_end_at),
  CHECK (run_at = window_end_at)
);

CREATE INDEX IF NOT EXISTS idx_retrospective_lead_lag_daily_window
  ON retrospective_lead_lag_daily(method_version, observation_date);

CREATE TABLE IF NOT EXISTS retrospective_seasonal_lead_lag (
  asset_class TEXT NOT NULL,
  target_symbol TEXT NOT NULL,
  feature_kind TEXT NOT NULL,
  source_symbol TEXT NOT NULL,
  feature_id TEXT NOT NULL,
  indicator_role TEXT NOT NULL,
  -- Requested separation between predictor anchor and outcome-window start.
  -- mean_actual_lead_hours also includes observed source staleness.
  lag_hours REAL NOT NULL CHECK (lag_hours >= 0),
  context_type TEXT NOT NULL,
  context_value TEXT NOT NULL,
  n INTEGER NOT NULL CHECK (n >= 0),
  correlation REAL,
  hac_z REAL,
  mean_actual_lead_hours REAL,
  discovery_n INTEGER NOT NULL DEFAULT 0 CHECK (discovery_n >= 0),
  discovery_correlation REAL,
  discovery_hac_z REAL,
  holdout_n INTEGER NOT NULL DEFAULT 0 CHECK (holdout_n >= 0),
  holdout_correlation REAL,
  holdout_hac_z REAL,
  discovery_tests_in_family INTEGER,
  corrected_z_threshold REAL,
  family_alpha_spent REAL,
  next_checkpoint_n INTEGER,
  walk_forward_verdict TEXT NOT NULL
    CHECK (walk_forward_verdict IN ('insufficient', 'passed', 'failed')),
  walk_forward_folds INTEGER NOT NULL DEFAULT 0 CHECK (walk_forward_folds >= 0),
  walk_forward_positive_folds INTEGER NOT NULL DEFAULT 0
    CHECK (walk_forward_positive_folds >= 0),
  discovered_at TEXT,
  discovery_fit_through TEXT,
  oos_n INTEGER NOT NULL DEFAULT 0 CHECK (oos_n >= 0),
  oos_correlation REAL,
  oos_hac_z REAL,
  oos_tests_in_family INTEGER,
  oos_corrected_z_threshold REAL,
  oos_alpha_spent REAL,
  oos_next_checkpoint_n INTEGER,
  status TEXT NOT NULL CHECK (status IN (
    'insufficient',
    'descriptive-only',
    'provisional-research-only',
    'replicated-research-only',
    'decayed-research-only'
  )),
  live_edge_eligible INTEGER NOT NULL DEFAULT 0 CHECK (live_edge_eligible = 0),
  updated_at TEXT NOT NULL,
  method_version TEXT NOT NULL,
  PRIMARY KEY (
    asset_class, target_symbol, feature_kind, source_symbol, feature_id,
    lag_hours, context_type, context_value, method_version
  ),
  CHECK (discovery_tests_in_family IS NULL OR discovery_tests_in_family >= 1),
  CHECK (family_alpha_spent IS NULL OR (family_alpha_spent > 0 AND family_alpha_spent < 1)),
  CHECK (next_checkpoint_n IS NULL OR next_checkpoint_n > 0),
  CHECK (oos_tests_in_family IS NULL OR oos_tests_in_family >= 1),
  CHECK (oos_alpha_spent IS NULL OR (oos_alpha_spent > 0 AND oos_alpha_spent < 1)),
  CHECK (oos_next_checkpoint_n IS NULL OR oos_next_checkpoint_n > 0),
  CHECK (mean_actual_lead_hours IS NULL OR mean_actual_lead_hours >= lag_hours),
  CHECK ((discovered_at IS NULL AND discovery_fit_through IS NULL)
      OR (discovered_at IS NOT NULL AND discovery_fit_through IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_retrospective_seasonal_lead_lag_status
  ON retrospective_seasonal_lead_lag(status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_retrospective_seasonal_lead_lag_target
  ON retrospective_seasonal_lead_lag(target_symbol, context_type, context_value,
                                     lag_hours, updated_at DESC);
