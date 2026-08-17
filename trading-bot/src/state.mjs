// Local JSON-file-backed state — a single-VM bot doesn't need a database,
// just something that survives a process restart. Tracks what this bot
// itself has done (equity curve for drawdown/circuit-breaker math,
// per-symbol cooldown timestamps); actual position/balance truth always
// comes fresh from Binance each cycle (binance.mjs), never trusted from
// this file, so a stale or lost state file can't cause a double-open.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.mjs';

const DEFAULT_STATE = {
  peakEquity: null,
  dayStartEquity: null,
  dayStartDate: null,
  equityHistory: [], // [{ts, equity}], trimmed to the last 30 days
  lastClosedAt: {}, // symbol -> ISO timestamp of last position close, for cooldown
  openOrders: {} // symbol -> {side, entryPrice, marginUsed, leverage, stopOrderId, tpOrderId, openedAt} — bot's own record of what it opened, for logging/reconciliation only
};

mkdirSync(dirname(config.stateFile), { recursive: true });

export function loadState() {
  if (!existsSync(config.stateFile)) return structuredClone(DEFAULT_STATE);
  try {
    return { ...structuredClone(DEFAULT_STATE), ...JSON.parse(readFileSync(config.stateFile, 'utf8')) };
  } catch {
    return structuredClone(DEFAULT_STATE);
  }
}

export function saveState(state) {
  writeFileSync(config.stateFile, JSON.stringify(state, null, 2));
}

// Called once per cycle with the REAL current equity from Binance.
// Rolls the day-start marker at UTC midnight and appends to the trimmed
// history the drawdown/circuit-breaker check reads.
export function recordEquity(state, equity, nowIso) {
  const today = nowIso.slice(0, 10);
  if (state.dayStartDate !== today) {
    state.dayStartDate = today;
    state.dayStartEquity = equity;
  }
  if (state.peakEquity == null || equity > state.peakEquity) state.peakEquity = equity;
  state.equityHistory.push({ ts: nowIso, equity });
  const cutoffMs = Date.now() - 30 * 86400000;
  state.equityHistory = state.equityHistory.filter((e) => new Date(e.ts).getTime() >= cutoffMs);
  return state;
}
