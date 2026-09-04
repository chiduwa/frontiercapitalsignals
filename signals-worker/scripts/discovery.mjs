// Continuous, self-validating pattern discovery across the archive.
//
// User-requested 2026-08-30: "build in a system that automatically tracks and
// looks for such and any other useful correlations/observations in assets, so
// it notifies me... all data should be logged and automatically learned from
// so that our predictions will be better continuously."
//
// WHY THIS IS ALLOWED TO MINE PER-SYMBOL, WHEN correlation-research.mjs IS NOT
//
// That module's own docs are emphatic that testing dozens of individual
// symbols is the multiple-testing trap, and pools by asset class instead. That
// reasoning is correct for a one-shot study, where the only evidence available
// is the data you searched. It does not bind a system that runs forever.
//
// The defence here is different and strictly stronger: a finding is never
// trusted on the data that produced it. It is recorded as `provisional` and
// then re-tested only on bars recorded AFTER its discovery date. Data that did
// not exist when the search ran cannot have been mined, so surviving that test
// is genuine out-of-sample evidence. A spurious pattern found by scanning 60
// symbols will not replicate; a real one will. That is what lets this look
// per-symbol at all, and it is why nothing is notified at `provisional`.
//
// Both guards still apply at discovery: a Bonferroni bar scaled to the actual
// number of hypotheses in the family, and the same chronological split-half
// check the rest of this engine uses. Out-of-sample confirmation is a third
// bar on top, not a replacement for them.
//
// Required env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID
// Optional: NTFY_TOPIC (status-change alerts),
// FCS_CRYPTO_ROUND_TRIP_COST_PCT / FCS_STOCK_ROUND_TRIP_COST_PCT (all-in
// execution-cost assumptions; defaults are exported below)
import { chronologicalHalfSplit, RELIABILITY_SIGNIFICANCE_Z } from '../worker.js';
import { d1, d1Batch } from './d1-client.mjs';
import { MARKET_CONTEXT_METHOD_VERSION } from './market-context.mjs';

const MARKET_CONTEXT_PROVIDER_BY_METRIC = Object.freeze({
  btc_mvrv: 'coinmetrics-community',
  btc_mayer_multiple: 'fcs-asset-daily-bars'
});

const {
  CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID, NTFY_TOPIC,
  FCS_CRYPTO_ROUND_TRIP_COST_PCT, FCS_STOCK_ROUND_TRIP_COST_PCT
} = process.env;
// Env is validated inside main(), not at module scope, so the pure statistical
// helpers below can be imported and unit-tested without credentials. Checking
// at import time made the whole module unloadable in the test suite.
const env = { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID };
const costOverrides = {
  crypto: FCS_CRYPTO_ROUND_TRIP_COST_PCT,
  stock: FCS_STOCK_ROUND_TRIP_COST_PCT
};

function requireEnv() {
  for (const [name, v] of Object.entries({ CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID })) {
    if (!v) { console.error(`Missing required env var: ${name}`); process.exit(1); }
  }
}

const MIN_SAMPLE = 60;          // per side of a two-sample test
const MIN_OOS_SAMPLE = 25;      // before an out-of-sample verdict is allowed at all
const DISCOVERY_ALPHA = 0.01;   // family-wide, matching RELIABILITY_SIGNIFICANCE_Z's two-tailed 0.01
const OOS_MIN_Z = 1.0;          // deliberately lenient — see evaluateOutOfSample
const STRATEGY_CONFIDENCE_Z = 1.96;
// Explicit assumptions, not observations. These are deliberately conservative
// enough to include a retail fee + spread allowance, but they do NOT pretend to
// model market impact, borrow, funding, taxes, or a specific venue. Operators
// can raise them without changing code when their real all-in costs are known.
export const DEFAULT_ROUND_TRIP_COST_PCT = Object.freeze({ crypto: 0.30, stock: 0.15 });
// Monthly families get a lower floor purely because months are scarce: six
// years is ~72 of them. This buys nothing statistically — the z-test already
// accounts for sample size — it only stops the family from being skipped
// outright before it can ever be tested. The out-of-sample stage still has to
// pass, and with monthly data that takes real calendar time to accumulate.
const MIN_SAMPLE_MONTHLY = 8;

// Acklam's rational approximation to the inverse normal CDF. Needed because
// the Bonferroni bar depends on the family size, which is only known at
// runtime (it is however many symbols actually had enough data), so the
// critical value cannot be a hardcoded constant the way it is elsewhere.
export function normalQuantile(p) {
  if (!(p > 0 && p < 1)) return NaN;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pl = 0.02425, ph = 1 - pl;
  let q, r;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  }
  if (p > ph) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  }
  q = p - 0.5; r = q * q;
  return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q / (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
}

// Two-tailed Bonferroni critical value for a family of `k` hypotheses. Scaling
// the bar to the number of tests ACTUALLY run is the whole point: scanning 60
// symbols and 5 weekdays is 300 chances for noise to clear a fixed bar.
export function familyZBar(k, alpha = DISCOVERY_ALPHA) {
  const tests = Math.max(1, k);
  return Math.abs(normalQuantile(1 - (alpha / tests) / 2));
}

// --------------------------- STRATEGY ACCOUNTING ---------------------------

function finiteNumber(value) {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function roundTripCostPct(assetClass, overrides = {}) {
  const configured = finiteNumber(overrides[assetClass]);
  if (configured != null && configured >= 0) return configured;
  return DEFAULT_ROUND_TRIP_COST_PCT[assetClass] ?? DEFAULT_ROUND_TRIP_COST_PCT.crypto;
}

function sampleMoments(values) {
  if (!values.length) return { mean: null, stdev: null, standardError: null, lower95: null };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (values.length < 2) return { mean, stdev: null, standardError: null, lower95: null };
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  const stdev = Math.sqrt(Math.max(0, variance));
  const iidSe = stdev / Math.sqrt(values.length);

  // Daily returns cluster (especially turn-of-month observations), so an IID
  // standard error can be much too optimistic. Use a short Bartlett-weighted
  // Newey-West estimate and take the larger of it and IID. The max keeps
  // negative sample autocorrelation from making the gate easier to clear.
  const maxLag = Math.min(5, values.length - 1);
  const centered = values.map((value) => value - mean);
  let longRunVariance = centered.reduce((sum, value) => sum + value * value, 0) / values.length;
  for (let lag = 1; lag <= maxLag; lag++) {
    let covariance = 0;
    for (let i = lag; i < centered.length; i++) covariance += centered[i] * centered[i - lag];
    covariance /= values.length;
    longRunVariance += 2 * (1 - lag / (maxLag + 1)) * covariance;
  }
  const hacSe = Math.sqrt(Math.max(0, longRunVariance) / values.length);
  const standardError = Math.max(iidSe, hacSe);
  return { mean, stdev, standardError, lower95: mean - STRATEGY_CONFIDENCE_Z * standardError };
}

// Difference-of-means test with the same conservative IID-or-Newey-West
// uncertainty used by the strategy layer. Market regimes persist, so treating
// adjacent daily observations as IID can make a calendar/cycle pattern look
// far more certain than it is.
export function twoSampleHacTest(sampleA, sampleB) {
  const values = (sample) => (sample || []).slice().sort((a, b) => {
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || !a.date || !b.date) return 0;
    return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
  }).map((point) => finiteNumber(point && typeof point === 'object' ? point.value : point)).filter((value) => value != null);
  const a = values(sampleA), b = values(sampleB);
  if (a.length < 2 || b.length < 2) return { z: null, effectSize: null, n: a.length + b.length };
  const am = sampleMoments(a), bm = sampleMoments(b);
  const se = Math.sqrt((am.standardError || 0) ** 2 + (bm.standardError || 0) ** 2);
  const effectSize = am.mean - bm.mean;
  return { z: se > 0 ? effectSize / se : effectSize === 0 ? 0 : null, effectSize, n: a.length + b.length };
}

