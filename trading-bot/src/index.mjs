// Runs ONE cycle and exits: resolve the shadow ledger -> fetch real account
// state + live signals -> decide -> execute (or record only) -> protect every
// open position with a real exchange-side stop/take-profit -> apply measured
// time exits -> persist state to D1 -> exit. Fired on a cron schedule by
// .github/workflows/trading-bot-cycle.yml — this process does NOT loop or
// sleep itself, since a GitHub Actions runner is stateless/ephemeral between
// invocations (see state.mjs).
//
// Protective orders are placed on the EXCHANGE (via the Algo Order API, see
// binance.mjs), not simulated in this process — so a position stays protected
// even between runs, or if a run fails outright. That's the single most
// important safety property of this design for an unattended leveraged
// system. The time exit is the one exit that cannot live on the exchange
// (Binance has no "close after N hours" order), so it is enforced here, and
// is deliberately additive: a missed cycle delays it, it never removes the
// stop or target underneath.
import { config } from './config.mjs';
import { log } from './logger.mjs';
import {
  acquireExecutionLease, releaseExecutionLease, loadState, saveState,
  recordEquity, recordTrade, logEquity, recordRiskAlert, tradeSummary
} from './state.mjs';
import {
  getAccount, getOpenAlgoOrders, setLeverage, getMarkPrice,
  placeMarketOrderReconciled, placeProtectiveOrderReconciled, cancelAlgoOrder,
  roundQuantity, roundPrice, getExchangeInfo, getPositionRiskMap,
  getIncomeSince, getUserTradesSince, getPositionAmount, makeClientOrderId,
  makeAssistedProtectionClientOrderId,
  executedMarketOrder, protectionClientOrderIds, findOrderByClientId,
  marketOrderMatches, isTerminalMarketOrder
} from './binance.mjs';
import { fetchSignals, fetchScalp, buildCandidates, getFearGreed } from './signals.mjs';
import { decideEntries } from './strategy.mjs';
import {
  stopLossPrice, stopLossPriceForResearch, takeProfitPrice, timeExitAfterMs
} from './risk.mjs';
import { positionOrigin, positionQuantitiesMatch, assessRisk, emergencyStopPrice } from './positions.mjs';
import {
  loadOpenShadowTrades, recordEntry, resolveShadowTrade, markResolved,
  updateExtremes, shadowSummary
} from './paper.mjs';

// Exit geometry for one candidate, computed once at decision time and then
// persisted, so a later cycle that did not open the position can still
// reproduce exactly the same stop, target and clock.
function exitGeometry(candidate, decision, entryPrice) {
  const stop = candidate.source === 'research-confirmed'
    ? stopLossPriceForResearch(entryPrice, decision.side, decision.leverage, candidate.worstTradePct)
    : stopLossPrice(entryPrice, decision.side, decision.leverage);
  const target = takeProfitPrice(decision.side, entryPrice, candidate.range, candidate.holding);
  const timeExit = timeExitAfterMs(candidate.holding, candidate.horizonHours, decision.extremeBoost);
  return { stop, target, timeExit };
}

const algoType = (order) => order?.orderType || order?.type;
const algoCloseAll = (order) => order?.closePosition === true || order?.closePosition === 'true';
const UNKNOWN_SUBMISSION_QUARANTINE_MS = 60 * 60 * 1000;

function protectionClientId(record, symbol, role) {
  return makeClientOrderId(role, symbol, record?.entryClientOrderId || record?.openedAt || 'legacy', record?.side || '');
}

function expectedProtectionIds(record, symbol) {
  return new Set([
    ...protectionClientOrderIds(protectionClientId(record, symbol, 'stop')),
    ...protectionClientOrderIds(protectionClientId(record, symbol, 'tp'))
  ]);
}

function trackProtection(record, role, order, fallbackClientId) {
  if (!record) return;
  if (!Array.isArray(record.protectionOrders)) record.protectionOrders = [];
  const item = {
    role,
    algoId: order?.algoId ?? null,
    clientAlgoId: order?.clientAlgoId || fallbackClientId || null
  };
  const at = record.protectionOrders.findIndex((r) => r.role === role);
  if (at >= 0) record.protectionOrders[at] = item;
  else record.protectionOrders.push(item);
}

function trackedProtection(order, record, expectedClientIds) {
  if (expectedClientIds.has(order?.clientAlgoId)) return true;
  return (record?.protectionOrders || []).some((r) =>
    (r.algoId != null && String(r.algoId) === String(order?.algoId))
      || (r.clientAlgoId && r.clientAlgoId === order?.clientAlgoId));
}

async function cancelTrackedProtection(symbol, record) {
  const expected = expectedProtectionIds(record, symbol);
  const open = await getOpenAlgoOrders(symbol);
  // Never cancel merely because an order happens to close the same symbol.
  // The operator may have placed that order. New bot protection has a stored
  // or deterministic identity; legacy protection is left for Binance/the
  // operator because its ownership cannot be proven retrospectively.
  const siblings = open.filter((o) => trackedProtection(o, record, expected));
  for (const order of siblings) {
    try {
      await cancelAlgoOrder({ algoId: order.algoId, clientAlgoId: order.clientAlgoId });
      log('cancelled_protection_sibling', {
        symbol, type: algoType(order), algoId: order.algoId, clientAlgoId: order.clientAlgoId
      });
    } catch (error) {
      // A sibling may trigger between listing and cancellation. Verification
      // below is authoritative; do not turn that harmless race into a retry.
      if (Number(error.binanceCode) !== -2011 && Number(error.binanceCode) !== -2013) throw error;
    }
  }
  const remaining = (await getOpenAlgoOrders(symbol)).filter((o) => trackedProtection(o, record, expected));
  if (remaining.length) {
    throw new Error(`failed to cancel ${remaining.length} tracked algo protection order(s) for ${symbol}`);
  }
}

