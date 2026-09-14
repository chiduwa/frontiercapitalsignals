-- Additive research snapshots, separate from confluence evidence and trading.
CREATE TABLE IF NOT EXISTS adaptive_research_runs (
  run_id TEXT PRIMARY KEY,
  model_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  as_of TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  summary_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_adaptive_research_latest
  ON adaptive_research_runs(model_version, created_at DESC);
CREATE TABLE IF NOT EXISTS adaptive_research_snapshots (
  run_id TEXT NOT NULL,
  asset_class TEXT NOT NULL,
  symbol TEXT NOT NULL,
  horizon INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  PRIMARY KEY (run_id, asset_class, symbol, horizon)
);
