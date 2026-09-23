-- Surge alerts are judged against the market over the same window
-- (2026-09-24, marketWindow / surgeNotifyGate in worker.js). Judged against a
-- coin flip, two long-side configurations graduated on the September rally
-- and notified 431 times while trailing the market in their own direction.
-- Each scored cast now records what every scanned coin did over its hours;
-- NULL for casts scored before this (or backfilled from Binance hourly
-- closes over the identical window, see docs/MISSED_MOVES.md).
ALTER TABLE surge_signal_log ADD COLUMN market_move_pct REAL;
ALTER TABLE surge_signal_log ADD COLUMN base_rate REAL;
ALTER TABLE surge_signal_log ADD COLUMN market_n INTEGER;
ALTER TABLE surge_config_status ADD COLUMN excess_pct REAL;
ALTER TABLE surge_config_status ADD COLUMN excess_t REAL;
ALTER TABLE surge_config_status ADD COLUMN excess_days INTEGER;
ALTER TABLE surge_config_status ADD COLUMN base_rate REAL;
