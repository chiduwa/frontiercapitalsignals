-- Evidence-preserving expansion of the automatic crypto retrospective.
--
-- The broad universe keeps its fixed move threshold.  Pinned favorites may
-- use a lower threshold only when a lagged daily history is deep enough to
-- estimate that asset's own normal range.  Every estimate is append-only so
-- the threshold used for an episode can be audited later.

ALTER TABLE retrospective_misses ADD COLUMN always_tracked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE retrospective_misses ADD COLUMN trigger_threshold_pct REAL;
ALTER TABLE retrospective_misses ADD COLUMN trigger_basis TEXT;
ALTER TABLE retrospective_misses ADD COLUMN baseline_samples INTEGER;
ALTER TABLE retrospective_misses ADD COLUMN baseline_fit_through TEXT;
ALTER TABLE retrospective_misses ADD COLUMN feature_cutoff_at TEXT;

CREATE TABLE IF NOT EXISTS retrospective_asset_baselines (
  computed_at TEXT NOT NULL,
  asset_class TEXT NOT NULL,
  symbol TEXT NOT NULL,
  fit_through TEXT,
  samples INTEGER NOT NULL,
  abs_return_p80_pct REAL,
  daily_range_p50_pct REAL,
  realized_volatility_pct REAL,
  candidate_threshold_pct REAL,
  effective_threshold_pct REAL NOT NULL,
  global_threshold_pct REAL NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('adaptive', 'global', 'insufficient')),
  method_version TEXT NOT NULL,
  PRIMARY KEY (computed_at, asset_class, symbol),
  CHECK (samples >= 0),
  CHECK (effective_threshold_pct > 0),
  CHECK (global_threshold_pct > 0)
);

CREATE INDEX IF NOT EXISTS idx_retrospective_asset_baselines_latest
  ON retrospective_asset_baselines(asset_class, symbol, computed_at DESC);

-- Frozen, point-in-time technique state immediately before the move window.
-- `aligned` is descriptive: these rows were selected after a large outcome
-- was observed, so neither this table nor its aggregates are live signals.
CREATE TABLE IF NOT EXISTS retrospective_feature_snapshots (
  run_at TEXT NOT NULL,
  asset_class TEXT NOT NULL,
  symbol TEXT NOT NULL,
  feature_cutoff_at TEXT NOT NULL,
  source_run_at TEXT NOT NULL,
  technique_id TEXT NOT NULL,
  technique_dir INTEGER NOT NULL CHECK (technique_dir IN (-1, 1)),
  technique_score REAL,
  move_pct REAL NOT NULL,
  move_dir INTEGER NOT NULL CHECK (move_dir IN (-1, 1)),
  aligned INTEGER NOT NULL CHECK (aligned IN (0, 1)),
  regime TEXT NOT NULL,
  time_bucket TEXT NOT NULL,
  source_lag_hours REAL NOT NULL CHECK (source_lag_hours >= 0),
  method_version TEXT NOT NULL,
  PRIMARY KEY (run_at, asset_class, symbol, technique_id, method_version),
  CHECK (source_run_at < feature_cutoff_at)
);

CREATE INDEX IF NOT EXISTS idx_retrospective_feature_snapshots_cell
  ON retrospective_feature_snapshots(asset_class, symbol, technique_id, regime, time_bucket, run_at);

-- Outcome-conditioned hypothesis ledger.  Even a multiple-testing-adjusted
-- notable cell remains `notable-retrospective-only`; live promotion requires
-- a separate forward, all-trigger study that includes non-events.
CREATE TABLE IF NOT EXISTS retrospective_feature_correlations (
  asset_class TEXT NOT NULL,
  symbol TEXT NOT NULL,
  technique_id TEXT NOT NULL,
  regime TEXT NOT NULL,
  time_bucket TEXT NOT NULL,
  n INTEGER NOT NULL,
  independent_dates INTEGER NOT NULL,
  alignment_rate REAL,
  correlation REAL,
  fisher_z REAL,
  first_half_correlation REAL,
  second_half_correlation REAL,
  tests_in_family INTEGER NOT NULL,
  corrected_z_threshold REAL,
  status TEXT NOT NULL CHECK (status IN ('insufficient', 'descriptive-only', 'notable-retrospective-only')),
  live_edge_eligible INTEGER NOT NULL DEFAULT 0 CHECK (live_edge_eligible = 0),
  updated_at TEXT NOT NULL,
  method_version TEXT NOT NULL,
  PRIMARY KEY (asset_class, symbol, technique_id, regime, time_bucket, method_version),
  CHECK (n >= 0),
  CHECK (independent_dates >= 0),
  CHECK (tests_in_family >= 1)
);
