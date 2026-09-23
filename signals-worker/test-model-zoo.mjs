import test from 'node:test';
import assert from 'node:assert/strict';
import {
  rank, pearson, spearman, clusteredT, ewmaVol, harComponents, MODELS,
  cohortOf, liquidityTier, scoreDirection, scoreMagnitude, scoreField,
  scoreByCohort, selectionPersistence, mean
} from './scripts/model-zoo.mjs';

const day = i => new Date(Date.UTC(2021, 0, 1 + i)).toISOString().slice(0, 10);
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const normal = r => {
  const u = Math.max(r(), 1e-12), v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

test('rank averages ties and spearman recovers a monotone but non-linear map', () => {
  assert.deepEqual(rank([10, 20, 30]), [1, 2, 3]);
  assert.deepEqual(rank([5, 5, 9]), [1.5, 1.5, 3]);
  assert.deepEqual(rank([7, 7, 7, 7]), [2.5, 2.5, 2.5, 2.5]);
  // y = x^3 is perfectly monotone: Spearman must be exactly 1 where Pearson is not.
  const x = [1, 2, 3, 4, 5, 6, 7, 8];
  const y = x.map(v => v ** 3);
  assert.ok(Math.abs(spearman(x, y) - 1) < 1e-12, `spearman ${spearman(x, y)}`);
  assert.ok(pearson(x, y) < 0.98, 'pearson must be dragged down by the curvature');
  // Reversed order is exactly -1.
  assert.ok(Math.abs(spearman(x, y.slice().reverse()) + 1) < 1e-12);
});

test('clusteredT counts a day once, not once per asset', () => {
  // 200 assets, 5 dates, every asset identical within a date. The information
  // content is 5 observations; a naive t would see 1000 and inflate by ~14x.
  const rows = [];
  for (let d = 0; d < 5; d++) {
    for (let a = 0; a < 200; a++) rows.push({ date: day(d), v: d === 0 ? 1 : -0.1 });
  }
  const c = clusteredT(rows, r => r.v, { minClusters: 3 });
  assert.equal(c.clusters, 5, 'must cluster to 5 days');
  assert.ok(Math.abs(c.mean - mean([1, -0.1, -0.1, -0.1, -0.1])) < 1e-12);
  // The identical data scored per-row has n=1000 and the same mean, so its t is
  // inflated by sqrt(1000/5) ~ 14x purely by counting one day 200 times.
  const vals = rows.map(r => r.v);
  const m = mean(vals);
  const popSd = Math.sqrt(mean(vals.map(v => (v - m) ** 2)));
  const naive = m / (popSd / Math.sqrt(vals.length));
  assert.ok(Math.abs(naive) > 5 * Math.abs(c.t),
    `naive t ${naive} must dwarf clustered t ${c.t}`);
  assert.equal(clusteredT(rows, r => r.v, { minClusters: 99 }).t, null, 'too few clusters -> no t');
});

test('ewma and HAR volatility behave as their definitions require', () => {
  // A constant-magnitude series has volatility equal to that magnitude.
  const flat = Array(200).fill(0.02).map((v, i) => (i % 2 ? v : -v));
  assert.ok(Math.abs(ewmaVol(flat) - 0.02) < 1e-6, `ewma ${ewmaVol(flat)}`);
  // EWMA must react to a regime change faster than a long window average.
  const calm = Array(200).fill(0.001).map((v, i) => (i % 2 ? v : -v));
  const shocked = calm.concat(Array(10).fill(0.05).map((v, i) => (i % 2 ? v : -v)));
  assert.ok(ewmaVol(shocked) > 5 * ewmaVol(calm), 'EWMA must respond to the shock');
  // HAR components: with a flat series all three horizons agree.
  const h = harComponents(flat);
  assert.ok(Math.abs(h.d - h.w) < 1e-9 && Math.abs(h.w - h.m) < 1e-9);
  assert.equal(harComponents(Array(5).fill(0.01)), null, 'HAR needs 22 observations');
});

test('a model is scored only on the skill it claims', () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({
    symbol: 'A', date: day(i), actual: i % 2 ? 1 : -1, volPct: 2, returns: [], horizon: 1
  }));
  // trailingVol claims magnitude only -- asking it for direction returns null,
  // it is never silently treated as a directional bet.
  assert.equal(scoreDirection(rows, MODELS.trailingVol), null);
  assert.ok(scoreMagnitude(rows, MODELS.trailingVol) !== null);
  // momentum claims direction only.
  assert.equal(scoreMagnitude(rows, MODELS.momentum), null);
  // The zero model forecasts a constant, so it has NO ordering information.
  // Reporting Spearman 0 would be wrong; it must be null.
  const z = scoreMagnitude(rows, MODELS.zero);
  assert.equal(z.spearman, null, 'a constant forecast cannot rank anything');
});

