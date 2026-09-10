-- Durable audit trail for the futures bot's resting entry policy.
-- One row is retained whether the exact intent fills, expires, is canceled on
-- an ownership conflict, or is only a dry/shadow proposal.
CREATE TABLE IF NOT EXISTS trading_bot_entry_intents (
  client_order_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'dry', 'shadow')),
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  filled_at TEXT,
  canceled_at TEXT,
  closed_at TEXT,
  asset_class TEXT NOT NULL CHECK (asset_class IN ('crypto', 'stock')),
  symbol TEXT NOT NULL,
  signal_symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  source TEXT NOT NULL,
  signal_generated_at TEXT,
  signal_price_at TEXT NOT NULL,
  signal_price REAL NOT NULL CHECK (signal_price > 0),
  mark_price_at_order REAL CHECK (mark_price_at_order IS NULL OR mark_price_at_order > 0),
  limit_price REAL NOT NULL CHECK (limit_price > 0),
  offset_pct REAL NOT NULL CHECK (offset_pct > 0),
  offset_basis TEXT NOT NULL,
  median_daily_move_pct REAL,
  absolute_24h_move_pct REAL,
  adverse_excursion_pct REAL,
  adverse_basis TEXT,
  wrong_call_samples INTEGER,
  conservative_edge REAL,
  position_pct REAL,
  leverage INTEGER,
  requested_qty REAL,
  filled_qty REAL,
  avg_fill_price REAL,
  stop_price REAL,
  target_price REAL,
  time_exit_after_ms REAL,
  horizon_hours REAL,
  cancel_reason TEXT,
  final_net_pnl REAL,
  final_return_on_margin_pct REAL,
  exit_reason TEXT,
  first_touch_bar_at TEXT,
  observation_count INTEGER,
  observed_low REAL,
  observed_high REAL,
  closest_distance_pct REAL,
  research_resolved_at TEXT,
  resolution_basis TEXT,
  evidence_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_entry_intents_symbol_time
  ON trading_bot_entry_intents(symbol, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_entry_intents_status_expiry
  ON trading_bot_entry_intents(mode, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_entry_intents_research_pending
  ON trading_bot_entry_intents(asset_class, expires_at)
  WHERE mode IN ('dry', 'shadow') AND status IN ('proposed', 'awaiting-bars');
