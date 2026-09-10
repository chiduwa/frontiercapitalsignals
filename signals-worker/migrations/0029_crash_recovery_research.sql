-- Research-only, point-in-time crash-threshold cohort.
--
-- Scope is intentionally narrow: this records first crossings below a
-- predeclared drawdown threshold and what happened afterwards. It does NOT
-- identify a bottom, predict a reversal, establish a cause, or represent the
-- full historical market. The source is the bounded, currently archived
-- asset_daily_bars universe, which can omit delisted assets and therefore has
-- survivorship/coverage censoring. Hindsight lows and return milestones are
-- outcome diagnostics only and are never model inputs.
--
-- Nothing in this schema is wired to research_registry, learned weights,
-- published signals, alerts, or orders. Every live_edge_eligible field is
-- hard-locked to zero.

CREATE TABLE IF NOT EXISTS crash_recovery_runs (
  run_id TEXT PRIMARY KEY,
  method_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'resource-capped', 'failed')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  universe_scope TEXT NOT NULL DEFAULT 'bounded-current-archive-no-delisted-guarantee'
    CHECK (universe_scope = 'bounded-current-archive-no-delisted-guarantee'),
  symbols_considered INTEGER NOT NULL DEFAULT 0 CHECK (symbols_considered >= 0),
  symbols_processed INTEGER NOT NULL DEFAULT 0 CHECK (symbols_processed >= 0),
  symbols_deferred INTEGER NOT NULL DEFAULT 0 CHECK (symbols_deferred >= 0),
  bars_read INTEGER NOT NULL DEFAULT 0 CHECK (bars_read >= 0),
  episodes_seen INTEGER NOT NULL DEFAULT 0 CHECK (episodes_seen >= 0),
  outcomes_pending INTEGER NOT NULL DEFAULT 0 CHECK (outcomes_pending >= 0),
  outcomes_matured INTEGER NOT NULL DEFAULT 0 CHECK (outcomes_matured >= 0),
  error_summary TEXT,
  live_edge_eligible INTEGER NOT NULL DEFAULT 0 CHECK (live_edge_eligible = 0)
);

CREATE INDEX IF NOT EXISTS idx_crash_recovery_runs_started
  ON crash_recovery_runs(started_at DESC);

CREATE TABLE IF NOT EXISTS crash_recovery_checkpoints (
  asset_class TEXT NOT NULL CHECK (asset_class IN ('crypto', 'stock')),
  symbol TEXT NOT NULL,
  method_version TEXT NOT NULL,
  -- Last bar fully examined for a threshold crossing. A resource-deferred
  -- publication lookup or truncated bar query must never advance this cursor
  -- through the deferred event/range.
  last_scanned_signal_date TEXT NOT NULL,
  -- Frozen on the first successfully processed slice. Rows dated on/before
  -- this boundary are bootstrap; only later rows are prospective.
  bootstrap_through_date TEXT NOT NULL,
  cohort_id TEXT NOT NULL,
  source_max_date TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (asset_class, symbol, method_version),
  CHECK (last_scanned_signal_date <= source_max_date),
  CHECK (bootstrap_through_date <= source_max_date)
);

CREATE INDEX IF NOT EXISTS idx_crash_recovery_checkpoints_rotation
  ON crash_recovery_checkpoints(method_version, updated_at, asset_class, symbol);

