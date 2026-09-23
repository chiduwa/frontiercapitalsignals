// Classical time-series models, and the decomposition they imply.
//
// Four families, each the textbook answer to one question:
//
//   GARCH(1,1)      how large will the next move be? Volatility clusters, and
//                   the clustering decays at a rate the data can estimate.
//   weekday factor  does the day of the week change the size of the move?
//   ARIMA(p,1,0)    does the recent path of returns say anything about the
//                   next one? Order chosen by BIC, drift included.
//   structural      log price = trend + weekly seasonal + cycle + irregular,
//                   estimated by Kalman filter (Harvey's basic structural model
//                   with a stochastic cycle). The only one of the four whose
//                   parameters ARE the decomposition.
//
// None of this publishes anything. The models enter the candidate field in
// model-zoo.mjs, where they are scored on direction and magnitude separately
// and only ever reported by survivorship cohort. The decomposition is
// descriptive: each component carries its own significance test, because a
// band-pass filter applied to a pure random walk manufactures cycles
// (Slutsky-Yule), and a "cycle" that a random walk would also show is not a
// cycle.

import {
  fitLinearModel, withDesign, hacCovariance, chiSquareUpperP, tTwoSidedP, ljungBox, normalCdf
} from './regression-diagnostics.mjs';
import { sanitizeBars } from './panel-features.mjs';

export const TIME_SERIES_VERSION = 'time-series-v1';

const DAY = 86400000;
const dateMs = d => Date.parse(`${d}T00:00:00Z`);
const isoDay = ms => new Date(ms).toISOString().slice(0, 10);
const mean = xs => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null);
const logistic = u => 1 / (1 + Math.exp(-u));
const logit = p => Math.log(p / (1 - p));
const clampNumber = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const weekdayOf = date => new Date(dateMs(date)).getUTCDay(); // 0 = Sunday

function median(xs) {
  if (!xs.length) return null;
  const s = Float64Array.from(xs).sort();
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ---------------------------------------------------------------------------
// Returns and calendars
// ---------------------------------------------------------------------------

/**
 * Close-to-close log returns between consecutive valid bars, dated by the bar
 * that closes the interval. The same convention `volatilityScales` uses, so a
 * time-series forecast and the incumbents it is compared against see exactly
 * the same inputs.
 */
export function barReturns(bars) {
  const out = [];
  for (let i = 1; i < (bars || []).length; i++) {
    const a = bars[i - 1].close, b = bars[i].close;
    if (!(a > 0) || !(b > 0)) continue;
    const r = Math.log(b / a);
    if (Number.isFinite(r)) out.push({ date: bars[i].date, r, index: i });
  }
  return out;
}

/**
 * The next `h` session dates after `date`. Crypto trades every calendar day;
 * equities trade Monday to Friday. Exchange holidays are not modelled: a
 * seasonal factor looked up for a holiday is a weekday's factor, which is the
 * right answer for the session that actually follows.
 */
export function nextSessionDates(date, h, calendar = 'calendar') {
  const out = [];
  let ms = dateMs(date);
  while (out.length < h) {
    ms += DAY;
    const wd = new Date(ms).getUTCDay();
    if (calendar === 'business' && (wd === 0 || wd === 6)) continue;
    out.push(isoDay(ms));
  }
  return out;
}

export const calendarFor = assetClass => (['stock', 'benchmark'].includes(assetClass) ? 'business' : 'calendar');

// ---------------------------------------------------------------------------
// Optimizer
// ---------------------------------------------------------------------------

/**
 * Nelder-Mead simplex minimization. Small, derivative-free, and adequate for
 * the two-to-six parameter likelihoods here. Non-finite objective values are
 * treated as +Infinity so a parameter that breaks the filter is simply
 * rejected rather than propagating NaN through the simplex.
 */
export function nelderMead(f, x0, { step = 0.5, maxEvaluations = 400, tolerance = 1e-8 } = {}) {
  const n = x0.length;
  let evaluations = 0;
  const evaluate = x => {
    evaluations++;
    const v = f(x);
    return Number.isFinite(v) ? v : Infinity;
  };
  let simplex = [x0.slice()];
  for (let i = 0; i < n; i++) {
    const x = x0.slice();
    x[i] += Array.isArray(step) ? step[i] : step;
    simplex.push(x);
  }
  let values = simplex.map(evaluate);
  while (evaluations < maxEvaluations) {
    const order = values.map((_, i) => i).sort((a, b) => values[a] - values[b]);
    simplex = order.map(i => simplex[i]);
    values = order.map(i => values[i]);
    const spread = Math.abs(values[n] - values[0]);
    if (Number.isFinite(spread) && spread <= tolerance * (Math.abs(values[0]) + tolerance)) break;
    const centroid = Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) centroid[j] += simplex[i][j] / n;
    const worst = simplex[n];
    const reflected = centroid.map((c, j) => c + (c - worst[j]));
    const fr = evaluate(reflected);
    if (fr < values[0]) {
      const expanded = centroid.map((c, j) => c + 2 * (c - worst[j]));
      const fe = evaluate(expanded);
      if (fe < fr) { simplex[n] = expanded; values[n] = fe; } else { simplex[n] = reflected; values[n] = fr; }
    } else if (fr < values[n - 1]) {
      simplex[n] = reflected; values[n] = fr;
    } else {
      const outside = fr < values[n];
      const contracted = outside
        ? centroid.map((c, j) => c + 0.5 * (reflected[j] - c))
        : centroid.map((c, j) => c + 0.5 * (worst[j] - c));
      const fc = evaluate(contracted);
      if (fc < (outside ? fr : values[n])) {
        simplex[n] = contracted; values[n] = fc;
      } else {
        for (let i = 1; i <= n; i++) {
          simplex[i] = simplex[i].map((v, j) => simplex[0][j] + 0.5 * (v - simplex[0][j]));
          values[i] = evaluate(simplex[i]);
        }
      }
    }
  }
  let best = 0;
  for (let i = 1; i <= n; i++) if (values[i] < values[best]) best = i;
  return { x: simplex[best], value: values[best], evaluations, converged: evaluations < maxEvaluations };
}

// ---------------------------------------------------------------------------
// GARCH(1,1)
// ---------------------------------------------------------------------------

// Persistence is capped below one: an integrated GARCH has no long-run
// variance to revert to, and EWMA -- already in the field -- IS that model.
const MAX_PERSISTENCE = 0.9995;

function garchParameters(u) {
  const persistence = MAX_PERSISTENCE * logistic(u[0]);
  const share = logistic(u[1]);
  return { alpha: persistence * share, beta: persistence * (1 - share), persistence };
}

/**
 * Gaussian quasi-likelihood with variance targeting: omega is pinned so the
 * unconditional variance equals the sample second moment. That removes the
 * worst-identified parameter and is the standard remedy for fat-tailed data,
 * where a free omega wanders. Zero conditional mean, like every volatility
 * model already in the field.
 */
export function garchNegativeLogLikelihood(returns, alpha, beta, longRunVariance) {
  const omega = longRunVariance * (1 - alpha - beta);
  let s2 = longRunVariance, nll = 0;
  for (let t = 0; t < returns.length; t++) {
    if (!(s2 > 0)) return Infinity;
    const r2 = returns[t] * returns[t];
    nll += Math.log(s2) + r2 / s2;
    s2 = omega + alpha * r2 + beta * s2;
  }
  return 0.5 * nll;
}

