// Cross-process lease for one-shot trading cycles.
//
// Binance client order IDs are unique only while an order is open. They are
// still valuable for timeout reconciliation, but they cannot by themselves
// stop two concurrent processes from both observing "not found" and then
// submitting the same MARKET intent. This D1 compare-and-swap lease is the
// first operation in each bot process, so systemd, a manual invocation, or a
// second host cannot overlap an execution cycle.
import { randomUUID } from 'node:crypto';
import { d1 } from './d1-client.mjs';

export async function acquireExecutionLease(env, name, ttlSeconds, query = d1) {
  const ttl = Math.max(1, Math.floor(Number(ttlSeconds) || 0));
  const owner = randomUUID();
  const rows = await query(env, `
    INSERT INTO trading_execution_leases
      (name, owner, acquired_at, expires_at)
    VALUES (?, ?, unixepoch('now'), unixepoch('now') + ?)
    ON CONFLICT(name) DO UPDATE SET
      owner = excluded.owner,
      acquired_at = excluded.acquired_at,
      expires_at = excluded.expires_at
    WHERE trading_execution_leases.expires_at <= unixepoch('now')
    RETURNING owner, expires_at
  `, [name, owner, ttl]);
  return rows?.[0]?.owner === owner
    ? { name, owner, expiresAtSeconds: Number(rows[0].expires_at) }
    : null;
}

export async function releaseExecutionLease(env, lease, query = d1) {
  if (!lease?.name || !lease?.owner) return false;
  const rows = await query(env, `
    DELETE FROM trading_execution_leases
    WHERE name = ? AND owner = ?
    RETURNING owner
  `, [lease.name, lease.owner]);
  return rows?.[0]?.owner === lease.owner;
}
