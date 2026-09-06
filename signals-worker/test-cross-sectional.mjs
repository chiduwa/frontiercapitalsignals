// Guardrail tests for the cross-sectional expected-return lane.
//
// The regression maths is not the risky part — an OLS slope is an OLS slope.
// The risky parts are that this lane (a) searches ~20 features for a small
// effect in very noisy data, which is the setup that reliably manufactures
// convincing false positives, and (b) rebuilds historical features from an
// archive, where a single off-by-one in a slice silently grants the model
// knowledge of its own future and makes everything downstream look brilliant.
//
// So most of what follows tests refusals: that noise cannot become a
// coefficient, that a gap in the bar series cannot fake a 7-day return, that
// a feature computed at bar i is unchanged by anything after bar i, and that
// a decile with no evidence cannot be published.
import assert from 'node:assert/strict';
import {
  crossSectionalRanks, xsForecast, xsPercentiles, buildXsPanel,
  XS_FEATURES, XS_MIN_UNIVERSE, XS_MIN_FEATURE_COVERAGE
} from './worker.js';
import {
  winsorise, spansExpectedDays, groupBars, archiveMetrics, buildWeeklyCrossSections,
  fitCoefficients, ols, bonferroniZ, normalInvCdf, xsDecileIsPublishable,
  XS_WARMUP_BARS, XS_PUBLICATION_MIN_SAMPLES, XS_PUBLICATION_MIN_T, XS_WINSOR_PCT
} from './scripts/cross-sectional.mjs';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (err) { console.error(`FAIL  ${name}\n      ${err.message}`); process.exitCode = 1; }
}

// Deterministic PRNG so a "sometimes fails" test is impossible.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

console.log('\n-- crossSectionalRanks --');

test('maps a strict ordering onto [-0.5, +0.5] endpoints inclusive', () => {
  const r = crossSectionalRanks([10, 20, 30, 40, 50]);
  assert.equal(r[0], -0.5);
  assert.equal(r[4], 0.5);
  assert.equal(r[2], 0);
});

test('ties share the midpoint of their block rather than an arbitrary order', () => {
  const r = crossSectionalRanks([5, 5, 5, 5]);
  assert.deepEqual(r, [0, 0, 0, 0], 'a constant feature must contribute exactly zero, not a random ordering');
});

test('nulls stay null and do not consume a rank slot', () => {
  const r = crossSectionalRanks([1, null, 2, undefined, 3, NaN]);
  assert.equal(r[1], null); assert.equal(r[3], null); assert.equal(r[5], null);
  // The three finite values must still span the full range between themselves.
  assert.equal(r[0], -0.5); assert.equal(r[4], 0.5);
});

test('a missing value never ranks as the worst peer', () => {
  const r = crossSectionalRanks([100, null, -100]);
  assert.equal(r[1], null, 'null must abstain, not be treated as the minimum');
});

test('fewer than two finite values yields no ranks at all', () => {
  assert.deepEqual(crossSectionalRanks([7]), [null]);
  assert.deepEqual(crossSectionalRanks([7, null]), [null, null]);
});

console.log('\n-- winsorise --');

test('clips both tails and leaves the interior untouched', () => {
  const v = [-1000, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 1000];
  const w = winsorise(v, XS_WINSOR_PCT);
  assert.equal(w.length, v.length, 'clipping must not change the number of assets in the cross-section');
  assert.ok(w[0] > -1000, 'lower tail not clipped');
  assert.ok(w[11] < 1000, 'upper tail not clipped');
  assert.deepEqual(w.slice(2, 10), v.slice(2, 10), 'interior must be identical');
});

test('a single extreme observation cannot dominate the fitted slope', () => {
  // The GRAM case that was caught in validation: one +120,933% observation.
  const x = [], yClean = [];
  for (let i = 0; i < 40; i++) { x.push(i / 39 - 0.5); yClean.push((i / 39 - 0.5) * 4); }
  const yPoisoned = yClean.slice();
  yPoisoned[0] = 120933;
  const clean = ols(x, yClean).beta;
  const poisoned = ols(x, yPoisoned).beta;
  const repaired = ols(x, winsorise(yPoisoned, XS_WINSOR_PCT)).beta;
  assert.ok(Math.abs(poisoned - clean) > 100, 'sanity: the outlier really does wreck a raw fit');
  assert.ok(Math.abs(repaired - clean) < 1, `winsorised slope ${repaired} should be near the clean slope ${clean}`);
});

