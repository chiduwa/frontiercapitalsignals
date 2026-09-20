-- Raw provider reports, not liquidation inferred from OI. Rolling windows overlap.
CREATE TABLE IF NOT EXISTS liquidation_observations (
  provider TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  window_hours INTEGER NOT NULL,
  long_usd REAL NOT NULL,
  short_usd REAL NOT NULL,
  total_usd REAL NOT NULL,
  ingested_at TEXT NOT NULL,
  PRIMARY KEY(provider,observed_at,asset_id,window_hours)
);
