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
import { getExchangeInfo, getFreeBalance, getPrice, getWeeklyKlines, marketBuyQuote, roundQuantity, marketBuyQuantity } from './binance-spot.mjs';
import { selectAssets, weeklyProfile, evaluateTrigger, tranchePool, trancheDue, periodsElapsed } from './strategy.mjs';
import { loadState, saveState, recordFill, recordSkip, costBasis } from './state.mjs';

const log = (event, data = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), event, ...data }));

async function fetchSignals() {
  const res = await fetch(`${config.signalsBase}/api/signals`);
  if (!res.ok) throw new Error(`signals fetch failed: HTTP ${res.status}`);
  return res.json();
}

async function buyOne(asset, quoteAmount, price, profile, trigger, nowIso, tradable) {
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
  let order;
  if (info?.quoteOrderQtyAllowed) {
    order = await marketBuyQuote(asset.symbol, quoteAmount);
  } else {
    const qty = await roundQuantity(asset.symbol, quoteAmount / price);
    if (!(qty > 0)) return { spent: 0, deferred: quoteAmount, reason: 'rounded quantity is zero for this pair' };
    order = await marketBuyQuantity(asset.symbol, qty);
  }

  const filledQty = Number(order.executedQty ?? 0) || null;
  const spentQuote = Number(order.cummulativeQuoteQty ?? quoteAmount);
  log('bought', { symbol: asset.symbol, sleeve: asset.sleeve, quote: Number(spentQuote.toFixed(2)), qty: filledQty, orderId: order.orderId, trigger: trigger.trigger });
  await recordFill({ ...base, mode: 'live', quoteSpent: spentQuote, quantity: filledQty, orderId: String(order.orderId ?? '') });
  return { spent: spentQuote, deferred: 0 };
}

async function runCycle() {
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();
  const state = await loadState();

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

  let spentTotal = 0;
  let deferredTotal = 0;

  for (const asset of selected) {
    const share = pool * asset.weight;
    try {
      const [price, klines] = await Promise.all([
        getPrice(asset.symbol),
        getWeeklyKlines(asset.symbol, config.klineWeeks)
      ]);
      const profile = weeklyProfile(klines);
      const trigger = evaluateTrigger(price, profile);

      if (!trigger.buy) {
        log('skip', { symbol: asset.symbol, sleeve: asset.sleeve, price, deferred: Number(share.toFixed(2)), reason: trigger.reason });
        await recordSkip({ skippedAt: nowIso, symbol: asset.symbol, reason: trigger.reason, price, quoteDeferred: share });
        deferredTotal += share;
        continue;
      }

      const result = await buyOne(asset, share, price, profile, trigger, nowIso, tradable);
      spentTotal += result.spent;
      deferredTotal += result.deferred;
      if (result.deferred > 0) {
        log('skip', { symbol: asset.symbol, reason: result.reason, deferred: Number(result.deferred.toFixed(2)) });
        await recordSkip({ skippedAt: nowIso, symbol: asset.symbol, reason: result.reason, price, quoteDeferred: result.deferred });
      }
    } catch (e) {
      log('error_asset', { symbol: asset.symbol, error: e.message });
      deferredTotal += share;
    }
  }

  // The marker only advances when something was actually bought. If the whole
  // cycle was declined, the tranche stays due and the next firing (hours, not
  // a week) re-checks — and once a whole further period has passed, the pool
  // grows by one tranche on its own. Nothing is stored to make that happen.
  log('cycle_summary', {
    spent: Number(spentTotal.toFixed(2)),
    deferred: Number(deferredTotal.toFixed(2)),
    trancheAdvanced: spentTotal > 0,
    note: spentTotal > 0 ? 'tranche spent; clock restarts'
      : 'nothing met its bar; tranche stays due and the pool grows a tranche per further period'
  });

  if (spentTotal > 0) await saveState({ lastTrancheAt: nowIso, dryPowder: 0 }, nowIso);

  for (const row of await costBasis().catch(() => [])) {
    log('holding', {
      symbol: row.symbol, sleeve: row.sleeve, fills: row.fills,
      spent: Number(Number(row.spent).toFixed(2)),
      avgCost: row.qty > 0 ? Number((row.spent / row.qty).toFixed(8)) : null,
      since: row.first_fill
    });
  }
}

log('spot_bot_starting', { dryRun: config.dryRun });
try {
  await runCycle();
  log('cycle_end', {});
} catch (e) {
  log('error_cycle', { error: e.message, stack: e.stack });
  process.exitCode = 1;
}
