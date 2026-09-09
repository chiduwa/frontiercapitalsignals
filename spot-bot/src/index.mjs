// Runs ONE spot cycle and exits. Fired daily by a systemd timer; whether the
// firing is actually a tranche cycle is decided by elapsed days (see
// trancheDue), so a missed firing delays a tranche rather than skipping it.
//
// The flow: read the published signals payload -> screen a core and satellite
// sleeve from descriptive measures only -> for each asset, measure its own
// weekly distribution from Binance candles -> spend its share only if price
// has actually fallen by that asset's own standard -> bank anything unspent as
// dry powder for a later, larger buy.
//
// Accumulate only. There is no sell path: an exit needs a directional or
// valuation call and the engine withholds both, so a sell rule written today
// would be invented rather than measured.
import { config } from './config.mjs';
import {
  getExchangeInfo, getFreeBalance, getPrice, getWeeklyKlines, makeClientOrderId,
  marketBuyReconciled, roundQuantity, terminalSpotOrder
} from './binance-spot.mjs';
import { selectAssets, weeklyProfile, evaluateTrigger, tranchePool, trancheDue, periodsElapsed, allocate } from './strategy.mjs';
import {
  acquireExecutionLease, releaseExecutionLease, loadState, saveState,
  recordFill, recordSkip, costBasis, logValuation
} from './state.mjs';

const log = (event, data = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), event, ...data }));

async function fetchSignals() {
  const res = await fetch(`${config.signalsBase}/api/signals`);
  if (!res.ok) throw new Error(`signals fetch failed: HTTP ${res.status}`);
  return res.json();
}

async function buyOne(asset, quoteAmount, price, profile, trigger, nowIso, tradable, trancheIntent) {
  const info = tradable[asset.symbol];
  const minNotional = Math.max(config.minOrderQuote, info?.minNotional || 0);
  if (quoteAmount < minNotional) {
    return { spent: 0, deferred: quoteAmount, reason: `share ${quoteAmount.toFixed(2)} below the ${minNotional.toFixed(2)} minimum order for this pair` };
  }

  const base = {
    filledAt: nowIso, symbol: asset.symbol, signalSymbol: asset.signalSymbol,
    sleeve: asset.sleeve, trigger: trigger.trigger, triggerReason: trigger.reason,
    quoteSpent: quoteAmount, price,
    weeklySigma: profile.weeklySigma, typicalDrawdown: profile.typicalDrawdown,
    weeksHistory: profile.weeks
  };

  if (config.dryRun) {
    log('dry_run_would_buy', { symbol: asset.symbol, sleeve: asset.sleeve, quote: Number(quoteAmount.toFixed(2)), price, trigger: trigger.trigger, reason: trigger.reason });
    await recordFill({ ...base, mode: 'dry', quantity: quoteAmount / price });
    return { spent: quoteAmount, deferred: 0 };
  }

  // quoteOrderQty is the natural expression of "spend this tranche" and needs
  // no quantity rounding at all. Where a pair does not allow it, fall back to
  // a step-rounded quantity.
  const clientOrderId = makeClientOrderId(trancheIntent, asset.symbol);
  let order;
  if (info?.quoteOrderQtyAllowed) {
    order = await marketBuyReconciled({ symbol: asset.symbol, quoteQty: quoteAmount, clientOrderId, intentEpoch: trancheIntent });
  } else {
    const qty = await roundQuantity(asset.symbol, quoteAmount / price);
    if (!(qty > 0)) return { spent: 0, deferred: quoteAmount, reason: 'rounded quantity is zero for this pair' };
    order = await marketBuyReconciled({ symbol: asset.symbol, quantity: qty, clientOrderId, intentEpoch: trancheIntent });
  }

  const filledQty = Number(order.executedQty ?? 0) || null;
  const spentQuote = Number(order.cummulativeQuoteQty ?? 0);
  if (order.pending || !terminalSpotOrder(order)) {
    const error = new Error(`Binance spot order ${order.orderId ?? clientOrderId} remains ${order.status || 'nonterminal'} after settlement polling`);
    error.outcomeUnknown = true;
    error.clientOrderId = order.clientOrderId || clientOrderId;
    error.executedQty = Number(order.executedQty ?? 0);
    error.cummulativeQuoteQty = Number(order.cummulativeQuoteQty ?? 0);
    throw error;
  }
  if (!(filledQty > 0) || !(spentQuote > 0)) {
    throw new Error(`Binance order ${order.orderId ?? clientOrderId} has no confirmed fill (status ${order.status || 'unknown'})`);
  }
  const fillPrice = spentQuote / filledQty;
  log('bought', {
    symbol: asset.symbol, sleeve: asset.sleeve, quote: Number(spentQuote.toFixed(2)),
    qty: filledQty, orderId: order.orderId, clientOrderId: order.clientOrderId || clientOrderId, reconciled: !!order.reconciled,
    trigger: trigger.trigger
  });
  try {
    await recordFill({
      ...base, mode: 'live', quoteSpent: spentQuote, price: fillPrice,
      quantity: filledQty, orderId: String(order.orderId ?? '')
    });
  } catch (error) {
    // The exchange fill is authoritative even if its D1 mirror is briefly
    // unavailable. Surface the confirmed spend so the parent tranche still
    // advances and cannot be submitted again under a new epoch.
    error.confirmedSpentQuote = spentQuote;
    error.confirmedOrderId = order.orderId ?? null;
    error.fillPersistenceFailed = true;
    throw error;
  }
  return { spent: spentQuote, deferred: 0 };
}