test('magnitude scoring rewards ordering, not level', () => {
  const r = rng(42);
  const rows = [];
  for (let i = 0; i < 600; i++) {
    const size = 1 + 4 * r();           // the truth we want ranked
    const actual = size * (r() < 0.5 ? -1 : 1);
    rows.push({ symbol: 'A', date: day(i), actual, volPct: size * 100, returns: [], horizon: 1 });
  }
  const s = scoreMagnitude(rows, MODELS.trailingVol);
  // volPct is 100x the true size: the LEVEL is badly wrong, the ORDER is exact.
  assert.ok(Math.abs(s.spearman - 1) < 1e-9, `spearman ${s.spearman}`);
  assert.ok(s.meanAbsoluteError > 50, 'and the level error is enormous, as it should be');
});

test('a hit rate above 50% with zero net return is reported as both', () => {
  // Wins are small, losses are large: 60% hit, negative money. This is the
  // shape the survivorship artifact had on liquid assets, and the reason
  // hitRate alone is never sufficient.
  const rows = [];
  for (let i = 0; i < 500; i++) {
    const win = i % 10 < 6;
    rows.push({ symbol: 'A', date: day(i), actual: win ? 0.5 : -2.0, hier: 1 });
  }
  const s = scoreDirection(rows, MODELS.hierarchical, { costPct: 0 });
  assert.ok(Math.abs(s.hitRate - 0.6) < 1e-9, `hit ${s.hitRate}`);
  assert.ok(s.netPct < 0, `net must be negative, got ${s.netPct}`);
});

test('cohorts split on listing date, and scoreByCohort refuses a pooled headline', () => {
  assert.equal(cohortOf('2020-01-01', '2021-01-01'), 'established');
  assert.equal(cohortOf('2021-06-01', '2021-01-01'), 'recent');
  assert.equal(cohortOf(null, '2021-01-01'), 'unknown');
  assert.equal(liquidityTier(5e8), 'deep');
  assert.equal(liquidityTier(5e7), 'liquid');
  assert.equal(liquidityTier(5e6), 'thin');
  assert.equal(liquidityTier(5e5), 'microcap');

  // Reproduce the 2026 shape: the `recent` cohort carries a large fake edge,
  // the `established` cohort carries none. The report must keep them apart.
  const rows = [];
  for (let i = 0; i < 400; i++) {
    rows.push({ symbol: 'OLD', date: day(i), cohort: 'established', actual: i % 2 ? 1 : -1, hier: 1 });
    rows.push({ symbol: 'NEW', date: day(i), cohort: 'recent', actual: i % 10 < 8 ? 1 : -1, hier: 1 });
  }
  const out = scoreByCohort(rows, { costPct: 0 });
  assert.equal(out.actionable, false);
  assert.ok(out.byCohort.established && out.byCohort.recent);
  assert.ok(Math.abs(out.byCohort.established.field.hierarchical.direction.hitRate - 0.5) < 1e-9);
  assert.ok(Math.abs(out.byCohort.recent.field.hierarchical.direction.hitRate - 0.8) < 1e-9);
  assert.equal(out.byCohort.pooled, undefined, 'there must be no pooled headline to quote');
});

