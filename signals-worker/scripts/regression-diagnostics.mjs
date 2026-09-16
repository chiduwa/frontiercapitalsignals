// Regression inference for the per-asset learners. Pure, dependency-free and
// separately testable: nothing here reads the archive, the ledger or the clock.
//
// Every estimator in this file exists because a specific measurement in this
// project was wrong without it. Overlapping forecast windows and within-day
// cross-sectional correlation both inflate ordinary t-statistics here, which
// is how `docs/PREDICTION_WEIGHTS_EVIDENCE.md` turned an apparent t=1.2 into
// significance; HAC errors and date clustering are the corrections. Fitting
// ~500 assets at once manufactures winners by construction, which is what the
// Benjamini-Hochberg pass is for.

// ---------------------------------------------------------------------------
// Special functions. Needed for exact p-values without a numerics dependency.
// ---------------------------------------------------------------------------

const LANCZOS = [676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012,
  9.9843695780195716e-6, 1.5056327351493116e-7];

export function lnGamma(x) {
  if (!(x > 0)) return NaN;
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  const z = x - 1;
  let a = 0.99999999999980993;
  for (let i = 0; i < LANCZOS.length; i++) a += LANCZOS[i] / (z + i + 1);
  const t = z + LANCZOS.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

// Modified Lentz evaluation of the beta continued fraction. Kept as a separate
// function so the symmetry swap below cannot accidentally reorder its terms.
function betaContinuedFraction(x, a, b) {
  const tiny = 1e-300, epsilon = 1e-15;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - qab * x / qap;
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 500; m++) {
    const m2 = 2 * m;
    let numerator = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + numerator * d; if (Math.abs(d) < tiny) d = tiny;
    c = 1 + numerator / c; if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    numerator = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + numerator * d; if (Math.abs(d) < tiny) d = tiny;
    c = 1 + numerator / c; if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < epsilon) break;
  }
  return h;
}

// Regularized incomplete beta I_x(a,b). The fraction only converges quickly on
// one side of the mean, so the far side is evaluated through the symmetry
// I_x(a,b) = 1 - I_{1-x}(b,a).
export function incompleteBeta(x, a, b) {
  if (!(a > 0 && b > 0) || !Number.isFinite(x)) return NaN;
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b)
    + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2)
    ? front * betaContinuedFraction(x, a, b) / a
    : 1 - front * betaContinuedFraction(1 - x, b, a) / b;
}

// Regularized lower incomplete gamma P(a,x): series below the crossover,
// continued fraction above it.
export function regularizedGammaP(a, x) {
  if (!(a > 0) || !(x >= 0)) return NaN;
  if (x === 0) return 0;
  if (x < a + 1) {
    let term = 1 / a, sum = term;
    for (let n = 1; n <= 1000; n++) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-15) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - lnGamma(a));
  }
  const tiny = 1e-300;
  let b = x + 1 - a, c = 1 / tiny, d = 1 / b, h = d;
  for (let i = 1; i <= 1000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-15) break;
  }
  return 1 - Math.exp(-x + a * Math.log(x) - lnGamma(a)) * h;
}

export const normalCdf = z => Number.isFinite(z)
  ? 0.5 * (1 + Math.sign(z) * regularizedGammaP(0.5, z * z / 2)) : NaN;

/** Two-sided p-value for a t statistic. df <= 0 returns null, not 1. */
export function tTwoSidedP(t, df) {
  if (!Number.isFinite(t) || !(df > 0)) return null;
  return incompleteBeta(df / (df + t * t), df / 2, 0.5);
}

/** Upper-tail p-value for an F statistic (the usual direction for a Wald test). */
export function fUpperP(f, df1, df2) {
  if (!Number.isFinite(f) || f < 0 || !(df1 > 0) || !(df2 > 0)) return null;
  return 1 - incompleteBeta(df1 * f / (df1 * f + df2), df1 / 2, df2 / 2);
}

/** Upper-tail p-value for a chi-square statistic. */
export function chiSquareUpperP(x, df) {
  if (!Number.isFinite(x) || x < 0 || !(df > 0)) return null;
  return 1 - regularizedGammaP(df / 2, x / 2);
}

// ---------------------------------------------------------------------------
// Linear algebra. Small dense systems only (p is under ~30 here).
// ---------------------------------------------------------------------------

