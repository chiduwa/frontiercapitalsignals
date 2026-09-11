// Pure decision layer: given this cycle's candidates + account/state
// snapshot, decide what to do. No I/O here — index.mjs executes whatever
// this returns. Keeping this pure makes the actual trading logic something
// that can be read and reasoned about (and unit tested) without needing a
// live Binance connection.
import { config } from './config.mjs';
import { activeExecutionEligible } from './active-limit.mjs';
import {
  conservativeEdge, sizePosition, wouldExceedExposure, wouldExceedResearchExposure,
  circuitBreakerTripped, dailyLossLimitHit, inCooldown, fundingUnfavorable,
  signalReferenceIssue
} from './risk.mjs';

// Evaluates ONE candidate against every gate, in the order a human reading
// the decision log would want to see them fail: cheapest/most-obviously-
// disqualifying checks first.
//
// Three outcomes, not two:
//   SKIP   — a genuine gate failed; the bot would not want this trade.
//   SHADOW — every gate the BOT owns passed, but the engine has not
//            authorized a call on this row. Recorded, never executed.
//   OPEN   — authorized and clear.
//
// The SHADOW state exists because of the v7 cold start: the engine
// deliberately withholds every direction until independent evidence
// rebuilds, so a correctly-gated bot places nothing for days or weeks.
// Rather than idle through that, it records what it would have done and
// resolves those against real subsequent prices, so by the time the engine
// opens up the bot has its own track record instead of a blank one.
export function evaluateCandidate(candidate, ctx) {
  const { symbol, side, funding } = candidate;
  const { fearGreed, openSymbols, openPositions, balance, state, nowMs } = ctx;

  if (!['BUY', 'SELL'].includes(side)) return { action: 'SKIP', reason: 'no explicit setup direction' };
  if (candidate.source === 'conflict') return { action: 'SKIP', reason: 'conflicting setup directions' };

  if (openSymbols.has(symbol)) return { action: 'SKIP', reason: 'already holding a position in this symbol' };
  if (inCooldown(state, symbol, nowMs)) return { action: 'SKIP', reason: `cooldown active (closed within the last ${config.cooldownMinutes}m)` };

  // Fear & Greed extreme + reversal. When it fires it SUBSTITUTES for the
  // normal range-position gate (an extreme-sentiment reversal is itself the
  // strong signal) rather than stacking on top of it.
  //
  // "Reversal" used to mean the intraday model's bottomed/peaked flags. That
  // pipeline was retired for showing no usable edge, and its endpoint now
  // returns a deprecation stub — so this condition had been silently dead.
  // It is now proximity to a real session extreme, taken from the
  // measurement-only scalp surface, which is the same underlying idea the
  // original spec described and is a number the engine still stands behind.
  const atExtreme = Number.isFinite(candidate.dayRangePos) && (
    side === 'BUY' ? candidate.dayRangePos <= config.reversalDayRangeLow
      : candidate.dayRangePos >= config.reversalDayRangeHigh
  );
  const extremeBoost = candidate.assetClass === 'crypto' && atExtreme && fearGreed != null && (
    (side === 'BUY' && fearGreed <= config.fearGreedExtremeLow) ||
    (side === 'SELL' && fearGreed >= config.fearGreedExtremeHigh)
  );

  // Price patience now lives in the order itself: an authorized long rests
  // below its fresh signal reference and a short rests above it, with the
  // offset widened by exact-asset movement/adverse-excursion evidence. This
  // allows more authorized setups to place an order without buying the high
  // or shorting the low. Stale/missing references still abstain here.
  const referenceIssue = signalReferenceIssue(candidate, nowMs);
  if (referenceIssue) return { action: 'SKIP', reason: referenceIssue };

  if (funding == null || !Number.isFinite(Number(funding))) {
    return { action: 'SKIP', reason: 'current Binance funding rate unavailable' };
  }
  if (fundingUnfavorable(side, Number(funding))) return { action: 'SKIP', reason: `funding ${funding} unfavorable for ${side}` };

  const { positionPct, leverage } = sizePosition(candidate, extremeBoost);
  if (wouldExceedExposure(openPositions, balance, positionPct)) return { action: 'SKIP', reason: 'would exceed max total exposure' };
  if (candidate.source === 'research-confirmed' && wouldExceedResearchExposure(openPositions, balance, positionPct)) {
    return { action: 'SKIP', reason: `would exceed the ${config.maxResearchExposurePct * 100}% cap on research-sourced exposure` };
  }

  // Last gate, deliberately last: everything above is the bot's own risk
  // discipline and applies whether or not the engine has spoken. Only the
  // engine decides whether there is a call to act on at all.
  if (!candidate.authorized && !activeExecutionEligible(candidate)) {
    return {
      action: 'SHADOW', symbol, side, positionPct, leverage, extremeBoost,
      reason: candidate.unauthorizedReason || 'engine has not authorized a call on this row'
    };
  }

  return {
    action: 'OPEN', symbol, side, positionPct, leverage, extremeBoost,
    edge: candidate.authorized ? conservativeEdge(candidate) : null
  };
}

