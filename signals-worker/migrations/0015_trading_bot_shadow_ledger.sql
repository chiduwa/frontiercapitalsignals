-- The bot's own track record, kept separately from the engine's.
--
-- Under confluence-v7 the engine withholds every direction until independent
-- evidence rebuilds, so a correctly-gated bot places nothing for days or
-- weeks. Idling through that window would mean arriving at the far end with
-- no evidence about the BOT's selection quality either — only the engine's.
--
-- So every candidate that clears every gate the bot itself owns, and fails
-- only because the engine has not authorized a call, is recorded here with
-- the exact entry, stop and target it would have used. Later cycles resolve
-- them against real subsequent prices. Nothing in this table places an order
-- or feeds a sizing decision; it is measurement, in the same spirit as the
-- engine's own research lane.
--
-- `mode` separates the three provenances so they can never be pooled:
--   shadow — would have opened, but the engine had not authorized the call
--   dry    — authorized, but DRY_RUN was on, so no order was sent
--   live   — authorized and actually executed
CREATE TABLE IF NOT EXISTS trading_bot_shadow_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  opened_at TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('shadow', 'dry', 'live')),
  source TEXT NOT NULL CHECK (source IN ('confluence-v7', 'research-confirmed')),
  symbol TEXT NOT NULL,
  signal_symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  entry_price REAL NOT NULL CHECK (entry_price > 0),
  stop_price REAL CHECK (stop_price IS NULL OR stop_price > 0),
  target_price REAL CHECK (target_price IS NULL OR target_price > 0),
  position_pct REAL NOT NULL,
  leverage REAL NOT NULL,
  extreme_boost INTEGER NOT NULL DEFAULT 0 CHECK (extreme_boost IN (0, 1)),
  -- Why the engine withheld, for a shadow row. Preserved verbatim so the
  -- cold-start record can later be grouped by reason rather than guessed at.
  withheld_reason TEXT,
  -- The measured path evidence in force at entry, if any. Stored rather than
  -- re-derived: the evidence moves as outcomes mature, and a resolution must
  -- be judged against what was actually known when the decision was made.
  horizon_hours REAL,
  time_exit_after_ms REAL,
  edge REAL,
  holding_n INTEGER,
  holding_mfe_pct REAL,
  holding_mae_pct REAL,
  holding_hours_to_peak REAL,
  -- Resolution, written by a later cycle.
  resolved_at TEXT,
  exit_price REAL CHECK (exit_price IS NULL OR exit_price > 0),
  exit_reason TEXT CHECK (exit_reason IS NULL OR exit_reason IN ('target', 'stop', 'time', 'horizon')),
  -- Signed return in the direction taken, before costs, at the position's own
  -- leverage. Gross deliberately: a fee assumption belongs in analysis, not
  -- baked into the stored observation.
  return_pct REAL
);

CREATE INDEX IF NOT EXISTS idx_trading_bot_shadow_open
  ON trading_bot_shadow_trades(resolved_at, opened_at) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_trading_bot_shadow_symbol
  ON trading_bot_shadow_trades(symbol, opened_at DESC);

-- One unresolved entry per symbol per mode at a time. The bot already refuses
-- to stack positions in a symbol; this makes that an invariant of the record
-- too, so a stuck cycle cannot inflate the ledger with near-duplicate rows.
CREATE UNIQUE INDEX IF NOT EXISTS idx_trading_bot_shadow_one_open
  ON trading_bot_shadow_trades(symbol, mode) WHERE resolved_at IS NULL;

-- The bot's open-position record needs to carry its exit geometry, not just
-- the predicted range it was gated on. Under v7 the take-profit is no longer
-- derivable from the range alone (it may come from measured path evidence
-- instead), and the time exit has no representation at all — so a cycle that
-- did not open the position could not reconstruct either one.
ALTER TABLE trading_bot_open_orders ADD COLUMN target_price REAL;
ALTER TABLE trading_bot_open_orders ADD COLUMN stop_price REAL;
ALTER TABLE trading_bot_open_orders ADD COLUMN time_exit_after_ms REAL;
ALTER TABLE trading_bot_open_orders ADD COLUMN source TEXT;

-- Extremes seen since entry, carried forward each cycle. Resolution judges
-- against these rather than the latest mark: a stop breached and then
-- recovered between two cycles is a closed trade, and scoring on the current
-- price alone would silently drop exactly the losers.
ALTER TABLE trading_bot_shadow_trades ADD COLUMN running_high REAL;
ALTER TABLE trading_bot_shadow_trades ADD COLUMN running_low REAL;