CREATE TABLE IF NOT EXISTS crash_recovery_episodes (
  asset_class TEXT NOT NULL CHECK (asset_class IN ('crypto', 'stock')),
  symbol TEXT NOT NULL,
  signal_date TEXT NOT NULL,
  method_version TEXT NOT NULL,
  -- The crossing is knowable only after signal_date's close. The later bar
  -- close is a reproducible research reference, not a claimed executable fill.
  eligible_at TEXT,
  feature_cutoff_date TEXT NOT NULL,
  signal_close REAL NOT NULL CHECK (signal_close > 0),
  reference_entry_close REAL CHECK (reference_entry_close IS NULL OR reference_entry_close > 0),
  signal_source TEXT,
  entry_source TEXT,
  threshold_pct REAL NOT NULL CHECK (threshold_pct < 0),
  peak_lookback_sessions INTEGER NOT NULL CHECK (peak_lookback_sessions > 0),
  trailing_peak_close REAL NOT NULL CHECK (trailing_peak_close > 0),
  drawdown_pct REAL NOT NULL CHECK (drawdown_pct <= threshold_pct),
  peak_age_sessions INTEGER NOT NULL CHECK (peak_age_sessions >= 1),
  trailing_return_20_pct REAL,
  realized_vol_20_pct REAL CHECK (realized_vol_20_pct IS NULL OR realized_vol_20_pct >= 0),
  volume_ratio_20 REAL CHECK (volume_ratio_20 IS NULL OR volume_ratio_20 >= 0),
  distance_sma_200_pct REAL,
  benchmark_symbol TEXT,
  benchmark_return_20_pct REAL,
  relative_strength_20_pct REAL,
  benchmark_regime TEXT CHECK (benchmark_regime IS NULL OR benchmark_regime IN ('up', 'down', 'flat')),
  depth_bucket TEXT NOT NULL CHECK (depth_bucket IN ('30-to-40', '40-to-55', '55-plus')),
  evidence_partition TEXT NOT NULL CHECK (evidence_partition IN ('bootstrap', 'prospective')),
  cohort_id TEXT NOT NULL,
  -- Exact post-sanitizer board snapshot strictly before the signal UTC day.
  publication_snapshot_at TEXT,
  publication_state TEXT NOT NULL CHECK (publication_state IN (
    'published', 'conflicted', 'withheld', 'not-surfaced', 'not-in-universe', 'unavailable'
  )),
  published_direction INTEGER CHECK (published_direction IN (-1, 1)),
  published_score REAL,
  publication_call_usable INTEGER CHECK (publication_call_usable IN (0, 1)),
  publication_alignment_reason TEXT NOT NULL,
  first_recorded_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  scope_label TEXT NOT NULL DEFAULT 'crash-threshold-crossing-not-bottom-or-cause'
    CHECK (scope_label = 'crash-threshold-crossing-not-bottom-or-cause'),
  association_label TEXT NOT NULL DEFAULT 'association-not-causal'
    CHECK (association_label = 'association-not-causal'),
  live_edge_eligible INTEGER NOT NULL DEFAULT 0 CHECK (live_edge_eligible = 0),
  PRIMARY KEY (asset_class, symbol, signal_date, method_version),
  CHECK (feature_cutoff_date = signal_date),
  CHECK (eligible_at IS NULL OR eligible_at > signal_date),
  CHECK ((eligible_at IS NULL AND reference_entry_close IS NULL)
      OR (eligible_at IS NOT NULL AND reference_entry_close IS NOT NULL)),
  CHECK ((publication_state = 'published'
          AND published_direction IS NOT NULL AND publication_call_usable = 1)
      OR (publication_state <> 'published'
          AND published_direction IS NULL
          AND (publication_call_usable = 0 OR publication_call_usable IS NULL)))
);

CREATE INDEX IF NOT EXISTS idx_crash_recovery_episode_partition
  ON crash_recovery_episodes(method_version, asset_class, evidence_partition, signal_date);

