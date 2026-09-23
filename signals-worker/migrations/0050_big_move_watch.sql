-- Big-move watch (scripts/big-move-watch.py, big-move-watch-v1): the coins
-- most likely to move >= 12% either way over the next two days, logged at the
-- close BEFORE those two days happen and scored in place afterwards against
-- the same days' share of ALL coins that moved that much. Never backfill it.
CREATE TABLE IF NOT EXISTS big_move_watch (
  model_version TEXT NOT NULL,
  as_of TEXT NOT NULL,
  symbol TEXT NOT NULL,
  rank INTEGER NOT NULL,
  p REAL NOT NULL,
  close REAL,
  detail_json TEXT CHECK (detail_json IS NULL OR json_valid(detail_json)),
  issued_at TEXT NOT NULL,
  move_pct REAL,
  big INTEGER CHECK (big IS NULL OR big IN (0, 1)),
  day_base_rate REAL,
  scored_at TEXT,
  PRIMARY KEY (model_version, as_of, symbol)
);
CREATE INDEX IF NOT EXISTS idx_big_move_watch_open ON big_move_watch(model_version, big, as_of);

-- One summary per run for the payload; notified_at makes the daily push
-- happen once per as-of close however often the job reruns.
CREATE TABLE IF NOT EXISTS big_move_watch_runs (
  run_id TEXT PRIMARY KEY,
  model_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  as_of TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  summary_json TEXT NOT NULL CHECK (json_valid(summary_json)),
  notified_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_big_move_watch_runs_latest ON big_move_watch_runs(model_version, created_at DESC);
