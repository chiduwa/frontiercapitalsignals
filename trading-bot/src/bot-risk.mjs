import { config } from './config.mjs';
import { positionOrigin } from './positions.mjs';

const numeric = value => value == null || value === '' ? NaN : Number(value);

export function entryCapitalIssue(account, positionPct) {
  const capital = numeric(account?.totalMarginBalance);
  const available = numeric(account?.availableBalance);
  const positionMargin = numeric(account?.totalPositionInitialMargin);
  const orderMargin = numeric(account?.totalOpenOrderInitialMargin);
  if (!(capital > 0) || ![available, positionMargin, orderMargin].every(n => Number.isFinite(n) && n >= 0)
      || !(Number.isFinite(positionPct) && positionPct > 0 && positionPct <= config.maxPositionPct)) {
    return 'current margin allocation is unavailable or invalid';
  }
  const newMargin = capital * positionPct;
  if (newMargin > available) return 'insufficient available margin for the resting order';
  if (positionMargin + orderMargin + newMargin > capital * config.maxTotalExposurePct + 1e-9) {
    return 'existing positions and resting orders would exceed total margin allocation';
  }
  return null;
}

// Entry-risk accounting, not a fund NAV. Settled net P&L includes recorded
// fees/funding; open P&L is Binance's mark reading and does not yet include
// unsettled fees/funding. Open gains cannot cancel a booked loss here.
export function assessBotEntryRisk(summary, account, state) {
  const fail = reason => ({ ok: false, reason, basis: 'bot-settled-net-plus-open-loss' });
  const capital = numeric(account?.totalMarginBalance);
  const maintenance = numeric(account?.totalMaintMargin);
  if (!(capital > 0) || !(maintenance >= 0) || !Array.isArray(account?.positions)) {
    return fail('current account capital or maintenance margin unavailable');
  }
  if (maintenance / capital >= 0.5) return fail('account maintenance margin is at least 50% of equity');
  const net = numeric(summary?.netPnl);
  const peak = numeric(summary?.peakNetPnl);
  const daily = numeric(summary?.dailyNetPnl);
  if (numeric(summary?.incomplete) !== 0 || ![net, peak, daily].every(Number.isFinite)
      || peak < Math.max(0, net)) return fail('bot outcome ledger is incomplete');
  let openLoss = 0;
  for (const record of Object.values(state.openOrders || {})) {
    if (record.ownershipConflict || record.outcomePending) {
      return fail('bot ownership or a closed outcome is awaiting reconciliation');
    }
  }
  for (const position of account.positions) {
    const amount = numeric(position.positionAmt);
    if (!Number.isFinite(amount)) return fail('position quantity unavailable');
    if (amount === 0) continue;
    const origin = positionOrigin(position.symbol, state, amount > 0 ? 'BUY' : 'SELL', amount);
    if (origin === 'conflict') return fail('mixed position ownership requires reconciliation');
    if (origin !== 'bot') continue;
    const pnl = numeric(position.unrealizedProfit);
    if (!Number.isFinite(pnl)) return fail('bot position mark P&L unavailable');
    openLoss += Math.max(0, -pnl);
  }
  const drawdownLoss = Math.max(0, peak - net) + openLoss;
  const dailyLoss = Math.max(0, -daily) + openLoss;
  // Account cash flows and personal P&L change available capital, but never
  // enter either loss numerator. Add back the attributed loss to compare it
  // with capital before that loss. No account high-water mark is reset.
  const drawdownPct = drawdownLoss / (capital + drawdownLoss);
  const dailyLossPct = dailyLoss / (capital + dailyLoss);
  const reason = drawdownPct >= config.circuitBreakerDrawdownPct
    ? 'bot-attributable drawdown limit reached'
    : dailyLossPct >= config.dailyLossLimitPct ? 'bot-attributable daily loss limit reached' : null;
  return {
    ok: reason == null, reason, basis: 'bot-settled-net-plus-open-loss',
    capital, settledNetPnl: net, settledPeakPnl: peak, settledDailyPnl: daily,
    openLoss, drawdownPct, dailyLossPct,
    openCostsBasis: 'fees and funding enter the settled ledger after exact outcome reconciliation'
  };
}
