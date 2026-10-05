-- Shadow ledger for the pump-fade lane (trading-bot/src/pump-fade.mjs,
-- docs/PUMP_FADE_EVIDENCE.md), 2026-10-05. One row per coin per UTC day: the
-- short the lane WOULD have opened after the day's first aligned 10% pump,
-- then its 24-hour result. Written by the Oracle host, never by the Worker.
-- No orders exist behind these rows. A handful of writes a day.
CREATE TABLE IF NOT EXISTS pump_fade_shadow (
  symbol TEXT NOT NULL,                -- engine symbol, e.g. PEPE
  venue_symbol TEXT NOT NULL,          -- Binance perp, e.g. 1000PEPEUSDT
  signal_day TEXT NOT NULL,            -- UTC date of the pump bar's close
  model_version TEXT NOT NULL,
  bar_close_ts INTEGER NOT NULL,       -- ms, close of the hourly bar that qualified
  bar_close_price REAL NOT NULL,
  lag_bars INTEGER NOT NULL DEFAULT 0, -- 1 = recorded an hour late after a missed run
  move_1h_pct REAL, move_3h_pct REAL, move_6h_pct REAL NOT NULL, move_24h_pct REAL,
  entry_ts INTEGER NOT NULL,           -- ms, when the shadow entry was taken
  entry_price REAL NOT NULL,           -- perp mark price at entry_ts
  stop_price REAL NOT NULL,
  funding_rate_at_entry REAL,
  detected_at TEXT NOT NULL,
  -- Outcome, NULL until the 24-hour hold has finished and been scored.
  settled_at TEXT,
  exit_ts INTEGER,
  exit_price REAL,
  exit_reason TEXT CHECK (exit_reason IS NULL OR exit_reason IN ('stop', 'time')),
  gross_pct REAL,                      -- short P&L on price alone
  funding_pct REAL,                    -- funding a short received (+) or paid (-)
  cost_pct REAL,
  net_pct REAL,
  max_adverse_pct REAL,
  max_favourable_pct REAL,
  PRIMARY KEY (symbol, signal_day)
);
CREATE INDEX IF NOT EXISTS idx_pump_fade_shadow_unsettled ON pump_fade_shadow(entry_ts) WHERE settled_at IS NULL;
