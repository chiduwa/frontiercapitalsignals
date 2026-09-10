// Whose position is this, and is it in trouble?
//
// The operator manages their own trades. The bot must not put a stop or a
// take-profit on a position it did not open, and must not time-exit one: an
// unrequested protective order can close somebody else's trade against their
// intent, which is its own kind of loss.
//
// Even an extreme reading is alert-only. A warning can inform the operator,
// but it does not authorize this process to create an order on their trade.
//
// Pure: every threshold here is testable without an exchange.
import { config } from './config.mjs';

// A position belongs to the bot only if the bot's own record says it opened
// it. If that record were ever lost, its positions read as the operator's and
// stop being managed — the safe direction to fail, since it withholds action
// rather than taking one on a trade nobody asked the bot to touch.
export function positionQuantitiesMatch(expected, actual) {
  const a = Number(expected);
  const b = Number(actual);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const tolerance = Math.max(1e-12, Math.abs(a) * 1e-9);
  return Math.abs(a - b) <= tolerance;
}

export function positionOrigin(symbol, state, actualSide = null, actualQuantity = null) {
  const recorded = state?.openOrders?.[symbol];
  if (!recorded) return 'manual';
  // A row written before an exchange-confirmed fill is only an intent, not
  // proof that the current net position came from the bot. The same is true
  // of legacy rows which lack the explicit ownership marker. Failing these
  // to conflict is safer than attaching a close-all stop or time exit to a
  // manual position which happened to reuse the same symbol/side/quantity.
  if (recorded.ownershipVerified !== true
      || !recorded.entryClientOrderId
      || !(Number(recorded.entryExecutedQty) > 0)) return 'conflict';
  // Binance one-way mode nets a symbol into one position. If the live side no
  // longer matches what the bot actually opened, an operator action (or an
  // external order) has changed ownership semantics. Do not manage that net
  // position as though it were still the bot's original trade.
  if (actualSide && recorded.side !== actualSide) return 'conflict';
  // One-way mode nets manual and automated fills together. A same-side manual
  // addition is therefore just as important an ownership conflict as a side
  // flip: closePosition=true would otherwise close the operator's addition as
  // well. New records retain the bot's exact confirmed residual quantity.
  const ownedQuantity = Number(recorded.entryExecutedQty);
  if (actualQuantity != null && Number.isFinite(ownedQuantity)
      && !positionQuantitiesMatch(ownedQuantity, Math.abs(Number(actualQuantity)))) {
    return 'conflict';
  }
  return 'bot';
}

// Distance from the mark to the liquidation price, as a percentage of the
// mark. This is the number that decides whether "a lot of money" is actually
// at stake: at liquidation the entire margin committed to the position is
// gone, not merely the adverse move.
export function distanceToLiquidationPct(markPrice, liquidationPrice, side) {
  if (!(markPrice > 0) || !(liquidationPrice > 0)) return null;
  const raw = side === 'BUY'
    ? (markPrice - liquidationPrice) / markPrice
    : (liquidationPrice - markPrice) / markPrice;
  return raw * 100;
}

// Classifies a position the bot does not own.
//
// Two independent readings, because they catch different failures: proximity
// to liquidation catches a leveraged position about to be force-closed, while
// unrealized loss against account equity catches a large position bleeding
// badly without being near liquidation yet.
//
// Returns { severity: 'none' | 'warning' | 'extreme', reason, metrics }.
export function assessRisk({ symbol, side, markPrice, liquidationPrice, unrealizedPnl, equity }) {
  const distance = distanceToLiquidationPct(markPrice, liquidationPrice, side);
  const vsEquity = (Number.isFinite(unrealizedPnl) && equity > 0)
    ? (unrealizedPnl / equity) * 100 : null;
  const metrics = { markPrice, liquidationPrice, distanceToLiquidationPct: distance, unrealizedPnl, unrealizedVsEquityPct: vsEquity, equity };

  const reasons = [];
  let severity = 'none';

  if (distance != null && distance <= config.liquidationExtremePct) {
    severity = 'extreme';
    reasons.push(`mark is ${distance.toFixed(1)}% from liquidation (extreme below ${config.liquidationExtremePct}%) — a liquidation forfeits the whole margin, not just the adverse move`);
  } else if (distance != null && distance <= config.liquidationWarnPct) {
    severity = 'warning';
    reasons.push(`mark is ${distance.toFixed(1)}% from liquidation (warning below ${config.liquidationWarnPct}%)`);
  }

  if (vsEquity != null && vsEquity <= config.unrealizedLossExtremePct) {
    severity = 'extreme';
    reasons.push(`unrealized loss is ${vsEquity.toFixed(1)}% of account equity (extreme below ${config.unrealizedLossExtremePct}%)`);
  } else if (severity !== 'extreme' && vsEquity != null && vsEquity <= config.unrealizedLossWarnPct) {
    severity = 'warning';
    reasons.push(`unrealized loss is ${vsEquity.toFixed(1)}% of account equity (warning below ${config.unrealizedLossWarnPct}%)`);
  }

  return { severity, reason: reasons.join('; ') || 'within normal bounds', metrics };
}
