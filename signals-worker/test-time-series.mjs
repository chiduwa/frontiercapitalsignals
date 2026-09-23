import test from 'node:test';
import assert from 'node:assert/strict';
import {
  barReturns, nextSessionDates, nelderMead, fitGarch, garchFilter, garchVariancePath,
  weekdayVarianceFactors, weekdayOf, fitAutoregression, autoregressionForecast,
  fitStructural, smoothStructural, sessionSeries, fisherGTest, varianceRatioTest,
  holmAdjust, weekdayMeanTest, trendDrift, timeSeriesPaths, describeTimeSeries
} from './scripts/time-series.mjs';
import { buildTimeSeriesSection } from './scripts/time-series-research.mjs';

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return (s + 0.5) / 4294967296; };
}
const normal = r => Math.sqrt(-2 * Math.log(r())) * Math.cos(2 * Math.PI * r());
const day = i => new Date(Date.UTC(2021, 0, 1 + i)).toISOString().slice(0, 10);

/**
 * GARCH(1,1) returns with an optional weekday variance multiplier. Return t is
 * dated by the bar that CLOSES it, day(t + 1) in barsFrom, so the multiplier is
 * looked up on that date -- the same convention barReturns uses.
 */
function garchSeries(n, { seed = 1, alpha = 0.08, beta = 0.9, longRun = 4e-4, weekday = null, ar = 0 } = {}) {
  const r = rng(seed), omega = longRun * (1 - alpha - beta), out = [];
  let s2 = longRun;
  for (let t = 0; t < n; t++) {
    const w = weekday ? weekday[weekdayOf(day(t + 1))] : 1;
    const e = Math.sqrt(s2) * normal(r);
    out.push(e * Math.sqrt(w) + (t ? ar * out[t - 1] : 0));
    s2 = omega + alpha * e * e + beta * s2;
  }
  return out;
}
const barsFrom = (returns, start = 100) => {
  let p = start;
  return [{ date: day(0), close: p }, ...returns.map((x, i) => ({ date: day(i + 1), close: (p *= Math.exp(x)) }))];
};

test('nelder-mead finds the minimum of a shifted quadratic and treats NaN as rejection', () => {
  const f = x => (x[0] - 3) ** 2 + 2 * (x[1] + 1) ** 2;
  const o = nelderMead(f, [0, 0], { maxEvaluations: 500 });
  assert.ok(Math.abs(o.x[0] - 3) < 1e-3 && Math.abs(o.x[1] + 1) < 1e-3, JSON.stringify(o.x));
  const g = x => (x[0] < 0 ? NaN : (x[0] - 1) ** 2);
  assert.ok(Math.abs(nelderMead(g, [2], { maxEvaluations: 200 }).x[0] - 1) < 1e-3);
});

test('GARCH(1,1) recovers its parameters and the variance path decays to the long-run level', () => {
  const x = garchSeries(6000, { seed: 7 });
  const f = fitGarch(x);
  assert.equal(f.status, 'fitted');
  assert.ok(Math.abs(f.alpha - 0.08) < 0.03, `alpha ${f.alpha}`);
  assert.ok(Math.abs(f.beta - 0.9) < 0.04, `beta ${f.beta}`);
  assert.ok(f.persistence < 1 && f.halfLifeDays > 0);
  const path = garchVariancePath(4 * f.longRunVariance, f.persistence, f.longRunVariance, 400);
  assert.ok(path[0] > path[10] && path[10] > path[100], 'an elevated variance must decay');
  assert.ok(Math.abs(path[399] / f.longRunVariance - 1) < 0.01, 'and converge to the long-run level');
  // The filter's first variance is the target itself.
  assert.equal(garchFilter(x.slice(0, 5), f).sigma2[0], f.longRunVariance);
  assert.equal(fitGarch(x.slice(0, 20)).status, 'insufficient');
});

test('weekday factors recover a quiet weekend and are exactly 1 when there is no effect', () => {
  const n = 1400, dates = Array.from({ length: n }, (_, i) => day(i));
  const r = rng(9);
  const quiet = dates.map(d => ([0, 6].includes(weekdayOf(d)) ? Math.sqrt(0.5) : 1) * normal(r));
  const f = weekdayVarianceFactors(dates.map(weekdayOf), quiet.map(v => v * v));
  assert.ok(f.factors[6] < 0.75 && f.factors[0] < 0.75, `weekend ${f.factors[6]} ${f.factors[0]}`);
  assert.ok(f.factors[3] > 1.05, `midweek ${f.factors[3]}`);
  assert.ok(f.pValue < 1e-6);
  // Renormalized: the average weekday factor is 1, so the level is untouched.
  const avg = f.factors.reduce((s, v) => s + v, 0) / 7;
  assert.ok(Math.abs(avg - 1) < 0.02, `average ${avg}`);
  const r2 = rng(19);
  const flat = weekdayVarianceFactors(dates.map(weekdayOf), dates.map(() => normal(r2) ** 2));
  assert.ok(flat.factors.every(v => Math.abs(v - 1) < 1e-9), 'shrinkage must remove a noise-only pattern');
  assert.ok(flat.pValue > 0.05);
});

