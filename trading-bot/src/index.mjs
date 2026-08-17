// Main loop. One cycle = fetch real account state + live signals -> decide
// -> execute (or log-only, if DRY_RUN) -> protect every open position with
// a real exchange-side stop/take-profit -> persist state -> sleep.
//
// Protective orders are placed on the EXCHANGE (via the Algo Order API,
// see binance.mjs), not simulated in this process — so a position stays
// protected even if this bot crashes or the VM reboots. That's the single
// most important safety property of this design for an unattended
// leveraged system.
import { config } from './config.mjs';
import { log } from './logger.mjs';
import { loadState, saveState, recordEquity } from './state.mjs';
import {
  getAccount, getOpenAlgoOrders, setLeverage, getMarkPrice,
  placeMarketOrder, placeProtectiveOrder, roundQuantity, roundPrice
} from './binance.mjs';
import { fetchSignals, fetchIntraday, buildCandidates, getFearGreed } from './signals.mjs';
import { decideEntries } from './strategy.mjs';
import { stopLossPrice, takeProfitPrice } from './risk.mjs';

async function ensureProtection(position, state) {
  const symbol = position.symbol;
  const existing = await getOpenAlgoOrders(symbol);
  const hasStop = existing.some((o) => o.orderType === 'STOP_MARKET' || o.type === 'STOP_MARKET');
  const hasTp = existing.some((o) => o.orderType === 'TAKE_PROFIT_MARKET' || o.type === 'TAKE_PROFIT_MARKET');
  if (hasStop && hasTp) return;

  const side = Number(position.positionAmt) > 0 ? 'BUY' : 'SELL';
  const closingSide = side === 'BUY' ? 'SELL' : 'BUY';
  const entryPrice = Number(position.entryPrice);
  const leverage = Number(position.leverage) || config.minLeverage;
  const recorded = state.openOrders[symbol];

  if (!hasStop) {
    const raw = stopLossPrice(entryPrice, side, leverage);
    const price = await roundPrice(symbol, raw);
    if (config.dryRun) {
      log('dry_run_would_place_stop', { symbol, side: closingSide, triggerPrice: price });
    } else {
      const order = await placeProtectiveOrder(symbol, closingSide, 'STOP_MARKET', price);
      log('placed_stop_loss', { symbol, triggerPrice: price, algoId: order.algoId });
    }
  }
  if (!hasTp) {
    const range = recorded?.range;
    const raw = range ? takeProfitPrice(side, range) : null;
    if (raw == null) {
      log('warning_no_take_profit_target', { symbol, reason: 'no recorded predicted range for this position (likely opened before this bot, or state was lost) — stop-loss only' });
      return;
    }
    const price = await roundPrice(symbol, raw);
    if (config.dryRun) {
      log('dry_run_would_place_take_profit', { symbol, side: closingSide, triggerPrice: price });
    } else {
      const order = await placeProtectiveOrder(symbol, closingSide, 'TAKE_PROFIT_MARKET', price);
      log('placed_take_profit', { symbol, triggerPrice: price, algoId: order.algoId });
    }
  }
}

async function executeOpen(decision, state, nowIso) {
  const { symbol, side, positionPct, leverage, extremeBoost, candidate } = decision;
  try {
    const account = await getAccount();
    const balance = Number(account.totalMarginBalance);
    const marginToUse = balance * positionPct;
    const { price: markPrice } = await getMarkPrice(symbol);
    const notional = marginToUse * leverage;
    const rawQuantity = notional / markPrice;
    const quantity = await roundQuantity(symbol, rawQuantity);
    if (!(quantity > 0)) {
      log('skip_zero_quantity', { symbol, reason: 'rounded quantity is zero — position size too small for this symbol\'s lot step' });
      return;
    }

    log('decision_open', { symbol, side, positionPct, leverage, extremeBoost, marginToUse, quantity, markPrice, confidence: decision.confidence, range: candidate.range });

    if (config.dryRun) {
      log('dry_run_would_open', { symbol, side, quantity, leverage });
    } else {
      await setLeverage(symbol, leverage);
      const order = await placeMarketOrder(symbol, side, quantity);
      log('opened_position', { symbol, side, quantity, orderId: order.orderId });
    }

    state.openOrders[symbol] = { side, entryPrice: markPrice, marginUsed: marginToUse, leverage, range: candidate.range, openedAt: nowIso };
  } catch (e) {
    log('error_opening_position', { symbol, error: e.message });
  }
}

async function runCycle() {
  const nowIso = new Date().toISOString();
  const state = loadState();

  const account = await getAccount();
  const equity = Number(account.totalMarginBalance);
  const balance = Number(account.totalMarginBalance);
  recordEquity(state, equity, nowIso);

  const openPositionsRaw = (account.positions || []).filter((p) => Math.abs(Number(p.positionAmt)) > 0);
  log('cycle_start', { equity, openPositionCount: openPositionsRaw.length, dryRun: config.dryRun });

  // Protect every currently-open position first, before considering new
  // entries — an unprotected leveraged position is the single biggest
  // risk in this whole system.
  for (const p of openPositionsRaw) {
    try { await ensureProtection(p, state); } catch (e) { log('error_ensuring_protection', { symbol: p.symbol, error: e.message }); }
  }

  // Reconcile: any symbol this bot thought it had open but Binance no
  // longer shows (closed via stop/take-profit, or manually) starts its
  // cooldown timer now.
  const openSymbolsNow = new Set(openPositionsRaw.map((p) => p.symbol));
  for (const symbol of Object.keys(state.openOrders)) {
    if (!openSymbolsNow.has(symbol)) {
      state.lastClosedAt[symbol] = nowIso;
      delete state.openOrders[symbol];
      log('detected_position_closed', { symbol });
    }
  }

  const [signals, intraday] = await Promise.all([fetchSignals(), fetchIntraday()]);
  const candidates = buildCandidates(signals, intraday);
  const fearGreed = getFearGreed(signals);

  const openPositions = openPositionsRaw.map((p) => ({ notional: Math.abs(Number(p.notional)), leverage: Number(p.leverage) || 1 }));
  const { decisions, paused } = decideEntries(candidates, {
    fearGreed, openSymbols: openSymbolsNow, openPositions, balance, equity, state, nowMs: Date.now()
  });

  if (paused) log('entries_paused', { reason: paused });
  for (const d of decisions) {
    if (d.action === 'SKIP') log('decision_skip', { symbol: d.symbol, reason: d.reason });
    else await executeOpen(d, state, nowIso);
  }

  saveState(state);
  log('cycle_end', {});
}

async function main() {
  log('bot_starting', { dryRun: config.dryRun, cycleMinutes: config.cycleMinutes });
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await runCycle();
    } catch (e) {
      log('error_cycle', { error: e.message, stack: e.stack });
    }
    await new Promise((r) => setTimeout(r, config.cycleMinutes * 60000));
  }
}

main();