test('per-asset selection is refused unless the RANK correlation persists', () => {
  // Case 1: the better model per asset is pure noise across halves.
  const r = rng(7);
  const noisy = [];
  for (let a = 0; a < 40; a++) {
    for (let i = 0; i < 400; i++) {
      const actual = normal(r);
      noisy.push({ symbol: `N${a}`, date: day(i), actual,
        hier: normal(r), adap: normal(r) });
    }
  }
  const bad = selectionPersistence(noisy, MODELS.hierarchical, MODELS.adaptive, 'direction',
    { minPerAsset: 300, threshold: 0.2 });
  assert.equal(bad.selectable, false, `noise must not be selectable (rho=${bad.spearman})`);
  assert.ok(Math.abs(bad.spearman) < 0.35, `rho ${bad.spearman} should be near zero`);

  // Case 2: a genuine, stable per-asset split -- half the assets are always
  // predicted well by `hier`, half always by `adap`, in BOTH halves.
  const stable = [];
  for (let a = 0; a < 40; a++) {
    const hierOwns = a % 2 === 0;
    for (let i = 0; i < 400; i++) {
      const actual = normal(r);
      const good = Math.sign(actual) || 1;
      const bad2 = r() < 0.5 ? 1 : -1;
      stable.push({ symbol: `S${a}`, date: day(i), actual,
        hier: hierOwns ? good : bad2, adap: hierOwns ? bad2 : good });
    }
  }
  const good = selectionPersistence(stable, MODELS.hierarchical, MODELS.adaptive, 'direction',
    { minPerAsset: 300, threshold: 0.2 });
  assert.equal(good.selectable, true, `a real split must be selectable (rho=${good.spearman})`);
  assert.ok(good.spearman > 0.6, `rho ${good.spearman}`);

  assert.equal(selectionPersistence([], MODELS.hierarchical, MODELS.adaptive, 'direction').selectable,
    false, 'no data is not a licence to select');
});

test('scoreField covers every declared model and never invents a skill', () => {
  const rows = Array.from({ length: 300 }, (_, i) => ({
    symbol: 'A', date: day(i), actual: normal(rng(i + 1)), volPct: 3,
    returns: Array.from({ length: 40 }, (_, k) => 0.01 * Math.sin(k)),
    horizon: 1, hier: 0.4, adap: -0.3, return1: 0.2, return5: -0.1
  }));
  const field = scoreField(rows);
  for (const [name, model] of Object.entries(MODELS)) {
    assert.ok(field[name], `${name} missing from the field`);
    assert.deepEqual(field[name].skills, model.skills);
    if (!model.skills.includes('direction')) assert.equal(field[name].direction, null);
    if (!model.skills.includes('magnitude')) assert.equal(field[name].magnitude, null);
  }
});

// ---------------------------------------------------------------------------
// Time-series candidates (2026-09-23)
// ---------------------------------------------------------------------------
import {
  qlike, magnitudeHeadToHead, intervalComparison, medianDollarVolume as dollarVolume,
  TIME_SERIES_COMPARISONS, INTERVAL_SCALES
} from './scripts/model-zoo.mjs';
import { compactZoo } from './scripts/hierarchical-research.mjs';

test('the time-series candidates declare the skills they are scored on', () => {
  for (const m of ['garchVol', 'garchWeekdayVol', 'harWeekdayVol']) assert.deepEqual(MODELS[m].skills, ['magnitude']);
  for (const m of ['arima', 'structural']) assert.deepEqual(MODELS[m].skills, ['direction']);
  // A missing time-series forecast is "no forecast", never a zero-size or a flat call.
  assert.equal(MODELS.garchVol.magnitude({}), null);
  assert.equal(MODELS.arima.direction({}), 0);
  for (const [candidate, incumbent] of TIME_SERIES_COMPARISONS) assert.ok(MODELS[candidate] && MODELS[incumbent]);
  assert.ok(INTERVAL_SCALES.includes('trailingVol'), 'the band test must include the production scale');
});

test('QLIKE is minimised by the true variance and punishes under-forecasting hardest', () => {
  const r = rng(3), sigma = 2;
  const draws = Array.from({ length: 20000 }, () => sigma * normal(r));
  const loss = s => mean(draws.map(a => qlike(s, a)));
  assert.ok(loss(sigma) < loss(sigma * 0.8) && loss(sigma) < loss(sigma * 1.25));
  assert.ok(loss(sigma * 0.5) - loss(sigma) > loss(sigma * 2) - loss(sigma), 'halving must cost more than doubling');
  assert.equal(qlike(0, 1), null, 'a zero variance forecast has no QLIKE');
});

test('head-to-head scores both models on the SAME rows only, clustered by date', () => {
  const r = rng(8), rows = [];
  for (let d = 0; d < 60; d++) {
    for (let a = 0; a < 20; a++) {
      const vol = 1 + (a % 5);
      rows.push({ date: day(d), actual: vol * normal(r), good: vol, bad: 1,
        // The candidate is missing on a third of rows; those rows must not count.
        sparse: a % 3 ? vol : null });
    }
  }
  const good = { skills: ['magnitude'], magnitude: x => x.good };
  const bad = { skills: ['magnitude'], magnitude: x => x.bad };
  const sparse = { skills: ['magnitude'], magnitude: x => x.sparse };
  const h = magnitudeHeadToHead(rows, good, bad);
  assert.ok(h.qlikeDifference < 0 && h.qlikeT < -3, `good must beat bad: ${h.qlikeT}`);
  assert.ok(h.spearmanCandidate > h.spearmanIncumbent);
  assert.ok(h.firstHalf.clusters + h.secondHalf.clusters === h.clusters, 'halves partition the dates');
  const s = magnitudeHeadToHead(rows, sparse, bad);
  assert.equal(s.forecasts, rows.filter(x => x.sparse != null).length, 'only rows where both forecast');
  assert.equal(magnitudeHeadToHead(rows.slice(0, 10), good, bad).status, 'insufficient');
});

