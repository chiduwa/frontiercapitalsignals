// Operator baseline, NOT an optimized model or a probability forecast.
// Price movement is converted to gross return on ORIGINAL initial margin.
export const POLICY_VERSION = 'margin-roi-v1';
const clamp = (x, low, high) => Math.max(low, Math.min(high, x));

export function dailyRangeStats(bars, nowMs = Date.now()) {
  if (!Array.isArray(bars) || !Number.isFinite(nowMs)) return null;
  const closed = bars.filter(b => Array.isArray(b) && Number(b[6]) < nowMs).slice(-30);
  if (closed.length !== 30) return null;
  let previous = null;
  const ranges = [];
  for (const b of closed) {
    const [at, open, high, low, close] = b.slice(0, 5).map(Number);
    const end = Number(b[6]);
    if (![at, open, high, low, close, end].every(Number.isFinite)
        || !(open > 0 && low > 0 && high >= Math.max(open, close) && low <= Math.min(open, close))
        || end - at !== 86_399_999 || at % 86_400_000 !== 0
        || (previous != null && at - previous !== 86_400_000)) return null;
    previous = at;
    ranges.push((high - low) / open * 100);
  }
  const through = Number(closed.at(-1)[6]);
  if (nowMs - through > 86_400_000) return null;
  const sorted = [...ranges].sort((a, b) => a - b);
  return { samples: 30, meanPct: ranges.reduce((a, b) => a + b, 0) / 30,
    medianPct: (sorted[14] + sorted[15]) / 2, through,
    basis: '30 closed daily futures candles: (high-low)/open' };
}

export function policyReliability(candidate, edgeFloor = 0.18, fullEdge = 0.35) {
  if (candidate?.authorized !== true || candidate.source !== 'confluence-v7'
      || !Number.isFinite(candidate.edge)) return 0;
  return clamp((candidate.edge - edgeFloor) / Math.max(1e-9, fullEdge - edgeFloor), 0, 1);
}

export function observedRange(candidate, nowMs = Date.now()) {
  const r = candidate?.tradingRange;
  if (r?.samples !== 30 || ![r.meanPct, r.medianPct, r.through].every(Number.isFinite)
      || !(r.meanPct > 0 && r.medianPct > 0)
      || r.through >= nowMs || nowMs - r.through > 86_400_000) return null;
  return Math.max(r.meanPct, r.medianPct,
    Number.isFinite(candidate.currentMovePct) ? Math.abs(candidate.currentMovePct) : 0);
}

export function leveragePlan(candidate, { min = 5, max = 20, edgeFloor = 0.18, fullEdge = 0.35, nowMs = Date.now() } = {}) {
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 5 || max > 20 || max < min) {
    throw new Error('leverage policy requires integer bounds within 5–20');
  }
  const reliability = policyReliability(candidate, edgeFloor, fullEdge);
  const rangePct = observedRange(candidate, nowMs);
  // Explicit initial policy anchors: <=2% daily range can allow 20x,
  // >=8% caps at 5x. These anchors have NOT been fitted to maximize profit.
  const stabilityCap = rangePct == null ? min : clamp(Math.floor(40 / rangePct), min, max);
  const reliabilityCap = Math.floor(min + reliability * (max - min) + 1e-9);
  return { leverage: Math.min(stabilityCap, reliabilityCap), reliability, rangePct,
    stabilityCap, reliabilityCap, basis: 'operator-baseline; minimum of stability and measured-edge caps' };
}

export function baselineExitPolicy(candidate, leverage, nowMs = Date.now()) {
  if (!Number.isInteger(leverage) || leverage < 5 || leverage > 20) return null;
  const reliability = policyReliability(candidate);
  const range = observedRange(candidate, nowMs);
  // Noise allowance grows with observed price range and measured reliability;
  // capped in MARGIN units so increased leverage cannot silently widen risk.
  const stopRoiPct = clamp((range ?? 0) * leverage * (0.25 + 0.25 * reliability), 10, 30);
  return { version: POLICY_VERSION, basis: 'gross-return-on-original-initial-margin',
    leverage, stopRoiPct, firstTargetRoiPct: 60, finalTargetRoiPct: 120,
    firstFraction: 0.75 - 0.25 * reliability, maxHoldHours: 24,
    reliability, rangePct: range, optimized: false };
}

export function validExitPolicy(p) {
  return p?.version === POLICY_VERSION && p.basis === 'gross-return-on-original-initial-margin'
    && Number.isInteger(p.leverage) && p.leverage >= 5 && p.leverage <= 20
    && Number.isFinite(p.stopRoiPct) && p.stopRoiPct >= 10 && p.stopRoiPct <= 30
    && p.firstTargetRoiPct === 60 && p.finalTargetRoiPct === 120
    && Number.isFinite(p.firstFraction) && p.firstFraction >= 0.5 && p.firstFraction <= 0.75
    && Number.isFinite(p.maxHoldHours) && p.maxHoldHours > 0 && p.maxHoldHours <= 24;
}

export function roiExitGeometry(side, entry, p) {
  if (!validExitPolicy(p) || !['BUY', 'SELL'].includes(side) || !Number.isFinite(entry) || entry <= 0) return null;
  const sign = side === 'BUY' ? 1 : -1;
  const price = roi => entry * (1 + sign * roi / (100 * p.leverage));
  return { stop: price(-p.stopRoiPct), firstTarget: price(p.firstTargetRoiPct),
    target: price(p.finalTargetRoiPct), timeExit: p.maxHoldHours * 3_600_000 };
}

export function managedExitReason(record, markPrice, nowMs, reversal = null) {
  if (!validExitPolicy(record?.roiPolicy)) return null;
  if (reversal?.authorized === true && reversal.symbol === record.symbol
      && reversal.assetClass === record.assetClass && ['BUY', 'SELL'].includes(reversal.side)
      && reversal.side !== record.side && Number.isFinite(Date.parse(reversal.signalPriceAt))
      && nowMs - Date.parse(reversal.signalPriceAt) >= 0
      && nowMs - Date.parse(reversal.signalPriceAt) <= 30 * 60_000) return 'verified-reversal';
  if (Number.isFinite(record.timeExitAfterMs) && record.timeExitAfterMs > 0
      && nowMs - Date.parse(record.openedAt) >= record.timeExitAfterMs) return 'policy-time-exit';
  if (!(Number.isFinite(markPrice) && markPrice > 0 && record.entryPrice > 0)) return null;
  const roi = (markPrice / record.entryPrice - 1) * (record.side === 'BUY' ? 1 : -1) * 100 * record.roiPolicy.leverage;
  if (roi <= -record.roiPolicy.stopRoiPct) return 'policy-stop';
  if (roi >= record.roiPolicy.finalTargetRoiPct) return 'policy-final-profit';
  if (roi >= record.roiPolicy.firstTargetRoiPct
      && !(record.firstProfitComplete === true)) return 'policy-first-profit';
  return null;
}