test('AR(p) by BIC recovers an AR(1) and picks the random walk on white noise', () => {
  const r = rng(11), x = [0];
  for (let t = 1; t < 3000; t++) x.push(-0.2 * x[t - 1] + 0.02 * normal(r));
  const m = fitAutoregression(x);
  assert.equal(m.order, 1);
  assert.ok(Math.abs(m.coefficients[0] + 0.2) < 0.05, `phi ${m.coefficients[0]}`);
  // One-step forecast is intercept + phi * last; a two-step one iterates.
  const one = autoregressionForecast(m, [0.01], 1);
  assert.ok(Math.abs(one - (m.intercept + m.coefficients[0] * 0.01)) < 1e-12);
  let zeros = 0;
  for (let s = 0; s < 30; s++) {
    const r2 = rng(100 + s);
    if (fitAutoregression(Array.from({ length: 1000 }, () => 0.02 * normal(r2))).order === 0) zeros++;
  }
  assert.ok(zeros >= 27, `white noise picked p=0 only ${zeros}/30 times`);
  // A corrupt print cannot set the coefficient by itself.
  const spiked = x.slice(0, 1500); spiked[700] = 30;
  const clipped = fitAutoregression(spiked);
  assert.ok(Math.abs(clipped.coefficients[0] + 0.2) < 0.08, `clipped phi ${clipped.coefficients[0]}`);
});

test('Fisher g holds its size under noise and finds a planted cycle', () => {
  let rejections = 0;
  for (let s = 0; s < 200; s++) {
    const r = rng(1000 + s);
    if (fisherGTest(Array.from({ length: 1000 }, () => normal(r))).pValue < 0.05) rejections++;
  }
  assert.ok(rejections / 200 < 0.1, `null rejection ${rejections / 200}`);
  const r = rng(5);
  const planted = fisherGTest(Array.from({ length: 1000 }, (_, t) => normal(r) + 0.35 * Math.sin(2 * Math.PI * t / 30)));
  assert.ok(Math.abs(planted.period - 30) < 1.5 && planted.pValue < 1e-4, JSON.stringify(planted));
});

test('variance ratio: robust size under GARCH noise, detects reversal, reduces to the classical variance', () => {
  let rejections = 0;
  for (let s = 0; s < 200; s++) if (varianceRatioTest(garchSeries(1000, { seed: 500 + s, alpha: 0.1, beta: 0.85 }), 5).pValue < 0.05) rejections++;
  assert.ok(rejections / 200 < 0.1, `null rejection ${rejections / 200}`);
  const r = rng(9), x = [0];
  for (let t = 1; t < 1000; t++) x.push(-0.2 * x[t - 1] + 0.01 * normal(r));
  const vr = varianceRatioTest(x, 5);
  assert.ok(vr.ratio < 0.8 && vr.z < -3, JSON.stringify(vr));
  // Constant squared deviations make every delta(j) exactly 1/n, so the robust
  // variance must equal the homoskedastic 2(2q-1)(q-1)/(3qn).
  const n = 800, q = 5;
  const alt = Array.from({ length: n }, (_, t) => (t % 2 ? 0.01 : -0.01));
  const res = varianceRatioTest(alt, q);
  const classical = 2 * (2 * q - 1) * (q - 1) / (3 * q * n);
  const impliedTheta = ((res.ratio - 1) / res.z) ** 2;
  assert.ok(Math.abs(impliedTheta / classical - 1) < 0.02, `theta ${impliedTheta} vs ${classical}`);
});

test('holm adjustment is monotone, capped at 1 and ignores missing values', () => {
  const adj = holmAdjust([0.01, 0.04, null, 0.03, 0.5]);
  assert.deepEqual(adj.map(v => (v == null ? null : Number(v.toFixed(4)))), [0.04, 0.09, null, 0.09, 0.5]);
  assert.ok(holmAdjust([0.9, 0.8]).every(v => v <= 1));
});

test('session series treats a missing day as missing, and business calendars skip weekends', () => {
  const bars = [{ date: '2021-01-04', close: 1 }, { date: '2021-01-06', close: 2 }];
  const cal = sessionSeries(bars, 'calendar');
  assert.deepEqual(cal.dates, ['2021-01-04', '2021-01-05', '2021-01-06']);
  assert.ok(Number.isNaN(cal.y[1]));
  const biz = sessionSeries([{ date: '2021-01-08', close: 1 }, { date: '2021-01-11', close: 2 }], 'business');
  assert.deepEqual(biz.dates, ['2021-01-08', '2021-01-11'], 'Friday to Monday is one step');
  assert.deepEqual(nextSessionDates('2021-01-08', 2, 'business'), ['2021-01-11', '2021-01-12']);
  assert.deepEqual(nextSessionDates('2021-01-08', 2, 'calendar'), ['2021-01-09', '2021-01-10']);
});

