-- DASH is both Dash (crypto) and DoorDash (equity). Legacy table keys that
-- omitted asset_class interleaved their prices and outcomes, creating a
-- mathematically impossible series and a false research finding. The runtime
-- now rejects every crypto ticker that collides with the equity watchlist.
-- Clear the one known collision so DoorDash can be backfilled/relearned from a
-- clean slate; no result is preferable to a cross-asset fabrication.
DELETE FROM forecast_outcomes WHERE symbol = 'DASH';
DELETE FROM technique_votes WHERE symbol = 'DASH';
DELETE FROM asset_price_log WHERE symbol = 'DASH';
DELETE FROM range_log WHERE symbol = 'DASH';
DELETE FROM technique_reliability WHERE symbol = 'DASH';
DELETE FROM technique_regime_reliability WHERE symbol = 'DASH';
DELETE FROM technique_combo_reliability WHERE symbol = 'DASH';
DELETE FROM range_reliability WHERE symbol = 'DASH';
DELETE FROM asset_move_stats WHERE symbol = 'DASH';
DELETE FROM asset_score_snapshots WHERE symbol = 'DASH';
DELETE FROM swing_time_stats WHERE symbol = 'DASH';
DELETE FROM time_of_day_stats WHERE symbol = 'DASH';
DELETE FROM intraday_price_ticks WHERE symbol = 'DASH';
DELETE FROM intraday_signal_log WHERE symbol = 'DASH';
DELETE FROM intraday_reliability WHERE symbol = 'DASH';
DELETE FROM intraday_backtest_reliability WHERE symbol = 'DASH';
DELETE FROM call_flip_log WHERE symbol = 'DASH';

DELETE FROM asset_daily_bars WHERE symbol = 'DASH';
DELETE FROM asset_hourly_bars WHERE symbol = 'DASH';
DELETE FROM funding_rate_daily WHERE symbol = 'DASH';
DELETE FROM sentiment_daily WHERE symbol = 'DASH';
DELETE FROM asset_sectors WHERE symbol = 'DASH';
DELETE FROM asset_events WHERE symbol = 'DASH';
DELETE FROM asset_rotation_status WHERE symbol = 'DASH';
DELETE FROM long_term_bottom_status WHERE symbol = 'DASH';
DELETE FROM asset_daily_range WHERE symbol = 'DASH';
DELETE FROM time_of_day_edge WHERE symbol = 'DASH';
DELETE FROM asset_sr_levels WHERE symbol = 'DASH';
DELETE FROM lead_lag_signals WHERE leader_symbol = 'DASH' OR follower_symbol = 'DASH';

DELETE FROM research_strategy_metric_history
WHERE hypothesis IN (
  SELECT hypothesis FROM research_registry
  WHERE symbol = 'DASH' OR hypothesis LIKE '%|DASH' OR hypothesis LIKE '%|DASH|%'
);
DELETE FROM research_strategy_metrics
WHERE hypothesis IN (
  SELECT hypothesis FROM research_registry
  WHERE symbol = 'DASH' OR hypothesis LIKE '%|DASH' OR hypothesis LIKE '%|DASH|%'
);
DELETE FROM research_registry
WHERE symbol = 'DASH'
   OR hypothesis LIKE '%|DASH'
   OR hypothesis LIKE '%|DASH|%';