/** Filtered conditional variances: sigma2[t] is the variance of returns[t] given t-1. */
export function garchFilter(returns, { alpha, beta, longRunVariance }) {
  const omega = longRunVariance * (1 - alpha - beta);
  const sigma2 = new Float64Array(returns.length);
  let s2 = longRunVariance;
  for (let t = 0; t < returns.length; t++) {
    sigma2[t] = s2;
    s2 = omega + alpha * returns[t] * returns[t] + beta * s2;
  }
  return { sigma2, next: s2 };
}

export function fitGarch(returns, { start = null, maxEvaluations = 300 } = {}) {
  const n = returns.length;
  if (n < 60) return { status: 'insufficient', observations: n };
  let V = 0;
  for (const r of returns) V += r * r;
  V /= n;
  if (!(V > 0)) return { status: 'degenerate', observations: n };
  const x0 = start && start.persistence > 0 && start.alpha > 0
    ? [logit(clampNumber(start.persistence / MAX_PERSISTENCE, 1e-6, 1 - 1e-6)),
      logit(clampNumber(start.alpha / start.persistence, 1e-6, 1 - 1e-6))]
    : [logit(0.94 / MAX_PERSISTENCE), logit(0.08 / 0.94)];
  const objective = u => {
    const p = garchParameters(u);
    return garchNegativeLogLikelihood(returns, p.alpha, p.beta, V);
  };
  const opt = nelderMead(objective, x0, { step: start ? 0.3 : 1, maxEvaluations });
  const p = garchParameters(opt.x);
  const { next } = garchFilter(returns, { ...p, longRunVariance: V });
  return {
    status: 'fitted', ...p, omega: V * (1 - p.persistence), longRunVariance: V,
    sigma2Next: next, negativeLogLikelihood: opt.value, observations: n,
    evaluations: opt.evaluations,
    // Days for a volatility shock to decay halfway back to its long-run level.
    halfLifeDays: p.persistence > 0 && p.persistence < 1 ? Math.log(0.5) / Math.log(p.persistence) : null
  };
}

