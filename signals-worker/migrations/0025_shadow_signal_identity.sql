-- A five-minute resolver can close a short-horizon shadow trade while the
-- hourly signals payload is still unchanged. Without the immutable signal
-- timestamp, the next cycle records the same decision again and inflates the
-- apparent sample size. Existing rows remain valid historical observations;
-- prospective rows are one per exact signal decision.

ALTER TABLE trading_bot_shadow_trades ADD COLUMN signal_generated_at TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_shadow_signal_identity
  ON trading_bot_shadow_trades(mode, source, symbol, side, signal_generated_at)
  WHERE signal_generated_at IS NOT NULL;
