// A field of candidate models, scored on two skills that are NOT the same
// skill, and reported by survivorship cohort.
//
// Why this file exists. On 2026-09-18 a combination rule -- two models agreeing
// AND both predicting a move over 0.5% -- scored 53.7% directional accuracy on
// 34,592 crypto forecasts, t=6.20, monotone in conviction and present in both
// halves of history. Every persistence check it was given, it passed. It was
// still false. Restricted to assets that existed before the sample began, its
// 2026 edge fell from 62.6% (t=13.6) to 51.0% (t=0.58), and on assets trading
// over $10M/day its net return after costs was -0.015%/day, t=-0.12. The edge
// was survivorship: an asset is in the panel because it survived to today, and
// that is most distorting for the recently listed.
//
// So this module enforces two rules that the earlier lanes could not:
//
//   1. DIRECTION AND MAGNITUDE ARE SCORED SEPARATELY. Measured over the same
//      311,088 forecasts: a plain volatility estimate ranks |move| at Spearman
//      0.321 while the 29-feature regression manages 0.225, and neither has
//      direction skill (t=0.51 and t=-1.41). Combining them makes magnitude
//      WORSE (0.332 -> 0.265, R2 negative out of sample). A model that is good
//      at one of these is not thereby good at the other, and a single blended
//      score hides exactly that.
//
//   2. EVERY RESULT IS SPLIT BY COHORT. `established` assets are those listed
//      before the evaluation window opens; they cannot carry listing-recency
//      survivorship. A result that lives only in the `recent` cohort is a
//      survivorship artifact until proven otherwise, and this module refuses to
//      report a headline number that is not cohort-split.
//
// Nothing here promotes anything. `actionable: false`, always. A candidate that
// looks good becomes a REGISTERED HYPOTHESIS for the existing evidence gate to
// judge on unseen forward outcomes -- it does not become a forecast.

import { timeSeriesPaths, TIME_SERIES_VERSION } from './time-series.mjs';
import { sanitizeBars } from './panel-features.mjs';

const DAY = 86400000;
const dateMs = d => Date.parse(`${d}T00:00:00Z`);
export const mean = xs => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null);
const sd = xs => {
  const m = mean(xs);
  return m == null ? null : Math.sqrt(mean(xs.map(v => (v - m) ** 2)));
};

export const ZOO_VERSION = 'model-zoo-v2';

// ---------------------------------------------------------------------------
// Rank statistics. Spearman is the magnitude metric because |move| is heavily
// right-tailed: a single sub-penny token's 19,668% print would dominate any
// Pearson correlation, and 15 such rows exist in the crypto panel.
// ---------------------------------------------------------------------------

