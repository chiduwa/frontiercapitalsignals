-- High-frequency open-interest sampling, and the flush events derived from it.
--
-- WHY THIS EXISTS
--
-- docs/FLUSH_EVIDENCE.md established that the direction of open-interest change
-- DURING a violent move is what separates a dip that fully retraces from one
-- that does not: OI rising through the drop (new shorts pressing in) recovers
-- 106% median, OI falling (longs being liquidated out) recovers 50.3%.
-- Spearman +0.505, t = 7.99, n = 189.
--
-- That finding is useless to a live bot unless the OI reading is FAST. The
-- portal's metrics files are 5-minute buckets published after the day closes,
-- and the live 5m aggregate endpoints lag 6-16 minutes — far slower than the
-- sub-five-minute events they would have to classify.
--
-- Measured on the Oracle host 2026-09-12: /fapi/v1/openInterest returns a
-- reading stamped ~8 SECONDS old, in ~0.6s round trip. That is fast enough.
-- But it is a SNAPSHOT — it carries no delta — so computing "OI change across
-- the last five minutes" requires having sampled and stored the history
-- yourself. Hence this table.
--
-- Only the Oracle host can write it: fapi.binance.com is HTTP 451 from the
-- developer machine and from GitHub runners.
CREATE TABLE IF NOT EXISTS oi_tick (
  symbol TEXT NOT NULL,
  ts INTEGER NOT NULL,              -- exchange timestamp, ms epoch
  oi_contracts REAL,
  oi_usd REAL,
  mark_price REAL,
  PRIMARY KEY (symbol, ts)
);
CREATE INDEX IF NOT EXISTS idx_oi_tick_ts ON oi_tick(ts);

-- Detected in-flight events, written by the sampler the moment the geometry
-- qualifies. Deliberately separate from trading_bot_entry_intents: this is an
-- OBSERVATION ("a flush is happening on ZEC right now, OI is falling"), not a
-- decision to trade. Keeping them apart means the classifier can be evaluated
-- on its own record before anything is allowed to act on it.
--
-- classification uses the measured rule, not a guess:
--   'liquidation'  OI fell through the move  -> partial recovery expected (~50%)
--   'new-position' OI rose through the move  -> full retrace expected (~106%)
--   'ambiguous'    OI flat, or no OI history deep enough to judge
CREATE TABLE IF NOT EXISTS flush_event (
  id TEXT PRIMARY KEY,              -- symbol|first_ts
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('down', 'up')),
  detected_at TEXT NOT NULL,
  first_ts INTEGER NOT NULL,
  ref_price REAL NOT NULL,          -- pre-event extreme the move is measured from
  extreme_price REAL NOT NULL,      -- furthest price reached during the move
  move_pct REAL NOT NULL,
  oi_change_pct REAL,               -- across the move; the classifying variable
  classification TEXT NOT NULL CHECK (classification IN ('liquidation', 'new-position', 'ambiguous')),
  expected_recovery REAL,           -- from the measured medians, not a forecast
  -- Outcome, filled in later by whatever scores these. Left NULL on write so a
  -- detection can never be confused with a verified result.
  resolved_at TEXT,
  actual_recovery REAL,
  fwd_1h_pct REAL,
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_flush_event_symbol ON flush_event(symbol, first_ts);
CREATE INDEX IF NOT EXISTS idx_flush_event_unresolved ON flush_event(resolved_at) WHERE resolved_at IS NULL;