function metricsFromGrossReturns(grossReturns, costPct) {
  const cost = Math.max(0, finiteNumber(costPct) ?? 0);
  const gross = grossReturns.map(finiteNumber).filter((value) => value != null);
  const net = gross.map((value) => value - cost);
  const grossStats = sampleMoments(gross);
  const netStats = sampleMoments(net);

  let logEquity = 0;
  let peakLogEquity = 0;
  let ruined = false;
  let maxDrawdownPct = 0;
  for (const value of net) {
    // A short can lose more than 100%. Treat that as ruin, not a negative
    // account value that later returns can magically revive.
    const factor = 1 + value / 100;
    if (factor <= 0 || ruined) {
      ruined = true;
      maxDrawdownPct = 100;
      continue;
    }
    logEquity += Math.log(factor);
    peakLogEquity = Math.max(peakLogEquity, logEquity);
    const drawdown = (1 - Math.exp(logEquity - peakLogEquity)) * 100;
    maxDrawdownPct = Math.max(maxDrawdownPct, drawdown);
  }
  const maxSafeLog = Math.log(Number.MAX_VALUE / 100);
  const compoundReturnPct = ruined ? -100 : logEquity < maxSafeLog ? Math.expm1(logEquity) * 100 : null;

  const grossProfit = net.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(net.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
  return {
    tradeN: net.length,
    assumedRoundTripCostPct: cost,
    grossMeanPct: grossStats.mean,
    netMeanPct: netStats.mean,
    netLower95Pct: netStats.lower95,
    winRatePct: net.length ? net.filter((value) => value > 0).length / net.length * 100 : null,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    compoundReturnPct: net.length ? compoundReturnPct : null,
    maxDrawdownPct: net.length ? maxDrawdownPct : null,
    worstTradePct: net.length ? Math.min(...net) : null
  };
}

// Turns an observed setup return into an executable long/short return and
// subtracts one explicit round trip per event. The setup return itself is
// never relabelled as a probability, target, or guaranteed top/bottom.
export function strategyMetrics(samples, direction, costPct) {
  const side = direction === -1 || direction === 'short' ? -1 : direction === 1 || direction === 'long' ? 1 : 0;
  const ordered = (samples || []).slice().sort((a, b) => {
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || !a.date || !b.date) return 0;
    return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
  });
  const values = ordered.map((point) => finiteNumber(point && typeof point === 'object' ? point.value : point)).filter((value) => value != null);
  const metrics = metricsFromGrossReturns(side ? values.map((value) => side * value) : [], costPct);
  return { ...metrics, direction: side > 0 ? 'long' : side < 0 ? 'short' : 'abstain' };
}

export function strategyEligibility(metrics, minTrades = MIN_OOS_SAMPLE) {
  if (!metrics || metrics.direction === 'abstain') return { eligible: false, reason: 'no-direction' };
  if (metrics.tradeN < minTrades) return { eligible: false, reason: 'insufficient-trades' };
  if (!(metrics.netMeanPct > 0)) return { eligible: false, reason: 'no-after-cost-edge' };
  if (!(metrics.netLower95Pct > 0)) return { eligible: false, reason: 'after-cost-uncertainty-crosses-zero' };
  if (!(metrics.compoundReturnPct > 0)) return { eligible: false, reason: 'non-positive-compound-return' };
  if (metrics.profitFactor != null && !(metrics.profitFactor > 1)) return { eligible: false, reason: 'profit-factor-not-above-one' };
  return { eligible: true, reason: 'positive-after-cost-edge' };
}

// Anchored expanding-window walk-forward check. Each fold learns the side from
// the prefix that existed before that fold, then scores only the next block.
// Fold test blocks are disjoint, so one return cannot masquerade as several
// independent confirmations. This is a discovery-time stress test; genuine
// post-discovery observations are still required for `confirmed` status.
export function walkForwardStrategyAssessment(sampleA, sampleB, costPct, options = {}) {
  const foldsWanted = Math.max(2, Math.floor(options.folds ?? 3));
  const minTrainPerSide = Math.max(2, Math.floor(options.minTrainPerSide ?? 12));
  const minTestPerSide = Math.max(2, Math.floor(options.minTestPerSide ?? 3));
  const dates = [...new Set([...(sampleA || []).map((p) => p.date), ...(sampleB || []).map((p) => p.date)])].sort();
  if (dates.length < 12) return { verdict: 'insufficient', folds: [], positiveFolds: 0, metrics: metricsFromGrossReturns([], costPct) };

  const initialTrainEnd = Math.max(1, Math.floor(dates.length / 2));
  const remaining = dates.length - initialTrainEnd;
  const foldWidth = Math.max(1, Math.floor(remaining / foldsWanted));
  const folds = [];
  const heldOutGross = [];

  for (let fold = 0; fold < foldsWanted; fold++) {
    const start = initialTrainEnd + fold * foldWidth;
    const end = fold === foldsWanted - 1 ? dates.length : Math.min(dates.length, start + foldWidth);
    if (start >= end) continue;
    const startDate = dates[start];
    const endDate = dates[end - 1];
    const trainA = (sampleA || []).filter((p) => p.date < startDate);
    const trainB = (sampleB || []).filter((p) => p.date < startDate);
    const testA = (sampleA || []).filter((p) => p.date >= startDate && p.date <= endDate);
    const testB = (sampleB || []).filter((p) => p.date >= startDate && p.date <= endDate);
    if (trainA.length < minTrainPerSide || trainB.length < minTrainPerSide || testA.length < minTestPerSide || testB.length < minTestPerSide) continue;

    const trained = twoSampleHacTest(trainA, trainB);
    if (trained.effectSize == null || trained.effectSize === 0) continue;
    const direction = Math.sign(trained.effectSize);
    const tested = twoSampleHacTest(testA, testB);
    const foldMetrics = strategyMetrics(testA, direction, costPct);
    const alignedRelativeEffect = tested.effectSize == null ? null : direction * tested.effectSize;
    const passed = alignedRelativeEffect > 0 && foldMetrics.netMeanPct > 0;
    for (const point of testA) heldOutGross.push(direction * Number(point.value));
    folds.push({
      trainEndDate: dates[start - 1], testStartDate: startDate, testEndDate: endDate,
      direction: direction > 0 ? 'long' : 'short', testTrades: testA.length,
      alignedRelativeEffect, netMeanPct: foldMetrics.netMeanPct, passed
    });
  }

  const metrics = metricsFromGrossReturns(heldOutGross, costPct);
  const positiveFolds = folds.filter((fold) => fold.passed).length;
  if (folds.length < 2) return { verdict: 'insufficient', folds, positiveFolds, metrics };
  const stableAcrossFolds = positiveFolds / folds.length >= 2 / 3;
  const conservativeNetPositive = metrics.netLower95Pct != null && metrics.netLower95Pct > 0;
  return { verdict: stableAcrossFolds && conservativeNetPositive ? 'passed' : 'failed', folds, positiveFolds, metrics };
}

export function evaluateDiscoveryStrategy(entry, samples, options = {}) {
  const costPct = options.costPct ?? roundTripCostPct(entry.asset_class || entry.assetClass, options.costOverrides || {});
  if (!samples || !samples.a || !samples.b) {
    return { eligible: false, tradeDecision: 'abstain', reason: 'missing-discovery-samples', metrics: strategyMetrics([], 0, costPct), walkForward: { verdict: 'insufficient', folds: [], positiveFolds: 0, metrics: metricsFromGrossReturns([], costPct) } };
  }
  const direction = Math.sign(Number(entry.discovery_effect));
  const metrics = strategyMetrics(samples.a, direction, costPct);
  const minTrades = samples.minSample != null ? samples.minSample : MIN_SAMPLE;
  const eligibility = strategyEligibility(metrics, minTrades);
  const walkForward = walkForwardStrategyAssessment(samples.a, samples.b, costPct, options.walkForward);
  // Low-frequency monthly patterns often cannot form two useful historical
  // folds. They may remain provisional because future data is a clean test;
  // a FAILED walk-forward test, however, is an explicit abstention.
  const walkForwardOk = walkForward.verdict !== 'failed';
  const eligible = eligibility.eligible && walkForwardOk;
  return {
    eligible,
    tradeDecision: eligible ? 'provisional' : 'abstain',
    reason: !eligibility.eligible ? eligibility.reason : walkForwardOk ? 'awaiting-post-discovery-confirmation' : 'walk-forward-failed',
    metrics,
    walkForward
  };
}

// -------------------------------- FAMILIES ---------------------------------

// Family 1 — the equity overnight effect, which is what prompted all this:
// "buy at the close, sell at the open." Splits each session into the part that
// happens while the market is shut (previous close -> open) and the part that
// happens while it is open (open -> close), then asks whether they differ.
// Requires asset_daily_bars.open, added 2026-08-30 specifically for this.
export function overnightVsIntradaySamples(bars) {
  const overnight = [], intraday = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1], cur = bars[i];
    if (!prev.close || !cur.open || !cur.close) continue;
    if (prev.close <= 0 || cur.open <= 0) continue;
    const on = (cur.open / prev.close - 1) * 100;
    const id = (cur.close / cur.open - 1) * 100;
    // Same implausibility discipline as the rest of the archive work: a
    // >50% overnight gap on a large-cap is a split or a bad bar, not a move.
    if (!Number.isFinite(on) || !Number.isFinite(id) || Math.abs(on) > 50 || Math.abs(id) > 50) continue;
    overnight.push({ date: cur.date, value: on });
    intraday.push({ date: cur.date, value: id });
  }
  return { overnight, intraday };
}