async function ensureProtection(position, state, risk) {
  const symbol = position.symbol;
  const existing = await getOpenAlgoOrders(symbol);

  const side = Number(position.positionAmt) > 0 ? 'BUY' : 'SELL';
  const closingSide = side === 'BUY' ? 'SELL' : 'BUY';
  const r = (risk && risk[symbol]) || {};
  const recorded = state.openOrders[symbol];
  const verifyFinishedReplacement = async (finishedOrder) => {
    const currentAmount = await getPositionAmount(symbol);
    const currentSide = currentAmount > 0 ? 'BUY' : currentAmount < 0 ? 'SELL' : null;
    const owned = currentSide != null
      && positionOrigin(symbol, state, currentSide, currentAmount) === 'bot';
    if (!owned) {
      log('protection_replacement_withheld', {
        symbol, priorAlgoId: finishedOrder?.algoId,
        priorClientAlgoId: finishedOrder?.clientAlgoId,
        currentPositionAmt: currentAmount,
        reason: currentAmount === 0
          ? 'the prior conditional order finished and the position is now flat'
          : 'the remaining side/quantity is not provably the bot-owned position'
      });
    }
    return owned;
  };
  // Prefer fresh positionRisk data. A confirmed bot fill retained in D1 is a
  // valid fallback when that endpoint is temporarily unavailable; the account
  // payload itself does not contain entry price/leverage.
  const recordedEntry = Number(recorded?.entryPrice);
  let entryPrice = Number.isFinite(r.entryPrice) && r.entryPrice > 0
    ? r.entryPrice
    : Number.isFinite(recordedEntry) && recordedEntry > 0 ? recordedEntry : NaN;
  let anchor = Number.isFinite(r.entryPrice) && r.entryPrice > 0 ? 'position-risk entry' : 'recorded fill';
  if (!Number.isFinite(entryPrice)) {
    // A stop anchored to the mark is not equivalent to one anchored to entry,
    // but an unprotected leveraged position is strictly worse than a slightly
    // mis-anchored stop. Take the mark and say so.
    entryPrice = Number.isFinite(r.markPrice) && r.markPrice > 0 ? r.markPrice : NaN;
    anchor = 'mark';
  }
  const recordedLeverage = Number(recorded?.leverage);
  const leverage = Number.isFinite(r.leverage) && r.leverage > 0
    ? r.leverage
    : Number.isFinite(recordedLeverage) && recordedLeverage > 0 ? recordedLeverage : config.minLeverage;
  const stopClientAlgoId = protectionClientId(recorded, symbol, 'stop');
  const tpClientAlgoId = protectionClientId(recorded, symbol, 'tp');
  const expected = expectedProtectionIds(recorded, symbol);
  const suitable = (o, type) => o?.symbol === symbol && o?.side === closingSide
    && algoCloseAll(o) && algoType(o) === type;
  const legacyRecord = !recorded?.entryClientOrderId;
  const trackedOrLegacy = (type) => {
    const exact = existing.filter((o) => suitable(o, type) && trackedProtection(o, recorded, expected));
    if (exact.length || !legacyRecord) return { orders: exact, owned: true };
    // Compatibility for positions opened before deterministic IDs existed:
    // recognize a suitable close-all order so protection is not duplicated,
    // but do not claim or later cancel an order whose provenance is unknown.
    return { orders: existing.filter((o) => suitable(o, type)), owned: false };
  };
  const stopMatch = trackedOrLegacy('STOP_MARKET');
  const tpMatch = trackedOrLegacy('TAKE_PROFIT_MARKET');
  if (stopMatch.owned) for (const order of stopMatch.orders) trackProtection(recorded, 'stop', order, order.clientAlgoId);
  if (tpMatch.owned) for (const order of tpMatch.orders) trackProtection(recorded, 'tp', order, order.clientAlgoId);
  const hasStop = stopMatch.orders.length > 0;
  const hasTp = tpMatch.orders.length > 0;
  if (hasStop && hasTp) return;

  if (!Number.isFinite(entryPrice)) {
    // Fail loudly rather than sending a NaN trigger price that the exchange
    // will reject, leaving the position silently unprotected.
    log('error_no_price_reference_for_protection', {
      symbol, reason: 'neither entryPrice nor markPrice available from positionRisk — cannot compute a protective trigger',
      action: 'NO PROTECTIVE ORDER PLACED — investigate immediately'
    });
    return;
  }
  if (anchor === 'mark') {
    log('warning_stop_anchored_to_mark', { symbol, reason: 'entryPrice unavailable from positionRisk; stop sized from the current mark instead' });
  }

  if (!hasStop) {
    // A recorded stop is preferred: for a research-sourced position it was
    // sized off that strategy's own measured worst trade, which this generic
    // fallback knows nothing about.
    const raw = recorded?.stopPrice ?? stopLossPrice(entryPrice, side, leverage);
    const price = await roundPrice(symbol, raw);
    if (!Number.isFinite(price) || !(price > 0)) {
      log('error_bad_stop_price', { symbol, raw, computed: price, action: 'NO STOP PLACED — investigate immediately' });
      return;
    }
    if (config.dryRun) {
      log('dry_run_would_place_stop', { symbol, side: closingSide, triggerPrice: price });
    } else {
      const order = await placeProtectiveOrderReconciled(
        symbol, closingSide, 'STOP_MARKET', price, stopClientAlgoId,
        { verifyFinishedReplacement }
      );
      const actualClientAlgoId = order.clientAlgoId || stopClientAlgoId;
      trackProtection(recorded, 'stop', order, actualClientAlgoId);
      log('placed_stop_loss', { symbol, triggerPrice: price, algoId: order.algoId, clientAlgoId: actualClientAlgoId, reconciled: !!order.reconciled });
    }
  }
  if (!hasTp) {
    const raw = recorded?.targetPrice
      ?? (recorded?.range ? takeProfitPrice(side, entryPrice, recorded.range, null) : null);
    if (raw == null) {
      log('warning_no_take_profit_target', { symbol, reason: 'no recorded exit geometry for this position (likely opened before this bot, or state was lost) — stop-loss only' });
      return;
    }
    const price = await roundPrice(symbol, raw);
    if (!Number.isFinite(price) || !(price > 0)) {
      log('error_bad_take_profit_price', { symbol, raw, computed: price, action: 'no take-profit placed; stop-loss still applies' });
      return;
    }
    if (config.dryRun) {
      log('dry_run_would_place_take_profit', { symbol, side: closingSide, triggerPrice: price });
    } else {
      const order = await placeProtectiveOrderReconciled(
        symbol, closingSide, 'TAKE_PROFIT_MARKET', price, tpClientAlgoId,
        { verifyFinishedReplacement }
      );
      const actualClientAlgoId = order.clientAlgoId || tpClientAlgoId;
      trackProtection(recorded, 'tp', order, actualClientAlgoId);
      log('placed_take_profit', { symbol, triggerPrice: price, algoId: order.algoId, clientAlgoId: actualClientAlgoId, reconciled: !!order.reconciled });
    }
  }
}

