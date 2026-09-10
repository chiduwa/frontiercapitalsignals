// D1-backed state — the decision and protection workers run as one-shot
// systemd services, not persistent daemons, so durable coordination cannot
// depend on process memory or local disk. Reuses
// the same d1-client.mjs (and D1 database) the rest of this repo's
// scripts already use — one source of truth for how to talk to D1,
// not a hand-copied duplicate. Actual position/balance truth always
// comes fresh from Binance each cycle (binance.mjs), never trusted from
// here, so a stale or lost row here can't cause a double-open.
import { d1, d1Batch } from '../../signals-worker/scripts/d1-client.mjs';
import { acquireExecutionLease as acquireLease, releaseExecutionLease as releaseLease } from '../../signals-worker/scripts/execution-lease.mjs';
import { config } from './config.mjs';
import { assessLimitReachability } from './entry-research.mjs';

const env = { CLOUDFLARE_API_TOKEN: config.cloudflareApiToken, CLOUDFLARE_ACCOUNT_ID: config.cloudflareAccountId, FCS_D1_DATABASE_ID: config.d1DatabaseId };

// The decision service is hard-killed after 180 seconds. A 210-second lease
// covers a legitimate run plus clock/network jitter while limiting a killed
// process's stale lock to about 30 seconds; a 30-minute lease would defeat the
// fast fill-protection supervisor after a crash.
export const acquireExecutionLease = (ttlSeconds = 210) =>
  acquireLease(env, 'futures-cycle', ttlSeconds);

export const releaseExecutionLease = (lease) => releaseLease(env, lease);

export async function hasTrackedOpenOrders() {
  const [row] = await d1(env, 'SELECT 1 AS present FROM trading_bot_open_orders LIMIT 1');
  return row?.present === 1;
}

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
          extremeBoost: !!o.extremeBoost, equityAtOpen: o.equityAtOpen ?? null,
          entryClientOrderId: o.entryClientOrderId ?? null,
          entryExecutedQty: o.entryExecutedQty ?? null,
          entryRequestedQty: o.entryRequestedQty ?? null,
          entryOrderPending: !!o.entryOrderPending,
          entrySubmissionUnknownAt: o.entrySubmissionUnknownAt ?? null,
          entryOrderType: o.entryOrderType ?? null,
          entryLimitPrice: o.entryLimitPrice ?? null,
          entryExpiresAt: o.entryExpiresAt ?? null,
          entryPlacedAt: o.entryPlacedAt ?? null,
          entryFilledAt: o.entryFilledAt ?? null,
          ownershipVerified: o.ownershipVerified === true,
          ownershipConflict: o.ownershipConflict === true,
          signalPrice: o.signalPrice ?? null,
          signalPriceAt: o.signalPriceAt ?? null,
          entryOffsetPct: o.entryOffsetPct ?? null,
          entryOffsetBasis: o.entryOffsetBasis ?? null,
          wrongCallSamples: o.wrongCallSamples ?? null,
          assetClass: o.assetClass ?? null,
          worstTradePct: o.worstTradePct ?? null,
          timeExitClientOrderId: o.timeExitClientOrderId ?? null,
          timeExitRequestedQty: o.timeExitRequestedQty ?? null,
          timeExitPositionBefore: o.timeExitPositionBefore ?? null,
          timeExitOrderPending: !!o.timeExitOrderPending,
          timeExitSubmissionUnknownAt: o.timeExitSubmissionUnknownAt ?? null,
          exitReason: o.exitReason ?? null,
          outcomePending: o.outcomePending === true,
          closedDetectedAt: o.closedDetectedAt ?? null,
          protectionOrders: Array.isArray(o.protectionOrders) ? o.protectionOrders : []
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

// Immutable limit-entry proposal plus lifecycle updates. Unlike journald this
// survives indefinitely and retains unfilled/expired orders, which is the
// evidence needed to evaluate whether each asset's offset was too near, too
// far, or appropriately timed. No row here authorizes an order.
const nullableTextEqual = (actual, expected) =>
  (actual == null ? null : String(actual)) === (expected == null ? null : String(expected));
