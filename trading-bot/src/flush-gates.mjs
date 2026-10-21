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
  const maxPerDay = Number(envVars.FLUSH_EXEC_MAX_PER_DAY || DEFAULT_MAX_PER_DAY);
  const dailyLossPct = Number(envVars.FLUSH_EXEC_DAILY_LOSS_PCT || DEFAULT_DAILY_LOSS_PCT);
  return {
    enabled,
    notional: Number.isFinite(notional) && notional > 0 ? notional : null,
    maxConcurrent: Number.isFinite(maxConcurrent) && maxConcurrent > 0 ? Math.floor(maxConcurrent) : 1,
    leverage: Number.isFinite(leverage) && leverage > 0 ? leverage : 1,
    ttlMin: Number.isFinite(ttlMin) && ttlMin > 0 ? ttlMin : 20,
    maxPerDay: Number.isFinite(maxPerDay) && maxPerDay > 0 ? Math.floor(maxPerDay) : DEFAULT_MAX_PER_DAY,
    dailyLossPct: Number.isFinite(dailyLossPct) && dailyLossPct > 0 && dailyLossPct < 1
      ? dailyLossPct : DEFAULT_DAILY_LOSS_PCT
  };
}

// Daily backstops, added 2026-10-21 (questions spike S1). The operator asked
// for limits sized for someone who accepts risk, so these exist to stop a
// runaway — a bug that re-enters, an outage, a string of stop-outs in one bad
// session — not to ration ordinary trading.
//
// At $25 notional a stop-out costs about $1.60-2.30, so six entries a day can
// lose about $14 if every one is stopped. The loss stop is on the WHOLE
// account's realized result over the last 24 hours (the account is shared
// with the futures bot and manual trades): the same "loss / capital before
// the loss" measure bot-risk.mjs uses, at 15% where the futures bot uses 10%.
export const DEFAULT_MAX_PER_DAY = 6;
export const DEFAULT_DAILY_LOSS_PCT = 0.15;

// Refuses (returns a reason) when either backstop is reached or when the
// inputs needed to check them could not be read. Unknown is a refusal, like
// every other gate in this file.
export function dailyLimitReason({ submittedLast24h, netPnlLast24h, walletBalance }, gates) {
  if (!Number.isFinite(submittedLast24h)) return 'could not count this executor\'s entries in the last 24h';
  if (submittedLast24h >= gates.maxPerDay) {
    return `${submittedLast24h} entries in the last 24h reached the cap of ${gates.maxPerDay}`;
  }
  if (!Number.isFinite(netPnlLast24h) || !(walletBalance > 0)) {
    return 'could not read the account\'s result for the last 24h';
  }
  const loss = Math.max(0, -netPnlLast24h);
  const lossPct = loss / (walletBalance + loss);
  if (lossPct >= gates.dailyLossPct) {
    return `the account lost ${(lossPct * 100).toFixed(1)}% in the last 24h `
      + `(new entries stop at ${(gates.dailyLossPct * 100).toFixed(0)}%)`;
  }
  return null;
}

// The evidence this executor's one setup rests on was withdrawn on 2026-09-14.
//
// It trades "spike + open interest FELL" as a short-covering squeeze, on a
// measured 106% retrace. That measurement classified open interest by
// `sum_open_interest_value`, which is contracts x mark price and therefore
// carries the price move inside it (r = 0.910 with the same bar's return over
// 804k bars). Re-run on contracts over an independent 74-day window, the
// spike separation falls from -38.6 points of retrace (t = -7.75) to -4.9
// (t = -1.22). See signals-worker/docs/OI_MEASUREMENT_EVIDENCE.md.
//
// This file's stated rule is that every gate defaults to a refusal, so a setup
// whose evidence has been withdrawn defaults to a refusal too. It is one env
// var to override, deliberately, because the decision is the operator's:
//
//   FLUSH_EXEC_ALLOW_UNPROVEN=true
//
// This is NOT a claim that the setup loses money. It is that the number it was
// sized and justified on does not survive being measured correctly, so there is
// currently nothing behind it either way.
export const UNPROVEN_REASON =
  'the short-covering setup is unproven: its 106% retrace was measured on open interest in dollar '
  + 'value, which is mostly the price move again, and does not replicate on contracts '
  + '(t = -1.22). Set FLUSH_EXEC_ALLOW_UNPROVEN=true to trade it anyway.';

export function allowsUnproven(envVars = process.env) {
  return String(envVars.FLUSH_EXEC_ALLOW_UNPROVEN || '').toLowerCase() === 'true';
}

// The setup restriction the operator chose: only the short-covering spike.
// The dip case is excluded in CODE rather than in configuration so it cannot be
// re-enabled by editing an env file.
export function isTradeableSetup(event, envVars = process.env) {
  if (!event) return { ok: false, reason: 'no event' };
  if (!allowsUnproven(envVars)) return { ok: false, reason: UNPROVEN_REASON };
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
