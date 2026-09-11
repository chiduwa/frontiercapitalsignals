import assert from 'node:assert/strict';
import { replayPolicy, comparePolicies } from './src/policy-replay.mjs';

const start = Date.parse('2024-09-01T00:00:00Z');
const policy = { id: 'baseline', leverage: 10, stopRoiPct: 20,
  firstTargetRoiPct: 60, finalTargetRoiPct: 120, firstFraction: 0.5 };
const event = (changes = {}) => ({ id: 'synthetic-test', venue: 'binance-usdm', priceType: 'mark',
  source: 'synthetic fixture, NOT market evidence', assetClass: 'crypto', symbol: 'TESTUSDT',
  side: 'BUY', regime: 'bull', contextAt: start - 1, entryAt: start, endAt: start + 120_000,
  entryPrice: 100, intervalMs: 60_000,
  costs: { feeRate: 0.0005, slippagePct: 0, fundingComplete: true, funding: [], source: 'test-assumption' },
  bars: [
    { at: start, open: 100, high: 107, low: 99, close: 106 },
    { at: start + 60_000, open: 106, high: 113, low: 105, close: 112 }
  ], ...changes });
const result = replayPolicy(event(), policy);
assert.equal(result.status, 'simulated');
assert.ok(Math.abs(result.grossRoiPct - 90) < 1e-9);
assert.ok(Math.abs(result.feeRoiPct - 1.045) < 1e-9);
assert.equal(result.liveEligible, false);
assert.equal(result.exits.length, 2);
const both = event(); both.bars[0].low = 97;
assert.equal(replayPolicy(both, policy).status, 'ambiguous-intrabar-order');
const short = event({ side: 'SELL', bars: [
  { at: start, open: 100, high: 101, low: 93, close: 94 },
  { at: start + 60_000, open: 94, high: 95, low: 87, close: 88 }
] });
assert.ok(Math.abs(replayPolicy(short, policy).grossRoiPct - 90) < 1e-9);
const gap = event(); gap.bars[0] = { at: start, open: 95, high: 96, low: 94, close: 95 };
assert.ok(Math.abs(replayPolicy(gap, policy).grossRoiPct + 50) < 1e-9);
assert.equal(replayPolicy(gap, policy).exits[0].reason, 'gap-stop');
const badLater = event(); badLater.bars[1].at += 1;
assert.equal(replayPolicy(badLater, policy).status, 'invalid-path');
assert.equal(replayPolicy(event({ contextAt: start + 1 }), policy).status, 'invalid-path');
assert.equal(replayPolicy(event({ costs: null }), policy).status, 'missing-cost-evidence');
const funded = event(); funded.costs.funding = [{ at: start + 60_000, rate: 0.001, markPrice: 106 }];
assert.ok(Math.abs(replayPolicy(funded, policy).fundingRoiPct + 0.53) < 1e-9);
funded.costs.funding[0].at = start + 30_000;
assert.equal(replayPolicy(funded, policy).status, 'ambiguous-funding-order');

const shift = (e, delta, id) => ({ ...e, id, entryAt: e.entryAt + delta,
  endAt: e.endAt + delta, contextAt: e.contextAt + delta,
  bars: e.bars.map(b => ({ ...b, at: b.at + delta })) });
const validationStart = Date.parse('2025-09-01T00:00:00Z');
const events = [
  ...Array.from({ length: 30 }, (_, i) => shift(event(), i * 3_600_000, `train-${i}`)),
  ...Array.from({ length: 20 }, (_, i) => shift(event(), validationStart - start + i * 3_600_000, `valid-${i}`))
];
const policies = [policy, { ...policy, id: 'lower-leverage', leverage: 5 }];
const comparison = { cutoffAt: Date.parse('2025-01-01T00:00:00Z'), baselineId: 'baseline' };
const report = comparePolicies(events, policies, comparison);
assert.equal(report.cells.length, 1);
assert.equal(report.cells[0].status, 'descriptive-validation-only');
assert.equal(report.cells[0].selectedOnTraining, 'baseline');
assert.equal(report.cells[0].validation.n, 20);
const alteredValidation = events.map(e => e.entryAt < comparison.cutoffAt ? e : {
  ...e, bars: e.bars.map(b => ({ ...b, open: 100, high: 100.1, low: 99.9, close: 100 }))
});
assert.equal(comparePolicies(alteredValidation, policies, comparison).cells[0].selectedOnTraining,
  report.cells[0].selectedOnTraining);
assert.throws(() => comparePolicies([...events, events[0]], policies, comparison), /duplicate/);
const ambiguousAll = comparePolicies([both], policies, comparison);
assert.equal(ambiguousAll.cells.length, 0);
assert.equal(ambiguousAll.excluded['ambiguous-intrabar-order'], 1);
const overlap = shift(events[0], 60_000, 'overlapping');
assert.equal(comparePolicies([...events, overlap], policies, comparison).excluded['overlapping-asset-window'], 1);
const sparse = comparePolicies(events.slice(0, 2), policies, comparison);
assert.equal(sparse.cells[0].selectedOnTraining, null);
assert.equal(sparse.cells[0].status, 'insufficient-data');
assert.equal(comparePolicies(events, policies, { ...comparison, asOf: comparison.cutoffAt }).excluded['unmatured-window'], 20);
console.log('POLICY REPLAY OK: synthetic math, costs, data quality, ambiguity, splitting and non-promotion');
