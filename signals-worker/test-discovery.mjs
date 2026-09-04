import assert from 'node:assert/strict';
import {
  DEFAULT_ROUND_TRIP_COST_PCT,
  evaluateDiscoveryStrategy,
  evaluateLiveTriggers,
  evaluateOutOfSample,
  nextStatus,
  roundTripCostPct,
  strategyEligibility,
  strategyMetrics,
  walkForwardStrategyAssessment
} from './scripts/discovery.mjs';
import { MARKET_CONTEXT_METHOD_VERSION } from './scripts/market-context.mjs';

const dated = (fn, n = 120) => Array.from({ length: n }, (_, i) => ({
  date: new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10),
  value: fn(i)
}));

assert.equal(roundTripCostPct('crypto'), DEFAULT_ROUND_TRIP_COST_PCT.crypto);
assert.equal(roundTripCostPct('stock', { stock: '0.42' }), 0.42);
assert.equal(roundTripCostPct('stock', { stock: '-1' }), DEFAULT_ROUND_TRIP_COST_PCT.stock);
assert.equal(roundTripCostPct('stock', { stock: '' }), DEFAULT_ROUND_TRIP_COST_PCT.stock);

const long = strategyMetrics([{ value: 10 }, { value: -20 }, { value: 5 }], 'long', 0);
assert.equal(long.tradeN, 3);
assert.ok(Math.abs(long.maxDrawdownPct - 20) < 1e-9);
assert.ok(Math.abs(long.compoundReturnPct - ((1.1 * 0.8 * 1.05 - 1) * 100)) < 1e-9);

const short = strategyMetrics([{ value: -1 }, { value: -2 }, { value: 1 }], 'short', 0.1);
assert.ok(Math.abs(short.netMeanPct - ((0.9 + 1.9 - 1.1) / 3)) < 1e-9);
assert.equal(short.direction, 'short');
assert.equal(strategyMetrics([], 'long', 0.3).netMeanPct, null);

const clustered = [...Array(20).fill(1), ...Array(20).fill(-0.2), ...Array(20).fill(1), ...Array(20).fill(-0.2)];
const clusteredMetrics = strategyMetrics(clustered, 'long', 0);
const clusteredMean = clustered.reduce((sum, value) => sum + value, 0) / clustered.length;
const clusteredSd = Math.sqrt(clustered.reduce((sum, value) => sum + (value - clusteredMean) ** 2, 0) / (clustered.length - 1));
const iidLower95 = clusteredMean - 1.96 * clusteredSd / Math.sqrt(clustered.length);
assert.ok(clusteredMetrics.netLower95Pct < iidLower95, 'positive serial correlation must widen, not tighten, the confidence interval');

const stableA = dated((i) => 1 + (i % 5) * 0.05);
const stableB = dated((i) => (i % 5) * 0.01);
const walk = walkForwardStrategyAssessment(stableA, stableB, 0.3);
assert.equal(walk.verdict, 'passed');
assert.equal(walk.positiveFolds, walk.folds.length);
assert.ok(walk.folds.every((fold) => fold.trainEndDate < fold.testStartDate));
assert.ok(walk.metrics.netLower95Pct > 0);

// The first half trains a long side, but every disjoint future fold reverses.
// A pooled/full-history direction must not be allowed to hide that decay.
const regimeA = dated((i) => i < 60 ? 1 : -1);
const regimeB = dated(() => 0);
const regimeWalk = walkForwardStrategyAssessment(regimeA, regimeB, 0.1);
assert.equal(regimeWalk.verdict, 'failed');
assert.equal(regimeWalk.positiveFolds, 0);

const discovery = evaluateDiscoveryStrategy(
  { asset_class: 'crypto', discovery_effect: 1 },
  { a: stableA, b: stableB }
);
assert.equal(discovery.tradeDecision, 'provisional');
assert.equal(discovery.eligible, true);

const oosConfirmed = evaluateOutOfSample(
  { asset_class: 'crypto', discovery_effect: 1, strategy_direction: 'long', status: 'provisional' },
  { a: stableA.slice(0, 40), b: stableB.slice(0, 40) },
  { discoveryEligible: true }
);
assert.equal(oosConfirmed.statisticalVerdict, 'held');
assert.equal(oosConfirmed.verdict, 'held');
assert.equal(oosConfirmed.tradeDecision, 'confirmed');
assert.ok(oosConfirmed.metrics.netLower95Pct > 0);
assert.equal(oosConfirmed.checkpoint, 25);

const betweenCheckpoints = evaluateOutOfSample(
  { asset_class: 'crypto', discovery_effect: 1, strategy_direction: 'long', status: 'confirmed', trade_decision: 'confirmed', oos_trade_n: 30, oos_checkpoint_n: 25 },
  { a: stableA.slice(0, 40), b: stableB.slice(0, 40) },
  { discoveryEligible: true }
);
assert.equal(betweenCheckpoints.statisticalVerdict, 'not-scheduled');
assert.equal(betweenCheckpoints.tradeDecision, 'confirmed', 'a confirmed strategy keeps its prior decision while waiting for the next fixed checkpoint');
assert.equal(betweenCheckpoints.decisionReason, 'awaiting-next-fixed-oos-checkpoint');

const reachesCheckpoint = evaluateOutOfSample(
  { asset_class: 'crypto', discovery_effect: 1, strategy_direction: 'long', status: 'confirmed', trade_decision: 'confirmed', oos_trade_n: 49, oos_checkpoint_n: 25 },
  { a: stableA.slice(0, 50), b: stableB.slice(0, 50) },
  { discoveryEligible: true }
);
assert.notEqual(reachesCheckpoint.statisticalVerdict, 'not-scheduled', 'the predeclared 50-observation checkpoint performs a real reassessment');

