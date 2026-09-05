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
  const openOrderRows = await d1(env, 'SELECT symbol, side, entry_price, margin_used, leverage, range_low, range_high, target_price, stop_price, time_exit_after_ms, source, entry_evidence, opened_at FROM trading_bot_open_orders');

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
      openedAt: r.opened_at,
      // Frozen at open; see the entry_evidence note in migration 0017.
      ...(() => { try { return JSON.parse(r.entry_evidence || '{}'); } catch { return {}; } })()
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
      INSERT INTO trading_bot_open_orders (symbol, side, entry_price, margin_used, leverage, range_low, range_high, target_price, stop_price, time_exit_after_ms, source, entry_evidence, opened_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(symbol) DO UPDATE SET side = excluded.side, entry_price = excluded.entry_price, margin_used = excluded.margin_used, leverage = excluded.leverage, range_low = excluded.range_low, range_high = excluded.range_high, target_price = excluded.target_price, stop_price = excluded.stop_price, time_exit_after_ms = excluded.time_exit_after_ms, source = excluded.source, entry_evidence = excluded.entry_evidence, opened_at = excluded.opened_at
    `, [symbol, o.side, o.entryPrice, o.marginUsed, o.leverage, o.range?.low ?? null, o.range?.high ?? null, o.targetPrice ?? null, o.stopPrice ?? null, o.timeExitAfterMs ?? null, o.source ?? null,
        JSON.stringify({
          edge: o.edge ?? null, horizonHours: o.horizonHours ?? null,
          holdingMfePct: o.holdingMfePct ?? null, holdingMaePct: o.holdingMaePct ?? null,
          holdingHoursToPeak: o.holdingHoursToPeak ?? null,
          extremeBoost: !!o.extremeBoost, equityAtOpen: o.equityAtOpen ?? null
        }), o.openedAt]);
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

// ---------------------------------------------------------------------------
// Long-horizon record (migration 0017). The shadow ledger stores DECISIONS;
// these store OUTCOMES and the account's value through time, so the question
// "did the model's edge estimate actually predict anything" can be asked from
// data rather than from memory.
// ---------------------------------------------------------------------------

export async function recordTrade(t) {
  await d1(env, `
    INSERT INTO trading_bot_trades
      (symbol, side, origin, source, opened_at, closed_at, entry_price, exit_price,
       quantity, leverage, margin_used, realized_pnl, commission, funding_fee, net_pnl,
       return_on_margin_pct, holding_minutes, exit_reason, edge, horizon_hours,
       holding_mfe_pct, holding_mae_pct, holding_hours_to_peak, extreme_boost,
       equity_at_open, equity_at_close)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT DO NOTHING
  `, [
    t.symbol, t.side, t.origin, t.source ?? null, t.openedAt ?? null, t.closedAt,
    t.entryPrice ?? null, t.exitPrice ?? null, t.quantity ?? null, t.leverage ?? null,
    t.marginUsed ?? null, t.realizedPnl ?? null, t.commission ?? null, t.fundingFee ?? null,
    t.netPnl ?? null, t.returnOnMarginPct ?? null, t.holdingMinutes ?? null,
    t.exitReason ?? null, t.edge ?? null, t.horizonHours ?? null,
    t.holdingMfePct ?? null, t.holdingMaePct ?? null, t.holdingHoursToPeak ?? null,
    t.extremeBoost ? 1 : 0, t.equityAtOpen ?? null, t.equityAtClose ?? null
  ]);
}

// Bucketed to 15 minutes so a 5-minute cadence cannot grow this without bound
// while keeping enough resolution to see a drawdown that matters.
export async function logEquity(nowIso, equity, openPositions, unrealizedPnl) {
  const d = new Date(nowIso);
  d.setUTCMinutes(Math.floor(d.getUTCMinutes() / 15) * 15, 0, 0);
  await d1(env, `
    INSERT INTO trading_bot_equity_log (bucket, observed_at, equity, open_positions, unrealized_pnl)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(bucket) DO UPDATE SET
      observed_at = excluded.observed_at, equity = excluded.equity,
      open_positions = excluded.open_positions, unrealized_pnl = excluded.unrealized_pnl
  `, [d.toISOString(), nowIso, equity, openPositions, unrealizedPnl ?? null]);
}

export async function recordRiskAlert(a) {
  await d1(env, `
    INSERT INTO trading_bot_risk_alerts
      (raised_at, symbol, severity, reason, mark_price, liquidation_price,
       distance_to_liquidation_pct, unrealized_pnl, unrealized_vs_equity_pct, equity, action_taken)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [a.raisedAt, a.symbol, a.severity, a.reason, a.markPrice ?? null,
      a.liquidationPrice ?? null, a.distanceToLiquidationPct ?? null,
      a.unrealizedPnl ?? null, a.unrealizedVsEquityPct ?? null, a.equity ?? null,
      a.actionTaken ?? null]);
}

// Realised performance, split by origin so the operator's own trades are never
// pooled with the model's. Reported each cycle so the job log carries it.
export async function tradeSummary() {
  return d1(env, `
    SELECT origin, COUNT(*) AS n,
           SUM(CASE WHEN net_pnl > 0 THEN 1 ELSE 0 END) AS wins,
           ROUND(SUM(net_pnl), 4) AS net_pnl,
           ROUND(AVG(return_on_margin_pct), 3) AS avg_return_on_margin_pct,
           ROUND(AVG(holding_minutes), 1) AS avg_hold_minutes
    FROM trading_bot_trades GROUP BY origin
  `);
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