// The measured time exit. The engine records when, inside the declared
// window, the favorable extreme historically arrived; past that point the
// evidence says the move is usually already behind us and the position is
// giving back what it offered. Closing here is the "sell as high as possible"
// half of the mandate expressed as a measurement rather than a hope.
async function applyTimeExits(openPositionsRaw, state, nowMs) {
  for (const position of openPositionsRaw) {
    const symbol = position.symbol;
    const recorded = state.openOrders[symbol];
    if (!recorded || !Number.isFinite(Number(recorded.timeExitAfterMs))) continue;
    const openedMs = Date.parse(recorded.openedAt);
    if (!Number.isFinite(openedMs) || nowMs - openedMs < Number(recorded.timeExitAfterMs)) continue;

    // Re-read immediately before closing. The stop/target may have fired since
    // the cycle's account snapshot; reduceOnly below is the final race guard.
    let amount;
    try {
      amount = await getPositionAmount(symbol);
    } catch (error) {
      log('error_time_exit_position_refresh', { symbol, error: error.message });
      continue;
    }
    if (!Number.isFinite(amount)) continue;
    if (recorded.timeExitOrderPending) {
      const pendingId = recorded.timeExitClientOrderId;
      const requestedQty = Number(recorded.timeExitRequestedQty);
      const closingSide = recorded.side === 'BUY' ? 'SELL' : 'BUY';
      let pendingOrder;
      try { pendingOrder = await findOrderByClientId(symbol, pendingId); }
      catch (error) {
        log('pending_time_exit_query_failed', { symbol, clientOrderId: pendingId, error: error.message });
        continue;
      }
      if (!pendingOrder) {
        const unknownSince = Date.parse(recorded.timeExitSubmissionUnknownAt);
        const oldEnough = Number.isFinite(unknownSince)
          && Date.now() - unknownSince >= UNKNOWN_SUBMISSION_QUARANTINE_MS;
        if (oldEnough) {
          recorded.timeExitOrderPending = false;
          await saveState(state);
          log('pending_time_exit_abandoned_absent', {
            symbol, clientOrderId: pendingId,
            reason: 'Binance still reports no order after the one-hour ambiguity quarantine; a fresh reduce-only close may now be attempted'
          });
        } else {
          log('pending_time_exit_unverified', {
            symbol, clientOrderId: pendingId,
            action: 'no replacement close submitted while the prior intent remains absent inside its ambiguity quarantine'
          });
          continue;
        }
      } else if (!marketOrderMatches(pendingOrder, {
        symbol, side: closingSide, quantity: requestedQty,
        clientOrderId: pendingId, reduceOnly: true
      })) {
        log('pending_time_exit_unverified', {
          symbol, clientOrderId: pendingId,
          action: 'no replacement close submitted while the prior intent is absent or mismatched'
        });
        continue;
      }
      if (pendingOrder && !isTerminalMarketOrder(pendingOrder)) {
        log('pending_time_exit_still_open', {
          symbol, clientOrderId: pendingId, status: pendingOrder.status,
          executedQty: pendingOrder.executedQty
        });
        continue;
      }
      if (pendingOrder) {
        // The order may have become terminal after the position read at the
        // top of this loop. Compare its cumulative fill only with a position
        // snapshot taken after terminal status was observed.
        try {
          amount = await getPositionAmount(symbol);
        } catch (error) {
          log('pending_time_exit_position_refresh_failed', {
            symbol, clientOrderId: pendingId, error: error.message,
            action: 'pending state retained; no replacement close submitted'
          });
          continue;
        }
        const beforeAmount = Number(recorded.timeExitPositionBefore);
        const executedQty = Math.abs(Number(pendingOrder.executedQty));
        const expectedRemaining = beforeAmount
          + (closingSide === 'BUY' ? executedQty : -executedQty);
        recorded.timeExitOrderPending = false;
        if (!Number.isFinite(beforeAmount)
            || !positionQuantitiesMatch(expectedRemaining, amount)) {
          await saveState(state).catch((error) =>
            log('critical_pending_time_exit_state_persist_failed', { symbol, error: error.message }));
          log('pending_time_exit_ownership_conflict', {
            symbol, clientOrderId: pendingId, beforePositionAmt: beforeAmount,
            executedQty, expectedPositionAmt: expectedRemaining,
            observedPositionAmt: amount,
            action: 'prior close is terminal, but no further automated close will run on an unexplained net position'
          });
          continue;
        }
        if (amount === 0) {
          recorded.exitReason = 'time-exit';
          await saveState(state).catch((error) =>
            log('critical_time_exit_reason_persist_failed', { symbol, error: error.message }));
          await cancelTrackedProtection(symbol, recorded).catch((error) =>
            log('error_cancelling_protection_siblings', { symbol, error: error.message }));
          log('pending_time_exit_settled_flat', { symbol, clientOrderId: pendingId });
          continue;
        }
        recorded.entryExecutedQty = Math.abs(amount);
        await saveState(state).catch((error) =>
          log('critical_pending_time_exit_state_persist_failed', { symbol, error: error.message }));
        log('pending_time_exit_settled_partial', {
          symbol, clientOrderId: pendingId, remainingPositionAmt: amount
        });
      }
    }
    if (amount === 0) {
      log('time_exit_already_flat', { symbol });
      if (!config.dryRun) {
        await cancelTrackedProtection(symbol, recorded).catch((error) =>
          log('error_cancelling_protection_siblings', { symbol, error: error.message }));
      }
      continue;
    }
    const actualSide = amount > 0 ? 'BUY' : 'SELL';
    if (positionOrigin(symbol, state, actualSide, amount) !== 'bot') {
      log('time_exit_ownership_conflict', {
        symbol, recordedSide: recorded.side,
        recordedQuantity: recorded.entryExecutedQty ?? null,
        observedPositionAmt: amount,
        action: 'no order sent; side/quantity drift means the net position may contain operator fills'
      });
      continue;
    }
    const closingSide = amount > 0 ? 'SELL' : 'BUY';
    const quantity = await roundQuantity(symbol, Math.abs(amount));
    const heldHours = ((nowMs - openedMs) / 3600000).toFixed(1);
    if (!(quantity > 0)) {
      log('time_exit_skipped_zero_quantity', { symbol, heldHours });
      continue;
    }
    log('time_exit_due', { symbol, heldHours, afterMs: recorded.timeExitAfterMs, reason: 'past the measured mean time-to-peak for this asset/side/horizon' });
    if (config.dryRun) {
      log('dry_run_would_close_on_time', { symbol, side: closingSide, quantity });
      continue;
    }
    try {
      // Quantity is part of the intent. If a rare partial fill leaves a
      // smaller position, the next cycle gets a new deterministic close ID;
      // an unchanged amount still reconciles the same order and cannot close
      // twice after a timeout.
      const baseClientOrderId = makeClientOrderId(
        'texit', symbol, recorded.entryClientOrderId || recorded.openedAt,
        recorded.side, quantity
      );
      // Persist the exact reduce-only close intent before the exchange call.
      // A kill between acceptance and response can then be reconciled without
      // issuing another close or losing the measured exit reason.
      recorded.timeExitClientOrderId = baseClientOrderId;
      recorded.timeExitRequestedQty = quantity;
      recorded.timeExitPositionBefore = amount;
      recorded.timeExitOrderPending = true;
      recorded.timeExitSubmissionUnknownAt = new Date().toISOString();
      await saveState(state);
      let order;
      try {
        order = await placeMarketOrderReconciled(symbol, closingSide, quantity, {
          clientOrderId: baseClientOrderId, reduceOnly: true,
          onBeforeSubmit: async ({ clientOrderId }) => {
            recorded.timeExitClientOrderId = clientOrderId;
            recorded.timeExitSubmissionUnknownAt = new Date().toISOString();
            await saveState(state);
          }
        });
      } catch (error) {
        if (!error.outcomeUnknown) throw error;
        recorded.timeExitClientOrderId = error.clientOrderId || baseClientOrderId;
        recorded.timeExitRequestedQty = quantity;
        recorded.timeExitPositionBefore = amount;
        recorded.timeExitOrderPending = true;
        recorded.timeExitSubmissionUnknownAt = new Date().toISOString();
        await saveState(state);
        log('time_exit_submission_quarantined', {
          symbol, clientOrderId: recorded.timeExitClientOrderId,
          error: error.message,
          action: 'protection stays active; no replacement close until Binance proves this exact outcome terminal or absent beyond quarantine'
        });
        continue;
      }
      const clientOrderId = order.clientOrderId || baseClientOrderId;
      recorded.timeExitClientOrderId = clientOrderId;
      recorded.timeExitRequestedQty = quantity;
      recorded.timeExitPositionBefore = amount;
      recorded.timeExitOrderPending = !!order.pending;
      recorded.timeExitSubmissionUnknownAt = order.pending ? new Date().toISOString() : null;
      if (order.pending) {
        await saveState(state).catch((error) =>
          log('critical_pending_time_exit_state_persist_failed', { symbol, error: error.message }));
        log('time_exit_order_pending', {
          symbol, orderId: order?.orderId, clientOrderId,
          status: order?.status, executedQty: order?.executedQty,
          action: 'stop/take-profit remain active; no replacement close until this exact order is terminal'
        });
        continue;
      }
      if (!executedMarketOrder(order, { symbol, side: closingSide, clientOrderId })) {
        log('time_exit_not_executed', {
          symbol, orderId: order?.orderId, clientOrderId,
          status: order?.status, executedQty: order?.executedQty,
          action: 'tracked stop/take-profit left active; next cycle will retry safely'
        });
        continue;
      }
      const remaining = await getPositionAmount(symbol);
      const executedQty = Math.abs(Number(order.executedQty));
      const expectedRemaining = amount + (closingSide === 'BUY' ? executedQty : -executedQty);
      if (remaining === 0) {
        recorded.exitReason = 'time-exit';
        // Closure is detected from a fresh account snapshot next cycle. Save
        // the verified reason now so that retrospective attribution survives.
        await saveState(state).catch((error) =>
          log('critical_time_exit_reason_persist_failed', { symbol, error: error.message }));
        // Conditional orders use the separate Algo API. Cancel the exact
        // tracked stop/target siblings only after Binance confirms flat.
        await cancelTrackedProtection(symbol, recorded);
      } else {
        if (positionQuantitiesMatch(expectedRemaining, remaining)
            && Math.sign(remaining) === Math.sign(amount)) {
          // A verified partial reduce-only fill leaves a smaller bot-owned
          // residual. Persist it immediately so the next cycle does not
          // confuse our own partial exit with an operator addition.
          recorded.entryExecutedQty = Math.abs(remaining);
          await saveState(state).catch((error) =>
            log('critical_partial_time_exit_state_persist_failed', { symbol, error: error.message }));
        } else {
          log('time_exit_post_fill_ownership_conflict', {
            symbol, beforePositionAmt: amount, executedQty,
            expectedPositionAmt: expectedRemaining, observedPositionAmt: remaining,
            action: 'tracked protection left active; no further automated close until ownership is reconciled'
          });
        }
        log('time_exit_not_flat', {
          symbol, remaining, action: 'tracked stop/take-profit left active; next cycle will reconcile'
        });
      }
      log('closed_on_time_exit', {
        symbol, side: closingSide, quantity, orderId: order.orderId,
        clientOrderId, reconciled: !!order.reconciled, flatVerified: remaining === 0
      });
    } catch (e) {
      log('error_time_exit', { symbol, error: e.message });
    }
  }
}

