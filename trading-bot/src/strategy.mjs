// Pure decision layer: given this cycle's candidates + account/state
// snapshot, decide what to do. No I/O here — index.mjs executes whatever
// this returns. Keeping this pure makes the actual trading logic
// something that can be read and reasoned about (and unit tested) without
// needing a live Binance connection.
import { config } from './config.mjs';
import {
  combinedConfidence, sizePosition, wouldExceedExposure,
  circuitBreakerTripped, dailyLossLimitHit, inCooldown, fundingUnfavorable
} from './risk.mjs';

// Evaluates ONE candidate against every gate, in the order a human reading
// the decision log would want to see them fail: cheapest/most-obviously-
// disqualifying checks first. Returns {action: 'SKIP', reason} or
// {action: 'OPEN', side, positionPct, leverage, extremeBoost}.
export function evaluateCandidate(candidate, ctx) {
  const { symbol, side, rangePos, funding, reversalFlag } = candidate;
  const { fearGreed, openSymbols, openPositions, balance, state, nowMs } = ctx;

  if (openSymbols.has(symbol)) return { action: 'SKIP', reason: 'already holding a position in this symbol' };
  if (inCooldown(state, symbol, nowMs)) return { action: 'SKIP', reason: `cooldown active (closed within the last ${config.cooldownMinutes}m)` };

  const confidence = combinedConfidence(candidate);
  if (confidence < config.minConfidenceRatio) return { action: 'SKIP', reason: `confidence ${confidence.toFixed(2)} below floor ${config.minConfidenceRatio}` };

  // Fear & Greed extreme + reversal: user's own conditioning rule. When
  // it fires, it substitutes for the normal range-position gate entirely
  // (an extreme-sentiment reversal IS the strong signal) rather than
  // stacking on top of it — the range gate exists to enforce patience on
  // an otherwise-ordinary setup, not to filter out the specific scenario
  // the user explicitly asked the bot to lean into harder.
  const extremeBoost =
    (side === 'BUY' && fearGreed != null && fearGreed <= config.fearGreedExtremeLow && reversalFlag) ||
    (side === 'SELL' && fearGreed != null && fearGreed >= config.fearGreedExtremeHigh && reversalFlag);

  if (!extremeBoost) {
    const inZone = side === 'BUY' ? rangePos <= config.entryLowRangePos : rangePos >= config.entryHighRangePos;
    if (!inZone) return { action: 'SKIP', reason: `rangePos ${rangePos.toFixed(2)} not in the ${side === 'BUY' ? 'low' : 'high'} entry zone — patience, wait for a better price` };
  }

  if (fundingUnfavorable(side, funding)) return { action: 'SKIP', reason: `funding ${funding} unfavorable for ${side}` };

  const { positionPct, leverage } = sizePosition(candidate, extremeBoost);
  if (wouldExceedExposure(openPositions, balance, positionPct)) return { action: 'SKIP', reason: 'would exceed max total exposure' };

  return { action: 'OPEN', symbol, side, positionPct, leverage, extremeBoost, confidence };
}

// Ranks and filters a full candidate list down to what this cycle should
// actually act on. Circuit breaker / daily loss limit gate ALL new
// entries at once (existing positions are managed separately in
// index.mjs regardless of this function's output).
export function decideEntries(candidates, ctx) {
  if (circuitBreakerTripped(ctx.state, ctx.equity)) {
    return { decisions: candidates.map((c) => ({ action: 'SKIP', symbol: c.symbol, reason: `circuit breaker: drawdown >= ${config.circuitBreakerDrawdownPct * 100}% from peak` })), paused: 'circuit_breaker' };
  }
  if (dailyLossLimitHit(ctx.state, ctx.equity)) {
    return { decisions: candidates.map((c) => ({ action: 'SKIP', symbol: c.symbol, reason: `daily loss limit hit (${config.dailyLossLimitPct * 100}%)` })), paused: 'daily_loss_limit' };
  }

  // Best candidates first (highest combined confidence) so that if
  // exposure room is limited, it goes to the strongest setups, not
  // whichever happened to be listed first.
  const sorted = [...candidates].sort((a, b) => combinedConfidence(b) - combinedConfidence(a));
  const decisions = [];
  const openPositions = [...ctx.openPositions]; // local mutable copy — each OPEN this loop reduces remaining exposure room for the next candidate
  for (const candidate of sorted) {
    const decision = evaluateCandidate(candidate, { ...ctx, openPositions });
    decisions.push({ ...decision, symbol: candidate.symbol, candidate });
    if (decision.action === 'OPEN') {
      openPositions.push({ notional: ctx.balance * decision.positionPct * decision.leverage, leverage: decision.leverage });
    }
  }
  return { decisions, paused: null };
}
