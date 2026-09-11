// Pure risk-management functions — position sizing, leverage scaling,
// exposure caps, circuit breaker, cooldown, and the exit geometry. Kept
// separate from strategy.mjs (which decides WHETHER to trade something) and
// index.mjs (which does the actual I/O) so the risk math itself is easy to
// read and reason about in one place.
import { config } from './config.mjs';
import { ENGINE } from './contract.mjs';
import { ACTIVE_LIMIT_SOURCE } from './active-limit.mjs';
import { leveragePlan } from './trade-policy.mjs';

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
  // Installation must not silently activate the new live risk policy.
  // Keep the existing sizing behavior until either new mode is selected.
  if (!config.roiExitPolicy && !config.activeLimitMode && candidate.source !== ACTIVE_LIMIT_SOURCE) {
    if (candidate.source === 'research-confirmed') return {
      positionPct: config.minPositionPct, leverage: config.legacyMinLeverage
    };
    const edge = conservativeEdge(candidate);
    const boost = extremeBoost ? config.extremeAggressionBoost : 1;
    return {
      positionPct: Math.min(config.maxPositionPct, scaleByEdge(edge, config.minPositionPct, config.maxPositionPct) * boost),
      leverage: Math.min(config.maxLeverage, Math.max(config.legacyMinLeverage,
        Math.round(scaleByEdge(edge, config.legacyMinLeverage, config.maxLeverage)
          * Math.max(1, config.legacyLeverageMultiplier) * boost)))
    };
  }
  const plan = leveragePlan(candidate, { min: config.minLeverage, max: config.maxLeverage,
    edgeFloor: ENGINE.minActionableEdge, fullEdge: config.edgeFullSize });
  if (candidate.source === ACTIVE_LIMIT_SOURCE) {
    return {
      positionPct: config.minPositionPct,
      leverage: plan.leverage
    };
  }
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
  if (extremeBoost) {
    positionPct *= config.extremeAggressionBoost;
  }
  return {
    positionPct: Math.min(positionPct, config.maxPositionPct),
    leverage: plan.leverage
  };
}

// ---------------------------------------------------------------------------
// Entry geometry: an evidence-labelled margin of error, not a guessed bottom.
// ---------------------------------------------------------------------------

const positiveFinite = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

export function entryOffsetPlan(candidate) {
  const signalPrice = positiveFinite(candidate?.signalPrice);
  if (signalPrice == null) {
    return { ok: false, reason: 'no positive published signal price from which to calculate a limit entry' };
  }

  const active = candidate?.source === ACTIVE_LIMIT_SOURCE;
  const minPct = positiveFinite(active
    ? Math.max(config.entryOffsetMinPct, config.activeLimitOffsetFloorPct)
    : config.entryOffsetMinPct);
  const maxPct = positiveFinite(config.entryOffsetMaxPct);
  const confidenceFloor = positiveFinite(config.entryOffsetHighConfidenceFloorPct);
  const maxReduction = Number(config.entryOffsetMaxConfidenceReductionPct);
  if (minPct == null || maxPct == null || confidenceFloor == null
      || maxPct < minPct || confidenceFloor >= minPct
      || !Number.isFinite(maxReduction) || maxReduction < 0) {
    return { ok: false, reason: 'entry-offset configuration is invalid' };
  }

  // Exact-asset historical daily movement is admitted only with a real sample
  // count. chg24h is labelled separately: it is a current realized move, not
  // a volatility estimator. Both are observable at decision time.
  const dailyMoveSamples = Number(candidate?.dailyMoveSamples);
  const medianDailyMovePct = dailyMoveSamples >= config.entryOffsetDailyMoveMinSamples
    ? positiveFinite(candidate?.medianAbsDailyMovePct) : null;
  const absolute24hMovePct = candidate?.currentMovePct != null
      && Number.isFinite(Number(candidate.currentMovePct))
    ? Math.abs(Number(candidate.currentMovePct)) : null;

  const holding = candidate?.holding;
  const wrongN = Number(holding?.wrongN);
  const wrongMae = Number(holding?.wrongMaePct);
  const allMae = Number(holding?.maePct);
  const wrongCallAdversePct = wrongN >= config.entryOffsetWrongCallMinSamples
      && Number.isFinite(wrongMae) && wrongMae < 0
    ? -wrongMae : null;
  const allCallAdversePct = Number(holding?.n) >= 30
      && Number.isFinite(allMae) && allMae < 0
    ? -allMae : null;
  const adversePct = wrongCallAdversePct ?? allCallAdversePct;
  const adverseBasis = wrongCallAdversePct != null
    ? 'wrong-call mean adverse excursion'
    : allCallAdversePct != null ? 'all-call mean adverse excursion' : null;

  const empirical = [
    [active ? 'uncalibrated active-limit policy floor' : 'operator policy floor', minPct],
    ['historical median absolute daily move', medianDailyMovePct],
    ['current absolute 24h move', absolute24hMovePct],
    [adverseBasis, adversePct]
  ].filter(([, value]) => Number.isFinite(value));
  const strongest = empirical.sort((a, b) => b[1] - a[1])[0];
  const beforeConfidence = Math.min(maxPct, Math.max(minPct, strongest[1]));

  // Only the engine's already-conservative edge may tighten the offset. The
  // reduction is bounded and cannot reach the signal price even at full size.
  const edge = active ? 0 : conservativeEdge(candidate);
  const edgeSpan = Math.max(1e-9, config.edgeFullSize - ENGINE.minActionableEdge);
  const confidenceProgress = Math.max(0, Math.min(1,
    (edge - ENGINE.minActionableEdge) / edgeSpan));
  const confidenceReductionPct = Math.min(maxReduction,
    Math.max(0, maxReduction * confidenceProgress));
  const offsetPct = Math.min(maxPct,
    Math.max(confidenceFloor, beforeConfidence - confidenceReductionPct));

  return {
    ok: true,
    signalPrice,
    offsetPct,
    beforeConfidencePct: beforeConfidence,
    confidenceReductionPct,
    confidenceProgress,
    basis: strongest[0],
    medianDailyMovePct,
    dailyMoveSamples: Number.isFinite(dailyMoveSamples) ? dailyMoveSamples : null,
    absolute24hMovePct,
    adversePct,
    adverseBasis,
    wrongCallSamples: Number.isFinite(wrongN) ? wrongN : null
  };
}