// Resolve the bot's own ledger against real subsequent prices. Runs before
// anything else so the cycle log leads with how the existing record is doing.
async function resolveShadowLedger(nowIso, nowMs) {
  if (!config.shadowLedger) return;
  let open;
  try {
    open = await loadOpenShadowTrades();
  } catch (e) {
    log('error_loading_shadow_ledger', { error: e.message });
    return;
  }
  for (const row of open) {
    try {
      const { price } = await getMarkPrice(row.symbol);
      const resolution = resolveShadowTrade(row, Number(price), nowMs);
      if (!resolution) {
        // Still open: carry this observation into the row's running extremes
        // so the next cycle judges against everything seen since entry.
        await updateExtremes(row.id, Number(price));
        continue;
      }
      await markResolved(row.id, resolution, nowIso);
      log('shadow_trade_resolved', {
        id: row.id, mode: row.mode, source: row.source, symbol: row.symbol,
        side: row.side, reason: resolution.reason,
        returnPct: Number(resolution.returnPct.toFixed(3))
      });
    } catch (e) {
      log('error_resolving_shadow_trade', { id: row.id, symbol: row.symbol, error: e.message });
    }
  }
}

// MARKET orders normally settle before a RESULT response, but Binance exposes
// PARTIALLY_FILLED and other nonterminal states. If a cycle ends while one is
// still moving, retain the exact intent and cumulative owned quantity instead
// of either abandoning a real fill or treating a later fill as manual.
async function reconcilePendingEntries(state) {
  let sawPending = false;
  let changed = false;
  for (const [symbol, record] of Object.entries(state.openOrders || {})) {
    if (!record.entryOrderPending) continue;
    sawPending = true;
    const clientOrderId = record.entryClientOrderId;
    if (!clientOrderId || !(Number(record.entryRequestedQty) > 0)) {
      log('pending_entry_invalid_state', {
        symbol, clientOrderId, requestedQty: record.entryRequestedQty,
        action: 'entry remains quarantined; no replacement submitted'
      });
      continue;
    }
    let order;
    try {
      order = await findOrderByClientId(symbol, clientOrderId);
    } catch (error) {
      log('pending_entry_query_failed', { symbol, clientOrderId, error: error.message });
      continue;
    }
    if (!order) {
      const unknownSince = Date.parse(record.entrySubmissionUnknownAt);
      const oldEnough = Number.isFinite(unknownSince)
        && Date.now() - unknownSince >= UNKNOWN_SUBMISSION_QUARANTINE_MS;
      if (oldEnough) {
        let currentAmount = null;
        try { currentAmount = await getPositionAmount(symbol); } catch {}
        if (currentAmount === 0) {
          delete state.openOrders[symbol];
          changed = true;
          log('pending_entry_abandoned_absent', {
            symbol, clientOrderId,
            reason: 'Binance still reports no order and no position after the one-hour ambiguity quarantine'
          });
          continue;
        }
      }
      log('pending_entry_not_yet_visible', {
        symbol, clientOrderId,
        action: 'entry remains quarantined; absence is not treated as proof of rejection'
      });
      continue;
    }
    const expected = {
      symbol, side: record.side, quantity: record.entryRequestedQty,
      clientOrderId, reduceOnly: false
    };
    if (!marketOrderMatches(order, expected)) {
      log('pending_entry_intent_mismatch', {
        symbol, clientOrderId,
        action: 'entry remains quarantined; exchange order does not match frozen intent'
      });
      continue;
    }

    const executedQty = Math.abs(Number(order.executedQty));
    let currentAmount = null;
    try { currentAmount = await getPositionAmount(symbol); }
    catch (error) {
      log('pending_entry_position_query_failed', { symbol, clientOrderId, error: error.message });
    }
    const expectedAmount = record.side === 'BUY' ? executedQty : -executedQty;
    if (executedQty > 0 && currentAmount != null
        && positionQuantitiesMatch(expectedAmount, currentAmount)) {
      record.entryExecutedQty = executedQty;
      const avgPrice = Number(order.avgPrice);
      const cumQuote = Number(order.cumQuote);
      if (Number.isFinite(avgPrice) && avgPrice > 0) record.entryPrice = avgPrice;
      else if (Number.isFinite(cumQuote) && cumQuote > 0) record.entryPrice = cumQuote / executedQty;
      changed = true;
    } else if (executedQty > 0 && currentAmount != null && currentAmount !== 0) {
      log('pending_entry_ownership_conflict', {
        symbol, clientOrderId, exchangeExecutedQty: executedQty,
        observedPositionAmt: currentAmount,
        action: 'record retained but position is not managed as solely bot-owned'
      });
    }

    if (isTerminalMarketOrder(order) && currentAmount == null) {
      log('pending_entry_terminal_position_unverified', {
        symbol, clientOrderId, status: order.status,
        action: 'entry remains quarantined until live position ownership can be verified'
      });
    } else if (isTerminalMarketOrder(order)) {
      record.entryOrderPending = false;
      changed = true;
      if (!(executedQty > 0) && (currentAmount == null || currentAmount === 0)) {
        delete state.openOrders[symbol];
        log('pending_entry_terminal_without_fill', { symbol, clientOrderId, status: order.status });
      } else {
        log('pending_entry_settled', {
          symbol, clientOrderId, status: order.status,
          executedQty, observedPositionAmt: currentAmount
        });
      }
    } else {
      log('pending_entry_still_open', {
        symbol, clientOrderId, status: order.status, executedQty,
        observedPositionAmt: currentAmount
      });
    }
  }
  if (changed) await saveState(state);
  return sawPending;
}

