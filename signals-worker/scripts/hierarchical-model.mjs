// Per-asset multiple regression with partial pooling across the asset class.
//
// The point of this file is a specific, measured problem. `adaptive-ridge-v1`
// fits every asset on its own and shrinks it toward ZERO, so an asset either
// learns nothing or learns its own noise. Meanwhile
// `docs/PREDICTION_WEIGHTS_EVIDENCE.md` established that between-asset
// dispersion here is real but does not persist: the first-half/second-half IC
// correlation was -0.036, and both extreme quintiles reverted to the universe
// mean. Selecting per-asset weights on that evidence is fitting luck.
//
// Empirical Bayes is the estimator that respects both facts at once. Each asset
// is shrunk toward the CLASS coefficient by a weight derived from the data:
//
//     tau^2 = between-asset variance of the coefficient (DerSimonian-Laird)
//     lambda_ij = tau^2_j / (tau^2_j + se^2_ij)
//     beta_ij   = mu_j + lambda_ij * (beta_ij - mu_j)
//
// If a feature's between-asset spread is no bigger than its sampling noise,
// tau^2 goes to zero, lambda goes to zero, and every asset receives the pooled
// coefficient. The model then "learns per asset" exactly nowhere -- which is
// the honest answer, produced automatically rather than asserted. Where an
// asset genuinely does respond differently, lambda rises and it keeps its own
// coefficient. The shrinkage weight is reported, so the question "does this
// asset really differ from its class" has a number attached instead of a claim.

import {
  fitLinearModel, regressionReport, withDesign, hacCovariance, invert,
  chiSquareUpperP, benjaminiHochberg, outOfSampleR2, varianceInflationFactors
} from './regression-diagnostics.mjs';
import {
  FEATURE_NAMES, FEATURE_BLOCKS, BLOCK_NAMES, BLOCK_OF, OPTIONAL_BLOCKS,
  featureRow, usableColumns, pruneCollinear, independentColumns, sanitizeBars
} from './panel-features.mjs';

export const HIERARCHICAL_VERSION = 'hierarchical-mlr-v1';
const DAY = 86400000;
const dateMs = d => Date.parse(`${d}T00:00:00Z`);
const mean = xs => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null);

// ---------------------------------------------------------------------------
// Building one asset's regression sample
// ---------------------------------------------------------------------------

/**
 * Feature rows paired with the asset's own forward return over `horizon`,
 * normalized by the volatility known AT the anchor. Only non-overlapping
 * observations are marked independent: a 7-day forecast sampled daily shares
 * six days of its target window with its neighbour, and counting those as
 * separate trials is the exact defect that produced `confluence-v6`.
 */