async function runCycle() {
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();
  const state = await loadState();
  // Stable across retries until a tranche is actually completed. If a
  // process dies after Binance fills an order but before D1 advances the
  // marker, the next cycle queries the same client IDs instead of buying the
  // same assets twice.
  let trancheIntent = state.lastTrancheAt || 'initial-tranche';

  const periods = periodsElapsed(state.lastTrancheAt, nowMs);
  const due = trancheDue(state.lastTrancheAt, nowMs);
  const freeQuote = await getFreeBalance(config.quoteAsset);
  const { base, carryTranches, pool } = tranchePool(freeQuote, periods);

  log('cycle_start', {
    dryRun: config.dryRun, quoteAsset: config.quoteAsset,
    freeQuote: Number(freeQuote.toFixed(2)),
    trancheDue: due, lastTrancheAt: state.lastTrancheAt,
    periodsElapsed: periods, carriedTranches: carryTranches,
    poolThisCycle: Number(pool.toFixed(2))
  });

  if (!due) {
    const days = config.tranchePeriodDays;
    log('not_a_tranche_cycle', { reason: `next tranche ${days} days after ${state.lastTrancheAt}` });
    return;
  }
  if (!(pool > 0)) {
    log('nothing_to_spend', { freeQuote: Number(freeQuote.toFixed(2)), reserve: config.reserveQuote });
    return;
  }

  const [signals, tradable] = await Promise.all([fetchSignals(), getExchangeInfo()]);
  const selected = selectAssets(signals, tradable);
  log('selection', {
    model: signals.model,
    core: selected.filter((a) => a.sleeve === 'core').map((a) => a.signalSymbol),
    satellite: selected.filter((a) => a.sleeve === 'satellite').map((a) => a.signalSymbol),
    note: 'screened on published quality percentile, market-cap rank and the near-multi-month-low board only; no directional call is used'
  });
  if (!selected.length) {
    log('no_candidates', { reason: 'nothing in the universe cleared the screen and is spot-tradable here' });
    return;
  }

  // Pass 1: measure every selected asset and record who triggered. No money is
  // committed here, so the allocation in pass 2 can see the full picture.
  const triggered = [];
  let spentTotal = 0;
  let deferredTotal = 0;
  let quarantineTranche = false;

  for (const asset of selected) {
    try {
      const [price, klines] = await Promise.all([
        getPrice(asset.symbol),
        getWeeklyKlines(asset.symbol, config.klineWeeks)
      ]);
      const profile = weeklyProfile(klines);
      const trigger = evaluateTrigger(price, profile);
      if (!trigger.buy) {
        log('skip', { symbol: asset.symbol, sleeve: asset.sleeve, price, reason: trigger.reason });
        await recordSkip({ skippedAt: nowIso, symbol: asset.symbol, reason: trigger.reason, price, quoteDeferred: pool * asset.weight });
        continue;
      }
      triggered.push({ ...asset, price, profile, trigger });
    } catch (e) {
      log('error_asset', { symbol: asset.symbol, error: e.message });
    }
  }

  if (!triggered.length) {
    log('no_triggers', { checked: selected.length, reason: 'no asset met its own measured bar this cycle' });
  }

  // Pass 2: fund as many of them as the pool can actually cover at or above
  // each pair's minimum order size, rather than handing every asset a share
  // too small for the exchange to accept.
  const minNotionalFor = (symbol) =>
    Math.max(config.minOrderQuote, tradable[symbol]?.minNotional || 0);
  const funded = allocate(triggered, pool, minNotionalFor);
  let trancheReserved = false;

  if (triggered.length && !funded.length) {
    log('pool_too_small', {
      pool: Number(pool.toFixed(2)), triggered: triggered.map((a) => a.symbol),
      cheapestMinimum: Math.min(...triggered.map((a) => minNotionalFor(a.symbol))),
      reason: 'the whole tranche cannot cover even one minimum order; deferring so it can accumulate'
    });
  } else if (funded.length < triggered.length) {
    log('allocation_concentrated', {
      funded: funded.map((a) => a.symbol), perAsset: Number((pool / funded.length).toFixed(2)),
      notFunded: triggered.slice(funded.length).map((a) => a.symbol),
      reason: 'pool split across as many triggered assets as clear their minimum order size, in rank order'
    });
  }

  if (!config.dryRun && funded.length) {
    // Reserve the tranche clock durably before the first exchange submission.
    // If this process is killed after one fill, the next cycle cannot recompute
    // and spend the full pool again on a different set of assets. The rare
    // failure trade-off is a deferred/forfeited remainder, never over-allocation.
    trancheIntent = nowIso;
    await saveState({ lastTrancheAt: nowIso, dryPowder: 0 }, nowIso);
    trancheReserved = true;
    log('tranche_reserved', {
      trancheIntent, budget: Number(pool.toFixed(2)), allocations: funded.length,
      reason: 'write-ahead clock committed before any live market order'
    });
  }

  for (const asset of funded) {
    try {
      const result = await buyOne(asset, asset.quote, asset.price, asset.profile, asset.trigger, nowIso, tradable, trancheIntent);
      spentTotal += result.spent;
      deferredTotal += result.deferred;
      if (result.deferred > 0) {
        log('skip', { symbol: asset.symbol, reason: result.reason, deferred: Number(result.deferred.toFixed(2)) });
        await recordSkip({ skippedAt: nowIso, symbol: asset.symbol, reason: result.reason, price: asset.price, quoteDeferred: result.deferred });
      }
    } catch (e) {
      log('error_asset', { symbol: asset.symbol, error: e.message });
      if (Number(e.confirmedSpentQuote) > 0) spentTotal += Number(e.confirmedSpentQuote);
      if (e.outcomeUnknown || e.fillPersistenceFailed) {
        quarantineTranche = true;
        log('tranche_execution_quarantined', {
          symbol: asset.symbol,
          clientOrderId: e.clientOrderId ?? null,
          executedQtyObserved: e.executedQty ?? null,
          quoteObserved: e.cummulativeQuoteQty ?? e.confirmedSpentQuote ?? null,
          reason: e.fillPersistenceFailed
            ? 'a confirmed fill could not be mirrored to D1'
            : 'exchange outcome is not terminally known',
          action: 'no more sibling orders this cycle; tranche epoch advances to prevent duplicate spend'
        });
        break;
      }
    }
  }
  deferredTotal += Math.max(0, pool - spentTotal - deferredTotal);

  // The marker advances after a confirmed buy, or after an ambiguous exchange
  // submission which is deliberately quarantined so a different client ID can
  // never spend the same tranche twice. Purely declined cycles remain due; the
  // next firing re-checks and later periods grow the pool from the clock.
  log('cycle_summary', {
    spent: Number(spentTotal.toFixed(2)),
    deferred: Number(deferredTotal.toFixed(2)),
    trancheAdvanced: trancheReserved || spentTotal > 0 || quarantineTranche,
    note: spentTotal > 0 ? 'tranche spent; clock restarts'
      : quarantineTranche ? 'ambiguous exchange outcome quarantined; clock advances so it cannot duplicate'
      : 'nothing met its bar; tranche stays due and the pool grows a tranche per further period'
  });

  if (!trancheReserved && (spentTotal > 0 || quarantineTranche)) {
    await saveState({ lastTrancheAt: nowIso, dryPowder: 0 }, nowIso);
  }

  // Mark to market. Prices for the selected set were already fetched above, so
  // the only extra work is for a holding no longer in the current selection —
  // which still needs valuing, or a position would vanish from the record the
  // moment the screen stopped picking it.
  const priced = new Map(triggered.map((a) => [a.symbol, a.price]));
  const valuations = [];
  for (const row of await costBasis().catch(() => [])) {
    const avgCost = row.qty > 0 ? row.spent / row.qty : null;
    let price = priced.get(row.symbol) ?? null;
    if (price == null) price = await getPrice(row.symbol).catch(() => null);
    const marketValue = price != null ? price * row.qty : null;
    const unrealizedPct = (avgCost && price) ? ((price / avgCost) - 1) * 100 : null;
    if (price != null) {
      valuations.push({ symbol: row.symbol, quantity: row.qty, price, marketValue, costBasis: row.spent, unrealizedPct });
    }
    log('holding', {
      symbol: row.symbol, sleeve: row.sleeve, fills: row.fills,
      spent: Number(Number(row.spent).toFixed(2)),
      avgCost: avgCost != null ? Number(avgCost.toFixed(8)) : null,
      price, marketValue: marketValue != null ? Number(marketValue.toFixed(2)) : null,
      unrealizedPct: unrealizedPct != null ? Number(unrealizedPct.toFixed(2)) : null,
      since: row.first_fill
    });
  }
  await logValuation(nowIso, valuations).catch((e) => log('error_logging_valuation', { error: e.message }));
  if (valuations.length) {
    const mv = valuations.reduce((t, v) => t + v.marketValue, 0);
    const cb = valuations.reduce((t, v) => t + (v.costBasis || 0), 0);
    log('portfolio', {
      positions: valuations.length, costBasis: Number(cb.toFixed(2)),
      marketValue: Number(mv.toFixed(2)),
      returnOnAssetPct: cb > 0 ? Number((((mv / cb) - 1) * 100).toFixed(2)) : null
    });
  }
}

log('spot_bot_starting', { dryRun: config.dryRun });
let lease = null;
try {
  lease = await acquireExecutionLease();
  if (!lease) {
    log('cycle_skipped_overlap', {
      lease: 'spot-cycle',
      reason: 'another spot process holds the execution lease; no exchange action attempted'
    });
  } else {
    await runCycle();
    log('cycle_end', {});
  }
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
