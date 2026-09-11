// Runs ONE cycle and exits: resolve the shadow ledger -> fetch real account
// state + live signals -> decide -> execute (or record only) -> protect every
// open position with a real exchange-side stop/take-profit -> apply measured
// time exits -> persist state to D1 -> exit. Fired by an Oracle-hosted systemd
// timer; this process does NOT loop or sleep. A separate protection-only
// one-shot checks resting LIMIT fills between decision cycles and shares this
// process's D1 execution lease (see protection-cycle.mjs and state.mjs).
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
import { pathToFileURL } from 'node:url';
import { log } from './logger.mjs';
import {
  acquireExecutionLease, releaseExecutionLease, loadState, saveState,
  recordEquity, recordTrade, logEquity, recordRiskAlert, tradeSummary, loadBotLossSummary,
  recordEntryIntent, updateEntryIntent, finalizeEntryIntent,
  loadActiveEntryIntentSymbols, resolveMatureEntryIntentProposals
} from './state.mjs';
import {
  getAccount, getOpenAlgoOrders, setLeverage, getMarkPrice, getDailyRangeStats,
  placeMarketOrderReconciled, placeLimitOrderReconciled,
  placeProtectiveOrderReconciled, cancelAlgoOrder, cancelOrder,
  roundQuantity, roundPrice, roundLimitPrice, getExchangeInfo, getPositionRiskMap,
  marketEligibleForAssetClass,
  getIncomeSince, getUserTradesSince, getUserTradesForOrder, getPositionAmount, makeClientOrderId,
  isLegacyAssistedProtectionId, isFuturesBotOrderId, getOpenOrders,
  executedMarketOrder, protectionClientOrderIds, findOrderByClientId,
  marketOrderMatches, limitOrderMatches, isTerminalMarketOrder,
  isTerminalEntryOrder
} from './binance.mjs';
import { fetchSignals, fetchScalp, buildCandidates, getFearGreed } from './signals.mjs';
import { decideEntries } from './strategy.mjs';
import {
  stopLossPrice, stopLossPriceForResearch, takeProfitPrice, timeExitAfterMs,
  entryOffsetPlan, entryLimitPrice, entryOrderExpiryMs, signalReferenceIssue,
  fundingUnfavorable
} from './risk.mjs';
import { positionOrigin, positionQuantitiesMatch, assessRisk } from './positions.mjs';
import { summarizeExactRoundTrip } from './outcome.mjs';
import { ACTIVE_LIMIT_SOURCE, activeExecutionEligible, activeExitGeometry } from './active-limit.mjs';
import { assessBotEntryRisk, entryCapitalIssue } from './bot-risk.mjs';
import { baselineExitPolicy, roiExitGeometry, leveragePlan } from './trade-policy.mjs';
import { managePolicyExits } from './managed-exits.mjs';

export async function applyPolicyExits(state, reversals = []) {
  try { await managePolicyExits(state, {
    amount: getPositionAmount, mark: getMarkPrice, round: roundQuantity,
    find: findOrderByClientId, close: placeMarketOrderReconciled,
    save: saveState, log, dryRun: config.dryRun
  }, { reversals }); } catch (error) {
    log('managed_exit_pass_failed', { error: error.message,
      action: 'no replacement close; independent protection checks continue' });
  }
}
import {
  loadOpenShadowTrades, recordEntry, resolveShadowTrade, markResolved,
  updateExtremes, shadowSummary
} from './paper.mjs';

// Exit geometry for one candidate, computed once at decision time and then
// persisted, so a later cycle that did not open the position can still
// reproduce exactly the same stop, target and clock.
function exitGeometry(candidate, decision, entryPrice) {
  if (config.roiExitPolicy || candidate.source === ACTIVE_LIMIT_SOURCE || candidate.roiPolicy) {
    candidate.roiPolicy ||= baselineExitPolicy(candidate, decision.leverage);
    const geometry = roiExitGeometry(decision.side, entryPrice, candidate.roiPolicy);
    if (!geometry) throw new Error('invalid frozen return-on-margin exit policy');
    return geometry;
  }
  const stop = candidate.source === 'research-confirmed'
    ? stopLossPriceForResearch(entryPrice, decision.side, decision.leverage, candidate.worstTradePct)
    : stopLossPrice(entryPrice, decision.side, decision.leverage);
  const target = takeProfitPrice(decision.side, entryPrice, candidate.range, candidate.holding);
  const timeExit = timeExitAfterMs(candidate.holding, candidate.horizonHours, decision.extremeBoost);
  return { stop, target, timeExit };
}

const algoType = (order) => order?.orderType || order?.type;
const algoReduceOnly = (order) => order?.reduceOnly === true || order?.reduceOnly === 'true';
const algoQuantity = (order) => Number(order?.quantity ?? order?.origQty);
const UNKNOWN_SUBMISSION_QUARANTINE_MS = 60 * 60 * 1000;

function protectionClientId(record, symbol, role) {
  if (record?.roiPolicy) return makeClientOrderId(role, symbol, record.entryClientOrderId,
    record.side, record.entryExecutedQty);
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
  const at = record.protectionOrders.findIndex((r) => r.role === role
    && (!record.roiPolicy || r.clientAlgoId === item.clientAlgoId));
  if (at >= 0) record.protectionOrders[at] = item;
  else record.protectionOrders.push(item);
}

function trackedProtection(order, record, expectedClientIds) {
  if (expectedClientIds.has(order?.clientAlgoId)) return true;
  return (record?.protectionOrders || []).some((r) =>
    (r.algoId != null && String(r.algoId) === String(order?.algoId))
      || (r.clientAlgoId && r.clientAlgoId === order?.clientAlgoId));
}

