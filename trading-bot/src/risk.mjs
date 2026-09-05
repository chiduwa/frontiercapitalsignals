// Pure risk-management functions — position sizing, leverage scaling,
// exposure caps, circuit breaker, cooldown, and the exit geometry. Kept
// separate from strategy.mjs (which decides WHETHER to trade something) and
// index.mjs (which does the actual I/O) so the risk math itself is easy to
// read and reason about in one place.
import { config } from './config.mjs';
import { ENGINE } from './contract.mjs';

// What sizing scales on. NOT a raw win rate: the engine's own audit is
// explicit that a flat hit-rate threshold means wildly different things in
// different classes, because their no-skill baselines differ (a crypto 24h
// call guesses right ~38% of the time with no information; a stock 168h call
// ~52%). `conservative_edge` is already a one-sided Wilson lower bound on
// accuracy MINUS that measured baseline, so it is the one number that means
// the same thing everywhere: at 95% confidence, this much better than
// guessing.
export function conservativeEdge(candidate) {
  return Number.isFinite(candidate?.edge) ? candidate.edge : 0;
}

// Linear scale from [engine's actionable bar, edgeFullSize] -> [min, max].
// Anything at or below the engine's own bar gets the minimum size, not zero,
// because the gate in strategy.mjs has already refused everything below it.
function scaleByEdge(edge, min, max) {
  const floor = ENGINE.minActionableEdge;
  const ceiling = Math.max(floor + 1e-9, config.edgeFullSize);
  const t = Math.max(0, Math.min(1, (edge - floor) / (ceiling - floor)));
  return min + t * (max - min);
}

// extremeBoost: true when the fear-greed-extreme + reversal condition fires
// for this candidate (see strategy.mjs) — "goes harder... a bit of a higher
// leverage" per the original spec, applied as a multiplier and then
// re-clamped to the hard ceiling, never past it.
export function sizePosition(candidate, extremeBoost) {
  // A confirmed research strategy is validated by an event study, not by a
  // calibrated per-asset forecast record. That is real evidence, but it is a
  // different and weaker kind for sizing purposes: it says the RULE has
  // positive after-cost expectancy, not that this specific asset's direction
  // at this moment is well calibrated. So it always takes the floor size and
  // the floor leverage, regardless of how good its backtest looks.
  if (candidate.source === 'research-confirmed') {
    return { positionPct: config.minPositionPct, leverage: config.minLeverage };
  }
  const edge = conservativeEdge(candidate);
  let positionPct = scaleByEdge(edge, config.minPositionPct, config.maxPositionPct);
  let leverage = scaleByEdge(edge, config.minLeverage, config.maxLeverage);
  if (extremeBoost) {
    positionPct *= config.extremeAggressionBoost;
    leverage *= config.extremeAggressionBoost;
  }
  return {
    positionPct: Math.min(positionPct, config.maxPositionPct),
    leverage: Math.min(Math.max(Math.round(leverage), config.minLeverage), config.maxLeverage)
  };
}

// Total margin already committed across every open position, as a fraction
// of current balance — the number maxTotalExposurePct caps.
export function currentExposurePct(openPositions, balance) {
  if (!balance) return 1; // fail safe: unknown balance reads as fully exposed, never as room to trade
  const committed = openPositions.reduce((sum, p) => sum + Math.abs(p.notional) / p.leverage, 0);
  return committed / balance;
}

export function wouldExceedExposure(openPositions, balance, newPositionPct) {
  return currentExposurePct(openPositions, balance) + newPositionPct > config.maxTotalExposurePct;
}

// Research-sourced positions get their own, much lower ceiling on top of the
// global one. Their evidence is thinner in kind, so a run of confirmed
// strategies must not be able to consume the whole exposure budget.
export function wouldExceedResearchExposure(openPositions, balance, newPositionPct) {
  const research = openPositions.filter((p) => p.source === 'research-confirmed');
  return currentExposurePct(research, balance) + newPositionPct > config.maxResearchExposurePct;
}