test('the band test hits its nominal coverage and exposes a weekday-blind scale', () => {
  // True vol is half as large on Saturday and Sunday. A scale that knows this
  // covers every weekday evenly; one that does not over-covers weekends.
  const r = rng(12), rows = [];
  for (let a = 0; a < 8; a++) {
    for (let d = 0; d < 700; d++) {
      const date = day(d);
      const next = new Date(Date.parse(date + 'T00:00:00Z') + 86400000).getUTCDay();
      const vol = (next === 0 || next === 6) ? 1 : 2;
      rows.push({ symbol: 'A' + a, date, horizon: 1, actual: vol * normal(r), aware: vol, blind: 1.7 });
    }
  }
  const models = {
    aware: { skills: ['magnitude'], magnitude: x => x.aware },
    blind: { skills: ['magnitude'], magnitude: x => x.blind }
  };
  const out = intervalComparison(rows, ['aware', 'blind'], { models });
  for (const m of ['aware', 'blind']) assert.ok(Math.abs(out.models[m].coverage - 0.8) < 0.02, `${m} coverage ${out.models[m].coverage}`);
  assert.ok(out.models.aware.weekdayCoverageSpread < 0.05, `aware spread ${out.models.aware.weekdayCoverageSpread}`);
  assert.ok(out.models.blind.weekdayCoverageSpread > 0.1, `blind spread ${out.models.blind.weekdayCoverageSpread}`);
  // What the weekday factor buys is CONDITIONAL coverage. For a scale mixture
  // the average width barely moves (2 x 1.28 x E[sigma] against the blind
  // band's mixture quantile), so the claim is "calibrated at no extra width",
  // not "narrower" -- which is also what the archive showed.
  assert.ok(out.models.aware.meanWidthPct <= out.models.blind.meanWidthPct * 1.03,
    `aware ${out.models.aware.meanWidthPct} vs blind ${out.models.blind.meanWidthPct}`);
});

test('dollar volume: equity volume is shares, crypto volume is already dollars', () => {
  const bars = Array.from({ length: 60 }, (_, i) => ({ date: day(i), close: 80000, volume: 2e10 }));
  assert.equal(dollarVolume(bars, 400, { quoteDenominated: true }), 2e10, 'BTC trades ~$20B/day, not 1.6e15');
  assert.equal(dollarVolume(bars), 1.6e15, 'the share convention multiplies by price');
  assert.equal(liquidityTier(dollarVolume(bars, 400, { quoteDenominated: true })), 'deep');
});

test('the public summary keeps each comparison headline and drops the half-by-half detail', () => {
  const detail = { forecasts: 9, clusters: 9, spearmanCandidate: 0.3, spearmanIncumbent: 0.2, maeDifference: -0.1, maeT: -1,
    qlikeDifference: -0.2, qlikeT: -3, firstHalf: { qlikeT: -2, maeT: 0 }, secondHalf: { qlikeT: -2.5, maeT: 0 }, note: 'x' };
  const zoo = { byCohort: {}, timeSeries: { version: 'v', intervals: { established: {} },
    headToHead: { a_vs_b: { candidate: 'a', incumbent: 'b', question: 'q', byCohort: { established: detail, recent: { status: 'insufficient' } } } } } };
  const c = compactZoo(zoo);
  assert.deepEqual(c.timeSeries.headToHead.a_vs_b.byCohort.established,
    { forecasts: 9, spearmanCandidate: 0.3, spearmanIncumbent: 0.2, maeT: -1, qlikeT: -3, qlikeTFirstHalf: -2, qlikeTSecondHalf: -2.5 });
  assert.deepEqual(c.timeSeries.headToHead.a_vs_b.byCohort.recent, { status: 'insufficient' });
  assert.ok(c.timeSeries.intervals, 'the band test is kept whole');
  assert.equal(compactZoo(null), null);
});
