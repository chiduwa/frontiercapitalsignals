// Plain-Node test suite, no framework — matches signals-worker/test-worker.mjs's
// style. Covers the pure contract/risk/strategy/resolution math only (no live
// Binance calls, no D1).
process.env.BINANCE_API_KEY = 'test';
process.env.BINANCE_API_SECRET = 'test';
process.env.CLOUDFLARE_API_TOKEN = 'test';
process.env.CLOUDFLARE_ACCOUNT_ID = 'test';
process.env.FCS_D1_DATABASE_ID = 'test';

const { config } = await import('./src/config.mjs');
const { ENGINE, authorizeRow, authorizeResearch, classAuthorized, holdingFor, dayRangePosition } = await import('./src/contract.mjs');
const {
  conservativeEdge, sizePosition, currentExposurePct, wouldExceedExposure,
  wouldExceedResearchExposure, circuitBreakerTripped, dailyLossLimitHit, inCooldown,
  fundingUnfavorable, stopLossPrice, stopLossPriceForResearch, takeProfitPrice,
  timeExitAfterMs, patienceUnmet
} = await import('./src/risk.mjs');
const { evaluateCandidate, decideEntries } = await import('./src/strategy.mjs');
const { resolveShadowTrade } = await import('./src/paper.mjs');
const { buildCandidates, toBinanceSymbol, dedupeBySymbol } = await import('./src/signals.mjs');

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
  funding: 0, drivers: []
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
  { assetClass: 'crypto', symbol: 'SOL', dir: 1, horizonHours: 24, n: 41, mfePct: 6, maePct: -2.4, hoursToPeak: 7, peakShare: 0.29, heldPct: 1.2, giveBackPct: 4.8, adverseFirstRate: 0.7, adverseFirstLower: 0.56 }
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
const atFull = sizePosition({ source: 'confluence-v7', edge: config.edgeFullSize }, false);
check('at the full-size edge, sizing/leverage reach the maximum',
  atFull.positionPct === config.maxPositionPct && atFull.leverage === config.maxLeverage, JSON.stringify(atFull));
check('a larger edge never exceeds the hard ceilings', (() => {
  const huge = sizePosition({ source: 'confluence-v7', edge: 5 }, true);
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

console.log('\n== strategy.mjs: an unauthorized row can never become an order ==');
const nowMs = Date.parse('2026-09-05T12:00:00Z');
const baseCtx = {
  fearGreed: 50, openSymbols: new Set(), openPositions: [], balance: 1000, equity: 1000,
  state: { peakEquity: 1000, dayStartEquity: 1000, lastClosedAt: {} }, nowMs
};
const authorizedCandidate = {
  source: 'confluence-v7', signalSymbol: 'SOL', symbol: 'SOLUSDT', side: 'BUY',
  authorized: true, unauthorizedReason: null, rangePos: 0.1, range: { low: 96, high: 108 },
  horizonHours: 24, edge: 0.26, holding: null, dayRangePos: 0.2, funding: 0
};
check('an authorized, in-zone candidate opens', evaluateCandidate(authorizedCandidate, baseCtx).action === 'OPEN');
// THE critical safety property of this whole upgrade.
const withheld = { ...authorizedCandidate, authorized: false, unauthorizedReason: 'engine withheld: insufficient-evidence' };
check('the identical candidate, unauthorized, becomes SHADOW and never OPEN',
  evaluateCandidate(withheld, baseCtx).action === 'SHADOW');
check('the shadow decision carries the engine\'s reason for withholding',
  evaluateCandidate(withheld, baseCtx).reason.includes('insufficient-evidence'));
check('authorization is checked LAST, so a shadow entry still passed every risk gate',
  evaluateCandidate({ ...withheld, rangePos: 0.9 }, baseCtx).action === 'SKIP');
check('already holding this symbol is skipped', evaluateCandidate(authorizedCandidate, { ...baseCtx, openSymbols: new Set(['SOLUSDT']) }).action === 'SKIP');
check('a symbol in cooldown is skipped', evaluateCandidate(authorizedCandidate, {
  ...baseCtx, state: { ...baseCtx.state, lastClosedAt: { SOLUSDT: new Date(nowMs - 60000).toISOString() } }
}).action === 'SKIP');
check('an out-of-zone candidate waits for a better price',
  evaluateCandidate({ ...authorizedCandidate, rangePos: 0.9 }, baseCtx).action === 'SKIP');
check('unfavorable funding is skipped',
  evaluateCandidate({ ...authorizedCandidate, funding: 0.01 }, baseCtx).action === 'SKIP');
check('a research candidate with no range bypasses the range gate rather than being blocked by it',
  evaluateCandidate({
    ...authorizedCandidate, source: 'research-confirmed', rangePos: null, range: null, edge: 0
  }, baseCtx).action === 'OPEN');

// Fear & Greed extreme + reversal, now sourced from the scalp day-range.
const extremeCtx = { ...baseCtx, fearGreed: 12 };
const outOfZone = { ...authorizedCandidate, rangePos: 0.9, dayRangePos: 0.05 };
check('at an extreme with price at the session low, the range gate is substituted',
  evaluateCandidate(outOfZone, extremeCtx).action === 'OPEN');
check('the extreme boost is flagged on that decision',
  evaluateCandidate(outOfZone, extremeCtx).extremeBoost === true);
check('an extreme reading alone, without price at the session extreme, does not substitute',
  evaluateCandidate({ ...outOfZone, dayRangePos: 0.5 }, extremeCtx).action === 'SKIP');
check('greed does not boost a long',
  evaluateCandidate(outOfZone, { ...baseCtx, fearGreed: 95 }).action === 'SKIP');

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
  return r.paused === 'daily_loss_limit';
})());
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
check('the two sources are kept separate, not merged', (() => {
  const research = { ...dupA, source: 'research-confirmed' };
  return dedupeBySymbol([dupA, research]).length === 2;
})());
check('buildCandidates emits one row per symbol even when a symbol is on two boards', (() => {
  const row = authorizedRow();
  const both = buildCandidates({
    classSkill: provenClass, holdingEvidence: evidence,
    crypto: { breakout: [row], breakdown: [{ ...row }] }
  }, null);
  return both.filter((c) => c.signalSymbol === 'SOL').length === 1;
})());

console.log(failures === 0 ? '\nTRADING BOT OK\n' : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