-- Separate predeclared clocks avoid treating 252 US sessions as equivalent to
-- 252 continuously traded crypto days. Crypto uses 365/730 daily bars; stocks
-- use 252/504 observed sessions. Recent incomplete paths stay pending.
CREATE TABLE IF NOT EXISTS crash_recovery_outcomes (
  asset_class TEXT NOT NULL CHECK (asset_class IN ('crypto', 'stock')),
  symbol TEXT NOT NULL,
  signal_date TEXT NOT NULL,
  method_version TEXT NOT NULL,
  horizon_sessions INTEGER NOT NULL,
  outcome_status TEXT NOT NULL CHECK (outcome_status IN ('pending', 'matured')),
  observed_forward_sessions INTEGER NOT NULL DEFAULT 0 CHECK (observed_forward_sessions >= 0),
  outcome_label TEXT CHECK (outcome_label IN ('recovered-prior-peak', 'failed-recovery')),
  recovered_prior_peak INTEGER CHECK (recovered_prior_peak IN (0, 1)),
  sessions_to_recovery INTEGER CHECK (sessions_to_recovery IS NULL OR sessions_to_recovery >= 0),
  first_2x_sessions INTEGER CHECK (first_2x_sessions IS NULL OR first_2x_sessions >= 1),
  first_5x_sessions INTEGER CHECK (first_5x_sessions IS NULL OR first_5x_sessions >= 1),
  first_10x_sessions INTEGER CHECK (first_10x_sessions IS NULL OR first_10x_sessions >= 1),
  first_20x_sessions INTEGER CHECK (first_20x_sessions IS NULL OR first_20x_sessions >= 1),
  forward_terminal_return_pct REAL,
  forward_max_return_pct REAL,
  forward_max_adverse_pct REAL,
  -- Outcome-only hindsight diagnostic. It cannot be used as an entry feature.
  hindsight_low_close REAL CHECK (hindsight_low_close IS NULL OR hindsight_low_close > 0),
  hindsight_low_date TEXT,
  sessions_to_hindsight_low INTEGER CHECK (sessions_to_hindsight_low IS NULL OR sessions_to_hindsight_low >= 0),
  matured_at TEXT,
  first_recorded_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  outcome_only_label TEXT NOT NULL DEFAULT 'future-path-label-not-model-input'
    CHECK (outcome_only_label = 'future-path-label-not-model-input'),
  live_edge_eligible INTEGER NOT NULL DEFAULT 0 CHECK (live_edge_eligible = 0),
  PRIMARY KEY (asset_class, symbol, signal_date, method_version, horizon_sessions),
  FOREIGN KEY (asset_class, symbol, signal_date, method_version)
    REFERENCES crash_recovery_episodes(asset_class, symbol, signal_date, method_version)
    ON DELETE CASCADE,
  CHECK ((asset_class = 'crypto' AND horizon_sessions IN (365, 730))
      OR (asset_class = 'stock' AND horizon_sessions IN (252, 504))),
  CHECK ((first_5x_sessions IS NULL OR first_2x_sessions IS NOT NULL)
      AND (first_10x_sessions IS NULL OR first_5x_sessions IS NOT NULL)
      AND (first_20x_sessions IS NULL OR first_10x_sessions IS NOT NULL)),
  CHECK (
    (outcome_status = 'pending'
      AND observed_forward_sessions < horizon_sessions
      AND outcome_label IS NULL AND recovered_prior_peak IS NULL
      AND sessions_to_recovery IS NULL
      AND first_2x_sessions IS NULL AND first_5x_sessions IS NULL
      AND first_10x_sessions IS NULL AND first_20x_sessions IS NULL
      AND forward_terminal_return_pct IS NULL AND forward_max_return_pct IS NULL
      AND forward_max_adverse_pct IS NULL AND hindsight_low_close IS NULL
      AND hindsight_low_date IS NULL AND sessions_to_hindsight_low IS NULL
      AND matured_at IS NULL)
    OR
    (outcome_status = 'matured'
      AND observed_forward_sessions = horizon_sessions
      AND outcome_label IS NOT NULL AND recovered_prior_peak IS NOT NULL
      AND forward_terminal_return_pct IS NOT NULL
      AND forward_max_return_pct IS NOT NULL
      AND forward_max_adverse_pct IS NOT NULL
      AND hindsight_low_close IS NOT NULL AND hindsight_low_date IS NOT NULL
      AND sessions_to_hindsight_low IS NOT NULL AND matured_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_crash_recovery_outcomes_pending
  ON crash_recovery_outcomes(method_version, asset_class, symbol, signal_date, horizon_sessions)
  WHERE outcome_status = 'pending';

CREATE INDEX IF NOT EXISTS idx_crash_recovery_outcomes_matured
  ON crash_recovery_outcomes(method_version, asset_class, horizon_sessions, signal_date)
  WHERE outcome_status = 'matured';

-- Raw descriptive rates only. Events from one symbol and overlapping horizons
-- are dependent, so an iid binomial/Wilson confidence interval would overstate
-- certainty. Unique symbol/cohort counts expose the effective breadth instead.
CREATE TABLE IF NOT EXISTS crash_recovery_associations (
  method_version TEXT NOT NULL,
  asset_class TEXT NOT NULL CHECK (asset_class IN ('crypto', 'stock')),
  horizon_sessions INTEGER NOT NULL,
  evidence_partition TEXT NOT NULL CHECK (evidence_partition IN ('all', 'bootstrap', 'prospective')),
  feature_name TEXT NOT NULL CHECK (feature_name IN (
    'all-events', 'drawdown-depth', 'momentum-20', 'realized-volatility-20',
    'volume-ratio-20', 'distance-sma-200', 'benchmark-return-20',
    'relative-strength-20', 'benchmark-regime', 'publication-call'
  )),
  feature_bucket TEXT NOT NULL,
  n INTEGER NOT NULL CHECK (n > 0),
  unique_symbols INTEGER NOT NULL CHECK (unique_symbols > 0 AND unique_symbols <= n),
  unique_cohorts INTEGER NOT NULL CHECK (unique_cohorts > 0 AND unique_cohorts <= n),
  recovered_n INTEGER NOT NULL CHECK (recovered_n >= 0 AND recovered_n <= n),
  failed_n INTEGER NOT NULL CHECK (failed_n >= 0 AND failed_n <= n),
  recovery_rate REAL NOT NULL CHECK (recovery_rate >= 0 AND recovery_rate <= 1),
  reached_2x_n INTEGER NOT NULL CHECK (reached_2x_n >= 0 AND reached_2x_n <= n),
  reached_5x_n INTEGER NOT NULL CHECK (reached_5x_n >= 0 AND reached_5x_n <= n),
  reached_10x_n INTEGER NOT NULL CHECK (reached_10x_n >= 0 AND reached_10x_n <= n),
  reached_20x_n INTEGER NOT NULL CHECK (reached_20x_n >= 0 AND reached_20x_n <= n),
  avg_terminal_return_pct REAL,
  avg_max_return_pct REAL,
  avg_max_adverse_pct REAL,
  updated_at TEXT NOT NULL,
  evidence_label TEXT NOT NULL DEFAULT 'raw-descriptive-association-not-causal'
    CHECK (evidence_label = 'raw-descriptive-association-not-causal'),
  live_edge_eligible INTEGER NOT NULL DEFAULT 0 CHECK (live_edge_eligible = 0),
  PRIMARY KEY (method_version, asset_class, horizon_sessions, evidence_partition, feature_name, feature_bucket),
  CHECK ((asset_class = 'crypto' AND horizon_sessions IN (365, 730))
      OR (asset_class = 'stock' AND horizon_sessions IN (252, 504))),
  CHECK (recovered_n + failed_n = n),
  CHECK (reached_20x_n <= reached_10x_n AND reached_10x_n <= reached_5x_n
      AND reached_5x_n <= reached_2x_n)
);

CREATE INDEX IF NOT EXISTS idx_crash_recovery_associations_lookup
  ON crash_recovery_associations(asset_class, horizon_sessions, evidence_partition, feature_name, n DESC);