export function entryLimitPrice(signalPrice, side, offsetPct) {
  const reference = positiveFinite(signalPrice);
  const offset = Number(offsetPct);
  if (reference == null || !Number.isFinite(offset) || !(offset > 0 && offset < 100)) return null;
  if (side === 'BUY') return reference * (1 - offset / 100);
  if (side === 'SELL') return reference * (1 + offset / 100);
  return null;
}

export function entryOrderTtlMs(candidate) {
  if (candidate?.source === ACTIVE_LIMIT_SOURCE) {
    const hours = positiveFinite(candidate?.activePolicy?.holdHours);
    return hours == null ? null : Math.min(hours, config.entryOrderMaxHours, 24) * 3_600_000;
  }
  const minMinutes = positiveFinite(config.entryOrderMinMinutes);
  const maxHours = positiveFinite(config.entryOrderMaxHours);
  if (minMinutes == null || maxHours == null) return null;
  const minMs = minMinutes * 60_000;
  const maxMs = maxHours * 3_600_000;
  if (!(minMs > 10 * 60_000) || !(maxMs >= minMs)) return null;
  const measuredHours = positiveFinite(candidate?.holding?.hoursToPeak);
  const horizonHours = positiveFinite(candidate?.horizonHours);
  const evidenceClockMs = (measuredHours ?? horizonHours ?? config.entryOrderMaxHours) * 3_600_000;
  return Math.min(maxMs, Math.max(minMs, evidenceClockMs));
}

// Freeze GTD against the immutable signal observation, not the bot cycle's
// wall clock. Re-running the same signal must address the same bounded order
// intent instead of extending its life by another day on every retry.
export function entryOrderExpiryMs(candidate) {
  const ttlMs = entryOrderTtlMs(candidate);
  const observedAt = Date.parse(candidate?.signalPriceAt || candidate?.signalGeneratedAt || '');
  if (!(ttlMs > 0) || !Number.isFinite(observedAt)) return null;
  return Math.floor((observedAt + ttlMs) / 1000) * 1000;
}

export function signalReferenceIssue(candidate, nowMs, markPrice = null) {
  const signalPrice = positiveFinite(candidate?.signalPrice);
  if (signalPrice == null) return 'no positive published signal price';
  const observedAt = Date.parse(candidate?.signalPriceAt || candidate?.signalGeneratedAt || '');
  if (!Number.isFinite(observedAt)) return 'published signal price has no parseable observation time';
  const ageMs = Number(nowMs) - observedAt;
  if (!Number.isFinite(ageMs) || ageMs < -60_000) return 'published signal price timestamp is in the future';
  if (ageMs > config.maxSignalAgeMinutes * 60_000) {
    return `published signal price is ${(ageMs / 60_000).toFixed(1)} minutes old (maximum ${config.maxSignalAgeMinutes})`;
  }
  if (markPrice != null) {
    const mark = positiveFinite(markPrice);
    if (mark == null) return 'Binance mark price is unavailable';
    const deviationPct = Math.abs(mark / signalPrice - 1) * 100;
    if (deviationPct > config.maxSignalMarkDeviationPct) {
      return `Binance mark differs from the published reference by ${deviationPct.toFixed(2)}% (maximum ${config.maxSignalMarkDeviationPct}%)`;
    }
  }
  return null;
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
