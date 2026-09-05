// D1-backed state — this bot runs as a one-shot script fired every N
// minutes by .github/workflows/trading-bot-cycle.yml, not a persistent
// daemon, so there's no local disk that survives between runs. Reuses
// the same d1-client.mjs (and D1 database) the rest of this repo's
// scripts already use — one source of truth for how to talk to D1,
// not a hand-copied duplicate. Actual position/balance truth always
// comes fresh from Binance each cycle (binance.mjs), never trusted from
// here, so a stale or lost row here can't cause a double-open.
import { d1 } from '../../signals-worker/scripts/d1-client.mjs';
import { config } from './config.mjs';

const env = { CLOUDFLARE_API_TOKEN: config.cloudflareApiToken, CLOUDFLARE_ACCOUNT_ID: config.cloudflareAccountId, FCS_D1_DATABASE_ID: config.d1DatabaseId };

export async function loadState() {
  const [equityRow] = await d1(env, 'SELECT peak_equity, day_start_equity, day_start_date FROM trading_bot_equity_state WHERE id = 1');
  const lastClosedRows = await d1(env, 'SELECT symbol, closed_at FROM trading_bot_last_closed');
  const openOrderRows = await d1(env, 'SELECT symbol, side, entry_price, margin_used, leverage, range_low, range_high, target_price, stop_price, time_exit_after_ms, source, opened_at FROM trading_bot_open_orders');

  return {
    peakEquity: equityRow?.peak_equity ?? null,
    dayStartEquity: equityRow?.day_start_equity ?? null,
    dayStartDate: equityRow?.day_start_date ?? null,
    lastClosedAt: Object.fromEntries(lastClosedRows.map((r) => [r.symbol, r.closed_at])),
    openOrders: Object.fromEntries(openOrderRows.map((r) => [r.symbol, {
      side: r.side, entryPrice: r.entry_price, marginUsed: r.margin_used, leverage: r.leverage,
      range: r.range_low != null ? { low: r.range_low, high: r.range_high } : null,
      targetPrice: r.target_price ?? null,
      stopPrice: r.stop_price ?? null,
      timeExitAfterMs: r.time_exit_after_ms ?? null,
      source: r.source ?? null,
      openedAt: r.opened_at
    }]))
  };
}

// Called once at the end of a cycle. Diffs against nothing — just
// upserts the current in-memory state wholesale, since a single cycle's
// worth of changes is always small (at most a few symbols touched).
export async function saveState(state) {
  await d1(env, `
    INSERT INTO trading_bot_equity_state (id, peak_equity, day_start_equity, day_start_date) VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET peak_equity = excluded.peak_equity, day_start_equity = excluded.day_start_equity, day_start_date = excluded.day_start_date
  `, [state.peakEquity, state.dayStartEquity, state.dayStartDate]);

  for (const [symbol, closedAt] of Object.entries(state.lastClosedAt)) {
    await d1(env, 'INSERT INTO trading_bot_last_closed (symbol, closed_at) VALUES (?, ?) ON CONFLICT(symbol) DO UPDATE SET closed_at = excluded.closed_at', [symbol, closedAt]);
  }

  const stillOpenSymbols = Object.keys(state.openOrders);
  for (const [symbol, o] of Object.entries(state.openOrders)) {
    await d1(env, `
      INSERT INTO trading_bot_open_orders (symbol, side, entry_price, margin_used, leverage, range_low, range_high, target_price, stop_price, time_exit_after_ms, source, opened_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(symbol) DO UPDATE SET side = excluded.side, entry_price = excluded.entry_price, margin_used = excluded.margin_used, leverage = excluded.leverage, range_low = excluded.range_low, range_high = excluded.range_high, target_price = excluded.target_price, stop_price = excluded.stop_price, time_exit_after_ms = excluded.time_exit_after_ms, source = excluded.source, opened_at = excluded.opened_at
    `, [symbol, o.side, o.entryPrice, o.marginUsed, o.leverage, o.range?.low ?? null, o.range?.high ?? null, o.targetPrice ?? null, o.stopPrice ?? null, o.timeExitAfterMs ?? null, o.source ?? null, o.openedAt]);
  }
  // Positions this cycle detected as closed (see index.mjs) were already
  // deleted from state.openOrders in-memory before this is called —
  // remove their D1 rows too, otherwise they'd linger forever.
  const existing = await d1(env, 'SELECT symbol FROM trading_bot_open_orders');
  for (const row of existing) {
    if (!stillOpenSymbols.includes(row.symbol)) {
      await d1(env, 'DELETE FROM trading_bot_open_orders WHERE symbol = ?', [row.symbol]);
    }
  }
}

// Called once per cycle with the REAL current equity from Binance. Rolls
// the day-start marker at UTC midnight.
export function recordEquity(state, equity, nowIso) {
  const today = nowIso.slice(0, 10);
  if (state.dayStartDate !== today) {
    state.dayStartDate = today;
    state.dayStartEquity = equity;
  }
  if (state.peakEquity == null || equity > state.peakEquity) state.peakEquity = equity;
  return state;
}