/** E[sigma^2_{t+k}] for k = 1..h, given sigma^2_{t+1}. */
export function garchVariancePath(sigma2Next, persistence, longRunVariance, h) {
  const out = [];
  let gap = sigma2Next - longRunVariance;
  for (let k = 0; k < h; k++) {
    out.push(Math.max(longRunVariance + gap, 0));
    gap *= persistence;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Weekday seasonality in variance
// ---------------------------------------------------------------------------

/**
 * How much bigger or smaller a move is on each weekday, estimated from
 * GARCH-STANDARDIZED squared returns so that volatility clustering does not
 * masquerade as a weekday effect. Squares are winsorized at `cap` (|z| = 5)
 * because a single corrupt or crash bar would otherwise set a weekday's factor
 * by itself.
 *
 * The raw factors are then shrunk toward 1 by DerSimonian-Laird -- the same
 * estimator the hierarchical lane uses across assets -- so a weekday only
 * keeps the part of its difference that exceeds sampling noise. `pValue` is
 * Cochran's Q test of "every weekday has the same variance"; it is the number
 * the seasonality indicator reports.
 */
export function weekdayVarianceFactors(weekdays, z2, { cap = 25, minPerDay = 10 } = {}) {
  const sum = Array(7).fill(0), sumSq = Array(7).fill(0), count = Array(7).fill(0);
  for (let t = 0; t < z2.length; t++) {
    const v = Math.min(z2[t], cap);
    if (!Number.isFinite(v)) continue;
    const w = weekdays[t];
    sum[w] += v; sumSq[w] += v * v; count[w]++;
  }
  const days = [0, 1, 2, 3, 4, 5, 6].filter(w => count[w] >= minPerDay);
  const identity = { factors: Array(7).fill(1), raw: Array(7).fill(null), days, pValue: null, q: null, tauSquared: 0 };
  if (days.length < 2) return identity;
  const total = days.reduce((s, w) => s + sum[w], 0) / days.reduce((s, w) => s + count[w], 0);
  if (!(total > 0)) return identity;
  const raw = Array(7).fill(null), se2 = Array(7).fill(null);
  for (const w of days) {
    const m = sum[w] / count[w];
    const variance = Math.max(sumSq[w] / count[w] - m * m, 1e-12);
    raw[w] = m / total;
    se2[w] = variance / count[w] / (total * total);
  }
  const weights = days.map(w => 1 / se2[w]);
  const sw = weights.reduce((s, v) => s + v, 0);
  const pooled = days.reduce((s, w, i) => s + weights[i] * raw[w], 0) / sw;
  const q = days.reduce((s, w, i) => s + weights[i] * (raw[w] - pooled) ** 2, 0);
  const df = days.length - 1;
  const c = sw - weights.reduce((s, v) => s + v * v, 0) / sw;
  const tauSquared = c > 0 ? Math.max(0, (q - df) / c) : 0;
  const factors = Array(7).fill(1);
  for (const w of days) {
    const lambda = tauSquared / (tauSquared + se2[w]);
    factors[w] = Math.max(1 + lambda * (raw[w] - 1), 0.05);
  }
  // Renormalize so the adjustment redistributes variance across the week
  // without changing its average level.
  const level = days.reduce((s, w) => s + factors[w] * count[w], 0) / days.reduce((s, w) => s + count[w], 0);
  for (const w of days) factors[w] /= level;
  return { factors, raw, days, pValue: chiSquareUpperP(q, df), q, df, tauSquared, counts: count };
}

// ---------------------------------------------------------------------------
// ARIMA(p,1,0) with drift: AR(p) on daily log returns
// ---------------------------------------------------------------------------

/**
 * Order p in 0..maxOrder chosen by BIC on a COMMON sample (every candidate
 * starts at t = maxOrder, so the criteria are comparable). p = 0 is the random
 * walk with drift. Training returns are clipped at `clipAt` robust standard
 * deviations: one corrupt bar of +3000% would otherwise set an AR coefficient
 * on its own, and the archive is known to contain some.
 */
export function fitAutoregression(returns, { maxOrder = 5, clipAt = 8 } = {}) {
  const n = returns.length;
  if (n < 60 + maxOrder) return { status: 'insufficient', observations: n };
  const med = median(returns);
  const scale = 1.4826 * median(returns.map(r => Math.abs(r - med)));
  const lo = scale > 0 ? med - clipAt * scale : -Infinity;
  const hi = scale > 0 ? med + clipAt * scale : Infinity;
  const x = returns.map(r => clampNumber(r, lo, hi));
  let best = null;
  for (let p = 0; p <= maxOrder; p++) {
    const X = [], y = [];
    for (let t = maxOrder; t < n; t++) {
      const row = [1];
      for (let k = 1; k <= p; k++) row.push(x[t - k]);
      X.push(row);
      y.push(x[t]);
    }
    const fit = fitLinearModel(X, y);
    if (!fit) continue;
    const m = y.length;
    const sse = fit.residuals.reduce((s, v) => s + v * v, 0);
    if (!(sse > 0)) continue;
    const bic = m * Math.log(sse / m) + (p + 1) * Math.log(m);
    if (!best || bic < best.bic) {
      best = { order: p, intercept: fit.beta[0], coefficients: fit.beta.slice(1), sigma2: sse / Math.max(m - p - 1, 1), bic, observations: m };
    }
  }
  if (!best) return { status: 'singular', observations: n };
  return { status: 'fitted', ...best, clip: [lo, hi], maxOrder };
}

/** Cumulative log-return forecast over h steps, iterating the AR recursion. */
export function autoregressionForecast(model, recentReturns, h) {
  if (!model || model.status !== 'fitted') return null;
  const [lo, hi] = model.clip;
  const history = recentReturns.slice(-Math.max(model.order, 1)).map(r => clampNumber(r, lo, hi));
  if (history.length < model.order) return null;
  let cumulative = 0;
  for (let k = 0; k < h; k++) {
    let f = model.intercept;
    for (let j = 0; j < model.order; j++) f += model.coefficients[j] * history[history.length - 1 - j];
    history.push(f);
    cumulative += f;
  }
  return cumulative;
}

// ---------------------------------------------------------------------------
// Structural time-series model (unobserved components)
// ---------------------------------------------------------------------------
//
//   y_t      = mu_t + gamma_t + psi_t + eps_t          eps ~ N(0, s_eps)
//   mu_t+1   = mu_t + beta_t + eta_t                   eta ~ N(0, s_eta)
//   beta_t+1 = beta_t + zeta_t                         zeta ~ N(0, s_zeta)
//   gamma    = trigonometric weekly seasonal, each harmonic a rotation
//              with disturbance variance s_omega
//   psi      = rho * rotation(lambda_c) psi + kappa    kappa ~ N(0, s_kappa)
//
// y is log price on a SESSION index (calendar days for crypto, business days
// for equities) so the weekly seasonal is aligned to real weekdays and a
// missing bar is a missing observation, not a skipped day.

/**
 * Build the state-space system. T is stored as sparse rows (at most two
 * non-zeros each), which is what makes the filter cheap: T P T' costs 4m^2
 * instead of 2m^3.
 */
export function structuralSystem({ period = 7, rho = 0.9, cyclePeriod = 60, variances }) {
  const blocks = [];
  blocks.push({ kind: 'trend', size: 2 });
  for (let j = 1; j <= Math.floor(period / 2); j++) {
    blocks.push({ kind: 'seasonal', size: 2 * j === period ? 1 : 2, lambda: 2 * Math.PI * j / period });
  }
  blocks.push({ kind: 'cycle', size: 2, lambda: 2 * Math.PI / cyclePeriod });
  const m = blocks.reduce((s, b) => s + b.size, 0);
  const rows = Array.from({ length: m }, () => []);
  const Z = new Float64Array(m), Q = new Float64Array(m);
  const offsets = {};
  let o = 0;
  for (const b of blocks) {
    b.offset = o;
    if (b.kind === 'trend') {
      rows[o].push([o, 1], [o + 1, 1]);
      rows[o + 1].push([o + 1, 1]);
      Z[o] = 1;
      Q[o] = variances.level; Q[o + 1] = variances.slope;
      offsets.trend = o;
    } else if (b.size === 1) {
      rows[o].push([o, -1]);
      Z[o] = 1;
      Q[o] = variances.seasonal;
    } else {
      const damp = b.kind === 'cycle' ? rho : 1;
      const c = damp * Math.cos(b.lambda), s = damp * Math.sin(b.lambda);
      rows[o].push([o, c], [o + 1, s]);
      rows[o + 1].push([o, -s], [o + 1, c]);
      Z[o] = 1;
      const v = b.kind === 'cycle' ? variances.cycle : variances.seasonal;
      Q[o] = v; Q[o + 1] = v;
      if (b.kind === 'cycle') offsets.cycle = o;
    }
    o += b.size;
  }
  offsets.seasonal = blocks.filter(b => b.kind === 'seasonal').map(b => [b.offset, b.size]);
  return { m, rows, Z, Q, H: variances.irregular, rho, cyclePeriod, period, blocks, offsets };
}

/**
 * Flat form of the sparse transition, for the hot loop. Every row has at most
 * two non-zeros; a one-entry row gets a zero-weight duplicate so the loop has
 * no branch.
 */
function compileTransition(sys) {
  if (sys.compiled) return sys.compiled;
  const { m, rows } = sys;
  const c0 = new Int32Array(m), c1 = new Int32Array(m), v0 = new Float64Array(m), v1 = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    c0[i] = rows[i][0][0]; v0[i] = rows[i][0][1];
    if (rows[i].length > 1) { c1[i] = rows[i][1][0]; v1[i] = rows[i][1][1]; } else { c1[i] = c0[i]; v1[i] = 0; }
  }
  sys.compiled = { c0, c1, v0, v1 };
  return sys.compiled;
}

/**
 * One pass of the Kalman filter over z. Shared by the likelihood, the
 * walk-forward forecaster and the smoother so the three can never disagree
 * about the recursion.
 *
 * `onPredicted(t, a)` is called after the prediction step for every observed
 * t, with a = a_{t+1|t}; that is the only point at which a causal forecast
 * made at t's close can be read.
 */
function filterPass(z, sys, { collect = false, onPredicted = null, diffuseScale = 1e7 } = {}) {
  const { m, Z, Q, H } = sys;
  const { c0, c1, v0, v1 } = compileTransition(sys);
  const a = new Float64Array(m), Ta = new Float64Array(m), PZ = new Float64Array(m);
  let P = new Float64Array(m * m), Pn = new Float64Array(m * m);
  const TP = new Float64Array(m * m);
  const zIdx = [];
  for (let i = 0; i < m; i++) if (Z[i] !== 0) zIdx.push(i);
  const nz = zIdx.length;
  const cycle = sys.offsets.cycle;
  const cycleVar = Q[cycle] / Math.max(1 - sys.rho * sys.rho, 1e-6);
  for (let i = 0; i < m; i++) P[i * m + i] = (i === cycle || i === cycle + 1) ? cycleVar : diffuseScale;
  const diffuse = m - 2;
  let observed = 0, sumLogF = 0, sumV2F = 0, scored = 0;
  const store = collect ? { a: [], P: [], v: new Float64Array(z.length), F: new Float64Array(z.length), K: [] } : null;
  for (let t = 0; t < z.length; t++) {
    if (collect) { store.a.push(Float64Array.from(a)); store.P.push(Float64Array.from(P)); }
    const yt = z[t];
    const isObserved = yt === yt; // not NaN
    if (isObserved) {
      let pred = 0;
      for (let q = 0; q < nz; q++) pred += a[zIdx[q]];
      const v = yt - pred;
      for (let i = 0; i < m; i++) {
        let s = 0;
        const row = i * m;
        for (let q = 0; q < nz; q++) s += P[row + zIdx[q]];
        PZ[i] = s;
      }
      let F = H;
      for (let q = 0; q < nz; q++) F += PZ[zIdx[q]];
      if (!(F > 0)) return { failed: true, sumLogF, sumV2F, scored, observed };
      const invF = 1 / F;
      for (let i = 0; i < m; i++) a[i] += PZ[i] * v * invF;
      for (let i = 0; i < m; i++) {
        const ki = PZ[i] * invF, row = i * m;
        for (let j = i; j < m; j++) {
          const val = P[row + j] - ki * PZ[j];
          P[row + j] = val; P[j * m + i] = val;
        }
      }
      if (observed >= diffuse) { sumLogF += Math.log(F); sumV2F += v * v * invF; scored++; }
      observed++;
      if (collect) { store.v[t] = v; store.F[t] = F; store.K.push(Float64Array.from(PZ, x => x * invF)); }
    } else if (collect) {
      store.v[t] = NaN; store.F[t] = NaN; store.K.push(null);
    }
    // Predict: a <- T a, P <- T P T' + Q (symmetric, upper triangle mirrored).
    for (let i = 0; i < m; i++) Ta[i] = v0[i] * a[c0[i]] + v1[i] * a[c1[i]];
    a.set(Ta);
    if (isObserved && onPredicted) onPredicted(t, a, yt);
    for (let i = 0; i < m; i++) {
      const r0 = c0[i] * m, r1 = c1[i] * m, w0 = v0[i], w1 = v1[i], row = i * m;
      for (let j = 0; j < m; j++) TP[row + j] = w0 * P[r0 + j] + w1 * P[r1 + j];
    }
    for (let i = 0; i < m; i++) {
      const row = i * m;
      for (let j = i; j < m; j++) {
        const val = TP[row + c0[j]] * v0[j] + TP[row + c1[j]] * v1[j];
        Pn[row + j] = val; Pn[j * m + i] = val;
      }
      Pn[row + i] += Q[i];
    }
    const swap = P; P = Pn; Pn = swap;
  }
  return { sumLogF, sumV2F, scored, observed, a, P, store };
}

/**
 * Kalman filter with missing observations and an approximate diffuse prior on
 * the non-stationary states (trend and seasonal). The first `diffuse` observed
 * points are excluded from the likelihood, as the exact diffuse treatment
 * would. `collect` keeps what the smoother needs.
 */
export function kalmanFilter(y, sys, { collect = false, diffuseScale = 1e7 } = {}) {
  return filterPass(y, sys, { collect, diffuseScale });
}

/**
 * Concentrated log-likelihood: the level variance is factored out, so the
 * optimizer only sees ratios to it. A price series always has a non-zero
 * level variance, which is what makes it the right variance to concentrate.
 */
function concentratedLogLik(filter) {
  if (filter.failed || !(filter.scored > 10) || !(filter.sumV2F > 0)) return -Infinity;
  const n = filter.scored;
  const scale = filter.sumV2F / n;
  return -0.5 * (n * Math.log(2 * Math.PI) + n * Math.log(scale) + filter.sumLogF + n);
}

const LOG_RATIO_BOUNDS = [-30, 4];

function structuralFromVector(u, { period, minCycle, maxCycle }) {
  const ratio = i => Math.exp(clampNumber(u[i], LOG_RATIO_BOUNDS[0], LOG_RATIO_BOUNDS[1]));
  return {
    period,
    rho: 0.995 * logistic(u[4]),
    cyclePeriod: minCycle + (maxCycle - minCycle) * logistic(u[5]),
    variances: { level: 1, slope: ratio(0), seasonal: ratio(1), cycle: ratio(2), irregular: ratio(3) }
  };
}

/**
 * Session index for a bar series: crypto on calendar days, equities on
 * business days. Missing sessions come back as NaN so the filter treats them
 * as unobserved rather than stitching across them.
 */
export function sessionSeries(bars, calendar = 'calendar') {
  const valid = (bars || []).filter(b => b.close > 0 && Number.isFinite(Math.log(b.close)));
  if (!valid.length) return { dates: [], y: new Float64Array(0), barIndex: [] };
  const dates = [], barAt = new Map(valid.map((b, i) => [b.date, i]));
  let ms = dateMs(valid[0].date);
  const end = dateMs(valid[valid.length - 1].date);
  while (ms <= end) {
    const wd = new Date(ms).getUTCDay();
    if (!(calendar === 'business' && (wd === 0 || wd === 6))) dates.push(isoDay(ms));
    ms += DAY;
  }
  const y = new Float64Array(dates.length);
  const barIndex = dates.map(d => barAt.get(d) ?? -1);
  for (let i = 0; i < dates.length; i++) {
    const bi = barIndex[i];
    y[i] = bi >= 0 ? Math.log(valid[bi].close) : NaN;
  }
  return { dates, y, barIndex, bars: valid };
}

/**
 * Fit the structural model by maximum likelihood. The series is centred on its
 * first observation and scaled by the robust scale of its daily changes, so
 * the diffuse prior and the variance ratios are on comparable footing for a
 * $0.0001 token and for BTC alike.
 */
export function fitStructural(y, {
  period = 7, minCycle = null, maxCycle = null, start = null, maxEvaluations = 500
} = {}) {
  const obs = [];
  for (const v of y) if (Number.isFinite(v)) obs.push(v);
  if (obs.length < 120) return { status: 'insufficient', observations: obs.length };
  const diffs = [];
  for (let t = 1; t < y.length; t++) if (Number.isFinite(y[t]) && Number.isFinite(y[t - 1])) diffs.push(y[t] - y[t - 1]);
  const scale = 1.4826 * median(diffs.map(Math.abs)) || Math.sqrt(mean(diffs.map(d => d * d))) || 1;
  const origin = obs[0];
  const z = Float64Array.from(y, v => (Number.isFinite(v) ? (v - origin) / scale : NaN));
  const bounds = { period, minCycle: minCycle ?? Math.max(2 * period, 10), maxCycle: maxCycle ?? (period === 5 ? 260 : 365) };
  const x0 = start?.vector?.slice() ?? [-12, -12, -6, -3, logit(0.9 / 0.995), 0];
  const objective = u => {
    const spec = structuralFromVector(u, bounds);
    const f = kalmanFilter(z, structuralSystem(spec));
    const ll = concentratedLogLik(f);
    return Number.isFinite(ll) ? -ll : Infinity;
  };
  const opt = nelderMead(objective, x0, { step: start ? 0.5 : [3, 3, 3, 3, 1.5, 1.5], maxEvaluations });
  const spec = structuralFromVector(opt.x, bounds);
  const filter = kalmanFilter(z, structuralSystem(spec));
  const levelVariance = filter.sumV2F / filter.scored;
  return {
    status: 'fitted', vector: opt.x, ...spec, origin, scale, levelVariance,
    // Disturbance variances back in log-price units.
    variancesLog: Object.fromEntries(Object.entries(spec.variances)
      .map(([k, v]) => [k, v * levelVariance * scale * scale])),
    logLik: concentratedLogLik(filter), observations: obs.length, evaluations: opt.evaluations,
    bounds
  };
}

/** The system for a fitted model, in the model's own (scaled) units. */
function fittedSystem(fit) {
  return structuralSystem({ period: fit.period, rho: fit.rho, cyclePeriod: fit.cyclePeriod,
    variances: fit.variances });
}

/**
 * Walk the filter with FIXED fitted parameters and report, for every session
 * with an observed close, the h-step forecast of the change in log price made
 * with information up to and including that close. Causal by construction:
 * the state used at t has only ever been updated with y[0..t].
 */
export function structuralForecastPath(y, fit, horizons, { fromIndex = 0 } = {}) {
  const sys = fittedSystem(fit);
  const { m, Z } = sys;
  const { c0, c1, v0, v1 } = compileTransition(sys);
  const z = Float64Array.from(y, v => (Number.isFinite(v) ? (v - fit.origin) / fit.scale : NaN));
  const zIdx = [];
  for (let i = 0; i < m; i++) if (Z[i] !== 0) zIdx.push(i);
  const out = new Map();
  const work = new Float64Array(m), next = new Float64Array(m);
  const maxH = Math.max(...horizons);
  filterPass(z, sys, {
    onPredicted: (t, a, yt) => {
      if (t < fromIndex) return;
      // a = a_{t+1|t}; E[y_{t+k} | t] = Z T^{k-1} a_{t+1|t}.
      work.set(a);
      const forecasts = {};
      for (let k = 1; k <= maxH; k++) {
        if (horizons.includes(k)) {
          let level = 0;
          for (const i of zIdx) level += work[i];
          forecasts[k] = (level - yt) * fit.scale;
        }
        for (let i = 0; i < m; i++) next[i] = v0[i] * work[c0[i]] + v1[i] * work[c1[i]];
        work.set(next);
      }
      out.set(t, forecasts);
    }
  });
  return out;
}

/**
 * Fixed-interval smoother (Durbin & Koopman 4.4) for the decomposition.
 * Returns each component's smoothed path in log-price units, plus the
 * smoothed slope and its standard error, which is what the trend indicator
 * reports. The final smoothed state equals the final filtered state, so the
 * "current" reading uses no future data.
 */
export function smoothStructural(y, fit) {
  const sys = fittedSystem(fit);
  const { m, rows, Z } = sys;
  const z = Float64Array.from(y, v => (Number.isFinite(v) ? (v - fit.origin) / fit.scale : NaN));
  const f = kalmanFilter(z, sys, { collect: true });
  const n = z.length;
  const zIdx = [];
  for (let i = 0; i < m; i++) if (Z[i] !== 0) zIdx.push(i);
  let r = new Float64Array(m), N = new Float64Array(m * m);
  const states = new Array(n), variances = new Array(n);
  // Transpose multiply helpers for the backward pass.
  const tTranspose = vec => {
    const out = new Float64Array(m);
    for (let i = 0; i < m; i++) for (const [k, v] of rows[i]) out[k] += v * vec[i];
    return out;
  };
  for (let t = n - 1; t >= 0; t--) {
    const a = f.store.a[t], P = f.store.P[t];
    if (Number.isFinite(z[t])) {
      const v = f.store.v[t], F = f.store.F[t], k = f.store.K[t]; // k = P Z' / F (filtering gain)
      // L' r where L = T (I - k Z): r_{t-1} = Z' v / F + (I - Z' k') T' r
      const Ttr = tTranspose(r);
      let kTr = 0;
      for (let i = 0; i < m; i++) kTr += k[i] * Ttr[i];
      const rPrev = new Float64Array(m);
      for (let i = 0; i < m; i++) rPrev[i] = Ttr[i];
      for (const i of zIdx) rPrev[i] += v / F - kTr;
      // N_{t-1} = Z'Z / F + L' N L, with L = T (I - k Z)
      const TtNT = new Float64Array(m * m);
      // T' N T
      const NT = new Float64Array(m * m);
      for (let i = 0; i < m; i++) for (let j = 0; j < m; j++) {
        let s = 0;
        for (const [l, w] of rows[j]) s += N[i * m + l] * w;
        NT[i * m + j] = s;
      }
      for (let i = 0; i < m; i++) for (const [k2, v2] of rows[i]) for (let j = 0; j < m; j++) TtNT[k2 * m + j] += v2 * NT[i * m + j];
      // (I - Z'k') M (I - k Z) where M = T'NT
      const Mk = new Float64Array(m), kM = new Float64Array(m);
      for (let i = 0; i < m; i++) { let s = 0; for (let j = 0; j < m; j++) s += TtNT[i * m + j] * k[j]; Mk[i] = s; }
      for (let j = 0; j < m; j++) { let s = 0; for (let i = 0; i < m; i++) s += k[i] * TtNT[i * m + j]; kM[j] = s; }
      let kMk = 0;
      for (let i = 0; i < m; i++) kMk += k[i] * Mk[i];
      const Nprev = Float64Array.from(TtNT);
      for (const i of zIdx) for (let j = 0; j < m; j++) Nprev[i * m + j] -= kM[j];
      for (let i = 0; i < m; i++) for (const j of zIdx) Nprev[i * m + j] -= Mk[i];
      for (const i of zIdx) for (const j of zIdx) Nprev[i * m + j] += kMk + 1 / F;
      r = rPrev; N = Nprev;
    } else {
      r = tTranspose(r);
      const NT = new Float64Array(m * m), TtNT = new Float64Array(m * m);
      for (let i = 0; i < m; i++) for (let j = 0; j < m; j++) {
        let s = 0;
        for (const [l, w] of rows[j]) s += N[i * m + l] * w;
        NT[i * m + j] = s;
      }
      for (let i = 0; i < m; i++) for (const [k2, v2] of rows[i]) for (let j = 0; j < m; j++) TtNT[k2 * m + j] += v2 * NT[i * m + j];
      N = TtNT;
    }
    // alpha_hat = a + P r_{t-1};  V = P - P N_{t-1} P
    const alpha = new Float64Array(m);
    for (let i = 0; i < m; i++) { let s = a[i]; for (let j = 0; j < m; j++) s += P[i * m + j] * r[j]; alpha[i] = s; }
    const PN = new Float64Array(m * m);
    for (let i = 0; i < m; i++) for (let j = 0; j < m; j++) { let s = 0; for (let k = 0; k < m; k++) s += P[i * m + k] * N[k * m + j]; PN[i * m + j] = s; }
    const V = new Float64Array(m);
    for (let i = 0; i < m; i++) { let s = P[i * m + i]; for (let k = 0; k < m; k++) s -= PN[i * m + k] * P[k * m + i]; V[i] = s; }
    states[t] = alpha; variances[t] = V;
  }
  const { trend: tr, cycle: cy, seasonal } = sys.offsets;
  const sc = fit.scale;
  const component = (t, pick) => pick(states[t]) * sc;
  const trend = [], slope = [], slopeSe = [], season = [], cyc = [], irregular = [];
  for (let t = 0; t < n; t++) {
    const s = states[t];
    trend.push(s[tr] * sc + fit.origin);
    slope.push(s[tr + 1] * sc);
    slopeSe.push(Math.sqrt(Math.max(variances[t][tr + 1], 0)) * sc * Math.sqrt(fit.levelVariance));
    let g = 0;
    for (const [off] of seasonal) g += s[off];
    season.push(g * sc);
    cyc.push(component(t, st => st[cy]));
    irregular.push(Number.isFinite(y[t]) ? y[t] - (trend[t] + season[t] + cyc[t]) : NaN);
  }
  return { trend, slope, slopeSe, seasonal: season, cycle: cyc, irregular };
}

// ---------------------------------------------------------------------------
// Walk-forward paths for the candidate field
// ---------------------------------------------------------------------------

const pathCache = new WeakMap();

/**
 * Every time-series forecast for one asset, for every bar date, made with
 * information up to and including that bar's close. Parameters are re-estimated
 * every `refitEvery` bars on at most the last `window` returns, and held fixed
 * in between -- the standard recursive scheme. Nothing here reads a bar after
 * the date it is keyed on.
 *
 * Cached per asset object, so the crypto 1d and 7d lanes (which receive the
 * same asset objects) fit each model once.
 */
export function timeSeriesPaths(asset, {
  assetClass = asset.assetClass, horizons = [1, 5, 7], refitEvery = 21, window = 1000,
  minObservations = 250, structural = true, structuralRefitEvery = 126, structuralWindow = 730,
  structuralEvaluations = 250
} = {}) {
  const cacheKey = JSON.stringify({ assetClass, horizons, refitEvery, window, minObservations, structural, structuralRefitEvery, structuralWindow, structuralEvaluations });
  const cached = pathCache.get(asset);
  if (cached?.key === cacheKey) return cached.paths;
  const calendar = calendarFor(assetClass);
  // The same cleaned, date-aligned bars the production features read: a
  // CoinGecko row is a midnight sample of the PREVIOUS day's close, so raw
  // dates would put every weekday factor one day off for those assets.
  const bars = sanitizeBars(asset.bars);
  const returns = barReturns(bars);
  const paths = new Map();
  const put = (date, model, h, v) => {
    if (!Number.isFinite(v)) return;
    if (!paths.has(date)) paths.set(date, {});
    const row = paths.get(date);
    (row[model] ||= {})[h] = v;
  };
  const r = returns.map(x => x.r);
  const weekdays = returns.map(x => weekdayOf(x.date));

  // GARCH, seasonal GARCH, seasonal HAR and AR share one refit schedule.
  let garch = null, seasonalGarch = null, factors = null, ar = null;
  let s2 = null, s2s = null;
  let sinceFit = Infinity;
  const harDeseason = []; // deseasonalized squared returns for the HAR blend
  for (let j = 0; j < r.length; j++) {
    const date = returns[j].date;
    // Update filters with r_j using the parameters in force BEFORE this refit.
    if (garch) s2 = garch.omega + garch.alpha * r[j] * r[j] + garch.beta * s2;
    if (seasonalGarch) {
      const rt = r[j] / Math.sqrt(factors[weekdays[j]]);
      s2s = seasonalGarch.omega + seasonalGarch.alpha * rt * rt + seasonalGarch.beta * s2s;
    }
    if (sinceFit >= refitEvery && j + 1 >= minObservations) {
      const lo = Math.max(0, j + 1 - window);
      const win = r.slice(lo, j + 1);
      const fit = fitGarch(win, { start: garch });
      if (fit.status === 'fitted') {
        garch = fit; s2 = fit.sigma2Next;
        // Weekday factors from THIS window's standardized residuals only.
        const { sigma2 } = garchFilter(win, fit);
        const z2 = win.map((v, i) => v * v / sigma2[i]);
        factors = weekdayVarianceFactors(weekdays.slice(lo, j + 1), z2).factors;
        const deseason = win.map((v, i) => v / Math.sqrt(factors[weekdays[lo + i]]));
        const sfit = fitGarch(deseason, { start: seasonalGarch });
        if (sfit.status === 'fitted') { seasonalGarch = sfit; s2s = sfit.sigma2Next; }
      }
      const arFit = fitAutoregression(win);
      if (arFit.status === 'fitted') ar = arFit;
      sinceFit = 0;
    }
    sinceFit++;
    if (factors) harDeseason.push(r[j] * r[j] / factors[weekdays[j]]);
    else harDeseason.push(null);
    if (!garch) continue;
    const targets = nextSessionDates(date, Math.max(...horizons), calendar).map(weekdayOf);
    for (const h of horizons) {
      const path = garchVariancePath(s2, garch.persistence, garch.longRunVariance, h);
      put(date, 'garchVol', h, Math.sqrt(path.reduce((s, v) => s + v, 0)));
      if (seasonalGarch && factors) {
        const sp = garchVariancePath(s2s, seasonalGarch.persistence, seasonalGarch.longRunVariance, h);
        let total = 0;
        for (let k = 0; k < h; k++) total += sp[k] * factors[targets[k]];
        put(date, 'garchWeekdayVol', h, Math.sqrt(total));
      }
      if (factors && harDeseason.length >= 22 && harDeseason.slice(-22).every(v => v != null)) {
        const rms = n => Math.sqrt(mean(harDeseason.slice(-n)));
        const blended = (rms(1) + rms(5) + rms(22)) / 3;
        let f = 0;
        for (let k = 0; k < h; k++) f += factors[targets[k]];
        put(date, 'harWeekdayVol', h, blended * Math.sqrt(f));
      }
      if (ar) put(date, 'arima', h, autoregressionForecast(ar, r.slice(Math.max(0, j + 1 - ar.maxOrder), j + 1), h));
    }
  }

  if (structural) {
    const period = calendar === 'business' ? 5 : 7;
    const series = sessionSeries(bars, calendar);
    const observedIdx = [];
    for (let t = 0; t < series.y.length; t++) if (Number.isFinite(series.y[t])) observedIdx.push(t);
    let fit = null;
    // Refit on a session cadence; each segment is filtered with parameters
    // estimated strictly before it starts.
    for (let s = 0; s < observedIdx.length; s += structuralRefitEvery) {
      const t0 = observedIdx[s];
      if (s + 1 < minObservations) continue;
      const lo = Math.max(0, t0 + 1 - structuralWindow);
      const trainY = series.y.slice(lo, t0 + 1);
      const next = fitStructural(trainY, { period, start: fit, maxEvaluations: structuralEvaluations });
      if (next.status !== 'fitted') continue;
      fit = next;
      const endObs = observedIdx[Math.min(s + structuralRefitEvery, observedIdx.length) - 1];
      const segY = series.y.slice(lo, endObs + 1);
      const forecasts = structuralForecastPath(segY, fit, horizons, { fromIndex: t0 - lo });
      for (const [t, fc] of forecasts) {
        const date = series.dates[lo + t];
        for (const h of horizons) put(date, 'structural', h, fc[h]);
      }
    }
  }
  pathCache.set(asset, { key: cacheKey, paths });
  return paths;
}

// ---------------------------------------------------------------------------
// Indicator statistics for the decomposition panel
// ---------------------------------------------------------------------------

/**
 * Does the mean return differ by weekday? OLS of returns on weekday dummies
 * with Newey-West errors, joint Wald test. Returns the per-weekday mean in
 * percent and the p-value. Directional seasonality has never survived in this
 * project; this is where that is checked for each series.
 */
export function weekdayMeanTest(returns, dates, { lags = 5 } = {}) {
  const wds = dates.map(weekdayOf);
  const days = [...new Set(wds)].sort();
  if (days.length < 2 || returns.length < 60) return null;
  const X = wds.map(w => days.map(d => (d === w ? 1 : 0)));
  const fit = fitLinearModel(X, returns);
  if (!fit) return null;
  withDesign(fit, X);
  const cov = hacCovariance(fit, { lags }).covariance;
  // Wald test of equal means: contrasts d_i - d_0.
  const k = days.length - 1;
  const R = Array.from({ length: k }, (_, i) => days.map((_, j) => (j === 0 ? -1 : j === i + 1 ? 1 : 0)));
  const Rb = R.map(row => row.reduce((s, v, j) => s + v * fit.beta[j], 0));
  const RVR = R.map(ri => R.map(rj => ri.reduce((s, v, a) => s + v * rj.reduce((t, w, b) => t + w * cov[a][b], 0), 0)));
  const inv = invertSmall(RVR);
  if (!inv) return null;
  let wald = 0;
  for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) wald += Rb[i] * inv[i][j] * Rb[j];
  return {
    meanPct: Object.fromEntries(days.map((d, j) => [d, (Math.expm1(fit.beta[j]) * 100)])),
    wald, df: k, pValue: chiSquareUpperP(wald, k), observations: returns.length
  };
}

