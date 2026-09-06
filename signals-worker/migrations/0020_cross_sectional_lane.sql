-- Cross-sectional expected-return lane (see worker.js's XS_FEATURES block and
-- docs/CROSS_SECTIONAL_EVIDENCE.md).
--
-- Deliberately a SEPARATE ledger from forecast_outcomes rather than a new
-- series_kind on it. forecast_outcomes was stabilised by migration 0009 as the
-- idempotency boundary for the direction model and its CHECK constraint on
-- series_kind cannot be widened in SQLite without a table rebuild. This lane
-- predicts a different quantity (expected return, not direction), is scored by
-- a different statistic (mean realised return by decile, not hit rate), and
-- must be able to fail on its own without touching a ledger that is currently
-- the only working record of the production model.
--
-- Idempotent by construction: CREATE TABLE IF NOT EXISTS only.

-- One row per (class, horizon, feature). Rewritten in full by each fit; the
-- history of what was believed when lives in xs_coefficient_history.
CREATE TABLE IF NOT EXISTS xs_feature_coefficients (
  asset_class TEXT NOT NULL,
  horizon_days INTEGER NOT NULL,
  feature_id TEXT NOT NULL,
  -- Fama-MacBeth mean of the per-week univariate cross-sectional regressions
  -- of forward return on this feature's [-0.5, 0.5] rank.
  alpha REAL NOT NULL,
  beta REAL NOT NULL,
  -- mean(beta_t) / (sd(beta_t)/sqrt(T)) over the estimation window.
  t_stat REAL NOT NULL,
  weeks INTEGER NOT NULL,
  -- Share of estimation weeks whose beta carried the same sign as the mean.
  -- A feature that is significant only because of three enormous weeks looks
  -- identical to a persistent one on t_stat alone; this separates them.
  sign_consistency REAL,
  -- 1 only when the feature cleared BOTH the family-wise significance
  -- threshold and the sign-consistency floor. xsForecast ignores every row
  -- with selected = 0, so an unselected feature is inert, not down-weighted.
  selected INTEGER NOT NULL DEFAULT 0 CHECK (selected IN (0, 1)),
  z_threshold REAL NOT NULL,
  features_tested INTEGER NOT NULL,
  fit_through TEXT NOT NULL,
  method_version TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (asset_class, horizon_days, feature_id),
  CHECK (horizon_days > 0),
  CHECK (weeks >= 0)
);

-- Append-only record of every fit, so a coefficient that flips sign is
-- visible as a change of belief rather than silently overwriting the old one.
-- This is what makes "the model changed its mind about RSI in March" an
-- answerable question instead of a lost one.
CREATE TABLE IF NOT EXISTS xs_coefficient_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fit_at TEXT NOT NULL,
  asset_class TEXT NOT NULL,
  horizon_days INTEGER NOT NULL,
  feature_id TEXT NOT NULL,
  beta REAL NOT NULL,
  t_stat REAL NOT NULL,
  weeks INTEGER NOT NULL,
  selected INTEGER NOT NULL CHECK (selected IN (0, 1)),
  method_version TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_xs_coef_history
  ON xs_coefficient_history(asset_class, horizon_days, feature_id, fit_at DESC);

-- Out-of-sample scoring for the lane itself. One row per asset per scored
-- build; realised_return_pct is NULL until the horizon matures.
--
-- The unique index is the idempotency boundary, exactly as
-- idx_forecast_outcomes_unique is for the direction model: re-running a build
-- for the same (class, symbol, horizon, target date) cannot add a second
-- observation of the same future.
CREATE TABLE IF NOT EXISTS xs_forecast_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_at TEXT NOT NULL,
  asset_class TEXT NOT NULL,
  symbol TEXT NOT NULL,
  horizon_days INTEGER NOT NULL,
  target_date TEXT NOT NULL,
  expected_return_pct REAL NOT NULL,
  -- Within-class percentile of expected_return_pct at cast time, 0-100.
  -- This, not the raw expectation, is what a board row would show.
  percentile INTEGER NOT NULL,
  decile INTEGER NOT NULL CHECK (decile BETWEEN 0 AND 9),
  entry_price REAL NOT NULL CHECK (entry_price > 0),
  features_used INTEGER NOT NULL,
  universe_size INTEGER NOT NULL,
  realised_return_pct REAL,
  -- Equal-weighted mean return of the whole class over the same window, so
  -- every row is scored against "you could have just held everything"
  -- rather than against zero.
  universe_return_pct REAL,
  observed_at TEXT,
  method_version TEXT NOT NULL,
  aggregated INTEGER NOT NULL DEFAULT 0 CHECK (aggregated IN (0, 1)),
  CHECK (percentile BETWEEN 0 AND 100)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_xs_forecast_unique
  ON xs_forecast_log(asset_class, symbol, horizon_days, target_date);
CREATE INDEX IF NOT EXISTS idx_xs_forecast_pending
  ON xs_forecast_log(aggregated, target_date) WHERE realised_return_pct IS NULL;

-- Derived economic-edge evidence, folded from matured xs_forecast_log rows.
-- The publication gate reads this and nothing else.
--
-- Note the metric: mean EXCESS return over the equal-weighted class, not a
-- hit rate. Measured on this project's own archive, the top cross-sectional
-- momentum quintile returned +2.11%/week against a +1.26% universe mean while
-- its hit rate (46%) was indistinguishable from every other quintile's. A
-- hit-rate gate is blind to this lane's entire edge by construction.
CREATE TABLE IF NOT EXISTS xs_decile_evidence (
  asset_class TEXT NOT NULL,
  horizon_days INTEGER NOT NULL,
  decile INTEGER NOT NULL CHECK (decile BETWEEN 0 AND 9),
  n INTEGER NOT NULL,
  mean_excess_pct REAL NOT NULL,
  sd_excess_pct REAL,
  -- mean_excess_pct / (sd_excess_pct / sqrt(n)). The gate's only statistic.
  t_stat REAL,
  mean_raw_pct REAL,
  hit_rate REAL,
  updated_at TEXT NOT NULL,
  method_version TEXT NOT NULL,
  PRIMARY KEY (asset_class, horizon_days, decile)
);
