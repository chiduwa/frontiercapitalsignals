-- Long-horizon record of what the bots actually did and what it earned.
--
-- The shadow ledger (0015) captures DECISIONS and resolves them against later
-- prices. This captures OUTCOMES: the realized profit and loss Binance itself
-- reports once a position is closed, alongside the evidence that was in force
-- when it was opened. Without the second half, there is no way to ask whether
-- the model's edge estimate, horizon or measured excursion actually predicted
-- anything -- which is the point of keeping it.
CREATE TABLE IF NOT EXISTS trading_bot_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  -- 'bot' and 'manual' are NEVER pooled. A position the operator opened by
  -- hand is not evidence about the model's selection, and averaging the two
  -- would corrupt exactly the measurement this table exists to support.
  origin TEXT NOT NULL CHECK (origin IN ('bot', 'manual')),
  source TEXT,
  opened_at TEXT,
  closed_at TEXT NOT NULL,
  entry_price REAL,
  exit_price REAL,
  quantity REAL,
  leverage REAL,
  margin_used REAL,
  -- Authoritative figures from Binance's own income history, not inferred
  -- from price differences: fees and funding are real costs and an edge that
  -- only exists gross of them is not an edge.
  realized_pnl REAL,
  commission REAL,
  funding_fee REAL,
  net_pnl REAL,
  return_on_margin_pct REAL,
  holding_minutes REAL,
  exit_reason TEXT,
  -- What the model believed at entry. Judging an outcome against evidence
  -- gathered later would be hindsight, so this is frozen at open time.
  edge REAL,
  horizon_hours REAL,
  holding_mfe_pct REAL,
  holding_mae_pct REAL,
  holding_hours_to_peak REAL,
  extreme_boost INTEGER,
  equity_at_open REAL,
  equity_at_close REAL
);

CREATE INDEX IF NOT EXISTS idx_trading_bot_trades_closed ON trading_bot_trades(closed_at DESC);
CREATE INDEX IF NOT EXISTS idx_trading_bot_trades_symbol ON trading_bot_trades(origin, symbol, closed_at DESC);
-- One row per closed position per symbol, so a re-run cannot double-count a
-- trade into the record the model learns from.
CREATE UNIQUE INDEX IF NOT EXISTS idx_trading_bot_trades_unique ON trading_bot_trades(symbol, closed_at, origin);

-- Equity through time: the denominator for return on assets, and the only way
-- to see drawdown between trades. Bucketed to 15 minutes so a 5-minute cadence
-- cannot grow this without bound (~35k rows/year) while keeping enough
-- resolution to measure a drawdown that matters.
CREATE TABLE IF NOT EXISTS trading_bot_equity_log (
  bucket TEXT PRIMARY KEY,
  observed_at TEXT NOT NULL,
  equity REAL NOT NULL,
  open_positions INTEGER,
  unrealized_pnl REAL
);

-- Mark-to-market for spot. Fills alone give a cost basis; this gives the other
-- half of return on asset, and it costs nothing extra because the spot cycle
-- already fetches every one of these prices.
CREATE TABLE IF NOT EXISTS spot_bot_valuation (
  bucket TEXT NOT NULL,
  symbol TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  quantity REAL NOT NULL,
  price REAL NOT NULL,
  market_value REAL NOT NULL,
  cost_basis REAL,
  unrealized_pct REAL,
  PRIMARY KEY (bucket, symbol)
);

CREATE INDEX IF NOT EXISTS idx_spot_valuation_symbol ON spot_bot_valuation(symbol, observed_at DESC);

-- Positions the operator opened by hand. The bots do not manage these -- no
-- stop, no take-profit, no time exit -- but they are watched every cycle, and
-- a reading that suggests a large loss is imminent is recorded here and
-- alerted on. Kept so "we warned at this level, at this time" is auditable.
CREATE TABLE IF NOT EXISTS trading_bot_risk_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  raised_at TEXT NOT NULL,
  symbol TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('warning', 'extreme')),
  reason TEXT NOT NULL,
  mark_price REAL,
  liquidation_price REAL,
  distance_to_liquidation_pct REAL,
  unrealized_pnl REAL,
  unrealized_vs_equity_pct REAL,
  equity REAL,
  action_taken TEXT
);

CREATE INDEX IF NOT EXISTS idx_risk_alerts_time ON trading_bot_risk_alerts(raised_at DESC);

-- Evidence frozen at open, as JSON. The bot is a one-shot process, so
-- anything not persisted here is gone by the time the position closes and the
-- outcome could no longer be judged against what was actually known when the
-- decision was made. A blob rather than columns because it is never queried
-- relationally -- it is read back whole, once, at close.
ALTER TABLE trading_bot_open_orders ADD COLUMN entry_evidence TEXT;