export async function cancelTrackedProtection(symbol, record) {
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

function recordedEntryExpected(symbol, record) {
  const common = {
    symbol, side: record?.side, quantity: record?.entryRequestedQty,
    clientOrderId: record?.entryClientOrderId
  };
  if (record?.entryOrderType === 'LIMIT') {
    return {
      type: 'LIMIT',
      expected: {
        ...common, price: record.entryLimitPrice,
        goodTillDate: Date.parse(record.entryExpiresAt)
      }
    };
  }
  return { type: 'MARKET', expected: { ...common, reduceOnly: false } };
}

function recordedEntryMatches(order, symbol, record) {
  const { type, expected } = recordedEntryExpected(symbol, record);
  return type === 'LIMIT'
    ? limitOrderMatches(order, expected)
    : marketOrderMatches(order, expected);
}

async function exactOrFallbackFillTime(symbol, order, fallbackIso) {
  try {
    const fills = await getUserTradesForOrder(symbol, order?.orderId);
    const times = (Array.isArray(fills) ? fills : [])
      .map((fill) => Number(fill?.time))
      .filter((time) => Number.isFinite(time) && time > 0);
    if (times.length) return new Date(Math.min(...times)).toISOString();
    log('warning_entry_fill_time_unavailable', {
      symbol, orderId: order?.orderId,
      fallback: 'using exchange order updateTime because the exact order fill query returned no rows'
    });
  } catch (error) {
    log('warning_entry_fill_time_query_failed', {
      symbol, orderId: order?.orderId, error: error.message,
      fallback: 'using exchange order updateTime'
    });
  }
  const updateMs = Number(order?.updateTime);
  return Number.isFinite(updateMs) && updateMs > 0
    ? new Date(updateMs).toISOString() : fallbackIso;
}

// Cancel only the exact bot entry represented by the state row. This helper
// is used when a personal position appears while a resting limit is armed;
// broad symbol cancellation would also remove the operator's orders.
export async function cancelTrackedEntry(symbol, record, reason, nowIso = new Date().toISOString()) {
  if (!record?.entryOrderPending || !record.entryClientOrderId) return { canceled: false, terminal: true };
  const order = await findOrderByClientId(symbol, record.entryClientOrderId);
  if (!order) return { canceled: false, terminal: false, absent: true };
  if (!recordedEntryMatches(order, symbol, record)) {
    throw new Error(`tracked entry ${record.entryClientOrderId} no longer matches its frozen intent`);
  }
  if (isTerminalEntryOrder(order)) {
    record.entryOrderPending = false;
    return { canceled: false, terminal: true, order };
  }
  try {
    await cancelOrder({ symbol, orderId: order.orderId, clientOrderId: record.entryClientOrderId });
  } catch (error) {
    // The last resting quantity can fill between our query and cancellation.
    // Binance then reports "unknown order"/"cancel rejected"; only a fresh
    // exact-ID query may decide whether that race ended safely.
    if (![ -2011, -2013 ].includes(Number(error.binanceCode))) throw error;
  }
  const after = await findOrderByClientId(symbol, record.entryClientOrderId);
  if (!after || !recordedEntryMatches(after, symbol, record) || !isTerminalEntryOrder(after)) {
    throw new Error(`could not verify exact cancellation of ${record.entryClientOrderId}`);
  }
  record.entryOrderPending = false;
  await updateEntryIntent(record.entryClientOrderId, {
    status: Number(after.executedQty) > 0 ? 'partially-filled-canceled' : 'canceled',
    updatedAt: nowIso, canceledAt: nowIso,
    filledQty: Number(after.executedQty) || null,
    cancelReason: reason
  }).catch((error) => log('error_updating_entry_intent', { symbol, error: error.message }));
  log('cancelled_tracked_entry', {
    symbol, clientOrderId: record.entryClientOrderId,
    orderId: after.orderId, executedQty: after.executedQty, reason
  });
  return { canceled: true, terminal: true, order: after };
}

// Old versions could place an `fcsa-` stop on a manual position. Retire only
// that exact namespace; personal orders and normal `fcsf-` bot protection are
// deliberately untouched. Rechecking each cycle makes a transient API error
// self-healing without ever creating a new assisted stop.
async function retireLegacyAssistedProtection() {
  const all = await getOpenAlgoOrders();
  const legacy = all.filter((order) => isLegacyAssistedProtectionId(order?.clientAlgoId));
  if (!legacy.length) return;
  if (config.dryRun) {
    log('dry_run_legacy_assisted_protection_found', {
      count: legacy.length,
      action: 'no cancellation sent in dry-run; remove these exact fcsa-* orders manually'
    });
    return;
  }
  for (const order of legacy) {
    await cancelAlgoOrder({ algoId: order.algoId, clientAlgoId: order.clientAlgoId });
    log('retired_legacy_assisted_protection', {
      symbol: order.symbol, algoId: order.algoId, clientAlgoId: order.clientAlgoId
    });
  }
  const remaining = (await getOpenAlgoOrders())
    .filter((order) => isLegacyAssistedProtectionId(order?.clientAlgoId));
  if (remaining.length) throw new Error(`failed to retire ${remaining.length} legacy assisted stop(s)`);
}

async function cancelOrphanedBotOrdersOnForeignPosition(symbol) {
  const [normal, algo] = await Promise.all([getOpenOrders(symbol), getOpenAlgoOrders(symbol)]);
  const botNormal = normal.filter((order) => isFuturesBotOrderId(order?.clientOrderId));
  const botAlgo = algo.filter((order) => isFuturesBotOrderId(order?.clientAlgoId)
    || isLegacyAssistedProtectionId(order?.clientAlgoId));
  if (config.dryRun) {
    if (botNormal.length || botAlgo.length) log('dry_run_orphaned_bot_orders_on_foreign_position', {
      symbol, normal: botNormal.length, algo: botAlgo.length,
      action: 'no cancellation sent in dry-run'
    });
    return;
  }
  for (const order of botNormal) {
    await cancelOrder({ symbol, orderId: order.orderId, clientOrderId: order.clientOrderId });
  }
  for (const order of botAlgo) {
    await cancelAlgoOrder({ algoId: order.algoId, clientAlgoId: order.clientAlgoId });
  }
  const [normalAfter, algoAfter] = await Promise.all([getOpenOrders(symbol), getOpenAlgoOrders(symbol)]);
  const remaining = normalAfter.filter((order) => isFuturesBotOrderId(order?.clientOrderId)).length
    + algoAfter.filter((order) => isFuturesBotOrderId(order?.clientAlgoId)
      || isLegacyAssistedProtectionId(order?.clientAlgoId)).length;
  if (remaining) throw new Error(`${remaining} bot-tagged order(s) remain on operator-managed ${symbol}`);
  if (botNormal.length || botAlgo.length) log('canceled_orphaned_bot_orders_on_foreign_position', {
    symbol, normal: botNormal.length, algo: botAlgo.length
  });
}

export async function ensureProtection(position, state, risk) {
  const symbol = position.symbol;
  const existing = await getOpenAlgoOrders(symbol);

  const side = Number(position.positionAmt) > 0 ? 'BUY' : 'SELL';
  const closingSide = side === 'BUY' ? 'SELL' : 'BUY';
  const r = (risk && risk[symbol]) || {};
  const recorded = state.openOrders[symbol];
  const protectiveQty = await roundQuantity(symbol, Math.abs(Number(position.positionAmt)));
  if (!(protectiveQty > 0) || !recorded) {
    log('protection_withheld_unverified_quantity', {
      symbol, positionAmt: position.positionAmt,
      reason: !recorded
        ? 'no durable bot ownership record exists'
        : 'the verified position does not round to a positive exchange quantity'
    });
    return false;
  }
  const freshOwnedPosition = async ({ cancelOnConflict = false, context = 'protection' } = {}) => {
    const currentAmount = await getPositionAmount(symbol);
    const currentSide = currentAmount > 0 ? 'BUY' : currentAmount < 0 ? 'SELL' : null;
    const owned = currentSide != null
      && positionOrigin(symbol, state, currentSide, currentAmount) === 'bot';
    if (!owned) {
      if (cancelOnConflict && !config.dryRun) {
        await cancelTrackedProtection(symbol, recorded).catch((error) => {
          log('error_cancelling_protection_after_ownership_change', {
            symbol, context, error: error.message
          });
        });
      }
      log('protection_withheld_ownership_change', {
        symbol, context, currentPositionAmt: currentAmount,
        reason: currentAmount === 0
          ? 'the position is now flat'
          : 'side or quantity no longer exactly matches the proven bot fill'
      });
    }
    return owned;
  };
  const verifyFinishedReplacement = async (finishedOrder) => {
    const owned = await freshOwnedPosition({ context: 'finished conditional replacement' });
    if (!owned) {
      log('protection_replacement_withheld', {
        symbol, priorAlgoId: finishedOrder?.algoId,
        priorClientAlgoId: finishedOrder?.clientAlgoId,
        reason: 'the remaining position is not freshly provable as the exact bot-owned quantity'
      });
    }
    return owned;
  };
  const onBeforeSubmit = async ({ clientAlgoId }) => {
    if (!await freshOwnedPosition({
      cancelOnConflict: true, context: `immediately before ${clientAlgoId}`
    })) {
      const error = new Error(`ownership changed immediately before protective order ${clientAlgoId}`);
      error.protectionOwnershipChanged = true;
      throw error;
    }
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
  const staleOwned = recorded.roiPolicy ? existing.filter(o =>
    trackedProtection(o, recorded, expected) && !positionQuantitiesMatch(algoQuantity(o), protectiveQty)) : [];
  const suitable = (o, type) => o?.symbol === symbol && o?.side === closingSide
    && algoReduceOnly(o) && algoType(o) === type
    && positionQuantitiesMatch(algoQuantity(o), protectiveQty);
  const verifyCurrentStop = async () => {
    if (config.dryRun) return true;
    if (!await freshOwnedPosition({ cancelOnConflict: true, context: 'protection postflight' })) {
      return false;
    }
    const verified = await getOpenAlgoOrders(symbol);
    const verifiedStop = verified.some((order) => suitable(order, 'STOP_MARKET')
      && trackedProtection(order, recorded, expected));
    if (!verifiedStop) {
      throw new Error(`fresh verification found no exact quantity-bounded stop for ${symbol}`);
    }
    // Replacement stop is confirmed BEFORE stale oversized bot siblings are
    // removed. Only exact previously tracked IDs are eligible for cleanup.
    for (const order of staleOwned) {
      try { await cancelAlgoOrder({ algoId: order.algoId, clientAlgoId: order.clientAlgoId }); }
      catch (error) { if (![-2011, -2013].includes(Number(error.binanceCode))) throw error; }
    }
    return true;
  };
  const legacyRecord = !recorded?.entryClientOrderId;
  const trackedOrLegacy = (type) => {
    const exact = existing.filter((o) => suitable(o, type) && trackedProtection(o, recorded, expected));
    if (exact.length || !legacyRecord) return { orders: exact, owned: true };
    // Compatibility for positions opened before deterministic IDs existed:
    // recognize a suitable quantity-bounded order so protection is not duplicated,
    // but do not claim or later cancel an order whose provenance is unknown.
    return { orders: existing.filter((o) => suitable(o, type)), owned: false };
  };
  const stopMatch = trackedOrLegacy('STOP_MARKET');
  const tpMatch = trackedOrLegacy('TAKE_PROFIT_MARKET');
  if (stopMatch.owned) for (const order of stopMatch.orders) trackProtection(recorded, 'stop', order, order.clientAlgoId);
  if (tpMatch.owned) for (const order of tpMatch.orders) trackProtection(recorded, 'tp', order, order.clientAlgoId);
  const hasStop = stopMatch.orders.length > 0;
  const hasTp = tpMatch.orders.length > 0;
  if (!await freshOwnedPosition({ cancelOnConflict: true, context: 'protection preflight' })) {
    return false;
  }
  // The initial order snapshot preceded the ownership read. Re-query before
  // declaring the position protected so an operator/exchange cancellation in
  // that gap cannot be reported as a verified stop.
  if (hasStop && hasTp) return verifyCurrentStop();

  if (!Number.isFinite(entryPrice)) {
    // Fail loudly rather than sending a NaN trigger price that the exchange
    // will reject, leaving the position silently unprotected.
    log('error_no_price_reference_for_protection', {
      symbol, reason: 'neither entryPrice nor markPrice available from positionRisk — cannot compute a protective trigger',
      action: 'NO PROTECTIVE ORDER PLACED — investigate immediately'
    });
    return false;
  }
  if (anchor === 'mark') {
    log('warning_stop_anchored_to_mark', { symbol, reason: 'entryPrice unavailable from positionRisk; stop sized from the current mark instead' });
  }

  if (!hasStop) {
    // A recorded stop is preferred: for a research-sourced position it was
    // sized off that strategy's own measured worst trade, which this generic
    // fallback knows nothing about.
    const raw = recorded?.stopPrice ?? stopLossPrice(entryPrice, side, leverage);
    const price = recorded.roiPolicy
      ? await roundLimitPrice(symbol, raw, side === 'BUY' ? 'SELL' : 'BUY')
      : await roundPrice(symbol, raw);
    if (!Number.isFinite(price) || !(price > 0)) {
      log('error_bad_stop_price', { symbol, raw, computed: price, action: 'NO STOP PLACED — investigate immediately' });
      return false;
    }
    if (config.dryRun) {
      log('dry_run_would_place_stop', { symbol, side: closingSide, triggerPrice: price });
    } else {
      const order = await placeProtectiveOrderReconciled(
        symbol, closingSide, 'STOP_MARKET', price, protectiveQty, stopClientAlgoId,
        { verifyFinishedReplacement, onBeforeSubmit }
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
      return verifyCurrentStop();
    }
    const price = await roundPrice(symbol, raw);
    if (!Number.isFinite(price) || !(price > 0)) {
      log('error_bad_take_profit_price', { symbol, raw, computed: price, action: 'no take-profit placed; stop-loss still applies' });
      return verifyCurrentStop();
    }
    if (config.dryRun) {
      log('dry_run_would_place_take_profit', { symbol, side: closingSide, triggerPrice: price });
    } else {
      const order = await placeProtectiveOrderReconciled(
        symbol, closingSide, 'TAKE_PROFIT_MARKET', price, protectiveQty, tpClientAlgoId,
        { verifyFinishedReplacement, onBeforeSubmit }
      );
      const actualClientAlgoId = order.clientAlgoId || tpClientAlgoId;
      trackProtection(recorded, 'tp', order, actualClientAlgoId);
      log('placed_take_profit', { symbol, triggerPrice: price, algoId: order.algoId, clientAlgoId: actualClientAlgoId, reconciled: !!order.reconciled });
    }
  }
  return verifyCurrentStop();
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
    if (recorded?.roiPolicy) continue; // handled by exact staged-exit coordinator
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
        recorded.entryOriginalQty ??= recorded.entryExecutedQty;
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
          recorded.entryOriginalQty ??= recorded.entryExecutedQty;
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

// Reconcile exact market/limit entry identities. A partially filled resting
// limit is canceled before protection is installed: otherwise a stop could
// close the partial while the remaining entry later reopens a new, unprotected
// position. An unfilled limit is also canceled as soon as a personal position
// appears on the symbol.
export async function reconcilePendingEntries(state) {
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
          const abandonedAt = new Date().toISOString();
          await updateEntryIntent(clientOrderId, {
            status: 'abandoned-unobserved', updatedAt: abandonedAt,
            canceledAt: abandonedAt,
            cancelReason: 'Binance reported neither the exact order nor a position after the one-hour ambiguity quarantine'
          }).catch((error) => log('error_updating_entry_intent', { symbol, error: error.message }));
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
    if (!recordedEntryMatches(order, symbol, record)) {
      await updateEntryIntent(clientOrderId, {
        status: 'quarantined-intent-mismatch', updatedAt: new Date().toISOString(),
        cancelReason: 'exchange order no longer matches the frozen durable entry intent'
      }).catch((error) => log('error_updating_entry_intent', { symbol, error: error.message }));
      log('pending_entry_intent_mismatch', {
        symbol, clientOrderId,
        action: 'entry remains quarantined; exchange order does not match frozen intent'
      });
      continue;
    }

    let executedQty = Math.abs(Number(order.executedQty));
    let currentAmount = null;
    try { currentAmount = await getPositionAmount(symbol); }
    catch (error) {
      log('pending_entry_position_query_failed', { symbol, clientOrderId, error: error.message });
    }
    const expiresMs = Date.parse(record.entryExpiresAt);
    const expired = record.entryOrderType === 'LIMIT'
      && Number.isFinite(expiresMs) && Date.now() >= expiresMs;
    const personalPositionAppeared = executedQty === 0 && currentAmount != null && currentAmount !== 0;
    const partialStillResting = executedQty > 0 && !isTerminalEntryOrder(order);
    if (!isTerminalEntryOrder(order)
        && (expired || personalPositionAppeared || partialStillResting)) {
      const reason = personalPositionAppeared
        ? 'personal position appeared while bot limit was resting'
        : partialStillResting
          ? 'partial fill: cancel remainder before protecting the owned fill'
          : 'entry order reached its evidence/horizon expiry';
      try {
        const result = await cancelTrackedEntry(symbol, record, reason);
        if (!result.terminal) {
          log('pending_entry_cancel_unverified', { symbol, clientOrderId, reason });
          continue;
        }
        if (result.order) order = result.order;
        executedQty = Math.abs(Number(order.executedQty));
        try { currentAmount = await getPositionAmount(symbol); } catch {}
        changed = true;
      } catch (error) {
        log('pending_entry_cancel_failed', {
          symbol, clientOrderId, reason, error: error.message,
          action: 'intent remains quarantined; no replacement or protection mutation attempted'
        });
        continue;
      }
    }

    // The exact matched exchange order is sufficient proof of its own fill,
    // even if the resulting position opened and closed entirely between two
    // polls. Persist those facts before classifying the current net position;
    // exact round-trip capture will still refuse P&L if any foreign fills make
    // the outcome ambiguous.
    if (executedQty > 0) {
      record.entryExecutedQty = executedQty;
      record.entryOriginalQty = executedQty;
      const avgPrice = Number(order.avgPrice);
      const cumQuote = Number(order.cumQuote);
      if (Number.isFinite(avgPrice) && avgPrice > 0) record.entryPrice = avgPrice;
      else if (Number.isFinite(cumQuote) && cumQuote > 0) record.entryPrice = cumQuote / executedQty;
      else if (Number(record.entryLimitPrice) > 0) record.entryPrice = Number(record.entryLimitPrice);
      if (!record.entryFilledAt) {
        record.entryFilledAt = await exactOrFallbackFillTime(
          symbol, order, new Date().toISOString()
        );
        record.openedAt = record.entryFilledAt;
      }
      const actualMargin = executedQty * Number(record.entryPrice) / Number(record.leverage);
      if (Number.isFinite(actualMargin) && actualMargin > 0) record.marginUsed = actualMargin;
      const holding = Number.isFinite(Number(record.holdingMfePct))
          && record.holdingMfePct != null ? {
        mfePct: Number(record.holdingMfePct),
        maePct: Number(record.holdingMaePct),
        hoursToPeak: Number(record.holdingHoursToPeak)
      } : null;
      if (record.roiPolicy || record.source === ACTIVE_LIMIT_SOURCE) {
        const geometry = record.roiPolicy
          ? roiExitGeometry(record.side, record.entryPrice, record.roiPolicy)
          : activeExitGeometry(record.side, record.entryPrice, record.activePolicy);
        if (!geometry) throw new Error('filled active-limit entry has no valid frozen exit policy');
        record.stopPrice = geometry.stop;
        record.targetPrice = geometry.target;
        record.timeExitAfterMs = geometry.timeExit;
      } else {
        record.stopPrice = record.source === 'research-confirmed'
          ? stopLossPriceForResearch(record.entryPrice, record.side, record.leverage, record.worstTradePct)
          : stopLossPrice(record.entryPrice, record.side, record.leverage);
        record.targetPrice = takeProfitPrice(record.side, record.entryPrice, record.range, holding);
      }
      changed = true;
    }

    const expectedAmount = record.side === 'BUY' ? executedQty : -executedQty;
    if (executedQty > 0 && currentAmount != null
        && positionQuantitiesMatch(expectedAmount, currentAmount)) {
      record.ownershipVerified = true;
      await updateEntryIntent(clientOrderId, {
        status: isTerminalEntryOrder(order)
          ? (executedQty + 1e-12 < Number(record.entryRequestedQty)
              ? 'partially-filled-canceled' : 'filled')
          : 'partially-filled',
        updatedAt: new Date().toISOString(), filledAt: record.entryFilledAt,
        filledQty: executedQty, avgFillPrice: record.entryPrice,
        stopPrice: record.stopPrice, targetPrice: record.targetPrice
      }).catch((error) => log('error_updating_entry_intent', { symbol, error: error.message }));
      changed = true;
    } else if (executedQty > 0 && currentAmount != null && currentAmount !== 0) {
      record.ownershipVerified = false;
      record.ownershipConflict = true;
      if (!record.entryFilledAt) {
        record.entryFilledAt = await exactOrFallbackFillTime(
          symbol, order, new Date().toISOString()
        );
      }
      await updateEntryIntent(clientOrderId, {
        status: 'ownership-conflict', updatedAt: new Date().toISOString(),
        filledAt: record.entryFilledAt, filledQty: executedQty,
        cancelReason: 'live net position side/quantity does not equal the exact bot entry fill'
      }).catch((error) => log('error_updating_entry_intent', { symbol, error: error.message }));
      log('pending_entry_ownership_conflict', {
        symbol, clientOrderId, exchangeExecutedQty: executedQty,
        observedPositionAmt: currentAmount,
        action: 'record retained but position is not managed as solely bot-owned'
      });
    } else if (personalPositionAppeared) {
      record.ownershipVerified = false;
      record.ownershipConflict = true;
      const conflictedAt = new Date().toISOString();
      await updateEntryIntent(clientOrderId, {
        status: 'ownership-conflict', updatedAt: conflictedAt,
        canceledAt: conflictedAt,
        cancelReason: 'personal position appeared while the exact bot entry was resting'
      }).catch((error) => log('error_updating_entry_intent', { symbol, error: error.message }));
      log('pending_entry_personal_position_conflict', {
        symbol, clientOrderId, observedPositionAmt: currentAmount,
        action: 'bot entry canceled; personal position remains operator-managed'
      });
    }

    if (isTerminalEntryOrder(order) && currentAmount == null) {
      // `cancelTrackedEntry` marks the exchange order terminal, but ownership
      // is not settled until a fresh position read succeeds. Keep this row in
      // the reconciliation set so a partial fill cannot silently become an
      // unprotected position on the next cycle.
      record.entryOrderPending = true;
      changed = true;
      log('pending_entry_terminal_position_unverified', {
        symbol, clientOrderId, status: order.status,
        action: 'entry remains quarantined until live position ownership can be verified'
      });
    } else if (isTerminalEntryOrder(order)) {
      record.entryOrderPending = false;
      changed = true;
      if (!(executedQty > 0) && (currentAmount == null || currentAmount === 0)) {
        delete state.openOrders[symbol];
        await updateEntryIntent(clientOrderId, {
          status: expired ? 'expired' : String(order.status || 'terminal').toLowerCase(),
          updatedAt: new Date().toISOString(),
          canceledAt: new Date().toISOString(),
          cancelReason: expired ? 'entry order expired before fill' : 'entry terminated without a fill'
        }).catch((error) => log('error_updating_entry_intent', { symbol, error: error.message }));
        log('pending_entry_terminal_without_fill', { symbol, clientOrderId, status: order.status });
      } else if (executedQty > 0 && currentAmount === 0) {
        record.ownershipVerified = false;
        await updateEntryIntent(clientOrderId, {
          status: 'filled-closed-before-observation',
          updatedAt: new Date().toISOString(), filledAt: record.entryFilledAt,
          filledQty: executedQty, avgFillPrice: record.entryPrice,
          stopPrice: record.stopPrice, targetPrice: record.targetPrice
        }).catch((error) => log('error_updating_entry_intent', { symbol, error: error.message }));
        log('pending_entry_filled_and_already_flat', {
          symbol, clientOrderId, status: order.status, executedQty,
          action: 'exact fill retained; round-trip outcome requires complete unambiguous exchange fills'
        });
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
    if (!candidate.authorized && !activeExecutionEligible(candidate)) {
      throw new Error('entry has neither model authorization nor an enabled active-limit policy');
    }
    const nowMs = Date.parse(nowIso);
    const offset = entryOffsetPlan(candidate);
    const expiresMs = entryOrderExpiryMs(candidate);
    if (!offset.ok || !(expiresMs > nowMs + 10 * 60_000)) {
      log('entry_skipped_no_valid_limit_geometry', {
        symbol, reason: offset.reason
          || 'the immutable signal-based GTD expiry is no longer more than ten minutes away'
      });
      return;
    }
    const account = await getAccount();
    const balance = Number(account.totalMarginBalance);
    if (!(balance > 0)) throw new Error('account totalMarginBalance is unavailable or non-positive');
    const capitalIssue = entryCapitalIssue(account, positionPct);
    if (capitalIssue) { log('entry_skipped_capital', { symbol, reason: capitalIssue }); return; }
    if (config.activeLimitMode) {
      const botRisk = assessBotEntryRisk(await loadBotLossSummary(new Date().toISOString()), account, state);
      if (!botRisk.ok) { log('entry_skipped_bot_risk', { symbol, ...botRisk }); return; }
    }
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
    const [existingNormalOrders, existingAlgoOrders] = await Promise.all([
      getOpenOrders(symbol), getOpenAlgoOrders(symbol)
    ]);
    if (existingNormalOrders.length || existingAlgoOrders.length) {
      log('entry_skipped_existing_personal_order', {
        symbol, regularCount: existingNormalOrders.length,
        conditionalCount: existingAlgoOrders.length,
        reason: 'one or more unclaimed regular/conditional orders already exist; bot will not change leverage or add a resting order on this symbol'
      });
      return;
    }
    const marginToUse = balance * positionPct;
    const { price: markPrice, fundingRate } = await getMarkPrice(symbol);
    const referenceIssue = signalReferenceIssue(candidate, nowMs, markPrice);
    if (referenceIssue) {
      log('entry_skipped_reference_check', { symbol, reason: referenceIssue });
      return;
    }
    if (!Number.isFinite(fundingRate) || fundingUnfavorable(side, fundingRate)) {
      log('entry_skipped_live_funding', {
        symbol, fundingRate,
        reason: Number.isFinite(fundingRate)
          ? `live Binance funding is unfavorable for ${side}`
          : 'live Binance funding is unavailable'
      });
      return;
    }
    const rawLimit = entryLimitPrice(offset.signalPrice, side, offset.offsetPct);
    const limitPrice = await roundLimitPrice(symbol, rawLimit, side);
    if (!(limitPrice > 0)
        || (side === 'BUY' && !(limitPrice < offset.signalPrice))
        || (side === 'SELL' && !(limitPrice > offset.signalPrice))) {
      throw new Error('rounded limit price does not remain strictly away from the signal reference');
    }
    const expiresAt = new Date(expiresMs).toISOString();
    const notional = marginToUse * leverage;
    const rawQuantity = notional / limitPrice;
    const quantity = await roundQuantity(symbol, rawQuantity);
    if (!(quantity > 0)) {
      log('skip_zero_quantity', { symbol, reason: 'rounded quantity is zero — position size too small for this symbol\'s lot step' });
      return;
    }

    let { stop, target, timeExit } = exitGeometry(candidate, decision, limitPrice);
    const entryIntentClientOrderId = makeClientOrderId(
      'entry', config.dryRun ? 'dry' : 'live', symbol, side, candidate.source,
      candidate.signalPriceAt || '',
      offset.signalPrice, candidate.hypothesis || '', candidate.horizonHours || ''
    );
    log('decision_open', {
      symbol, side, source: candidate.source, positionPct, leverage, extremeBoost,
      marginToUse, quantity, markPrice, signalPrice: offset.signalPrice,
      limitPrice, offsetPct: offset.offsetPct, offsetBasis: offset.basis,
      offsetAdverseBasis: offset.adverseBasis, expiresAt, edge: decision.edge,
      stop, target, timeExitAfterMs: timeExit, entryClientOrderId: entryIntentClientOrderId,
      targetBasis: candidate.roiPolicy ? 'operator margin-ROI baseline; not optimized'
        : candidate.holding ? 'measured favorable excursion' : 'predicted range edge'
    });

    const intent = {
      clientOrderId: entryIntentClientOrderId,
      mode: config.dryRun ? 'dry' : 'live', status: config.dryRun ? 'proposed' : 'prepared',
      createdAt: nowIso, expiresAt, assetClass: candidate.assetClass,
      symbol, signalSymbol: candidate.signalSymbol, side, source: candidate.source,
      signalGeneratedAt: candidate.signalGeneratedAt, signalPriceAt: candidate.signalPriceAt,
      signalPrice: offset.signalPrice, markPriceAtOrder: markPrice, limitPrice,
      offsetPct: offset.offsetPct, offsetBasis: offset.basis,
      medianDailyMovePct: offset.medianDailyMovePct,
      absolute24hMovePct: offset.absolute24hMovePct,
      adverseExcursionPct: offset.adversePct, adverseBasis: offset.adverseBasis,
      wrongCallSamples: offset.wrongCallSamples, conservativeEdge: decision.edge,
      positionPct, leverage, requestedQty: quantity, stopPrice: stop,
      targetPrice: target, timeExitAfterMs: timeExit,
      horizonHours: candidate.horizonHours,
      evidence: {
        roiPolicy: candidate.roiPolicy ?? null,
        leverageEvidence: leveragePlan(candidate),
        tradingRange: candidate.tradingRange ?? null,
        activePolicy: candidate.activePolicy ?? null,
        modelAuthorized: candidate.authorized,
        modelWithheldReason: candidate.unauthorizedReason,
        screenAgree: candidate.screenAgree ?? null, screenTotal: candidate.screenTotal ?? null,
        formula: 'max(policy-floor, exact-asset daily/current/adverse move) minus bounded conservative-edge reduction; capped',
        beforeConfidencePct: offset.beforeConfidencePct,
        confidenceReductionPct: offset.confidenceReductionPct,
        confidenceProgress: offset.confidenceProgress,
        holdingN: candidate.holding?.n ?? null
      }
    };
    // The durable intent is a precondition for a live order. If D1 cannot
    // preserve what was decided, no exchange mutation occurs.
    await recordEntryIntent(intent);

    if (config.dryRun) {
      log('dry_run_would_place_limit', {
        symbol, side, quantity, leverage, signalPrice: offset.signalPrice,
        limitPrice, offsetPct: offset.offsetPct, expiresAt,
        note: 'proposal recorded but not counted as a fill'
      });
      return;
    }

    // Durable write-ahead intent: if the host dies after Binance accepts the
    // LIMIT order, the next cycle still knows the exact client ID to query
    // and does not misclassify an unprotected leveraged position as manual.
    const pendingEntry = {
      roiPolicy: candidate.roiPolicy ?? null,
      leverageEvidence: { ...leveragePlan(candidate), tradingRange: candidate.tradingRange ?? null },
      activePolicy: candidate.activePolicy ?? null,
      side, entryPrice: limitPrice, marginUsed: marginToUse, leverage,
      range: candidate.range, targetPrice: target, stopPrice: stop,
      timeExitAfterMs: timeExit, source: candidate.source, openedAt: nowIso,
      entryPlacedAt: nowIso, entryFilledAt: null,
      edge: decision.edge ?? null, horizonHours: candidate.horizonHours ?? null,
      holdingMfePct: candidate.holding?.mfePct ?? null,
      holdingMaePct: candidate.holding?.maePct ?? null,
      holdingHoursToPeak: candidate.holding?.hoursToPeak ?? null,
      worstTradePct: candidate.worstTradePct ?? null,
      extremeBoost: !!extremeBoost, equityAtOpen: balance,
      entryClientOrderId: entryIntentClientOrderId, entryExecutedQty: 0,
      entryRequestedQty: quantity, entryOrderPending: true,
      entryOrderType: 'LIMIT', entryLimitPrice: limitPrice,
      entryExpiresAt: expiresAt, entrySubmissionUnknownAt: nowIso,
      ownershipVerified: false, ownershipConflict: false,
      signalPrice: offset.signalPrice, signalPriceAt: candidate.signalPriceAt,
      entryOffsetPct: offset.offsetPct, entryOffsetBasis: offset.basis,
      wrongCallSamples: offset.wrongCallSamples,
      assetClass: candidate.assetClass, protectionOrders: []
    };
    state.openOrders[symbol] = pendingEntry;
    await saveState(state);

    const readEntrySurface = async () => {
      const [positionAmt, regularOrders, conditionalOrders] = await Promise.all([
        getPositionAmount(symbol), getOpenOrders(symbol), getOpenAlgoOrders(symbol)
      ]);
      return { positionAmt, regularOrders, conditionalOrders };
    };
    const entrySurfaceChanged = (surface) => !Number.isFinite(surface.positionAmt)
      || surface.positionAmt !== 0
      || surface.regularOrders.length > 0
      || surface.conditionalOrders.length > 0;
    const abandonBeforeSubmit = async (surface, stage) => {
      delete state.openOrders[symbol];
      await saveState(state);
      const canceledAt = new Date().toISOString();
      await updateEntryIntent(entryIntentClientOrderId, {
        status: 'canceled-pre-submit', updatedAt: canceledAt, canceledAt,
        cancelReason: `position or personal order appeared ${stage}`
      });
      log('entry_skipped_submit_race', {
        symbol, stage, observedPositionAmt: surface.positionAmt,
        openOrderCount: surface.regularOrders.length,
        openAlgoOrderCount: surface.conditionalOrders.length,
        reason: 'symbol changed during preflight; no entry order submitted'
      });
    };

    // D1 persistence takes a network round trip. Recheck after that write and
    // before changing symbol leverage so a manual position/order created in
    // the gap is not touched by a setting intended for the bot's trade.
    const preLeverageSurface = await readEntrySurface();
    if (entrySurfaceChanged(preLeverageSurface)) {
      await abandonBeforeSubmit(preLeverageSurface, 'before leverage change');
      return;
    }

    try {
      const leverageResult = await setLeverage(symbol, leverage);
      if (Number(leverageResult?.leverage) !== Math.round(leverage)) {
        throw new Error(`Binance did not confirm requested leverage ${Math.round(leverage)}x`);
      }
    } catch (error) {
      // No entry submission has happened, so this intent can be removed. If
      // cleanup itself fails, the persisted pending row fails conservatively
      // toward a one-hour quarantine rather than allowing an untracked order.
      delete state.openOrders[symbol];
      await saveState(state).catch((cleanupError) => {
        error.stateCleanupError = cleanupError.message;
      });
      await updateEntryIntent(entryIntentClientOrderId, {
        status: 'rejected-pre-submit', updatedAt: new Date().toISOString(),
        canceledAt: new Date().toISOString(), cancelReason: error.message
      }).catch(() => {});
      throw error;
    }

    // Narrow the original flat-check race. It cannot be mathematically
    // eliminated on a shared one-way account, so any observed position/order
    // aborts before the limit submission and is documented as such.
    const submitSurface = await readEntrySurface();
    if (entrySurfaceChanged(submitSurface)) {
      await abandonBeforeSubmit(submitSurface, 'after leverage change');
      return;
    }
    let order;
    try {
      order = await placeLimitOrderReconciled(symbol, side, quantity, limitPrice, {
        clientOrderId: entryIntentClientOrderId,
        goodTillDate: expiresMs,
        onBeforeSubmit: async () => {
          const finalSurface = await readEntrySurface();
          if (entrySurfaceChanged(finalSurface)) {
            const error = new Error('symbol changed immediately before limit-order submission');
            error.entryPreSubmitConflict = true;
            error.entrySurface = finalSurface;
            throw error;
          }
          pendingEntry.entrySubmissionUnknownAt = new Date().toISOString();
          await saveState(state);
        }
      });
    } catch (error) {
      if (error.entryPreSubmitConflict) {
        await abandonBeforeSubmit(error.entrySurface, 'immediately before order submission');
        return;
      }
      if (!error.outcomeUnknown) {
        // A positively rejected order cannot later fill. Intent mismatches are
        // retained as tombstones because their exchange state is not ours to
        // reinterpret or retry.
        if (!error.limitOrderIntentMismatch) {
          delete state.openOrders[symbol];
          await saveState(state).catch((cleanupError) => {
            error.stateCleanupError = cleanupError.message;
          });
        }
        await updateEntryIntent(entryIntentClientOrderId, {
          status: error.limitOrderIntentMismatch
            ? 'quarantined-intent-mismatch' : 'rejected',
          updatedAt: new Date().toISOString(),
          canceledAt: new Date().toISOString(), cancelReason: error.message
        }).catch(() => {});
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
    if (!limitOrderMatches(order, {
      symbol, side, quantity, price: limitPrice,
      clientOrderId: entryClientOrderId, goodTillDate: expiresMs
    })) throw new Error('Binance limit response failed exact frozen-intent verification');
    let executedQty = Math.abs(Number(order.executedQty));
    // Keep reconciliation armed even for a terminal fill until a fresh
    // position read and the verified ownership row have both been persisted.
    // A crash between the ACK/query response and that final save must not turn
    // the bot's real fill into an unprotected "foreign" position.
    pendingEntry.entryOrderPending = true;
    await updateEntryIntent(entryClientOrderId, {
      status: executedQty > 0 ? 'partially-filled' : 'resting',
      updatedAt: new Date().toISOString(), filledQty: executedQty || null
    });
    await saveState(state);
    if (!(executedQty > 0)) {
      if (isTerminalEntryOrder(order)) {
        delete state.openOrders[symbol];
        await saveState(state);
        await updateEntryIntent(entryClientOrderId, {
          status: String(order.status || 'terminal').toLowerCase(),
          updatedAt: new Date().toISOString(), canceledAt: new Date().toISOString(),
          cancelReason: 'entry order terminated before any fill'
        });
        log('entry_terminal_without_fill', {
          symbol, orderId: order.orderId, clientOrderId: entryClientOrderId,
          status: order.status
        });
        return;
      }
      log('resting_limit_placed', {
        symbol, side, quantity, leverage, orderId: order.orderId,
        clientOrderId: entryClientOrderId, signalPrice: offset.signalPrice,
        limitPrice, offsetPct: offset.offsetPct, expiresAt,
        reconciled: !!order.reconciled
      });
      return;
    }

    // LIMIT can partially fill immediately. Freeze the fill by canceling any
    // remainder before a close-all protective order is armed.
    if (!isTerminalEntryOrder(order)) {
      const canceled = await cancelTrackedEntry(
        symbol, pendingEntry,
        'partial fill: cancel remainder before protecting the owned fill',
        new Date().toISOString()
      );
      if (!canceled.terminal || !canceled.order) return;
      order = canceled.order;
      executedQty = Math.abs(Number(order.executedQty));
    }
    const reportedFill = Number(order.avgPrice);
    const cumulativeQuote = Number(order.cumQuote);
    const entryPrice = Number.isFinite(reportedFill) && reportedFill > 0
      ? reportedFill
      : Number.isFinite(cumulativeQuote) && cumulativeQuote > 0
        ? cumulativeQuote / executedQty
        : limitPrice;
    ({ stop, target, timeExit } = exitGeometry(candidate, decision, entryPrice));
    const filledAt = await exactOrFallbackFillTime(
      symbol, order, new Date().toISOString()
    );
    const actualMarginUsed = executedQty * entryPrice / leverage;
    log('opened_position', {
      symbol, side, quantity: executedQty, requestedQuantity: quantity,
      orderId: order.orderId, clientOrderId: entryClientOrderId,
      entryPrice, status: order.status, reconciled: !!order.reconciled
    });

    state.openOrders[symbol] = {
      roiPolicy: candidate.roiPolicy ?? null,
      leverageEvidence: { ...leveragePlan(candidate), tradingRange: candidate.tradingRange ?? null },
      activePolicy: candidate.activePolicy ?? null,
      side, entryPrice,
      marginUsed: Number.isFinite(actualMarginUsed) && actualMarginUsed > 0
        ? actualMarginUsed : marginToUse,
      leverage,
      range: candidate.range, targetPrice: target, stopPrice: stop,
      timeExitAfterMs: timeExit, source: candidate.source, openedAt: filledAt,
      entryPlacedAt: nowIso, entryFilledAt: filledAt,
      // Frozen at open: judging an outcome against evidence gathered later
      // would be hindsight, not measurement.
      edge: decision.edge ?? null, horizonHours: candidate.horizonHours ?? null,
      holdingMfePct: candidate.holding?.mfePct ?? null,
      holdingMaePct: candidate.holding?.maePct ?? null,
      holdingHoursToPeak: candidate.holding?.hoursToPeak ?? null,
      worstTradePct: candidate.worstTradePct ?? null,
      extremeBoost: !!extremeBoost, equityAtOpen: balance,
      entryClientOrderId, entryExecutedQty: executedQty, entryOriginalQty: executedQty,
      entryRequestedQty: quantity, entryOrderPending: false,
      entryOrderType: 'LIMIT', entryLimitPrice: limitPrice,
      entryExpiresAt: expiresAt, entrySubmissionUnknownAt: null,
      ownershipVerified: true, ownershipConflict: false,
      signalPrice: offset.signalPrice, signalPriceAt: candidate.signalPriceAt,
      entryOffsetPct: offset.offsetPct, entryOffsetBasis: offset.basis,
      wrongCallSamples: offset.wrongCallSamples,
      assetClass: candidate.assetClass, protectionOrders: []
    };
    await updateEntryIntent(entryClientOrderId, {
      status: executedQty + 1e-12 < quantity ? 'partially-filled-canceled' : 'filled',
      updatedAt: new Date().toISOString(), filledAt,
      filledQty: executedQty, avgFillPrice: entryPrice,
      stopPrice: stop, targetPrice: target
    });

    // Persist ownership promptly, then install exchange-side protection in
    // the same cycle instead of waiting for the next timer firing.
    await saveState(state).catch((e) =>
      log('critical_entry_state_persist_failed', { symbol, clientOrderId: entryClientOrderId, error: e.message }));
    if (!(executedQty > 0)) return;
    let amount = null;
    try {
      const observed = await getPositionAmount(symbol);
      if (Number.isFinite(observed) && observed !== 0) amount = observed;
      else log('warning_post_entry_position_temporarily_flat', {
        symbol,
        action: 'no protective order placed until a fresh position read proves the bot-owned quantity exists'
      });
    } catch (error) {
      log('warning_post_entry_position_refresh_unavailable', {
        symbol, error: error.message,
        action: 'no protective order placed until ownership can be freshly verified'
      });
    }
    if (!Number.isFinite(amount) || amount === 0) return;
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
      // fails protection. The protection-only service can retry without
      // misclassifying the position as the operator's.
      log('critical_immediate_protection_failed', { symbol, error: error.message });
    }
    await saveState(state).catch((e) =>
      log('critical_protection_state_persist_failed', { symbol, clientOrderId: entryClientOrderId, error: e.message }));
    if (config.shadowLedger) {
      await recordEntry({
        mode: 'live', candidate, decision,
        entryPrice, stopPrice: stop, targetPrice: target, openedAt: filledAt
      }).catch((e) => log('error_recording_ledger_entry', { symbol, error: e.message }));
    }
  } catch (e) {
    log('error_opening_position', { symbol, error: e.message });
  }
}

// A shadow LIMIT proposal: retained as an intent, never pretended to be a
// fill. The old market-entry shadow resolver continues to mature historical
// rows, but new policy rows need a real future touch of their limit before any
// later analysis may count them as entered.
async function recordShadow(decision, nowIso) {
  const { symbol, side, candidate } = decision;
  try {
    const { price: markPrice } = await getMarkPrice(symbol);
    const issue = signalReferenceIssue(candidate, Date.parse(nowIso), markPrice);
    const offset = entryOffsetPlan(candidate);
    const expiresMs = entryOrderExpiryMs(candidate);
    if (issue || !offset.ok || !(expiresMs > Date.parse(nowIso) + 10 * 60_000)) {
      log('shadow_limit_withheld', { symbol, reason: issue || offset.reason || 'invalid expiry' });
      return;
    }
    const rawLimit = entryLimitPrice(offset.signalPrice, side, offset.offsetPct);
    const limitPrice = await roundLimitPrice(symbol, rawLimit, side);
    const expiresAt = new Date(expiresMs).toISOString();
    const { stop, target, timeExit } = exitGeometry(candidate, decision, limitPrice);
    const clientOrderId = makeClientOrderId(
      'shad', symbol, side, candidate.source,
      candidate.signalPriceAt || '', offset.signalPrice,
      candidate.hypothesis || '', candidate.horizonHours || ''
    );
    await recordEntryIntent({
      clientOrderId, mode: 'shadow', status: 'proposed', createdAt: nowIso,
      expiresAt, assetClass: candidate.assetClass, symbol,
      signalSymbol: candidate.signalSymbol, side, source: candidate.source,
      signalGeneratedAt: candidate.signalGeneratedAt,
      signalPriceAt: candidate.signalPriceAt, signalPrice: offset.signalPrice,
      markPriceAtOrder: markPrice, limitPrice, offsetPct: offset.offsetPct,
      offsetBasis: offset.basis, medianDailyMovePct: offset.medianDailyMovePct,
      absolute24hMovePct: offset.absolute24hMovePct,
      adverseExcursionPct: offset.adversePct, adverseBasis: offset.adverseBasis,
      wrongCallSamples: offset.wrongCallSamples, conservativeEdge: decision.edge,
      positionPct: decision.positionPct, leverage: decision.leverage,
      requestedQty: null, stopPrice: stop, targetPrice: target,
      timeExitAfterMs: timeExit, horizonHours: candidate.horizonHours,
      evidence: { withheldReason: decision.reason, holdingN: candidate.holding?.n ?? null,
        roiPolicy: candidate.roiPolicy ?? null, leverageEvidence: leveragePlan(candidate),
        tradingRange: candidate.tradingRange ?? null,
        outcomeScope: 'limit reachability only; not a staged-exit profit simulation' }
    });
    log('shadow_limit_proposed', {
      symbol, side: decision.side, source: candidate.source,
      markPrice, signalPrice: offset.signalPrice, limitPrice,
      offsetPct: offset.offsetPct, expiresAt,
      withheldReason: decision.reason,
      note: 'not counted as a fill unless later price data proves the limit traded'
    });
  } catch (e) {
    log('error_recording_shadow_entry', { symbol, error: e.message });
  }
}

// Watch, do not touch. Manual/foreign positions are alert-only at every risk
// level. There is intentionally no configuration switch that can turn these
// observations into an order.
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

  const actionTaken = 'alert only; manual-position mutation is disabled in code';

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
  const closedMs = Date.parse(nowIso);
  if (!Number.isFinite(openedMs) || !Number.isFinite(closedMs) || closedMs < openedMs) {
    throw new Error('outcome window is missing or chronologically invalid');
  }
  const since = Math.max(0, openedMs - 1000);
  const entryOrder = await findOrderByClientId(symbol, record?.entryClientOrderId);
  if (!entryOrder || !recordedEntryMatches(entryOrder, symbol, record)) {
    throw new Error('exact bot entry order is unavailable or mismatches the durable ownership record');
  }
  const [income, fills] = await Promise.all([
    getIncomeSince(symbol, since, closedMs),
    getUserTradesSince(symbol, since, closedMs)
  ]);
  const exact = summarizeExactRoundTrip(record, fills, entryOrder.orderId);
  const marginIncome = income?.byAsset?.[exact.marginAsset];
  if (!income || !marginIncome) {
    throw new Error(`income ledger has no ${exact.marginAsset} rows for the proven round trip`);
  }
  const foreignFundingAssets = Object.entries(income.byAsset || {})
    .filter(([asset, totals]) => asset !== exact.marginAsset
      && Math.abs(Number(totals?.fundingFee) || 0) > 1e-12);
  if (foreignFundingAssets.length) {
    throw new Error('funding costs span multiple assets and cannot be added without conversion');
  }
  const fundingFee = Number(marginIncome.fundingFee);
  if (!Number.isFinite(fundingFee)) throw new Error('funding fee is not numeric');

  const marginUsed = Number(record?.marginUsed);
  if (!(marginUsed > 0)) throw new Error('recorded margin is unavailable for return calculation');
  const netPnl = exact.realizedPnl + exact.commission + fundingFee;
  const returnOnMarginPct = Number.isFinite(netPnl)
    ? (netPnl / marginUsed) * 100 : null;
  const holdingMinutes = Number.isFinite(openedMs) ? (Date.parse(nowIso) - openedMs) / 60000 : null;

  await recordTrade({
    symbol, side: record?.side || 'BUY', origin: 'bot', source: record?.source ?? null,
    openedAt: record?.openedAt ?? null, closedAt: nowIso,
    entryPrice: record?.entryPrice ?? null, exitPrice: exact.exitPrice,
    quantity: exact.quantity,
    leverage: record?.leverage ?? null, marginUsed: Number.isFinite(marginUsed) ? marginUsed : null,
    realizedPnl: exact.realizedPnl, commission: exact.commission,
    fundingFee, netPnl,
    returnOnMarginPct,
    holdingMinutes, exitReason: record?.exitReason ?? 'exchange-or-manual',
    edge: record?.edge ?? null, horizonHours: record?.horizonHours ?? null,
    holdingMfePct: record?.holdingMfePct ?? null, holdingMaePct: record?.holdingMaePct ?? null,
    holdingHoursToPeak: record?.holdingHoursToPeak ?? null,
    extremeBoost: record?.extremeBoost, equityAtOpen: record?.equityAtOpen ?? null,
    equityAtClose: equityNow
  });
  await finalizeEntryIntent(record?.entryClientOrderId, {
    closedAt: nowIso, netPnl, returnOnMarginPct,
    exitReason: record?.exitReason ?? 'exchange-or-manual'
  });
  log('trade_recorded', {
    symbol, netPnl, exitPrice: exact.exitPrice,
    holdingMinutes: holdingMinutes && Math.round(holdingMinutes)
  });
}

async function runCycle() {
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();
  const state = await loadState();

  let account = await getAccount();
  // An entry order observed pending in a prior cycle is reconciled before
  // ownership classification. Refresh the account afterward so a fill that
  // arrived during reconciliation is not mistaken for a manual position.
  if (await reconcilePendingEntries(state)) account = await getAccount();
  await applyPolicyExits(state);
  account = await getAccount();
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
  await retireLegacyAssistedProtection().catch((e) =>
    log('error_retiring_legacy_assisted_protection', {
      error: e.message,
      action: 'no new assisted stops can be created; retrying exact cleanup next cycle'
    }));
  // Positions the operator opened are NOT managed: no stop, no take-profit, no
  // time exit. An unrequested protective order can close somebody else's trade
  // against their intent, which is its own kind of loss. They are watched, and
  // spoken about only when a reading suggests a large loss is imminent.
  const ownPositions = [];
  for (const p of openPositionsRaw) {
    if (state.openOrders[p.symbol]?.managedExit) continue;
    const actualSide = Number(p.positionAmt) > 0 ? 'BUY' : 'SELL';
    const origin = positionOrigin(p.symbol, state, actualSide, Number(p.positionAmt));
    if (origin === 'bot') { ownPositions.push(p); continue; }
    if (origin === 'conflict') {
      const record = state.openOrders[p.symbol];
      if (record) {
        record.ownershipVerified = false;
        record.ownershipConflict = true;
        if (!config.dryRun) {
          await cancelTrackedEntry(
            p.symbol, record, 'position ownership conflict', nowIso
          ).catch((error) => log('error_cancelling_conflicted_entry', {
            symbol: p.symbol, error: error.message
          }));
          await cancelTrackedProtection(p.symbol, record)
            .catch((error) => log('error_cancelling_conflicted_protection', {
              symbol: p.symbol, error: error.message
            }));
        }
      }
      log('position_ownership_conflict', {
        symbol: p.symbol, recordedSide: state.openOrders[p.symbol]?.side,
        recordedQuantity: state.openOrders[p.symbol]?.entryExecutedQty ?? null,
        actualSide, actualQuantity: Math.abs(Number(p.positionAmt)),
        action: 'treated as operator-managed; no bot stop, target, or time exit'
      });
    }
    await cancelOrphanedBotOrdersOnForeignPosition(p.symbol).catch((error) =>
      log('error_cancelling_bot_orders_on_foreign_position', {
        symbol: p.symbol, error: error.message,
        action: 'operator-managed position remains excluded from stop/target/time-exit logic; exact cleanup retries next cycle'
      }));
    await watchForeignPosition(p, risk, equity, nowIso);
  }
  await saveState(state);
  for (const p of ownPositions) {
    try { await ensureProtection(p, state, risk); } catch (e) { log('error_ensuring_protection', { symbol: p.symbol, error: e.message }); }
  }
  // Persist exact protection identities before lower-priority research and
  // signal work. If a later network call hangs, the next cycle can still
  // reconcile or cancel only the bot's own conditional orders.
  await saveState(state);
  // Research bookkeeping is intentionally after the protection pass. It can
  // wait; a newly-filled leveraged entry should not wait behind price lookups
  // for simulated positions.
  await resolveShadowLedger(nowIso, nowMs);
  const reachability = await resolveMatureEntryIntentProposals(nowIso).catch((error) => {
    log('error_resolving_limit_reachability', { error: error.message });
    return null;
  });
  if (reachability?.checked) log('limit_reachability_research', reachability);
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
          action: 'no same-symbol entry until the existing entry order is terminal'
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
          // longer armed. Dropping them could leave a stale reduce-only order
          // able to reduce a later same-symbol net position.
          openSymbolsNow.add(symbol);
          log('error_cancelling_closed_position_siblings', {
            symbol, error: e.message,
            action: 'ownership tombstone retained; same-symbol entries blocked until exact cancellation verifies'
          });
        }
      }
      if (!protectionCleared) continue;
      if (record.ownershipConflict) {
        openSymbolsNow.add(symbol);
        record.ownershipVerified = false;
        log('retained_ownership_conflict_tombstone', {
          symbol,
          reason: 'orders are cleared, but unresolved bot P&L must not disappear from the entry-risk gate'
        });
        continue;
      }
      const firstDetection = !record.closedDetectedAt;
      record.closedDetectedAt = record.closedDetectedAt || nowIso;
      record.outcomePending = true;
      // Once flat has been observed, this ownership proof is spent. If the
      // operator opens the same side/quantity while outcome capture retries,
      // it must never be mistaken for the old bot position.
      record.ownershipVerified = false;
      // Keep the symbol blocked and persist the frozen close timestamp before
      // querying exchange history. A timeout must retry the same evidence
      // window next cycle, never erase the ownership row or manufacture null
      // P&L from a partial response.
      openSymbolsNow.add(symbol);
      await saveState(state);
      if (firstDetection) log('detected_position_closed', {
        symbol, closedDetectedAt: record.closedDetectedAt,
        action: 'exact exchange outcome capture pending'
      });
      try {
        await captureOutcome(symbol, record, equity, record.closedDetectedAt);
      } catch (e) {
        log('error_recording_outcome', {
          symbol, error: e.message,
          action: 'flat-position tombstone retained; same-symbol entry blocked and exact capture retries next cycle'
        });
        continue;
      }
      state.lastClosedAt[symbol] = record.closedDetectedAt;
      delete state.openOrders[symbol];
      openSymbolsNow.delete(symbol);
      log('outcome_capture_complete', { symbol, closedAt: record.closedDetectedAt });
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
  await applyPolicyExits(state, allCandidates.filter(c => c.authorized));

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
    const market = tradable[c.symbol];
    const eligible = marketEligibleForAssetClass(market, c.assetClass, c.signalSymbol);
    if (eligible) return true;
    log('decision_skip', {
      symbol: c.symbol,
      reason: market
        ? `Binance contract metadata does not prove it is the active ${c.assetClass} instrument for ${c.signalSymbol} with USDT/LIMIT/GTD support`
        : 'no Binance USDS-M futures market for this asset'
    });
    return false;
  });

  // Four bounded workers; one low-weight public history read per candidate.
  // No backfilled/forming daily candle may qualify for higher leverage.
  const rangeQueue = [...candidates];
  await Promise.all(Array.from({ length: Math.min(4, rangeQueue.length) }, async () => {
    while (rangeQueue.length) {
      const candidate = rangeQueue.shift();
      try { candidate.tradingRange = await getDailyRangeStats(candidate.symbol); }
      catch { candidate.tradingRange = null; }
    }
  }));

  // Equity-style contracts do not carry funding in the stock signal feed.
  // Read it from the exact Binance contract instead of silently treating a
  // missing value as zero. This is public market data and does not mutate the
  // account.
  for (const candidate of candidates) {
    if (candidate.funding != null && Number.isFinite(Number(candidate.funding))) continue;
    try {
      const quote = await getMarkPrice(candidate.symbol);
      candidate.funding = Number.isFinite(quote.fundingRate) ? quote.fundingRate : null;
      candidate.exchangeMarkPrice = Number.isFinite(quote.price) ? quote.price : null;
    } catch (error) {
      candidate.funding = null;
      log('warning_candidate_funding_unavailable', { symbol: candidate.symbol, error: error.message });
    }
  }

  const fearGreed = getFearGreed(signals);
  const openPositions = openPositionsRaw.map((p) => ({
    notional: Math.abs(Number(p.notional)),
    leverage: Number(risk[p.symbol]?.leverage)
      || Number(state.openOrders[p.symbol]?.leverage) || 1,
    source: state.openOrders[p.symbol]?.source || 'confluence-v7'
  }));
  // Reserve margin for resting entries which can all fill while this process
  // is asleep. Ignoring them would let several individually valid limits
  // collectively exceed the portfolio exposure ceiling.
  const actualSymbols = new Set(openPositionsRaw.map((p) => p.symbol));
  for (const [symbol, record] of Object.entries(state.openOrders)) {
    if (actualSymbols.has(symbol) || !record.entryOrderPending) continue;
    const margin = Number(record.marginUsed);
    const lev = Number(record.leverage);
    if (margin > 0 && lev > 0) openPositions.push({
      notional: margin * lev, leverage: lev,
      source: record.source || 'confluence-v7', pendingEntry: true
    });
  }
  let botRisk = null;
  if (config.activeLimitMode) {
    try {
      botRisk = assessBotEntryRisk(await loadBotLossSummary(nowIso), await getAccount(), state);
    } catch {
      botRisk = { ok: false, reason: 'bot risk accounting unavailable' };
    }
    log('bot_entry_risk', botRisk);
  }
  const { decisions, paused } = decideEntries(candidates, {
    fearGreed, openSymbols: openSymbolsNow, openPositions, balance, equity, state, nowMs, botRisk
  });

  if (paused) log('entries_paused', { reason: paused });

  const [legacyShadowRows, proposedShadowSymbols] = await Promise.all([
    loadOpenShadowTrades().catch(() => []),
    loadActiveEntryIntentSymbols('shadow', nowIso).catch(() => [])
  ]);
  const shadowSymbols = new Set([
    ...legacyShadowRows.filter((r) => r.mode === 'shadow').map((r) => r.symbol),
    ...proposedShadowSymbols
  ]);
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
    // The protection-only pass is deliberately offset from this timer, but a
    // slow network call can still make them meet. Give that short pass time to
    // release its lease so a harmless collision does not drop an entire
    // five-minute decision cycle.
    const leaseDeadline = Date.now() + 30_000;
    do {
      lease = await acquireExecutionLease();
      if (lease || Date.now() >= leaseDeadline) break;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    } while (!lease);
    if (!lease) {
      log('cycle_skipped_overlap', {
        lease: 'futures-cycle',
        reason: 'another futures process still holds the execution lease after 30 seconds; no exchange action attempted'
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