function invertSmall(A) {
  const n = A.length;
  const M = A.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-18) return null;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c];
    for (let j = 0; j < 2 * n; j++) M[c][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c];
      if (f) for (let j = 0; j < 2 * n; j++) M[r][j] -= f * M[c][j];
    }
  }
  return M.map(row => row.slice(n));
}

/**
 * Fisher's g test for a hidden periodicity in returns: the largest periodogram
 * ordinate in a band, as a share of the band's total. Under white noise the
 * exact p-value is  sum_{j=1}^{floor(1/g)} (-1)^{j-1} C(K,j) (1 - j g)^{K-1}.
 *
 * Applied to GARCH-standardized returns, because volatility clustering puts
 * power at low frequencies that is about the SIZE of moves, not their timing.
 * A cycle in log price is a cycle in returns at the same period, so this is
 * the test the cycle indicator must pass before a cycle is described as one.
 */
export function fisherGTest(series, { minPeriod = 10, maxPeriod = 365 } = {}) {
  const x = series.filter(Number.isFinite);
  const n = x.length;
  if (n < 2 * maxPeriod && n < 200) return null;
  const m = mean(x);
  const centred = x.map(v => v - m);
  const ordinates = [];
  for (let k = 1; k <= Math.floor((n - 1) / 2); k++) {
    const period = n / k;
    if (period < minPeriod || period > maxPeriod) continue;
    const w = 2 * Math.PI * k / n;
    let c = 0, s = 0;
    for (let t = 0; t < n; t++) { c += centred[t] * Math.cos(w * t); s += centred[t] * Math.sin(w * t); }
    ordinates.push({ period, power: (c * c + s * s) / n });
  }
  const K = ordinates.length;
  if (K < 3) return null;
  const total = ordinates.reduce((s, o) => s + o.power, 0);
  const peak = ordinates.reduce((b, o) => (o.power > b.power ? o : b), ordinates[0]);
  const g = peak.power / total;
  let p = 0;
  const upper = Math.floor(1 / g);
  let logC = 0; // log C(K, j)
  for (let j = 1; j <= Math.min(upper, K); j++) {
    logC += Math.log((K - j + 1) / j);
    const term = Math.exp(logC + (K - 1) * Math.log(Math.max(1 - j * g, 1e-300)));
    p += (j % 2 ? 1 : -1) * term;
  }
  return { period: peak.period, g, pValue: clampNumber(p, 0, 1), frequencies: K, observations: n };
}

