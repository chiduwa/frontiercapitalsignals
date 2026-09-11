// Plain-Node test suite, no framework — matches signals-worker/test-worker.mjs's
// style. Covers the pure contract/risk/strategy/resolution math only (no live
// Binance calls, no D1).
process.env.BINANCE_API_KEY = 'test';
process.env.BINANCE_API_SECRET = 'test';
process.env.CLOUDFLARE_API_TOKEN = 'test';
process.env.CLOUDFLARE_ACCOUNT_ID = 'test';
process.env.FCS_D1_DATABASE_ID = 'test';
process.env.ACTIVE_LIMIT_MODE = 'false';
process.env.ROI_EXIT_POLICY = 'true'; // exercise the opt-in policy without exchange IO
await import('./test-policy-replay.mjs');
await import('./test-policy-history.mjs');

const { config, parseBoolean } = await import('./src/config.mjs');
const {
  makeClientOrderId, executedMarketOrder, isActiveAlgoOrder, algoOrderDisposition,
  protectiveOrderMatches, protectionClientOrderId, protectionClientOrderIds,
  MAX_PROTECTION_GENERATIONS, marketClientOrderId, MAX_MARKET_ORDER_GENERATIONS,
  marketOrderMatches, limitOrderMatches, isExecutionOutcomeUnknown,
  isLegacyAssistedProtectionId, isFuturesBotOrderId, roundLimitToStep,
  boundedHistoryWindows, marketEligibleForAssetClass
} = await import('./src/binance.mjs');
const { acquireExecutionLease, releaseExecutionLease } = await import('../signals-worker/scripts/execution-lease.mjs');
const { entryIntentMatches, loadBotLossSummary } = await import('./src/state.mjs');
const { DatabaseSync } = await import('node:sqlite');
const { ACTIVE_LIMIT_SOURCE, activePolicyCandidate, activeExecutionEligible, activeExitGeometry } = await import('./src/active-limit.mjs');
const { assessBotEntryRisk, entryCapitalIssue } = await import('./src/bot-risk.mjs');
const { ENGINE, authorizeRow, authorizeResearch, classAuthorized, holdingFor, dayRangePosition } = await import('./src/contract.mjs');
const {
  conservativeEdge, sizePosition, currentExposurePct, wouldExceedExposure,
  wouldExceedResearchExposure, circuitBreakerTripped, dailyLossLimitHit, inCooldown,
  fundingUnfavorable, stopLossPrice, stopLossPriceForResearch, takeProfitPrice,
  timeExitAfterMs, patienceUnmet, entryOffsetPlan, entryLimitPrice,
  entryOrderTtlMs, entryOrderExpiryMs, signalReferenceIssue
} = await import('./src/risk.mjs');
const { evaluateCandidate, decideEntries } = await import('./src/strategy.mjs');
const { resolveShadowTrade } = await import('./src/paper.mjs');
const {
  positionOrigin, positionQuantitiesMatch, distanceToLiquidationPct,
  assessRisk
} = await import('./src/positions.mjs');
const { buildCandidates, toBinanceSymbol, dedupeBySymbol } = await import('./src/signals.mjs');
const { summarizeExactRoundTrip } = await import('./src/outcome.mjs');
const { assessLimitReachability } = await import('./src/entry-research.mjs');
const { leveragePlan, dailyRangeStats, baselineExitPolicy, roiExitGeometry, managedExitReason } = await import('./src/trade-policy.mjs');
const { managePolicyExits } = await import('./src/managed-exits.mjs');

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`  PASS  ${name}`); }
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`); }
}

// A row exactly as the engine publishes one when it HAS authorized a call.
// Every rejection test below mutates one field of this, so a future contract
// change surfaces as a specific failure rather than a silent pass.
const authorizedRow = () => ({
  symbol: 'SOL', price: 100, rangePos: 0.1, dir: 1,
  horizon: { days: 1, basis: 'historical' },
  range: { low: 96, high: 108, basis: 'historical' },
  confidence: {
    conservative_win_rate: 0.62, raw_win_rate: 0.66, baseline: 0.41,
    conservative_edge: 0.21, agreement: 0.6,
    asset_samples: 60, asset_effective_samples: 40,
    calibration_samples: 90, calibration_effective_samples: 50,
    calibration_source: 'asset-class-direction-horizon',
    asset_record_scope: 'asset-direction-horizon',
    range_coverage: 0.7, range_samples: 60, range_effective_samples: 40,
    range_nominal_coverage: 0.68, range_calibrated: true
  },
  funding: 0, drivers: [], chg24h: 2.5,
  dailyMoves: { medianAbsPct: 3.2, samples: 364 },
  analysis: { reference_price: 100, analyzed_at: '2026-09-05T11:55:00Z' }
});
const provenClass = { crypto: { proven: true, lowerEdge: 0.05, significant: true } };

console.log('== contract.mjs: the engine decides, not the board ==');
check('a fully authorized row is accepted', authorizeRow(authorizedRow()).ok);
check('side comes from the published dir, not from which board it sat on',
  authorizeRow({ ...authorizedRow(), dir: -1 }).side === 'SELL');
check('a long publishes as BUY', authorizeRow(authorizedRow()).side === 'BUY');
// The single most important rejection: the cold-start state live right now.
check('an explicitly withheld row is refused, with the engine\'s own reason',
  (() => { const r = authorizeRow({ ...authorizedRow(), abstained: { reason: 'insufficient-evidence', measured: null } }); return !r.ok && r.reason.includes('insufficient-evidence'); })());
check('dir 0 is not a direction', !authorizeRow({ ...authorizedRow(), dir: 0 }).ok);
check('a null horizon is refused', !authorizeRow({ ...authorizedRow(), horizon: null }).ok);
check('a non-empirical horizon basis is refused',
  !authorizeRow({ ...authorizedRow(), horizon: { days: 1, basis: 'methodology' } }).ok);
check('a null range is refused', !authorizeRow({ ...authorizedRow(), range: null }).ok);
check('a non-empirical range basis is refused',
  !authorizeRow({ ...authorizedRow(), range: { low: 96, high: 108, basis: 'volatility' } }).ok);
check('an inverted range is refused',
  !authorizeRow({ ...authorizedRow(), range: { low: 108, high: 96, basis: 'historical' } }).ok);
check('a null confidence object is refused', !authorizeRow({ ...authorizedRow(), confidence: null }).ok);
// Pooled calibration is diagnostic only — this is the exact substitution the
// engine's audit forbids, so it must never authorize a position.
check('pooled calibration may not authorize a trade', (() => {
  const row = authorizedRow();
  row.confidence.calibration_source = 'pooled';
  const r = authorizeRow(row);
  return !r.ok && r.reason.includes('diagnostic only');
})());
check('a pooled asset record scope is refused', (() => {
  const row = authorizedRow();
  row.confidence.asset_record_scope = 'asset-blended';
  return !authorizeRow(row).ok;
})());
check('an asset record below the engine\'s independent-sample bar is refused', (() => {
  const row = authorizedRow();
  row.confidence.asset_effective_samples = ENGINE.minReliabilitySamples - 1;
  return !authorizeRow(row).ok;
})());
check('thin calibration is refused', (() => {
  const row = authorizedRow();
  row.confidence.calibration_effective_samples = ENGINE.minCalibrationSamples - 1;
  return !authorizeRow(row).ok;
})());
check('an uncalibrated expected-move band is refused', (() => {
  const row = authorizedRow();
  row.confidence.range_calibrated = false;
  return !authorizeRow(row).ok;
})());
check('an edge below the engine\'s actionable bar is refused', (() => {
  const row = authorizedRow();
  row.confidence.conservative_edge = ENGINE.minActionableEdge - 0.001;
  return !authorizeRow(row).ok;
})());
check('an edge exactly at the bar is accepted', (() => {
  const row = authorizedRow();
  row.confidence.conservative_edge = ENGINE.minActionableEdge;
  return authorizeRow(row).ok;
})());
// Pinned to the engine's published constants (worker.js). If the engine
// raises a bar and this is not updated, this test fails rather than leaving
// the bot quietly laxer than the system it claims to follow.
check('the engine\'s bars are mirrored exactly', ENGINE.minActionableEdge === 0.18
  && ENGINE.minReliabilitySamples === 20 && ENGINE.minCalibrationSamples === 30
  && ENGINE.minRangeSamples === 30, JSON.stringify(ENGINE));

check('a class with no skill record is not authorized', !classAuthorized(null, 'crypto').ok);
check('an unproven class is not authorized — this is the live cold-start state',
  !classAuthorized({ crypto: { proven: false, lowerEdge: -0.056 } }, 'crypto').ok);
check('a proven class is authorized', classAuthorized(provenClass, 'crypto').ok);

console.log('\n== contract.mjs: research lifecycle ==');
const confirmedResearch = {
  decision: 'confirmed', side: 'long', walkForward: 'pass', netLower95Pct: 0.4,
  worstTradePct: -6.2, maxDrawdownPct: -11, horizonDays: 2, trades: 60,
  assetClass: 'crypto', symbol: 'ETH', hypothesis: 'turn-of-month|ETH|2d', family: 'turn-of-month'
};
check('a confirmed strategy with positive after-cost lower bound may trade', authorizeResearch(confirmedResearch).ok);
check('provisional may NOT trade — nothing post-discovery has confirmed it',
  !authorizeResearch({ ...confirmedResearch, decision: 'provisional' }).ok);
check('abstain may not trade', !authorizeResearch({ ...confirmedResearch, decision: 'abstain' }).ok);
check('a failed walk-forward may not trade',
  !authorizeResearch({ ...confirmedResearch, walkForward: 'fail' }).ok);
check('a non-positive after-cost lower bound may not trade',
  !authorizeResearch({ ...confirmedResearch, netLower95Pct: 0 }).ok);
check('a strategy with no measured worst trade may not trade (nothing to size a stop against)',
  !authorizeResearch({ ...confirmedResearch, worstTradePct: null }).ok);
check('a directionless strategy may not trade',
  !authorizeResearch({ ...confirmedResearch, side: 'abstain' }).ok);
check('short maps to SELL', authorizeResearch({ ...confirmedResearch, side: 'short' }).side === 'SELL');

console.log('\n== contract.mjs: measured path evidence lookup ==');
const evidence = { minSamples: 30, rows: [
  { assetClass: 'crypto', symbol: 'SOL', dir: 1, horizonHours: 24, n: 41, mfePct: 6, maePct: -2.4, wrongN: 12, wrongMaePct: -6.5, hoursToPeak: 7, peakShare: 0.29, heldPct: 1.2, giveBackPct: 4.8, adverseFirstRate: 0.7, adverseFirstLower: 0.56 }
] };
check('the exact asset/side/horizon record is found', holdingFor(evidence, 'crypto', 'SOL', 1, 24)?.n === 41);
check('the opposite side is not borrowed', holdingFor(evidence, 'crypto', 'SOL', -1, 24) === null);
check('a different horizon is not borrowed', holdingFor(evidence, 'crypto', 'SOL', 1, 168) === null);
check('a different asset is not borrowed', holdingFor(evidence, 'crypto', 'ETH', 1, 24) === null);
check('absent evidence returns null, never a partial record', holdingFor(null, 'crypto', 'SOL', 1, 24) === null);
check('day-range position is read from the scalp surface',
  dayRangePosition({ assets: [{ symbol: 'SOL', range: { posInDayRange: 0.12 } }] }, 'SOL') === 0.12);
check('a missing scalp asset yields null, not zero (zero would read as "at the low")',
  dayRangePosition({ assets: [] }, 'SOL') === null);

console.log('\n== risk.mjs: sizing scales on measured edge ==');
const atBar = sizePosition({ source: 'confluence-v7', edge: ENGINE.minActionableEdge }, false);
check('at the engine\'s bar, sizing/leverage sit at the minimum',
  atBar.positionPct === config.minPositionPct && atBar.leverage === config.minLeverage, JSON.stringify(atBar));
const stableRange = { samples: 30, meanPct: 2, medianPct: 1.8, through: Date.now() - 1000 };
const stableProven = { source: 'confluence-v7', authorized: true, tradingRange: stableRange };
const atFull = sizePosition({ ...stableProven, edge: config.edgeFullSize }, false);
check('at the full-size edge, sizing/leverage reach the maximum',
  atFull.positionPct === config.maxPositionPct && atFull.leverage === config.maxLeverage, JSON.stringify(atFull));
check('a larger edge never exceeds the hard ceilings', (() => {
  const huge = sizePosition({ ...stableProven, edge: 5 }, true);
  return huge.positionPct === config.maxPositionPct && huge.leverage === config.maxLeverage;
})());
const mid = sizePosition({ source: 'confluence-v7', edge: 0.26 }, false);
check('a mid edge sizes between the bounds',
  mid.positionPct > config.minPositionPct && mid.positionPct < config.maxPositionPct, JSON.stringify(mid));
check('the extreme boost increases size at the same edge',
  sizePosition({ source: 'confluence-v7', edge: 0.26 }, true).positionPct > mid.positionPct);
// Research evidence is an event study, not per-asset calibration: floor only.
check('a confirmed research strategy always takes the floor size and leverage', (() => {
  const r = sizePosition({ source: 'research-confirmed', edge: 5, netLower95Pct: 9 }, true);
  return r.positionPct === config.minPositionPct && r.leverage === config.minLeverage;
})());
check('conservativeEdge treats a missing edge as zero, never as a pass', conservativeEdge({}) === 0);

console.log('\n== risk.mjs: exposure caps ==');
check('unknown balance reads as fully exposed, never as room to trade', currentExposurePct([], 0) === 1);
check('exposure is margin committed, not notional',
  Math.abs(currentExposurePct([{ notional: 1000, leverage: 10 }], 1000) - 0.1) < 1e-9);
check('the global exposure ceiling is enforced',
  wouldExceedExposure([{ notional: 4000, leverage: 10 }], 1000, 0.2) === true);
check('research exposure has its own, lower ceiling', wouldExceedResearchExposure(
  [{ notional: 1000, leverage: 10, source: 'research-confirmed' }], 1000, 0.1) === true);
check('a confluence position does not consume the research budget', wouldExceedResearchExposure(
  [{ notional: 4000, leverage: 10, source: 'confluence-v7' }], 1000, 0.1) === false);

console.log('\n== risk.mjs: exits from measured path shape ==');
const holding = evidence.rows[0];
check('with no evidence, the target stays the far end of the predicted range',
  takeProfitPrice('BUY', 100, { low: 96, high: 108 }, null) === 108);
// Measured: 6% MFE x 0.7 = +4.2% -> 104.2, nearer than the 108 band edge.
check('a measured excursion target is preferred when it is nearer than the band edge',
  Math.abs(takeProfitPrice('BUY', 100, { low: 96, high: 108 }, holding) - 104.2) < 1e-9,
  String(takeProfitPrice('BUY', 100, { low: 96, high: 108 }, holding)));
check('the band edge wins when the measured excursion is further out',
  takeProfitPrice('BUY', 100, { low: 96, high: 102 }, holding) === 102);
check('a short takes the nearer target below entry', (() => {
  const shortHolding = { ...holding, dir: -1 };
  const tp = takeProfitPrice('SELL', 100, { low: 90, high: 104 }, shortHolding);
  return Math.abs(tp - 95.8) < 1e-9;
})());
// A side whose mean favorable excursion is ~0 must not produce a target at or
// through entry — that would fill the instant it is placed.
check('a non-improving measured target falls back to the band rather than filling instantly',
  takeProfitPrice('BUY', 100, { low: 96, high: 108 }, { ...holding, mfePct: 0 }) === 108);
check('with neither a band nor evidence there is no target',
  takeProfitPrice('BUY', 100, null, null) === null);

check('the time exit is the measured time-to-peak when inside the horizon',
  timeExitAfterMs(holding, 24, false) === 7 * 3600000);
check('the time exit never extends past the declared horizon',
  timeExitAfterMs({ ...holding, hoursToPeak: 40 }, 24, false) === 24 * 3600000);
check('the extreme boost holds longer, still capped by the horizon',
  timeExitAfterMs(holding, 24, true) === 7 * 3600000 * config.extremeHoldMultiplier);
check('with no evidence the horizon itself is the clock', timeExitAfterMs(null, 24, false) === 24 * 3600000);
check('with neither evidence nor horizon there is no clock', timeExitAfterMs(null, null, false) === null);

const genericStop = stopLossPrice(100, 'BUY', 10);
check('the generic stop burns a fixed fraction of committed margin',
  Math.abs(genericStop - 95) < 1e-9, String(genericStop));
check('a short\'s stop sits above entry', stopLossPrice(100, 'SELL', 10) === 105);
// -6.2% worst trade x 1.5 = -9.3% -> 90.7, wider than the generic 95 cap, so
// the generic cap must win: a research row can never risk more per trade.
check('a research stop never risks more than the generic per-trade cap',
  stopLossPriceForResearch(100, 'BUY', 10, -6.2) === genericStop,
  String(stopLossPriceForResearch(100, 'BUY', 10, -6.2)));
check('a research stop is used when it is tighter than the generic cap',
  Math.abs(stopLossPriceForResearch(100, 'BUY', 10, -2) - 97) < 1e-9,
  String(stopLossPriceForResearch(100, 'BUY', 10, -2)));
check('a short research stop is bounded on the correct side',
  stopLossPriceForResearch(100, 'SELL', 10, -6.2) === stopLossPrice(100, 'SELL', 10));
check('a missing worst trade falls back to the generic stop',
  stopLossPriceForResearch(100, 'BUY', 10, null) === genericStop);

console.log('\n== risk.mjs: entry patience, measured ==');
check('without path evidence patience is not asserted', patienceUnmet({ side: 'BUY', holding: null }) === null);
check('when the worst price usually lands first, a mid-range entry waits',
  typeof patienceUnmet({ side: 'BUY', holding, dayRangePos: 0.6 }) === 'string');
check('the same setup at the session low is allowed through',
  patienceUnmet({ side: 'BUY', holding, dayRangePos: 0.1 }) === null);
check('a short waits near the session low and is allowed near the high',
  typeof patienceUnmet({ side: 'SELL', holding, dayRangePos: 0.4 }) === 'string'
  && patienceUnmet({ side: 'SELL', holding, dayRangePos: 0.9 }) === null);
check('when the favorable extreme usually lands first, no patience is demanded',
  patienceUnmet({ side: 'BUY', holding: { ...holding, adverseFirstLower: 0.2 }, dayRangePos: 0.6 }) === null);
check('missing day-range data blocks rather than assumes the heat arrived',
  typeof patienceUnmet({ side: 'BUY', holding, dayRangePos: null }) === 'string');

console.log('\n== risk.mjs: evidence-labelled resting entry offset ==');
const quietOffset = entryOffsetPlan({
  signalPrice: 100, edge: ENGINE.minActionableEdge,
  medianAbsDailyMovePct: 3, dailyMoveSamples: 300, currentMovePct: 2,
  holding: null
});
check('the explicit policy prior supplies a 5% floor when exact-asset movement is quieter',
  quietOffset.ok && quietOffset.offsetPct === config.entryOffsetMinPct
    && quietOffset.basis === 'operator policy floor', JSON.stringify(quietOffset));
const wrongSideOffset = entryOffsetPlan({
  signalPrice: 100, edge: 0.26,
  medianAbsDailyMovePct: 3, dailyMoveSamples: 300, currentMovePct: 2,
  holding: { n: 40, maePct: -2.5, wrongN: 12, wrongMaePct: -6.5 }
});
check('a qualified exact-asset wrong-call excursion widens the offset and is labelled',
  wrongSideOffset.ok && wrongSideOffset.offsetPct > quietOffset.offsetPct
    && wrongSideOffset.adverseBasis === 'wrong-call mean adverse excursion',
  JSON.stringify(wrongSideOffset));
const highConfidenceOffset = entryOffsetPlan({
  signalPrice: 100, edge: config.edgeFullSize,
  medianAbsDailyMovePct: 3, dailyMoveSamples: 300, currentMovePct: 2,
  holding: { n: 40, maePct: -2.5, wrongN: 12, wrongMaePct: -6.5 }
});
check('higher calibrated edge reduces the same asset/volatility offset only modestly',
  highConfidenceOffset.offsetPct < wrongSideOffset.offsetPct
    && highConfidenceOffset.offsetPct >= config.entryOffsetHighConfidenceFloorPct,
  JSON.stringify(highConfidenceOffset));
const volatileOffset = entryOffsetPlan({
  signalPrice: 100, edge: ENGINE.minActionableEdge,
  medianAbsDailyMovePct: 12, dailyMoveSamples: 300, currentMovePct: 14,
  holding: null
});
check('higher observed volatility widens but never exceeds the requested cap',
  volatileOffset.offsetPct === config.entryOffsetMaxPct, JSON.stringify(volatileOffset));
check('thin wrong-call data is ignored in favor of the qualified all-call fallback', (() => {
  const r = entryOffsetPlan({
    signalPrice: 100, edge: ENGINE.minActionableEdge,
    holding: { n: 40, maePct: -5.5, wrongN: 3, wrongMaePct: -20 }
  });
  return r.adverseBasis === 'all-call mean adverse excursion' && r.offsetPct === 5.5;
})());
check('missing signal reference abstains rather than using the live mark',
  entryOffsetPlan({ price: 100 }).ok === false);
check('longs rest below and shorts rest above the same signal reference',
  entryLimitPrice(100, 'BUY', 5) === 95 && entryLimitPrice(100, 'SELL', 5) === 105);
check('an invalid side cannot manufacture an entry price', entryLimitPrice(100, 'HOLD', 5) === null);
check('limit tick rounding never erodes the offset on either side',
  roundLimitToStep(94.9991, 'BUY', 0.01, 2) === 94.99
    && roundLimitToStep(105.0001, 'SELL', 0.01, 2) === 105.01);
check('invalid limit tick geometry is withheld',
  Number.isNaN(roundLimitToStep(100, 'HOLD', 0.01, 2))
    && Number.isNaN(roundLimitToStep(100, 'BUY', 0, 2)));
check('measured hours-to-peak sets a shorter evidence clock than the one-day cap',
  entryOrderTtlMs({ holding: { hoursToPeak: 7 }, horizonHours: 24 }) === 7 * 3600000);
check('order lifetime is capped at one day when the forecast is longer',
  entryOrderTtlMs({ holding: null, horizonHours: 168 }) === 24 * 3600000);
check('the same immutable observation always produces the same GTD expiry',
  entryOrderExpiryMs({ signalPriceAt: '2026-09-05T12:00:00.987Z', holding: { hoursToPeak: 7 }, horizonHours: 24 })
    === Date.parse('2026-09-05T19:00:00.000Z'));
check('fresh matching references pass and stale/cross-market references abstain',
  signalReferenceIssue({ signalPrice: 100, signalPriceAt: '2026-09-05T11:55:00Z' }, Date.parse('2026-09-05T12:00:00Z'), 101) === null
    && signalReferenceIssue({ signalPrice: 100, signalPriceAt: '2026-09-05T10:00:00Z' }, Date.parse('2026-09-05T12:00:00Z'), 101)?.includes('old')
    && signalReferenceIssue({ signalPrice: 100, signalPriceAt: '2026-09-05T11:55:00Z' }, Date.parse('2026-09-05T12:00:00Z'), 110)?.includes('differs'));

console.log('\n== strategy.mjs: an unauthorized row can never become an order ==');
const nowMs = Date.parse('2026-09-05T12:00:00Z');
const baseCtx = {
  fearGreed: 50, openSymbols: new Set(), openPositions: [], balance: 1000, equity: 1000,
  state: { peakEquity: 1000, dayStartEquity: 1000, lastClosedAt: {} }, nowMs
};
const authorizedCandidate = {
  source: 'confluence-v7', signalSymbol: 'SOL', symbol: 'SOLUSDT', side: 'BUY',
  assetClass: 'crypto', signalPrice: 100, signalPriceAt: '2026-09-05T11:55:00Z',
  authorized: true, unauthorizedReason: null, rangePos: 0.1, range: { low: 96, high: 108 },
  horizonHours: 24, edge: 0.26, holding: null, dayRangePos: 0.2, funding: 0,
  medianAbsDailyMovePct: 3, dailyMoveSamples: 364, currentMovePct: 2
};
check('an authorized, in-zone candidate opens', evaluateCandidate(authorizedCandidate, baseCtx).action === 'OPEN');
// THE critical safety property of this whole upgrade.
const withheld = { ...authorizedCandidate, authorized: false, unauthorizedReason: 'engine withheld: insufficient-evidence' };
check('the identical candidate, unauthorized, becomes SHADOW and never OPEN',
  evaluateCandidate(withheld, baseCtx).action === 'SHADOW');
check('the shadow decision carries the engine\'s reason for withholding',
  evaluateCandidate(withheld, baseCtx).reason.includes('insufficient-evidence'));
check('authorization is checked LAST, so an otherwise-valid withheld row becomes shadow',
  evaluateCandidate({ ...withheld, rangePos: 0.9 }, baseCtx).action === 'SHADOW');
check('already holding this symbol is skipped', evaluateCandidate(authorizedCandidate, { ...baseCtx, openSymbols: new Set(['SOLUSDT']) }).action === 'SKIP');
check('a symbol in cooldown is skipped', evaluateCandidate(authorizedCandidate, {
  ...baseCtx, state: { ...baseCtx.state, lastClosedAt: { SOLUSDT: new Date(nowMs - 60000).toISOString() } }
}).action === 'SKIP');
check('an out-of-zone candidate can place a patient resting limit instead of a market entry',
  evaluateCandidate({ ...authorizedCandidate, rangePos: 0.9 }, baseCtx).action === 'OPEN');
check('unfavorable funding is skipped',
  evaluateCandidate({ ...authorizedCandidate, funding: 0.01 }, baseCtx).action === 'SKIP');
check('a research candidate without a published reference price abstains instead of inventing one',
  evaluateCandidate({
    ...authorizedCandidate, source: 'research-confirmed', rangePos: null, range: null,
    signalPrice: null, signalPriceAt: null, edge: 0
  }, baseCtx).action === 'SKIP');

// Fear & Greed extreme + reversal, now sourced from the scalp day-range.
const extremeCtx = { ...baseCtx, fearGreed: 12 };
const outOfZone = { ...authorizedCandidate, rangePos: 0.9, dayRangePos: 0.05 };
check('at an extreme with price at the session low, the range gate is substituted',
  evaluateCandidate(outOfZone, extremeCtx).action === 'OPEN');
check('the extreme boost is flagged on that decision',
  evaluateCandidate(outOfZone, extremeCtx).extremeBoost === true);
check('an extreme reading alone, without price at the session extreme, does not add the aggression boost',
  evaluateCandidate({ ...outOfZone, dayRangePos: 0.5 }, extremeCtx).extremeBoost === false);
check('greed does not boost a long',
  evaluateCandidate(outOfZone, { ...baseCtx, fearGreed: 95 }).extremeBoost === false);

console.log('\n== strategy.mjs: ranking and exposure accounting ==');
const strong = { ...authorizedCandidate, symbol: 'AUSDT', edge: 0.33 };
const weak = { ...authorizedCandidate, symbol: 'BUSDT', edge: 0.19 };
check('the strongest measured edge is evaluated first',
  decideEntries([weak, strong], baseCtx).decisions[0].symbol === 'AUSDT');
check('the circuit breaker pauses every entry at once', (() => {
  const r = decideEntries([strong], { ...baseCtx, equity: 800 });
  return r.paused === 'circuit_breaker' && r.decisions.every((d) => d.action === 'SKIP');
})());
check('the daily loss limit pauses every entry at once', (() => {
  const r = decideEntries([strong], { ...baseCtx, equity: 880, state: { ...baseCtx.state, peakEquity: 900, dayStartEquity: 1000 } });
  return r.paused === 'daily_loss_limit' && r.decisions.every((d) => d.action === 'SKIP');
})());
for (const [gate, pausedCtx] of [
  ['circuit_breaker', { ...baseCtx, equity: 800 }],
  ['daily_loss_limit', { ...baseCtx, equity: 880, state: { ...baseCtx.state, peakEquity: 900, dayStartEquity: 1000 } }]
]) {
  check(`${gate} keeps qualified withheld candidates in research while every live candidate stays SKIP`, (() => {
    const many = Array.from({ length: 8 }, (_, i) => ({ ...withheld, symbol: `P${i}USDT` }));
    const r = decideEntries([strong, ...many, weak], pausedCtx);
    const shadows = r.decisions.filter((d) => d.action === 'SHADOW');
    return r.paused === gate
      && r.decisions.filter((d) => d.candidate.authorized).every((d) => d.action === 'SKIP')
      && shadows.length === many.length
      && shadows.every((d) => d.reason.includes('insufficient-evidence') && d.reason.includes('live entries paused:'))
      && !r.decisions.some((d) => d.action === 'OPEN')
      && pausedCtx.openPositions.length === 0;
  })());
  check(`${gate} does not bypass research freshness, funding, ownership, cooldown, or exposure gates`, (() => {
    const stale = { ...withheld, signalPriceAt: '2026-09-05T10:00:00Z' };
    const badFunding = { ...withheld, funding: 0.01 };
    const cases = [
      [stale, pausedCtx, 'old'],
      [badFunding, pausedCtx, 'funding'],
      [withheld, { ...pausedCtx, openSymbols: new Set(['SOLUSDT']) }, 'already holding'],
      [withheld, { ...pausedCtx, state: { ...pausedCtx.state, lastClosedAt: { SOLUSDT: new Date(nowMs - 60000).toISOString() } } }, 'cooldown'],
      [withheld, { ...pausedCtx, openPositions: [{ notional: 1000, leverage: 1 }] }, 'max total exposure']
    ];
    return cases.every(([candidate, ctx, reason]) => {
      const r = decideEntries([candidate], ctx);
      return r.paused === gate && r.decisions[0].action === 'SKIP' && r.decisions[0].reason.includes(reason);
    });
  })());
}
// A shadow entry is not a position: it must not crowd out a real one.
check('a shadow entry consumes no exposure room', (() => {
  const many = Array.from({ length: 8 }, (_, i) => ({ ...withheld, symbol: `S${i}USDT` }));
  const r = decideEntries(many, baseCtx);
  return r.decisions.every((d) => d.action === 'SHADOW');
})());
check('real opens do consume exposure room, and later candidates are cut off', (() => {
  const many = Array.from({ length: 8 }, (_, i) => ({ ...authorizedCandidate, symbol: `R${i}USDT`, edge: 0.33 }));
  const r = decideEntries(many, baseCtx);
  const opened = r.decisions.filter((d) => d.action === 'OPEN').length;
  const blocked = r.decisions.filter((d) => d.action === 'SKIP' && d.reason === 'would exceed max total exposure').length;
  return opened > 0 && blocked > 0 && opened * config.maxPositionPct <= config.maxTotalExposurePct + 1e-9;
})(), 'exposure accounting across a full candidate list');

console.log('\n== paper.mjs: the ledger resolves against real prices ==');
const ledgerRow = {
  id: 1, opened_at: '2026-09-05T00:00:00Z', mode: 'shadow', source: 'confluence-v7',
  symbol: 'SOLUSDT', side: 'BUY', entry_price: 100, stop_price: 95, target_price: 104,
  leverage: 10, horizon_hours: 24, time_exit_after_ms: 7 * 3600000
};
const t0 = Date.parse('2026-09-05T01:00:00Z');
check('an untouched position inside its clock stays open', resolveShadowTrade(ledgerRow, 101, t0) === null);
check('a target hit resolves at the target, not the observed price',
  (() => { const r = resolveShadowTrade(ledgerRow, 106, t0); return r.reason === 'target' && r.exitPrice === 104; })());
check('the return is leveraged and signed for the side taken',
  Math.abs(resolveShadowTrade(ledgerRow, 106, t0).returnPct - 40) < 1e-9,
  String(resolveShadowTrade(ledgerRow, 106, t0).returnPct));
check('a stop hit resolves at the stop with a negative return',
  (() => { const r = resolveShadowTrade(ledgerRow, 90, t0); return r.reason === 'stop' && r.exitPrice === 95 && Math.abs(r.returnPct + 50) < 1e-9; })());
// Between two cycles both levels can be inside the gap. Which came first is
// unknowable from a single mark price, so it must read as the loss.
check('when the extremes since entry have seen BOTH levels, it resolves as the STOP', (() => {
  const r = resolveShadowTrade({ ...ledgerRow, running_high: 110, running_low: 90 }, 101, t0);
  return r.reason === 'stop';
})());
// A stop breached and recovered between cycles is a closed trade. Judging on
// the latest mark alone would silently drop exactly the losers.
check('a stop breached earlier still resolves even though price has recovered', (() => {
  const r = resolveShadowTrade({ ...ledgerRow, running_low: 94 }, 101, t0);
  return r.reason === 'stop' && r.exitPrice === 95;
})());
check('a target touched earlier still resolves even though price has fallen back', (() => {
  const r = resolveShadowTrade({ ...ledgerRow, running_high: 105 }, 99, t0);
  return r.reason === 'target' && r.exitPrice === 104;
})());
check('past the measured time exit it closes at the mark',
  (() => { const r = resolveShadowTrade(ledgerRow, 102, Date.parse('2026-09-05T08:00:00Z')); return r.reason === 'time' && r.exitPrice === 102; })());
check('with no time exit it still closes at the horizon',
  (() => { const r = resolveShadowTrade({ ...ledgerRow, time_exit_after_ms: null }, 102, Date.parse('2026-09-06T01:00:00Z')); return r.reason === 'horizon'; })());
check('a short resolves with the opposite sign', (() => {
  const r = resolveShadowTrade({ ...ledgerRow, side: 'SELL', stop_price: 105, target_price: 96 }, 96, t0);
  return r.reason === 'target' && Math.abs(r.returnPct - 40) < 1e-9;
})());

console.log('\n== signals.mjs: payload -> candidates ==');
check('the engine\'s bare symbol maps to the USDT futures pair', toBinanceSymbol('uni') === 'UNIUSDT');
const payload = {
  classSkill: provenClass,
  crypto: { breakout: [authorizedRow()], breakdown: [{ ...authorizedRow(), symbol: 'XRP', dir: -1 }] },
  holdingEvidence: evidence,
  quantResearch: { rows: [confirmedResearch, { ...confirmedResearch, symbol: 'BTC', decision: 'provisional' }] }
};
const built = buildCandidates(payload, { assets: [{ symbol: 'SOL', range: { posInDayRange: 0.3 } }] });
check('both boards contribute candidates', built.filter((c) => c.source === 'confluence-v7').length === 2);
check('a candidate carries the Binance pair and the engine symbol separately', (() => {
  const sol = built.find((c) => c.signalSymbol === 'SOL');
  return sol.symbol === 'SOLUSDT' && sol.signalSymbol === 'SOL';
})());
// A row on the BREAKDOWN board with dir -1 is a SELL because dir says so.
check('side follows the published direction', built.find((c) => c.signalSymbol === 'XRP').side === 'SELL');
check('authorized rows are marked authorized', built.find((c) => c.signalSymbol === 'SOL').authorized === true);
check('the matching path evidence is attached',
  built.find((c) => c.signalSymbol === 'SOL').holding?.n === 41);
check('day-range position is attached from the scalp surface',
  built.find((c) => c.signalSymbol === 'SOL').dayRangePos === 0.3);
check('only the confirmed research row is authorized', (() => {
  const research = built.filter((c) => c.source === 'research-confirmed');
  return research.length === 2 && research.filter((c) => c.authorized).length === 1
    && research.find((c) => c.signalSymbol === 'ETH').authorized === true;
})());
// The live cold start: an unproven class must disqualify every row in it,
// even one whose own cells would otherwise pass.
check('an unproven asset class disqualifies every row inside it', (() => {
  const cold = buildCandidates({ ...payload, classSkill: { crypto: { proven: false, lowerEdge: -0.05 } } }, null);
  return cold.filter((c) => c.source === 'confluence-v7').every((c) => !c.authorized);
})());
check('a withheld row is still surfaced, carrying the engine\'s reason', (() => {
  const cold = buildCandidates({
    ...payload,
    crypto: { breakout: [{ ...authorizedRow(), abstained: { reason: 'insufficient-evidence', measured: null } }], breakdown: [] }
  }, null);
  return cold[0].authorized === false && cold[0].unauthorizedReason.includes('insufficient-evidence');
})());

console.log('\n== signals.mjs: one candidate per symbol ==');
const dupA = { source: 'confluence-v7', symbol: 'UNIUSDT', side: 'BUY', authorized: false, unauthorizedReason: 'x' };
check('an identical duplicate collapses to one', dedupeBySymbol([dupA, { ...dupA }]).length === 1);
check('an authorized row wins over a withheld one for the same symbol', (() => {
  const auth = { ...dupA, authorized: true, unauthorizedReason: null };
  const r = dedupeBySymbol([dupA, auth]);
  return r.length === 1 && r[0].authorized === true;
})());
// A screen saying both long and short about one asset is a contradiction, not
// evidence for a side.
check('contradictory authorized directions abstain on both', (() => {
  const long = { ...dupA, authorized: true, side: 'BUY', unauthorizedReason: null };
  const short = { ...dupA, authorized: true, side: 'SELL', unauthorizedReason: null };
  const r = dedupeBySymbol([long, short]);
  return r.length === 1 && r[0].authorized === false && r[0].unauthorizedReason.includes('contradictory');
})());
check('two sources for one symbol cannot produce two execution candidates', (() => {
  const research = { ...dupA, source: 'research-confirmed' };
  return dedupeBySymbol([dupA, research]).length === 1;
})());
check('buildCandidates emits one row per symbol even when a symbol is on two boards', (() => {
  const row = authorizedRow();
  const both = buildCandidates({
    classSkill: provenClass, holdingEvidence: evidence,
    crypto: { breakout: [row], breakdown: [{ ...row }] }
  }, null);
  return both.filter((c) => c.signalSymbol === 'SOL').length === 1;
})());

console.log('\n== execution identity and live-mode parsing ==');
const entryId = makeClientOrderId('entry', 'SOLUSDT', 'BUY', '2026-09-08T12:00:00Z');
check('the same futures intent always produces the same client ID',
  entryId === makeClientOrderId('entry', 'SOLUSDT', 'BUY', '2026-09-08T12:00:00Z'));
check('a different futures intent produces a different client ID',
  entryId !== makeClientOrderId('entry', 'SOLUSDT', 'SELL', '2026-09-08T12:00:00Z'));
check('futures client IDs fit Binance\'s 36-character limit and alphabet',
  entryId.length <= 36 && /^[.A-Z:/a-z0-9_-]+$/.test(entryId), entryId);
check('strict boolean parsing accepts an explicit false', parseBoolean('DRY_RUN', 'false', true) === false);
check('terminal zero-fill market replacements have a bounded deterministic ID chain', (() => {
  const ids = Array.from({ length: MAX_MARKET_ORDER_GENERATIONS }, (_, generation) =>
    marketClientOrderId(entryId, generation));
  return ids[0] === entryId && new Set(ids).size === ids.length
    && ids.every((id) => id.length <= 36 && /^[.A-Z:/a-z0-9_-]+$/.test(id));
})());
check('strict boolean parsing rejects ambiguous live-mode text', (() => {
  try { parseBoolean('DRY_RUN', 'False', true); return false; } catch { return true; }
})());
const filledEntry = {
  symbol: 'SOLUSDT', side: 'BUY', type: 'MARKET', clientOrderId: entryId,
  status: 'FILLED', executedQty: '1.25'
};
check('only the exact positively-executed market intent is accepted',
  executedMarketOrder(filledEntry, { symbol: 'SOLUSDT', side: 'BUY', clientOrderId: entryId }));
check('a zero-fill historical order cannot claim a live position',
  !executedMarketOrder({ ...filledEntry, status: 'CANCELED', executedQty: '0' },
    { symbol: 'SOLUSDT', side: 'BUY', clientOrderId: entryId }));
check('a positive but nonterminal partial fill is retained as pending, not settled',
  !executedMarketOrder({ ...filledEntry, status: 'PARTIALLY_FILLED', executedQty: '0.5' },
    { symbol: 'SOLUSDT', side: 'BUY', clientOrderId: entryId }));
check('a mismatched market order cannot claim a live position',
  !executedMarketOrder({ ...filledEntry, side: 'SELL' },
    { symbol: 'SOLUSDT', side: 'BUY', clientOrderId: entryId }));
check('documented Binance timeout codes remain ambiguous even on HTTP 4xx',
  isExecutionOutcomeUnknown({ httpStatus: 400, binanceCode: -1007 }));
check('an ordinary malformed-request 4xx is a definite rejection',
  !isExecutionOutcomeUnknown({ httpStatus: 400, binanceCode: -1102 }));
const historyWindows = boundedHistoryWindows(0, 15 * 24 * 60 * 60 * 1000);
check('account-history reads cover long holds with non-overlapping Binance-safe windows',
  historyWindows.length === 3
    && historyWindows[0].startTime === 0
    && historyWindows[0].endTime < 7 * 24 * 60 * 60 * 1000
    && historyWindows[1].startTime === historyWindows[0].endTime + 1
    && historyWindows.at(-1).endTime === 15 * 24 * 60 * 60 * 1000);
const stopBaseId = makeClientOrderId('stop', 'SOLUSDT', entryId, 'BUY');
check('protection replacement IDs are deterministic and distinct',
  protectionClientOrderId(stopBaseId, 1) === protectionClientOrderId(stopBaseId, 1)
    && protectionClientOrderId(stopBaseId, 1) !== stopBaseId);
check('the full deterministic protection chain stays within Binance ID rules', (() => {
  const ids = protectionClientOrderIds(stopBaseId);
  return ids.length === MAX_PROTECTION_GENERATIONS && new Set(ids).size === ids.length
    && ids.every((id) => id.length <= 36 && /^[.A-Z:/a-z0-9_-]+$/.test(id));
})());
const activeStop = {
  symbol: 'SOLUSDT', side: 'SELL', orderType: 'STOP_MARKET',
  closePosition: false, reduceOnly: true, quantity: '2',
  workingType: 'MARK_PRICE', triggerPrice: '95',
  clientAlgoId: stopBaseId, algoStatus: 'NEW'
};
check('NEW and trigger-in-flight algo orders count as active protection',
  isActiveAlgoOrder(activeStop)
  && isActiveAlgoOrder({ ...activeStop, algoStatus: 'TRIGGERING' })
  && isActiveAlgoOrder({ ...activeStop, algoStatus: 'TRIGGERED' })
  && !isActiveAlgoOrder({ ...activeStop, algoStatus: 'FINISHED' }));
check('only never-triggered terminal algo states are automatically replaceable',
  algoOrderDisposition({ ...activeStop, algoStatus: 'CANCELED' }) === 'replaceable'
  && algoOrderDisposition({ ...activeStop, algoStatus: 'EXPIRED' }) === 'replaceable'
  && algoOrderDisposition({ ...activeStop, algoStatus: 'REJECTED' }) === 'replaceable'
  && algoOrderDisposition({ ...activeStop, algoStatus: 'FINISHED' }) === 'finished'
  && algoOrderDisposition({ ...activeStop, algoStatus: 'TRIGGERED' }) === 'pending'
  && algoOrderDisposition({ ...activeStop, algoStatus: 'NOT_A_REAL_STATE' }) === 'unknown');
check('protective reconciliation requires the exact stop intent',
  protectiveOrderMatches(activeStop, {
    symbol: 'SOLUSDT', side: 'SELL', type: 'STOP_MARKET',
    triggerPrice: 95, quantity: 2, clientAlgoId: stopBaseId
  }) && !protectiveOrderMatches({ ...activeStop, workingType: 'CONTRACT_PRICE' }, {
    symbol: 'SOLUSDT', side: 'SELL', type: 'STOP_MARKET',
    triggerPrice: 95, quantity: 2, clientAlgoId: stopBaseId
  }) && !protectiveOrderMatches({ ...activeStop, quantity: '3' }, {
    symbol: 'SOLUSDT', side: 'SELL', type: 'STOP_MARKET',
    triggerPrice: 95, quantity: 2, clientAlgoId: stopBaseId
  }) && !protectiveOrderMatches({ ...activeStop, reduceOnly: false }, {
    symbol: 'SOLUSDT', side: 'SELL', type: 'STOP_MARKET',
    triggerPrice: 95, quantity: 2, clientAlgoId: stopBaseId
  }));
check('market intent matching includes quantity and reduce-only semantics',
  marketOrderMatches({ ...filledEntry, origQty: '2', reduceOnly: false }, {
    symbol: 'SOLUSDT', side: 'BUY', quantity: 2,
    clientOrderId: entryId, reduceOnly: false
  }) && !marketOrderMatches({ ...filledEntry, origQty: '2', reduceOnly: true }, {
    symbol: 'SOLUSDT', side: 'BUY', quantity: 2,
    clientOrderId: entryId, reduceOnly: false
  }));
const limitEntry = {
  symbol: 'SOLUSDT', side: 'BUY', type: 'LIMIT', timeInForce: 'GTD',
  clientOrderId: entryId, origQty: '2', price: '95',
  goodTillDate: 1_757_073_600_000, status: 'NEW', executedQty: '0'
};
check('resting entry identity freezes side, quantity, price and GTD expiry',
  limitOrderMatches(limitEntry, {
    symbol: 'SOLUSDT', side: 'BUY', quantity: 2, price: 95,
    clientOrderId: entryId, goodTillDate: 1_757_073_600_999
  }) && !limitOrderMatches({ ...limitEntry, price: '95.01' }, {
    symbol: 'SOLUSDT', side: 'BUY', quantity: 2, price: 95,
    clientOrderId: entryId, goodTillDate: 1_757_073_600_999
  }));
const frozenIntent = {
  clientOrderId: 'fcsf-entry-deadbeef', mode: 'live', expiresAt: '2026-09-05T19:00:00.000Z',
  assetClass: 'crypto', symbol: 'SOLUSDT', signalSymbol: 'SOL', side: 'BUY',
  source: 'confluence-v7', signalGeneratedAt: '2026-09-05T12:00:00Z',
  signalPriceAt: '2026-09-05T12:00:00Z', signalPrice: 100, limitPrice: 94,
  offsetPct: 6, offsetBasis: 'wrong-call mean adverse excursion',
  positionPct: 0.1, leverage: 8, requestedQty: 1.25, stopPrice: 93,
  targetPrice: 104, timeExitAfterMs: 3600000, horizonHours: 24
};
const frozenIntentRow = {
  client_order_id: frozenIntent.clientOrderId, mode: frozenIntent.mode,
  expires_at: frozenIntent.expiresAt, asset_class: frozenIntent.assetClass,
  symbol: frozenIntent.symbol, signal_symbol: frozenIntent.signalSymbol,
  side: frozenIntent.side, source: frozenIntent.source,
  signal_generated_at: frozenIntent.signalGeneratedAt,
  signal_price_at: frozenIntent.signalPriceAt, signal_price: frozenIntent.signalPrice,
  limit_price: frozenIntent.limitPrice, offset_pct: frozenIntent.offsetPct,
  offset_basis: frozenIntent.offsetBasis, position_pct: frozenIntent.positionPct,
  leverage: frozenIntent.leverage, requested_qty: frozenIntent.requestedQty,
  stop_price: frozenIntent.stopPrice, target_price: frozenIntent.targetPrice,
  time_exit_after_ms: frozenIntent.timeExitAfterMs, horizon_hours: frozenIntent.horizonHours
};
check('a durable intent can only be reused with identical frozen execution geometry',
  entryIntentMatches(frozenIntentRow, frozenIntent)
    && !entryIntentMatches({ ...frozenIntentRow, requested_qty: 2 }, frozenIntent)
    && entryIntentMatches({
      ...frozenIntentRow, signal_generated_at: 'later payload publication'
    }, frozenIntent));

const cryptoMarket = {
  status: 'TRADING', contractType: 'PERPETUAL', baseAsset: 'SOL',
  quoteAsset: 'USDT', marginAsset: 'USDT', underlyingType: 'COIN',
  underlyingSubType: [], permissionSets: [],
  orderTypes: ['LIMIT', 'MARKET'], timeInForce: ['GTC', 'GTD']
};
const stockMarket = {
  ...cryptoMarket, contractType: 'TRADIFI_PERPETUAL', baseAsset: 'NVDA',
  underlyingType: 'EQUITY', underlyingSubType: ['TradFi']
};
check('market identity requires exact class and bare symbol metadata',
  marketEligibleForAssetClass(cryptoMarket, 'crypto', 'SOL')
    && !marketEligibleForAssetClass(cryptoMarket, 'stock', 'SOL')
    && !marketEligibleForAssetClass(cryptoMarket, 'crypto', 'S')
    && marketEligibleForAssetClass(stockMarket, 'stock', 'NVDA')
    && !marketEligibleForAssetClass(stockMarket, 'crypto', 'NVDA'));
check('TradFi ticker coincidence without exchange class evidence is withheld',
  !marketEligibleForAssetClass({ ...stockMarket, underlyingSubType: [] }, 'stock', 'NVDA')
    && !marketEligibleForAssetClass({ ...stockMarket, timeInForce: ['GTC'] }, 'stock', 'NVDA')
    && !marketEligibleForAssetClass({ ...stockMarket, timeInForce: [] }, 'stock', 'NVDA')
    && !marketEligibleForAssetClass({ ...stockMarket, orderTypes: [] }, 'stock', 'NVDA'));

const exactOutcomeRecord = { side: 'BUY', entryExecutedQty: 2 };
const exactOutcomeFills = [
  { orderId: 10, side: 'BUY', qty: '2', price: '95', realizedPnl: '0', commission: '0.04', commissionAsset: 'USDT', marginAsset: 'USDT' },
  { orderId: 11, side: 'SELL', qty: '0.75', price: '105', realizedPnl: '7.5', commission: '0.02', commissionAsset: 'USDT', marginAsset: 'USDT' },
  { orderId: 12, side: 'SELL', qty: '1.25', price: '104', realizedPnl: '11.25', commission: '0.03', commissionAsset: 'USDT', marginAsset: 'USDT' }
];
check('outcome reconstruction uses exact entry and quantity-balanced closing fills', (() => {
  const summary = summarizeExactRoundTrip(exactOutcomeRecord, exactOutcomeFills, 10);
  return summary.quantity === 2 && Math.abs(summary.exitPrice - 104.375) < 1e-9
    && summary.realizedPnl === 18.75 && Math.abs(summary.commission + 0.09) < 1e-9;
})());
check('outcome reconstruction rejects interleaved personal or incomplete fills', (() => {
  try {
    summarizeExactRoundTrip(exactOutcomeRecord, [
      ...exactOutcomeFills,
      { ...exactOutcomeFills[0], orderId: 99, qty: '0.1' }
    ], 10);
    return false;
  } catch {}
  try {
    summarizeExactRoundTrip(exactOutcomeRecord, exactOutcomeFills.slice(0, 2), 10);
    return false;
  } catch { return true; }
})());
check('outcome reconstruction refuses missing P&L or fee fields instead of treating them as zero', (() => {
  for (const field of ['realizedPnl', 'commission']) {
    try {
      summarizeExactRoundTrip(exactOutcomeRecord, exactOutcomeFills.map((fill, index) =>
        index === 1 ? { ...fill, [field]: null } : fill), 10);
      return false;
    } catch {}
  }
  return true;
})());
const reachabilityRow = {
  side: 'BUY', signal_price_at: '2026-09-05T00:00:00Z',
  expires_at: '2026-09-05T06:00:00Z', signal_price: 100, limit_price: 95,
  observation_count: 6, first_bar_at: '2026-09-05T00:00:00Z',
  last_bar_at: '2026-09-05T05:00:00Z', observed_low: 96, observed_high: 104
};
check('hourly research can prove a limit touch without pretending it executed',
  assessLimitReachability({ ...reachabilityRow, observed_low: 94 }).decision === 'touched');
check('an untouched limit expires only with adequate window coverage',
  assessLimitReachability(reachabilityRow).decision === 'expired'
    && assessLimitReachability({
      ...reachabilityRow, observation_count: 1,
      last_bar_at: '2026-09-05T00:00:00Z'
    }).decision === 'awaiting-bars');

const leaseEnv = {
  CLOUDFLARE_API_TOKEN: 'test', CLOUDFLARE_ACCOUNT_ID: 'test', FCS_D1_DATABASE_ID: 'test'
};
const lease = await acquireExecutionLease(leaseEnv, 'test-cycle', 60,
  async (_env, _sql, params) => [{ owner: params[1], expires_at: 123 }]);
check('execution lease accepts only the owner returned by atomic D1 compare-and-swap',
  lease?.name === 'test-cycle' && lease?.expiresAtSeconds === 123);
check('execution lease contention returns no lease',
  await acquireExecutionLease(leaseEnv, 'test-cycle', 60, async () => []) === null);
check('execution lease release is owner-qualified',
  await releaseExecutionLease(leaseEnv, lease,
    async (_env, _sql, params) => [{ owner: params[1] }]) === true);

console.log('\n== positions.mjs: the operator\'s trades are not the bot\'s to manage ==');
check('a position the bot recorded opening is its own',
  positionOrigin('SOLUSDT', { openOrders: { SOLUSDT: {
    side: 'BUY', entryExecutedQty: 2, entryClientOrderId: entryId,
    ownershipVerified: true
  } } }, 'BUY', 2) === 'bot');
check('an opposite live side is an ownership conflict, not a bot position',
  positionOrigin('SOLUSDT', { openOrders: { SOLUSDT: { side: 'BUY', entryExecutedQty: 2, entryClientOrderId: entryId, ownershipVerified: true } } }, 'SELL', -2) === 'conflict');
check('a same-side operator addition is an ownership conflict',
  positionOrigin('SOLUSDT', { openOrders: { SOLUSDT: { side: 'BUY', entryExecutedQty: 2, entryClientOrderId: entryId, ownershipVerified: true } } }, 'BUY', 2.5) === 'conflict');
check('a same-side external partial close is an ownership conflict',
  positionOrigin('SOLUSDT', { openOrders: { SOLUSDT: { side: 'BUY', entryExecutedQty: 2, entryClientOrderId: entryId, ownershipVerified: true } } }, 'BUY', 1.5) === 'conflict');
check('tiny decimal serialization noise does not create a false conflict',
  positionQuantitiesMatch(2, 2 + 1e-10));
check('legacy/incomplete ownership records fail closed as conflicts',
  positionOrigin('SOLUSDT', { openOrders: { SOLUSDT: { side: 'BUY' } } }, 'BUY', 2.5) === 'conflict');
check('a persisted intent without a verified fill cannot claim a personal position',
  positionOrigin('SOLUSDT', { openOrders: { SOLUSDT: {
    side: 'BUY', entryExecutedQty: 0, entryClientOrderId: entryId,
    ownershipVerified: false
  } } }, 'BUY', 2) === 'conflict');
check('a position the bot has no record of is the operator\'s',
  positionOrigin('TRXUSDT', { openOrders: {} }) === 'manual');
// If state were lost, the bot's own positions read as foreign and stop being
// managed. That is the safe direction to fail: it withholds action rather than
// placing an order on a trade nobody asked it to touch.
check('lost state fails toward withholding, not toward acting',
  positionOrigin('SOLUSDT', {}) === 'manual');

check('liquidation distance for a long is measured downward',
  Math.abs(distanceToLiquidationPct(100, 80, 'BUY') - 20) < 1e-9);
check('liquidation distance for a short is measured upward',
  Math.abs(distanceToLiquidationPct(100, 120, 'SELL') - 20) < 1e-9);
check('a missing liquidation price yields null, not a false sense of safety',
  distanceToLiquidationPct(100, 0, 'BUY') === null);

const calm = { symbol: 'TRXUSDT', side: 'BUY', markPrice: 100, liquidationPrice: 50, unrealizedPnl: -1, equity: 100 };
check('a healthy foreign position is left entirely alone', assessRisk(calm).severity === 'none');
check('approaching liquidation raises a warning',
  assessRisk({ ...calm, liquidationPrice: 80 }).severity === 'warning');
check('close to liquidation is extreme',
  assessRisk({ ...calm, liquidationPrice: 92 }).severity === 'extreme');
// The second, independent reading: bleeding badly while nowhere near
// liquidation. Both must be able to fire on their own.
check('a large unrealized loss is extreme even far from liquidation', (() => {
  const r = assessRisk({ ...calm, unrealizedPnl: -40, equity: 100 });
  return r.severity === 'extreme' && r.metrics.distanceToLiquidationPct === 50;
})());
check('a moderate unrealized loss is a warning', assessRisk({ ...calm, unrealizedPnl: -22 }).severity === 'warning');
check('the assessment always carries the numbers behind it',
  assessRisk({ ...calm, liquidationPrice: 92 }).reason.includes('liquidation'));
check('an unknown equity does not manufacture a loss reading',
  assessRisk({ ...calm, equity: 0 }).metrics.unrealizedVsEquityPct === null);

check('manual-position stop configuration has been removed rather than merely defaulted off',
  !Object.hasOwn(config, 'emergencyStopForeign') && !Object.hasOwn(config, 'emergencyStopFraction'));
check('bot and retired-assisted client namespaces are recognized exactly',
  isFuturesBotOrderId(entryId) && !isFuturesBotOrderId('personal-order')
    && isLegacyAssistedProtectionId('fcsa-abc') && !isLegacyAssistedProtectionId(entryId));

console.log('\n== active-limit policy and bot-attributable loss accounting ==');
const screen = {
  ...withheld, side: null, screenSide: 'BUY', screenAgree: 4, screenTotal: 6,
  dataQuality: 'model-ready', abstentionReason: 'insufficient-evidence'
};
const experiment = activePolicyCandidate(screen);
check('experimental setup has an explicit side but never invents forecast confidence or horizon',
  experiment.source === ACTIVE_LIMIT_SOURCE && experiment.side === 'BUY'
    && experiment.authorized === false && experiment.confidence === null
    && experiment.edge === null && experiment.horizonHours === null && experiment.range === null);
check('experimental defaults stay observation-only until the operator enables live policy',
  !activeExecutionEligible(experiment) && evaluateCandidate(experiment, baseCtx).action === 'SHADOW');
check('a withheld direction no longer defaults to a BUY', (() => {
  const row = { ...authorizedRow(), dir: 0, horizon: null, range: null, confidence: null };
  const [c] = buildCandidates({ crypto: { breakout: [row] } }, null);
  return c.side === null && evaluateCandidate(c, baseCtx).action === 'SKIP';
})());
check('missing history, bad data, no-edge, sparse votes and split votes cannot qualify a policy setup',
  [
    { dailyMoveSamples: 0 }, { dataQuality: 'cadence-mismatch' },
    { abstentionReason: 'no-edge' }, { screenAgree: 2 },
    { screenAgree: 3, screenTotal: 6 }, { screenSide: null }
  ].every(change => activePolicyCandidate({ ...screen, ...change }).source !== ACTIVE_LIMIT_SOURCE));
check('uncalibrated setups get wider volatility-sensitive offsets without a confidence reduction', (() => {
  const calm = entryOffsetPlan(experiment);
  const volatile = entryOffsetPlan({ ...experiment, currentMovePct: 12, edge: 1 });
  return calm.offsetPct === 7.5 && volatile.offsetPct === 10
    && calm.confidenceReductionPct === 0 && volatile.confidenceReductionPct === 0;
})());
check('policy exits follow the actual fill for both sides, with a frozen one-day clock', (() => {
  const long = activeExitGeometry('BUY', 90, experiment.activePolicy);
  const short = activeExitGeometry('SELL', 110, experiment.activePolicy);
  return Math.abs(long.stop - 88.2) < 1e-9 && Math.abs(long.target - 111.6) < 1e-9
    && Math.abs(short.stop - 112.2) < 1e-9 && Math.abs(short.target - 83.6) < 1e-9
    && long.timeExit === 86_400_000
    && activeExitGeometry('BUY', 90, null) === null;
})());
check('policy orders expire from the immutable reference, not a moving cycle clock',
  entryOrderExpiryMs(experiment) === Date.parse(experiment.signalPriceAt) + 86_400_000);
check('opposite policy setups for the same symbol abstain even during shadow collection', (() => {
  const conflict = dedupeBySymbol([experiment, { ...experiment, side: 'SELL' }]);
  return conflict.length === 1 && conflict[0].source === 'conflict'
    && evaluateCandidate(conflict[0], baseCtx).action === 'SKIP';
})());

const cleanSummary = { netPnl: 0, peakNetPnl: 0, dailyNetPnl: 0, incomplete: 0 };
const flatAccount = {
  totalMarginBalance: '100', totalMaintMargin: '0', availableBalance: '100',
  totalPositionInitialMargin: '0', totalOpenOrderInitialMargin: '0', positions: []
};
const flatState = { ...baseCtx.state, peakEquity: 1000, openOrders: {} };
check('personal-account drawdown and withdrawals do not become bot losses',
  assessBotEntryRisk(cleanSummary, flatAccount, flatState).ok
    && assessBotEntryRisk(cleanSummary, { ...flatAccount, totalMarginBalance: '20' }, flatState).ok);
check('actual settled bot drawdown and daily losses still block entries',
  !assessBotEntryRisk({ ...cleanSummary, netPnl: -20 }, { ...flatAccount, totalMarginBalance: '80' }, flatState).ok
    && !assessBotEntryRisk({ ...cleanSummary, netPnl: -10, dailyNetPnl: -10 }, { ...flatAccount, totalMarginBalance: '90' }, flatState).ok);
const ownedState = { ...flatState, openOrders: { SOLUSDT: {
  ownershipVerified: true, entryClientOrderId: 'fcsf-test', entryExecutedQty: 1, side: 'BUY'
} } };
const ownedAccount = { ...flatAccount, positions: [
  { symbol: 'SOLUSDT', positionAmt: '1', unrealizedProfit: '-25' },
  { symbol: 'PEPEUSDT', positionAmt: '20', unrealizedProfit: '-500' }
] };
check('only exactly owned open-position losses enter bot risk', (() => {
  const risk = assessBotEntryRisk(cleanSummary, ownedAccount, ownedState);
  return !risk.ok && risk.openLoss === 25;
})());
check('mixed positions, pending outcomes and missing ledger values cannot clear risk',
  !assessBotEntryRisk(cleanSummary, { ...ownedAccount, positions: [{ ...ownedAccount.positions[0], positionAmt: '2' }] }, ownedState).ok
    && !assessBotEntryRisk(cleanSummary, flatAccount, { ...ownedState, openOrders: { SOLUSDT: { outcomePending: true } } }).ok
    && !assessBotEntryRisk({ ...cleanSummary, netPnl: null }, flatAccount, flatState).ok
    && !assessBotEntryRisk({ ...cleanSummary, incomplete: 1 }, flatAccount, flatState).ok);
check('current maintenance pressure and personal resting orders still constrain account capacity',
  !assessBotEntryRisk(cleanSummary, { ...flatAccount, totalMaintMargin: '50' }, flatState).ok
    && entryCapitalIssue({ ...flatAccount, totalOpenOrderInitialMargin: '48' }, 0.05) != null
    && entryCapitalIssue({ ...flatAccount, availableBalance: '4' }, 0.05) != null
    && entryCapitalIssue(flatAccount, 0.05) === null);

const riskDb = new DatabaseSync(':memory:');
riskDb.exec('CREATE TABLE trading_bot_trades (id INTEGER PRIMARY KEY, origin TEXT, closed_at TEXT, net_pnl REAL)');
const riskQuery = async (_env, sql, params) => riskDb.prepare(sql).all(...params);
const riskDate = '2026-09-10T12:00:00.000Z';
check('empty bot ledger has zero observed losses',
  (await loadBotLossSummary(riskDate, riskQuery)).netPnl === 0);
for (const [id, origin, at, pnl] of [
  [1, 'bot', '2026-09-08T01:00:00.000Z', 30],
  [2, 'bot', '2026-09-09T01:00:00.000Z', -40],
  [3, 'bot', '2026-09-10T01:00:00.000Z', 5],
  [4, 'manual', '2026-09-10T02:00:00.000Z', -1000],
  [5, 'bot', '2026-09-11T01:00:00.000Z', 999]
]) riskDb.prepare('INSERT INTO trading_bot_trades VALUES (?,?,?,?)').run(id, origin, at, pnl);
const historicalRisk = await loadBotLossSummary(riskDate, riskQuery);
check('real SQL reconstructs realized peaks and UTC daily P&L without manual or future rows',
  historicalRisk.netPnl === -5 && historicalRisk.peakNetPnl === 30
    && historicalRisk.dailyNetPnl === 5 && historicalRisk.closedCount === 3);
riskDb.prepare('INSERT INTO trading_bot_trades VALUES (6,?,?,NULL)').run('bot', '2026-09-10T02:00:00.000Z');
check('a missing settled outcome stays incomplete instead of becoming zero profit',
  (await loadBotLossSummary(riskDate, riskQuery)).incomplete === 1);
riskDb.close();

config.activeLimitMode = true;
try {
  const riskCtx = { ...baseCtx, equity: 100, state: flatState, botRisk: assessBotEntryRisk(cleanSummary, flatAccount, flatState) };
  check('enabled policy can propose orders during a personal-account drawdown with clear bot risk',
    decideEntries([experiment], riskCtx).decisions[0].action === 'OPEN');
  check('policy orders use floor margin and modestly higher leverage',
    sizePosition(experiment, true).positionPct === config.minPositionPct
      && sizePosition(experiment, true).leverage === 5);
  check('new mode does not blindly turn all withheld rows into orders',
    decideEntries([withheld], riskCtx).decisions[0].action === 'SHADOW');
  check('missing or failed bot accounting still blocks every executable candidate',
    [undefined, { ok: false, reason: 'loss limit' }].every(botRisk =>
      decideEntries([experiment, authorizedCandidate], { ...riskCtx, botRisk }).decisions.every(d => d.action === 'SKIP')));
  check('many active-limit proposals reserve margin across the full candidate list', (() => {
    const candidates = Array.from({ length: 15 }, (_, i) => ({ ...experiment, symbol: `A${i}USDT` }));
    const decisions = decideEntries(candidates, riskCtx).decisions;
    return decisions.filter(d => d.action === 'OPEN').length === 10
      && decisions.filter(d => d.action === 'SKIP').length === 5;
  })());
} finally { config.activeLimitMode = false; }

console.log('\n== return-on-margin policy and staged-exit recovery ==');
const policyNow = Date.now();
const midnight = Math.floor(policyNow / 86_400_000) * 86_400_000;
const rangeBars = Array.from({ length: 30 }, (_, i) => {
  const at = midnight - (30 - i) * 86_400_000;
  return [at, '100', '101', '99', '100', '10', at + 86_399_999];
});
check('daily trading range measures high-low, not the zero close return',
  dailyRangeStats(rangeBars, policyNow)?.meanPct === 2);
check('thin, duplicated, stale and malformed daily candles cannot raise leverage',
  dailyRangeStats(rangeBars.slice(1), policyNow) === null
    && dailyRangeStats([...rangeBars.slice(0, 29), rangeBars[28]], policyNow) === null
    && dailyRangeStats(rangeBars, policyNow + 86_400_000) === null
    && dailyRangeStats(rangeBars.map((b, i) => i ? b : [b[0], 100, 90, 99, 100, 1, b[6]]), policyNow) === null);
check('leverage requires BOTH stable ranges and proven reliability',
  leveragePlan({ ...stableProven, edge: 0.35 }).leverage === 20
    && leveragePlan({ ...stableProven, edge: 0.35, authorized: false }).leverage === 5
    && leveragePlan({ ...stableProven, edge: 0.35, tradingRange: null }).leverage === 5
    && leveragePlan({ ...stableProven, edge: 0.35, currentMovePct: 12 }).leverage === 5);
const roiPolicy = baselineExitPolicy({ ...stableProven, edge: 0.35 }, 10);
const geometry = roiExitGeometry('BUY', 100, roiPolicy);
check('60/120 percent margin targets become 6/12 percent prices at 10x',
  Math.abs(geometry.firstTarget - 106) < 1e-9 && Math.abs(geometry.target - 112) < 1e-9
    && roiPolicy.stopRoiPct >= 10 && roiPolicy.stopRoiPct <= 30);
check('partial-exit outcomes retain the ORIGINAL filled quantity',
  summarizeExactRoundTrip({ ...exactOutcomeRecord, entryOriginalQty: exactOutcomeRecord.entryExecutedQty,
    entryExecutedQty: exactOutcomeRecord.entryExecutedQty / 2 }, exactOutcomeFills, 10).quantity === exactOutcomeRecord.entryExecutedQty);
const managedRecord = () => ({ side: 'BUY', symbol: 'SOLUSDT', assetClass: 'crypto',
  entryPrice: 100, entryExecutedQty: 10, entryOriginalQty: 10,
  entryClientOrderId: 'fcsf-owned', ownershipVerified: true,
  roiPolicy, openedAt: new Date(policyNow - 60_000).toISOString(), timeExitAfterMs: 86_400_000 });
check('only fresh authorized opposite signals trigger a reversal exit', (() => {
  const r = { symbol: 'SOLUSDT', assetClass: 'crypto', side: 'SELL', authorized: true,
    signalPriceAt: new Date(policyNow - 1000).toISOString() };
  return managedExitReason(managedRecord(), 100, policyNow, r) === 'verified-reversal'
    && managedExitReason(managedRecord(), 100, policyNow, { ...r, authorized: false }) === null
    && managedExitReason(managedRecord(), 100, policyNow, { ...r, signalPriceAt: '2020-01-01' }) === null;
})());
for (const scenario of ['filled', 'timeout', 'manual', 'save-failed']) {
  const s = { openOrders: { SOLUSDT: managedRecord() } };
  let amount = scenario === 'manual' ? 11 : 10;
  let submissions = 0;
  let storedOrder = null;
  const io = {
    amount: async () => amount, mark: async () => ({ price: 107 }),
    round: async (_s, q) => Math.floor(q * 100) / 100,
    find: async () => storedOrder,
    save: async () => { if (scenario === 'save-failed') throw new Error('D1 unavailable'); },
    log: () => {}, dryRun: false,
    close: async (symbol, side, quantity, opts) => {
      await opts.onBeforeSubmit({ clientOrderId: opts.clientOrderId });
      submissions++;
      amount -= quantity;
      storedOrder = { symbol, side, origQty: quantity, executedQty: quantity,
        clientOrderId: opts.clientOrderId, reduceOnly: true, status: 'FILLED', type: 'MARKET', orderId: 22 };
      if (scenario === 'timeout') throw new Error('response lost');
      return storedOrder;
    }
  };
  try { await managePolicyExits(s, io, { nowMs: policyNow }); } catch (e) {
    if (scenario !== 'save-failed') throw e;
  }
  if (scenario === 'filled' || scenario === 'timeout') {
    await managePolicyExits(s, io, { nowMs: policyNow + 1000 });
    check(`${scenario}: one exact half-close survives retry with original quantity intact`,
      submissions === 1 && amount === 5 && s.openOrders.SOLUSDT.entryExecutedQty === 5
        && s.openOrders.SOLUSDT.entryOriginalQty === 10 && s.openOrders.SOLUSDT.firstProfitComplete);
  } else check(`${scenario}: no managed order is submitted`, submissions === 0);
}

console.log(failures === 0 ? '\nTRADING BOT OK\n' : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