export function matMul(a, b) {
  const n = a.length, k = b.length, m = b[0].length;
  const out = Array.from({ length: n }, () => Array(m).fill(0));
  for (let i = 0; i < n; i++) {
    for (let t = 0; t < k; t++) {
      const v = a[i][t];
      if (v === 0) continue;
      for (let j = 0; j < m; j++) out[i][j] += v * b[t][j];
    }
  }
  return out;
}

/** Gauss-Jordan inverse with partial pivoting. Returns null if singular. */
export function invert(matrix) {
  const n = matrix.length;
  const m = matrix.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let k = 0; k < n; k++) {
    let pivot = k;
    for (let i = k + 1; i < n; i++) if (Math.abs(m[i][k]) > Math.abs(m[pivot][k])) pivot = i;
    if (Math.abs(m[pivot][k]) < 1e-12) return null;
    [m[k], m[pivot]] = [m[pivot], m[k]];
    const d = m[k][k];
    for (let j = 0; j < 2 * n; j++) m[k][j] /= d;
    for (let i = 0; i < n; i++) {
      if (i === k) continue;
      const f = m[i][k];
      if (f === 0) continue;
      for (let j = 0; j < 2 * n; j++) m[i][j] -= f * m[k][j];
    }
  }
  return m.map(row => row.slice(n));
}

const crossProduct = X => {
  const p = X[0].length;
  const out = Array.from({ length: p }, () => Array(p).fill(0));
  for (const row of X) {
    for (let i = 0; i < p; i++) {
      for (let j = i; j < p; j++) out[i][j] += row[i] * row[j];
    }
  }
  for (let i = 0; i < p; i++) for (let j = 0; j < i; j++) out[i][j] = out[j][i];
  return out;
};

// ---------------------------------------------------------------------------
// Estimation
// ---------------------------------------------------------------------------

/**
 * Least squares with an optional ridge penalty. The penalty is never applied to
 * a constant column: shrinking the intercept toward zero silently asserts that
 * the unconditional mean return is zero, which is a claim, not a regularizer.
 */
export function fitLinearModel(X, y, { ridge = 0, penalizeIntercept = false } = {}) {
  if (!Array.isArray(X) || !X.length || !Array.isArray(y) || y.length !== X.length) {
    throw new Error('Design matrix and response must be non-empty and equal length');
  }
  const p = X[0].length, n = X.length;
  if (X.some(row => row.length !== p || row.some(v => !Number.isFinite(v)))
    || y.some(v => !Number.isFinite(v))) throw new Error('Design matrix and response must be finite');
  const interceptColumn = penalizeIntercept ? -1 : X[0].findIndex((_, j) => X.every(row => row[j] === X[0][j]));
  const xtx = crossProduct(X);
  const xty = Array(p).fill(0);
  for (let t = 0; t < n; t++) for (let i = 0; i < p; i++) xty[i] += X[t][i] * y[t];
  const penalized = xtx.map((row, i) => row.map((v, j) =>
    v + (i === j && i !== interceptColumn ? ridge : 0)));
  const inverse = invert(penalized);
  if (!inverse) return null;
  const beta = inverse.map(row => row.reduce((s, v, j) => s + v * xty[j], 0));
  const fitted = X.map(row => row.reduce((s, v, j) => s + v * beta[j], 0));
  const residuals = y.map((v, t) => v - fitted[t]);
  // Ridge spends fewer than p degrees of freedom: tr(H) = tr((X'X+λI)^-1 X'X).
  const effectiveDf = ridge > 0
    ? matMul(inverse, xtx).reduce((s, row, i) => s + row[i], 0)
    : p;
  return { beta, fitted, residuals, xtx, xtxInverse: inverse, n, p, ridge, effectiveDf, interceptColumn };
}

/**
 * Newey-West HAC covariance. `lags` must be at least the overlap induced by the
 * forecast horizon: a 7-day forecast sampled daily shares 6 days of its target
 * window with its neighbour, so its residuals are serially correlated by
 * construction and lag 0 understates the variance badly.
 */