async function executeOpen(decision, state, nowIso) {
  const { symbol, side, positionPct, leverage, extremeBoost, candidate } = decision;
  try {
    const account = await getAccount();
    const balance = Number(account.totalMarginBalance);
    // Re-check the symbol immediately before any symbol-scoped mutation. The
    // cycle-wide snapshot may be seconds old and an operator can open a trade
    // during that interval. In one-way mode, adding our fill would merge the
    // two positions and make ownership impossible to preserve.
    const prePositionAmount = await getPositionAmount(symbol);
    if (!Number.isFinite(prePositionAmount) || prePositionAmount !== 0) {
      log('entry_skipped_position_race', {
        symbol, observedPositionAmt: prePositionAmount,
        reason: 'the symbol was no longer flat immediately before submission; no leverage or order change attempted'
      });
      return;
    }
    const marginToUse = balance * positionPct;
    const { price: markPrice } = await getMarkPrice(symbol);
    const notional = marginToUse * leverage;
    const rawQuantity = notional / markPrice;
    const quantity = await roundQuantity(symbol, rawQuantity);
    if (!(quantity > 0)) {
      log('skip_zero_quantity', { symbol, reason: 'rounded quantity is zero — position size too small for this symbol\'s lot step' });
      return;
    }

    let { stop, target, timeExit } = exitGeometry(candidate, decision, markPrice);
    const entryIntentClientOrderId = makeClientOrderId(
      'entry', symbol, side, candidate.source,
      candidate.signalGeneratedAt || nowIso, candidate.hypothesis || '', candidate.horizonHours || ''
    );
    log('decision_open', {
      symbol, side, source: candidate.source, positionPct, leverage, extremeBoost,
      marginToUse, quantity, markPrice, edge: decision.edge,
      stop, target, timeExitAfterMs: timeExit, entryClientOrderId: entryIntentClientOrderId,
      targetBasis: candidate.holding ? 'measured favorable excursion' : 'predicted range edge'
    });

    if (config.dryRun) {
      log('dry_run_would_open', { symbol, side, quantity, leverage });
      // Dry decisions belong only in the paper ledger. Putting them in
      // openOrders falsely claims ownership of a real position on restart.
      if (config.shadowLedger) {
        await recordEntry({
          mode: 'dry', candidate, decision,
          entryPrice: markPrice, stopPrice: stop, targetPrice: target, openedAt: nowIso
        }).catch((e) => log('error_recording_ledger_entry', { symbol, error: e.message }));
      }
      return;
    }

    // Durable write-ahead intent: if the host dies after Binance accepts the
    // MARKET order, the next cycle still knows the exact client ID to query
    // and does not misclassify an unprotected leveraged position as manual.
    const pendingEntry = {
      side, entryPrice: markPrice, marginUsed: marginToUse, leverage,
      range: candidate.range, targetPrice: target, stopPrice: stop,
      timeExitAfterMs: timeExit, source: candidate.source, openedAt: nowIso,
      edge: decision.edge ?? null, horizonHours: candidate.horizonHours ?? null,
      holdingMfePct: candidate.holding?.mfePct ?? null,
      holdingMaePct: candidate.holding?.maePct ?? null,
      holdingHoursToPeak: candidate.holding?.hoursToPeak ?? null,
      extremeBoost: !!extremeBoost, equityAtOpen: balance,
      entryClientOrderId: entryIntentClientOrderId, entryExecutedQty: 0,
      entryRequestedQty: quantity, entryOrderPending: true,
      entrySubmissionUnknownAt: nowIso, protectionOrders: []
    };
    state.openOrders[symbol] = pendingEntry;
    await saveState(state);

    try {
      await setLeverage(symbol, leverage);
    } catch (error) {
      // No entry submission has happened, so this intent can be removed. If
      // cleanup itself fails, the persisted pending row fails conservatively
      // toward a one-hour quarantine rather than allowing an untracked order.
      delete state.openOrders[symbol];
      await saveState(state).catch((cleanupError) => {
        error.stateCleanupError = cleanupError.message;
      });
      throw error;
    }
    let order;
    try {
      order = await placeMarketOrderReconciled(symbol, side, quantity, {
        clientOrderId: entryIntentClientOrderId,
        onBeforeSubmit: async ({ clientOrderId }) => {
          pendingEntry.entryClientOrderId = clientOrderId;
          pendingEntry.entrySubmissionUnknownAt = new Date().toISOString();
          await saveState(state);
        }
      });
    } catch (error) {
      if (!error.outcomeUnknown) {
        // A positively rejected order cannot later fill. Intent mismatches are
        // retained as tombstones because their exchange state is not ours to
        // reinterpret or retry.
        if (!error.marketOrderIntentMismatch) {
          delete state.openOrders[symbol];
          await saveState(state).catch((cleanupError) => {
            error.stateCleanupError = cleanupError.message;
          });
        }
        throw error;
      }
      const pendingClientOrderId = error.clientOrderId || entryIntentClientOrderId;
      pendingEntry.entryClientOrderId = pendingClientOrderId;
      pendingEntry.entrySubmissionUnknownAt = new Date().toISOString();
      await saveState(state);
      log('entry_submission_quarantined', {
        symbol, side, clientOrderId: pendingClientOrderId,
        error: error.message,
        action: 'exact intent persisted; no second entry submits until Binance proves this outcome terminal or absent beyond the quarantine window'
      });
      return;
    }
    const entryClientOrderId = order.clientOrderId || entryIntentClientOrderId;
    const settledExecution = executedMarketOrder(order, {
      symbol, side, clientOrderId: entryClientOrderId
    });
    const exactPendingIntent = order.pending && marketOrderMatches(order, {
      symbol, side, quantity, clientOrderId: entryClientOrderId, reduceOnly: false
    });
    const executedQty = Math.abs(Number(order.executedQty));
    if (!settledExecution
        && !(exactPendingIntent && Number.isFinite(executedQty))) {
      log('entry_not_executed', {
        symbol, side, orderId: order?.orderId, clientOrderId: entryClientOrderId,
        status: order?.status, executedQty: order?.executedQty,
        reason: 'Binance did not report a settled fill or an exact pending market-order intent; ownership not recorded'
      });
      return;
    }
    const reportedFill = Number(order.avgPrice);
    const cumulativeQuote = Number(order.cumQuote);
    const entryPrice = Number.isFinite(reportedFill) && reportedFill > 0
      ? reportedFill
      : Number.isFinite(cumulativeQuote) && cumulativeQuote > 0
        ? cumulativeQuote / executedQty
        : markPrice;
    ({ stop, target, timeExit } = exitGeometry(candidate, decision, entryPrice));
    log(order.pending ? 'entry_order_pending' : 'opened_position', {
      symbol, side, quantity: executedQty, requestedQuantity: quantity,
      orderId: order.orderId, clientOrderId: entryClientOrderId,
      entryPrice, status: order.status, reconciled: !!order.reconciled,
      action: order.pending
        ? 'exact intent retained; no second entry may submit until this order becomes terminal'
        : undefined
    });

    state.openOrders[symbol] = {
      side, entryPrice, marginUsed: marginToUse, leverage,
      range: candidate.range, targetPrice: target, stopPrice: stop,
      timeExitAfterMs: timeExit, source: candidate.source, openedAt: nowIso,
      // Frozen at open: judging an outcome against evidence gathered later
      // would be hindsight, not measurement.
      edge: decision.edge ?? null, horizonHours: candidate.horizonHours ?? null,
      holdingMfePct: candidate.holding?.mfePct ?? null,
      holdingMaePct: candidate.holding?.maePct ?? null,
      holdingHoursToPeak: candidate.holding?.hoursToPeak ?? null,
      extremeBoost: !!extremeBoost, equityAtOpen: balance,
      entryClientOrderId, entryExecutedQty: executedQty,
      entryRequestedQty: quantity, entryOrderPending: !!order.pending,
      entrySubmissionUnknownAt: order.pending ? nowIso : null,
      protectionOrders: []
    };

    // Persist ownership promptly, then install exchange-side protection in
    // the same cycle instead of waiting for the next timer firing.
    await saveState(state).catch((e) =>
      log('critical_entry_state_persist_failed', { symbol, clientOrderId: entryClientOrderId, error: e.message }));
    if (!(executedQty > 0)) return;
    let amount = side === 'BUY' ? executedQty : -executedQty;
    try {
      const observed = await getPositionAmount(symbol);
      if (Number.isFinite(observed) && observed !== 0) amount = observed;
      else log('warning_post_entry_position_temporarily_flat', {
        symbol, fallbackPositionAmt: amount,
        action: 'attempting close-position protection from the exact confirmed fill; it cannot open a reverse position'
      });
    } catch (error) {
      log('warning_post_entry_position_refresh_unavailable', {
        symbol, error: error.message, fallbackPositionAmt: amount
      });
    }
    if (positionOrigin(symbol, state, amount > 0 ? 'BUY' : 'SELL', amount) !== 'bot') {
      log('critical_entry_side_conflict', {
        symbol, recordedSide: side, recordedQuantity: executedQty,
        observedPositionAmt: amount,
        action: 'ownership retained for audit, but side/quantity drift means this net position will not be managed as solely the bot trade'
      });
      await saveState(state).catch((error) =>
        log('critical_entry_state_retry_failed', { symbol, clientOrderId: entryClientOrderId, error: error.message }));
      return;
    }
    const currentRisk = await getPositionRiskMap().catch((error) => {
      log('warning_post_entry_position_risk_unavailable', {
        symbol, error: error.message,
        fallback: 'using the confirmed entry fill and configured leverage for immediate protection'
      });
      return {};
    });
    try {
      await ensureProtection({ symbol, positionAmt: amount }, state, currentRisk);
    } catch (error) {
      // Retain the ownership record even when Binance rejects/transiently
      // fails protection. The next five-minute cycle can then retry instead
      // of misclassifying the position as the operator's.
      log('critical_immediate_protection_failed', { symbol, error: error.message });
    }
    await saveState(state).catch((e) =>
      log('critical_protection_state_persist_failed', { symbol, clientOrderId: entryClientOrderId, error: e.message }));
    if (config.shadowLedger) {
      await recordEntry({
        mode: 'live', candidate, decision,
        entryPrice, stopPrice: stop, targetPrice: target, openedAt: nowIso
      }).catch((e) => log('error_recording_ledger_entry', { symbol, error: e.message }));
    }
  } catch (e) {
    log('error_opening_position', { symbol, error: e.message });
  }
}