export function rank(xs) {
  const idx = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = Array(xs.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
}

export function pearson(a, b) {
  if (a.length !== b.length || a.length < 3) return null;
  const ma = mean(a), mb = mean(b);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : null;
}

export const spearman = (a, b) => (a.length === b.length && a.length >= 3
  ? pearson(rank(a), rank(b)) : null);

/**
 * A t-statistic that treats one DAY as one observation, not one forecast.
 * Hundreds of assets moving together on a single market-wide day is one trial.
 * Every inflated t this project has retracted came from skipping this.
 */
export function clusteredT(rows, score, { minClusters = 10 } = {}) {
  const byDate = new Map();
  for (const r of rows) {
    const k = r.date;
    if (!byDate.has(k)) byDate.set(k, []);
    byDate.get(k).push(score(r));
  }
  const daily = [...byDate.values()].map(mean).filter(Number.isFinite);
  if (daily.length < minClusters) return { mean: null, t: null, clusters: daily.length };
  const m = mean(daily), s = sd(daily);
  const se = daily.length > 1 && s > 0 ? s / Math.sqrt(daily.length) : null;
  return { mean: m, t: se ? m / se : null, clusters: daily.length };
}

// ---------------------------------------------------------------------------
// The candidates
//
// Each model declares which skills it claims. A magnitude-only model makes no
// directional bet and must never be scored as if it did; a direction-only rule
// has no opinion on size. Declaring this is what keeps the two scores honest.
// ---------------------------------------------------------------------------

/** Exponentially weighted volatility -- the RiskMetrics workhorse. */
export function ewmaVol(returns, lambda = 0.94) {
  if (!returns.length) return null;
  let v = returns[0] ** 2;
  for (let i = 1; i < returns.length; i++) v = lambda * v + (1 - lambda) * returns[i] ** 2;
  return Math.sqrt(Math.max(v, 0));
}

/**
 * HAR: today's volatility regressed on daily, weekly and monthly realized
 * volatility. Corsi's model is the standard baseline in the volatility
 * literature precisely because it is hard to beat, so it belongs in any field
 * that claims to be exhaustive about magnitude.
 */
export function harComponents(returns) {
  if (returns.length < 22) return null;
  const rms = n => {
    const w = returns.slice(-n);
    return Math.sqrt(mean(w.map(v => v * v)));
  };
  return { d: rms(1), w: rms(5), m: rms(22) };
}

/**
 * The field. `skills` is the contract: a model is scored ONLY on what it
 * claims. `magnitude` returns an expected |move| in percent; `direction`
 * returns -1, 0 or +1.
 */
export const MODELS = {
  zero: {
    skills: ['magnitude'],
    describe: 'Forecast no move. The null every magnitude model must beat.',
    magnitude: () => 0
  },
  trailingVol: {
    skills: ['magnitude'],
    describe: 'Trailing realized volatility over the feature window.',
    magnitude: ctx => ctx.volPct
  },
  ewmaVol: {
    skills: ['magnitude'],
    describe: 'EWMA volatility, lambda=0.94.',
    // `ewmaDailyVol` lets a caller precompute the recursion over an asset's
    // FULL history instead of handing every row a copy of its return window.
    magnitude: ctx => {
      const v = Number.isFinite(ctx.ewmaDailyVol) ? ctx.ewmaDailyVol
        : (ctx.returns?.length ? ewmaVol(ctx.returns) : null);
      return Number.isFinite(v) ? Math.expm1(v * Math.sqrt(ctx.horizon ?? 1)) * 100 : null;
    }
  },
  harVol: {
    skills: ['magnitude'],
    describe: 'HAR daily/weekly/monthly realized volatility, equally weighted.',
    magnitude: ctx => {
      const blended = Number.isFinite(ctx.harDailyVol) ? ctx.harDailyVol : (() => {
        const h = harComponents(ctx.returns || []);
        return h ? (h.d + h.w + h.m) / 3 : null;
      })();
      return Number.isFinite(blended) ? Math.expm1(blended * Math.sqrt(ctx.horizon ?? 1)) * 100 : null;
    }
  },
  momentum: {
    skills: ['direction'],
    describe: 'Sign of the trailing 5-day return.',
    direction: ctx => Math.sign(ctx.return5 ?? 0)
  },
  reversal: {
    skills: ['direction'],
    describe: 'Opposite the trailing 1-day return.',
    direction: ctx => -Math.sign(ctx.return1 ?? 0)
  },
  hierarchical: {
    skills: ['direction', 'magnitude'],
    describe: 'Per-asset multiple regression with empirical-Bayes pooling.',
    direction: ctx => Math.sign(ctx.hier ?? 0),
    magnitude: ctx => Math.abs(ctx.hier ?? 0)
  },
  adaptive: {
    skills: ['direction', 'magnitude'],
    describe: 'Adaptive ridge shrunk toward zero, 9 features.',
    direction: ctx => Math.sign(ctx.adap ?? 0),
    magnitude: ctx => Math.abs(ctx.adap ?? 0)
  },
  // -- Classical time-series candidates (time-series.mjs). Each forecast is
  // made from bars up to and including the decision close, with parameters
  // re-estimated on a fixed cadence and held in between.
  garchVol: {
    skills: ['magnitude'],
    describe: 'GARCH(1,1), variance-targeted quasi-MLE, refit every 21 bars on up to 1000 returns.',
    magnitude: ctx => logVolPct(ctx.garchLogVol)
  },
  garchWeekdayVol: {
    skills: ['magnitude'],
    describe: 'GARCH(1,1) on weekday-deseasonalized returns, reseasonalized for the target sessions.',
    magnitude: ctx => logVolPct(ctx.garchWeekdayLogVol)
  },
  harWeekdayVol: {
    skills: ['magnitude'],
    describe: 'The harVol blend on weekday-deseasonalized returns, reseasonalized for the target sessions.',
    magnitude: ctx => logVolPct(ctx.harWeekdayLogVol)
  },
  arima: {
    skills: ['direction'],
    describe: 'ARIMA(p,1,0) with drift: AR(p) on daily log returns, p <= 5 by BIC, refit every 21 bars.',
    direction: ctx => Math.sign(ctx.arima ?? 0)
  },
  structural: {
    skills: ['direction'],
    describe: 'Structural model: trend + weekly seasonal + cycle + irregular, Kalman filter, refit every 126 sessions.',
    direction: ctx => Math.sign(ctx.structural ?? 0)
  }
};

/** A cumulative log-scale volatility, as an expected move in percent. */
function logVolPct(v) {
  return Number.isFinite(v) ? Math.expm1(v) * 100 : null;
}

// ---------------------------------------------------------------------------
// Cohorts
// ---------------------------------------------------------------------------

/**
 * `established` means the asset's first bar predates `windowOpen`, so its
 * presence in the panel is not conditioned on surviving the evaluation window.
 * This is the split that turned a t=13.6 result into t=0.58.
 */
export function cohortOf(firstBarDate, windowOpen) {
  if (!firstBarDate) return 'unknown';
  return firstBarDate < windowOpen ? 'established' : 'recent';
}

export function liquidityTier(medianDollarVolume) {
  if (!Number.isFinite(medianDollarVolume)) return 'unknown';
  if (medianDollarVolume >= 1e8) return 'deep';
  if (medianDollarVolume >= 1e7) return 'liquid';
  if (medianDollarVolume >= 1e6) return 'thin';
  return 'microcap';
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Direction skill: hit rate against 50%, clustered by date, plus the net return
 * after costs. A hit rate above 50% with a net return of zero is not a signal,
 * it is a model that wins small and loses big -- which is exactly what the
 * survivorship artifact looked like on liquid assets.
 */
export function scoreDirection(rows, model, { costPct = 0.20 } = {}) {
  if (!model.skills.includes('direction')) return null;
  const usable = rows.filter(r => {
    const d = model.direction(r);
    return d === 1 || d === -1;
  });
  if (usable.length < 30) return { forecasts: usable.length, status: 'insufficient' };
  const hit = clusteredT(usable, r => (model.direction(r) === Math.sign(r.actual) ? 1 : 0) - 0.5);
  const net = clusteredT(usable, r => model.direction(r) * r.actual - costPct);
  return {
    forecasts: usable.length, clusters: hit.clusters,
    hitRate: hit.mean == null ? null : hit.mean + 0.5, hitT: hit.t,
    netPct: net.mean, netT: net.t, costPct
  };
}

/**
 * Magnitude skill: how well the model ORDERS the size of the coming move.
 * Spearman, because the level is a separate (and easily rescaled) question from
 * the ranking, and because the tail would otherwise dominate.
 */
export function scoreMagnitude(rows, model) {
  if (!model.skills.includes('magnitude')) return null;
  const pairs = [];
  for (const r of rows) {
    const m = model.magnitude(r);
    if (Number.isFinite(m)) pairs.push([m, Math.abs(r.actual)]);
  }
  if (pairs.length < 30) return { forecasts: pairs.length, status: 'insufficient' };
  const pred = pairs.map(p => p[0]), act = pairs.map(p => p[1]);
  const constant = sd(pred) === 0;
  return {
    forecasts: pairs.length,
    // A constant forecast has no ordering information by construction; saying
    // "Spearman null" is the honest answer, not 0.
    spearman: constant ? null : spearman(pred, act),
    meanAbsoluteError: mean(pred.map((p, i) => Math.abs(p - act[i]))),
    meanPredicted: mean(pred), meanActual: mean(act)
  };
}

/**
 * Score every model on every skill it claims, for one set of rows.
 */
export function scoreField(rows, { costPct = 0.20, models = MODELS } = {}) {
  const out = {};
  for (const [name, model] of Object.entries(models)) {
    out[name] = {
      describe: model.describe, skills: model.skills,
      direction: scoreDirection(rows, model, { costPct }),
      magnitude: scoreMagnitude(rows, model)
    };
  }
  return out;
}

/**
 * The same field, split by cohort. This is the only reporting entry point on
 * purpose: a headline that is not cohort-split is the thing that produced the
 * false positive, so the module does not offer one.
 */
export function scoreByCohort(rows, { costPct = 0.20, models = MODELS } = {}) {
  const groups = new Map();
  for (const r of rows) {
    const k = r.cohort || 'unknown';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const byCohort = {};
  for (const [k, rs] of groups) byCohort[k] = { rows: rs.length, field: scoreField(rs, { costPct, models }) };
  return {
    zooVersion: ZOO_VERSION, actionable: false,
    total: rows.length, byCohort,
    // Stated so a reader cannot mistake the pooled number for the finding.
    note: 'A result present only in the `recent` cohort is survivorship until proven otherwise.'
  };
}

// ---------------------------------------------------------------------------
// Does a per-asset choice survive its own history?
// ---------------------------------------------------------------------------

/**
 * Split each asset chronologically and ask whether the better model in the
 * first half is still better in the second. Reported as Spearman across assets,
 * because Pearson here is driven by a handful of extreme assets: on the
 * hierarchical-vs-adaptive direction edge the two disagreed 0.186 against
 * 0.0001, and the rank correlation was the one telling the truth.
 *
 * Returns `selectable: false` unless the rank correlation clears `threshold`.
 * Per-asset model selection has now failed this test three separate ways, so
 * the default is to refuse it.
 */
export function selectionPersistence(rows, modelA, modelB, skill, {
  minPerAsset = 300, threshold = 0.2, costPct = 0.20
} = {}) {
  const bySymbol = new Map();
  for (const r of rows) {
    if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, []);
    bySymbol.get(r.symbol).push(r);
  }
  const edge = (rs, model) => {
    if (skill === 'direction') {
      const s = scoreDirection(rs, model, { costPct });
      return s && Number.isFinite(s.hitRate) ? s.hitRate - 0.5 : null;
    }
    const s = scoreMagnitude(rs, model);
    return s && Number.isFinite(s.spearman) ? s.spearman : null;
  };
  const pairs = [];
  for (const [, rs] of bySymbol) {
    if (rs.length < minPerAsset) continue;
    const sorted = rs.slice().sort((a, b) => a.date.localeCompare(b.date));
    const mid = Math.floor(sorted.length / 2);
    const h1 = sorted.slice(0, mid), h2 = sorted.slice(mid);
    const d1 = edge(h1, modelA), e1 = edge(h1, modelB);
    const d2 = edge(h2, modelA), e2 = edge(h2, modelB);
    if ([d1, e1, d2, e2].some(v => v == null)) continue;
    pairs.push([d1 - e1, d2 - e2]);
  }
  if (pairs.length < 20) return { assets: pairs.length, status: 'insufficient', selectable: false };
  const rho = spearman(pairs.map(p => p[0]), pairs.map(p => p[1]));
  const r = pearson(pairs.map(p => p[0]), pairs.map(p => p[1]));
  return {
    assets: pairs.length, skill, spearman: rho, pearson: r, threshold,
    // Rank correlation decides. See the docstring for why.
    selectable: Number.isFinite(rho) && rho >= threshold,
    divergenceWarning: Number.isFinite(rho) && Number.isFinite(r) && Math.abs(r - rho) > 0.25
      ? 'Pearson and Spearman disagree; a few assets dominate the Pearson.' : null
  };
}

// ---------------------------------------------------------------------------
// Integration: score the field on a completed walk-forward
// ---------------------------------------------------------------------------

/**
 * Per-symbol volatility scales as of each date. EWMA runs the recursion over
 * the asset's FULL history rather than a window, so it is the real estimator
 * and not an approximation of it.
 */
export function volatilityScales(assets) {
  const ewma = new Map(), har = new Map(), lastReturn = new Map(), return5 = new Map();
  // Trailing realized volatility over the same 60-bar window `featureRow` uses,
  // so `trailingVol` in the field is the scale production actually runs on.
  const trailing = new Map();
  for (const a of assets) {
    // Aligned exactly as featureRow aligns them, so the scale at a decision
    // date is the one production had at that close -- for a CoinGecko asset
    // the raw row dated D is D-1's close, and keying on it read a day stale.
    const bars = sanitizeBars(a.bars);
    if (!bars || bars.length < 25) continue;
    const returns = [];
    let v = null;
    for (let i = 1; i < bars.length; i++) {
      if (!(bars[i].close > 0) || !(bars[i - 1].close > 0)) continue;
      const lr = Math.log(bars[i].close / bars[i - 1].close);
      if (!Number.isFinite(lr)) continue;
      returns.push(lr);
      v = v == null ? lr * lr : 0.94 * v + 0.06 * lr * lr;
      const key = `${a.symbol}|${bars[i].date}`;
      ewma.set(key, Math.sqrt(Math.max(v, 0)));
      if (returns.length >= 22) {
        const h = harComponents(returns);
        if (h) har.set(key, (h.d + h.w + h.m) / 3);
      }
      lastReturn.set(key, lr);
      if (returns.length >= 5) return5.set(key, returns.slice(-5).reduce((s, x) => s + x, 0));
      if (returns.length >= 60) {
        const w = returns.slice(-60);
        const m = mean(w);
        trailing.set(key, Math.sqrt(mean(w.map(x => (x - m) ** 2))));
      }
    }
  }
  return { ewma, har, trailing, lastReturn, return5 };
}

/**
 * Median dollar volume over the trailing window, as a liquidity proxy.
 *
 * The archive does not store volume in one unit. Equity bars carry SHARES
 * (Yahoo), so dollars are volume x close. Crypto bars from Yahoo, CoinGecko
 * and Binance's quote volume are already in USD, and multiplying them by price
 * again -- what this function did until 2026-09-23 -- made BTC's "dollar
 * volume" 1.7e15 and sorted every coin's liquidity tier by its PRICE. Callers
 * pass `quoteDenominated` for crypto.
 */
export function medianDollarVolume(bars, lookback = 400, { quoteDenominated = false } = {}) {
  const v = (bars || []).filter(b => b.volume > 0 && b.close > 0)
    .slice(-lookback).map(b => (quoteDenominated ? b.volume : b.volume * b.close));
  if (v.length <= 50) return null;
  v.sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)];
}

