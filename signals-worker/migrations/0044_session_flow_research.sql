-- Immutable, matched-clock provider observations; volume is rolling 24h USD,
-- NOT a disjoint trade tape or capital inflow. Provider timestamps are retained.
CREATE TABLE IF NOT EXISTS market_flow_observations (
  observed_at TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  asset_group TEXT NOT NULL CHECK(asset_group IN ('usd-stable','crypto')),
  provider_at TEXT,
  volume_usd_24h REAL,
  market_cap_usd REAL,
  price_usd REAL,
  quality TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'coingecko',
  PRIMARY KEY (observed_at, asset_id)
);
CREATE INDEX IF NOT EXISTS market_flow_asset_time ON market_flow_observations(asset_id, observed_at);
-- Compact, non-actionable summaries only; full inputs/predictions live in CI artifacts.
CREATE TABLE IF NOT EXISTS session_flow_research (
  as_of TEXT NOT NULL,
  version TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  PRIMARY KEY(as_of, version, input_hash, code_hash)
);

-- Capture version at FORECAST time; legacy pending votes must never mature as v9.
CREATE TABLE IF NOT EXISTS forecast_run_versions (
  run_at TEXT PRIMARY KEY,
  model_version TEXT NOT NULL
);

-- Preserve provider-native snapshots independently of settlement measurements.
-- Otherwise protecting canonical rows would prevent live percentile history growing.
CREATE TABLE IF NOT EXISTS funding_snapshot_daily (
  symbol TEXT NOT NULL,
  date TEXT NOT NULL,
  funding_rate REAL,
  open_interest REAL,
  basis_pct REAL,
  source TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  venue TEXT,
  contract_id TEXT,
  rate_unit TEXT NOT NULL DEFAULT 'provider-native',
  PRIMARY KEY(symbol,date,source)
);