export function buildAssetSample(rawBars, {
  horizon = 1, assetClass = 'crypto', benchmarkByDate = new Map(),
  derivatives = [], supply = [], asOf = null
} = {}) {
  const bars = sanitizeBars(rawBars, { asOf });
  const rows = [];
  const maxGap = assetClass === 'crypto' ? 1 : 4;
  let nextIndependent = 0;
  for (let i = 0; i < bars.length - horizon; i++) {
    const features = featureRow(bars, i, { benchmarkByDate, derivatives, supply, assetClass });
    if (!features) continue;
    const exit = bars[i + horizon];
    const path = bars.slice(i, i + horizon + 1);
    if (path.some((b, j) => j && (dateMs(b.date) - dateMs(path[j - 1].date)) / DAY > maxGap)) continue;
    const logReturn = Math.log(exit.close / bars[i].close);
    const scale = features.dailyVol * Math.sqrt(horizon);
    // Belt and braces: sanitizeBars removes the causes, this catches anything
    // that still arrives non-finite rather than letting it reach X'X.
    if (!Number.isFinite(logReturn) || !(scale > 0) || !features.x.every(Number.isFinite)) continue;
    const independent = i >= nextIndependent;
    if (independent) nextIndependent = i + horizon;
    rows.push({
      index: i, date: features.date, targetDate: exit.date, x: features.x,
      y: logReturn / scale, logReturn, scale, dailyVol: features.dailyVol,
      close: bars[i].close, available: features.available, independent
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// One asset, fitted and fully described
// ---------------------------------------------------------------------------

/**
 * Multiple regression of one asset's forward return on every available lane,
 * with robust inference, collinearity control and a nested test per lane.
 *
 * `independentOnly` defaults true. Using overlapping rows multiplies the
 * apparent sample without adding information, and every t-statistic in this
 * project that was computed that way turned out to be wrong.
 */
export function fitAssetRegression(sample, {
  symbol, assetClass = 'crypto', horizon = 1, ridge = 0, maxVif = 10,
  independentOnly = true, minObservations = 40, hacLags = null
} = {}) {
  const rows = independentOnly ? sample.filter(r => r.independent) : sample;
  if (rows.length < minObservations) {
    return { symbol, assetClass, horizon, status: 'insufficient-observations',
      observations: rows.length, required: minObservations };
  }
  const design = rows.map(r => r.x);
  const y = rows.map(r => r.y);
  // Three reductions, all blind to y. Order matters: constants first, then
  // exact linear dependence (which VIF cannot see, because it makes every VIF
  // auxiliary singular), then merely inflated columns.
  const varying = usableColumns(design);
  const independent = independentColumns(design, varying);
  const columns = pruneCollinear(design, independent, { maxVif, computeVif: varianceInflationFactors });
  const X = design.map(r => columns.map(j => r[j]));
  const names = columns.map(j => FEATURE_NAMES[j]);
  // Overlap is already removed, so the residual serial correlation that remains
  // is the asset's own; one horizon of lags covers it without over-smoothing.
  const lags = hacLags ?? Math.max(1, horizon - 1);
  const report = regressionReport(X, y, { names, ridge, errors: 'hac', lags });
  if (!report) {
    return { symbol, assetClass, horizon, status: 'singular-design', observations: rows.length };
  }
  return {
    symbol, assetClass, horizon, status: 'fitted', modelVersion: HIERARCHICAL_VERSION,
    observations: rows.length, overlapping: sample.length - rows.length,
    columns, names, droppedColumns: FEATURE_NAMES.filter((_, j) => !columns.includes(j)),
    regression: report,
    blocks: blockIncrementalTests(X, y, names, { ridge, lags }),
    lanesPresent: Object.fromEntries(BLOCK_NAMES.map(b =>
      [b, rows.some(r => r.available[b])])),
    firstDate: rows[0].date, lastDate: rows.at(-1).date
  };
}

/**
 * For each lane, refit without it and report what its columns added. This is
 * the direct answer to "many kinds of data, one asset": a block that cannot
 * beat its own degrees of freedom is not evidence, however many columns it has.
 */
export function blockIncrementalTests(X, y, names, { ridge = 0, lags = 1 } = {}) {
  const full = withDesign(fitLinearModel(X, y, { ridge }), X);
  if (!full) return {};
  const rssFull = full.residuals.reduce((s, v) => s + v * v, 0);
  const meanY = mean(y);
  const tss = y.reduce((s, v) => s + (v - meanY) ** 2, 0);
  const out = {};
  for (const block of BLOCK_NAMES) {
    const inBlock = names.map((n, j) => (BLOCK_OF[n] === block ? j : -1)).filter(j => j >= 0);
    if (!inBlock.length) continue;
    const keep = names.map((_, j) => j).filter(j => !inBlock.includes(j));
    if (keep.length < 1) continue;
    const reduced = fitLinearModel(X.map(r => keep.map(j => r[j])), y, { ridge });
    if (!reduced) continue;
    const rssReduced = reduced.residuals.reduce((s, v) => s + v * v, 0);
    // Wald test on the block, using the same HAC covariance as the coefficient
    // table so the two cannot disagree about the same numbers.
    const covariance = hacCovariance(full, { lags }).covariance;
    const sub = inBlock.map(i => inBlock.map(j => covariance[i][j]));
    const inverse = invert(sub);
    const b = inBlock.map(j => full.beta[j]);
    const statistic = inverse
      ? b.reduce((s, bi, i) => s + bi * inverse[i].reduce((t, v, j) => t + v * b[j], 0), 0) : null;
    out[block] = {
      columns: inBlock.length,
      incrementalRSquared: tss > 0 ? (rssReduced - rssFull) / tss : null,
      waldStatistic: statistic,
      pValue: statistic == null ? null : chiSquareUpperP(statistic, inBlock.length),
      features: inBlock.map(j => names[j])
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pooling across the class
// ---------------------------------------------------------------------------

/**
 * DerSimonian-Laird random-effects pooling of one coefficient across assets.
 * Returns the pooled mean, the between-asset variance, and the heterogeneity
 * statistics that say whether per-asset variation exists at all.
 */
export function poolCoefficient(estimates) {
  const usable = estimates.filter(e =>
    Number.isFinite(e.estimate) && Number.isFinite(e.standardError) && e.standardError > 0);
  const m = usable.length;
  if (m < 2) {
    return { assets: m, pooled: m ? usable[0].estimate : null, tauSquared: 0,
      iSquared: null, q: null, pValue: null, fixedEffect: m ? usable[0].estimate : null };
  }
  const w = usable.map(e => 1 / e.standardError ** 2);
  const sumW = w.reduce((s, v) => s + v, 0);
  const sumW2 = w.reduce((s, v) => s + v * v, 0);
  const fixedEffect = usable.reduce((s, e, i) => s + w[i] * e.estimate, 0) / sumW;
  const q = usable.reduce((s, e, i) => s + w[i] * (e.estimate - fixedEffect) ** 2, 0);
  const df = m - 1;
  const c = sumW - sumW2 / sumW;
  const tauSquared = c > 0 ? Math.max(0, (q - df) / c) : 0;
  const randomWeights = usable.map(e => 1 / (e.standardError ** 2 + tauSquared));
  const sumRandom = randomWeights.reduce((s, v) => s + v, 0);
  const pooled = usable.reduce((s, e, i) => s + randomWeights[i] * e.estimate, 0) / sumRandom;
  return {
    assets: m, pooled, fixedEffect, tauSquared,
    tau: Math.sqrt(tauSquared),
    // I^2 is the share of observed variation that is real rather than sampling
    // noise. At I^2 = 0 there is nothing per-asset to learn, by measurement.
    iSquared: q > 0 ? Math.max(0, (q - df) / q) : 0,
    q, df, pValue: chiSquareUpperP(q, df),
    pooledStandardError: Math.sqrt(1 / sumRandom),
    medianWithinVariance: median(usable.map(e => e.standardError ** 2))
  };
}

const median = xs => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/**
 * Pool every feature across a set of fitted assets, then shrink each asset back
 * toward the pooled value. `shrinkage` near 0 means the asset is being told to
 * use its class's coefficient; near 1 means its own history earned the right to
 * differ. That number is the deliverable, not a tuning knob.
 */
export function poolAcrossAssets(fits, { falseDiscoveryRate = 0.1 } = {}) {
  const fitted = fits.filter(f => f.status === 'fitted');
  const prior = {};
  for (const name of FEATURE_NAMES) {
    const estimates = fitted.flatMap(f => {
      const c = f.regression.coefficients.find(c => c.name === name);
      return c && Number.isFinite(c.estimate) && c.standardError > 0
        ? [{ symbol: f.symbol, estimate: c.estimate, standardError: c.standardError }] : [];
    });
    if (estimates.length) prior[name] = poolCoefficient(estimates);
  }
  // One test per asset per feature is thousands of tests; without a correction
  // the "assets that differ" list is manufactured by the sweep itself.
  const flat = [];
  for (const f of fitted) {
    for (const c of f.regression.coefficients) {
      if (Number.isFinite(c.pValue)) flat.push({ symbol: f.symbol, name: c.name, pValue: c.pValue });
    }
  }
  const correction = benjaminiHochberg(flat.map(e => e.pValue), { falseDiscoveryRate });
  const qBySymbol = new Map();
  flat.forEach((e, i) => {
    qBySymbol.set(`${e.symbol}|${e.name}`, { qValue: correction.qValues[i], survives: correction.rejected[i] });
  });
  const shrunk = fitted.map(f => ({
    symbol: f.symbol, assetClass: f.assetClass, horizon: f.horizon,
    observations: f.observations,
    coefficients: f.regression.coefficients.map(c => {
      const p = prior[c.name];
      const applied = shrinkTowardPrior(c, p);
      const q = qBySymbol.get(`${f.symbol}|${c.name}`) || {};
      return { ...applied, name: c.name, block: BLOCK_OF[c.name] ?? null,
        own: c.estimate, pooled: p?.pooled ?? null, qValue: q.qValue ?? null,
        survivesFdr: q.survives ?? false };
    })
  }));
  return {
    modelVersion: HIERARCHICAL_VERSION, assets: fitted.length, prior, shrunk,
    multipleComparisons: { tests: correction.tests, discoveries: correction.discoveries, falseDiscoveryRate },
    heterogeneity: Object.fromEntries(Object.entries(prior).map(([name, p]) =>
      [name, { iSquared: p.iSquared, tau: p.tau, pValue: p.pValue, assets: p.assets }]))
  };
}

/** beta_shrunk = mu + lambda * (beta_own - mu), with lambda from the variances. */
export function shrinkTowardPrior(coefficient, prior) {
  if (!prior || !Number.isFinite(coefficient.estimate)) {
    return { estimate: coefficient.estimate ?? null, shrinkage: null };
  }
  const se2 = Number.isFinite(coefficient.standardError) ? coefficient.standardError ** 2 : null;
  if (se2 == null || !(se2 > 0)) return { estimate: prior.pooled, shrinkage: 0 };
  const lambda = prior.tauSquared > 0 ? prior.tauSquared / (prior.tauSquared + se2) : 0;
  return {
    estimate: prior.pooled + lambda * (coefficient.estimate - prior.pooled),
    shrinkage: lambda,
    standardError: Math.sqrt(lambda * se2) // the posterior is tighter than either input
  };
}

// ---------------------------------------------------------------------------
// The online, walk-forward version
// ---------------------------------------------------------------------------

/** Exponentially-decayed sufficient statistics for one asset's regression. */
export function createAccumulator(p, { halfLifeDays = 365, ridge = 5 } = {}) {
  const a = Array.from({ length: p }, () => Array(p).fill(0));
  const b = Array(p).fill(0);
  let syy = 0, weight = 0, count = 0, lastDate = null;
  return {
    get count() { return count; },
    get lastDate() { return lastDate; },
    update(x, y, observedDate) {
      if (lastDate && observedDate < lastDate) throw new Error('Training must be chronological');
      const elapsed = lastDate ? (dateMs(observedDate) - dateMs(lastDate)) / DAY : 0;
      const decay = Math.exp(-Math.LN2 * Math.max(0, elapsed) / halfLifeDays);
      for (let i = 0; i < p; i++) {
        b[i] = b[i] * decay + x[i] * y;
        for (let j = 0; j < p; j++) a[i][j] = a[i][j] * decay + x[i] * x[j];
      }
      syy = syy * decay + y * y;
      weight = weight * decay + 1;
      count++;
      lastDate = observedDate;
    },
    /** Coefficients with classical standard errors. Training rows are
     *  non-overlapping by construction, so the classical form is the right one
     *  here; HAC is applied in the full-sample inference path instead. */
    solve() {
      const penalized = a.map((row, i) => row.map((v, j) => v + (i === j && i !== 0 ? ridge : 0)));
      const inverse = invert(penalized);
      if (!inverse) return null;
      const beta = inverse.map(row => row.reduce((s, v, j) => s + v * b[j], 0));
      const explained = beta.reduce((s, v, i) => s + v * b[i], 0);
      const residualDf = Math.max(1, weight - p);
      const sigma2 = Math.max(0, (syy - explained) / residualDf);
      return {
        beta, effectiveWeight: weight, samples: count, trainedThrough: lastDate,
        standardErrors: inverse.map((row, i) => Math.sqrt(Math.max(0, sigma2 * row[i]))),
        sigma2
      };
    }
  };
}

const intervalRadius = (residuals, coverage, minimum = 30) => {
  if (residuals.length < minimum) return null;
  const sorted = residuals.slice(-180).map(Math.abs).sort((a, b) => a - b);
  const rank = Math.ceil((sorted.length + 1) * coverage);
  return rank <= sorted.length ? sorted[rank - 1] : null;
};

/**
 * The online learner: every asset is fitted on its own history, pooled with its
 * class, shrunk back, and then asked to predict -- in that order, one date at a
 * time, with nothing in scope that had not happened yet.
 *
 * Two deliberate choices:
 *  - Every asset shares the FULL column space. Per-asset pruning would give
 *    each one a different parameter, and a pooled prior cannot average
 *    coefficients that do not mean the same thing. Collinearity is handled by
 *    the ridge here and reported by the full-sample path instead.
 *  - Coefficients are re-solved on a cadence, not every day. Between refits the
 *    accumulator keeps absorbing matured outcomes; only the solve is batched.
 *    This is a cost decision, and it is stated rather than hidden: a daily
 *    re-solve is 500 assets x 1500 days of 29x29 inversions.
 */
export function walkForwardPanel(assets, {
  horizon = 1, assetClass = 'crypto', asOf = new Date().toISOString().slice(0, 10),
  benchmark = [], derivativesBySymbol = new Map(), supplyBySymbol = new Map(),
  costBps = 20, coverage = 0.8, halfLifeDays = 365, ridge = 5,
  refitEvery = 21, minTrainingSamples = 40, onProgress = null
} = {}) {
  const p = FEATURE_NAMES.length;
  const benchmarkByDate = new Map(benchmark.map(b => [b.date, b.close]));
  const state = [];
  for (const asset of assets) {
    const sample = buildAssetSample(asset.bars, {
      horizon, assetClass, benchmarkByDate,
      derivatives: derivativesBySymbol.get(asset.symbol) || [],
      supply: supplyBySymbol.get(asset.symbol) || []
    }).filter(r => r.date < asOf);
    if (!sample.length) continue;
    state.push({
      symbol: asset.symbol, archiveClass: asset.assetClass || assetClass, sample,
      byDate: new Map(sample.map(r => [r.date, r])),
      accumulator: createAccumulator(p, { halfLifeDays, ridge }),
      solved: null, shrunk: null, pending: [], residuals: [], outcomes: []
    });
  }
  if (!state.length) return emptyPanelResult({ horizon, assetClass, asOf, costBps, coverage, halfLifeDays, ridge, refitEvery });

  const timeline = [...new Set(state.flatMap(s => s.sample.map(r => r.date)))].sort();
  const priorHistory = [];
  let prior = null, sinceRefit = Infinity;

  for (const date of timeline) {
    // 1. Mature everything whose target has now been observed, and learn from it.
    for (const s of state) {
      while (s.pending.length && s.pending[0].targetDate <= date) {
        const forecast = s.pending.shift();
        s.accumulator.update(forecast.x, forecast.actualNormalized, forecast.targetDate);
        // Grade as soon as the model was making a real prediction. Gating this
        // on the interval existing would deadlock again: intervals are built
        // FROM these residuals. Coverage is therefore scored separately, only
        // over the forecasts that actually carried a band.
        if (forecast.ready) {
          s.residuals.push(forecast.actualNormalized - forecast.predictedNormalized);
          s.outcomes.push(scoreForecast(forecast, costBps));
        }
      }
    }
    // 2. Re-solve and re-pool on the cadence. Both steps see only matured data.
    if (sinceRefit >= refitEvery) {
      const estimates = [];
      for (const s of state) {
        s.solved = s.accumulator.count >= minTrainingSamples ? s.accumulator.solve() : null;
        if (s.solved) estimates.push({ symbol: s.symbol, solved: s.solved });
      }
      prior = estimates.length >= 2 ? poolOnlineEstimates(estimates) : null;
      for (const s of state) s.shrunk = s.solved ? applyPrior(s.solved, prior) : null;
      if (prior) {
        priorHistory.push({ date, assets: estimates.length,
          heterogeneity: Object.fromEntries(FEATURE_NAMES.map((n, j) =>
            [n, prior[j] ? Number(prior[j].iSquared?.toFixed(4)) : null])) });
      }
      sinceRefit = 0;
      if (onProgress) onProgress({ date, assets: estimates.length });
    }
    sinceRefit++;
    // 3. Predict, then queue the observation for training.
    //
    // Queuing must NOT depend on the model being ready. The training pair
    // (features, realized outcome) exists whether or not anything can forecast
    // yet, and gating it on readiness deadlocks the learner: no forecast means
    // no queued row, which means no training, which means no forecast. Only
    // SCORING is gated -- an untrained model's zero is not a prediction to grade.
    for (const s of state) {
      const row = s.byDate.get(date);
      if (!row) continue;
      const ready = Boolean(s.shrunk);
      const predictedNormalized = ready
        ? clipPrediction(s.shrunk.beta.reduce((sum, w, j) => sum + w * row.x[j], 0)) : 0;
      const radius = ready ? intervalRadius(s.residuals, coverage) : null;
      const expectedReturnPct = Math.expm1(predictedNormalized * row.scale) * 100;
      const interval = radius == null ? null : {
        lowerPct: Math.expm1((predictedNormalized - radius) * row.scale) * 100,
        upperPct: Math.expm1((predictedNormalized + radius) * row.scale) * 100,
        nominalCoverage: coverage, calibrationSamples: Math.min(s.residuals.length, 180),
        method: 'rolling-prequential-residuals'
      };
      const meanShrinkage = ready ? mean(s.shrunk.shrinkage.filter(Number.isFinite)) : null;
      if (ready) {
        s.latest = {
          symbol: s.symbol, asOf: row.date, horizon, assetClass,
          referencePrice: row.close, predictedNormalized, expectedReturnPct, interval,
          trainingSamples: s.accumulator.count, meanShrinkage, available: row.available,
          status: radius == null ? 'warming-up' : 'shadow', actionable: false
        };
      }
      if (row.independent) {
        s.pending.push({
          symbol: s.symbol, asOf: row.date, targetDate: row.targetDate,
          x: row.x, scale: row.scale, interval, meanShrinkage,
          predictedNormalized, actualNormalized: row.y,
          expectedReturnPct, actualPct: Math.expm1(row.logReturn) * 100,
          ready: ready && s.accumulator.count >= minTrainingSamples
        });
      }
    }
  }
  return assemblePanelResult(state, prior, priorHistory,
    { horizon, assetClass, asOf, costBps, coverage, halfLifeDays, ridge, refitEvery, minTrainingSamples });
}

const clipPrediction = v => (Number.isFinite(v) ? Math.max(-4, Math.min(4, v)) : 0);

/** Pool the online per-asset solutions feature by feature. */
export function poolOnlineEstimates(estimates) {
  return FEATURE_NAMES.map((_, j) => poolCoefficient(estimates.map(e => ({
    symbol: e.symbol, estimate: e.solved.beta[j], standardError: e.solved.standardErrors[j]
  }))));
}

/** Shrink one asset's online solution toward the pooled prior, per feature. */
export function applyPrior(solved, prior) {
  if (!prior) return { beta: solved.beta, shrinkage: solved.beta.map(() => 1) };
  const beta = [], shrinkage = [];
  for (let j = 0; j < solved.beta.length; j++) {
    const applied = shrinkTowardPrior(
      { estimate: solved.beta[j], standardError: solved.standardErrors[j] }, prior[j]);
    beta.push(Number.isFinite(applied.estimate) ? applied.estimate : 0);
    shrinkage.push(applied.shrinkage);
  }
  return { beta, shrinkage };
}

function scoreForecast(forecast, costBps) {
  const predictedPct = forecast.expectedReturnPct;
  const actualPct = forecast.actualPct;
  const tradable = Math.abs(predictedPct) > costBps / 100;
  return {
    symbol: forecast.symbol, asOf: forecast.asOf, targetDate: forecast.targetDate,
    predictedPct, actualPct,
    absoluteErrorPct: Math.abs(predictedPct - actualPct),
    zeroErrorPct: Math.abs(actualPct),
    directionCorrect: Math.sign(predictedPct) === Math.sign(actualPct),
    covered: forecast.interval
      ? actualPct >= forecast.interval.lowerPct && actualPct <= forecast.interval.upperPct : null,
    intervalWidthPct: forecast.interval ? forecast.interval.upperPct - forecast.interval.lowerPct : null,
    side: tradable ? Math.sign(predictedPct) : 0,
    netReturnPct: tradable ? Math.sign(predictedPct) * actualPct - costBps / 100 : 0,
    buyHoldPct: actualPct, meanShrinkage: forecast.meanShrinkage, provenance: 'replay'
  };
}

const emptyPanelResult = config => ({
  modelVersion: HIERARCHICAL_VERSION, config, assets: [], outcomes: [],
  prior: null, priorHistory: [], metrics: null,
  status: 'no-usable-assets'
});

function assemblePanelResult(state, prior, priorHistory, config) {
  const outcomes = state.flatMap(s => s.outcomes);
  const assets = state.map(s => ({
    symbol: s.symbol, archiveClass: s.archiveClass,
    observations: s.outcomes.length, trainingSamples: s.accumulator.count,
    meanShrinkage: s.shrunk ? mean(s.shrunk.shrinkage.filter(Number.isFinite)) : null,
    coefficients: s.shrunk
      ? Object.fromEntries(FEATURE_NAMES.map((n, j) => [n, s.shrunk.beta[j]])) : null,
    // Per feature: how much of this asset's OWN estimate survived pooling.
    // 0 means it was handed the class coefficient; 1 means its own history
    // earned the right to differ. This is the per-asset learning, measured.
    shrinkage: s.shrunk
      ? Object.fromEntries(FEATURE_NAMES.map((n, j) => [n, s.shrunk.shrinkage[j]])) : null,
    forecast: s.latest ?? null,
    metrics: summarizePanelOutcomes(s.outcomes)
  }));
  return {
    modelVersion: HIERARCHICAL_VERSION, status: 'complete', config,
    assets, outcomes,
    prior: prior ? Object.fromEntries(FEATURE_NAMES.map((n, j) => [n, prior[j]])) : null,
    priorHistory,
    metrics: summarizePanelOutcomes(outcomes),
    // Grouping by decision date is what stops one day's market-wide move from
    // being counted as hundreds of independent successes.
    byDate: summarizeByDate(outcomes)
  };
}

export function summarizePanelOutcomes(rows) {
  if (!rows.length) return { observations: 0 };
  const banded = rows.filter(r => r.covered != null);
  const traded = rows.filter(r => r.side);
  const predicted = rows.map(r => r.predictedPct);
  const actual = rows.map(r => r.actualPct);
  const midpoint = Math.floor(rows.length / 2);
  return {
    observations: rows.length,
    directionalAccuracy: mean(rows.map(r => Number(r.directionCorrect))),
    meanAbsoluteErrorPct: mean(rows.map(r => r.absoluteErrorPct)),
    zeroForecastErrorPct: mean(rows.map(r => r.zeroErrorPct)),
    outOfSampleR2: outOfSampleR2(actual, predicted),
    intervalObservations: banded.length,
    intervalCoverage: mean(banded.map(r => Number(r.covered))),
    meanIntervalWidthPct: mean(banded.map(r => r.intervalWidthPct)),
    trades: traded.length,
    meanNetReturnPct: mean(rows.map(r => r.netReturnPct)),
    meanTradeNetPct: mean(traded.map(r => r.netReturnPct)),
    earlyNetPct: mean(rows.slice(0, midpoint).map(r => r.netReturnPct)),
    lateNetPct: mean(rows.slice(midpoint).map(r => r.netReturnPct)),
    meanBuyHoldPct: mean(rows.map(r => r.buyHoldPct)),
    meanShrinkage: mean(rows.map(r => r.meanShrinkage).filter(Number.isFinite))
  };
}

/**
 * Per-date means and a t-statistic across dates. Clustering by date is not
 * optional on this data: `docs/PREDICTION_WEIGHTS_EVIDENCE.md` records pooled
 * quintiles that looked significant until exactly this was applied.
 */
export function summarizeByDate(rows) {
  const groups = new Map();
  for (const r of rows) {
    const g = groups.get(r.asOf) || [];
    g.push(r.netReturnPct);
    groups.set(r.asOf, g);
  }
  const dailyMeans = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, values]) => ({ date, mean: mean(values), assets: values.length }));
  const values = dailyMeans.map(d => d.mean);
  if (values.length < 3) return { decisionDates: values.length, meanNetPct: mean(values), tStatistic: null };
  const m = mean(values);
  const variance = values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1);
  const standardError = Math.sqrt(variance / values.length);
  return {
    decisionDates: values.length, meanNetPct: m, standardError,
    tStatistic: standardError > 0 ? m / standardError : null,
    positiveDates: values.filter(v => v > 0).length
  };
}