// A shadow entry: every gate the bot owns passed, and only the engine's
// authorization is missing. Priced and recorded exactly as a real entry would
// have been, so the resulting record is comparable — but no order is ever
// sent, and no exposure is consumed.
async function recordShadow(decision, nowIso) {
  const { symbol, candidate } = decision;
  try {
    const { price: markPrice } = await getMarkPrice(symbol);
    const { stop, target } = exitGeometry(candidate, decision, Number(markPrice));
    await recordEntry({
      mode: 'shadow', candidate, decision,
      entryPrice: Number(markPrice), stopPrice: stop, targetPrice: target, openedAt: nowIso
    });
    log('shadow_entry_recorded', {
      symbol, side: decision.side, source: candidate.source,
      markPrice, stop, target, withheldReason: decision.reason
    });
  } catch (e) {
    log('error_recording_shadow_entry', { symbol, error: e.message });
  }
}

// Watch, do not touch. Records and alerts on a foreign position only when the
// numbers say a large loss is close — and at 'extreme', optionally places a
// stop between the mark and the liquidation price, because closing short of a
// liquidation loses materially less than the liquidation itself.
async function watchForeignPosition(position, risk, equity, nowIso) {
  const symbol = position.symbol;
  const side = Number(position.positionAmt) > 0 ? 'BUY' : 'SELL';
  const r = (risk && risk[symbol]) || {};
  const assessment = assessRisk({
    symbol, side, markPrice: r.markPrice, liquidationPrice: r.liquidationPrice,
    unrealizedPnl: Number(position.unrealizedProfit), equity
  });

  if (assessment.severity === 'none') {
    log('foreign_position_ok', { symbol, side, note: 'operator-managed; bot places no orders on it', ...assessment.metrics });
    return;
  }

  let actionTaken = 'alert only';
  if (assessment.severity === 'extreme' && config.emergencyStopForeign) {
    const raw = emergencyStopPrice(r.markPrice, r.liquidationPrice, side);
    if (raw == null) {
      actionTaken = 'no stop possible (mark/liquidation unusable)';
    } else {
      const price = await roundPrice(symbol, raw).catch(() => null);
      const closingSide = side === 'BUY' ? 'SELL' : 'BUY';
      let existing;
      try {
        existing = await getOpenAlgoOrders(symbol);
      } catch (error) {
        actionTaken = `alert only; could not verify existing stops: ${error.message}`;
        existing = null;
      }
      if (existing == null) {
        // Never place a possibly duplicate order when the ownership/existence
        // check itself failed.
      } else {
        const hasStop = existing.some((o) => o.orderType === 'STOP_MARKET' || o.type === 'STOP_MARKET');
        if (hasStop) {
          actionTaken = 'position already has a stop; left alone';
        } else if (!Number.isFinite(price) || !(price > 0)) {
          actionTaken = 'computed stop price unusable; NOT placed';
        } else if (config.dryRun) {
          actionTaken = `dry run — would place emergency stop at ${price}`;
        } else {
          const clientAlgoId = makeAssistedProtectionClientOrderId(symbol, side, nowIso, price);
          await placeProtectiveOrderReconciled(symbol, closingSide, 'STOP_MARKET', price, clientAlgoId)
            .then(() => { actionTaken = `emergency stop placed at ${price}`; })
            .catch((e) => { actionTaken = `emergency stop FAILED: ${e.message}`; });
        }
      }
    }
  }

  log(assessment.severity === 'extreme' ? 'foreign_position_extreme_risk' : 'foreign_position_warning', {
    symbol, side, reason: assessment.reason, actionTaken, ...assessment.metrics
  });
  await recordRiskAlert({
    raisedAt: nowIso, symbol, severity: assessment.severity, reason: assessment.reason,
    ...assessment.metrics, actionTaken
  }).catch((e) => log('error_recording_risk_alert', { symbol, error: e.message }));
}