// Family 2 — day-of-week. Each weekday against all the others, for any asset
// with daily bars, crypto included (crypto trades weekends, which is itself
// worth testing rather than assuming).
export function dayOfWeekSamples(bars, weekday) {
  const on = [], off = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1], cur = bars[i];
    if (!prev.close || !cur.close || prev.close <= 0) continue;
    const ret = (cur.close / prev.close - 1) * 100;
    if (!Number.isFinite(ret) || Math.abs(ret) > 50) continue;
    const dow = new Date(`${cur.date}T00:00:00Z`).getUTCDay();
    (dow === weekday ? on : off).push({ date: cur.date, value: ret });
  }
  return { on, off };
}

// Family 3 — turn-of-month, conditioned on how the month has actually gone.
// User's framing: "a drop or rise in the last few days of the month if an
// asset was bullish or bearish all month."
//
// The conditioning is the interesting part and also the risk: splitting each
// month into bullish/bearish doubles the hypothesis count, so both variants
// are counted in the family size rather than quietly tested for free.
//
// `trend` is judged on the month up to the start of the closing window, never
// including it — otherwise the condition would be partly made of the very
// returns being predicted, which guarantees a spurious result.
export function turnOfMonthSamples(bars, lastNDays, wantBullish) {
  const byMonth = {};
  for (const b of bars) {
    if (!b.close) continue;
    (byMonth[b.date.slice(0, 7)] ??= []).push(b);
  }
  // BOTH samples are closing-window returns. The first version compared the
  // closing window against THE SAME MONTH'S HEAD, and that was a selection
  // bias severe enough to manufacture findings: months are selected precisely
  // because their head rose (or fell), so the head's mean return is positive
  // (or negative) BY CONSTRUCTION. Comparing anything against it is comparing
  // unselected returns to returns hand-picked for their sign.
  //
  // It showed up exactly as it should have — 132 of 624 tests "passed" at a
  // |z| >= 4.31 bar where chance is ~0.001%, split roughly half positive and
  // half negative, i.e. the sign of the selection rather than of any pattern.
  //
  // Now the baseline is the closing window of months that did NOT meet the
  // trend condition. Same part of the month on both sides, so the only thing
  // that differs is the prior trend — which is the actual question.
  const matching = [], other = [];
  for (const month of Object.keys(byMonth).sort()) {
    const days = byMonth[month];
    if (days.length < lastNDays + 5) continue;   // need a real month, not a stub
    const cut = days.length - lastNDays;
    const head = days.slice(0, cut);
    const tail = days.slice(cut);
    const monthTrend = (head[head.length - 1].close / head[0].close - 1) * 100;
    if (!Number.isFinite(monthTrend)) continue;
    const isMatch = wantBullish ? monthTrend > 0 : monthTrend < 0;
    const target = isMatch ? matching : other;
    let prev = head[head.length - 1].close;
    for (const d of tail) {
      if (prev && d.close && prev > 0) {
        const ret = (d.close / prev - 1) * 100;
        if (Number.isFinite(ret) && Math.abs(ret) <= 50) target.push({ date: d.date, value: ret });
      }
      prev = d.close;
    }
  }
  return { a: matching, b: other };
}

// Family 4 — mean reversion after a run. User's framing: "crypto will usually
// have at least one bull month after two bear ones and vice versa."
//
// Tests exactly that: after `runLength` consecutive months in one direction,
// is the NEXT month's return different from an unconditional month? Monthly
// returns are built from the first and last close actually present in each
// month, so a missing day never fabricates a month boundary.
export function monthlyReturns(bars) {
  const byMonth = {};
  for (const b of bars) {
    if (!b.close) continue;
    (byMonth[b.date.slice(0, 7)] ??= []).push(b);
  }
  return Object.keys(byMonth).sort().map((m) => {
    const days = byMonth[m];
    const first = days[0].close, last = days[days.length - 1].close;
    return { month: m, days: days.length, value: first > 0 ? (last / first - 1) * 100 : null };
  }).filter((r) => r.value != null && Number.isFinite(r.value) && Math.abs(r.value) <= 200 && r.days >= 15);
}

export function runReversalSamples(bars, runLength, wantDownRun) {
  const months = monthlyReturns(bars);
  const after = [], baseline = [];
  for (let i = 0; i < months.length; i++) {
    if (i >= runLength) {
      const run = months.slice(i - runLength, i);
      const matches = run.every((m) => (wantDownRun ? m.value < 0 : m.value > 0));
      if (matches) {
        after.push({ date: months[i].month, value: months[i].value });
        continue;
      }
    }
    baseline.push({ date: months[i].month, value: months[i].value });
  }
  return { a: after, b: baseline };
}

// Equal-weight monthly return series for a whole asset class.
//
// The run-reversal question ("does crypto bounce after two bear months?") is
// asked at monthly resolution, which is inherently sample-starved: six years is
// ~72 months, and "after two down months" might occur a dozen times. The
// tempting fix — pool 83 coins to get 83x the observations — is invalid here,
// because crypto monthly returns are near-perfectly correlated: those are not
// 83 independent observations of a month, they are one month observed 83 times.
// That is the same correlation trap horizonEstimate and the class-skill gate
// already guard against elsewhere in this engine.
//
// So symbols are averaged WITHIN each month first, making the month the unit of
// observation and n the honest count of months. This produces fewer, real
// samples instead of many fake ones, and it means these families will often
// return nothing — which is a valid answer, not a failure.
export function classMonthlySeries(bySymbol, assetClass) {
  const perMonth = {};
  for (const [, rec] of Object.entries(bySymbol)) {
    if (rec.assetClass !== assetClass) continue;
    for (const m of monthlyReturns(rec.bars)) {
      (perMonth[m.month] ??= []).push(m.value);
    }
  }
  return Object.keys(perMonth).sort()
    .filter((m) => perMonth[m].length >= 3)
    .map((m) => ({ month: m, value: perMonth[m].reduce((a, b) => a + b, 0) / perMonth[m].length }));
}

export function runReversalFromSeries(series, runLength, wantDownRun) {
  const after = [], baseline = [];
  for (let i = 0; i < series.length; i++) {
    if (i >= runLength) {
      const run = series.slice(i - runLength, i);
      if (run.every((m) => (wantDownRun ? m.value < 0 : m.value > 0))) {
        after.push({ date: series[i].month, value: series[i].value });
        continue;
      }
    }
    baseline.push({ date: series[i].month, value: series[i].value });
  }
  return { a: after, b: baseline };
}