// ---------------------------------------------------------------------------
// Head-to-head: a candidate against the model it would replace
// ---------------------------------------------------------------------------

/**
 * QLIKE, the volatility-forecast loss that stays consistent when the squared
 * return is a noisy stand-in for the true variance (Patton, 2011). Lower is
 * better; differences are what matter, the level is not interpretable.
 */
export function qlike(predictedPct, actualPct) {
  const s = Math.log1p(predictedPct / 100), r = Math.log1p(actualPct / 100);
  const h = s * s;
  return h > 0 && Number.isFinite(r) ? Math.log(h) + (r * r) / h : null;
}

/**
 * Two magnitude models on EXACTLY the same rows -- the rows where both have a
 * forecast -- so a model is never flattered by being scored on a friendlier
 * subset. The paired loss difference is clustered by date (a market-wide day
 * is one trial) and reported for each chronological half as well, because an
 * advantage that exists in only one half is a regime, not a model.
 */
export function magnitudeHeadToHead(rows, candidate, incumbent, { minClusters = 10 } = {}) {
  const common = [];
  for (const r of rows) {
    const a = candidate.magnitude(r), b = incumbent.magnitude(r);
    if (!Number.isFinite(a) || !Number.isFinite(b) || !(a > 0) || !(b > 0)) continue;
    const qa = qlike(a, r.actual), qb = qlike(b, r.actual);
    if (!Number.isFinite(qa) || !Number.isFinite(qb)) continue;
    common.push({ date: r.date, a, b, act: Math.abs(r.actual), qa, qb });
  }
  if (common.length < 30) return { forecasts: common.length, status: 'insufficient' };
  const summarize = rs => {
    const mae = clusteredT(rs, x => Math.abs(x.a - x.act) - Math.abs(x.b - x.act), { minClusters });
    const ql = clusteredT(rs, x => x.qa - x.qb, { minClusters });
    return {
      forecasts: rs.length, clusters: ql.clusters,
      spearmanCandidate: spearman(rs.map(x => x.a), rs.map(x => x.act)),
      spearmanIncumbent: spearman(rs.map(x => x.b), rs.map(x => x.act)),
      maeDifference: mae.mean, maeT: mae.t,
      qlikeDifference: ql.mean, qlikeT: ql.t
    };
  };
  const sorted = common.slice().sort((x, y) => x.date.localeCompare(y.date));
  const dates = [...new Set(sorted.map(x => x.date))];
  const cut = dates[Math.floor(dates.length / 2)];
  return {
    ...summarize(common),
    firstHalf: summarize(sorted.filter(x => x.date < cut)),
    secondHalf: summarize(sorted.filter(x => x.date >= cut)),
    // Negative is better for the candidate on both losses.
    note: 'Differences are candidate minus incumbent; negative favours the candidate.'
  };
}