// Equity drawdown from the peak this bot has observed (state.peakEquity).
// Existing positions are still managed (stops/take-profits stay live on the
// exchange regardless) — this only gates NEW entries.
export function circuitBreakerTripped(state, currentEquity) {
  if (!state.peakEquity) return false;
  const drawdown = (state.peakEquity - currentEquity) / state.peakEquity;
  return drawdown >= config.circuitBreakerDrawdownPct;
}

export function dailyLossLimitHit(state, currentEquity) {
  if (!state.dayStartEquity) return false;
  const loss = (state.dayStartEquity - currentEquity) / state.dayStartEquity;
  return loss >= config.dailyLossLimitPct;
}

export function inCooldown(state, symbol, nowMs) {
  const lastClosed = state.lastClosedAt[symbol];
  if (!lastClosed) return false;
  return (nowMs - new Date(lastClosed).getTime()) < config.cooldownMinutes * 60000;
}

// Funding paid/received every 8h works AGAINST a position whose direction
// matches the funding sign (positive funding: longs pay shorts). Skip entries
// where funding is already extreme against the intended side — no point
// paying away edge before the trade even has a chance to work.
export function fundingUnfavorable(side, fundingRate) {
  if (side === 'BUY') return fundingRate >= config.maxFundingRateAbs;
  return fundingRate <= -config.maxFundingRateAbs;
}

// ---------------------------------------------------------------------------
// Exit geometry, driven by measured path shape where it exists.
//
// The engine records, for every matured non-overlapping forecast, the best
// and worst price reached inside the declared window and when each first
// occurred (holdingEvidence). That turns three previously-assumed numbers
// into measured ones: where to take profit, when to stop waiting, and whether
// the signal price was even a good entry.
// ---------------------------------------------------------------------------

// Stop-loss trigger price: the price move (leveraged) that would burn
// stopLossMarginFraction of the margin committed to this specific trade —
// bounds max loss per trade to a consistent fraction of what was risked,
// regardless of which leverage this particular trade ended up using.
export function stopLossPrice(entryPrice, side, leverage) {
  const moveFraction = config.stopLossMarginFraction / leverage;
  return side === 'BUY' ? entryPrice * (1 - moveFraction) : entryPrice * (1 + moveFraction);
}

// For a research-sourced trade, the confirmed sample carries the worst single
// trade it actually suffered. Sizing the stop off that measured figure beats a
// generic margin fraction: it is the drawdown this rule is KNOWN to produce,
// so a stop inside it would be cutting trades the strategy's own expectancy
// depends on. Widened by a margin, then still bounded by the generic stop so
// a pathological research row cannot risk more than the normal per-trade cap.
export function stopLossPriceForResearch(entryPrice, side, leverage, worstTradePct) {
  const generic = stopLossPrice(entryPrice, side, leverage);
  if (!Number.isFinite(worstTradePct) || worstTradePct === 0) return generic;
  const moveFraction = Math.abs(worstTradePct) / 100 * config.researchStopWidening;
  const measured = side === 'BUY' ? entryPrice * (1 - moveFraction) : entryPrice * (1 + moveFraction);
  // Whichever is TIGHTER in loss terms — never risk more than the generic cap.
  return side === 'BUY' ? Math.max(generic, measured) : Math.min(generic, measured);
}