/**
 * Trend over the last `days` sessions: the mean daily log return with a
 * Newey-West standard error. This is the plain-language trend reading -- its
 * t-statistic says whether the drift is distinguishable from noise.
 */
export function trendDrift(returns, { lags = 10 } = {}) {
  if (returns.length < 20) return null;
  const X = returns.map(() => [1]);
  const fit = fitLinearModel(X, returns);
  if (!fit) return null;
  withDesign(fit, X);
  const se = Math.sqrt(hacCovariance(fit, { lags }).covariance[0][0]);
  const t = se > 0 ? fit.beta[0] / se : null;
  return {
    meanDailyPct: Math.expm1(fit.beta[0]) * 100,
    totalPct: Math.expm1(fit.beta[0] * returns.length) * 100,
    tStatistic: t, pValue: t == null ? null : tTwoSidedP(t, returns.length - 1), days: returns.length
  };
}

/**
 * Lo-MacKinlay variance ratio with the heteroskedasticity-robust z*. VR(q) is
 * the variance of q-day returns over q times the one-day variance: 1 for a
 * random walk, below 1 when swings tend to reverse (the cyclical case), above 1
 * when they tend to persist. The robust form matters here: volatility
 * clustering alone would make the classical statistic reject far too often.
 */
export function varianceRatioTest(returns, q) {
  const n = returns.length;
  if (!(q >= 2) || n < 4 * q) return null;
  const mu = mean(returns);
  const dev = returns.map(r => r - mu);
  const ss = dev.reduce((s, v) => s + v * v, 0);
  const varA = ss / (n - 1);
  const m = q * (n - q + 1) * (1 - q / n);
  let window = 0;
  for (let j = 0; j < q; j++) window += returns[j];
  let sumC = (window - q * mu) ** 2;
  for (let t = q; t < n; t++) {
    window += returns[t] - returns[t - q];
    sumC += (window - q * mu) ** 2;
  }
  const vr = (sumC / m) / varA;
  let theta = 0;
  for (let j = 1; j < q; j++) {
    let num = 0;
    for (let t = j; t < n; t++) num += dev[t] * dev[t] * dev[t - j] * dev[t - j];
    // delta(j) is O(1/n): under homoskedasticity theta reduces exactly to
    // the classical 2(2q-1)(q-1)/(3qn), which the tests pin.
    const delta = num / (ss * ss);
    theta += (2 * (q - j) / q) ** 2 * delta;
  }
  const z = theta > 0 ? (vr - 1) / Math.sqrt(theta) : null;
  return { q, ratio: vr, z, pValue: z == null ? null : 2 * (1 - normalCdf(Math.abs(z))), observations: n };
}

