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
import { loadState, saveState, recordEquity, recordTrade, logEquity, recordRiskAlert, tradeSummary } from './state.mjs';
import {
  getAccount, getOpenAlgoOrders, setLeverage, getMarkPrice,
  placeMarketOrder, placeProtectiveOrder, cancelAllOpenOrders,
  roundQuantity, roundPrice, getExchangeInfo, getPositionRiskMap,
  getIncomeSince, getUserTradesSince
} from './binance.mjs';
import { fetchSignals, fetchScalp, buildCandidates, getFearGreed } from './signals.mjs';
import { decideEntries } from './strategy.mjs';
import {
  stopLossPrice, stopLossPriceForResearch, takeProfitPrice, timeExitAfterMs
} from './risk.mjs';
import { positionOrigin, assessRisk, emergencyStopPrice } from './positions.mjs';
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

async function ensureProtection(position, state, risk) {
  const symbol = position.symbol;
  const existing = await getOpenAlgoOrders(symbol);
  const hasStop = existing.some((o) => o.orderType === 'STOP_MARKET' || o.type === 'STOP_MARKET');
  const hasTp = existing.some((o) => o.orderType === 'TAKE_PROFIT_MARKET' || o.type === 'TAKE_PROFIT_MARKET');
  if (hasStop && hasTp) return;

  const side = Number(position.positionAmt) > 0 ? 'BUY' : 'SELL';
  const closingSide = side === 'BUY' ? 'SELL' : 'BUY';
  const r = (risk && risk[symbol]) || {};
  // entryPrice/leverage come from positionRisk, not from the account payload —
  // the account's position entries do not contain them (see getPositionRiskMap).
  let entryPrice = Number.isFinite(r.entryPrice) && r.entryPrice > 0 ? r.entryPrice : NaN;
  let anchor = 'entry';
  if (!Number.isFinite(entryPrice)) {
    // A stop anchored to the mark is not equivalent to one anchored to entry,
    // but an unprotected leveraged position is strictly worse than a slightly
    // mis-anchored stop. Take the mark and say so.
    entryPrice = Number.isFinite(r.markPrice) && r.markPrice > 0 ? r.markPrice : NaN;
    anchor = 'mark';
  }
  const leverage = Number.isFinite(r.leverage) && r.leverage > 0 ? r.leverage : config.minLeverage;
  const recorded = state.openOrders[symbol];

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
      const order = await placeProtectiveOrder(symbol, closingSide, 'STOP_MARKET', price);
      log('placed_stop_loss', { symbol, triggerPrice: price, algoId: order.algoId });
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
      const order = await placeProtectiveOrder(symbol, closingSide, 'TAKE_PROFIT_MARKET', price);
      log('placed_take_profit', { symbol, triggerPrice: price, algoId: order.algoId });
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

    const amount = Number(position.positionAmt);
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
      await placeMarketOrder(symbol, closingSide, quantity);
      // The stop and target are now orphaned — leaving them live would arm a
      // protective order against a position that no longer exists.
      await cancelAllOpenOrders(symbol);
      log('closed_on_time_exit', { symbol, side: closingSide, quantity });
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

    const { stop, target, timeExit } = exitGeometry(candidate, decision, markPrice);
    log('decision_open', {
      symbol, side, source: candidate.source, positionPct, leverage, extremeBoost,
      marginToUse, quantity, markPrice, edge: decision.edge,
      stop, target, timeExitAfterMs: timeExit,
      targetBasis: candidate.holding ? 'measured favorable excursion' : 'predicted range edge'
    });

    if (config.dryRun) {
      log('dry_run_would_open', { symbol, side, quantity, leverage });
    } else {
      await setLeverage(symbol, leverage);
      const order = await placeMarketOrder(symbol, side, quantity);
      log('opened_position', { symbol, side, quantity, orderId: order.orderId });
    }

    state.openOrders[symbol] = {
      side, entryPrice: markPrice, marginUsed: marginToUse, leverage,
      range: candidate.range, targetPrice: target, stopPrice: stop,
      timeExitAfterMs: timeExit, source: candidate.source, openedAt: nowIso,
      // Frozen at open: judging an outcome against evidence gathered later
      // would be hindsight, not measurement.
      edge: decision.edge ?? null, horizonHours: candidate.horizonHours ?? null,
      holdingMfePct: candidate.holding?.mfePct ?? null,
      holdingMaePct: candidate.holding?.maePct ?? null,
      holdingHoursToPeak: candidate.holding?.hoursToPeak ?? null,
      extremeBoost: !!extremeBoost, equityAtOpen: balance
    };
    if (config.shadowLedger) {
      await recordEntry({
        mode: config.dryRun ? 'dry' : 'live', candidate, decision,
        entryPrice: markPrice, stopPrice: stop, targetPrice: target, openedAt: nowIso
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
      const existing = await getOpenAlgoOrders(symbol).catch(() => []);
      const hasStop = existing.some((o) => o.orderType === 'STOP_MARKET' || o.type === 'STOP_MARKET');
      if (hasStop) {
        actionTaken = 'position already has a stop; left alone';
      } else if (!Number.isFinite(price) || !(price > 0)) {
        actionTaken = 'computed stop price unusable; NOT placed';
      } else if (config.dryRun) {
        actionTaken = `dry run — would place emergency stop at ${price}`;
      } else {
        await placeProtectiveOrder(symbol, closingSide, 'STOP_MARKET', price)
          .then(() => { actionTaken = `emergency stop placed at ${price}`; })
          .catch((e) => { actionTaken = `emergency stop FAILED: ${e.message}`; });
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

  const account = await getAccount();
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
    if (positionOrigin(p.symbol, state) === 'bot') { ownPositions.push(p); continue; }
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
  try {
    await runCycle();
  } catch (e) {
    log('error_cycle', { error: e.message, stack: e.stack });
    process.exitCode = 1;
  }
}

main();
