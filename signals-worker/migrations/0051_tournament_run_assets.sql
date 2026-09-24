-- The tournament widened past the always-tracked 8 (2026-09-24,
-- scripts/tournament-universe.json): one run's per-asset slots and input
-- weights now live here, one row per asset, so the run row stays small and
-- the payload loader reads only what it publishes (the always-tracked assets,
-- the pooled slots, and any asset whose model has been promoted).
CREATE TABLE IF NOT EXISTS model_tournament_run_assets (
  run_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  asset_class TEXT NOT NULL,
  promoted INTEGER NOT NULL DEFAULT 0,
  summary_json TEXT NOT NULL CHECK (json_valid(summary_json)),
  PRIMARY KEY (run_id, symbol)
);
CREATE INDEX IF NOT EXISTS idx_model_tournament_run_assets_promoted ON model_tournament_run_assets(run_id, promoted);
