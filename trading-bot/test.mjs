// Plain-Node test suite, no framework — matches signals-worker/test-worker.mjs's
// style. Covers the pure risk/strategy math only (no live Binance calls).
process.env.BINANCE_API_KEY = 'test';
process.env.BINANCE_API_SECRET = 'test';
process.env.CLOUDFLARE_API_TOKEN = 'test';
process.env.CLOUDFLARE_ACCOUNT_ID = 'test';
process.env.FCS_D1_DATABASE_ID = 'test';

const { config } = await import('./src/config.mjs');
const { combinedConfidence, sizePosition, currentExposurePct, wouldExceedExposure, circuitBreakerTripped, dailyLossLimitHit, inCooldown, fundingUnfavorable, stopLossPrice, takeProfitPrice } = await import('./src/risk.mjs');
const { evaluateCandidate, decideEntries } = await import('./src/strategy.mjs');

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`  PASS  ${name}`); }
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`); }
}

console.log('== risk.mjs ==');
check('combinedConfidence takes the min, not the average', combinedConfidence({ confidenceRatio: 0.9, topIndicatorAccuracy: 0.5 }) === 0.5);

const lowConf = sizePosition({ confidenceRatio: config.minConfidenceRatio, topIndicatorAccuracy: config.minConfidenceRatio }, false);
check('at the confidence floor, sizing/leverage hit the minimum', lowConf.positionPct === config.minPositionPct && lowConf.leverage === config.minLeverage, JSON.stringify(lowConf));
const highConf = sizePosition({ confidenceRatio: 1, topIndicatorAccuracy: 1 }, false);
check('at full confidence, sizing/leverage hit the maximum', highConf.positionPct === config.maxPositionPct && highConf.leverage === config.maxLeverage, JSON.stringify(highConf));
const boosted = sizePosition({ confidenceRatio: 1, topIndicatorAccuracy: 1 }, true);
check('extreme boost never pushes past the hard ceiling even at full confidence', boosted.positionPct === config.maxPositionPct && boosted.leverage === config.maxLeverage, JSON.stringify(boosted));
const boostedFromMid = sizePosition({ confidenceRatio: 0.7, topIndicatorAccuracy: 0.7 }, true);
const unboostedFromMid = sizePosition({ confidenceRatio: 0.7, topIndicatorAccuracy: 0.7 }, false);
check('extreme boost increases sizing relative to the same confidence unboosted', boostedFromMid.positionPct > unboostedFromMid.positionPct, JSON.stringify({ boostedFromMid, unboostedFromMid }));

check('exposure: two 20%-margin/3x positions = 40% of balance committed', Math.abs(currentExposurePct([{ notional: 6000, leverage: 3 }, { notional: 6000, leverage: 3 }], 10000) - 0.4) < 1e-9);
check('exposure: empty book is 0%', currentExposurePct([], 10000) === 0);
check('exposure: unknown balance fails safe to fully-exposed, not zero-risk', currentExposurePct([], 0) === 1);
check('wouldExceedExposure: a new position that would push past the 50% cap is rejected', wouldExceedExposure([{ notional: 12000, leverage: 3 }], 10000, 0.15) === true, `current=${currentExposurePct([{ notional: 12000, leverage: 3 }], 10000)}`);
check('wouldExceedExposure: room remaining is accepted', wouldExceedExposure([], 10000, 0.20) === false);

check('circuit breaker: no peak recorded yet never trips', circuitBreakerTripped({ peakEquity: null }, 5000) === false);
check('circuit breaker: exactly at the drawdown threshold trips', circuitBreakerTripped({ peakEquity: 10000 }, 10000 * (1 - config.circuitBreakerDrawdownPct)) === true);
check('circuit breaker: comfortably above the threshold does not trip', circuitBreakerTripped({ peakEquity: 10000 }, 9500) === false);

check('daily loss limit: hit when today\'s loss reaches the cap', dailyLossLimitHit({ dayStartEquity: 10000 }, 10000 * (1 - config.dailyLossLimitPct)) === true);
check('daily loss limit: not hit on a green day', dailyLossLimitHit({ dayStartEquity: 10000 }, 10500) === false);

const nowMs = Date.parse('2026-01-01T12:00:00Z');
check('cooldown: active right after a close', inCooldown({ lastClosedAt: { BTCUSDT: '2026-01-01T11:50:00Z' } }, 'BTCUSDT', nowMs) === true);
check('cooldown: expired well after the window', inCooldown({ lastClosedAt: { BTCUSDT: '2026-01-01T09:00:00Z' } }, 'BTCUSDT', nowMs) === false);
check('cooldown: a symbol never closed before is never in cooldown', inCooldown({ lastClosedAt: {} }, 'ETHUSDT', nowMs) === false);

check('funding unfavorable for a long when strongly positive', fundingUnfavorable('BUY', config.maxFundingRateAbs + 0.0001) === true);
check('funding fine for a long when negative (longs get PAID)', fundingUnfavorable('BUY', -0.005) === false);
check('funding unfavorable for a short when strongly negative', fundingUnfavorable('SELL', -config.maxFundingRateAbs - 0.0001) === true);

check('stop-loss below entry for a long', stopLossPrice(100, 'BUY', 10) < 100);
check('stop-loss above entry for a short', stopLossPrice(100, 'SELL', 10) > 100);
check('higher leverage means a TIGHTER stop (same margin-at-risk, less price room)', (100 - stopLossPrice(100, 'BUY', 20)) < (100 - stopLossPrice(100, 'BUY', 5)));
check('take-profit for a long targets the range high', takeProfitPrice('BUY', { low: 90, high: 110 }) === 110);
check('take-profit for a short targets the range low', takeProfitPrice('SELL', { low: 90, high: 110 }) === 90);

console.log('\n== strategy.mjs ==');
const baseCtx = { fearGreed: 50, openSymbols: new Set(), openPositions: [], balance: 10000, state: { lastClosedAt: {} }, nowMs };
const strongBuy = { symbol: 'BTCUSDT', side: 'BUY', rangePos: 0.1, range: { low: 90, high: 110 }, confidenceRatio: 0.8, topIndicatorAccuracy: 0.8, funding: 0, reversalFlag: false };

check('a strong candidate in the low range zone opens', evaluateCandidate(strongBuy, baseCtx).action === 'OPEN', JSON.stringify(evaluateCandidate(strongBuy, baseCtx)));
check('the same candidate NOT in the entry zone is skipped for patience, not confidence', evaluateCandidate({ ...strongBuy, rangePos: 0.5 }, baseCtx).action === 'SKIP');
check('low confidence is skipped even in the entry zone', evaluateCandidate({ ...strongBuy, confidenceRatio: 0.1 }, baseCtx).action === 'SKIP');
check('already holding this symbol is skipped', evaluateCandidate(strongBuy, { ...baseCtx, openSymbols: new Set(['BTCUSDT']) }).action === 'SKIP');
check('a symbol in cooldown is skipped', evaluateCandidate(strongBuy, { ...baseCtx, state: { lastClosedAt: { BTCUSDT: new Date(nowMs - 60000).toISOString() } } }).action === 'SKIP');
check('unfavorable funding is skipped even with a good setup otherwise', evaluateCandidate({ ...strongBuy, funding: 0.01 }, baseCtx).action === 'SKIP');

const midRangeButExtreme = { ...strongBuy, rangePos: 0.5, reversalFlag: true };
const extremeCtx = { ...baseCtx, fearGreed: 10 };
check('fear&greed extreme + reversal substitutes for the range gate (mid-range would normally be skipped)', evaluateCandidate(midRangeButExtreme, extremeCtx).action === 'OPEN', JSON.stringify(evaluateCandidate(midRangeButExtreme, extremeCtx)));
check('the extreme-boost open uses a larger position than a normal one at the same confidence', evaluateCandidate(midRangeButExtreme, extremeCtx).positionPct > evaluateCandidate(strongBuy, baseCtx).positionPct);
check('fear&greed extreme WITHOUT a detected reversal does not get the exemption', evaluateCandidate({ ...strongBuy, rangePos: 0.5, reversalFlag: false }, extremeCtx).action === 'SKIP');

const sellCandidate = { symbol: 'ETHUSDT', side: 'SELL', rangePos: 0.9, range: { low: 1800, high: 2000 }, confidenceRatio: 0.8, topIndicatorAccuracy: 0.8, funding: 0, reversalFlag: false };
check('a short candidate near the high end of its range opens', evaluateCandidate(sellCandidate, baseCtx).action === 'OPEN');

const findByAction = (list, action) => list.filter((d) => d.action === action);
const decisions1 = decideEntries([strongBuy], { ...baseCtx, equity: 10000, state: { ...baseCtx.state, peakEquity: 10000, dayStartEquity: 10000 } });
check('decideEntries opens a valid single candidate with no drawdown', findByAction(decisions1.decisions, 'OPEN').length === 1, JSON.stringify(decisions1));

const trippedCtx = { ...baseCtx, equity: 8000, state: { ...baseCtx.state, peakEquity: 10000, dayStartEquity: 10000 } };
const decisions2 = decideEntries([strongBuy], trippedCtx);
check('circuit breaker blocks ALL entries this cycle, with a clear reason', decisions2.paused === 'circuit_breaker' && findByAction(decisions2.decisions, 'OPEN').length === 0);

const twoCandle = [strongBuy, { ...sellCandidate, confidenceRatio: 0.95, topIndicatorAccuracy: 0.95 }];
const decisions3 = decideEntries(twoCandle, { ...baseCtx, balance: 10000, equity: 10000, state: { ...baseCtx.state, peakEquity: 10000, dayStartEquity: 10000 } });
check('ranks candidates by confidence — the stronger one is evaluated (and appears) first', decisions3.decisions[0].symbol === 'ETHUSDT', JSON.stringify(decisions3.decisions.map((d) => d.symbol)));

console.log(failures === 0 ? '\nTRADING BOT LOGIC OK\n' : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