const nullableNumberEqual = (actual, expected) => {
  if (actual == null || expected == null) return actual == null && expected == null;
  const a = Number(actual);
  const b = Number(expected);
  return Number.isFinite(a) && Number.isFinite(b)
    && Math.abs(a - b) <= Math.max(1e-12, Math.abs(b) * 1e-10);
};

export function entryIntentMatches(row, i) {
  if (!row || !i) return false;
  const textFields = [
    ['client_order_id', i.clientOrderId], ['mode', i.mode],
    ['expires_at', i.expiresAt], ['asset_class', i.assetClass],
    ['symbol', i.symbol], ['signal_symbol', i.signalSymbol],
    ['side', i.side], ['source', i.source],
    ['signal_price_at', i.signalPriceAt], ['offset_basis', i.offsetBasis]
  ];
  const numericFields = [
    ['signal_price', i.signalPrice], ['limit_price', i.limitPrice],
    ['offset_pct', i.offsetPct], ['position_pct', i.positionPct ?? null],
    ['leverage', i.leverage ?? null], ['requested_qty', i.requestedQty ?? null],
    ['stop_price', i.stopPrice ?? null], ['target_price', i.targetPrice ?? null],
    ['time_exit_after_ms', i.timeExitAfterMs ?? null],
    ['horizon_hours', i.horizonHours ?? null]
  ];
  return textFields.every(([field, expected]) => nullableTextEqual(row[field], expected))
    && numericFields.every(([field, expected]) => nullableNumberEqual(row[field], expected));
}

export async function recordEntryIntent(i) {
  await d1(env, `
    INSERT INTO trading_bot_entry_intents
      (client_order_id, mode, status, created_at, updated_at, expires_at,
       asset_class, symbol, signal_symbol, side, source, signal_generated_at,
       signal_price_at, signal_price, mark_price_at_order, limit_price,
       offset_pct, offset_basis, median_daily_move_pct, absolute_24h_move_pct,
       adverse_excursion_pct, adverse_basis, wrong_call_samples,
       conservative_edge, position_pct, leverage, requested_qty, stop_price,
       target_price, time_exit_after_ms, horizon_hours, evidence_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(client_order_id) DO NOTHING
  `, [
    i.clientOrderId, i.mode, i.status, i.createdAt, i.createdAt, i.expiresAt,
    i.assetClass, i.symbol, i.signalSymbol, i.side, i.source,
    i.signalGeneratedAt ?? null, i.signalPriceAt, i.signalPrice,
    i.markPriceAtOrder ?? null, i.limitPrice, i.offsetPct, i.offsetBasis,
    i.medianDailyMovePct ?? null, i.absolute24hMovePct ?? null,
    i.adverseExcursionPct ?? null, i.adverseBasis ?? null,
    i.wrongCallSamples ?? null, i.conservativeEdge ?? null,
    i.positionPct ?? null, i.leverage ?? null, i.requestedQty ?? null,
    i.stopPrice ?? null, i.targetPrice ?? null, i.timeExitAfterMs ?? null,
    i.horizonHours ?? null, JSON.stringify(i.evidence || {})
  ]);
  const [stored] = await d1(env, `
    SELECT client_order_id, mode, expires_at, asset_class, symbol,
           signal_symbol, side, source, signal_generated_at, signal_price_at,
           signal_price, limit_price, offset_pct, offset_basis, position_pct,
           leverage, requested_qty, stop_price, target_price,
           time_exit_after_ms, horizon_hours
    FROM trading_bot_entry_intents WHERE client_order_id = ?
  `, [i.clientOrderId]);
  if (!entryIntentMatches(stored, i)) {
    const error = new Error(`durable entry intent ${i.clientOrderId} does not match the frozen proposal`);
    error.entryIntentMismatch = true;
    throw error;
  }
  return stored;
}

export async function updateEntryIntent(clientOrderId, u) {
  await d1(env, `
    UPDATE trading_bot_entry_intents SET
      status = ?, updated_at = ?,
      filled_at = COALESCE(?, filled_at),
      canceled_at = COALESCE(?, canceled_at),
      filled_qty = COALESCE(?, filled_qty),
      avg_fill_price = COALESCE(?, avg_fill_price),
      stop_price = COALESCE(?, stop_price),
      target_price = COALESCE(?, target_price),
      cancel_reason = COALESCE(?, cancel_reason)
    WHERE client_order_id = ?
  `, [u.status, u.updatedAt, u.filledAt ?? null, u.canceledAt ?? null,
      u.filledQty ?? null, u.avgFillPrice ?? null, u.stopPrice ?? null,
      u.targetPrice ?? null, u.cancelReason ?? null, clientOrderId]);
}

