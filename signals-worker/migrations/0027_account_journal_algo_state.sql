-- Durable USDⓈ-M conditional-order state for account-journal provenance.
--
-- Binance documents time-window queries for allAlgoOrders but does not promise
-- that a parent created before a later rolling window will reappear when its
-- status changes. A stop or take-profit can remain open beyond the journal's
-- overlap window and only acquire actual_order_id when it later triggers.
-- Retaining the parent algo ID lets the read-only journal poll that exact order
-- until it becomes terminal, rather than losing the clientAlgoId -> fill
-- orderId ownership link.
CREATE TABLE IF NOT EXISTS account_journal_futures_algos (
  symbol TEXT NOT NULL,
  algo_id TEXT NOT NULL,
  client_algo_id TEXT,
  actual_order_id TEXT,
  side TEXT CHECK (side IS NULL OR side IN ('BUY', 'SELL')),
  order_type TEXT,
  actual_type TEXT,
  algo_status TEXT,
  create_time_ms INTEGER,
  update_time_ms INTEGER,
  trigger_time_ms INTEGER,
  last_polled_at TEXT,
  polling_closed_at TEXT,
  ingested_at TEXT NOT NULL,
  PRIMARY KEY (symbol, algo_id)
);

CREATE INDEX IF NOT EXISTS idx_account_journal_algos_pending
  ON account_journal_futures_algos(last_polled_at, symbol)
  WHERE actual_order_id IS NULL AND polling_closed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_account_journal_algos_actual_order
  ON account_journal_futures_algos(symbol, actual_order_id)
  WHERE actual_order_id IS NOT NULL;