/** Scales entered in the band test: production's, and the two GARCH forms. */
export const INTERVAL_SCALES = ['trailingVol', 'garchVol', 'garchWeekdayVol'];

/** The comparisons the time-series candidates were added to answer. */
export const TIME_SERIES_COMPARISONS = [
  ['garchVol', 'ewmaVol', 'Is GARCH better than the fixed-decay EWMA it generalizes?'],
  ['garchVol', 'harVol', 'Does GARCH beat the incumbent magnitude winner?'],
  ['garchVol', 'trailingVol', 'Does GARCH beat the scale production runs on?'],
  ['garchWeekdayVol', 'garchVol', 'Does weekday seasonality add to GARCH?'],
  ['garchWeekdayVol', 'trailingVol', 'Does the seasonal GARCH band scale beat the scale production runs on?'],
  ['harWeekdayVol', 'harVol', 'Does weekday seasonality add to HAR?'],
  ['harWeekdayVol', 'trailingVol', 'Does seasonal HAR beat the scale production runs on?']
];

export function timeSeriesHeadToHead(rows, { models = MODELS } = {}) {
  const groups = new Map();
  for (const r of rows) {
    const k = r.cohort || 'unknown';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const out = {};
  for (const [candidate, incumbent, question] of TIME_SERIES_COMPARISONS) {
    if (!models[candidate] || !models[incumbent]) continue;
    const byCohort = {};
    for (const [k, rs] of groups) byCohort[k] = magnitudeHeadToHead(rs, models[candidate], models[incumbent]);
    out[`${candidate}_vs_${incumbent}`] = { candidate, incumbent, question, byCohort };
  }
  return out;
}

/**
 * The band test: an 80% interval built exactly the way production builds one
 * (per asset, radius = the 80th percentile of that asset's last 180 matured
 * |standardized errors|), with each candidate volatility as the scale. A scale
 * earns its place by a NARROWER band at the same coverage, and -- the part a
 * weekday-blind scale cannot deliver -- by coverage that holds on every
 * weekday rather than averaging an over-covered Saturday with an
 * under-covered Monday.
 */
export function intervalComparison(rows, modelNames, {
  models = MODELS, coverage = 0.8, calibration = 180, warmup = 60, calendar = 'calendar'
} = {}) {
  const usable = rows.filter(r => Number.isFinite(r.actual) && r.actual > -100
    && modelNames.every(m => { const v = models[m].magnitude(r); return Number.isFinite(v) && v > 0; }));
  const bySymbol = new Map();
  for (const r of usable) {
    if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, []);
    bySymbol.get(r.symbol).push(r);
  }
  for (const list of bySymbol.values()) list.sort((a, b) => a.date.localeCompare(b.date));
  const targetWeekday = date => {
    const t = new Date(dateMs(date));
    do { t.setUTCDate(t.getUTCDate() + 1); } while (calendar === 'business' && (t.getUTCDay() === 0 || t.getUTCDay() === 6));
    return t.getUTCDay();
  };
  const out = {};
  for (const name of modelNames) {
    let n = 0, covered = 0, width = 0;
    const byDay = Array.from({ length: 7 }, () => [0, 0]);
    for (const list of bySymbol.values()) {
      const history = [];
      for (const r of list) {
        const scale = Math.log1p(models[name].magnitude(r) / 100);
        const z = Math.log1p(r.actual / 100) / scale;
        if (history.length >= warmup) {
          const recent = history.slice(-calibration).map(Math.abs).sort((a, b) => a - b);
          const radius = recent[Math.ceil(coverage * recent.length) - 1];
          const hit = Math.abs(z) <= radius ? 1 : 0;
          n++; covered += hit;
          width += (Math.expm1(radius * scale) - Math.expm1(-radius * scale)) * 100;
          if (r.horizon === 1) { const d = byDay[targetWeekday(r.date)]; d[0]++; d[1] += hit; }
        }
        history.push(z);
      }
    }
    const daily = byDay.filter(d => d[0] >= 30).map(d => d[1] / d[0]);
    out[name] = {
      forecasts: n, coverage: n ? covered / n : null, meanWidthPct: n ? width / n : null,
      // Only meaningful at a one-session horizon; a multi-day window spans
      // several weekdays and has no single "target weekday".
      weekdayCoverageSpread: daily.length >= 2 ? Math.max(...daily) - Math.min(...daily) : null
    };
  }
  return { nominalCoverage: coverage, calibrationForecasts: calibration, models: out };
}