const asymmetricCheckpoint = evaluateOutOfSample(
  { asset_class: 'crypto', discovery_effect: 1, strategy_direction: 'long', status: 'confirmed', trade_decision: 'confirmed', oos_trade_n: 100, oos_checkpoint_n: 25 },
  { a: stableA.slice(0, 100), b: stableB.slice(0, 50) },
  { discoveryEligible: true }
);
assert.notEqual(asymmetricCheckpoint.statisticalVerdict, 'not-scheduled', 'a large setup sample must not cause the smaller two-sample checkpoint to be skipped');
assert.equal(asymmetricCheckpoint.checkpoint, 50);

// It can replicate relative to an even worse baseline and still lose money.
// That is statistically interesting, but explicitly not a trade.
const tinyA = dated((i) => 0.10 + (i % 3) * 0.001, 40);
const worseB = dated((i) => -0.20 + (i % 3) * 0.001, 40);
const untradeable = evaluateOutOfSample(
  { asset_class: 'crypto', discovery_effect: 0.30, strategy_direction: 'long', status: 'provisional' },
  { a: tinyA, b: worseB },
  { discoveryEligible: true }
);
assert.equal(untradeable.statisticalVerdict, 'held');
assert.equal(untradeable.verdict, 'untradeable');
assert.equal(untradeable.tradeDecision, 'abstain');
assert.equal(untradeable.decisionReason, 'no-after-cost-edge');
assert.equal(strategyEligibility(untradeable.metrics, 25).eligible, false);

assert.equal(nextStatus('provisional', 'held'), 'confirmed');
assert.equal(nextStatus('confirmed', 'untradeable'), 'decayed');
assert.equal(nextStatus('decayed', 'held'), 'decayed');
assert.equal(evaluateOutOfSample(
  { asset_class: 'crypto', discovery_effect: 1, strategy_direction: 'long', status: 'decayed' },
  { a: stableA.slice(0, 40), b: stableB.slice(0, 40) },
  { discoveryEligible: true }
).tradeDecision, 'abstain');

const thursday = {
  hypothesis: 'day-of-week|AAPL|4', family: 'day-of-week', status: 'confirmed', trade_decision: 'confirmed',
  asset_class: 'stock', symbol: 'AAPL', discovery_effect: 0.5
};
assert.equal(evaluateLiveTriggers([thursday], {}, '2026-09-03T06:00:00Z').length, 1);
assert.equal(evaluateLiveTriggers([{ ...thursday, trade_decision: 'provisional' }], {}, '2026-09-03T06:00:00Z').length, 0);
assert.equal(evaluateLiveTriggers([{ ...thursday, trade_decision: 'abstain' }], {}, '2026-09-03T06:00:00Z').length, 0);

const mvrvRegistry = {
  hypothesis: `market-context|btc_mvrv|coinmetrics-community|${MARKET_CONTEXT_METHOD_VERSION}|low|7`,
  family: 'market-context', status: 'confirmed', trade_decision: 'confirmed',
  asset_class: 'crypto', symbol: 'BTC', discovery_effect: 1,
  strategy_direction: 'long', horizon_days: 7
};
const liveMvrv = {
  metric: 'btc_mvrv', provider: 'coinmetrics-community', method_version: MARKET_CONTEXT_METHOD_VERSION,
  context_date: '2026-09-03', value: 0.8, training_n: 500, training_percentile: 0.05,
  known_at: '2026-09-03T02:00:00Z', source_timestamp: '2026-09-03T00:00:00Z'
};
assert.equal(evaluateLiveTriggers([mvrvRegistry], {}, '2026-09-03T06:00:00Z', [liveMvrv]).length, 1, 'an exact, available, confirmed context may trigger');
assert.equal(evaluateLiveTriggers([mvrvRegistry], {}, '2026-09-03T06:00:00Z', [{ ...liveMvrv, known_at: '2026-09-03T08:00:00Z' }]).length, 0, 'future-known context cannot trigger');
assert.equal(evaluateLiveTriggers([mvrvRegistry], {}, '2026-09-03T06:00:00Z', [{ ...liveMvrv, source_timestamp: '2026-09-03T08:00:00Z' }]).length, 0, 'future source timestamp cannot trigger');
assert.equal(evaluateLiveTriggers([mvrvRegistry], {}, '2026-09-03T06:00:00Z', [{ ...liveMvrv, training_percentile: null }]).length, 0, 'null percentile cannot become a low-tail trigger');
assert.equal(evaluateLiveTriggers([mvrvRegistry], {}, '2026-09-03T06:00:00Z', [{ ...liveMvrv, provider: 'replacement-provider' }]).length, 0, 'provider mismatch cannot inherit confirmation');
assert.equal(evaluateLiveTriggers([mvrvRegistry], {}, '2026-09-03T06:00:00Z', [{ ...liveMvrv, method_version: 'future-method' }]).length, 0, 'method mismatch cannot inherit confirmation');
assert.equal(evaluateLiveTriggers([{ ...mvrvRegistry, hypothesis: `market-context|btc_mayer_multiple|fcs-asset-daily-bars|${MARKET_CONTEXT_METHOD_VERSION}|low|7` }], {}, '2026-09-03T06:00:00Z', [{ ...liveMvrv, metric: 'btc_mayer_multiple', provider: 'fcs-asset-daily-bars' }]).length, 0, 'Mayer remains control-only even if a registry row is manually marked confirmed');
assert.equal(evaluateLiveTriggers([{ ...mvrvRegistry, hypothesis: `market-context|btc_mvrv|${MARKET_CONTEXT_METHOD_VERSION}|low|7` }], {}, '2026-09-03T06:00:00Z', [liveMvrv]).length, 0, 'legacy hypotheses without provider identity fail closed');

console.log('discovery quant-strategy tests passed');
