import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HIERARCHICAL_VERSION, buildAssetSample, fitAssetRegression, blockIncrementalTests,
  poolCoefficient, poolAcrossAssets, shrinkTowardPrior, createAccumulator,
  walkForwardPanel, poolOnlineEstimates, applyPrior, summarizeByDate
} from './scripts/hierarchical-model.mjs';
import {
  FEATURE_NAMES, FEATURE_BLOCKS, BLOCK_OF, OPTIONAL_BLOCKS, featureRow,
  usableColumns, pruneCollinear, independentColumns, asOfRow, sanitizeBars,
  EXPERIMENTAL_BLOCKS, EXPERIMENTAL_BLOCKS_ENABLED
} from './scripts/panel-features.mjs';
import { varianceInflationFactors } from './scripts/regression-diagnostics.mjs';

const day = i => new Date(Date.UTC(2021, 0, 1 + i)).toISOString().slice(0, 10);
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
}
function gaussian(next) {
  const u = Math.max(next(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
}

/**
 * An AR(1) process in log returns. Because featureRow's `return1` is the prior
 * return divided by trailing volatility, and the target is the next return on
 * the same scale, `phi` IS the true coefficient on return1 -- so a test can
 * assert what the regression is supposed to recover.
 */
function arSeries(n, phi, seed, { volatility = 0.02 } = {}) {
  const next = rng(seed);
  let price = 100, previous = 0;
  const bars = [];
  for (let i = 0; i < n; i++) {
    const shock = gaussian(next) * volatility;
    const r = phi * previous + shock;
    price *= Math.exp(r);
    previous = r;
    bars.push({ date: day(i), close: price, volume: 1e6 * (1 + 0.1 * gaussian(next)) });
  }
  return bars;
}
const flat = (n, seed) => arSeries(n, 0, seed);

test('feature rows cover every lane, and a missing lane is flagged rather than imputed', () => {
  const bars = flat(200, 3);
  const bench = flat(200, 4);
  const benchmarkByDate = new Map(bench.map(b => [b.date, b.close]));
  const bare = featureRow(bars, 150, { assetClass: 'crypto' });
  assert.equal(bare.x.length, FEATURE_NAMES.length);
  assert.equal(bare.x[0], 1, 'intercept');

  // No benchmark, no derivatives, no supply -> those blocks are zero AND the
  // indicator is 1. A silent zero would assert "measured, and average".
  for (const block of OPTIONAL_BLOCKS) {
    assert.equal(bare.available[block], false, `${block} should be absent`);
    assert.equal(bare.x[FEATURE_NAMES.indexOf(`${block}Missing`)], 1);
    for (const f of FEATURE_BLOCKS[block]) assert.equal(bare.x[FEATURE_NAMES.indexOf(f)], 0);
  }
  // Price-derived blocks are always present and must actually vary.
  for (const block of ['momentum', 'volatility', 'volume', 'range']) {
    assert.equal(bare.available[block], true, `${block} should be present`);
  }
  const withMarket = featureRow(bars, 150, { benchmarkByDate, assetClass: 'crypto' });
  assert.equal(withMarket.available.market, true);
  assert.equal(withMarket.x[FEATURE_NAMES.indexOf('marketMissing')], 0);
  assert.notEqual(withMarket.x[FEATURE_NAMES.indexOf('market5')], 0);

  const derivatives = bars.map((b, i) => ({ date: b.date, oi_usd_close: 1e9 * (1 + 0.01 * i),
    taker_buy_sell_ratio: 1.05, all_account_ls: 1.2 + 0.001 * i }));
  const withDeriv = featureRow(bars, 150, { benchmarkByDate, derivatives, assetClass: 'crypto' });
  assert.equal(withDeriv.available.derivatives, true);
  assert.equal(withDeriv.x[FEATURE_NAMES.indexOf('derivativesMissing')], 0);
  assert.ok(withDeriv.x[FEATURE_NAMES.indexOf('oiChange1')] > 0, 'rising OI must read positive');

  assert.equal(featureRow(bars, 10), null, 'too little history returns null, never a guess');
  assert.equal(featureRow(bars.filter((_, i) => i % 9), 150, { assetClass: 'crypto' }), null,
    'a gapped window is refused');
});

test('asOfRow never reads the future and respects its tolerance', () => {
  const series = [{ date: '2024-01-01', v: 1 }, { date: '2024-01-05', v: 2 }, { date: '2024-01-20', v: 3 }];
  assert.equal(asOfRow(series, '2024-01-06', 3).v, 2);
  assert.equal(asOfRow(series, '2024-01-10', 3), null, 'stale beyond tolerance is not used');
  assert.equal(asOfRow(series, '2023-12-31', 3), null, 'nothing exists before the first row');
  assert.equal(asOfRow(series, '2024-01-04', 5).v, 1, 'must not jump forward to Jan 5');
});

test('samples mark only non-overlapping observations independent', () => {
  const bars = flat(400, 11);
  const daily = buildAssetSample(bars, { horizon: 1 });
  assert.ok(daily.every(r => r.independent), 'every daily row is independent at horizon 1');
  const weekly = buildAssetSample(bars, { horizon: 7 });
  const independent = weekly.filter(r => r.independent);
  assert.ok(independent.length < weekly.length / 6,
    `${independent.length} of ${weekly.length} weekly rows may be independent`);
  for (let i = 1; i < independent.length; i++) {
    assert.ok(independent[i].index - independent[i - 1].index >= 7, 'independent rows cannot overlap');
  }
  assert.ok(weekly.every(r => r.targetDate > r.date));
});

test('a single asset regression recovers a coefficient the data really contains', () => {
  const bars = arSeries(1200, 0.25, 21);
  const fit = fitAssetRegression(buildAssetSample(bars, { horizon: 1 }),
    { symbol: 'AR', horizon: 1 });
  assert.equal(fit.status, 'fitted');
  assert.equal(fit.modelVersion, HIERARCHICAL_VERSION);
  const return1 = fit.regression.coefficients.find(c => c.name === 'return1');
  assert.ok(Math.abs(return1.estimate - 0.25) < 0.12, `recovered ${return1.estimate}, wanted ~0.25`);
  assert.ok(return1.pValue < 0.001, `p=${return1.pValue}`);
  assert.ok(fit.regression.jointSignificance.pValue < 0.01);
  // Absent lanes must have been dropped as constant, not fitted as zeros.
  assert.ok(fit.droppedColumns.includes('oiChange1'));
  assert.ok(fit.droppedColumns.includes('derivativesMissing'), 'a constant indicator carries no information');
  assert.equal(fit.lanesPresent.derivatives, false);

  const noise = fitAssetRegression(buildAssetSample(flat(1200, 22), { horizon: 1 }),
    { symbol: 'NOISE', horizon: 1 });
  assert.ok(noise.regression.jointSignificance.pValue > 0.05,
    `pure noise must not be jointly significant, got ${noise.regression.jointSignificance.pValue}`);
  assert.equal(fitAssetRegression(buildAssetSample(flat(80, 23)), { symbol: 'S' }).status,
    'insufficient-observations');
});

test('nested block tests separate a lane that carries signal from one that does not', () => {
  const next = rng(500);
  const n = 1000;
  const bars = [], derivatives = [];
  let price = 100, oi = 1e9, drive = 0;
  for (let i = 0; i < n; i++) {
    // Tomorrow's return is driven by TODAY's open-interest change and nothing else.
    const shock = gaussian(next);
    const oiChange = 0.02 * gaussian(next);
    oi *= Math.exp(oiChange);
    price *= Math.exp(drive * 0.02 + shock * 0.02);
    drive = oiChange * 25;
    bars.push({ date: day(i), close: price, volume: 1e6 });
    derivatives.push({ date: day(i), oi_usd_close: oi, taker_buy_sell_ratio: 1, all_account_ls: 1 });
  }
  const fit = fitAssetRegression(buildAssetSample(bars, { horizon: 1, derivatives }),
    { symbol: 'OI', horizon: 1 });
  assert.equal(fit.status, 'fitted');
  assert.ok(fit.blocks.derivatives.pValue < 0.01,
    `the driving lane must be significant, got ${fit.blocks.derivatives.pValue}`);
  assert.ok(fit.blocks.derivatives.incrementalRSquared > 0.05,
    `incremental R2 ${fit.blocks.derivatives.incrementalRSquared}`);
  assert.ok(fit.blocks.volume == null || fit.blocks.volume.pValue > 0.05,
    'a constant lane must not appear to explain anything');
});

test('DerSimonian-Laird reports no heterogeneity when the spread is only sampling noise', () => {
  // Every asset shares one true coefficient; the observed spread is pure noise.
  const next = rng(909);
  const identical = Array.from({ length: 60 }, () => ({
    estimate: 0.3 + gaussian(next) * 0.05, standardError: 0.05
  }));
  const homogeneous = poolCoefficient(identical);
  assert.ok(homogeneous.tauSquared < 0.0015,
    `tau^2 should collapse to ~0, got ${homogeneous.tauSquared}`);
  assert.ok(homogeneous.iSquared < 0.25, `I^2 ${homogeneous.iSquared}`);
  assert.ok(Math.abs(homogeneous.pooled - 0.3) < 0.03);

  // Now a genuinely heterogeneous set: the same noise, far bigger true spread.
  const spread = Array.from({ length: 60 }, (_, i) => ({
    estimate: (i % 3 - 1) * 0.6 + gaussian(next) * 0.05, standardError: 0.05
  }));
  const heterogeneous = poolCoefficient(spread);
  assert.ok(heterogeneous.tauSquared > 0.1, `tau^2 ${heterogeneous.tauSquared}`);
  assert.ok(heterogeneous.iSquared > 0.9, `I^2 ${heterogeneous.iSquared}`);
  assert.ok(heterogeneous.pValue < 1e-6);
  assert.equal(poolCoefficient([]).assets, 0);
  assert.equal(poolCoefficient([{ estimate: 1, standardError: 0.1 }]).assets, 1);
});

test('shrinkage hands an asset its class coefficient when its own estimate is not earned', () => {
  const noHeterogeneity = { pooled: 0.4, tauSquared: 0 };
  const shrunkFully = shrinkTowardPrior({ estimate: 2.5, standardError: 0.3 }, noHeterogeneity);
  assert.equal(shrunkFully.shrinkage, 0);
  assert.equal(shrunkFully.estimate, 0.4, 'with no real spread, the asset uses the pooled value');

  // Real spread + a precisely measured asset -> it keeps most of its own estimate.
  const realHeterogeneity = { pooled: 0.4, tauSquared: 0.25 };
  const precise = shrinkTowardPrior({ estimate: 1.4, standardError: 0.05 }, realHeterogeneity);
  assert.ok(precise.shrinkage > 0.98, `lambda ${precise.shrinkage}`);
  assert.ok(Math.abs(precise.estimate - 1.4) < 0.03);

  // Same spread, a noisily measured asset -> pulled most of the way back.
  const noisy = shrinkTowardPrior({ estimate: 1.4, standardError: 1.5 }, realHeterogeneity);
  assert.ok(noisy.shrinkage < 0.15, `lambda ${noisy.shrinkage}`);
  assert.ok(Math.abs(noisy.estimate - 0.4) < 0.2, 'must sit near the pooled value');
  assert.ok(noisy.standardError < 1.5, 'the posterior must be tighter than the raw estimate');
});

test('pooling across assets corrects for the size of the sweep', () => {
  const fits = Array.from({ length: 40 }, (_, k) =>
    fitAssetRegression(buildAssetSample(flat(600, 3000 + k), { horizon: 1 }),
      { symbol: `N${k}`, horizon: 1 }));
  const pooled = poolAcrossAssets(fits.filter(f => f.status === 'fitted'));
  assert.ok(pooled.assets >= 35);
  assert.ok(pooled.multipleComparisons.tests > 300, 'this is a large sweep and must be counted as one');
  // 40 pure-noise assets: essentially nothing may survive the FDR correction.
  assert.ok(pooled.multipleComparisons.discoveries <= pooled.multipleComparisons.tests * 0.02,
    `${pooled.multipleComparisons.discoveries} discoveries on pure noise`);
  // And the heterogeneity report must not claim per-asset structure exists.
  const return1 = pooled.heterogeneity.return1;
  assert.ok(return1.iSquared < 0.4, `I^2 on noise ${return1.iSquared}`);
  const anyShrunk = pooled.shrunk[0].coefficients.find(c => c.name === 'return1');
  assert.ok(anyShrunk.shrinkage < 0.5, `noise assets must be pulled to the class, lambda=${anyShrunk.shrinkage}`);
  assert.equal(anyShrunk.block, 'momentum');
});

test('the accumulator learns online and refuses to run time backwards', () => {
  const accumulator = createAccumulator(3, { halfLifeDays: 1e9, ridge: 0 });
  for (let i = 0; i < 200; i++) {
    const x = [1, Math.sin(i), Math.cos(i / 3)];
    accumulator.update(x, 2 + 0.75 * x[1] - 0.4 * x[2], day(i));
  }
  const solved = accumulator.solve();
  assert.ok(Math.abs(solved.beta[0] - 2) < 1e-6);
  assert.ok(Math.abs(solved.beta[1] - 0.75) < 1e-6);
  assert.ok(Math.abs(solved.beta[2] + 0.4) < 1e-6);
  assert.equal(solved.samples, 200);
  assert.throws(() => accumulator.update([1, 0, 0], 1, day(5)), /chronological/);
  assert.equal(createAccumulator(2).solve(), null, 'an empty accumulator has no solution');
});

test('the ridge penalty is invariant to the units a column is measured in', () => {
  // Rescaling a regressor is a change of units, not of information, so the
  // model it implies is identical: beta_j must scale by exactly 1/c and every
  // other coefficient must not move at all. A flat ridge fails this -- it
  // penalizes the absolute size of a coefficient, so a column measured in
  // small units is charged far more for the same fit. That is not academic
  // here: `oiChange1` has a mean square ~200x smaller than `return1`, and it
  // is one of only two features carrying real per-asset heterogeneity.
  const fit = (c, scaleInvariantRidge) => {
    const accumulator = createAccumulator(3, { halfLifeDays: 1e9, ridge: 5, scaleInvariantRidge });
    for (let i = 0; i < 400; i++) {
      const small = Math.sin(i) * 0.005;      // the "open interest" column
      const large = Math.cos(i / 3);          // the "return" column
      const y = 2 + 60 * small - 0.4 * large;
      accumulator.update([1, small * c, large], y, day(i));
    }
    return accumulator.solve().beta;
  };

  const base = fit(1, true);
  const rescaled = fit(100, true);
  assert.ok(Math.abs(rescaled[1] * 100 - base[1]) < 1e-9 * Math.abs(base[1]) + 1e-12,
    `scaled ridge must rescale exactly: ${rescaled[1] * 100} vs ${base[1]}`);
  assert.ok(Math.abs(rescaled[0] - base[0]) < 1e-9, 'intercept must not move');
  assert.ok(Math.abs(rescaled[2] - base[2]) < 1e-9, 'the other slope must not move');

  // The scale-invariant penalty must also actually recover the small column's
  // steep coefficient, which the flat penalty crushes toward zero.
  assert.ok(base[1] > 55, `scaled ridge should recover ~60, got ${base[1]}`);
  const flat = fit(1, false);
  assert.ok(flat[1] < 5, `flat ridge should crush the small-scale column, got ${flat[1]}`);

  // And the flat penalty must demonstrably depend on the units chosen.
  const flatRescaled = fit(100, false);
  assert.ok(Math.abs(flatRescaled[1] * 100 - flat[1]) > 1,
    'flat ridge is unit-dependent; if this ever passes the arms have converged');
});

test('the walk-forward panel discovers a real per-asset split and keeps its timing honest', () => {
  // Half the universe mean-reverts, half trends. The spread is far larger than
  // sampling noise, so a working learner must find it.
  const assets = Array.from({ length: 24 }, (_, k) => ({
    symbol: `A${k}`, assetClass: 'crypto',
    bars: arSeries(700, k % 2 ? 0.35 : -0.35, 7000 + k)
  }));
  const panel = walkForwardPanel(assets, { horizon: 1, assetClass: 'crypto',
    asOf: day(700), refitEvery: 21, minTrainingSamples: 40, halfLifeDays: 1e9 });
  assert.equal(panel.status, 'complete');
  assert.equal(panel.modelVersion, HIERARCHICAL_VERSION);
  assert.ok(panel.metrics.observations > 5000, `only ${panel.metrics.observations} scored`);

  // The heterogeneity must be detected, and the coefficients must split by group.
  assert.ok(panel.prior.return1.iSquared > 0.8, `I^2 ${panel.prior.return1.iSquared}`);
  const trending = panel.assets.filter(a => Number(a.symbol.slice(1)) % 2 === 1);
  const reverting = panel.assets.filter(a => Number(a.symbol.slice(1)) % 2 === 0);
  const avg = xs => xs.reduce((s, a) => s + a.coefficients.return1, 0) / xs.length;
  assert.ok(avg(trending) > 0.2, `trending group learned ${avg(trending)}`);
  assert.ok(avg(reverting) < -0.2, `reverting group learned ${avg(reverting)}`);
  // Shrinkage is per FEATURE. Averaging it over 29 columns, of which only
  // return1 carries real between-asset spread here, would measure the test
  // fixture rather than the estimator -- so assert on the column that varies.
  assert.ok(panel.assets.every(a => a.shrinkage.return1 > 0.5),
    `real structure must survive shrinkage, got ${panel.assets.map(a => a.shrinkage.return1.toFixed(2)).join(',')}`);
  // ...and the columns with no real spread must be pulled fully to the class.
  assert.ok(panel.assets.every(a => a.shrinkage.volOfVol < 0.5),
    'a feature with no between-asset spread must not be learned per asset');

  // Direction accuracy must beat a coin flip on a process that genuinely is
  // predictable -- this is the test that the whole pipeline is wired up.
  assert.ok(panel.metrics.directionalAccuracy > 0.55,
    `accuracy ${panel.metrics.directionalAccuracy} on a knowingly predictable process`);
  assert.ok(panel.metrics.outOfSampleR2 > 0, `OOS R2 ${panel.metrics.outOfSampleR2}`);
  assert.ok(panel.byDate.decisionDates > 300 && panel.byDate.tStatistic != null);

  // Every scored forecast must have been made strictly before its target.
  for (const o of panel.outcomes) assert.ok(o.targetDate > o.asOf, `${o.asOf} -> ${o.targetDate}`);
});

test('the panel does not invent per-asset structure in a homogeneous universe', () => {
  // THE test. Every asset shares one coefficient; between-asset spread is pure
  // sampling noise. The learner must report that, and pull every asset to the
  // class value, rather than manufacturing 24 bespoke models.
  const assets = Array.from({ length: 24 }, (_, k) => ({
    symbol: `H${k}`, assetClass: 'crypto', bars: arSeries(700, 0.2, 8000 + k)
  }));
  const panel = walkForwardPanel(assets, { horizon: 1, assetClass: 'crypto',
    asOf: day(700), refitEvery: 21, minTrainingSamples: 40, halfLifeDays: 1e9 });
  const spread = panel.assets.map(a => a.coefficients.return1);
  const width = Math.max(...spread) - Math.min(...spread);
  assert.ok(width < 0.3, `coefficients should cluster, spread was ${width.toFixed(3)}`);
  assert.ok(panel.prior.return1.iSquared < 0.6, `I^2 ${panel.prior.return1.iSquared} on a shared coefficient`);
  // The shared signal is still learned -- pooling must not destroy real signal.
  assert.ok(panel.metrics.directionalAccuracy > 0.53,
    `the shared effect must still be found, got ${panel.metrics.directionalAccuracy}`);
});

test('the panel cannot see the future: appending later bars leaves earlier forecasts unchanged', () => {
  const build = n => Array.from({ length: 8 }, (_, k) => ({
    symbol: `L${k}`, assetClass: 'crypto', bars: arSeries(n, 0.3, 9000 + k)
  }));
  const short = walkForwardPanel(build(400), { horizon: 1, asOf: day(400), refitEvery: 21, halfLifeDays: 1e9 });
  const long = walkForwardPanel(build(700), { horizon: 1, asOf: day(700), refitEvery: 21, halfLifeDays: 1e9 });
  const earlier = new Map(short.outcomes.map(o => [`${o.symbol}|${o.asOf}`, o.predictedPct]));
  let compared = 0;
  for (const o of long.outcomes) {
    const before = earlier.get(`${o.symbol}|${o.asOf}`);
    if (before == null) continue;
    compared++;
    assert.ok(Math.abs(before - o.predictedPct) < 1e-9,
      `${o.symbol} ${o.asOf}: ${before} vs ${o.predictedPct} -- a later bar changed an earlier forecast`);
  }
  assert.ok(compared > 500, `only ${compared} overlapping forecasts were compared`);
});

test('date clustering reports what pooled observations would overstate', () => {
  // One market-wide move repeated across 50 assets is ONE observation, not 50.
  const rows = [];
  const next = rng(4);
  for (let d = 0; d < 60; d++) {
    const marketDay = gaussian(next) * 2;
    for (let a = 0; a < 50; a++) rows.push({ asOf: day(d), netReturnPct: marketDay });
  }
  const clustered = summarizeByDate(rows);
  assert.equal(clustered.decisionDates, 60, 'clusters are dates, not observations');
  const pooledStandardError = Math.sqrt(rows.reduce((s, r) =>
    s + (r.netReturnPct - clustered.meanNetPct) ** 2, 0) / (rows.length - 1) / rows.length);
  assert.ok(clustered.standardError > pooledStandardError * 5,
    'clustering must report far more uncertainty than pooling the duplicates');
  assert.equal(summarizeByDate([]).decisionDates, 0);
});

test('corrupt archive rows are removed instead of poisoning the fit', () => {
  // asset_daily_bars is documented to contain corrupt rows. One non-positive
  // close makes a log return -Infinity, which reaches X'X and kills the asset's
  // entire regression with an error that names no symbol.
  const clean = arSeries(400, 0.2, 55);
  const corrupt = [
    ...clean.slice(0, 200),
    { date: clean[200].date, close: 0, volume: 1e6 },          // zero close
    { date: clean[201].date, close: -5, volume: 1e6 },         // negative close
    { date: clean[202].date, close: NaN, volume: 1e6 },        // not a number
    { date: 'not-a-date', close: 100, volume: 1e6 },
    { date: clean[150].date, close: 123, volume: 1e6 },        // duplicate date
    ...clean.slice(203)
  ];
  const kept = sanitizeBars(corrupt);
  assert.ok(kept.every(b => Number.isFinite(b.close) && b.close > 0));
  assert.equal(new Set(kept.map(b => b.date)).size, kept.length, 'dates must be unique');
  assert.deepEqual(kept.map(b => b.date), [...kept.map(b => b.date)].sort(), 'and ordered');
  assert.equal(sanitizeBars(clean, { asOf: clean[100].date }).length, 100, 'asOf excludes the anchor day');

  const sample = buildAssetSample(corrupt, { horizon: 1 });
  assert.ok(sample.length > 250, `only ${sample.length} usable rows survived`);
  assert.ok(sample.every(r => Number.isFinite(r.y) && r.x.every(Number.isFinite)),
    'no non-finite value may reach the design matrix');
  assert.equal(fitAssetRegression(sample, { symbol: 'CORRUPT', horizon: 1 }).status, 'fitted');
});

test('an asset benchmarked against itself is fitted, not abandoned as singular', () => {
  // BTC is its own benchmark, so market5 IS return5 and relative5 is exactly
  // zero. VIF cannot see this -- with both present every VIF auxiliary is
  // singular and returns null, so nothing gets pruned. Before the Gram-Schmidt
  // pass this produced `singular-design` on the most important asset in the
  // universe.
  const bars = arSeries(900, 0.2, 61);
  const selfBenchmark = new Map(bars.map(b => [b.date, b.close]));
  const sample = buildAssetSample(bars, { horizon: 1, benchmarkByDate: selfBenchmark });
  const fit = fitAssetRegression(sample, { symbol: 'SELF', horizon: 1 });
  assert.equal(fit.status, 'fitted');
  assert.ok(fit.droppedColumns.includes('relative5'), 'an identically-zero column must go');
  assert.ok(!(fit.names.includes('market5') && fit.names.includes('return5')),
    'two identical columns cannot both survive');
  assert.ok(Number.isFinite(fit.regression.rSquared));
});

test('exact linear dependence is removed before variance inflation is consulted', () => {
  const next = rng(88);
  const rows = Array.from({ length: 150 }, () => {
    const a = gaussian(next), b = gaussian(next);
    return [1, a, b, a + b, gaussian(next)]; // column 3 is exactly 1+2
  });
  const kept = independentColumns(rows, [0, 1, 2, 3, 4]);
  assert.deepEqual(kept, [0, 1, 2, 4], 'the dependent column is dropped, the rest survive');
  assert.deepEqual(independentColumns(rows.map(r => [...r, 0]), [0, 5]), [0],
    'an all-zero column is dropped');
});

test('collinear and constant columns are removed before anything is claimed about them', () => {
  const next = rng(77);
  const rows = Array.from({ length: 200 }, () => {
    const a = gaussian(next);
    return [1, a, a + gaussian(next) * 1e-4, gaussian(next), 5];
  });
  const varying = usableColumns(rows);
  assert.deepEqual(varying, [0, 1, 2, 3], 'the constant column 4 is dropped, the intercept kept');
  const kept = pruneCollinear(rows, varying, { maxVif: 10, computeVif: varianceInflationFactors });
  assert.ok(kept.length < varying.length, 'one of the duplicated columns must go');
  assert.ok(kept.includes(0) && kept.includes(3));
});

test('funding and sentiment become features, and announce themselves absent', { skip: !EXPERIMENTAL_BLOCKS_ENABLED && 'experimental blocks are off by default' }, () => {
  // 120 daily bars so every window the row needs is satisfied.
  const bars = Array.from({ length: 120 }, (_, i) => ({
    date: day(i), close: 100 * (1 + 0.01 * Math.sin(i / 3)), volume: 1000 + i
  }));
  const at = day(119);
  const funding = Array.from({ length: 120 }, (_, i) => ({
    date: day(i), funding_rate: 0.0002 + 0.0001 * Math.sin(i / 5)
  }));
  const sentimentByDate = new Map(Array.from({ length: 120 }, (_, i) => [day(i), 40 + (i % 40)]));

  const withAll = featureRow(bars, 119, { funding, sentimentByDate, assetClass: 'crypto' });
  const idx = name => FEATURE_NAMES.indexOf(name);

  // Funding: the tanh transform is near-linear at realistic magnitudes, so a
  // rate of 2e-4 must NOT saturate -- the whole point of choosing the scale.
  const rate = funding[119].funding_rate;
  assert.ok(Math.abs(withAll.raw.fundingRate - Math.tanh(rate * 500)) < 1e-12);
  assert.ok(Math.abs(withAll.raw.fundingRate) < 0.3, 'realistic funding must stay off the tanh shoulder');
  // Percentile is centred on zero and bounded.
  assert.ok(withAll.raw.fundingPercentile > -0.5 && withAll.raw.fundingPercentile <= 0.5);
  // Sentiment is centred: 50 maps to 0, 100 to +1, 0 to -1.
  const fg = sentimentByDate.get(at);
  assert.ok(Math.abs(withAll.raw.fearGreed - (fg - 50) / 50) < 1e-12);
  assert.equal(withAll.available.funding, true);
  assert.equal(withAll.available.sentiment, true);
  assert.equal(withAll.x[idx('fundingMissing')], 0);
  assert.equal(withAll.x[idx('sentimentMissing')], 0);

  // An equity has no funding leg and no crypto sentiment row. The block must
  // zero out AND raise its indicator, so the other lanes are still estimated
  // where they exist instead of the whole row being discarded.
  // Supply BOTH lanes and still assert absence: an equity has no perpetual
  // funding leg, and alternative.me's Fear & Greed is a CRYPTO index, so
  // handing it to a stock regression is a cross-asset borrow. Measured when it
  // leaked: stock 1d OOS R2 -0.0222 -> -0.0265, t -3.43 -> -3.72. Passing the
  // data in is the point of this assertion -- omitting it tests nothing.
  const without = featureRow(bars, 119, { funding, sentimentByDate, assetClass: 'stock' });
  assert.equal(without.available.funding, false);
  assert.equal(without.available.sentiment, false);
  assert.equal(without.raw.fearGreed, undefined, 'crypto sentiment must not reach an equity row');
  assert.equal(without.x[idx('fundingMissing')], 1);
  assert.equal(without.x[idx('sentimentMissing')], 1);
  assert.equal(without.x[idx('fundingRate')], 0);
  assert.equal(without.x[idx('fearGreed')], 0);

  // An extreme funding print must be bounded, not allowed to dominate X'X.
  const squeeze = funding.map((r, i) => (i === 119 ? { ...r, funding_rate: 0.78 } : r));
  const wild = featureRow(bars, 119, { funding: squeeze, sentimentByDate, assetClass: 'crypto' });
  assert.ok(Math.abs(wild.raw.fundingRate) <= 1, 'tanh must bound the tail');
  assert.ok(Math.abs(wild.x[idx('fundingRate')]) <= 4, 'and clip must hold it inside the design bound');
});

test('the column vector length and the model version move together', () => {
  // A stored coefficient vector is positional, so the version must change with
  // the column space or coefficients silently remap onto different features.
  // Default is the 29-column production space; the experimental blocks are off.
  // Both spaces are pinned, and the pairing is the invariant: 29 <-> v4,
  // 36 <-> v4-exp. Neither may move without the other.
  const expected = EXPERIMENTAL_BLOCKS_ENABLED
    ? { columns: 36, version: 'hierarchical-mlr-v4-exp' }
    : { columns: 29, version: 'hierarchical-mlr-v4' };
  assert.equal(FEATURE_NAMES.length, expected.columns);
  assert.equal(HIERARCHICAL_VERSION, expected.version);
  assert.equal(FEATURE_NAMES[0], 'intercept');
  for (const f of ['fundingRate', 'fearGreed']) {
    assert.equal(FEATURE_NAMES.includes(f), EXPERIMENTAL_BLOCKS_ENABLED,
      `${f} presence must follow the experimental flag`);
  }
  // Indicators come last, after every block feature.
  const firstIndicator = FEATURE_NAMES.findIndex(n => n.endsWith('Missing'));
  assert.ok(FEATURE_NAMES.slice(firstIndicator).every(n => n.endsWith('Missing')));
  // And the blocks are defined, tested and reachable -- excluded, not deleted.
  assert.deepEqual(EXPERIMENTAL_BLOCKS, ['funding', 'sentiment']);
  for (const b of EXPERIMENTAL_BLOCKS) assert.ok(FEATURE_BLOCKS[b]?.length);
});