test('structural model recovers a planted weekly pattern and its components add back to the data', () => {
  const r = rng(3), pattern = [0.004, -0.002, -0.003, 0.001, 0.002, 0.003, -0.005];
  const pm = pattern.reduce((s, v) => s + v, 0) / 7, pat = pattern.map(v => v - pm);
  let level = 0;
  const y = [];
  for (let t = 0; t < 700; t++) { level += 0.0003 + 0.01 * normal(r); y.push(level + pat[t % 7] + 0.004 * normal(r)); }
  const fit = fitStructural(Float64Array.from(y), { period: 7, maxEvaluations: 400 });
  assert.equal(fit.status, 'fitted');
  const sm = smoothStructural(Float64Array.from(y), fit);
  const est = sm.seasonal.slice(300, 307), truth = Array.from({ length: 7 }, (_, i) => pat[(300 + i) % 7]);
  const corr = (a, b) => {
    const ma = a.reduce((s, v) => s + v, 0) / a.length, mb = b.reduce((s, v) => s + v, 0) / b.length;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < a.length; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
    return num / Math.sqrt(da * db);
  };
  assert.ok(corr(est, truth) > 0.9, `seasonal correlation ${corr(est, truth)}`);
  for (const t of [10, 350, 699]) {
    const back = sm.trend[t] + sm.seasonal[t] + sm.cycle[t] + sm.irregular[t];
    assert.ok(Math.abs(back - y[t]) < 1e-9, 'trend + seasonal + cycle + irregular must equal the data');
  }
});

test('walk-forward paths never read a bar after the date they are keyed on', () => {
  // Real autocorrelation, so BIC picks AR order >= 1 and an AR forecast that
  // peeked at tomorrow would actually change.
  const x = garchSeries(700, { seed: 21, weekday: [0.4, 1.3, 1.1, 1.1, 1.1, 1.1, 0.5], ar: -0.3 });
  const bars = barsFrom(x);
  const opts = { structuralEvaluations: 60, structuralRefitEvery: 126 };
  const full = timeSeriesPaths({ symbol: 'T', assetClass: 'crypto', bars }, opts);
  // A one-bar peek is invisible unless the series is cut exactly AT a refit
  // boundary, so cut at and just before both schedules' boundaries.
  // GARCH/AR refit once 250 returns exist, then every 21: return j = 249, 270.
  // Return j closes bar j+1, so bars.slice(0, j + 2) ends on return j.
  const garchCuts = [249, 270].flatMap(j => [j + 2, j + 1]);
  // The structural model refits at session 252, then every 126 sessions.
  const structuralCuts = [252, 378].flatMap(t => [t + 1, t]);
  let compared = 0;
  for (const n of [...garchCuts, ...structuralCuts, 520]) {
    const cut = timeSeriesPaths({ symbol: 'T', assetClass: 'crypto', bars: bars.slice(0, n) }, opts);
    for (const [date, row] of cut) {
      const later = full.get(date);
      assert.ok(later, `date ${date} missing from the full run`);
      for (const model of Object.keys(row)) {
        for (const h of Object.keys(row[model])) {
          assert.ok(Math.abs(row[model][h] - later[model][h]) < 1e-12,
            `${model} h=${h} at ${date} changed when bars after it were appended (cut ${n})`);
          compared++;
        }
      }
    }
  }
  assert.ok(compared > 5000, `only ${compared} forecasts compared`);
  for (const model of ['garchVol', 'garchWeekdayVol', 'harWeekdayVol', 'arima', 'structural']) {
    assert.ok([...full.values()].some(row => row[model]), `${model} produced no forecasts`);
  }
  // Cached per asset object: the second lane pays nothing.
  const asset = { symbol: 'C', assetClass: 'crypto', bars: bars.slice(0, 300) };
  assert.equal(timeSeriesPaths(asset, opts), timeSeriesPaths(asset, opts));
});