export async function finalizeEntryIntent(clientOrderId, u) {
  if (!clientOrderId) return;
  await d1(env, `
    UPDATE trading_bot_entry_intents SET
      status = 'closed', updated_at = ?, closed_at = ?,
      final_net_pnl = ?, final_return_on_margin_pct = ?, exit_reason = ?
    WHERE client_order_id = ?
  `, [u.closedAt, u.closedAt, u.netPnl ?? null,
      u.returnOnMarginPct ?? null, u.exitReason ?? null, clientOrderId]);
}

export async function loadActiveEntryIntentSymbols(mode, nowIso) {
  const rows = await d1(env, `
    SELECT DISTINCT symbol FROM trading_bot_entry_intents
    WHERE mode = ? AND status IN ('proposed', 'prepared', 'resting', 'partially-filled')
      AND expires_at > ?
  `, [mode, nowIso]);
  return rows.map((row) => row.symbol);
}

export async function resolveMatureEntryIntentProposals(nowIso, limit = 25) {
  const rows = await d1(env, `
    SELECT i.client_order_id, i.mode, i.side, i.signal_price_at,
           i.expires_at, i.signal_price, i.limit_price,
           COUNT(b.bar_at) AS observation_count,
           MIN(b.bar_at) AS first_bar_at, MAX(b.bar_at) AS last_bar_at,
           MIN(b.low) AS observed_low, MAX(b.high) AS observed_high,
           MIN(CASE
             WHEN i.side = 'BUY' AND b.low <= i.limit_price THEN b.bar_at
             WHEN i.side = 'SELL' AND b.high >= i.limit_price THEN b.bar_at
           END) AS first_touch_bar_at
    FROM trading_bot_entry_intents i
    LEFT JOIN asset_hourly_bars b
      ON b.symbol = i.signal_symbol
     AND b.asset_class = i.asset_class
     AND b.bar_at >= i.signal_price_at
     AND b.bar_at <= i.expires_at
    WHERE i.mode IN ('dry', 'shadow')
      AND i.asset_class = 'crypto'
      AND i.status IN ('proposed', 'awaiting-bars')
      AND i.expires_at <= ?
    GROUP BY i.client_order_id
    ORDER BY i.expires_at ASC
    LIMIT ?
  `, [nowIso, Math.max(1, Math.min(100, Math.floor(Number(limit) || 25)))]);
  if (!rows.length) return { checked: 0, touched: 0, expired: 0, awaitingBars: 0 };

  const resolvedAt = nowIso;
  const counts = { checked: rows.length, touched: 0, expired: 0, awaitingBars: 0 };
  const statements = rows.map((row) => {
    const assessment = assessLimitReachability(row);
    if (assessment.decision === 'touched') counts.touched++;
    else if (assessment.decision === 'expired') counts.expired++;
    else counts.awaitingBars++;
    const status = assessment.decision === 'touched'
      ? `${row.mode}-touched`
      : assessment.decision === 'expired' ? `${row.mode}-expired` : 'awaiting-bars';
    return {
      sql: `UPDATE trading_bot_entry_intents SET
        status = ?, updated_at = ?, research_resolved_at = ?,
        first_touch_bar_at = ?, observation_count = ?, observed_low = ?,
        observed_high = ?, closest_distance_pct = ?, resolution_basis = ?
        WHERE client_order_id = ? AND mode IN ('dry', 'shadow')
          AND status IN ('proposed', 'awaiting-bars')`,
      params: [
        status, resolvedAt, assessment.complete ? resolvedAt : null,
        row.first_touch_bar_at ?? null, Number(row.observation_count) || 0,
        row.observed_low ?? null, row.observed_high ?? null,
        assessment.closestDistancePct,
        assessment.complete
          ? 'hourly-ohlc-limit-reachability-not-execution-or-pnl'
          : 'insufficient-hourly-window-coverage',
        row.client_order_id
      ]
    };
  });
  await d1Batch(env, statements);
  return counts;
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
