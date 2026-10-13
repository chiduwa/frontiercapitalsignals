-- Low-cap watch (scripts/lowcap-watch.py, lowcap-watch-v1; docs/LOWCAP_SPIKES.md).
-- Every Binance low cap (bottom 40% of Binance market caps) is written once per
-- as-of close with both of its ranks, BEFORE its 30- and 90-day outcomes exist,
-- and scored in place afterwards. The published inflow watch and the private
-- spike ranking are both judged against the same day's whole low-cap set, so
-- the cohort is stored whole, not just the picks. Never backfill it.
CREATE TABLE IF NOT EXISTS lowcap_watch (
  model_version TEXT NOT NULL,
  as_of TEXT NOT NULL,
  symbol TEXT NOT NULL,
  pair TEXT NOT NULL,
  close REAL NOT NULL,
  mcap REAL,
  qv90 REAL,
  eligible INTEGER NOT NULL CHECK (eligible IN (0, 1)),
  inflow_rank INTEGER NOT NULL,
  inflow_score REAL NOT NULL,
  spike_rank INTEGER NOT NULL,
  spike_score REAL NOT NULL,
  detail_json TEXT CHECK (detail_json IS NULL OR json_valid(detail_json)),
  issued_at TEXT NOT NULL,
  -- 30 days on: mean daily volume over the next 30 days / the trailing 90-day mean
  fwd_qv_ratio REAL,
  inflow3x INTEGER CHECK (inflow3x IS NULL OR inflow3x IN (0, 1)),
  scored30_at TEXT,
  -- 90 days on: best close multiple, close-to-close return, take-profit exits, delisting
  max_close_mult REAL,
  ret90 REAL,
  tp50 REAL,
  tp100 REAL,
  delisted INTEGER CHECK (delisted IS NULL OR delisted IN (0, 1)),
  scored90_at TEXT,
  PRIMARY KEY (model_version, as_of, symbol)
);
CREATE INDEX IF NOT EXISTS idx_lowcap_watch_open30 ON lowcap_watch(model_version, scored30_at, as_of);
CREATE INDEX IF NOT EXISTS idx_lowcap_watch_open90 ON lowcap_watch(model_version, scored90_at, as_of);

-- One summary per run for the payload (the page reads the newest).
CREATE TABLE IF NOT EXISTS lowcap_watch_runs (
  run_id TEXT PRIMARY KEY,
  model_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  as_of TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  summary_json TEXT NOT NULL CHECK (json_valid(summary_json))
);
CREATE INDEX IF NOT EXISTS idx_lowcap_watch_runs_latest ON lowcap_watch_runs(model_version, created_at DESC);