test('seasonal HAR deseasonalizes its inputs and reseasonalizes for the target session', () => {
  // Deterministic: every return is 2% x sqrt(its weekday factor), alternating
  // sign. Deseasonalized, every return is the same size, so the HAR blend is
  // flat and a Monday forecast over a Saturday forecast is sqrt(f_Mon / f_Sat)
  // exactly. Skip the deseasonalizing step and the blend drags the size of the
  // LAST day into the forecast, which breaks that ratio.
  const f = [0.4, 1.3, 1.1, 1.1, 1.1, 1.1, 0.5];
  const returns = Array.from({ length: 600 }, (_, t) => (t % 2 ? 1 : -1) * 0.02 * Math.sqrt(f[weekdayOf(day(t + 1))]));
  const paths = timeSeriesPaths({ symbol: 'H', assetClass: 'crypto', bars: barsFrom(returns) }, { structural: false });
  const byTarget = Array.from({ length: 7 }, () => []);
  for (const [date, row] of paths) {
    if (!row.harWeekdayVol) continue;
    byTarget[weekdayOf(nextSessionDates(date, 1, 'calendar')[0])].push(row.harWeekdayVol[1]);
  }
  const avg = xs => xs.reduce((a, v) => a + v, 0) / xs.length;
  const ratio = avg(byTarget[1]) / avg(byTarget[6]);
  const expected = Math.sqrt(f[1] / f[6]);
  assert.ok(Math.abs(ratio / expected - 1) < 0.03, `Mon/Sat ratio ${ratio} vs ${expected}`);
});

test('describeTimeSeries: statuses, a band for the session on or after the report date, no direction field', () => {
  const x = garchSeries(900, { seed: 31, weekday: [0.4, 1.3, 1.1, 1.1, 1.1, 1.1, 0.5] });
  const bars = barsFrom(x);
  const last = bars[bars.length - 1].date;
  const later = new Date(Date.parse(last + 'T00:00:00Z') + 2 * 86400000).toISOString().slice(0, 10);
  const d = describeTimeSeries(bars, { assetClass: 'crypto', asOf: later });
  assert.equal(d.status, 'measured');
  assert.equal(d.variations.nextSession, later, 'the band targets the report date, not a closed session');
  assert.equal(d.variations.stepsAhead, 2);
  assert.ok(d.variations.band.lowerPct < 0 && d.variations.band.upperPct > 0);
  assert.ok(d.seasonality.volatility.pValue < 0.01, 'the planted weekend must be detected');
  assert.equal(d.seasonality.volatility.calmest, 'Sun');
  const text = JSON.stringify(d);
  assert.ok(!/"(direction|dir|side|call)":\s*-?1\b/.test(text), 'no numeric direction vote may appear');
  const stale = describeTimeSeries(bars, { asOf: new Date(Date.parse(last + 'T00:00:00Z') + 10 * 86400000).toISOString().slice(0, 10) });
  assert.equal(stale.status, 'stale');
  assert.equal(stale.variations.band, null, 'no band for an archive ten days behind');
  assert.equal(stale.variations.bandWithheld, 'archive-behind');
  assert.ok(stale.seasonality.volatility.pValue < 0.01, 'the descriptive readings survive staleness');
  assert.equal(describeTimeSeries(bars.slice(0, 100)).status, 'insufficient-history');
  assert.ok(trendDrift(x.slice(0, 90)).pValue > 0, 'drift reports a p-value');
  assert.ok(weekdayMeanTest(x, bars.slice(1).map(b => b.date)).pValue > 0.001, 'no planted direction effect');
});

test('the section covers the market and every tracked asset, and corrects each family across them', () => {
  const assets = ['BTC', 'ETH', 'SOL', 'XLM', 'XRP', 'HYPE', 'HBAR', 'ARB'].map((symbol, i) => ({
    symbol, assetClass: 'crypto', bars: barsFrom(garchSeries(600, { seed: 40 + i }))
  }));
  assets.push({ symbol: 'MCAP:BROAD', assetClass: 'market', bars: barsFrom(garchSeries(600, { seed: 90 })) });
  const panel = { asOf: '2022-09-01', assets };
  const section = buildTimeSeriesSection(panel, { asOf: '2022-09-01' });
  assert.equal(section.actionable, false);
  assert.deepEqual(Object.keys(section.assets).sort(),
    ['ARB', 'BTC', 'ETH', 'HBAR', 'HYPE', 'MCAP:BROAD', 'SOL', 'SPY', 'XLM', 'XRP'].sort());
  assert.equal(section.assets.SPY.status, 'no-archive', 'a missing series is reported, not skipped');
  const measured = Object.values(section.assets).filter(a => a.seasonality);
  for (const a of measured) {
    const v = a.seasonality.volatility;
    if (v.pValue != null) assert.ok(v.adjustedP >= v.pValue - 1e-12, 'Holm never lowers a p-value');
    assert.equal(v.familySize, measured.length);
    for (const w of a.trend.windows) {
      if (w.status) continue;
      assert.equal(w.distinguishable, w.adjustedP < 0.05, 'a trend clears noise only after correction');
    }
  }
  assert.equal(section.evidence.crypto1d.status, 'not-computed', 'no zoo supplied -> nothing borrowed');
});
