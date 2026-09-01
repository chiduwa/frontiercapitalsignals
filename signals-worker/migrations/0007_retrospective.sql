-- Automatic retrospective (scripts/retrospective.mjs) + the stablecoin
-- research lane. User-requested 2026-08-31.
--
-- Two separate concerns that arrived in the same request and stay
-- separate here:
--
--   retrospective_misses / retrospective_patterns
--     "what moved, and why didn't we call it" — a permanent, append-only
--     record of every large move alongside what the engine believed at
--     the time, so the failure MODE can be counted rather than argued
--     about. The aggregate table is what turns a pile of individual
--     misses into an instruction about what to fix next.
--
--   stable_value_observations
--     pegs are excluded from every directional board (a $1 asset has no
--     breakout to call, and showing USDG "⏳ Consolidating" was the bug
--     that started all this) — but excluded is not the same as ignored.
--     A stablecoin's supply and turnover going quiet or surging is
--     plausibly information about where the money that is NOT sitting in
--     it is about to go, and that hypothesis cannot be tested without
--     first accumulating the series. This table is that accumulation.
--     It is raw observation only; nothing reads it into a live signal
--     until correlation-research.mjs says the relationship survives
--     out-of-sample (see research_registry, migration 0006).
--
-- Idempotent by construction: CREATE TABLE IF NOT EXISTS only.

CREATE TABLE IF NOT EXISTS retrospective_misses (
  run_at TEXT NOT NULL,
  symbol TEXT NOT NULL,
  name TEXT,
  asset_class TEXT NOT NULL,
  -- Rank AS OBSERVED, which for a big gainer is measured after the move
  -- and therefore flatters where it sat before it (ARB read 85 at +34%,
  -- having started the day near the rank-100 universe boundary). Stored
  -- as seen rather than adjusted, so the caveat lives in the docs and the
  -- data stays a plain record of what was true at write time.
  mcap_rank INTEGER,
  move_pct REAL NOT NULL,
  move_dir INTEGER NOT NULL,
  in_universe INTEGER NOT NULL,
  passed_floors INTEGER NOT NULL,
  -- What the engine actually said, from the composite votes the hourly
  -- build had already written before the move — not a reconstruction.
  engine_dir INTEGER,
  engine_score REAL,
  engine_first_seen_at TEXT,
  -- One of MISS_CAUSES (worker.js). A closed vocabulary specifically so
  -- causes can be counted; free text cannot be aggregated.
  cause TEXT NOT NULL,
  -- Whether a volume/participation tell existed at all before the move.
  -- 0 is a real and useful answer: a move with no warning is the one
  -- class of miss no amount of engine tuning can recover, and separating
  -- those out keeps them from inflating the fixable backlog.
  detected INTEGER,
  detectable_at TEXT,
  detectable_price REAL,
  surge_ratio REAL,
  trade_ratio REAL,
  lead_hours REAL,
  gain_to_peak_pct REAL,
  max_drawdown_pct REAL,
  PRIMARY KEY (run_at, symbol)
);

CREATE INDEX IF NOT EXISTS idx_retrospective_misses_cause ON retrospective_misses(cause, run_at);
CREATE INDEX IF NOT EXISTS idx_retrospective_misses_symbol ON retrospective_misses(symbol, run_at);

-- Recomputed wholesale from the ledger each run (not incremented), so it
-- can never drift from the rows it summarises.
CREATE TABLE IF NOT EXISTS retrospective_patterns (
  cause TEXT PRIMARY KEY,
  n INTEGER NOT NULL,
  share REAL NOT NULL,
  avg_move_pct REAL,
  -- Average % still available from the first detectable tell to the peak.
  -- The number that decides whether a miss actually cost anything: a
  -- missed move that was only detectable at its own top is not a miss in
  -- any sense worth acting on.
  avg_available_pct REAL,
  avg_lead_hours REAL,
  n_detected INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- Keyed by DATE, not by run timestamp, for three reasons that all point
-- the same way. It bounds the table (~26 rows/day rather than ~26/hour,
-- so ~9.5K rows/year instead of 228K, with no pruning job needed at all).
-- It matches the grain of the question: net mint/redeem is a daily-scale
-- flow, and hourly wobble in a peg's market cap is mostly noise on the
-- anchor. And it makes these rows directly joinable with the stablecoin
-- depeg research already in correlation-research.mjs, which keys its own
-- series by calendar date.
--
-- The hourly build upserts into the day's row, so most columns hold the
-- most recent observation. peak_deviation_pct is the exception and is
-- accumulated with MAX() across the day — a depeg is an intraday spike,
-- and last-write-wins would be exactly the wrong summary for it.
CREATE TABLE IF NOT EXISTS stable_value_observations (
  obs_date TEXT NOT NULL,
  symbol TEXT NOT NULL,
  name TEXT,
  price REAL,
  -- Supply proxy: for a peg, market cap IS net mint/redeem, which is the
  -- flow variable the hypothesis is actually about.
  mcap REAL,
  volume REAL,
  -- Median absolute bar-over-bar return (see pegBehaviour). Doubles as
  -- the peg-tightness measure a depeg-stress study needs, and as an audit
  -- trail for why this asset was excluded from the boards.
  median_bar_pct REAL,
  chg24h REAL,
  -- Largest absolute % gap from this asset's own anchor seen during the
  -- day. Accumulated with MAX, never overwritten.
  peak_deviation_pct REAL,
  -- 'known' (name/ticker list) or 'behaviour' (price series). Lets a
  -- wrong exclusion be found later instead of staying invisible.
  basis TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (obs_date, symbol)
);

CREATE INDEX IF NOT EXISTS idx_stable_value_symbol ON stable_value_observations(symbol, obs_date);