export function hacCovariance(fit, { lags, smallSample = true } = {}) {
  const { residuals: u, n, p, xtxInverse, effectiveDf } = fit;
  const X = fit.X || null;
  const design = X || fit.design;
  if (!design) throw new Error('hacCovariance needs the design matrix; pass it via withDesign()');
  const L = Math.max(0, Math.min(Math.floor(lags ?? Math.floor(4 * (n / 100) ** (2 / 9))), n - 1));
  const meat = Array.from({ length: p }, () => Array(p).fill(0));
  const add = (t, s, weight) => {
    for (let i = 0; i < p; i++) {
      const left = design[t][i] * u[t];
      for (let j = 0; j < p; j++) meat[i][j] += weight * left * design[s][j] * u[s];
    }
  };
  for (let t = 0; t < n; t++) add(t, t, 1);
  for (let l = 1; l <= L; l++) {
    const w = 1 - l / (L + 1); // Bartlett kernel; guarantees a PSD estimate
    for (let t = l; t < n; t++) { add(t, t - l, w); add(t - l, t, w); }
  }
  const scale = smallSample && n > effectiveDf ? n / (n - effectiveDf) : 1;
  const scaled = meat.map(row => row.map(v => v * scale));
  return { covariance: matMul(matMul(xtxInverse, scaled), xtxInverse), lags: L, kernel: 'bartlett' };
}

/** White/HC1 covariance: heteroskedasticity-robust, no serial-correlation term. */
export function hc1Covariance(fit) {
  const design = fit.X || fit.design;
  if (!design) throw new Error('hc1Covariance needs the design matrix; pass it via withDesign()');
  const { residuals: u, n, p, xtxInverse, effectiveDf } = fit;
  const meat = Array.from({ length: p }, () => Array(p).fill(0));
  for (let t = 0; t < n; t++) {
    const u2 = u[t] * u[t];
    for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) meat[i][j] += u2 * design[t][i] * design[t][j];
  }
  const scale = n > effectiveDf ? n / (n - effectiveDf) : 1;
  const scaled = meat.map(row => row.map(v => v * scale));
  return { covariance: matMul(matMul(xtxInverse, scaled), xtxInverse) };
}

/**
 * Covariance clustered on a grouping key. Within-day cross-sectional
 * correlation is the specific failure this project already hit once: pooled
 * quintiles looked significant at t~1.2 until they were clustered by date.
 */
export function clusteredCovariance(fit, groups) {
  const design = fit.X || fit.design;
  if (!design) throw new Error('clusteredCovariance needs the design matrix; pass it via withDesign()');
  const { residuals: u, n, p, xtxInverse, effectiveDf } = fit;
  if (!Array.isArray(groups) || groups.length !== n) throw new Error('One cluster key per observation is required');
  const sums = new Map();
  for (let t = 0; t < n; t++) {
    const key = String(groups[t]);
    const acc = sums.get(key) || Array(p).fill(0);
    for (let i = 0; i < p; i++) acc[i] += design[t][i] * u[t];
    sums.set(key, acc);
  }
  const meat = Array.from({ length: p }, () => Array(p).fill(0));
  for (const acc of sums.values()) {
    for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) meat[i][j] += acc[i] * acc[j];
  }
  const g = sums.size;
  const scale = g > 1 && n > effectiveDf ? (g / (g - 1)) * ((n - 1) / (n - effectiveDf)) : 1;
  const scaled = meat.map(row => row.map(v => v * scale));
  return { covariance: matMul(matMul(xtxInverse, scaled), xtxInverse), clusters: g };
}

// ---------------------------------------------------------------------------
// Fit quality and residual diagnostics
// ---------------------------------------------------------------------------

export function varianceInflationFactors(X, names = null) {
  const p = X[0].length;
  const constant = X[0].map((_, j) => X.every(row => row[j] === X[0][j]));
  const out = {};
  for (let j = 0; j < p; j++) {
    if (constant[j]) continue;
    const others = X.map(row => [1, ...row.filter((_, k) => k !== j && !constant[k])]);
    const target = X.map(row => row[j]);
    const fit = fitLinearModel(others, target);
    const label = names?.[j] ?? `x${j}`;
    if (!fit) { out[label] = null; continue; }
    const mean = target.reduce((s, v) => s + v, 0) / target.length;
    const tss = target.reduce((s, v) => s + (v - mean) ** 2, 0);
    const rss = fit.residuals.reduce((s, v) => s + v * v, 0);
    out[label] = tss > 0 && rss < tss ? 1 / (1 - (1 - rss / tss)) : null;
  }
  return out;
}

export function durbinWatson(residuals) {
  if (residuals.length < 2) return null;
  let num = 0, den = 0;
  for (let t = 0; t < residuals.length; t++) {
    den += residuals[t] ** 2;
    if (t) num += (residuals[t] - residuals[t - 1]) ** 2;
  }
  return den > 0 ? num / den : null;
}

