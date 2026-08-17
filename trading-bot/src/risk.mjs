// Pure risk-management functions — position sizing, leverage scaling,
// exposure caps, circuit breaker, cooldown. Kept separate from strategy.mjs
// (which decides WHETHER to trade something) and index.mjs (which does
// the actual I/O) so the risk math itself is easy to read and reason
// about in one place.
import { config } from './config.mjs';

// Confidence blends technique agreement ratio and the asset's own best-
// performing technique's live accuracy — the min of the two, not the
// average, so a candidate can't look confident just because ONE of the
// two measures happens to be high while the other is mediocre.
export function combinedConfidence(candidate) {
  return Math.min(candidate.confidenceRatio, candidate.topIndicatorAccuracy);
}

// Linear scale from [minConfidenceRatio, 1.0] -> [min, max]. Candidates
// that didn't clear minConfidenceRatio never reach this function (see
// strategy.mjs's gate), so confidence here is always in-range.
function scaleByConfidence(confidence, min, max) {
  const floor = config.minConfidenceRatio;
  const t = Math.max(0, Math.min(1, (confidence - floor) / (1 - floor)));
  return min + t * (max - min);
}

// extremeBoost: true when the fear-greed-extreme + reversal condition
// fires for this candidate (see strategy.mjs) — "goes harder... a bit of
// a higher leverage" per the user's own instruction, applied as a
// multiplier and then re-clamped to the hard ceiling, never past it.
export function sizePosition(candidate, extremeBoost) {
  const confidence = combinedConfidence(candidate);
  let positionPct = scaleByConfidence(confidence, config.minPositionPct, config.maxPositionPct);
  let leverage = scaleByConfidence(confidence, config.minLeverage, config.maxLeverage);
  if (extremeBoost) {
    positionPct *= config.extremeAggressionBoost;
    leverage *= config.extremeAggressionBoost;
  }
  return {
    positionPct: Math.min(positionPct, config.maxPositionPct),
    leverage: Math.min(Math.max(Math.round(leverage), config.minLeverage), config.maxLeverage)
  };
}

// Total margin already committed across every open position, as a
// fraction of current balance — the number maxTotalExposurePct caps.
export function currentExposurePct(openPositions, balance) {
  if (!balance) return 1; // fail safe: unknown balance reads as fully exposed, never as room to trade
  const committed = openPositions.reduce((sum, p) => sum + Math.abs(p.notional) / p.leverage, 0);
  return committed / balance;
}

export function wouldExceedExposure(openPositions, balance, newPositionPct) {
  return currentExposurePct(openPositions, balance) + newPositionPct > config.maxTotalExposurePct;
}

// Equity drawdown from the peak this bot has observed (state.peakEquity).
// Existing positions are still managed (stops/take-profits stay live on
// the exchange regardless) — this only gates NEW entries.
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
// matches the funding sign (positive funding: longs pay shorts). Skip
// entries where funding is already extreme against the intended side —
// no point paying away edge before the trade even has a chance to work.
export function fundingUnfavorable(side, fundingRate) {
  if (side === 'BUY') return fundingRate >= config.maxFundingRateAbs;
  return fundingRate <= -config.maxFundingRateAbs;
}

// Stop-loss trigger price: the price move (leveraged) that would burn
// stopLossMarginFraction of the margin committed to this specific trade —
// bounds max loss per trade to a consistent fraction of what was risked,
// regardless of which leverage this particular trade ended up using.
export function stopLossPrice(entryPrice, side, leverage) {
  const moveFraction = config.stopLossMarginFraction / leverage;
  return side === 'BUY' ? entryPrice * (1 - moveFraction) : entryPrice * (1 + moveFraction);
}

// Take-profit target: the OPPOSITE end of the predicted range from where
// this trade entered — ties the exit directly to the same range
// prediction the entry was gated on (user: buy near the low end, sell
// near the high end; the natural target for a long entered near the low
// end is the range's own high end, and vice versa).
export function takeProfitPrice(side, range) {
  return side === 'BUY' ? range.high : range.low;
}
