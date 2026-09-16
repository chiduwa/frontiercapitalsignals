-- Per-asset multiple regression research. Additive and separate from the
-- confluence ledger, the cross-sectional lane and the adaptive-ridge study:
-- nothing here feeds trade weights or the publication gate.
CREATE TABLE IF NOT EXISTS hierarchical_research_runs (
  run_id TEXT PRIMARY KEY,
  model_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  as_of TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  summary_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hierarchical_research_latest
  ON hierarchical_research_runs(model_version, created_at DESC);

-- One row per asset/horizon: shrunk coefficients, the per-feature shrinkage
-- weights that say how much of the asset's own fit survived pooling, and its
-- walk-forward metrics.
CREATE TABLE IF NOT EXISTS hierarchical_research_assets (
  run_id TEXT NOT NULL,
  asset_class TEXT NOT NULL,
  symbol TEXT NOT NULL,
  horizon INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  PRIMARY KEY (run_id, asset_class, symbol, horizon)
);
CREATE INDEX IF NOT EXISTS idx_hierarchical_research_symbol
  ON hierarchical_research_assets(symbol, horizon);