// What the trade actually earned, from Binance's own income ledger rather than
// inferred from prices — fees and funding are real costs, and an edge that
// only survives gross of them is not an edge.
async function captureOutcome(symbol, record, equityNow, nowIso) {
  const openedMs = Date.parse(record?.openedAt);
  const since = Number.isFinite(openedMs) ? openedMs - 60000 : Date.now() - 7 * 86400000;
  const [income, fills] = await Promise.all([
    getIncomeSince(symbol, since).catch(() => null),
    getUserTradesSince(symbol, since).catch(() => [])
  ]);

  // Average exit price from the closing fills, weighted by quantity.
  const closing = (Array.isArray(fills) ? fills : []).filter((f) =>
    (record?.side === 'BUY' ? f.side === 'SELL' : f.side === 'BUY'));
  const qty = closing.reduce((t, f) => t + Math.abs(Number(f.qty) || 0), 0);
  const exitPrice = qty > 0
    ? closing.reduce((t, f) => t + Number(f.price) * Math.abs(Number(f.qty) || 0), 0) / qty
    : null;

  const marginUsed = Number(record?.marginUsed);
  const netPnl = income ? income.netPnl : null;
  const holdingMinutes = Number.isFinite(openedMs) ? (Date.parse(nowIso) - openedMs) / 60000 : null;

  await recordTrade({
    symbol, side: record?.side || 'BUY', origin: 'bot', source: record?.source ?? null,
    openedAt: record?.openedAt ?? null, closedAt: nowIso,
    entryPrice: record?.entryPrice ?? null, exitPrice, quantity: qty || null,
    leverage: record?.leverage ?? null, marginUsed: Number.isFinite(marginUsed) ? marginUsed : null,
    realizedPnl: income?.realizedPnl ?? null, commission: income?.commission ?? null,
    fundingFee: income?.fundingFee ?? null, netPnl,
    returnOnMarginPct: (Number.isFinite(netPnl) && marginUsed > 0) ? (netPnl / marginUsed) * 100 : null,
    holdingMinutes, exitReason: record?.exitReason ?? 'exchange-or-manual',
    edge: record?.edge ?? null, horizonHours: record?.horizonHours ?? null,
    holdingMfePct: record?.holdingMfePct ?? null, holdingMaePct: record?.holdingMaePct ?? null,
    holdingHoursToPeak: record?.holdingHoursToPeak ?? null,
    extremeBoost: record?.extremeBoost, equityAtOpen: record?.equityAtOpen ?? null,
    equityAtClose: equityNow
  });
  log('trade_recorded', { symbol, netPnl, exitPrice, holdingMinutes: holdingMinutes && Math.round(holdingMinutes) });
}