/**
 * Holm step-down adjustment. The decomposition panel runs the same test on
 * every displayed series, and an uncorrected p < 0.05 somewhere among ten is
 * what chance delivers about 40% of the time.
 */
export function holmAdjust(pValues) {
  const idx = pValues.map((p, i) => [p, i]).filter(([p]) => Number.isFinite(p)).sort((a, b) => a[0] - b[0]);
  const out = pValues.map(() => null);
  const m = idx.length;
  let running = 0;
  idx.forEach(([p, i], k) => {
    running = Math.max(running, Math.min(1, (m - k) * p));
    out[i] = running;
  });
  return out;
}

const round = (x, d = 4) => (Number.isFinite(x) ? Number(x.toFixed(d)) : null);
const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Plain drift over a calendar window: the exact close-to-close change, and a
 * Newey-West t on the mean daily log return so the reading says whether the
 * drift is distinguishable from what noise alone produces.
 */
function trendWindow(returns, bars, lastDate, days) {
  const cutoff = isoDay(dateMs(lastDate) - days * DAY);
  const rs = returns.filter(x => x.date > cutoff).map(x => x.r);
  const first = bars.find(b => b.date >= cutoff && b.close > 0);
  const lastBar = bars[bars.length - 1];
  const drift = trendDrift(rs);
  if (!drift || !first) return { days, status: 'insufficient' };
  return {
    days, sessions: rs.length,
    changePct: round((lastBar.close / first.close - 1) * 100, 2),
    tStatistic: round(drift.tStatistic, 2), pValue: round(drift.pValue, 4),
    direction: drift.tStatistic == null ? 'unknown' : drift.tStatistic > 0 ? 'up' : 'down',
    // |t| >= 2 is the plain-language bar for "not just noise". Most windows
    // will not clear it; that is the finding, not a defect.
    distinguishable: drift.tStatistic != null && Math.abs(drift.tStatistic) >= 2
  };
}

