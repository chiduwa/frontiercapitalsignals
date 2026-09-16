import test from 'node:test';
import assert from 'node:assert/strict';
import {
  lnGamma, incompleteBeta, regularizedGammaP, normalCdf, tTwoSidedP, fUpperP, chiSquareUpperP,
  invert, matMul, fitLinearModel, hacCovariance, hc1Covariance, clusteredCovariance,
  varianceInflationFactors, durbinWatson, ljungBox, breuschPagan, jarqueBera,
  informationCriteria, outOfSampleR2, benjaminiHochberg, regressionReport, withDesign
} from './scripts/regression-diagnostics.mjs';

const close = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol,
  `expected ${a} within ${tol} of ${b}`);

// Deterministic generator: every test below must reproduce exactly on a rerun,
// because a statistic that only sometimes passes is not a test of the estimator.
function rng(seed = 12345) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
}
function normals(n, seed) {
  const next = rng(seed), out = [];
  while (out.length < n) {
    const u = Math.max(next(), 1e-12), v = next();
    out.push(Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
    out.push(Math.sqrt(-2 * Math.log(u)) * Math.sin(2 * Math.PI * v));
  }
  return out.slice(0, n);
}

test('special functions match their closed forms', () => {
  close(Math.exp(lnGamma(5)), 24, 1e-7);          // Gamma(5) = 4!
  close(Math.exp(lnGamma(0.5)), Math.sqrt(Math.PI), 1e-9);
  close(incompleteBeta(0.5, 1, 1), 0.5, 1e-12);   // uniform CDF
  close(incompleteBeta(0.5, 2, 1), 0.25, 1e-12);  // I_x(2,1) = x^2
  close(incompleteBeta(0.3, 1, 2), 1 - 0.7 ** 2, 1e-12);
  close(regularizedGammaP(1, 1), 1 - Math.exp(-1), 1e-12); // exponential CDF
  close(normalCdf(0), 0.5, 1e-12);
  close(normalCdf(1.959963985), 0.975, 1e-9);
  close(normalCdf(-2.5758293035), 0.005, 1e-10);
});

test('t, F and chi-square p-values satisfy their exact distributional identities', () => {
  // Rather than trusting transcribed table values, each statistic is checked
  // against a closed form it must satisfy exactly. A mistyped critical value
  // would otherwise look like a passing test.
  close(tTwoSidedP(2.228138852, 10), 0.05, 1e-7);      // t(10) 0.975 quantile
  close(tTwoSidedP(1.959963985, 1e7), 0.05, 1e-5);     // converges to the normal
  close(tTwoSidedP(0, 5), 1, 1e-12);
  assert.equal(tTwoSidedP(2, 0), null);

  // chi-square(2) is exponential: upper tail = exp(-x/2).
  for (const x of [0.5, 2, 5.991464547, 12]) close(chiSquareUpperP(x, 2), Math.exp(-x / 2), 1e-12);
  // chi-square(1) at z^2 is the two-sided normal tail.
  for (const z of [0.5, 1.5, 1.959963985, 3]) close(chiSquareUpperP(z * z, 1), 2 * (1 - normalCdf(z)), 1e-10);
  assert.equal(chiSquareUpperP(-1, 3), null);

  // F(1, df) at f is exactly the two-sided t(df) tail at sqrt(f).
  for (const df of [3, 10, 60]) for (const f of [0.25, 1, 4.2, 9]) {
    close(fUpperP(f, 1, df), tTwoSidedP(Math.sqrt(f), df), 1e-10);
  }
  // F(2,2) upper tail has the closed form 1/(1+f).
  for (const f of [0.5, 1, 3, 7]) close(fUpperP(f, 2, 2), 1 / (1 + f), 1e-12);
  // F(2,d2) upper tail is (d2/(2f+d2))^(d2/2).
  for (const [f, d2] of [[1, 4], [2.5, 6], [0.4, 10]]) {
    close(fUpperP(f, 2, d2), (d2 / (2 * f + d2)) ** (d2 / 2), 1e-11);
  }
  // Reciprocal symmetry: the upper tail of F(d1,d2) at f mirrors F(d2,d1) at 1/f.
  for (const [d1, d2, f] of [[3, 7, 2.2], [5, 11, 0.6], [8, 4, 1.9]]) {
    close(fUpperP(f, d1, d2), 1 - fUpperP(1 / f, d2, d1), 1e-10);
  }
  assert.equal(fUpperP(-1, 2, 2), null);
});

test('linear algebra inverts and multiplies exactly', () => {
  const a = [[4, 7], [2, 6]];
  assert.deepEqual(invert(a).map(r => r.map(v => Number(v.toFixed(10)))), [[0.6, -0.7], [-0.2, 0.4]]);
  assert.equal(invert([[1, 2], [2, 4]]), null); // singular
  assert.deepEqual(matMul([[1, 2]], [[3], [4]]), [[11]]);
});

test('OLS recovers a known relationship and its textbook standard errors', () => {
  // y = 3 + 2*x exactly -> zero residuals, exact coefficients.
  const X = Array.from({ length: 20 }, (_, i) => [1, i]);
  const exact = fitLinearModel(X, X.map(([, x]) => 3 + 2 * x));
  close(exact.beta[0], 3, 1e-9);
  close(exact.beta[1], 2, 1e-9);
  close(exact.residuals.reduce((s, v) => s + v * v, 0), 0, 1e-18);
  assert.equal(exact.effectiveDf, 2);

  // With noise, the classical SE must equal sigma^2 * (X'X)^-1 computed by hand.
  const noise = normals(20, 99);
  const y = X.map(([, x], i) => 3 + 2 * x + noise[i]);
  const fit = fitLinearModel(X, y);
  const rss = fit.residuals.reduce((s, v) => s + v * v, 0);
  const sigma2 = rss / (fit.n - fit.p);
  const classical = Math.sqrt(sigma2 * fit.xtxInverse[1][1]);
  const meanX = 9.5;
  const sxx = X.reduce((s, [, x]) => s + (x - meanX) ** 2, 0);
  close(classical, Math.sqrt(sigma2 / sxx), 1e-10);
});

test('the ridge penalty shrinks slopes, spares the intercept, and spends less than p degrees of freedom', () => {
  const X = Array.from({ length: 40 }, (_, i) => [1, i / 10, (i % 7) / 3]);
  const y = X.map(([, a, b]) => 5 + 2 * a - 1.5 * b);
  const ols = fitLinearModel(X, y);
  const ridge = fitLinearModel(X, y, { ridge: 50 });
  assert.ok(Math.abs(ridge.beta[1]) < Math.abs(ols.beta[1]), 'slope must shrink');
  assert.ok(ridge.effectiveDf < 3 && ridge.effectiveDf > 0, `effective df ${ridge.effectiveDf}`);
  assert.equal(ridge.interceptColumn, 0);
  // Penalizing the intercept asserts a zero unconditional mean; confirm the
  // default does NOT do that by showing the option changes the answer.
  const penalized = fitLinearModel(X, y, { ridge: 50, penalizeIntercept: true });
  assert.ok(Math.abs(penalized.beta[0]) < Math.abs(ridge.beta[0]));
});

test('HAC at zero lags equals White/HC1, and widens with positive serial correlation', () => {
  const X = Array.from({ length: 200 }, (_, i) => [1, Math.sin(i / 5)]);
  const e = normals(200, 7);
  const y = X.map(([, x], i) => 1 + 0.5 * x + e[i]);
  const fit = withDesign(fitLinearModel(X, y), X);
  const zeroLag = hacCovariance(fit, { lags: 0 }).covariance;
  const white = hc1Covariance(fit).covariance;
  close(zeroLag[1][1], white[1][1], 1e-12);

  // AR(1) errors: HAC at a horizon-sized lag must report more uncertainty than
  // the lag-0 estimator, which is the whole reason overlapping forecasts need it.
  let prior = 0;
  const correlated = e.map(v => (prior = 0.8 * prior + v));
  const arFit = withDesign(fitLinearModel(X, X.map(([, x], i) => 1 + 0.5 * x + correlated[i])), X);
  const wide = hacCovariance(arFit, { lags: 12 }).covariance;
  const narrow = hacCovariance(arFit, { lags: 0 }).covariance;
  assert.ok(wide[0][0] > narrow[0][0] * 1.5, `HAC ${wide[0][0]} vs ${narrow[0][0]}`);
  assert.equal(hacCovariance(arFit, { lags: 12 }).kernel, 'bartlett');
});

test('clustering on a key collapses duplicated observations to their real information', () => {
  // Same 20 observations repeated 10 times within their cluster. Clustering
  // must not be fooled into reporting sqrt(10) times more precision.
  const base = Array.from({ length: 20 }, (_, i) => [1, (i % 5) - 2]);
  const noise = normals(20, 31);
  const X = [], y = [], groups = [];
  for (let d = 0; d < 20; d++) {
    for (let k = 0; k < 10; k++) { X.push(base[d]); y.push(1 + 0.4 * base[d][1] + noise[d]); groups.push(`day${d}`); }
  }
  const fit = withDesign(fitLinearModel(X, y), X);
  const naive = hc1Covariance(fit).covariance[0][0];
  const clustered = clusteredCovariance(fit, groups);
  assert.equal(clustered.clusters, 20);
  assert.ok(clustered.covariance[0][0] > naive * 5,
    `clustered ${clustered.covariance[0][0]} should dwarf naive ${naive}`);
});

test('VIF detects collinearity and stays near 1 for orthogonal columns', () => {
  const n = 120, a = normals(n, 5), b = normals(n, 6);
  const orthogonal = Array.from({ length: n }, (_, i) => [1, a[i], b[i]]);
  const vifs = varianceInflationFactors(orthogonal, ['intercept', 'a', 'b']);
  assert.ok(vifs.a > 0.9 && vifs.a < 1.5, `orthogonal VIF ${vifs.a}`);
  assert.equal(vifs.intercept, undefined, 'the constant column has no VIF');
  const collinear = Array.from({ length: n }, (_, i) => [1, a[i], a[i] + b[i] * 1e-3]);
  assert.ok(varianceInflationFactors(collinear, ['intercept', 'a', 'c']).a > 100);
});

test('residual diagnostics separate white noise from structure', () => {
  const white = normals(400, 11);
  close(durbinWatson(white), 2, 0.25);
  assert.ok(ljungBox(white, { lags: 10 }).pValue > 0.05, 'white noise must not be flagged');
  let prior = 0;
  const ar = white.map(v => (prior = 0.7 * prior + v));
  assert.ok(durbinWatson(ar) < 1, `DW ${durbinWatson(ar)} should fall well below 2`);
  assert.ok(ljungBox(ar, { lags: 10 }).pValue < 1e-6);
  assert.ok(ljungBox(ar, { lags: 10 }).autocorrelations[0] > 0.5);

  // Jarque-Bera: normal passes, a fat-tailed mixture does not.
  assert.ok(jarqueBera(white).pValue > 0.05);
  const fatTailed = white.map((v, i) => (i % 40 === 0 ? v * 12 : v));
  assert.ok(jarqueBera(fatTailed).pValue < 0.01);
  assert.ok(jarqueBera(fatTailed).kurtosis > 3);
});

test('Breusch-Pagan finds variance that scales with a regressor', () => {
  const n = 300, e = normals(n, 17), x = normals(n, 18);
  const X = Array.from({ length: n }, (_, i) => [1, x[i]]);
  const homoskedastic = withDesign(fitLinearModel(X, X.map(([, v], i) => 1 + v + e[i])), X);
  assert.ok(breuschPagan(homoskedastic).pValue > 0.05);
  // The variance must be MONOTONE in the regressor: scaling it by |x| is
  // symmetric, so the auxiliary regression of u^2 on x has no slope to find.
  const heteroskedastic = withDesign(
    fitLinearModel(X, X.map(([, v], i) => 1 + v + e[i] * Math.exp(0.8 * v))), X);
  assert.ok(breuschPagan(heteroskedastic).pValue < 0.01);
});

test('information criteria and out-of-sample R-squared behave as defined', () => {
  const residuals = normals(100, 23);
  const small = informationCriteria({ n: 100, effectiveDf: 2, residuals });
  const large = informationCriteria({ n: 100, effectiveDf: 8, residuals });
  assert.ok(large.aic > small.aic, 'more parameters at equal fit must cost AIC');
  assert.ok(large.bic - small.bic > large.aic - small.aic, 'BIC penalizes harder at n=100');

  // OOS R2 is negative exactly when the forecast beats neither the benchmark.
  close(outOfSampleR2([1, -1, 1, -1], [1, -1, 1, -1]), 1, 1e-12);
  close(outOfSampleR2([1, -1, 1, -1], [0, 0, 0, 0]), 0, 1e-12);
  assert.ok(outOfSampleR2([1, -1, 1, -1], [-1, 1, -1, 1]) < 0);
  assert.equal(outOfSampleR2([], []), null);
});

test('Benjamini-Hochberg controls discoveries and reproduces a hand-worked example', () => {
  // m=5, q=0.1. Thresholds i/m*q = .02 .04 .06 .08 .10
  // p = .001 .050 .055 .060 .900. Sorted, i=2 FAILS (.050 > .04) but i=4 passes
  // (.060 <= .08), and BH steps up: everything below the last passing rank is
  // rejected, including the one that failed on its own. That is the procedure.
  const { discoveries, rejected, qValues } = benjaminiHochberg([0.001, 0.05, 0.055, 0.06, 0.9],
    { falseDiscoveryRate: 0.1 });
  assert.equal(discoveries, 4);
  assert.deepEqual(rejected, [true, true, true, true, false]);
  close(qValues[0], 0.005, 1e-12);      // .001*5/1
  close(qValues[3], 0.075, 1e-12);      // .060*5/4
  const ascending = [...qValues].sort((a, b) => a - b);
  assert.deepEqual(qValues, ascending, 'q-values must be monotone in p');

  // 500 null tests at uniform p: BH must find essentially nothing, which is the
  // property that stops a 500-asset sweep from manufacturing winners.
  const next = rng(4242);
  const nulls = Array.from({ length: 500 }, () => next());
  assert.ok(benjaminiHochberg(nulls, { falseDiscoveryRate: 0.1 }).discoveries <= 2);
  // ...but a genuinely strong subset survives in full. BH does not promise
  // zero false discoveries, it promises their PROPORTION stays near the rate,
  // so the test is "found every real one, and the tag-alongs stayed under q".
  const mixed = [...Array.from({ length: 480 }, () => next()), ...Array(20).fill(1e-8)];
  const found = benjaminiHochberg(mixed, { falseDiscoveryRate: 0.1 });
  assert.ok(mixed.every((p, i) => p > 1e-6 || found.rejected[i]), 'every real signal must be found');

  // BH controls the false discovery rate IN EXPECTATION, so a single draw may
  // exceed q and that is not a defect. Averaging over independent replications
  // is the property worth asserting, and the one that protects a 500-asset sweep.
  let totalProportion = 0;
  const replications = 200;
  for (let r = 0; r < replications; r++) {
    const draw = [...Array.from({ length: 480 }, () => next()), ...Array(20).fill(1e-8)];
    const outcome = benjaminiHochberg(draw, { falseDiscoveryRate: 0.1 });
    const wrong = outcome.rejected.filter((flag, i) => flag && draw[i] > 1e-6).length;
    totalProportion += outcome.discoveries ? wrong / outcome.discoveries : 0;
  }
  const meanFdp = totalProportion / replications;
  assert.ok(meanFdp <= 0.1, `mean false discovery proportion ${meanFdp.toFixed(4)} must respect q`);
  assert.equal(benjaminiHochberg([NaN, null]).tests, 0);
});

test('regressionReport assembles a complete, self-consistent description', () => {
  const n = 250, e = normals(n, 77), a = normals(n, 78), b = normals(n, 79);
  const X = Array.from({ length: n }, (_, i) => [1, a[i], b[i]]);
  const y = X.map(([, p, q], i) => 0.5 + 1.2 * p + e[i] * 0.8 + 0 * q);
  const report = regressionReport(X, y, { names: ['intercept', 'signal', 'noise'], lags: 5 });
  assert.equal(report.observations, n);
  assert.equal(report.coefficients.length, 3);
  assert.equal(report.errorModel, 'hac');
  assert.equal(report.hacLags, 5);
  const signal = report.coefficients.find(c => c.name === 'signal');
  const noise = report.coefficients.find(c => c.name === 'noise');
  close(signal.estimate, 1.2, 0.15);
  assert.ok(signal.pValue < 1e-10, `real coefficient p=${signal.pValue}`);
  assert.ok(noise.pValue > 0.05, `null coefficient p=${noise.pValue}`);
  assert.ok(report.rSquared > 0.6 && report.rSquared < 1);
  assert.ok(report.adjustedRSquared < report.rSquared);
  assert.ok(report.jointSignificance.pValue < 1e-10);
  assert.equal(report.jointSignificance.df, 2);
  assert.ok(Object.values(report.vif).every(v => v < 1.5));
  assert.ok(report.residualDiagnostics.aic < report.residualDiagnostics.bic);
  assert.ok(report.residualDiagnostics.ljungBox.pValue > 0.01);

  // A pure-noise response must not produce a significant joint test.
  const nullReport = regressionReport(X, e, { names: ['intercept', 'signal', 'noise'], lags: 5 });
  assert.ok(nullReport.jointSignificance.pValue > 0.05, `null joint p=${nullReport.jointSignificance.pValue}`);
  assert.ok(nullReport.rSquared < 0.05);
});

test('estimation refuses malformed input rather than returning a confident number', () => {
  assert.throws(() => fitLinearModel([], []), /non-empty/);
  assert.throws(() => fitLinearModel([[1, 2]], [1, 2]), /equal length/);
  assert.throws(() => fitLinearModel([[1, NaN]], [1]), /finite/);
  assert.throws(() => fitLinearModel([[1, 0]], [Infinity]), /finite/);
  assert.equal(fitLinearModel([[1, 1], [1, 1]], [1, 2]), null, 'singular design returns null');
  const fit = fitLinearModel([[1, 0], [1, 1], [1, 2]], [0, 1, 2]);
  assert.throws(() => hacCovariance(fit, { lags: 1 }), /design matrix/);
  assert.throws(() => clusteredCovariance(withDesign(fit, [[1, 0], [1, 1], [1, 2]]), ['a']), /One cluster key/);
});
