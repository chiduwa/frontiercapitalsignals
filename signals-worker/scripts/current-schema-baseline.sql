-- ONLY for a brand-new empty database immediately after scripts/schema.sql.
--
-- This repository predates Wrangler-managed migrations: schema.sql is the
-- current full snapshot, while migrations/ contains upgrades from earlier
-- production shapes. Mark those upgrades applied after bootstrapping the
-- snapshot, or the next workflow would replay historical ALTER TABLE steps
-- against columns the snapshot already contains. Never run this file to
-- upgrade an existing/partial database; use `wrangler d1 migrations apply`.
-- The table shape matches Wrangler v4's D1 migration journal.

CREATE TABLE IF NOT EXISTS d1_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);

INSERT OR IGNORE INTO d1_migrations (name) VALUES
  ('0001_score_calibration_detail.sql'),
  ('0002_reset_pre_exact_horizon_aggregates.sql'),
  ('0003_direction_baseline.sql'),
  ('0004_asset_daily_range.sql'),
  ('0005_time_of_day_edge.sql'),
  ('0006_research_registry.sql'),
  ('0007_retrospective.sql'),
  ('0008_surge_signals.sql'),
  ('0009_independent_retry_safe_outcomes.sql'),
  ('0010_quant_strategy_metrics.sql'),
  ('0011_market_context.sql'),
  ('0012_cross_class_ticker_quarantine.sql'),
  ('0013_outcome_provenance_and_versions.sql'),
  ('0014_fixed_oos_decision_checkpoints.sql'),
  ('0015_trading_bot_shadow_ledger.sql'),
  ('0016_spot_bot_ledger.sql'),
  ('0017_trade_outcomes_and_equity.sql'),
  ('0018_robinhood_reversal_ledger.sql'),
  ('0019_microstructure_leadlag.sql'),
  ('0020_cross_sectional_lane.sql'),
  ('0021_manual_trade_journal.sql'),
  ('0022_retrospective_asset_baselines.sql'),
  ('0023_retrospective_seasonal_lead_lag.sql'),
  ('0024_trading_execution_leases.sql'),
  ('0025_shadow_signal_identity.sql'),
  ('0026_signal_publication_snapshots.sql'),
  ('0027_account_journal_algo_state.sql'),
  ('0028_account_journal_query_indexes.sql'),
  ('0029_crash_recovery_research.sql'),
  ('0030_futures_limit_entry_intents.sql'),
  ('0031_account_journal_position_snapshots.sql'),
  ('0032_policy_history_research.sql'),
  ('0033_derivatives_daily.sql'),
  ('0034_asset_bar_quarantine.sql'),
  ('0035_asset_supply_daily.sql'),
  ('0036_fundamentals_lanes.sql');