/**
 * Attach cohort, liquidity tier and the volatility candidates to each scored
 * forecast. Exported so the research harness scores the identical rows the
 * daily job does.
 */
export function buildZooRows(assets, outcomes, { horizon = 1, adaptiveBySymbolDate = null, timeSeries = true, log = null } = {}) {
  const windowOpen = outcomes.reduce((m, r) => (r.asOf < m ? r.asOf : m), outcomes[0].asOf);
  const scales = volatilityScales(assets);
  const firstBar = new Map(), tier = new Map(), paths = new Map();
  const failures = [];
  for (const a of assets) {
    const aligned = sanitizeBars(a.bars);
    if (aligned.length) firstBar.set(a.symbol, aligned[0].date);
    tier.set(a.symbol, liquidityTier(medianDollarVolume(a.bars, 400,
      { quoteDenominated: !['stock', 'benchmark'].includes(a.assetClass) })));
    if (!timeSeries) continue;
    // One asset's model failing to fit must never fail the field; it simply
    // has no time-series forecasts, and that is counted.
    try { paths.set(a.symbol, timeSeriesPaths(a)); } catch (error) { failures.push({ symbol: a.symbol, error: String(error?.message || error) }); }
  }
  if (log && failures.length) log(`[zoo] time-series paths failed for ${failures.length} assets`);
  const rows = outcomes.map(o => {
    const key = `${o.symbol}|${o.asOf}`;
    const ts = paths.get(o.symbol)?.get(o.asOf);
    return {
      symbol: o.symbol, date: o.asOf, actual: o.actualPct, hier: o.predictedPct,
      adap: adaptiveBySymbolDate?.get(key) ?? null,
      volPct: (() => {
        const t = scales.trailing.get(key);
        return Number.isFinite(t) ? Math.expm1(t * Math.sqrt(horizon)) * 100 : null;
      })(),
      horizon,
      cohort: cohortOf(firstBar.get(o.symbol), windowOpen),
      tier: tier.get(o.symbol) ?? 'unknown',
      ewmaDailyVol: scales.ewma.get(key), harDailyVol: scales.har.get(key),
      return1: scales.lastReturn.get(key), return5: scales.return5.get(key),
      garchLogVol: ts?.garchVol?.[horizon] ?? null,
      garchWeekdayLogVol: ts?.garchWeekdayVol?.[horizon] ?? null,
      harWeekdayLogVol: ts?.harWeekdayVol?.[horizon] ?? null,
      arima: ts?.arima?.[horizon] ?? null,
      structural: ts?.structural?.[horizon] ?? null
    };
  });
  return { rows, windowOpen, timeSeriesFailures: failures };
}

