-- Read-path support for the private journal's durable filters. The journal has
-- no automatic expiry policy; this migration contains no delete, update,
-- retention, or rebuild operation. Storage still has finite platform capacity.
--
-- Existing indexes already cover time, origin/market/time, and
-- market/symbol/time. These two fill the material gaps without adding an
-- index for every low-cardinality filter or display-only sort.
CREATE INDEX IF NOT EXISTS idx_account_journal_fills_symbol_time
  ON account_journal_fills(symbol, event_time DESC);

CREATE INDEX IF NOT EXISTS idx_account_journal_fills_reported_pnl
  ON account_journal_fills(realized_pnl, event_time DESC)
  WHERE market = 'futures' AND realized_pnl IS NOT NULL;