async function runCycle() {
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();
  const state = await loadState();

  await resolveShadowLedger(nowIso, nowMs);

  let account = await getAccount();
  // A MARKET order observed nonterminal in a prior cycle is reconciled before
  // ownership classification. Refresh the account afterward so a fill that
  // arrived during reconciliation is not mistaken for a manual position.
  if (await reconcilePendingEntries(state)) account = await getAccount();
  const equity = Number(account.totalMarginBalance);
  const balance = Number(account.totalMarginBalance);
  recordEquity(state, equity, nowIso);

  const openPositionsRaw = (account.positions || []).filter((p) => Math.abs(Number(p.positionAmt)) > 0);
  log('cycle_start', { equity, openPositionCount: openPositionsRaw.length, dryRun: config.dryRun });

  // Protect every currently-open position first, before considering new
  // entries — an unprotected leveraged position is the single biggest risk in
  // this whole system.
  const risk = await getPositionRiskMap().catch((e) => {
    log('error_loading_position_risk', { error: e.message, note: 'protective orders cannot be anchored without it' });
    return {};
  });
  // Positions the operator opened are NOT managed: no stop, no take-profit, no
  // time exit. An unrequested protective order can close somebody else's trade
  // against their intent, which is its own kind of loss. They are watched, and
  // spoken about only when a reading suggests a large loss is imminent.
  const ownPositions = [];
  for (const p of openPositionsRaw) {
    const actualSide = Number(p.positionAmt) > 0 ? 'BUY' : 'SELL';
    const origin = positionOrigin(p.symbol, state, actualSide, Number(p.positionAmt));
    if (origin === 'bot') { ownPositions.push(p); continue; }
    if (origin === 'conflict') {
      log('position_ownership_conflict', {
        symbol: p.symbol, recordedSide: state.openOrders[p.symbol]?.side,
        recordedQuantity: state.openOrders[p.symbol]?.entryExecutedQty ?? null,
        actualSide, actualQuantity: Math.abs(Number(p.positionAmt)),
        action: 'treated as operator-managed; no bot stop, target, or time exit'
      });
    }
    await watchForeignPosition(p, risk, equity, nowIso);
  }
  for (const p of ownPositions) {
    try { await ensureProtection(p, state, risk); } catch (e) { log('error_ensuring_protection', { symbol: p.symbol, error: e.message }); }
  }
  await applyTimeExits(ownPositions, state, nowMs);

  // Reconcile: any symbol this bot thought it had open but Binance no longer
  // shows (closed via stop/take-profit, time exit, or manually) starts its
  // cooldown timer now.
  const openSymbolsNow = new Set(openPositionsRaw.map((p) => p.symbol));
  for (const symbol of Object.keys(state.openOrders)) {
    if (!openSymbolsNow.has(symbol)) {
      const record = state.openOrders[symbol];
      if (record.entryOrderPending) {
        openSymbolsNow.add(symbol);
        log('pending_entry_symbol_blocked', {
          symbol, clientOrderId: record.entryClientOrderId,
          action: 'no same-symbol entry until the existing market order is terminal'
        });
        continue;
      }
      let protectionCleared = true;
      if (!config.dryRun) {
        try {
          await cancelTrackedProtection(symbol, record);
        } catch (e) {
          protectionCleared = false;
          // Keep both the D1 tombstone and the symbol-level entry block until
          // Binance positively confirms that our exact stop/target IDs are no
          // longer armed. Dropping them could orphan a closePosition order
          // which later closes a new manual trade on the same symbol.
          openSymbolsNow.add(symbol);
          log('error_cancelling_closed_position_siblings', {
            symbol, error: e.message,
            action: 'ownership tombstone retained; same-symbol entries blocked until exact cancellation verifies'
          });
        }
      }
      if (!protectionCleared) continue;
      state.lastClosedAt[symbol] = nowIso;
      delete state.openOrders[symbol];
      log('detected_position_closed', { symbol });
      await captureOutcome(symbol, record, equity, nowIso).catch((e) =>
        log('error_recording_outcome', { symbol, error: e.message }));
    }
  }

  const [signals, scalp] = await Promise.all([
    fetchSignals(),
    fetchScalp().catch((e) => { log('warning_scalp_unavailable', { error: e.message }); return null; })
  ]);
  log('signals_contract', {
    model: signals.model,
    cryptoClassProven: signals.classSkill?.crypto?.proven ?? null,
    holdingEvidenceAssets: signals.holdingEvidence?.rows?.length ?? 0,
    confirmedResearch: (signals.quantResearch?.rows || []).filter((r) => r.decision === 'confirmed').length
  });

  const allCandidates = buildCandidates(signals, scalp);

  // The engine speaks in bare asset symbols; this account trades USDT pairs.
  // A candidate whose pair does not exist on Binance USDS-M futures is
  // dropped here rather than failing later inside order sizing.
  let tradable = {};
  try {
    tradable = await getExchangeInfo();
  } catch (e) {
    log('error_loading_exchange_info', { error: e.message });
  }
  const candidates = allCandidates.filter((c) => {
    if (tradable[c.symbol]) return true;
    log('decision_skip', { symbol: c.symbol, reason: 'no Binance USDS-M futures market for this asset' });
    return false;
  });

  const fearGreed = getFearGreed(signals);
  const openPositions = openPositionsRaw.map((p) => ({
    notional: Math.abs(Number(p.notional)),
    leverage: Number(p.leverage) || 1,
    source: state.openOrders[p.symbol]?.source || 'confluence-v7'
  }));
  const { decisions, paused } = decideEntries(candidates, {
    fearGreed, openSymbols: openSymbolsNow, openPositions, balance, equity, state, nowMs
  });

  if (paused) log('entries_paused', { reason: paused });

  const shadowSymbols = new Set(
    (await loadOpenShadowTrades().catch(() => [])).filter((r) => r.mode === 'shadow').map((r) => r.symbol)
  );
  for (const d of decisions) {
    if (d.action === 'SKIP') { log('decision_skip', { symbol: d.symbol, reason: d.reason }); continue; }
    if (d.action === 'SHADOW') {
      if (!config.shadowLedger || shadowSymbols.has(d.symbol)) {
        log('decision_withheld', { symbol: d.symbol, reason: d.reason });
        continue;
      }
      await recordShadow(d, nowIso);
      shadowSymbols.add(d.symbol);
      continue;
    }
    await executeOpen(d, state, nowIso);
  }

  if (config.shadowLedger) {
    const summary = await shadowSummary().catch((e) => { log('error_shadow_summary', { error: e.message }); return []; });
    for (const row of summary) {
      log('track_record', {
        mode: row.mode, source: row.source, entries: row.n, stillOpen: row.open_n,
        wins: row.wins, avgReturnPct: row.avg_return_pct == null ? null : Number(Number(row.avg_return_pct).toFixed(3))
      });
    }
  }

  const unrealized = openPositionsRaw.reduce((t, p) => t + (Number(p.unrealizedProfit) || 0), 0);
  await logEquity(nowIso, equity, openPositionsRaw.length, unrealized)
    .catch((e) => log('error_logging_equity', { error: e.message }));
  for (const row of await tradeSummary().catch(() => [])) {
    log('realised_record', {
      origin: row.origin, trades: row.n, wins: row.wins, netPnl: row.net_pnl,
      avgReturnOnMarginPct: row.avg_return_on_margin_pct, avgHoldMinutes: row.avg_hold_minutes
    });
  }

  await saveState(state);
  log('cycle_end', {});
}

async function main() {
  log('bot_starting', { dryRun: config.dryRun });
  let lease = null;
  try {
    lease = await acquireExecutionLease();
    if (!lease) {
      log('cycle_skipped_overlap', {
        lease: 'futures-cycle',
        reason: 'another futures process holds the execution lease; no exchange action attempted'
      });
      return;
    }
    await runCycle();
  } catch (e) {
    log('error_cycle', { error: e.message, stack: e.stack });
    process.exitCode = 1;
  } finally {
    if (lease) {
      await releaseExecutionLease(lease).catch((error) => {
        log('warning_execution_lease_release_failed', {
          lease: lease.name, error: error.message,
          action: 'lease expires automatically; a later cycle may be delayed but cannot overlap this one'
        });
      });
    }
  }
}

main();