// Family 5 — market-cycle context, deliberately small and non-redundant.
// MVRV is the one on-chain valuation feature; Mayer Multiple is the simple
// price/200DMA control it must beat. NUPL is algebraically the same ordering as
// MVRV, while Pi Cycle, 2Y/4Y MA and Golden Ratio variants are overlapping
// moving-average transforms, so adding all of them would multiply tests, not
// information.
//
// Each daily context row already stores a percentile calculated against PRIOR
// values only. Forward trades enter at the next available BTC daily open. We
// then walk chronologically and retain the first eligible observation after
// the prior trade has exited; event and baseline returns therefore never
// overlap in calendar time and cannot masquerade as independent samples.
export function marketContextTailSamples(contextRows, btcBars, metric, tail, horizonDays, sinceDate = null, untilDate = null, enforceKnownAt = false, methodVersion = MARKET_CONTEXT_METHOD_VERSION, provider = MARKET_CONTEXT_PROVIDER_BY_METRIC[metric]) {
  const contexts = (contextRows || [])
    .filter((row) => row.metric === metric)
    .filter((row) => !methodVersion || row.method_version === methodVersion)
    .filter((row) => !provider || row.provider === provider)
    .filter((row) => !sinceDate || row.context_date > sinceDate)
    .filter((row) => !untilDate || row.context_date <= untilDate)
    .filter((row) => row.training_percentile != null && Number(row.training_n) >= 365
      && Number.isFinite(Number(row.training_percentile))
      && Number(row.training_percentile) >= 0 && Number(row.training_percentile) <= 1)
    .sort((a, b) => a.context_date.localeCompare(b.context_date));
  const bars = (btcBars || [])
    .filter((bar) => bar.date && Number(bar.open) > 0 && Number(bar.close) > 0)
    .slice().sort((a, b) => a.date.localeCompare(b.date));
  const days = Math.max(1, Number(horizonDays) || 1);
  const candidates = [];

  const firstBarAfter = (date) => {
    let low = 0, high = bars.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (bars[middle].date <= date) low = middle + 1;
      else high = middle;
    }
    return low < bars.length ? low : -1;
  };

  for (const context of contexts) {
    // Backfilled values can help generate a provisional hypothesis, but only
    // OOS scoring enforces their real ingestion time. A new observation is
    // entered no earlier than the first daily open AFTER it was known.
    if (enforceKnownAt && (!context.known_at || !context.source_timestamp
      || !Number.isFinite(Date.parse(context.known_at))
      || !Number.isFinite(Date.parse(context.source_timestamp)))) continue;
    const availabilityDate = enforceKnownAt
      ? [context.context_date, context.known_at.slice(0, 10), context.source_timestamp.slice(0, 10)].sort().at(-1)
      : context.context_date;
    const entryIndex = firstBarAfter(availabilityDate);
    const exitIndex = entryIndex + days - 1;
    if (entryIndex < 0 || exitIndex >= bars.length) continue;
    // The entire realized outcome must have existed inside the requested
    // sample. Filtering only the context date leaks post-cutoff exit prices
    // into the frozen discovery set for multi-day horizons.
    if (sinceDate && bars[entryIndex].date <= sinceDate) continue;
    if (untilDate && bars[exitIndex].date > untilDate) continue;
    const percentile = Number(context.training_percentile);
    const isTail = tail === 'low' ? percentile <= 0.10 : percentile >= 0.90;
    const isBaseline = percentile >= 0.25 && percentile <= 0.75;
    if (!isTail && !isBaseline) continue;
    const value = (Number(bars[exitIndex].close) / Number(bars[entryIndex].open) - 1) * 100;
    // Do not censor a trade after seeing an extreme outcome. Suspect bars are a
    // data-quality problem for the archive, not permission to delete tail losses
    // or gains selectively from the strategy sample.
    if (!Number.isFinite(value)) continue;
    const point = {
      date: bars[entryIndex].date, value,
      contextDate: context.context_date, percentile,
      sourceTimestamp: context.source_timestamp, knownAt: context.known_at,
      entryIndex
    };
    candidates.push({ sample: isTail ? 'a' : 'b', point });
  }

  const a = [], b = [];
  let lastExitIndex = -1;
  for (const candidate of candidates.sort((x, y) => x.point.entryIndex - y.point.entryIndex)) {
    const point = candidate.point;
    const pointIndex = point.entryIndex;
    if (pointIndex <= lastExitIndex) continue;
    if (candidate.sample === 'a') a.push(point);
    else b.push(point);
    lastExitIndex = pointIndex + days - 1;
  }
  return { a, b };
}

// Runs the discovery-time guards: family-corrected pooled bar, then the
// chronological split-half check. Returns null unless both pass.
export function guardedDiscovery(sampleA, sampleB, zBar, minSample = MIN_SAMPLE) {
  if (sampleA.length < minSample || sampleB.length < minSample) return null;
  const pooled = twoSampleHacTest(sampleA, sampleB);
  if (pooled.z == null || Math.abs(pooled.z) < zBar) return null;

  const { firstHalf, secondHalf } = chronologicalHalfSplit([...sampleA.map((p) => p.date), ...sampleB.map((p) => p.date)]);
  const h1 = twoSampleHacTest(sampleA.filter((p) => firstHalf.has(p.date)), sampleB.filter((p) => firstHalf.has(p.date)));
  const h2 = twoSampleHacTest(sampleA.filter((p) => secondHalf.has(p.date)), sampleB.filter((p) => secondHalf.has(p.date)));
  const sameSign = h1.effectSize != null && h2.effectSize != null && Math.sign(h1.effectSize) === Math.sign(h2.effectSize);
  const bothOk = h1.z != null && h2.z != null && Math.abs(h1.z) >= RELIABILITY_SIGNIFICANCE_Z && Math.abs(h2.z) >= RELIABILITY_SIGNIFICANCE_Z;
  if (!sameSign || !bothOk) return null;

  return {
    n: pooled.n, effectSize: pooled.effectSize, z: pooled.z,
    notes: `pooled z=${pooled.z.toFixed(2)}; h1 z=${h1.z.toFixed(2)} eff=${h1.effectSize.toFixed(4)}; h2 z=${h2.z.toFixed(2)} eff=${h2.effectSize.toFixed(4)}`
  };
}

// ----------------------------- OUT-OF-SAMPLE -------------------------------

// Re-tests one registry entry using ONLY bars dated after it was discovered.
//
// The relative-effect bar here is deliberately lenient (same sign, |z| >= 1.0)
// rather than the strict discovery bar, and that is a considered choice, not
// a shortcut.
// Out-of-sample windows are short by construction — a finding discovered last
// month has a month of new data — so demanding z >= 2.576 would reject almost
// everything real for lack of samples and turn this into a null generator.
// What actually matters at this stage is direction: a spurious pattern has no
// reason to keep pointing the same way on data it was not fitted to, while a
// real one does. That only establishes replication, though. Confirmation now
// ALSO requires the simulated setup return itself (not merely its difference
// from baseline) to retain a positive 95% lower confidence bound after the
// declared round-trip cost. A real but too-small anomaly remains an abstention.
export function evaluateOutOfSample(entry, samples = {}, options = {}) {
  const { a, b } = samples;
  const floor = samples.minSample != null ? Math.min(samples.minSample, MIN_OOS_SAMPLE) : MIN_OOS_SAMPLE;
  const costPct = options.costPct ?? roundTripCostPct(entry.asset_class || entry.assetClass, options.costOverrides || {});
  const direction = entry.strategy_direction || Math.sign(Number(entry.discovery_effect));
  const metrics = strategyMetrics(a || [], direction, costPct);
  if (!a || !b || a.length < floor || b.length < floor) {
    const decayed = entry.status === 'decayed';
    return {
      verdict: 'insufficient', statisticalVerdict: 'insufficient', n: (a ? a.length : 0) + (b ? b.length : 0), metrics, checkpoint: 0,
      tradeDecision: decayed || options.discoveryEligible === false ? 'abstain' : 'provisional',
      decisionReason: decayed ? 'decayed-pattern-requires-new-discovery'
        : options.discoveryEligible === false ? 'discovery-strategy-ineligible' : 'insufficient-post-discovery-trades'
    };
  }
  // Re-running a fixed-horizon test every day is repeated optional stopping:
  // noise eventually crosses a threshold if inspected often enough. Decisions
  // are therefore made only when the smaller side reaches a predeclared
  // doubling checkpoint (25/50/100/...; 8/16/... for sparse monthly data).
  const checkpointAt = (n) => n < floor ? 0 : floor * (2 ** Math.floor(Math.log2(n / floor)));
  const informationN = Math.min(a.length, b.length);
  const currentCheckpoint = checkpointAt(informationN);
  // `oos_trade_n` is the number of simulated setup trades (sample A), not the
  // information available to a two-sample test. The baseline side can be much
  // smaller, so persisting the setup count as the checkpoint can accidentally
  // skip the 50/100/... reviews. Keep the decision checkpoint separately.
  const priorCheckpoint = Number(entry.oos_checkpoint_n) || 0;
  if (currentCheckpoint <= priorCheckpoint) {
    const priorConfirmed = entry.status === 'confirmed' && entry.trade_decision === 'confirmed';
    return {
      verdict: 'inconclusive', statisticalVerdict: 'not-scheduled', n: a.length + b.length,
      metrics, checkpoint: currentCheckpoint,
      tradeDecision: priorConfirmed ? 'confirmed' : entry.status === 'decayed' ? 'abstain' : 'provisional',
      decisionReason: 'awaiting-next-fixed-oos-checkpoint'
    };
  }
  const r = twoSampleHacTest(a, b);
  if (r.z == null || r.effectSize == null) {
    return { verdict: 'insufficient', statisticalVerdict: 'insufficient', n: r.n || 0, metrics, checkpoint: currentCheckpoint, tradeDecision: 'abstain', decisionReason: 'unmeasurable-post-discovery-effect' };
  }
  const sameSign = Math.sign(r.effectSize) === Math.sign(entry.discovery_effect);
  const strongEnough = Math.abs(r.z) >= OOS_MIN_Z;
  // Actively contradicted: pointing the other way with real force. That is
  // worth demoting on, where merely "not yet significant" is not.
  const contradicted = !sameSign && Math.abs(r.z) >= OOS_MIN_Z;
  const statisticalVerdict = contradicted ? 'contradicted' : (sameSign && strongEnough ? 'held' : 'inconclusive');
  const eligibility = strategyEligibility(metrics, floor);
  const discoveryEligible = options.discoveryEligible !== false;
  let verdict = statisticalVerdict;
  let tradeDecision = entry.status === 'confirmed' ? 'abstain' : (discoveryEligible ? 'provisional' : 'abstain');
  let decisionReason = statisticalVerdict === 'contradicted' ? 'post-discovery-effect-reversed' : 'post-discovery-effect-inconclusive';
  if (statisticalVerdict === 'held') {
    if (discoveryEligible && eligibility.eligible) {
      verdict = 'held';
      tradeDecision = 'confirmed';
      decisionReason = 'independent-positive-after-cost-edge';
    } else {
      verdict = 'untradeable';
      tradeDecision = 'abstain';
      decisionReason = discoveryEligible ? eligibility.reason : 'discovery-strategy-ineligible';
    }
  }
  if (entry.status === 'decayed') {
    tradeDecision = 'abstain';
    decisionReason = 'decayed-pattern-requires-new-discovery';
  }
  return { verdict, statisticalVerdict, n: r.n, effectSize: r.effectSize, z: r.z, metrics, checkpoint: currentCheckpoint, tradeDecision, decisionReason };
}

