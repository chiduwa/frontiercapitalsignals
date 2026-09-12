-- Where a matured forecast came from.
--
-- 'live'   cast by a scheduled build against the market as it stood, then
--          scored when the horizon elapsed. Every row written before this
--          migration is one of these, which is why the default backfills them
--          correctly.
-- 'replay' cast by scripts/replay-history.mjs against archive bars, using only
--          information available at its own anchor date, then scored against
--          the bar the horizon actually landed on.
--
-- Both are legitimate evidence and the loaders deliberately read both: a
-- walk-forward replay with no look-ahead is measuring the same model against
-- the same labels, and the engine's problem was never that its evidence was
-- the wrong KIND, it was that ten independent periods cannot settle anything.
--
-- The column exists so that claim stays auditable rather than assumed. Any
-- query can separate the two populations and check that they agree; if replayed
-- accuracy and live accuracy ever diverge materially, that is the signal that
-- the replay has drifted from the live model and the harness is wrong.
ALTER TABLE forecast_outcomes ADD COLUMN provenance TEXT NOT NULL DEFAULT 'live';

CREATE INDEX IF NOT EXISTS idx_forecast_outcomes_provenance
  ON forecast_outcomes(provenance, model_version, series_kind, series_key, run_at DESC);

-- Resumable checkpoint for the replay, one row per (asset_class, horizon).
-- The replay walks anchors newest-first the way backfill-history.mjs walks
-- dates, so `oldest_anchor_done` is the low-water mark: the next run starts
-- strictly before it. Keeping this in D1 rather than a file means a workflow
-- run that is cancelled mid-way (the 120-minute ceiling is real -- see
-- signals-daily.yml's own notes on silent cancellation) resumes where it
-- stopped instead of redoing the newest anchors forever.
CREATE TABLE IF NOT EXISTS replay_checkpoints (
  asset_class TEXT NOT NULL,
  horizon_days INTEGER NOT NULL,
  oldest_anchor_done TEXT,          -- YYYY-MM-DD, exclusive lower bound for the next run
  newest_anchor_done TEXT,
  anchors_done INTEGER NOT NULL DEFAULT 0,
  rows_written INTEGER NOT NULL DEFAULT 0,
  model_version TEXT NOT NULL,
  last_run_at TEXT,
  PRIMARY KEY (asset_class, horizon_days, model_version)
);