// Take-profit target.
//
// Without evidence this stays what it was: the opposite end of the same
// predicted range the entry was gated on.
//
// With evidence, the measured mean favorable excursion says how far this
// asset/side/horizon actually ran before turning. It is deliberately NOT used
// at face value: excursion distributions are right-skewed, so their mean sits
// above their median and a target at the full mean would be reached less than
// half the time. `takeProfitMfeFraction` takes a fraction of it.
//
// The two candidates are then reconciled by taking the NEARER one. The range
// edge is a calibrated 68% band, not a place price is known to reach; the MFE
// figure is a measured excursion. Banking the closer of the two is what
// "sell as high as possible" actually means once give-back is measured —
// holding for the further target is precisely the behaviour the give-back
// number exists to expose.
export function takeProfitPrice(side, entryPrice, range, holding) {
  const rangeTarget = range ? (side === 'BUY' ? range.high : range.low) : null;
  const measuredTarget = holding && Number.isFinite(holding.mfePct)
    ? entryPrice * (1 + (side === 'BUY' ? 1 : -1) * (holding.mfePct / 100) * config.takeProfitMfeFraction)
    : null;
  if (rangeTarget == null) return measuredTarget;
  if (measuredTarget == null) return rangeTarget;
  // A measured target on the wrong side of entry (a side whose mean favorable
  // excursion is ~0) is not a target at all — fall back rather than placing a
  // take-profit that would fill instantly.
  const improves = side === 'BUY' ? measuredTarget > entryPrice : measuredTarget < entryPrice;
  if (!improves) return rangeTarget;
  return side === 'BUY' ? Math.min(rangeTarget, measuredTarget) : Math.max(rangeTarget, measuredTarget);
}

// When to stop waiting. The measured time-to-peak says how long after the
// call the best price historically arrived; past that, the evidence says the
// favorable excursion for this asset/side/horizon is usually already behind
// us and the position is giving back. Never extends past the declared
// horizon — holding beyond the window the forecast was calibrated on is
// holding on no evidence at all.
export function timeExitAfterMs(holding, horizonHours, extremeBoost) {
  const horizonMs = Number.isFinite(horizonHours) ? horizonHours * 3600000 : null;
  if (!holding || !Number.isFinite(holding.hoursToPeak) || holding.hoursToPeak <= 0) return horizonMs;
  const multiple = config.timeExitPeakMultiple * (extremeBoost ? config.extremeHoldMultiplier : 1);
  const measuredMs = holding.hoursToPeak * 3600000 * multiple;
  return horizonMs == null ? measuredMs : Math.min(horizonMs, measuredMs);
}

export function timeExitDue(openedAtIso, holding, horizonHours, extremeBoost, nowMs) {
  const after = timeExitAfterMs(holding, horizonHours, extremeBoost);
  if (after == null) return false;
  const openedMs = Date.parse(openedAtIso);
  if (!Number.isFinite(openedMs)) return false;
  return nowMs - openedMs >= after;
}

// Entry patience, measured instead of assumed.
//
// `adverseFirstLower` is the one-sided lower bound on how often the WORST
// price of the window arrived before the best one. When that bound clears
// 50%, the evidence says: more often than not, this setup goes against you
// first — so filling at the signal price is measurably worse than waiting for
// that heat to arrive. Rather than placing a resting limit order (which would
// need an order lifecycle this one-shot process cannot supervise), the bot
// simply waits: it runs again in five minutes, and enters when price has
// actually come to it.
//
// Returns a reason string when patience is unmet, or null when clear.
export function patienceUnmet(candidate) {
  const holding = candidate.holding;
  if (!holding || !Number.isFinite(holding.adverseFirstLower)) return null;
  if (holding.adverseFirstLower < config.patienceAdverseFirstBound) return null;
  const pos = candidate.dayRangePos;
  if (!Number.isFinite(pos)) {
    return `evidence says the adverse extreme usually lands first (>=${(holding.adverseFirstLower * 100).toFixed(0)}% at 95% confidence) and no day-range position is available to confirm the heat has arrived`;
  }
  const arrived = candidate.side === 'BUY'
    ? pos <= config.entryLowRangePos
    : pos >= config.entryHighRangePos;
  if (arrived) return null;
  return `waiting for the measured drawdown: this setup's worst price lands before its best in >=${(holding.adverseFirstLower * 100).toFixed(0)}% of matured cases (mean ${holding.maePct.toFixed(1)}%), and price is at ${(pos * 100).toFixed(0)}% of the day's range`;
}
