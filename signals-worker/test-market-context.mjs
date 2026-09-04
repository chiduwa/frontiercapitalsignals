import assert from 'node:assert/strict';
import {
  attachCausalPercentiles, computeMayerSeries, coinMetricsMvrvRows,
  currentContextRow, insertMarketContextRows, MARKET_CONTEXT_METHOD_VERSION
} from './scripts/market-context.mjs';
import { marketContextTailSamples } from './scripts/discovery.mjs';

const pct = attachCausalPercentiles([
  { context_date: '2026-01-01', value: 10 },
  { context_date: '2026-01-02', value: 20 },
  { context_date: '2026-01-03', value: 5 }
]);
assert.equal(pct[0].training_percentile, null, 'first point has no invented percentile');
assert.equal(pct[1].training_percentile, 1, 'second point only sees the first');
assert.equal(pct[2].training_percentile, 0, 'future values do not leak into a causal percentile');
assert.deepEqual(pct.map((row) => row.training_n), [0, 1, 2]);
const ties = attachCausalPercentiles([
  { context_date: '2026-01-01', value: 10 },
  { context_date: '2026-01-02', value: 10 },
  { context_date: '2026-01-03', value: 10 }
]);
assert.deepEqual(ties.map((row) => row.training_percentile), [null, 0.5, 0.5], 'ties use midranks rather than turning a constant series into a high-tail signal');

const bars = [];
for (let index = 0; index < 230; index++) {
  const date = new Date(Date.UTC(2025, 0, 1 + index)).toISOString().slice(0, 10);
  bars.push({ date, close: index === 229 ? 200 : 100 });
}
const mayer = computeMayerSeries(bars, '2026-09-03T12:00:00.000Z');
assert.equal(mayer.length, 31);
assert.equal(mayer[0].value, 1);
assert.ok(mayer.at(-1).value > 1, 'current price is divided by its trailing 200-day mean');
assert.equal(mayer[0].known_at, '2026-09-03T12:00:00.000Z', 'backfill is not falsely backdated');
assert.equal(mayer[0].method_version, MARKET_CONTEXT_METHOD_VERSION);
assert.equal(mayer[0].raw_hash.length, 64);
const mayerWithoutPartial = computeMayerSeries([
  ...bars,
  { date: '2026-09-03', close: 999999 }
], '2026-09-03T12:00:00.000Z');
assert.equal(mayerWithoutPartial.length, mayer.length, 'the current UTC daily candle is excluded until complete');
assert.equal(mayerWithoutPartial.at(-1).value, mayer.at(-1).value, 'a partial close cannot contaminate the latest Mayer value');

const mvrv = coinMetricsMvrvRows({ data: [
  { asset: 'btc', time: '2026-09-01T00:00:00.000000000Z', CapMVRVCur: '1.5' }
] }, '2026-09-03T12:00:00.000Z', [1, 2]);
assert.equal(mvrv[0].value, 1.5);
assert.equal(mvrv[0].known_at, '2026-09-03T12:00:00.000Z');
assert.equal(mvrv[0].training_percentile, 0.5);

assert.equal(currentContextRow('x', null, '2026-01-01T00:00:00Z', 'p', '2026-01-01T01:00:00Z', {}, []), null);

const daily = [];
const contexts = [];
for (let index = 0; index < 90; index++) {
  const date = new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10);
  daily.push({ date, open: 100 + index, close: 101 + index });
  contexts.push({
    metric: 'btc_mvrv', context_date: date, value: 1,
    training_n: 500, training_percentile: index % 12 === 0 ? 0.05 : 0.5,
    source_timestamp: `${date}T00:00:00Z`, known_at: `${date}T02:00:00Z`,
    provider: 'coinmetrics-community', method_version: MARKET_CONTEXT_METHOD_VERSION
  });
}
const samples = marketContextTailSamples(contexts, daily, 'btc_mvrv', 'low', 7);
assert.ok(samples.a.length > 0 && samples.b.length > 0);
const allDates = [...samples.a, ...samples.b].map((point) => point.date);
assert.equal(new Set(allDates).size, allDates.length, 'event and baseline observations are disjoint');
const barIndex = new Map(daily.map((bar, index) => [bar.date, index]));
const ordered = allDates.map((date) => barIndex.get(date)).sort((a, b) => a - b);
for (let index = 1; index < ordered.length; index++) {
  assert.ok(ordered[index] - ordered[index - 1] >= 7, 'horizon-sized blocks prevent overlapping outcomes');
}

const unavailable = marketContextTailSamples([
  { ...contexts[0], known_at: '2030-01-01T00:00:00Z' }
], daily, 'btc_mvrv', 'low', 1, '2025-01-01', null, true);
assert.equal(unavailable.a.length, 0, 'OOS entry cannot predate real known_at');

const sourceUnavailable = marketContextTailSamples([
  { ...contexts[0], source_timestamp: '2030-01-01T00:00:00Z' }
], daily, 'btc_mvrv', 'low', 1, '2025-01-01', null, true);
assert.equal(sourceUnavailable.a.length, 0, 'OOS entry cannot predate the source observation either');

const cutoffBeforeExit = marketContextTailSamples(
  [contexts[0]], daily, 'btc_mvrv', 'low', 7,
  null, daily[3].date, false
);
assert.equal(cutoffBeforeExit.a.length, 0, 'a context inside the discovery cutoff is excluded when its realized exit falls after that cutoff');

const nullPercentile = marketContextTailSamples([
  { ...contexts[0], training_percentile: null }
], daily, 'btc_mvrv', 'low', 1);
assert.equal(nullPercentile.a.length, 0, 'null percentiles do not coerce to a false low-tail event');

const wrongProvider = marketContextTailSamples([
  { ...contexts[0], provider: 'replacement-provider' }
], daily, 'btc_mvrv', 'low', 1);
assert.equal(wrongProvider.a.length, 0, 'a replacement provider cannot inherit the declared provider\'s sample');

const wrongMethod = marketContextTailSamples([
  { ...contexts[0], method_version: 'future-method' }
], daily, 'btc_mvrv', 'low', 1);
assert.equal(wrongMethod.a.length, 0, 'a new calculation version cannot inherit the prior version\'s sample');

const priorFetch = globalThis.fetch;
let insertBody;
globalThis.fetch = async (_url, options) => {
  insertBody = JSON.parse(options.body);
  return new Response(JSON.stringify({ success: true, result: [{ success: true, results: [] }] }), { status: 200, headers: { 'content-type': 'application/json' } });
};
await insertMarketContextRows({ CLOUDFLARE_ACCOUNT_ID: 'a', FCS_D1_DATABASE_ID: 'd', CLOUDFLARE_API_TOKEN: 't' }, [mvrv[0]]);
assert.ok(insertBody.sql.includes('ON CONFLICT(metric, provider, method_version, context_date) DO NOTHING'));
assert.ok(!insertBody.sql.includes('INSERT OR IGNORE'), 'only the declared duplicate key is ignored; other data errors surface');
globalThis.fetch = priorFetch;

console.log('market-context tests passed');