/**
 * Trend, seasonality, cycles, variations and irregularities for one series.
 *
 * Every component is DESCRIPTIVE except the next-session volatility band,
 * which comes from the one model in this module with measured out-of-sample
 * skill (GARCH with weekday seasonality; see docs/TIME_SERIES_EVIDENCE.md).
 * Nothing here is, or may be rendered as, a direction call.
 */
export function describeTimeSeries(bars, {
  assetClass = 'crypto', window = 1000, bandCoverage = 0.8, calibrationWindow = 180,
  staleAfterDays = 3, asOf = null
} = {}) {
  const calendar = calendarFor(assetClass);
  const clean = sanitizeBars(bars).filter(b => b.close > 0 && Number.isFinite(b.close));
  const lastBar = clean[clean.length - 1];
  const all = barReturns(clean);
  if (!lastBar || all.length < 250) {
    return { status: 'insufficient-history', observations: all.length, lastBar: lastBar?.date ?? null };
  }
  const ageDays = asOf ? (dateMs(asOf) - dateMs(lastBar.date)) / DAY : null;
  const ret = all.slice(-window);
  const r = ret.map(x => x.r), dates = ret.map(x => x.date), wds = dates.map(weekdayOf);

  // -- variations: GARCH, deseasonalized by weekday, reseasonalized per session
  const raw = fitGarch(r);
  if (raw.status !== 'fitted') return { status: 'model-failed', observations: r.length, lastBar: lastBar.date };
  const { sigma2: rawSigma2 } = garchFilter(r, raw);
  const seasonal = weekdayVarianceFactors(wds, r.map((v, i) => v * v / rawSigma2[i]));
  const f = seasonal.factors;
  const deseasoned = r.map((v, i) => v / Math.sqrt(f[wds[i]]));
  const g = fitGarch(deseasoned, { start: raw });
  if (g.status !== 'fitted') return { status: 'model-failed', observations: r.length, lastBar: lastBar.date };
  const { sigma2, next } = garchFilter(deseasoned, g);
  const condSd = r.map((_, i) => Math.sqrt(sigma2[i] * f[wds[i]]));
  const z = r.map((v, i) => v / condSd[i]);
  // The band is for the first session on or after the report date. The
  // archive can trail it by a day or two, so this is a k-step forecast whose
  // variance decays toward the long-run level, not a band for a day that has
  // already closed.
  const upcoming = nextSessionDates(lastBar.date, 10, calendar);
  const target = asOf ? (upcoming.find(d => d >= asOf) ?? upcoming[0]) : upcoming[0];
  const stepsAhead = upcoming.indexOf(target) + 1;
  const pathVariance = garchVariancePath(next, g.persistence, g.longRunVariance, stepsAhead);
  const nextSession = target;
  const nextSd = Math.sqrt(pathVariance[stepsAhead - 1] * f[weekdayOf(target)]);
  const recentAbsZ = z.slice(-calibrationWindow).map(Math.abs).sort((a, b) => a - b);
  const radius = recentAbsZ[Math.max(0, Math.ceil(bandCoverage * recentAbsZ.length) - 1)];
  // Regime on the DESEASONALIZED scale, so a quiet Saturday is not read as a
  // calm market. Labelled by where it sits in the past year.
  const regimeSd = Math.sqrt(next), history = Array.from(sigma2.slice(-365), v => Math.sqrt(v));
  const percentile = history.filter(v => v <= regimeSd).length / history.length;
  const ratio = regimeSd / Math.sqrt(g.longRunVariance);
  const regime = percentile >= 0.95 ? 'extreme' : percentile >= 0.75 ? 'elevated' : percentile <= 0.25 ? 'calm' : 'normal';

  // -- seasonality: in the SIZE of moves, and separately in their direction
  const days = seasonal.days;
  const moveSize = Object.fromEntries(days.map(d => [dayNames[d], round(Math.sqrt(f[d]), 3)]));
  const calmest = days.reduce((a, d) => (f[d] < f[a] ? d : a), days[0]);
  const busiest = days.reduce((a, d) => (f[d] > f[a] ? d : a), days[0]);
  const meanTest = weekdayMeanTest(r, dates);

  // -- cycles: a hidden periodicity in standardized returns, and whether
  //    multi-day swings revert (VR < 1) or persist (VR > 1)
  const cycle = fisherGTest(z, { minPeriod: 10, maxPeriod: calendar === 'business' ? 260 : 365 });
  const vr5 = varianceRatioTest(r, 5), vr20 = varianceRatioTest(r, 20);

  // -- irregularities: what is left after trend, season and volatility
  const z2 = z.map(v => v * v);
  const m2 = mean(z2), m4 = mean(z2.map(v => v * v));
  const recent = ret.slice(-90).map((x, i) => ({ date: x.date, r: x.r, z: z[z.length - Math.min(90, ret.length) + i] }));
  const shocks = recent.filter(x => Math.abs(x.z) > 3);
  const largest = recent.reduce((a, x) => (!a || Math.abs(x.z) > Math.abs(a.z) ? x : a), null);
  const tailRate = z.filter(v => Math.abs(v) > 3).length / z.length;
  const lbLevel = ljungBox(z, { lags: 10 }), lbSquare = ljungBox(z2, { lags: 10 });

  // A band for a series whose archive is days behind would be a k-step
  // forecast that has decayed to the long-run level, dated to a session that
  // may already have closed. It is withheld rather than shown as current.
  const stale = ageDays != null && ageDays > staleAfterDays;
  return {
    status: stale ? 'stale' : 'measured',
    lastBar: lastBar.date, observations: r.length, calendar,
    trend: {
      windows: [30, 90, 365].map(d => trendWindow(all, clean, lastBar.date, d)),
      // The zoo measured trend-following direction models (ARIMA, structural)
      // with no out-of-sample skill; the window readings describe, they do not forecast.
      forecastSkill: 'none-measured'
    },
    seasonality: {
      volatility: {
        relativeMoveSize: moveSize, pValue: round(seasonal.pValue, 6),
        calmest: dayNames[calmest], busiest: dayNames[busiest],
        calmestRelative: round(Math.sqrt(f[calmest]), 3), busiestRelative: round(Math.sqrt(f[busiest]), 3)
      },
      direction: meanTest ? {
        meanReturnPct: Object.fromEntries(Object.entries(meanTest.meanPct).map(([d, v]) => [dayNames[d], round(v, 3)])),
        pValue: round(meanTest.pValue, 4)
      } : null
    },
    cycles: {
      dominantPeriodDays: cycle ? round(cycle.period, 1) : null,
      pValue: cycle ? round(cycle.pValue, 4) : null,
      varianceRatio5: vr5 ? { ratio: round(vr5.ratio, 3), z: round(vr5.z, 2), pValue: round(vr5.pValue, 4) } : null,
      varianceRatio20: vr20 ? { ratio: round(vr20.ratio, 3), z: round(vr20.z, 2), pValue: round(vr20.pValue, 4) } : null
    },
    variations: {
      model: 'garch(1,1)+weekday',
      nextSession: stale ? null : nextSession, stepsAhead: stale ? null : stepsAhead,
      nextSessionSdPct: stale ? null : round(Math.expm1(nextSd) * 100, 3),
      band: stale ? null : {
        coverage: bandCoverage, lowerPct: round(Math.expm1(-radius * nextSd) * 100, 2),
        upperPct: round(Math.expm1(radius * nextSd) * 100, 2), calibrationSessions: recentAbsZ.length,
        method: 'conformal radius on the last standardized one-step errors'
      },
      bandWithheld: stale ? 'archive-behind' : null,
      longRunSdPct: round(Math.expm1(Math.sqrt(g.longRunVariance)) * 100, 3),
      ratioToLongRun: round(ratio, 3), regime, percentileOfYear: round(percentile, 3),
      persistence: round(g.persistence, 4), halfLifeDays: round(g.halfLifeDays, 1)
    },
    irregular: {
      excessKurtosis: round(m4 / (m2 * m2) - 3, 2),
      tailRate: round(tailRate, 4), normalTailRate: 0.0027,
      shocksLast90: shocks.length,
      largestLast90: largest ? { date: largest.date, returnPct: round(Math.expm1(largest.r) * 100, 2), z: round(largest.z, 2) } : null,
      // Serial dependence left in the standardized residuals, and volatility
      // clustering the model failed to absorb. Both near-uniform p-values are
      // what an adequate model leaves behind.
      ljungBoxP: round(lbLevel?.pValue, 4), ljungBoxSquaredP: round(lbSquare?.pValue, 4)
    }
  };
}

export { ljungBox };