// provisional -> confirmed once it has held on data it was never fitted to
// AND remains tradeable after costs.
// Anything -> decayed the moment it is actively contradicted, including a
// previously confirmed finding: a pattern that stops working is the dangerous
// case, because it keeps its authority while quietly costing money.
export function nextStatus(current, verdict) {
  if (verdict === 'contradicted') return 'decayed';
  if (verdict === 'untradeable' && current === 'confirmed') return 'decayed';
  if (verdict === 'held' && current === 'provisional') return 'confirmed';
  // A decayed pattern must go through a new discovery lifecycle before it can
  // regain authority; one favourable re-check cannot silently resurrect it.
  return current;
}

// ----------------------------- LIVE TRIGGERS -------------------------------

// A confirmed pattern is only useful if you are told when its precondition is
// actually live. This checks the CURRENT state of the archive against each
// confirmed finding and reports the ones whose setup is in place right now.
//
// Confirmed twice over, never provisional: both the statistical lifecycle and
// the separate after-cost trade decision must say confirmed. Firing an alert
// from either alone would reintroduce the noise this lifecycle exists to stop.
export function evaluateLiveTriggers(registry, bySymbol, nowIso, contextRows = []) {
  const today = nowIso.slice(0, 10);
  const out = [];
  for (const entry of registry) {
    if (entry.status !== 'confirmed') continue;
    // Rows created before the quant-metrics migration have no decision yet;
    // they remain silent until the next discovery run measures actual
    // after-cost performance. Statistical significance alone is not a trade.
    if (entry.trade_decision !== 'confirmed') continue;
    const parts = entry.hypothesis.split('|');
    const family = parts[0];

    if (family === 'market-context') {
      if (parts.length !== 6) continue;
      const [, metric, provider, methodVersion, tail] = parts;
      // Mayer is the declared price/MA200 control. A stale/manual registry
      // row must never turn the control into a production trigger.
      if (metric === 'btc_mayer_multiple') continue;
      const nowMs = Date.parse(nowIso);
      const latest = contextRows.filter((row) => row.metric === metric
          && row.provider === provider && row.method_version === methodVersion)
        .filter((row) => row.known_at && row.source_timestamp
          && Date.parse(row.known_at) <= nowMs
          && Date.parse(row.source_timestamp) <= nowMs)
        .filter((row) => row.training_percentile != null
          && Number.isFinite(Number(row.training_percentile))
          && Number(row.training_percentile) >= 0 && Number(row.training_percentile) <= 1)
        .sort((a, b) => b.context_date.localeCompare(a.context_date))[0];
      if (!latest || Number(latest.training_n) < 365) continue;
      const ageDays = (new Date(`${today}T00:00:00Z`).getTime() - new Date(`${latest.context_date}T00:00:00Z`).getTime()) / 86400000;
      if (!Number.isFinite(ageDays) || ageDays < 0 || ageDays > 2) continue;
      const percentile = Number(latest.training_percentile);
      const active = tail === 'low' ? percentile <= 0.10 : percentile >= 0.90;
      if (!active) continue;
      const label = metric === 'btc_mvrv' ? 'BTC MVRV' : metric === 'btc_mayer_multiple' ? 'BTC Mayer Multiple' : metric;
      out.push({
        entry, kind: 'market-context',
        detail: `${label} is ${Number(latest.value).toFixed(3)}, in its causal ${tail} tail (${Math.round(percentile * 100)}th percentile)`,
        expectation: `the validated ${entry.strategy_direction || (entry.discovery_effect >= 0 ? 'long' : 'short')} BTC setup is measured over ${entry.horizon_days} day${entry.horizon_days === 1 ? '' : 's'}`
      });
      continue;
    }

    if (family === 'run-reversal') {
      const [, cls, rl, dir] = parts;
      const series = classMonthlySeries(bySymbol, cls);
      const need = Number(rl);
      if (series.length < need) continue;
      // The run must be COMPLETE and immediately prior — the last `need`
      // finished months all in the same direction.
      const run = series.slice(-need);
      const matches = run.every((m) => (dir === 'down' ? m.value < 0 : m.value > 0));
      if (!matches) continue;
      out.push({
        entry, kind: 'run-reversal',
        detail: `${cls} has just closed ${need} consecutive ${dir} months (${run.map((m) => `${m.month} ${m.value >= 0 ? '+' : ''}${m.value.toFixed(1)}%`).join(', ')})`,
        expectation: `after this setup the next month has averaged ${entry.discovery_effect >= 0 ? '+' : ''}${entry.discovery_effect.toFixed(2)}% versus other months`
      });
      continue;
    }

    if (family === 'turn-of-month') {
      const [, symbol, win, trend] = parts;
      const rec = bySymbol[symbol];
      if (!rec || !rec.bars.length) continue;
      const month = today.slice(0, 7);
      const days = rec.bars.filter((b) => b.date.slice(0, 7) === month);
      if (days.length < Number(win) + 5) continue;
      // Only interesting while the closing window is approaching or open.
      const daysLeftGuess = 30 - Number(today.slice(8, 10));
      if (daysLeftGuess > Number(win) + 2) continue;
      const head = days.slice(0, Math.max(1, days.length - Number(win)));
      const monthTrend = (head[head.length - 1].close / head[0].close - 1) * 100;
      const isBull = monthTrend > 0;
      if ((trend === 'bull') !== isBull) continue;
      out.push({
        entry, kind: 'turn-of-month',
        detail: `${symbol} is ${isBull ? 'up' : 'down'} ${monthTrend.toFixed(1)}% so far this month and its final ${win} sessions are starting`,
        expectation: `in this setup those closing sessions have averaged ${entry.discovery_effect >= 0 ? '+' : ''}${entry.discovery_effect.toFixed(3)}%/day versus the rest of the month`
      });
      continue;
    }

    if (family === 'day-of-week') {
      const [, symbol, wd] = parts;
      if (new Date(`${today}T00:00:00Z`).getUTCDay() !== Number(wd)) continue;
      const name = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][Number(wd)];
      out.push({
        entry, kind: 'day-of-week',
        detail: `today is ${name}, ${symbol}'s confirmed ${entry.discovery_effect >= 0 ? 'strong' : 'weak'} weekday`,
        expectation: `${name}s have averaged ${entry.discovery_effect >= 0 ? '+' : ''}${entry.discovery_effect.toFixed(3)}% versus other days`
      });
    }
  }
  return out;
}

async function loadRegistry() {
  const rows = await d1(env, `
    SELECT r.*,
      m.strategy_direction, m.assumed_round_trip_cost_pct, m.trade_decision, m.decision_reason,
      m.oos_trade_n, m.oos_checkpoint_n, m.oos_net_mean_pct, m.oos_net_lower_95_pct,
      m.oos_profit_factor, m.oos_compound_return_pct, m.oos_max_drawdown_pct
    FROM research_registry r
    LEFT JOIN research_strategy_metrics m ON m.hypothesis = r.hypothesis
  `);
  return rows;
}

async function upsertProvisional(entry, nowIso) {
  await d1(env, `
    INSERT INTO research_registry
      (hypothesis, family, asset_class, symbol, horizon_days, status, discovered_at,
       discovery_n, discovery_effect, discovery_z, tests_in_family, last_checked_at, status_changed_at, notes)
    VALUES (?, ?, ?, ?, ?, 'provisional', ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (hypothesis) DO UPDATE SET
      last_checked_at = excluded.last_checked_at
  `, [entry.hypothesis, entry.family, entry.assetClass, entry.symbol, entry.horizonDays, nowIso,
      entry.n, entry.effectSize, entry.z, entry.testsInFamily, nowIso, nowIso, entry.notes]);
}

function dbNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function recordStrategyAssessment(hypothesis, status, statusChanged, discovery, oos, nowIso) {
  const dm = discovery.metrics;
  const wm = discovery.walkForward.metrics;
  const om = oos.metrics;
  const params = [
    hypothesis, dm.direction, dm.assumedRoundTripCostPct,
    dm.tradeN, dbNumber(dm.grossMeanPct), dbNumber(dm.netMeanPct), dbNumber(dm.netLower95Pct), dbNumber(dm.winRatePct),
    dbNumber(dm.profitFactor), dbNumber(dm.compoundReturnPct), dbNumber(dm.maxDrawdownPct), dbNumber(dm.worstTradePct),
    discovery.walkForward.verdict, discovery.walkForward.folds.length, discovery.walkForward.positiveFolds,
    dbNumber(wm.netMeanPct), dbNumber(wm.netLower95Pct), dbNumber(wm.maxDrawdownPct),
    om.tradeN, Math.max(0, Number(oos.checkpoint) || 0), dbNumber(om.grossMeanPct), dbNumber(om.netMeanPct), dbNumber(om.netLower95Pct), dbNumber(om.winRatePct),
    dbNumber(om.profitFactor), dbNumber(om.compoundReturnPct), dbNumber(om.maxDrawdownPct), dbNumber(om.worstTradePct),
    oos.tradeDecision, oos.decisionReason, nowIso
  ];
  const upsertSql = `
    INSERT INTO research_strategy_metrics (
      hypothesis, strategy_direction, assumed_round_trip_cost_pct,
      discovery_trade_n, discovery_gross_mean_pct, discovery_net_mean_pct, discovery_net_lower_95_pct, discovery_win_rate_pct,
      discovery_profit_factor, discovery_compound_return_pct, discovery_max_drawdown_pct, discovery_worst_trade_pct,
      walk_forward_verdict, walk_forward_folds, walk_forward_positive_folds,
      walk_forward_net_mean_pct, walk_forward_net_lower_95_pct, walk_forward_max_drawdown_pct,
      oos_trade_n, oos_checkpoint_n, oos_gross_mean_pct, oos_net_mean_pct, oos_net_lower_95_pct, oos_win_rate_pct,
      oos_profit_factor, oos_compound_return_pct, oos_max_drawdown_pct, oos_worst_trade_pct,
      trade_decision, decision_reason, updated_at
    ) VALUES (${params.map(() => '?').join(', ')})
    ON CONFLICT (hypothesis) DO UPDATE SET
      strategy_direction = excluded.strategy_direction,
      assumed_round_trip_cost_pct = excluded.assumed_round_trip_cost_pct,
      discovery_trade_n = excluded.discovery_trade_n,
      discovery_gross_mean_pct = excluded.discovery_gross_mean_pct,
      discovery_net_mean_pct = excluded.discovery_net_mean_pct,
      discovery_net_lower_95_pct = excluded.discovery_net_lower_95_pct,
      discovery_win_rate_pct = excluded.discovery_win_rate_pct,
      discovery_profit_factor = excluded.discovery_profit_factor,
      discovery_compound_return_pct = excluded.discovery_compound_return_pct,
      discovery_max_drawdown_pct = excluded.discovery_max_drawdown_pct,
      discovery_worst_trade_pct = excluded.discovery_worst_trade_pct,
      walk_forward_verdict = excluded.walk_forward_verdict,
      walk_forward_folds = excluded.walk_forward_folds,
      walk_forward_positive_folds = excluded.walk_forward_positive_folds,
      walk_forward_net_mean_pct = excluded.walk_forward_net_mean_pct,
      walk_forward_net_lower_95_pct = excluded.walk_forward_net_lower_95_pct,
      walk_forward_max_drawdown_pct = excluded.walk_forward_max_drawdown_pct,
      oos_trade_n = excluded.oos_trade_n,
      oos_checkpoint_n = excluded.oos_checkpoint_n,
      oos_gross_mean_pct = excluded.oos_gross_mean_pct,
      oos_net_mean_pct = excluded.oos_net_mean_pct,
      oos_net_lower_95_pct = excluded.oos_net_lower_95_pct,
      oos_win_rate_pct = excluded.oos_win_rate_pct,
      oos_profit_factor = excluded.oos_profit_factor,
      oos_compound_return_pct = excluded.oos_compound_return_pct,
      oos_max_drawdown_pct = excluded.oos_max_drawdown_pct,
      oos_worst_trade_pct = excluded.oos_worst_trade_pct,
      trade_decision = excluded.trade_decision,
      decision_reason = excluded.decision_reason,
      updated_at = excluded.updated_at
  `;
  const historySql = `
    INSERT INTO research_strategy_metric_history
      (hypothesis, trade_decision, decision_reason, oos_trade_n, oos_checkpoint_n, oos_net_mean_pct,
       oos_net_lower_95_pct, oos_compound_return_pct, oos_max_drawdown_pct, computed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  await d1Batch(env, [
    {
      sql: `UPDATE research_registry SET
              status = ?, oos_n = ?, oos_effect = ?, oos_z = ?, oos_checks = oos_checks + 1,
              last_checked_at = ?, status_changed_at = COALESCE(?, status_changed_at)
            WHERE hypothesis = ?`,
      params: [status, oos.n || 0, oos.effectSize ?? null, oos.z ?? null, nowIso, statusChanged ? nowIso : null, hypothesis]
    },
    { sql: upsertSql, params },
    { sql: historySql, params: [hypothesis, oos.tradeDecision, oos.decisionReason, om.tradeN, Math.max(0, Number(oos.checkpoint) || 0), dbNumber(om.netMeanPct),
      dbNumber(om.netLower95Pct), dbNumber(om.compoundReturnPct), dbNumber(om.maxDrawdownPct), nowIso] }
  ]);
}

async function notify(title, body, priority = 'default') {
  if (!NTFY_TOPIC) return false;
  try {
    const res = await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: 'POST', headers: { Title: title, Priority: priority, Tags: 'microscope' }, body
    });
    return res.ok;
  } catch (e) {
    console.error('discovery notify failed:', e.message);
    return false;
  }
}

// --------------------------------- MAIN ------------------------------------

function groupBars(rows) {
  // asset_daily_bars has PRIMARY KEY (symbol, date) with no asset_class, so a
  // ticker used by two different assets leaves one interleaved series. DASH is
  // the live case: Dash the crypto (~$41) and DoorDash the equity (~$237)
  // alternate in the same rows. The first discovery run found exactly one
  // "overnight effect" in the whole crypto universe and it was DASH, at -5.96%
  // with z=-12.84 — which is not a market pattern, it is two assets being
  // differenced against each other.
  //
  // dailyRangeStatsFromRows already drops these; this module needs the same
  // guard, and so will anything else built on this table until the key is
  // widened.
  const classes = {};
  for (const r of rows) (classes[r.symbol] ??= new Set()).add(r.asset_class);
  const ambiguous = Object.entries(classes).filter(([, set]) => set.size > 1).map(([sym]) => sym);
  if (ambiguous.length) console.log(`excluded ${ambiguous.length} symbol(s) present under more than one asset class: ${ambiguous.join(', ')}`);

  const bySymbol = {};
  for (const r of rows) {
    if (classes[r.symbol].size > 1) continue;
    (bySymbol[r.symbol] ??= { assetClass: r.asset_class, bars: [] }).bars.push(r);
  }
  for (const v of Object.values(bySymbol)) v.bars.sort((a, b) => (a.date < b.date ? -1 : 1));
  return bySymbol;
}

// Builds the two samples for a hypothesis inside an explicit, half-open/closed
// time box: after `sinceDate`, through `untilDate`. Reconstructing the original
// discovery sample with `untilDate=discovered_at` prevents later bars from
// leaking into the walk-forward gate; using `sinceDate=discovered_at` is the
// genuine post-discovery test.
function samplesFor(entry, bySymbol, sinceDate, untilDate = null, contextRows = []) {
  const parts = entry.hypothesis.split('|');
  const family = parts[0];
  const inWindow = (bar) => (!sinceDate || bar.date > sinceDate) && (!untilDate || bar.date <= untilDate);

  // Class-level family: rebuild the composite from bars after `sinceDate`.
  if (family === 'run-reversal') {
    const [, cls, rl, dir] = parts;
    const sliced = {};
    for (const [sym, rec] of Object.entries(bySymbol)) {
      if (rec.assetClass !== cls) continue;
      sliced[sym] = { assetClass: rec.assetClass, bars: rec.bars.filter(inWindow) };
    }
    const series = classMonthlySeries(sliced, cls);
    if (series.length < 3) return null;
    return { ...runReversalFromSeries(series, Number(rl), dir === 'down'), minSample: MIN_SAMPLE_MONTHLY };
  }

  if (family === 'market-context') {
    // Provider and calculation version are part of the evidence identity.
    // Legacy registry rows without both remain silent rather than borrowing a
    // replacement source's historical confirmation.
    if (parts.length !== 6) return null;
    const [, metric, provider, methodVersion, tail, horizon] = parts;
    const btc = bySymbol.BTC;
    if (!btc) return null;
    return marketContextTailSamples(contextRows, btc.bars, metric, tail, Number(horizon), sinceDate, untilDate, !!sinceDate, methodVersion, provider);
  }

  const rec = bySymbol[entry.symbol];
  if (!rec) return null;
  const bars = rec.bars.filter(inWindow);
  if (bars.length < 3) return null;
  if (family === 'overnight-vs-intraday') {
    const { overnight, intraday } = overnightVsIntradaySamples(bars);
    return { a: overnight, b: intraday };
  }
  if (family === 'day-of-week') {
    const { on, off } = dayOfWeekSamples(bars, Number(parts[2]));
    return { a: on, b: off };
  }
  if (family === 'turn-of-month') {
    return turnOfMonthSamples(bars, Number(parts[2]), parts[3] === 'bull');
  }
  return null;
}

async function main() {
  requireEnv();
  const nowIso = new Date().toISOString();
  console.log(`discovery run @ ${nowIso}`);

  // One read. asset_daily_bars is the largest table here, so this is the whole
  // D1 cost of the run — every family below works off this same slice.
  // Daily upstreams include today's still-forming candle. Research uses only
  // dates strictly before this run's UTC date so a partial close cannot become
  // either a feature or a supposedly matured outcome.
  const today = nowIso.slice(0, 10);
  const rows = await d1(env, "SELECT symbol, asset_class, date, open, close FROM asset_daily_bars WHERE symbol NOT LIKE 'SECTOR:%' AND symbol NOT LIKE 'MCAP:%' AND date < ? ORDER BY symbol, date", [today]);
  const bySymbol = groupBars(rows);
  console.log(`loaded ${rows.length} bars across ${Object.keys(bySymbol).length} symbols`);
  const withOpen = Object.values(bySymbol).filter((v) => v.bars.some((b) => b.open != null)).length;
  console.log(`symbols with at least one open price: ${withOpen} (the overnight family needs these)`);
  const contextRows = await d1(env, `
    SELECT metric, context_date, value, source_timestamp, known_at, provider,
           method_version, training_percentile, training_n
    FROM market_context_daily
    WHERE method_version = ?
    ORDER BY metric, context_date
  `, [MARKET_CONTEXT_METHOD_VERSION]);
  console.log(`loaded ${contextRows.length} immutable market-context rows (research only)`);

  // ---- discovery ----
  const candidates = [];

  // Family sizes must be counted BEFORE testing, so the Bonferroni bar
  // reflects every hypothesis the scan could have surfaced, not just the ones
  // that happened to produce a sample.
  const overnightSymbols = Object.entries(bySymbol).filter(([, v]) => v.bars.some((b) => b.open != null));
  const overnightZBar = familyZBar(overnightSymbols.length);
  console.log(`family overnight-vs-intraday: ${overnightSymbols.length} hypotheses, corrected |z| bar = ${overnightZBar.toFixed(3)}`);
  for (const [symbol, v] of overnightSymbols) {
    const { overnight, intraday } = overnightVsIntradaySamples(v.bars);
    const res = guardedDiscovery(overnight, intraday, overnightZBar);
    if (res) {
      candidates.push({
        hypothesis: `overnight-vs-intraday|${symbol}`, family: 'overnight-vs-intraday',
        assetClass: v.assetClass, symbol, horizonDays: 1, testsInFamily: overnightSymbols.length, ...res
      });
    }
  }

  const dowSymbols = Object.entries(bySymbol);
  const dowZBar = familyZBar(dowSymbols.length * 7);
  console.log(`family day-of-week: ${dowSymbols.length * 7} hypotheses, corrected |z| bar = ${dowZBar.toFixed(3)}`);
  for (const [symbol, v] of dowSymbols) {
    for (let wd = 0; wd < 7; wd++) {
      const { on, off } = dayOfWeekSamples(v.bars, wd);
      const res = guardedDiscovery(on, off, dowZBar);
      if (res) {
        candidates.push({
          hypothesis: `day-of-week|${symbol}|${wd}`, family: 'day-of-week',
          assetClass: v.assetClass, symbol, horizonDays: 1, testsInFamily: dowSymbols.length * 7, ...res
        });
      }
    }
  }
  // Family 3 — turn-of-month, split by how the month had gone up to that point.
  // Two windows x two trend conditions x every symbol, all counted in the bar.
  const tomWindows = [3, 5];
  const tomZBar = familyZBar(dowSymbols.length * tomWindows.length * 2);
  console.log(`family turn-of-month: ${dowSymbols.length * tomWindows.length * 2} hypotheses, corrected |z| bar = ${tomZBar.toFixed(3)}`);
  for (const [symbol, v] of dowSymbols) {
    for (const win of tomWindows) {
      for (const bullish of [true, false]) {
        const { a, b } = turnOfMonthSamples(v.bars, win, bullish);
        const res = guardedDiscovery(a, b, tomZBar);
        if (res) {
          candidates.push({
            hypothesis: `turn-of-month|${symbol}|${win}|${bullish ? 'bull' : 'bear'}`, family: 'turn-of-month',
            assetClass: v.assetClass, symbol, horizonDays: win,
            testsInFamily: dowSymbols.length * tomWindows.length * 2, ...res
          });
        }
      }
    }
  }

  // Family 4 — reversal after a directional run, at CLASS level (see
  // classMonthlySeries for why this is not per-symbol).
  const runLengths = [2, 3];
  const classes = ['crypto', 'stock'];
  const runZBar = familyZBar(classes.length * runLengths.length * 2);
  console.log(`family run-reversal: ${classes.length * runLengths.length * 2} hypotheses, corrected |z| bar = ${runZBar.toFixed(3)}`);
  for (const cls of classes) {
    const series = classMonthlySeries(bySymbol, cls);
    console.log(`  ${cls}: ${series.length} months of composite history`);
    for (const rl of runLengths) {
      for (const down of [true, false]) {
        const { a, b } = runReversalFromSeries(series, rl, down);
        const res = guardedDiscovery(a, b, runZBar, MIN_SAMPLE_MONTHLY);
        console.log(`  ${cls} after ${rl} ${down ? 'down' : 'up'} months: n_after=${a.length}, n_base=${b.length}${res ? ` -> VALIDATED z=${res.z.toFixed(2)}` : ''}`);
        if (res) {
          candidates.push({
            hypothesis: `run-reversal|${cls}|${rl}|${down ? 'down' : 'up'}`, family: 'run-reversal',
            assetClass: cls, symbol: null, horizonDays: 30,
            testsInFamily: classes.length * runLengths.length * 2, ...res
          });
        }
      }
    }
  }

  // Family 5 — only MVRV plus a transparent Mayer/MA200 control, two tails,
  // and two declared holding periods. Eight hypotheses total; no dashboard
  // threshold is imported as truth.
  const contextMetrics = ['btc_mvrv', 'btc_mayer_multiple'];
  const contextTails = ['low', 'high'];
  const contextHorizons = [1, 7];
  const contextTests = contextMetrics.length * contextTails.length * contextHorizons.length;
  const contextZBar = familyZBar(contextTests);
  console.log(`family market-context: ${contextTests} hypotheses, corrected |z| bar = ${contextZBar.toFixed(3)}`);
  for (const metric of contextMetrics) {
    const provider = MARKET_CONTEXT_PROVIDER_BY_METRIC[metric];
    for (const tail of contextTails) {
      for (const horizon of contextHorizons) {
        const { a, b } = marketContextTailSamples(contextRows, bySymbol.BTC ? bySymbol.BTC.bars : [], metric, tail, horizon, null, null, false, MARKET_CONTEXT_METHOD_VERSION, provider);
        const result = guardedDiscovery(a, b, contextZBar);
        const control = metric === 'btc_mayer_multiple';
        console.log(`  ${metric} ${tail} tail -> ${horizon}d: n_tail=${a.length}, n_base=${b.length}${result ? ` -> ${control ? 'CONTROL ONLY' : 'VALIDATED'} z=${result.z.toFixed(2)}` : ''}`);
        // Mayer is a transparent price/MA200 control, not a promotable signal.
        // It remains inside the family count and report so MVRV is not compared
        // against a conveniently omitted simple benchmark.
        if (result && !control) candidates.push({
          hypothesis: `market-context|${metric}|${provider}|${MARKET_CONTEXT_METHOD_VERSION}|${tail}|${horizon}`,
          family: 'market-context', assetClass: 'crypto', symbol: 'BTC',
          horizonDays: horizon, testsInFamily: contextTests, ...result
        });
      }
    }
  }

  console.log(`discovery: ${candidates.length} candidate(s) cleared BOTH the family-corrected bar and the split-half check`);

  const existing = new Set((await loadRegistry()).map((r) => r.hypothesis));
  let newlyProvisional = 0;
  for (const c of candidates) {
    if (!existing.has(c.hypothesis)) newlyProvisional++;
    await upsertProvisional(c, nowIso);
    await d1(env, `INSERT INTO correlation_research_findings (hypothesis, asset_class, horizon_days, n, effect_size, z, split_consistent, computed_at, notes)
                   VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [c.hypothesis, c.assetClass, c.horizonDays, c.n, c.effectSize, c.z, nowIso, c.notes]);
  }
  console.log(`registry: ${newlyProvisional} newly provisional, ${candidates.length - newlyProvisional} already known`);

  // ---- out-of-sample re-validation ----
  const registry = await loadRegistry();
  const transitions = [];
  for (const entry of registry) {
    const discoveryDate = entry.discovered_at.slice(0, 10);
    // Freeze discovery accounting at the original discovery date. Recomputing
    // it over today's full history would quietly let OOS data leak back into
    // the train/walk-forward report on every daily run.
    const discoverySamples = samplesFor(entry, bySymbol, null, discoveryDate, contextRows);
    const discovery = evaluateDiscoveryStrategy(entry, discoverySamples, { costOverrides });
    const oosSamples = samplesFor(entry, bySymbol, discoveryDate, null, contextRows)
      || { a: [], b: [], ...(entry.family === 'run-reversal' ? { minSample: MIN_SAMPLE_MONTHLY } : {}) };
    const oos = evaluateOutOfSample(
      { ...entry, strategy_direction: discovery.metrics.direction },
      oosSamples,
      { costPct: discovery.metrics.assumedRoundTripCostPct, discoveryEligible: discovery.eligible }
    );
    const next = nextStatus(entry.status, oos.verdict);
    const changed = next !== entry.status;
    // Lifecycle, latest metrics, and the audit row are one D1 transaction. A
    // partial write cannot mark a pattern confirmed without its risk gate.
    await recordStrategyAssessment(entry.hypothesis, next, changed, discovery, oos, nowIso);
    console.log(
      `[${entry.hypothesis}] lifecycle=${entry.status}->${next} decision=${oos.tradeDecision} `
      + `oos=${oos.verdict} n=${oos.n} z=${oos.z != null ? oos.z.toFixed(2) : 'n/a'} `
      + `net/trade=${oos.metrics.netMeanPct != null ? `${oos.metrics.netMeanPct.toFixed(3)}%` : 'n/a'} `
      + `lower95=${oos.metrics.netLower95Pct != null ? `${oos.metrics.netLower95Pct.toFixed(3)}%` : 'n/a'} `
      + `maxDD=${oos.metrics.maxDrawdownPct != null ? `${oos.metrics.maxDrawdownPct.toFixed(1)}%` : 'n/a'} `
      + `reason=${oos.decisionReason}`
    );
    if (changed) transitions.push({ entry, next, oos, discovery });
  }

  // ---- notify only on genuine status changes ----
  // Never on discovery: at that point the finding has only been tested on the
  // data used to find it, and notifying there would be exactly the noise this
  // design exists to avoid.
  for (const t of transitions) {
    const e = t.entry;
    const dir = e.discovery_effect >= 0 ? 'higher' : 'lower';
    if (t.next === 'confirmed') {
      const m = t.oos.metrics;
      await notify(
        `Confirmed after costs: ${e.symbol || e.asset_class} ${e.family}`,
        `${e.hypothesis} held up out-of-sample. Discovered ${e.discovered_at.slice(0, 10)} `
        + `(effect ${e.discovery_effect.toFixed(4)}%, z=${e.discovery_z.toFixed(2)}, n=${e.discovery_n}); `
        + `since then, on ${t.oos.n} bars it did not exist for at discovery, effect ${t.oos.effectSize.toFixed(4)}% (z=${t.oos.z.toFixed(2)}), same direction — ${dir}. `
        + `One of ${e.tests_in_family} hypotheses tested in this family, so the bar it cleared was corrected for that. `
        + `${m.direction.toUpperCase()} simulation: ${m.tradeN} trades, ${m.netMeanPct.toFixed(3)}% mean net/trade `
        + `(95% lower bound ${m.netLower95Pct.toFixed(3)}%) after an assumed ${m.assumedRoundTripCostPct.toFixed(2)}% round trip; `
        + `the sequential full-notional event curve compounded ${m.compoundReturnPct.toFixed(1)}% with ${m.maxDrawdownPct.toFixed(1)}% max drawdown. `
        + `This excludes market impact, borrow/funding, and taxes; it is a validated tendency, not a price target.`
      );
    } else if (t.next === 'decayed') {
      await notify(
        `Abstain: ${e.symbol || e.asset_class} ${e.family}`,
        `${e.hypothesis} has stopped working and should no longer be relied on. `
        + `It was ${e.status} (discovered ${e.discovered_at.slice(0, 10)}, effect ${e.discovery_effect.toFixed(4)}%, z=${e.discovery_z.toFixed(2)}), `
        + (t.oos.verdict === 'contradicted'
          ? `but on ${t.oos.n} newer bars it now runs the OTHER way: effect ${t.oos.effectSize.toFixed(4)}% (z=${t.oos.z.toFixed(2)}).`
          : `but the newer simulation no longer clears its after-cost confidence bar (${t.oos.decisionReason}).`),
        'high'
      );
    }
  }

  // ---- live triggers: tell the user the setup is ON, ahead of the move ----
  const finalRegistry = await loadRegistry();
  const triggers = evaluateLiveTriggers(finalRegistry, bySymbol, nowIso, contextRows);
  for (const t of triggers) {
    const e = t.entry;
    await notify(
      `Setup live: ${e.symbol || e.asset_class} ${t.kind}`,
      `${t.detail}. Historically, ${t.expectation} `
      + `(discovered ${e.discovered_at.slice(0, 10)}, z=${e.discovery_z.toFixed(2)}, n=${e.discovery_n}; `
      + `confirmed out-of-sample on ${e.oos_trade_n} simulated trades; mean after-cost return ${Number(e.oos_net_mean_pct).toFixed(3)}%/trade, `
      + `95% lower bound ${Number(e.oos_net_lower_95_pct).toFixed(3)}%, max drawdown ${Number(e.oos_max_drawdown_pct).toFixed(1)}%). `
      + `Costs are assumed, not observed; no exact entry, exit, top, or bottom is inferred.`
    );
  }
  console.log(`live triggers fired: ${triggers.length}`);

  const counts = {};
  for (const r of finalRegistry) counts[r.status] = (counts[r.status] || 0) + 1;
  const decisions = {};
  for (const r of finalRegistry) decisions[r.trade_decision || 'abstain'] = (decisions[r.trade_decision || 'abstain'] || 0) + 1;
  const leaderboard = finalRegistry
    .filter((r) => r.trade_decision === 'confirmed' && Number.isFinite(Number(r.oos_net_lower_95_pct)))
    .sort((a, b) => Number(b.oos_net_lower_95_pct) - Number(a.oos_net_lower_95_pct))
    .slice(0, 10)
    .map((r) => ({
      hypothesis: r.hypothesis, side: r.strategy_direction, horizonDays: r.horizon_days, trades: r.oos_trade_n,
      netMeanPct: Number(r.oos_net_mean_pct).toFixed(3), lower95Pct: Number(r.oos_net_lower_95_pct).toFixed(3),
      maxDrawdownPct: Number(r.oos_max_drawdown_pct).toFixed(1)
    }));
  console.log(`registry lifecycle: ${JSON.stringify(counts)} | trade decisions: ${JSON.stringify(decisions)} | ${transitions.length} transition(s) notified this run`);
  console.log(`confirmed strategy leaderboard (ranked by conservative after-cost expectancy): ${JSON.stringify(leaderboard)}`);
}

// Only run when executed directly. Importing this module (the test suite does)
// must not kick off a full research pass against the live database.
const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) main().catch((e) => { console.error(e); process.exit(1); });
