// Guardrail tests for the walk-forward replay.
//
// A replay harness is the single easiest place in this project to manufacture a
// brilliant-looking model by accident. Three mistakes do it, all silent:
//
//   1. An off-by-one in a slice hands the model its own future.
//   2. Weighting a 2023 cast with a reliability map built from 2026.
//   3. Stepping i+N bars and calling it N days, so a gap becomes a fake return.
//
// None of those throw. All three make the output better. So almost everything
// below tests a REFUSAL: that a metric computed at bar i is unchanged by
// anything after bar i, that the reliability map at anchor D contains only
// outcomes that had already resolved by D, and that an unscoreable forecast is
// dropped rather than scored against whatever bar was nearest.
import assert from 'node:assert/strict';
import { confluence, compositeCall, reliabilityMultiplier } from './worker.js';
import { replayMetrics, REPLAY_WARMUP_BARS } from './scripts/replay-metrics.mjs';
import {
  replayAnchors, forwardBar, directionOf,
  createWalkForwardReliability, createWalkForwardBaselines, expandingOiPercentiles
} from './scripts/replay-history.mjs';
import { neweyWestSE } from './scripts/replay-report.mjs';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (err) { console.error(`FAIL  ${name}\n      ${err.message}`); process.exitCode = 1; }
}

const day = (n) => new Date(Date.UTC(2020, 0, 1) + n * 86400000).toISOString().slice(0, 10);
function bars(n, priceAt = (i) => 100 + Math.sin(i / 9) * 12 + i * 0.03, from = 0) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ date: day(from + i), close: priceAt(i), volume: 1000 + (i % 17) * 25 });
  return out;
}
const indexOf = (b) => new Map(b.map((row, i) => [row.date, i]));

// ---------------------------------------------------------------------------
console.log('\n== no look-ahead: a metric at bar i cannot see bar i+1 ==');