/** Ljung-Box Q on residual autocorrelation, df reduced by the fitted parameters. */
export function ljungBox(residuals, { lags = 10, fittedParameters = 0 } = {}) {
  const n = residuals.length;
  const h = Math.min(lags, n - 2);
  if (!(h > 0)) return null;
  const mean = residuals.reduce((s, v) => s + v, 0) / n;
  const centred = residuals.map(v => v - mean);
  const c0 = centred.reduce((s, v) => s + v * v, 0);
  if (!(c0 > 0)) return null;
  let q = 0;
  const autocorrelations = [];
  for (let k = 1; k <= h; k++) {
    let ck = 0;
    for (let t = k; t < n; t++) ck += centred[t] * centred[t - k];
    const rho = ck / c0;
    autocorrelations.push(rho);
    q += rho * rho / (n - k);
  }
  q *= n * (n + 2);
  const df = Math.max(1, h - fittedParameters);
  return { statistic: q, lags: h, df, pValue: chiSquareUpperP(q, df), autocorrelations };
}

/** Breusch-Pagan LM test: regress squared residuals on the same design. */
export function breuschPagan(fit) {
  const design = fit.X || fit.design;
  if (!design) throw new Error('breuschPagan needs the design matrix; pass it via withDesign()');
  const u2 = fit.residuals.map(v => v * v);
  const auxiliary = fitLinearModel(design, u2);
  if (!auxiliary) return null;
  const mean = u2.reduce((s, v) => s + v, 0) / u2.length;
  const tss = u2.reduce((s, v) => s + (v - mean) ** 2, 0);
  const rss = auxiliary.residuals.reduce((s, v) => s + v * v, 0);
  if (!(tss > 0)) return null;
  const r2 = 1 - rss / tss;
  const df = Math.max(1, design[0].length - 1);
  const statistic = fit.n * r2;
  return { statistic, df, pValue: chiSquareUpperP(statistic, df) };
}

export function jarqueBera(residuals) {
  const n = residuals.length;
  if (n < 4) return null;
  const mean = residuals.reduce((s, v) => s + v, 0) / n;
  const m = k => residuals.reduce((s, v) => s + (v - mean) ** k, 0) / n;
  const m2 = m(2);
  if (!(m2 > 0)) return null;
  const skewness = m(3) / m2 ** 1.5;
  const kurtosis = m(4) / (m2 * m2);
  const statistic = n / 6 * (skewness ** 2 + (kurtosis - 3) ** 2 / 4);
  return { statistic, df: 2, pValue: chiSquareUpperP(statistic, 2), skewness, kurtosis };
}

export function informationCriteria({ n, effectiveDf, residuals }) {
  const rss = residuals.reduce((s, v) => s + v * v, 0);
  if (!(n > 0) || !(rss > 0)) return { aic: null, bic: null, logLikelihood: null };
  const logLikelihood = -0.5 * n * (Math.log(2 * Math.PI) + Math.log(rss / n) + 1);
  const k = effectiveDf + 1; // + the error variance
  return { logLikelihood, aic: -2 * logLikelihood + 2 * k, bic: -2 * logLikelihood + k * Math.log(n) };
}

/**
 * Campbell-Thompson out-of-sample R-squared against a named benchmark forecast
 * (zero, by default). In-sample R-squared on a walk-forward learner measures
 * nothing; this is the number that can go negative, and usually should.
 */
export function outOfSampleR2(actual, predicted, benchmark = null) {
  if (actual.length !== predicted.length || !actual.length) return null;
  let sse = 0, sseBenchmark = 0;
  for (let i = 0; i < actual.length; i++) {
    const base = benchmark ? benchmark[i] : 0;
    sse += (actual[i] - predicted[i]) ** 2;
    sseBenchmark += (actual[i] - base) ** 2;
  }
  return sseBenchmark > 0 ? 1 - sse / sseBenchmark : null;
}

// ---------------------------------------------------------------------------
// Multiple comparisons
// ---------------------------------------------------------------------------

/**
 * Benjamini-Hochberg. Fitting one model per asset across a 500-asset universe
 * produces significant-looking cells at the nominal rate by construction; this
 * is what separates "this asset is different" from "we ran 500 tests".
 */
