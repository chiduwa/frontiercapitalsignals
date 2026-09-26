-- Per-coin calibrated exhaustion and the market-wide reading
-- (2026-09-26, docs/research-2026-09-26/EXHAUSTION.md).
--
-- The calibrated features each cast was made on, so the live record can later
-- be sliced by how extreme the print was and by coin size, rather than only
-- by which rule fired.
ALTER TABLE surge_signal_log ADD COLUMN vol_z REAL;
ALTER TABLE surge_signal_log ADD COLUMN bar_z REAL;
ALTER TABLE surge_signal_log ADD COLUMN run24_z REAL;
ALTER TABLE surge_signal_log ADD COLUMN liquidity_30d REAL;

-- One row per live scan: how much of the market printed exhaustion in the last
-- day, how unusual total volume is, and how far the equal-weight market has
-- run. Display and research only. The research found that a market-wide volume
-- surge in a rally has been followed by MORE upside, so nothing here alerts.
CREATE TABLE IF NOT EXISTS market_exhaustion_log (
  at TEXT PRIMARY KEY,
  scanned INTEGER NOT NULL,
  index_coins INTEGER,
  breadth REAL,
  prints_24h INTEGER,
  agg_volume_z REAL,
  market_run72_z REAL,
  market_ret24_pct REAL,
  state TEXT,
  prints_json TEXT CHECK (prints_json IS NULL OR json_valid(prints_json)),
  watch_json TEXT CHECK (watch_json IS NULL OR json_valid(watch_json)),
  created_at TEXT NOT NULL
);