test('leaves short cross-sections alone rather than clipping most of them', () => {
  const v = [1, 2, 99];
  assert.deepEqual(winsorise(v), v, 'with 3 points, a 2% clip would be meaningless');
});

console.log('\n-- spansExpectedDays --');

test('accepts an exact horizon', () => {
  assert.equal(spansExpectedDays('2026-01-01', '2026-01-08', 7), true);
});

test('accepts an equity week that skips a weekend', () => {
  assert.equal(spansExpectedDays('2026-01-02', '2026-01-05', 1), true, 'Friday to Monday is a legitimate 1-day bar step');
});

test('rejects a window that spans a real archive gap', () => {
  // The defect this guard exists for: bar i+7 landing 46 days later.
  assert.equal(spansExpectedDays('2026-06-21', '2026-08-06', 7), false);
});

test('rejects a zero-length or reversed window', () => {
  assert.equal(spansExpectedDays('2026-01-08', '2026-01-08', 7), false);
  assert.equal(spansExpectedDays('2026-01-08', '2026-01-01', 7), false);
});

console.log('\n-- archiveMetrics: no lookahead --');

// A series whose future is wildly different from its past. If any feature
// leaks, appending the future changes the value computed at the same index.
function syntheticBars(n, fn, startDate = '2020-01-01') {
  const base = Date.parse(`${startDate}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => ({
    date: new Date(base + i * 86400000).toISOString().slice(0, 10),
    close: fn(i),
    volume: 1000 + i
  }));
}

test('features at bar i are unchanged by any bar after i', () => {
  const rand = mulberry32(11);
  const past = syntheticBars(400, (i) => 100 * Math.exp(0.001 * i) * (1 + 0.02 * (rand() - 0.5)));
  // Same first 400 bars, then a violent future.
  const rand2 = mulberry32(99);
  const withFuture = past.concat(syntheticBars(200, (i) => 5000 * (1 + 0.3 * (rand2() - 0.5)), '2021-02-04'));

  const i = 350;
  const a = archiveMetrics('T', past, i);
  const b = archiveMetrics('T', withFuture, i);
  assert.ok(a && b, 'both must produce metrics at the same index');
  for (const f of XS_FEATURES) {
    const va = f.get(a), vb = f.get(b);
    assert.deepEqual(va, vb, `feature ${f.id} leaked future information (${va} vs ${vb})`);
  }
});

test('refuses to produce metrics before the warmup is satisfied', () => {
  const bars = syntheticBars(400, (i) => 100 + i);
  assert.equal(archiveMetrics('T', bars, XS_WARMUP_BARS - 2), null);
  assert.ok(archiveMetrics('T', bars, XS_WARMUP_BARS - 1), 'exactly at the warmup boundary must work');
});

console.log('\n-- buildWeeklyCrossSections --');

function panelOf(symbols, n, priceFn, opts = {}) {
  const rows = [];
  for (const s of symbols) {
    for (const b of syntheticBars(n, (i) => priceFn(s, i))) {
      if (opts.skip && opts.skip(s, b.date)) continue;
      rows.push({ symbol: s, date: b.date, close: b.close, volume: b.volume });
    }
  }
  return groupBars(rows);
}

test('anchors cross-sections on shared calendar dates, not per-symbol bar counts', () => {
  const symbols = Array.from({ length: 40 }, (_, k) => `S${k}`);
  const rand = mulberry32(5);
  // Every third symbol is missing a scattered set of days, so bar INDEX
  // anchoring would stagger them apart. Calendar anchoring must not.
  const bars = panelOf(symbols, 500, (s, i) => 100 * (1 + 0.01 * Math.sin(i / 9 + s.length)) + rand(),
    { skip: (s, date) => Number(s.slice(1)) % 3 === 0 && date.endsWith('07') });
  const sections = buildWeeklyCrossSections(bars, 7, 20);
  assert.ok(sections.length > 0, 'expected some cross-sections');
  const widths = sections.map((s) => s.members.length);
  const median = widths.sort((a, b) => a - b)[Math.floor(widths.length / 2)];
  assert.ok(median >= 30, `median cross-section width ${median} — gap-pattern staggering has returned`);
});

test('drops a symbol whose forward window jumps a gap', () => {
  const symbols = Array.from({ length: 30 }, (_, k) => `S${k}`);
  // S0 is missing an entire month right after the anchor region.
  const bars = panelOf(symbols, 500, (s, i) => 100 + i * 0.1,
    { skip: (s, date) => s === 'S0' && date >= '2021-02-01' && date <= '2021-03-05' });
  const sections = buildWeeklyCrossSections(bars, 7, 30);
  for (const section of sections) {
    for (const m of section.members) {
      assert.ok(Math.abs(m.forward) < 500, `implausible forward return ${m.forward}% survived the gap guard`);
    }
  }
});

test('emits no cross-section narrower than the universe minimum', () => {
  const bars = panelOf(['A', 'B', 'C'], 500, (s, i) => 100 + i);
  assert.deepEqual(buildWeeklyCrossSections(bars, 7, 20), [],
    `${XS_MIN_UNIVERSE} names are required before a percentile means anything`);
});

console.log('\n-- fitCoefficients: the refusals that matter --');

test('refuses to fit pure noise, however many features are offered', () => {
  const symbols = Array.from({ length: 60 }, (_, k) => `S${k}`);
  // Independent random walks: there is nothing to find, by construction.
  const seeds = new Map(symbols.map((s, k) => [s, mulberry32(2024 + k * 131)]));
  const state = new Map();
  const bars = panelOf(symbols, 900, (s) => {
    const prev = state.get(s) ?? 100;
    const next = prev * (1 + 0.05 * (seeds.get(s)() - 0.5));
    state.set(s, next);
    return next;
  });
  const sections = buildWeeklyCrossSections(bars, 7, 90);
  const fit = fitCoefficients(sections, { minWeeks: 60 });
  assert.equal(fit.ok, false, `noise produced a "significant" feature: ${JSON.stringify(fit.selected)}`);
  for (const c of Object.values(fit.coefficients)) {
    assert.equal(c.selected, false);
  }
});

test('recovers a planted cross-sectional signal', () => {
  // Momentum is made real: each symbol's next-week return is a deterministic
  // function of its own trailing 7-day return, plus noise. A working fitter
  // must find mom_7d; a broken one will not.
  const symbols = Array.from({ length: 60 }, (_, k) => `S${k}`);
  const rand = mulberry32(7);
  const n = 900;
  const series = new Map();
  for (const s of symbols) {
    const px = [100];
    for (let i = 1; i < n; i++) {
      const look = Math.max(0, i - 7);
      const trailing = px[i - 1] / px[look] - 1;
      // Persistent drift proportional to trailing return: genuine momentum.
      const drift = 0.35 * trailing / 7;
      px.push(px[i - 1] * (1 + drift + 0.012 * (rand() - 0.5)));
    }
    series.set(s, px);
  }
  const rows = [];
  for (const [s, px] of series) {
    const bars = syntheticBars(n, (i) => px[i]);
    for (const b of bars) rows.push({ symbol: s, date: b.date, close: b.close, volume: b.volume });
  }
  const sections = buildWeeklyCrossSections(groupBars(rows), 7, 90);
  const fit = fitCoefficients(sections, { minWeeks: 60 });
  assert.equal(fit.ok, true, 'a planted momentum effect was not detected at all');
  const mom = fit.coefficients.mom_7d;
  assert.ok(mom.beta > 0, `planted momentum must fit a POSITIVE beta, got ${mom.beta}`);
  assert.ok(fit.selected.length > 0);
});

test('the significance bar tightens as more features are searched', () => {
  assert.ok(bonferroniZ(20) > bonferroniZ(5), 'searching more features must demand a higher t');
  assert.ok(Math.abs(normalInvCdf(0.975) - 1.959964) < 1e-4, 'inverse normal is miscalibrated');
  assert.ok(bonferroniZ(14) > 2.8 && bonferroniZ(14) < 3.1, `z for 14 tests looks wrong: ${bonferroniZ(14)}`);
});

test('abstains when the estimation window is too short to mean anything', () => {
  const symbols = Array.from({ length: 40 }, (_, k) => `S${k}`);
  const bars = panelOf(symbols, 400, (s, i) => 100 + i * 0.05);
  const sections = buildWeeklyCrossSections(bars, 7, 10);
  const fit = fitCoefficients(sections);
  assert.equal(fit.ok, false);
  assert.match(fit.reason, /insufficient cross-sections/);
});

console.log('\n-- xsForecast / publication gate --');

test('an unselected feature is inert, not merely down-weighted', () => {
  const ranks = { mom_7d: 0.5, rsi: 0.5 };
  const coefficients = {
    mom_7d: { alpha: 1, beta: 2, selected: true },
    rsi: { alpha: 100, beta: 100, selected: false }
  };
  const out = xsForecast(ranks, coefficients);
  assert.equal(out.expectedReturnPct, 1 + 2 * 0.5, 'the unselected feature contributed');
  assert.equal(out.featuresUsed, 1);
});

test('abstains rather than guessing when too few selected features are present', () => {
  const coefficients = {};
  for (const id of ['a', 'b', 'c', 'd', 'e']) coefficients[id] = { alpha: 0, beta: 1, selected: true };
  // Only one of five selected features is available: below the coverage floor.
  assert.equal(xsForecast({ a: 0.5 }, coefficients), null);
  const enough = { a: 0.5, b: 0.5, c: 0.5, d: 0.5 };
  assert.ok(xsForecast(enough, coefficients), 'four of five should clear the floor');
  assert.ok(XS_MIN_FEATURE_COVERAGE > 0.5);
});

test('returns null, never zero, when it cannot forecast', () => {
  assert.equal(xsForecast(null, {}), null);
  assert.equal(xsForecast({ a: 1 }, null), null);
  assert.equal(xsForecast({ a: 1 }, { a: { alpha: 0, beta: 1, selected: false } }), null);
});

test('buildXsPanel refuses a universe too small to rank', () => {
  const few = Array.from({ length: XS_MIN_UNIVERSE - 1 }, (_, i) => ({ symbol: `S${i}`, chg7d: i, price: 1 }));
  assert.equal(buildXsPanel(few), null);
});

test('percentiles are within-class and span the full range', () => {
  const forecasts = [{ expectedReturnPct: -3 }, { expectedReturnPct: 0 }, { expectedReturnPct: 9 }, null];
  const p = xsPercentiles(forecasts);
  assert.equal(p[0], 0); assert.equal(p[2], 100); assert.equal(p[3], null);
});

test('publication is fail-closed without matching evidence', () => {
  assert.equal(xsDecileIsPublishable(null, 'crypto', 7, 9), false);
  assert.equal(xsDecileIsPublishable({}, 'crypto', 7, 9), false);
  const thin = { 'crypto|7|9': { n: XS_PUBLICATION_MIN_SAMPLES - 1, tStat: 9 } };
  assert.equal(xsDecileIsPublishable(thin, 'crypto', 7, 9), false, 'a huge t on a thin sample must not publish');
});

test('a top decile that did not beat the universe cannot be published as a buy', () => {
  const wrongWay = { 'crypto|7|9': { n: 5000, tStat: -6 } };
  assert.equal(xsDecileIsPublishable(wrongWay, 'crypto', 7, 9), false,
    'a significantly INVERTED top decile is a warning, not a licence');
  const right = { 'crypto|7|9': { n: 5000, tStat: XS_PUBLICATION_MIN_T + 0.1 } };
  assert.equal(xsDecileIsPublishable(right, 'crypto', 7, 9), true);
});

test('a bottom decile publishes only when it genuinely underperformed', () => {
  assert.equal(xsDecileIsPublishable({ 'crypto|7|0': { n: 5000, tStat: -3 } }, 'crypto', 7, 0), true);
  assert.equal(xsDecileIsPublishable({ 'crypto|7|0': { n: 5000, tStat: 3 } }, 'crypto', 7, 0), false);
});

console.log(`\n${passed} assertions passed${process.exitCode ? ' (with failures above)' : ''}\n`);
