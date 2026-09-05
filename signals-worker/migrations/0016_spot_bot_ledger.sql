-- Spot accumulation bot state and fill ledger.
--
-- Separate from the futures bot's tables on purpose: different key, different
-- risk profile, and no shared state beyond the D1 database itself. Nothing
-- here is leveraged and nothing here is ever sold by the bot, so there are no
-- stops, targets or exposure caps to track — only what was bought, when, and
-- what the measured reason was.
CREATE TABLE IF NOT EXISTS spot_bot_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),   -- single row, upsert-only
  last_tranche_at TEXT,
  -- Quote currency banked because no asset triggered on a due cycle. Capped
  -- in code (maxCarryTranches) so deferral cannot grow into one oversized
  -- bet, which would defeat the point of averaging.
  dry_powder REAL NOT NULL DEFAULT 0,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS spot_bot_fills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filled_at TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('dry', 'live')),
  symbol TEXT NOT NULL,
  signal_symbol TEXT NOT NULL,
  sleeve TEXT NOT NULL CHECK (sleeve IN ('core', 'satellite')),
  -- Which measured condition released the tranche, and the numbers behind it.
  -- Stored verbatim so a later review can group outcomes by trigger rather
  -- than re-deriving thresholds that have since moved.
  trigger TEXT NOT NULL CHECK (trigger IN ('significant-drop', 'weekly-low-reached')),
  trigger_reason TEXT,
  quote_spent REAL NOT NULL CHECK (quote_spent > 0),
  price REAL NOT NULL CHECK (price > 0),
  quantity REAL,
  order_id TEXT,
  -- The per-asset profile in force at the fill. A drop is only "significant"
  -- relative to a distribution, and that distribution moves as history
  -- accumulates, so judging this fill later requires what was known now.
  weekly_sigma REAL,
  typical_drawdown REAL,
  weeks_history INTEGER
);

CREATE INDEX IF NOT EXISTS idx_spot_bot_fills_symbol ON spot_bot_fills(symbol, filled_at DESC);
CREATE INDEX IF NOT EXISTS idx_spot_bot_fills_time ON spot_bot_fills(filled_at DESC);

-- Cycles where a tranche was due but nothing met its bar. Recorded because
-- conditional DCA's central risk is sitting out a rally: without this, the
-- skips are invisible and there is no way to tell later whether waiting paid.
CREATE TABLE IF NOT EXISTS spot_bot_skips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skipped_at TEXT NOT NULL,
  symbol TEXT NOT NULL,
  reason TEXT NOT NULL,
  price REAL,
  quote_deferred REAL
);

CREATE INDEX IF NOT EXISTS idx_spot_bot_skips_time ON spot_bot_skips(skipped_at DESC);