/**
 * Attach cohort, liquidity tier and the volatility candidates to each scored
 * forecast, then score the whole field split by cohort.
 *
 * `outcomes` are walk-forward rows carrying `symbol`, `asOf`, `actualPct` and
 * `predictedPct`. `adaptiveBySymbolDate` is optional; when absent the adaptive
 * model simply reports insufficient data rather than being silently skipped.
 */
export function buildZooSection(assets, outcomes, {
  horizon = 1, costPct = 0.20, adaptiveBySymbolDate = null, timeSeries = true, log = null
} = {}) {
  if (!outcomes?.length) return { zooVersion: ZOO_VERSION, actionable: false, status: 'no-outcomes' };
  const { rows, windowOpen, timeSeriesFailures } = buildZooRows(assets, outcomes,
    { horizon, adaptiveBySymbolDate, timeSeries, log });
  const intervalCalendar = assets.some(a => ['stock', 'benchmark'].includes(a.assetClass)) ? 'business' : 'calendar';
  const scored = scoreByCohort(rows, { costPct });
  return {
    ...scored, horizon, windowOpen,
    timeSeries: timeSeries ? {
      version: TIME_SERIES_VERSION,
      failedAssets: timeSeriesFailures.length,
      headToHead: timeSeriesHeadToHead(rows),
      intervals: Object.fromEntries(['established', 'recent'].map(cohort => [cohort,
        intervalComparison(rows.filter(r => r.cohort === cohort), INTERVAL_SCALES, { calendar: intervalCalendar })]))
    } : { status: 'not-computed' },
    selection: {
      // Per-asset selection is reported, never applied. Three separate methods
      // have now put the direction version of this at a rank correlation
      // indistinguishable from zero.
      //
      // When no adaptive forecasts were supplied this comparison has no data.
      // It must say so: a `selectable: false` carrying a null correlation reads
      // like a measured negative, and mistaking "not computed" for "tested and
      // refuted" is the exact confusion this module exists to prevent.
      hierarchicalVsAdaptiveDirection: adaptiveBySymbolDate
        ? selectionPersistence(rows, MODELS.hierarchical, MODELS.adaptive, 'direction', { costPct })
        : { status: 'not-computed', reason: 'no adaptive forecasts supplied', selectable: false },
      harVsEwmaMagnitude: selectionPersistence(rows, MODELS.harVol, MODELS.ewmaVol, 'magnitude', { costPct }),
      harVsTrailingMagnitude: selectionPersistence(rows, MODELS.harVol, MODELS.trailingVol, 'magnitude', { costPct }),
      harWeekdayVsHarMagnitude: timeSeries
        ? selectionPersistence(rows, MODELS.harWeekdayVol, MODELS.harVol, 'magnitude', { costPct })
        : { status: 'not-computed', selectable: false }
    }
  };
}
