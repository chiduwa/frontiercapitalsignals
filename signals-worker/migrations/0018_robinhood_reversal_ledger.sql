-- Robinhood leveraged-ETF reversal rule: evidence before execution.
--
-- The rule is promising, not proven. Measured over 5,020 daily bars across 10
-- leveraged ETFs (2024-09 to 2026-09), sigma-scaled thresholds gave 7 of 10
-- symbols positive compounded returns, median +25.4% -- but on 54 trades in
-- total, 2 to 9 per symbol. That cannot separate skill from luck, so it
-- accumulates a forward record here before it is allowed to place an order.
--
-- The same discipline as trading_bot_shadow_trades (0015): decisions recorded
-- with the numbers in force at the time, resolved against real subsequent
-- prices, provenance never pooled.
CREATE TABLE IF NOT EXISTS robinhood_shadow_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  opened_at TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('shadow', 'live')),
  symbol TEXT NOT NULL,
  -- A bottom in a leveraged LONG is a bet the underlying recovers, amplified.
  -- A bottom in an INVERSE is a bet it falls, with daily-reset decay working
  -- against the position throughout. Different trades; never pooled.
  structure TEXT NOT NULL CHECK (structure IN ('long', 'inverse')),
  entry_price REAL NOT NULL CHECK (entry_price > 0),
  target_price REAL NOT NULL CHECK (target_price > 0),
  stop_price REAL NOT NULL CHECK (stop_price > 0),
  max_hold_days INTEGER NOT NULL,
  -- Everything the rule measured at the moment it fired. Frozen, because
  -- judging the outcome against a sigma recomputed later would be hindsight.
  sigma_pct REAL,
  low_price REAL,
  low_age_sessions INTEGER,
  off_low_pct REAL,
  needed_pct REAL,
  reason TEXT,
  resolved_at TEXT,
  exit_price REAL,
  exit_reason TEXT CHECK (exit_reason IS NULL OR exit_reason IN ('target', 'stop', 'time')),
  return_pct REAL
);

CREATE INDEX IF NOT EXISTS idx_rh_shadow_open ON robinhood_shadow_trades(resolved_at, opened_at) WHERE resolved_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_rh_shadow_one_open ON robinhood_shadow_trades(symbol, mode) WHERE resolved_at IS NULL;

-- Where every candidate stood on every observation day, whether or not it
-- fired. Without this there is only a record of the days the rule acted, which
-- would make it impossible to ask later how close the near-misses came or
-- whether the thresholds are set anywhere near right.
CREATE TABLE IF NOT EXISTS robinhood_watchlist_state (
  observed_on TEXT NOT NULL,
  symbol TEXT NOT NULL,
  structure TEXT NOT NULL,
  close REAL NOT NULL,
  low_price REAL,
  low_age_sessions INTEGER,
  off_low_pct REAL,
  needed_pct REAL,
  sigma_pct REAL,
  closed_up INTEGER,
  qualifies INTEGER NOT NULL DEFAULT 0,
  verdict TEXT,
  PRIMARY KEY (observed_on, symbol)
);

CREATE INDEX IF NOT EXISTS idx_rh_watch_symbol ON robinhood_watchlist_state(symbol, observed_on DESC);
