-- Read-only Binance account journal.
--
-- This ledger is deliberately independent of the trading bots' outcome
-- tables. It records exchange fills as exchange facts, then attaches a
-- conservative provenance label:
--   bot     -- exact bot order evidence exists
--   manual  -- the operator explicitly identified the order (or used an
--              explicitly configured manual client-order prefix)
--   unknown -- everything else
--
-- In particular, "not found in a bot table" does NOT prove "manual". Older
-- bot orders did not consistently carry durable client order IDs, and Binance
-- does not expose an official UI-vs-API origin field in trade history.
CREATE TABLE IF NOT EXISTS account_journal_orders (
  market TEXT NOT NULL CHECK (market IN ('spot', 'futures')),
  symbol TEXT NOT NULL,
  order_id TEXT NOT NULL,
  client_order_id TEXT,
  side TEXT CHECK (side IS NULL OR side IN ('BUY', 'SELL')),
  order_type TEXT,
  status TEXT,
  order_time TEXT,
  updated_time TEXT,
  ingested_at TEXT NOT NULL,
  PRIMARY KEY (market, symbol, order_id)
);

CREATE INDEX IF NOT EXISTS idx_account_journal_orders_client
  ON account_journal_orders(market, client_order_id)
  WHERE client_order_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS account_journal_fills (
  market TEXT NOT NULL CHECK (market IN ('spot', 'futures')),
  symbol TEXT NOT NULL,
  trade_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  client_order_id TEXT,
  event_time TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  -- Futures may be BOTH (one-way mode), LONG, or SHORT. Spot has no position
  -- side and therefore stores NULL rather than inventing one.
  position_side TEXT CHECK (position_side IS NULL OR position_side IN ('BOTH', 'LONG', 'SHORT')),
  price REAL NOT NULL CHECK (price > 0),
  quantity REAL NOT NULL CHECK (quantity > 0),
  quote_quantity REAL CHECK (quote_quantity IS NULL OR quote_quantity >= 0),
  -- Binance supplies realizedPnl on futures fills. Spot myTrades does not, so
  -- this remains NULL for spot; no synthetic cost-basis P&L is written here.
  realized_pnl REAL,
  commission REAL CHECK (commission IS NULL OR commission >= 0),
  commission_asset TEXT,
  is_maker INTEGER CHECK (is_maker IS NULL OR is_maker IN (0, 1)),
  origin TEXT NOT NULL CHECK (origin IN ('bot', 'manual', 'unknown')),
  classification_method TEXT NOT NULL,
  classification_evidence TEXT,
  ingested_at TEXT NOT NULL,
  PRIMARY KEY (market, symbol, trade_id),
  FOREIGN KEY (market, symbol, order_id)
    REFERENCES account_journal_orders(market, symbol, order_id)
);

CREATE INDEX IF NOT EXISTS idx_account_journal_fills_time
  ON account_journal_fills(event_time DESC);
CREATE INDEX IF NOT EXISTS idx_account_journal_fills_origin
  ON account_journal_fills(origin, market, event_time DESC);
CREATE INDEX IF NOT EXISTS idx_account_journal_fills_order
  ON account_journal_fills(market, symbol, order_id);
CREATE INDEX IF NOT EXISTS idx_account_journal_fills_symbol
  ON account_journal_fills(market, symbol, event_time DESC);
CREATE INDEX IF NOT EXISTS idx_account_journal_fills_ingested
  ON account_journal_fills(origin, ingested_at);

-- Exact human-reviewed ownership. A future authenticated dashboard can write
-- this one small table; the ingestion service remains read-only at Binance.
-- UNKNOWN is represented by absence of an override, not by a sticky row.
CREATE TABLE IF NOT EXISTS account_journal_origin_overrides (
  market TEXT NOT NULL CHECK (market IN ('spot', 'futures')),
  symbol TEXT NOT NULL,
  order_id TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('bot', 'manual')),
  note TEXT,
  set_at TEXT NOT NULL,
  PRIMARY KEY (market, symbol, order_id)
);

