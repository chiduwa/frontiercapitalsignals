// Pure gating logic for the flush executor, deliberately in its own file.
//
// src/config.mjs validates credentials at import and calls process.exit(1) when
// they are absent, and binance.mjs imports it — so anything that pulls in the
// order path cannot be unit tested without production secrets. These are the
// rules that decide whether real money moves, so they are exactly the part that
// must be testable. No imports, no I/O.
import { MAX_LEVERAGE } from '../../signals-worker/scripts/flush-entry.mjs';

export const FLUSH_EXEC_VERSION = 'flush-exec-v1';

// Every gate defaults to a refusal. An accidental deploy trades nothing.
export function loadGates(envVars = process.env) {
  const enabled = String(envVars.FLUSH_EXEC_ENABLED || '').toLowerCase() === 'true';
  // REQUIRED, no default. Position size is the operator's decision and there is
  // no safe number to guess on their behalf.
  const notional = Number(envVars.FLUSH_EXEC_NOTIONAL_USD);
  const maxConcurrent = Number(envVars.FLUSH_EXEC_MAX_CONCURRENT || 1);
  const leverage = Math.min(Number(envVars.FLUSH_EXEC_LEVERAGE || MAX_LEVERAGE), MAX_LEVERAGE);
  const ttlMin = Number(envVars.FLUSH_EXEC_TTL_MIN || 20);
  return {
    enabled,
    notional: Number.isFinite(notional) && notional > 0 ? notional : null,
    maxConcurrent: Number.isFinite(maxConcurrent) && maxConcurrent > 0 ? Math.floor(maxConcurrent) : 1,
    leverage: Number.isFinite(leverage) && leverage > 0 ? leverage : 1,
    ttlMin: Number.isFinite(ttlMin) && ttlMin > 0 ? ttlMin : 20
  };
}

// The setup restriction the operator chose: only the short-covering spike,
// which carries a 1.22 reward:risk and a measured 106% retrace. The dip case
// (0.60 R:R, dependent on a 15% stop holding) is excluded in CODE rather than
// in configuration so it cannot be re-enabled by editing an env file.
export function isTradeableSetup(event) {
  if (!event) return { ok: false, reason: 'no event' };
  if (event.direction !== 'up') {
    return { ok: false, reason: 'only up-spikes are traded by this executor; the dip case was excluded on payoff grounds' };
  }
  if (event.classification !== 'liquidation') {
    return {
      ok: false,
      reason: `open interest ${event.classification === 'new-position' ? 'ROSE' : 'did not move decisively'} `
        + 'through the spike — not a short-covering squeeze'
    };
  }
  return { ok: true };
}

// Quantity from notional. Rounds DOWN: rounding up would silently push the
// position past the configured cap.
export function quantityFor(notionalUsd, price, stepSize) {
  if (!(notionalUsd > 0) || !(price > 0)) return null;
  const raw = notionalUsd / price;
  if (!(stepSize > 0)) return raw;
  const steps = Math.floor(raw / stepSize);
  return steps > 0 ? steps * stepSize : null;
}