test('replayMetrics at i is byte-identical whether or not future bars exist', () => {
  const short = bars(REPLAY_WARMUP_BARS + 1);
  const long = bars(REPLAY_WARMUP_BARS + 400);
  const i = short.length - 1;
  const a = replayMetrics('T', short, i, { kind: 'crypto' });
  const b = replayMetrics('T', long, i, { kind: 'crypto' });
  assert.ok(a && b, 'both windows should produce metrics');
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('every future bar appended leaves the anchor metric untouched, across many anchors', () => {
  const full = bars(REPLAY_WARMUP_BARS + 60);
  for (let i = REPLAY_WARMUP_BARS - 1; i < full.length - 10; i += 7) {
    const truncated = full.slice(0, i + 1);
    const a = replayMetrics('T', truncated, i, { kind: 'crypto' });
    const b = replayMetrics('T', full, i, { kind: 'crypto' });
    assert.equal(JSON.stringify(a), JSON.stringify(b), `diverged at i=${i}`);
  }
});

test('below the warmup bar count, no metrics at all — not a mostly-null object', () => {
  const b = bars(REPLAY_WARMUP_BARS + 5);
  assert.equal(replayMetrics('T', b, REPLAY_WARMUP_BARS - 2, { kind: 'crypto' }), null);
  assert.ok(replayMetrics('T', b, REPLAY_WARMUP_BARS - 1, { kind: 'crypto' }));
});

test('a fundamentals value is read by DATE, so a later date cannot leak backwards', () => {
  const b = bars(REPLAY_WARMUP_BARS + 5);
  const anchor = b[REPLAY_WARMUP_BARS - 1].date;
  const later = b[REPLAY_WARMUP_BARS + 3].date;
  const extras = { deriv: new Map([['T', new Map([[later, { oi_usd: 5e8 }]])]]) };
  const m = replayMetrics('T', b, REPLAY_WARMUP_BARS - 1, { kind: 'crypto', extras });
  assert.equal(m.openInterest, undefined, `read ${later}'s value at ${anchor}`);
});

test('the benchmark series must already be sliced — an unsliced one is the back door', () => {
  const b = bars(REPLAY_WARMUP_BARS + 50);
  const i = REPLAY_WARMUP_BARS - 1;
  const benchTruncated = b.slice(0, i + 1).map((r) => r.close);
  const a = replayMetrics('T', b, i, { kind: 'crypto', benchCloses: benchTruncated });
  const c = replayMetrics('T', b, i, { kind: 'crypto', benchCloses: b.map((r) => r.close) });
  // Not asserting which is right — asserting they DIFFER, which is what makes
  // passing an unsliced benchmark a real bug rather than a harmless one.
  assert.notEqual(a.corr, c.corr);
});

// ---------------------------------------------------------------------------
console.log('\n== independence: stride equals the horizon ==');

test('consecutive anchors are exactly one horizon apart, so forecasts never overlap', () => {
  const m = new Map([['T', bars(REPLAY_WARMUP_BARS + 90)]]);
  for (const h of [1, 7]) {
    const a = replayAnchors(m, h);
    assert.ok(a.length > 1, `no anchors at h=${h}`);
    for (let k = 1; k < a.length; k++) {
      const gap = (Date.parse(a[k]) - Date.parse(a[k - 1])) / 86400000;
      assert.equal(gap, h, `gap ${gap} != ${h}`);
    }
  }
});

test('anchors are ascending, so the walk-forward map is built in time order', () => {
  const a = replayAnchors(new Map([['T', bars(REPLAY_WARMUP_BARS + 60)]]), 1);
  assert.deepEqual(a, [...a].sort());
});

test('the last anchor leaves a full horizon of bars ahead of it to score against', () => {
  const b = bars(REPLAY_WARMUP_BARS + 40);
  const a = replayAnchors(new Map([['T', b]]), 7);
  const last = Date.parse(a[a.length - 1]);
  const end = Date.parse(b[b.length - 1].date);
  assert.ok((end - last) / 86400000 >= 7);
});

test('resuming after a checkpoint starts strictly beyond it, never re-casting the same anchor', () => {
  const m = new Map([['T', bars(REPLAY_WARMUP_BARS + 60)]]);
  const all = replayAnchors(m, 1);
  const resumed = replayAnchors(m, 1, { after: all[10] });
  assert.ok(resumed.every((d) => d > all[10]));
  assert.equal(resumed[0], all[11]);
});

// ---------------------------------------------------------------------------
console.log('\n== scoring: the forward bar is found by date and checked ==');

test('a clean horizon resolves to the bar exactly that many days later', () => {
  const b = bars(REPLAY_WARMUP_BARS + 30);
  const idx = indexOf(b);
  const i = REPLAY_WARMUP_BARS - 1;
  const j = forwardBar(b, idx, i, b[i].date, 7);
  assert.equal(b[j].date, day(REPLAY_WARMUP_BARS - 1 + 7));
});

test('a gap wider than the horizon tolerance is REFUSED, not scored against the nearest bar', () => {
  // 40-day hole immediately after the anchor: the next available bar is nowhere
  // near 7 days out. This is the shape that produced a single +120,933%
  // observation in the cross-sectional lane's validation.
  const head = bars(REPLAY_WARMUP_BARS);
  const tail = bars(10, (i) => 900 + i, REPLAY_WARMUP_BARS + 40);
  const b = [...head, ...tail];
  const idx = indexOf(b);
  const i = REPLAY_WARMUP_BARS - 1;
  assert.equal(forwardBar(b, idx, i, b[i].date, 7), null);
});

test('a weekend hole IS tolerated — equities have no Saturday bar and that is not a gap', () => {
  const b = [];
  // Walk calendar days but keep only weekdays, so the array reaches the warmup
  // count in TRADING bars rather than calendar ones.
  for (let k = 0; b.length < REPLAY_WARMUP_BARS + 40; k++) {
    const d = new Date(Date.UTC(2020, 0, 1) + k * 86400000);
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    b.push({ date: d.toISOString().slice(0, 10), close: 100 + b.length * 0.1, volume: 1000 });
  }
  const idx = indexOf(b);
  const i = REPLAY_WARMUP_BARS - 1;
  assert.ok(forwardBar(b, idx, i, b[i].date, 1) !== null);
});

test('the deadband makes a flat outcome wrong for BOTH sides, matching the live label', () => {
  // direction-deadband-0.5pct-v1: this is why a coin-flip call scores ~38-42%
  // in this engine rather than 50%, and why every significance test is measured
  // against direction_baseline instead of a fair coin.
  assert.equal(directionOf(0.4), 0);
  assert.equal(directionOf(-0.4), 0);
  assert.equal(directionOf(0.6), 1);
  assert.equal(directionOf(-0.6), -1);
  assert.notEqual(directionOf(0.4), 1);
  assert.notEqual(directionOf(0.4), -1);
});

// ---------------------------------------------------------------------------
console.log('\n== walk-forward reliability: weights may only use resolved evidence ==');

test('an outcome resolving ON the anchor is not yet visible to that anchor', () => {
  const r = createWalkForwardReliability();
  r.add({ series_kind: 'technique', series_key: 'rsi', symbol: 'T', dir: 1, correct: 1, targetDate: '2024-03-10' });
  assert.equal(r.fold('2024-03-10'), 0, 'folded an outcome that resolves the same day');
  assert.equal(r.fold('2024-03-11'), 1);
  assert.equal(r.map['T|rsi'].total, 1);
});

test('folding is monotone: evidence accumulates forward and is never unwound', () => {
  const r = createWalkForwardReliability();
  for (let k = 0; k < 30; k++) {
    r.add({ series_kind: 'technique', series_key: 'rsi', symbol: 'T', dir: 1, correct: k % 2, targetDate: day(k) });
  }
  r.fold(day(10));
  const after10 = r.map['T|rsi'].total;
  r.fold(day(25));
  assert.ok(r.map['T|rsi'].total > after10);
  assert.equal(r.map['T|rsi'].accuracy, r.map['T|rsi'].correct / r.map['T|rsi'].total);
});

test('non-directional and non-technique rows never enter the weighting map', () => {
  const r = createWalkForwardReliability();
  r.add({ series_kind: 'market', series_key: 'market', symbol: 'T', dir: null, correct: 1, targetDate: day(1) });
  r.add({ series_kind: 'technique', series_key: 'rsi', symbol: 'T', dir: null, correct: 1, targetDate: day(1) });
  r.fold(day(5));
  assert.deepEqual(Object.keys(r.map), []);
});

test('a seeded resume starts from the counters a continuous run would have held', () => {
  const seeded = createWalkForwardReliability({ 'T|rsi': { correct: 8, total: 20, accuracy: 0.4, votes_up: 20, votes_down: 0 } });
  assert.equal(seeded.map['T|rsi'].total, 20);
  seeded.add({ series_kind: 'technique', series_key: 'rsi', symbol: 'T', dir: 1, correct: 1, targetDate: day(1) });
  seeded.fold(day(2));
  assert.equal(seeded.map['T|rsi'].total, 21);
  assert.equal(seeded.map['T|rsi'].correct, 9);
});

test('direction baselines advance forward too — today\'s up/down mix is look-ahead at a past anchor', () => {
  const b = createWalkForwardBaselines();
  b.observe('crypto', 24, 1);
  b.observe('crypto', 24, -1);
  b.observe('crypto', 24, 0);
  assert.deepEqual(b.map['crypto|24'], { n_up: 1, n_flat: 1, n_down: 1 });
  assert.deepEqual(b.map['crypto|all'], { n_up: 1, n_flat: 1, n_down: 1 });
});

test('expanding OI percentile uses its own history only, and is never fed a later value', () => {
  const byDate = new Map([
    ['2024-01-01', { oi_usd: 10 }],
    ['2024-01-02', { oi_usd: 20 }],
    ['2024-01-03', { oi_usd: 5 }],
    ['2024-01-04', { oi_usd: 100 }]
  ]);
  const out = expandingOiPercentiles(new Map([['T', byDate]])).get('T');
  assert.equal(out.get('2024-01-01'), 1);        // first observation is its own max
  assert.equal(out.get('2024-01-02'), 1);        // 20 is the highest of {10,20}
  assert.ok(Math.abs(out.get('2024-01-03') - 1 / 3) < 1e-9); // 5 is lowest of three
  assert.equal(out.get('2024-01-04'), 1);
});

// ---------------------------------------------------------------------------
console.log('\n== the replayed model is the live model ==');

test('a cold replay produces a real panel and a composite call — it does not reproduce the deadlock', () => {
  // The whole point of the weighting change: with an empty reliability map the
  // panel must still carry weight, or the replay walks 900 anchors recording
  // nothing, exactly as the live loop did from 2026-09-06.
  const b = bars(REPLAY_WARMUP_BARS + 10);
  const m = replayMetrics('T', b, b.length - 1, { kind: 'crypto' });
  const c = confluence(m, 'crypto', {}, {});
  assert.ok(c.total >= 8, `only ${c.total} techniques voted on a cold map`);
  assert.ok(c.long !== 0 || c.short !== 0, 'every weight was zero — the deadlock is back');
  assert.ok(compositeCall(c), 'no composite call, so nothing would be recorded');
});

test('an unproven technique weights at the prior, and a proven anti-signal is still silenced', () => {
  assert.equal(reliabilityMultiplier({}, 'T', 'rsi'), 1);
  assert.equal(reliabilityMultiplier({ 'T|rsi': { accuracy: 0, correct: 0, total: 50 } }, 'T', 'rsi'), 0);
});

test('replayed metrics carry the fields the technique library actually reads', () => {
  const b = bars(REPLAY_WARMUP_BARS + 10);
  const m = replayMetrics('T', b, b.length - 1, { kind: 'crypto' });
  for (const field of ['rsi', 'rsiPrev', 'rsiRecentMin', 'macdHist', 'sma20', 'sma50',
    'bb', 'stoch', 'donchianHi', 'obv', 'structure', 'volReg', 'dwell', 'fib',
    'rangePos', 'slope', 'chg24h', 'chg7d', 'chg30d', 'volPct']) {
    assert.ok(m[field] !== undefined, `missing ${field}`);
  }
});

test('fields the archive cannot supply are absent, so their techniques abstain rather than guess', () => {
  const b = bars(REPLAY_WARMUP_BARS + 10);
  const m = replayMetrics('T', b, b.length - 1, { kind: 'crypto' });
  for (const field of ['val', 'trending', 'daysToEarnings', 'sentimentScore', 'ivPercentile', 'funding', 'chgShort']) {
    assert.equal(m[field], undefined, `${field} was fabricated`);
  }
  const c = confluence(m, 'crypto', {}, {});
  const voted = new Set(c.votes.map((v) => v.id));
  for (const id of ['valuation', 'attention', 'sentiment', 'impliedvol', 'positioning']) {
    assert.ok(!voted.has(id), `${id} voted without its input`);
  }
});

test('crypto volRatio needs a market cap — the stock definition is not silently substituted', () => {
  const b = bars(REPLAY_WARMUP_BARS + 10);
  const i = b.length - 1;
  const without = replayMetrics('T', b, i, { kind: 'crypto' });
  assert.equal(without.volRatio, null, 'used volume/avg-volume for crypto');
  const extras = { marketCap: new Map([['T', new Map([[b[i].date, 5e9]])]]) };
  const withCap = replayMetrics('T', b, i, { kind: 'crypto', extras });
  assert.ok(withCap.volRatio > 0);
  // Equities use volume-vs-own-average and need no market cap at all.
  assert.ok(replayMetrics('T', b, i, { kind: 'stock' }).volRatio > 0);
});

// ---------------------------------------------------------------------------
console.log('\n== the report refuses to overstate what the ledger supports ==');

test('Newey-West widens the standard error on a positively autocorrelated series', () => {
  // AR(1) with rho = 0.9: consecutive observations are not independent draws,
  // which is exactly the shape that makes a naive sd/sqrt(n) optimistic. Shocks
  // come from a seeded LCG so the assertion is deterministic. A deliberately
  // NON-periodic generator — an innovation cycling on k % 7 produces negative
  // autocorrelation at some lags and can make Newey-West smaller, not larger.
  let seed = 12345;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5; };
  const series = [];
  let v = 0;
  for (let k = 0; k < 200; k++) { v = 0.9 * v + rand() * 0.05; series.push(v); }
  const mean = series.reduce((a, b) => a + b, 0) / series.length;
  const naive = Math.sqrt(series.reduce((a, b) => a + (b - mean) ** 2, 0) / (series.length - 1)) / Math.sqrt(series.length);
  const nw = neweyWestSE(series);
  assert.ok(nw > naive, `NW ${nw} should exceed naive ${naive} on an autocorrelated series`);
});

test('Newey-West returns null rather than a number it cannot support', () => {
  assert.equal(neweyWestSE([0.1, 0.2]), null);
  assert.equal(neweyWestSE([]), null);
});

console.log(`\n${passed} assertions passed${process.exitCode ? ' (with failures above)' : ''}\n`);