// Ranks and filters a full candidate list down to what this cycle should
// actually act on. Circuit breaker / daily loss limit gate ALL live entries
// at once. Already-unauthorized candidates may still produce research-only
// SHADOW proposals if every candidate gate passes, so an account drawdown
// does not erase opportunities to collect prospective evidence. Existing
// positions are managed separately in index.mjs regardless of this output.
export function decideEntries(candidates, ctx) {
  let paused = null;
  let pauseReason = null;
  if (config.activeLimitMode) {
    if (ctx.botRisk?.ok !== true) {
      paused = 'bot_risk';
      pauseReason = ctx.botRisk?.reason || 'bot risk accounting unavailable';
    }
  } else if (circuitBreakerTripped(ctx.state, ctx.equity)) {
    paused = 'circuit_breaker';
    pauseReason = `circuit breaker: drawdown >= ${config.circuitBreakerDrawdownPct * 100}% from peak`;
  } else if (dailyLossLimitHit(ctx.state, ctx.equity)) {
    paused = 'daily_loss_limit';
    pauseReason = `daily loss limit hit (${config.dailyLossLimitPct * 100}%)`;
  }

  // Strongest measured edge first, so that when exposure room is limited it
  // goes to the best-evidenced setups. Research candidates carry no
  // comparable edge figure and sort last by construction — a rule with
  // positive after-cost expectancy should not outrank a calibrated,
  // asset-specific directional call for the same margin.
  const sorted = [...candidates].sort((a, b) => conservativeEdge(b) - conservativeEdge(a));
  const decisions = [];
  const openPositions = [...ctx.openPositions]; // local mutable copy — each OPEN this loop reduces remaining exposure room for the next candidate
  for (const candidate of sorted) {
    // Never turn an authorized live trade into an executable decision while
    // either account gate is active. The research path is available only to
    // candidates the engine had already withheld, with no live fallback.
    const decision = paused && (candidate.authorized || activeExecutionEligible(candidate))
      ? { action: 'SKIP', reason: pauseReason }
      : evaluateCandidate(candidate, { ...ctx, openPositions });
    if (paused && decision.action === 'SHADOW') {
      decision.reason = `${decision.reason}; live entries paused: ${pauseReason}`;
    }
    decisions.push({ ...decision, symbol: candidate.symbol, candidate });
    // Only a real OPEN consumes exposure. A shadow entry must never reduce
    // the room available to a genuinely authorized call.
    if (decision.action === 'OPEN') {
      openPositions.push({
        notional: ctx.balance * decision.positionPct * decision.leverage,
        leverage: decision.leverage,
        source: candidate.source
      });
    }
  }
  return { decisions, paused };
}