export function benjaminiHochberg(pValues, { falseDiscoveryRate = 0.1 } = {}) {
  const valid = pValues.map((p, index) => ({ p, index })).filter(e => Number.isFinite(e.p));
  const m = valid.length;
  if (!m) return { qValues: pValues.map(() => null), rejected: pValues.map(() => false), discoveries: 0, tests: 0 };
  const sorted = [...valid].sort((a, b) => a.p - b.p);
  const q = Array(pValues.length).fill(null);
  let running = 1;
  for (let i = m - 1; i >= 0; i--) {
    running = Math.min(running, sorted[i].p * m / (i + 1));
    q[sorted[i].index] = Math.min(1, running);
  }
  let cutoff = -1;
  for (let i = 0; i < m; i++) if (sorted[i].p <= (i + 1) / m * falseDiscoveryRate) cutoff = i;
  const rejectedSet = new Set(sorted.slice(0, cutoff + 1).map(e => e.index));
  return { qValues: q, rejected: pValues.map((_, i) => rejectedSet.has(i)),
    discoveries: cutoff + 1, tests: m, falseDiscoveryRate };
}

// ---------------------------------------------------------------------------
// The assembled report
// ---------------------------------------------------------------------------

/** Attach the design matrix so the covariance estimators can reach it. */
export const withDesign = (fit, X) => fit && Object.assign(fit, { design: X });

/**
 * One regression, fully described: coefficients with robust errors, joint
 * significance, collinearity, and residual diagnostics. `errors` picks the
 * covariance estimator; 'hac' is the right default for overlapping horizons.
 */
export function regressionReport(X, y, {
  names = null, ridge = 0, errors = 'hac', lags = null, clusters = null,
  benchmarkPredictions = null
} = {}) {
  const fit = withDesign(fitLinearModel(X, y, { ridge }), X);
  if (!fit) return null;
  const labels = names ?? X[0].map((_, j) => `x${j}`);
  const robust = errors === 'cluster' && clusters ? clusteredCovariance(fit, clusters)
    : errors === 'hc1' ? hc1Covariance(fit)
      : hacCovariance(fit, { lags });
  const covariance = robust.covariance;
  const df = Math.max(1, Math.round(fit.n - fit.effectiveDf));
  const standardErrors = covariance.map((row, i) => (row[i] > 0 ? Math.sqrt(row[i]) : null));
  const coefficients = fit.beta.map((b, i) => {
    const se = standardErrors[i];
    const t = se ? b / se : null;
    return { name: labels[i], estimate: b, standardError: se, tStatistic: t,
      pValue: t == null ? null : tTwoSidedP(t, df) };
  });
  const mean = y.reduce((s, v) => s + v, 0) / y.length;
  const tss = y.reduce((s, v) => s + (v - mean) ** 2, 0);
  const rss = fit.residuals.reduce((s, v) => s + v * v, 0);
  const r2 = tss > 0 ? 1 - rss / tss : null;
  const adjusted = r2 != null && fit.n > fit.effectiveDf
    ? 1 - (1 - r2) * (fit.n - 1) / (fit.n - fit.effectiveDf) : null;
  // Joint Wald test on the slopes, using the SAME robust covariance as the
  // per-coefficient errors. An F built from the naive RSS would contradict them.
  const slopeIndices = labels.map((_, i) => i).filter(i => i !== fit.interceptColumn);
  let wald = null;
  if (slopeIndices.length) {
    const sub = slopeIndices.map(i => slopeIndices.map(j => covariance[i][j]));
    const inverse = invert(sub);
    if (inverse) {
      const b = slopeIndices.map(i => fit.beta[i]);
      const stat = b.reduce((s, bi, i) => s + bi * inverse[i].reduce((t, v, j) => t + v * b[j], 0), 0);
      const q = slopeIndices.length;
      wald = { statistic: stat, df: q, pValue: chiSquareUpperP(stat, q),
        fStatistic: stat / q, fPValue: fUpperP(stat / q, q, df) };
    }
  }
  return {
    observations: fit.n, parameters: fit.p, effectiveDf: fit.effectiveDf, residualDf: df,
    ridge, errorModel: errors === 'cluster' && clusters ? 'cluster' : errors,
    hacLags: robust.lags ?? null, clusters: robust.clusters ?? null,
    coefficients, rSquared: r2, adjustedRSquared: adjusted,
    outOfSampleR2: benchmarkPredictions
      ? outOfSampleR2(y, fit.fitted, benchmarkPredictions) : null,
    jointSignificance: wald,
    vif: varianceInflationFactors(X, labels),
    residualDiagnostics: {
      durbinWatson: durbinWatson(fit.residuals),
      ljungBox: ljungBox(fit.residuals, { fittedParameters: Math.round(fit.effectiveDf) }),
      breuschPagan: breuschPagan(fit),
      jarqueBera: jarqueBera(fit.residuals),
      ...informationCriteria(fit)
    },
    fit
  };
}