-- Cursors advance only after every idempotent upsert in a page succeeds. A
-- process crash can therefore replay stored rows but cannot skip a fill.
-- last_trade_id is TEXT because exchange IDs are identifiers, not quantities
-- to aggregate.
CREATE TABLE IF NOT EXISTS account_journal_checkpoints (
  market TEXT NOT NULL CHECK (market IN ('spot', 'futures')),
  symbol TEXT NOT NULL,
  stream TEXT NOT NULL CHECK (stream IN ('trades', 'orders')),
  last_trade_id TEXT,
  cursor_time_ms INTEGER,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (market, symbol, stream)
);

CREATE TABLE IF NOT EXISTS account_journal_runs (
  run_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'ok', 'partial', 'failed')),
  markets_requested INTEGER NOT NULL DEFAULT 0,
  symbols_requested INTEGER NOT NULL DEFAULT 0,
  fills_seen INTEGER NOT NULL DEFAULT 0,
  pages_read INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  error_summary TEXT
);

CREATE INDEX IF NOT EXISTS idx_account_journal_runs_time
  ON account_journal_runs(started_at DESC);

-- Materialized, origin-separated daily analytics. These can be served by an
-- authenticated Worker or formatted for a notification without rescanning
-- every fill. realized_pnl stays NULL for spot because Binance spot trade
-- history provides no realized P&L.
CREATE TABLE IF NOT EXISTS account_journal_daily_stats (
  day TEXT NOT NULL,
  market TEXT NOT NULL CHECK (market IN ('spot', 'futures')),
  origin TEXT NOT NULL CHECK (origin IN ('bot', 'manual', 'unknown')),
  symbol TEXT NOT NULL,
  fill_count INTEGER NOT NULL,
  order_count INTEGER NOT NULL,
  buy_fill_count INTEGER NOT NULL,
  sell_fill_count INTEGER NOT NULL,
  buy_quantity REAL NOT NULL,
  sell_quantity REAL NOT NULL,
  buy_quote_quantity REAL NOT NULL,
  sell_quote_quantity REAL NOT NULL,
  realized_pnl REAL,
  first_fill_at TEXT NOT NULL,
  last_fill_at TEXT NOT NULL,
  refreshed_at TEXT NOT NULL,
  PRIMARY KEY (day, market, origin, symbol)
);

CREATE INDEX IF NOT EXISTS idx_account_journal_daily_origin
  ON account_journal_daily_stats(origin, day DESC, market);

-- Commissions cannot be truthfully added across BNB, USDT, BTC, and other fee
-- assets without a timestamped FX conversion. Keep one total per fee asset.
CREATE TABLE IF NOT EXISTS account_journal_daily_fees (
  day TEXT NOT NULL,
  market TEXT NOT NULL CHECK (market IN ('spot', 'futures')),
  origin TEXT NOT NULL CHECK (origin IN ('bot', 'manual', 'unknown')),
  symbol TEXT NOT NULL,
  commission_asset TEXT NOT NULL,
  commission_amount REAL NOT NULL,
  refreshed_at TEXT NOT NULL,
  PRIMARY KEY (day, market, origin, symbol, commission_asset)
);

CREATE VIEW IF NOT EXISTS account_journal_manual_fills AS
  SELECT * FROM account_journal_fills WHERE origin = 'manual';

CREATE VIEW IF NOT EXISTS account_journal_review_queue AS
  SELECT * FROM account_journal_fills WHERE origin = 'unknown';

CREATE VIEW IF NOT EXISTS account_journal_origin_summary AS
  SELECT
    market,
    origin,
    COUNT(*) AS fill_count,
    COUNT(DISTINCT symbol || ':' || order_id) AS order_count,
    COUNT(DISTINCT symbol) AS symbol_count,
    MIN(event_time) AS first_fill_at,
    MAX(event_time) AS last_fill_at,
    SUM(CASE WHEN side = 'BUY' THEN COALESCE(quote_quantity, 0) ELSE 0 END) AS buy_quote_quantity,
    SUM(CASE WHEN side = 'SELL' THEN COALESCE(quote_quantity, 0) ELSE 0 END) AS sell_quote_quantity,
    CASE WHEN market = 'futures' THEN SUM(realized_pnl) ELSE NULL END AS realized_pnl
  FROM account_journal_fills
  GROUP BY market, origin;
