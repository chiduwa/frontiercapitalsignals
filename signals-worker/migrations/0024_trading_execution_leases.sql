-- An exchange client-order ID is not a permanent idempotency key: Binance may
-- accept the same ID again after the earlier order is FILLED. Serialize each
-- one-shot bot across systemd/manual/other-host invocations before it can read
-- state or submit an order. Expiry makes a killed process self-healing.

CREATE TABLE IF NOT EXISTS trading_execution_leases (
  name TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  CHECK (expires_at > acquired_at)
);

CREATE INDEX IF NOT EXISTS idx_trading_execution_leases_expiry
  ON trading_execution_leases(expires_at);
