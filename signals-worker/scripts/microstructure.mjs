// Continuous cross-venue and perp-vs-spot lead-lag research, at 1-second
// resolution. User-requested 2026-09-05: look for one venue/instrument leading
// another "even if for a few seconds or minutes", keep looking forever so a
// pattern is caught whenever it emerges, and — only if evidence actually
// appears — feed it to the futures bot for scalping.
//
// This module DISCOVERS AND MEASURES. It does not authorize a trade, and
// nothing the futures bot reads is written from here. That separation is the
// point: see "WHY THIS CANNOT REACH THE BOT ON ITS OWN" below.
//
// ---------------------------------------------------------------------------
// WHAT IS MEASURED
//
// Two hypothesis families, both framed as "does X at time t tell you something
// about Y after t":
//
//   leadlag  corr(return of leader at second t, return of follower at t+k)
//            for k in -MAX_LAG..+MAX_LAG. A genuine leader peaks at k > 0.
//            The comparison that matters is the ASYMMETRY between +k and -k:
//            two venues quoting one asset correlate ~0.93-0.96 at k = 0 no
//            matter what, so raw correlation says only "same asset", never
//            "leads".
//
//   basis    corr(perp-vs-spot basis at t, follower's return over t+1..t+N).
//            Measured on the same venue, so it is a real premium rather than
//            a cross-venue quoting difference. The basis is z-scored WITHIN
//            the window before testing: live on 2026-09-05 it sat at -5.25bps
//            (BTC), -5.14 (ETH), -5.24 (SOL) with standard deviations of
//            0.34-0.75bps, i.e. almost entirely a constant structural offset.
//            Correlating the raw level would mostly be correlating a constant.
//
// ---------------------------------------------------------------------------
// THE THREE WAYS THIS MEASUREMENT LIES, AND WHAT IS DONE ABOUT EACH
//
// 1. Stale prices masquerading as lag. At 1-second granularity these venues
//    are quiet — 84.6% / 44.3% / 63.0% of seconds carried a trade on Binance
//    spot / OKX spot / OKX perp when measured live. A second with no trade has
//    no new information; its close is the last one carried forward. Correlate
//    that and the thinner venue always appears to "follow" the busier one,
//    which is non-synchronous trading bias, not an edge. Only seconds where
//    BOTH sides actually traded are paired (see alignTradedReturns). On the
//    live sample this was the difference between 91 honest paired seconds and
//    299 contaminated ones, and it moved the apparent best off-zero
//    correlation materially.
//
// 2. Clock skew imitating the effect exactly. If OKX stamps a trade half a
//    second later than Binance, every OKX series "lags" by construction. There
//    is no way to fully remove this from public kline timestamps, so instead it
//    is made visible: synchronised venues correlate most strongly at lag 0
//    (confirmed live, peak exactly at k = 0 for all three pairs), so a window
//    whose peak sits elsewhere has its clocks in doubt and is recorded with
//    peakAtZero = false. Each venue's own server clock is sampled every run and
//    stored beside the observation, so a lag smaller than the measured skew can
//    never be read as an economic result.
//
// 3. Multiple comparisons. This is the big one, and it is not hypothetical.
//    A single unguarded pass over 3 assets x 5 horizons on live data produced
//    "ETH basis predicts spot 10s ahead, corr 0.59" — while BTC came out
//    negative at 2s and SOL positive at 1s. Fifteen tests, inconsistent signs,
//    one impressive-looking number: that is what searching does, not what an
//    edge looks like. Every family here is therefore Bonferroni-corrected
//    across its FULL width (symbols x pairs x lags, computed at runtime and
//    recorded in tests_in_family), a candidate must additionally hold the same
//    sign independently in both chronological halves of the observation
//    history, and only then does it enter the registry as `provisional`.
//
// ---------------------------------------------------------------------------
// WHY THIS CANNOT REACH THE BOT ON ITS OWN
//
// `provisional` is in-sample by construction — it was found in the data used
// to find it. Promotion to `confirmed` requires the cell to hold on windows
// recorded strictly AFTER discovered_at, which is the one test a search cannot
// fake. That is the existing research_registry lifecycle (migrations/0006) and
// it is reused verbatim rather than reinvented.
//
// Separately, and independently of statistics, there is the economics. At
// 1-second horizons these assets move on the order of a basis point; a futures
// round trip costs an order of magnitude more. Leverage does NOT change this:
// it multiplies the edge and the cost by the same number, so a signal that
// loses money at 1x loses it faster at 10x. Every candidate therefore carries
// edge_bps — the actual expected follower move in basis points, conditional on
// the leader having moved — and gets trade_decision = 'confirmed' only if that
// clears the configured round-trip cost. A cell can perfectly well end up
// statistically confirmed and economically abstain; that is a real and likely
// outcome here, and the schema is built to say it out loud.
//
// Required env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID
// Optional env: FCS_FUTURES_ROUND_TRIP_COST_PCT (default below), NTFY_TOPIC
import { pearsonCorr, chronologicalHalfSplit, RELIABILITY_SIGNIFICANCE_Z, FAVORITE_SYMBOLS } from '../worker.js';
import { d1, d1Batch } from './d1-client.mjs';

// Bumped only when a change would make new rows incomparable with old ones.
// The pooled test filters on it, so old observations are retired rather than
// silently mixed with differently-measured new ones.
export const METHOD_VERSION = 'microstructure-v1';

// OKX caps candle requests at 300, which is the binding constraint on window
// length (Binance allows 1000). 300 one-second bars is a five-minute window.
export const WINDOW_SECONDS = 300;
// +/- 5 seconds. The live profile was flat past ~2s in every pair, and each
// extra lag widens the family the Bonferroni correction has to cover, so
// buying reach here is paid for in significance everywhere.
export const MAX_LAG_SECONDS = 5;
// Forward horizons for the basis family, in seconds. "A few seconds or
// minutes", per the request — 60s is the minute end of that.
export const BASIS_HORIZONS_SECONDS = [1, 2, 5, 10, 30, 60];
// A window this thin cannot support a correlation worth recording. Distinct
// from the significance test — this is just "do not bother".
export const MIN_PAIRED_SECONDS = 30;
// The same floor applied PER CELL, which is not the same thing and matters
// more. A window can clear MIN_PAIRED_SECONDS overall and still leave a
// particular lag with a handful of pairs, because a row only contributes to
// lag k if a partner exists k seconds away — and gaps are the norm here once
// untraded seconds are removed. Left unguarded this biases the archive in the
// worst possible direction: correlation noise scales as 1/sqrt(n), so the
// thinnest cells produce the most spectacular numbers, and those are exactly
// the ones that would get recorded and reported. Seen live on the first dry
// run — HYPE at lag 1s came back with corr 0.842 off twelve pairs, alongside
// a 36-pair BTC cell at 0.561. The first number is not better evidence than
// the second; it is less.
export const MIN_CELL_PAIRS = 30;
// Below this share of seconds actually trading, the series is too sparse for
// the both-traded filter to leave anything meaningful behind.
export const MIN_TRADED_FRACTION = 0.15;
// All-in round trip on a futures scalp, percent. Taker/taker on the venues
// reachable here runs ~0.1%; the default is deliberately not optimistic.
export const DEFAULT_FUTURES_ROUND_TRIP_COST_PCT = 0.10;
// A window must overlap the previous one by nothing at all. Overlapping
// windows are not independent observations — the exact error the v7 model
// contract was written to eliminate.
export const MIN_WINDOW_GAP_SECONDS = 0;

// ---------------------------------------------------------------------------
// VENUES
//
// Only what is actually reachable from this project's infrastructure, verified
// 2026-09-05. Binance's futures API (fapi.binance.com) answers HTTP 451 from
// here and has no data-mirror equivalent — data-api.binance.vision serves spot
// only — and Bybit's CloudFront distribution blocks this country outright. OKX
// answers for both spot and swap, which is what makes the same-venue
// perp-vs-spot comparison possible at all; it is not a second-choice venue
// here, it is the only one that can answer the question the user actually
// asked.
export const SERIES = Object.freeze([
  { id: 'binance:spot', venue: 'binance', kind: 'spot' },
  { id: 'okx:spot', venue: 'okx', kind: 'spot' },
  { id: 'okx:perp', venue: 'okx', kind: 'perp' }
]);

// Ordered pairs, read as "leader -> follower". Both directions are covered by
// the lag profile itself (k > 0 vs k < 0), so each unordered pair appears once.
export const PAIRS = Object.freeze([
  { leader: 'okx:perp', follower: 'okx:spot', note: 'same venue, perp vs spot' },
  { leader: 'binance:spot', follower: 'okx:spot', note: 'cross-venue, spot vs spot' },
  { leader: 'binance:spot', follower: 'okx:perp', note: 'cross-venue, spot vs perp' }
]);

// ---------------------------------------------------------------------------
// STATISTICS

// Inverse standard-normal CDF (Acklam's rational approximation, |error| <
// 1.15e-9). Needed because the Bonferroni bar here depends on family size,
// which depends on how many symbols and venues answered on a given run — so
// unlike correlation-research.mjs' fixed TOD_SENTIMENT_BONFERRONI_Z, it cannot
// be a constant computed once by hand.
export function normalInvCdf(p) {
  if (!(p > 0 && p < 1)) return null;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pLow = 0.02425, pHigh = 1 - pLow;
  let q, r;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > pHigh) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5; r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// Two-tailed z bar for `familySize` simultaneous tests at overall alpha.
// Bonferroni rather than anything less conservative on purpose: the families
// here are small enough that the extra strictness costs little, and the whole
// reason this module exists is that an uncorrected scan over this exact search
// space already produced a convincing-looking false positive.
export function bonferroniZ(familySize, overallAlpha = 0.01) {
  const k = Math.max(1, Math.floor(familySize || 1));
  const per = overallAlpha / k;
  const z = normalInvCdf(1 - per / 2);
  // Never weaker than the project-wide bar, whatever the family size.
  return z == null ? RELIABILITY_SIGNIFICANCE_Z : Math.max(z, RELIABILITY_SIGNIFICANCE_Z);
}

// Is there enough spread here to divide by, or is what remains just the
// arithmetic's own rounding error?
//
// `sd > 0` is not the test it looks like. Three copies of 0.2 do not sum to
// exactly 0.6 in binary floating point, so their standard deviation comes out
// at 3.4e-17 rather than zero — and a mean of 0.2 divided by that yields
// z = 1.0e16, which clears every significance bar ever written. A degenerate
// sample is thus the single cheapest way to manufacture a finding, and it
// arises naturally here: a pegged basis, a venue that quotes a fixed multiple
// of another, a window where nothing moved.
//
// The bar is relative because the values are: rounding noise in a sample of
// magnitude M lands near M * 2^-52 (~2.2e-16), so anything below M * 1e-12 is
// noise with four orders of magnitude to spare. Real effects here are nowhere
// near it — a genuine correlation series has sd/scale around 0.1.
export function hasRealSpread(values, sd) {
  if (!(sd > 0)) return false;
  const scale = Math.max(...values.map((v) => Math.abs(v)), 0);
  if (!(scale > 0)) return false;
  return sd > scale * 1e-12;
}

// One-sample test of "is the mean of these per-window correlations non-zero".
// Each value is one window's measurement of one cell, and windows do not
// overlap, so they are independent in the way 1-second returns inside a window
// emphatically are not — which is exactly why the pooled test is run over
// window summaries rather than over pooled ticks.
export function meanZTest(values) {
  const xs = (values || []).filter((v) => Number.isFinite(v));
  const n = xs.length;
  if (n < 2) return { n, mean: null, sd: null, z: null };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(variance);
  if (!hasRealSpread(xs, sd)) return { n, mean, sd, z: null };
  return { n, mean, sd, z: mean / (sd / Math.sqrt(n)) };
}

// ---------------------------------------------------------------------------
// WINDOW MATHS

// Pairs two second-indexed series into aligned one-second returns, keeping a
// second ONLY when it is contiguous with the one before it on both sides and
// both sides actually traded in it. See this file's header, hazard 1: without
// the traded test this function would manufacture the very effect it is meant
// to detect.
export function alignTradedReturns(leaderBars, followerBars) {
  const secs = [...leaderBars.keys()].filter((s) => followerBars.has(s)).sort((a, b) => a - b);
  const rows = [];
  for (let i = 1; i < secs.length; i++) {
    if (secs[i] !== secs[i - 1] + 1) continue;
    const a0 = leaderBars.get(secs[i - 1]), a1 = leaderBars.get(secs[i]);
    const b0 = followerBars.get(secs[i - 1]), b1 = followerBars.get(secs[i]);
    if (!(a1.vol > 0 && b1.vol > 0)) continue;
    if (!(a0.close > 0 && b0.close > 0)) continue;
    rows.push({ sec: secs[i], leaderRet: a1.close / a0.close - 1, followerRet: b1.close / b0.close - 1 });
  }
  return rows;
}

// The lag profile for one pair in one window, plus the two diagnostics that
// decide whether it can be believed at all.
export function lagProfile(rows, maxLag = MAX_LAG_SECONDS) {
  const byLeaderSec = new Map(rows.map((r) => [r.sec, r]));
  const cells = [];
  for (let k = -maxLag; k <= maxLag; k++) {
    const xs = [], ys = [];
    for (const r of rows) {
      const f = byLeaderSec.get(r.sec + k);
      if (f) { xs.push(r.leaderRet); ys.push(f.followerRet); }
    }
    const corr = pearsonCorr(xs, ys);
    // Recorded only with enough pairs behind it to mean anything — see
    // MIN_CELL_PAIRS. The lag-0 cell is exempt because it is not evidence, it
    // is the clock diagnostic, and suppressing it would silently turn a thin
    // window into a "peak is off zero" verdict.
    if (corr != null && (k === 0 || xs.length >= MIN_CELL_PAIRS)) cells.push({ lag: k, corr, n: xs.length });
  }
  const zero = cells.find((c) => c.lag === 0) || null;
  // Clock-alignment diagnostic, per hazard 2: synchronised venues peak at 0.
  const peak = cells.reduce((m, c) => (m == null || Math.abs(c.corr) > Math.abs(m.corr) ? c : m), null);
  return {
    cells,
    lag0Corr: zero ? zero.corr : null,
    peakAtZero: peak != null && peak.lag === 0
  };
}

// The economic half. A correlation cannot be compared with a fee; this can.
//
// Conditional on the leader having made a move worth reacting to (its own
// in-window standard deviation, so the threshold adapts to the asset rather
// than assuming a scale), what does the follower do `lag` seconds later, in
// the leader's direction, measured in basis points? That number is directly
// comparable with a round-trip cost — and is what makes it possible to say
// "real, but not worth trading", which at these horizons is the likely answer.
export function directionalEdgeBps(rows, lag, sdMultiple = 1) {
  const byLeaderSec = new Map(rows.map((r) => [r.sec, r]));
  const leaderRets = rows.map((r) => r.leaderRet);
  if (leaderRets.length < MIN_PAIRED_SECONDS) return { edgeBps: null, n: 0 };
  const mean = leaderRets.reduce((a, b) => a + b, 0) / leaderRets.length;
  const sd = Math.sqrt(leaderRets.reduce((a, b) => a + (b - mean) ** 2, 0) / leaderRets.length);
  if (!(sd > 0)) return { edgeBps: null, n: 0 };
  const threshold = sd * sdMultiple;
  const signed = [];
  for (const r of rows) {
    if (Math.abs(r.leaderRet) < threshold) continue;
    const f = byLeaderSec.get(r.sec + lag);
    if (!f) continue;
    // Signed by the leader's direction: a follower that moves the same way is
    // a positive edge, the opposite way a negative one.
    signed.push(Math.sign(r.leaderRet) * f.followerRet * 1e4);
  }
  if (signed.length < 5) return { edgeBps: null, n: signed.length };
  return { edgeBps: signed.reduce((a, b) => a + b, 0) / signed.length, n: signed.length };
}

// Basis family. z-scored within the window (see header): the level is ~99%
// constant offset, so testing it raw would mostly test a constant.
export function basisProfile(spotBars, perpBars, horizons = BASIS_HORIZONS_SECONDS) {
  const secs = [...spotBars.keys()].filter((s) => perpBars.has(s)).sort((a, b) => a - b);
  const rows = [];
  for (const s of secs) {
    const sp = spotBars.get(s), pp = perpBars.get(s);
    if (!(sp.vol > 0 && pp.vol > 0)) continue;
    if (!(sp.close > 0 && pp.close > 0)) continue;
    rows.push({ sec: s, basisBps: (pp.close / sp.close - 1) * 1e4, spot: sp.close });
  }
  if (rows.length < MIN_PAIRED_SECONDS) return { cells: [], rows: rows.length };
  const bs = rows.map((r) => r.basisBps);
  const mean = bs.reduce((a, b) => a + b, 0) / bs.length;
  const sd = Math.sqrt(bs.reduce((a, b) => a + (b - mean) ** 2, 0) / bs.length);
  // A basis that does not actually vary carries no information, and z-scoring
  // it would divide real forward returns by rounding error — see hasRealSpread.
  // This is not a hypothetical shape for a perp: a venue quoting a fixed
  // multiple of spot, or a dead-quiet window, produces exactly it.
  if (!hasRealSpread(bs, sd)) return { cells: [], rows: rows.length };
  const byS = new Map(rows.map((r) => [r.sec, r]));
  const cells = [];
  for (const N of horizons) {
    const xs = [], ys = [];
    for (const r of rows) {
      const f = byS.get(r.sec + N);
      if (!f) continue;
      xs.push((r.basisBps - mean) / sd);
      ys.push((f.spot / r.spot - 1) * 1e4);
    }
    const corr = pearsonCorr(xs, ys);
    if (corr == null || xs.length < MIN_CELL_PAIRS) continue;
    // Edge for this family: mean forward move in bps when the basis is
    // stretched at least one in-window sd, signed by the basis' direction.
    const stretched = [];
    for (const r of rows) {
      const z = (r.basisBps - mean) / sd;
      if (Math.abs(z) < 1) continue;
      const f = byS.get(r.sec + N);
      if (!f) continue;
      stretched.push(Math.sign(z) * (f.spot / r.spot - 1) * 1e4);
    }
    cells.push({
      lag: N,
      corr,
      n: xs.length,
      edgeBps: stretched.length >= 5 ? stretched.reduce((a, b) => a + b, 0) / stretched.length : null,
      edgeN: stretched.length
    });
  }
  return { cells, rows: rows.length };
}

// ---------------------------------------------------------------------------
// POOLED EVALUATION ACROSS WINDOWS
//
// The only place a hypothesis is judged. Takes every stored observation of one
// cell, in chronological order, and applies the same two guardrails
// correlation-research.mjs applies to its own families — a family-corrected
// pooled bar, then an independent same-signed result in both chronological
// halves — before anything is called a candidate.
export function evaluateCell(observations, familySize, options = {}) {
  const { requirePeakAtZero = true } = options;
  const usable = (observations || [])
    .filter((o) => Number.isFinite(o.corr))
    .filter((o) => !requirePeakAtZero || o.peakAtZero)
    .slice()
    .sort((a, b) => String(a.observedAt).localeCompare(String(b.observedAt)));
  const zBar = bonferroniZ(familySize);
  const pooled = meanZTest(usable.map((o) => o.corr));
  if (pooled.z == null || Math.abs(pooled.z) < zBar) {
    return { verdict: 'no-effect', pooled, zBar, windows: usable.length };
  }
  // Same chronological-half discipline as runGuardedTest, keyed on the window
  // timestamps rather than trading dates.
  const { firstHalf, secondHalf } = chronologicalHalfSplit(usable.map((o) => o.observedAt));
  const first = meanZTest(usable.filter((o) => firstHalf.has(o.observedAt)).map((o) => o.corr));
  const second = meanZTest(usable.filter((o) => secondHalf.has(o.observedAt)).map((o) => o.corr));
  const firstOk = first.z != null && Math.abs(first.z) >= RELIABILITY_SIGNIFICANCE_Z;
  const secondOk = second.z != null && Math.abs(second.z) >= RELIABILITY_SIGNIFICANCE_Z;
  const sameSign = first.mean != null && second.mean != null && Math.sign(first.mean) === Math.sign(second.mean);
  if (!firstOk || !secondOk || !sameSign) {
    return { verdict: 'unstable', pooled, first, second, zBar, windows: usable.length };
  }
  const edges = usable.map((o) => o.edgeBps).filter(Number.isFinite);
  const medianEdge = edges.length ? edges.slice().sort((a, b) => a - b)[Math.floor(edges.length / 2)] : null;
  return {
    verdict: 'candidate',
    pooled, first, second, zBar,
    windows: usable.length,
    medianEdgeBps: medianEdge
  };
}

// Statistically real is not the same as worth trading, and at these horizons
// the two answers routinely disagree. Kept as its own decision so the registry
// can record "confirmed, but abstain on cost" rather than flattening it.
export function tradeDecisionForEdge(medianEdgeBps, roundTripCostPct) {
  if (!Number.isFinite(medianEdgeBps)) return { decision: 'abstain', reason: 'no-measured-edge' };
  const costBps = Math.abs(roundTripCostPct) * 100;
  if (Math.abs(medianEdgeBps) <= costBps) {
    return { decision: 'abstain', reason: `edge ${medianEdgeBps.toFixed(2)}bps does not clear ${costBps.toFixed(2)}bps round-trip cost` };
  }
  return { decision: 'eligible', reason: `edge ${medianEdgeBps.toFixed(2)}bps clears ${costBps.toFixed(2)}bps round-trip cost` };
}

// Reused verbatim from discovery.mjs' lifecycle, so both research lanes age a
// finding the same way. A pattern that quietly stops working is the dangerous
// case, which is why 'contradicted' demotes even a previously confirmed cell.
export function nextStatus(verdict, current) {
  if (verdict === 'contradicted') return 'decayed';
  if (verdict === 'held' && current === 'provisional') return 'confirmed';
  return current;
}

export function cellKey({ symbol, family, leader, follower, lag }) {
  return `micro:${family}:${symbol}:${leader}>${follower}:lag${lag}`;
}

// ---------------------------------------------------------------------------
// COLLECTION

const FETCH_TIMEOUT_MS = 15000;

async function fetchJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'frontiercapitalsignals-microstructure/1' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url.slice(0, 90)}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// Both collectors return Map<epochSeconds, { close, vol }> so the maths above
// never has to know which venue it is looking at.
export async function fetchBinanceSpotSeconds(symbol, limit = WINDOW_SECONDS) {
  const rows = await fetchJson(`https://data-api.binance.vision/api/v3/klines?symbol=${encodeURIComponent(symbol)}USDT&interval=1s&limit=${limit}`);
  const out = new Map();
  for (const b of Array.isArray(rows) ? rows : []) {
    const close = Number(b[4]), vol = Number(b[5]);
    if (Number.isFinite(close) && close > 0) out.set(Math.floor(Number(b[0]) / 1000), { close, vol: Number.isFinite(vol) ? vol : 0 });
  }
  return out;
}

export async function fetchOkxSeconds(instId, limit = WINDOW_SECONDS) {
  const body = await fetchJson(`https://www.okx.com/api/v5/market/candles?instId=${encodeURIComponent(instId)}&bar=1s&limit=${limit}`);
  if (!body || body.code !== '0') throw new Error(`OKX error ${body && body.code}: ${body && body.msg}`);
  const out = new Map();
  for (const c of (body.data || [])) {
    const close = Number(c[4]), vol = Number(c[5]);
    if (Number.isFinite(close) && close > 0) out.set(Math.floor(Number(c[0]) / 1000), { close, vol: Number.isFinite(vol) ? vol : 0 });
  }
  return out;
}

// Each venue's own clock against ours, so hazard 2 is a recorded number rather
// than an assumption. Sampled once per run; a failure is not fatal (the
// peak-at-zero diagnostic is the real defence) but is stored as null so the
// gap is visible.
export async function measureClockSkewMs() {
  const out = {};
  await Promise.all([
    (async () => {
      try {
        const t0 = Date.now();
        const j = await fetchJson('https://data-api.binance.vision/api/v3/time');
        out.binance = Number(j.serverTime) - (t0 + Date.now()) / 2;
      } catch { out.binance = null; }
    })(),
    (async () => {
      try {
        const t0 = Date.now();
        const j = await fetchJson('https://www.okx.com/api/v5/public/time');
        out.okx = Number(j.data[0].ts) - (t0 + Date.now()) / 2;
      } catch { out.okx = null; }
    })()
  ]);
  return out;
}

export function tradedFraction(bars) {
  const v = [...bars.values()];
  return v.length ? v.filter((b) => b.vol > 0).length / v.length : 0;
}

// One window for one symbol: fetch every series, then produce every cell both
// families define. Returns null when the symbol cannot support a measurement,
// with the reason, rather than emitting rows that only look like data.
export async function collectSymbolWindow(symbol) {
  const [binance, okxSpot, okxPerp] = await Promise.allSettled([
    fetchBinanceSpotSeconds(symbol),
    fetchOkxSeconds(`${symbol}-USDT`),
    fetchOkxSeconds(`${symbol}-USDT-SWAP`)
  ]);
  const bars = {
    'binance:spot': binance.status === 'fulfilled' ? binance.value : null,
    'okx:spot': okxSpot.status === 'fulfilled' ? okxSpot.value : null,
    'okx:perp': okxPerp.status === 'fulfilled' ? okxPerp.value : null
  };
  const errors = [];
  for (const [id, r] of [['binance:spot', binance], ['okx:spot', okxSpot], ['okx:perp', okxPerp]]) {
    if (r.status === 'rejected') errors.push(`${id}: ${String(r.reason && r.reason.message || r.reason).slice(0, 120)}`);
  }
  const traded = {};
  for (const [id, m] of Object.entries(bars)) traded[id] = m ? tradedFraction(m) : null;

  const observations = [];
  for (const pair of PAIRS) {
    const L = bars[pair.leader], F = bars[pair.follower];
    if (!L || !F) continue;
    if (!(traded[pair.leader] >= MIN_TRADED_FRACTION) || !(traded[pair.follower] >= MIN_TRADED_FRACTION)) continue;
    const rows = alignTradedReturns(L, F);
    if (rows.length < MIN_PAIRED_SECONDS) continue;
    const prof = lagProfile(rows);
    for (const cell of prof.cells) {
      if (cell.lag === 0) continue; // lag 0 is "same asset", never a lead — kept only as the diagnostic
      const edge = directionalEdgeBps(rows, cell.lag);
      observations.push({
        symbol, family: 'leadlag', leader: pair.leader, follower: pair.follower,
        lag: cell.lag, corr: cell.corr, n: cell.n,
        edgeBps: edge.edgeBps, edgeN: edge.n,
        lag0Corr: prof.lag0Corr, peakAtZero: prof.peakAtZero,
        tradedLeader: traded[pair.leader], tradedFollower: traded[pair.follower]
      });
    }
  }

  // Basis is same-venue by definition; a cross-venue "premium" is mostly a
  // quoting difference and would not mean what the name implies.
  if (bars['okx:spot'] && bars['okx:perp']
    && traded['okx:spot'] >= MIN_TRADED_FRACTION && traded['okx:perp'] >= MIN_TRADED_FRACTION) {
    const basis = basisProfile(bars['okx:spot'], bars['okx:perp']);
    for (const cell of basis.cells) {
      observations.push({
        symbol, family: 'basis', leader: 'okx:perp', follower: 'okx:spot',
        lag: cell.lag, corr: cell.corr, n: cell.n,
        edgeBps: cell.edgeBps, edgeN: cell.edgeN,
        lag0Corr: null, peakAtZero: true, // no lag-profile symmetry to check for a forward-return test
        tradedLeader: traded['okx:perp'], tradedFollower: traded['okx:spot']
      });
    }
  }

  const allSecs = Object.values(bars).filter(Boolean).flatMap((m) => [...m.keys()]);
  return {
    symbol,
    observations,
    errors,
    traded,
    windowStartSec: allSecs.length ? Math.min(...allSecs) : null,
    windowEndSec: allSecs.length ? Math.max(...allSecs) : null
  };
}

// ---------------------------------------------------------------------------
// PERSISTENCE

export function dbNumber(v) { return Number.isFinite(v) ? v : null; }

// Windows must not overlap: two overlapping windows share seconds, so counting
// them as two observations double-counts the same evidence — the v6 defect
// this project already paid for once. Cheap to enforce, impossible to undo
// after the fact.
export function windowOverlaps(previousEndIso, windowStartIso) {
  if (!previousEndIso) return false;
  return new Date(windowStartIso).getTime() <= new Date(previousEndIso).getTime();
}

export async function lastWindowEnd(env) {
  const rows = await d1(env, 'SELECT window_end FROM microstructure_observations ORDER BY window_end DESC LIMIT 1');
  return rows.length ? rows[0].window_end : null;
}

export async function writeObservations(env, windowId, nowIso, startIso, endIso, observations, clockSkew) {
  if (!observations.length) return 0;
  const stmts = observations.map((o) => ({
    sql: `INSERT OR REPLACE INTO microstructure_observations
      (window_id, observed_at, window_start, window_end, symbol, family, leader, follower, lag_seconds,
       corr, n, edge_bps, edge_n, lag0_corr, peak_at_zero, traded_frac_leader, traded_frac_follower,
       clock_skew_ms, method_version)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    params: [
      windowId, nowIso, startIso, endIso, o.symbol, o.family, o.leader, o.follower, o.lag,
      dbNumber(o.corr), o.n, dbNumber(o.edgeBps), o.edgeN ?? null, dbNumber(o.lag0Corr),
      o.peakAtZero ? 1 : 0, dbNumber(o.tradedLeader), dbNumber(o.tradedFollower),
      dbNumber(clockSkew), METHOD_VERSION
    ]
  }));
  // Chunked: D1 batches are transactional, and one run's ~245 rows comfortably
  // exceed what belongs in a single statement list.
  for (let i = 0; i < stmts.length; i += 50) await d1Batch(env, stmts.slice(i, i + 50));
  return stmts.length;
}

// Every distinct cell that has ever been observed under the current method
// version. The family size the Bonferroni bar needs is exactly this count,
// per family — measured, not assumed, which is the point of recording
// tests_in_family at all.
export async function loadCells(env) {
  return d1(env, `SELECT symbol, family, leader, follower, lag_seconds AS lag, COUNT(*) AS windows
    FROM microstructure_observations WHERE method_version = ?
    GROUP BY symbol, family, leader, follower, lag_seconds
    HAVING COUNT(*) >= 2`, [METHOD_VERSION]);
}

export async function loadCellObservations(env, cell) {
  const rows = await d1(env, `SELECT observed_at, corr, edge_bps, peak_at_zero, n
    FROM microstructure_observations
    WHERE method_version = ? AND symbol = ? AND family = ? AND leader = ? AND follower = ? AND lag_seconds = ?
    ORDER BY observed_at`, [METHOD_VERSION, cell.symbol, cell.family, cell.leader, cell.follower, cell.lag]);
  return rows.map((r) => ({
    observedAt: r.observed_at,
    corr: r.corr,
    edgeBps: r.edge_bps,
    peakAtZero: r.peak_at_zero === 1,
    n: r.n
  }));
}

// ---------------------------------------------------------------------------
// MAIN

async function notify(title, body, priority = 'default') {
  if (!process.env.NTFY_TOPIC) return false;
  try {
    const res = await fetch(`https://ntfy.sh/${process.env.NTFY_TOPIC}`, {
      method: 'POST', headers: { Title: title, Priority: priority, Tags: 'microscope' }, body
    });
    return res.ok;
  } catch (e) {
    console.error('microstructure notify failed:', e.message);
    return false;
  }
}

async function main() {
  const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID } = process.env;
  for (const [name, v] of Object.entries({ CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID })) {
    if (!v) { console.error(`Missing required env var: ${name}`); process.exit(1); }
  }
  const env = { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID };
  const costPct = Number(process.env.FCS_FUTURES_ROUND_TRIP_COST_PCT) > 0
    ? Number(process.env.FCS_FUTURES_ROUND_TRIP_COST_PCT)
    : DEFAULT_FUTURES_ROUND_TRIP_COST_PCT;

  const startedAt = new Date().toISOString();
  const windowId = `w-${Date.now()}`;
  console.log(`[microstructure] ${METHOD_VERSION} window ${windowId}, round-trip cost assumption ${costPct}%`);

  const clock = await measureClockSkewMs();
  console.log(`[microstructure] clock skew vs local: binance=${clock.binance == null ? 'n/a' : Math.round(clock.binance) + 'ms'} okx=${clock.okx == null ? 'n/a' : Math.round(clock.okx) + 'ms'}`);

  // --- collect -------------------------------------------------------------
  const symbols = [...FAVORITE_SYMBOLS];
  const collected = [];
  const allErrors = [];
  for (const sym of symbols) {
    try {
      const r = await collectSymbolWindow(sym);
      if (r.errors.length) allErrors.push(`${sym} -> ${r.errors.join('; ')}`);
      collected.push(r);
      console.log(`[microstructure] ${sym}: ${r.observations.length} cells, traded fractions ` +
        Object.entries(r.traded).map(([k, v]) => `${k}=${v == null ? 'n/a' : (100 * v).toFixed(0) + '%'}`).join(' '));
    } catch (e) {
      allErrors.push(`${sym} -> ${e.message}`);
      console.error(`[microstructure] ${sym} failed: ${e.message}`);
    }
  }

  const observations = collected.flatMap((c) => c.observations);
  const secs = collected.flatMap((c) => [c.windowStartSec, c.windowEndSec]).filter(Number.isFinite);
  const startIso = secs.length ? new Date(Math.min(...secs) * 1000).toISOString() : startedAt;
  const endIso = secs.length ? new Date(Math.max(...secs) * 1000).toISOString() : startedAt;

  let written = 0;
  let skipped = null;
  const prevEnd = await lastWindowEnd(env);
  if (windowOverlaps(prevEnd, startIso)) {
    skipped = `window overlaps the previous one (previous ended ${prevEnd}, this starts ${startIso}) — not an independent observation`;
    console.log(`[microstructure] SKIPPED: ${skipped}`);
  } else if (!observations.length) {
    skipped = 'no usable cells this window';
    console.log('[microstructure] no usable cells this window');
  } else {
    const skew = Number.isFinite(clock.okx) && Number.isFinite(clock.binance) ? clock.okx - clock.binance : null;
    written = await writeObservations(env, windowId, startedAt, startIso, endIso, observations, skew);
    console.log(`[microstructure] wrote ${written} observations`);
  }

  await d1(env, `INSERT OR REPLACE INTO microstructure_runs
    (window_id, started_at, finished_at, window_start, window_end, symbols_requested, symbols_usable,
     observations, skipped_reason, venue_errors, method_version)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  [windowId, startedAt, new Date().toISOString(), startIso, endIso, symbols.length,
    collected.filter((c) => c.observations.length).length, written, skipped,
    allErrors.length ? allErrors.join(' | ').slice(0, 900) : null, METHOD_VERSION]);

  // --- evaluate ------------------------------------------------------------
  const cells = await loadCells(env);
  if (!cells.length) {
    console.log('[microstructure] no cell has two independent windows yet — nothing to test');
    return;
  }
  // Family size is the full width of the search, per family: every cell that
  // was looked at, not just the one being reported. This is the number that
  // makes the correction auditable after the fact.
  const familySizes = {};
  for (const c of cells) familySizes[c.family] = (familySizes[c.family] || 0) + 1;
  console.log(`[microstructure] families: ${Object.entries(familySizes).map(([f, n]) => `${f}=${n} cells (z bar ${bonferroniZ(n).toFixed(3)})`).join(', ')}`);

  const nowIso = new Date().toISOString();
  const existing = new Map((await d1(env, `SELECT hypothesis, status, discovered_at, discovery_effect, oos_checks
    FROM research_registry WHERE family LIKE 'microstructure%'`)).map((r) => [r.hypothesis, r]));

  let candidates = 0, promoted = 0, decayed = 0;
  for (const cell of cells) {
    const key = cellKey(cell);
    const obs = await loadCellObservations(env, cell);
    const prior = existing.get(key);
    const result = evaluateCell(obs, familySizes[cell.family]);

    if (result.verdict !== 'candidate') {
      // A previously-recorded finding that no longer clears its own bar has
      // stopped working, which is the case worth telling someone about.
      if (prior && prior.status !== 'decayed') {
        await d1(env, `UPDATE research_registry SET status='decayed', status_changed_at=?, last_checked_at=?,
          notes=? WHERE hypothesis=?`, [nowIso, nowIso, `no longer clears its family-corrected bar (${result.verdict})`, key]);
        await d1(env, `UPDATE microstructure_findings SET trade_decision='abstain', decision_reason=?, updated_at=? WHERE hypothesis=?`,
          ['pattern decayed', nowIso, key]);
        decayed++;
        await notify('Microstructure pattern decayed', `${key} stopped clearing its bar (${result.verdict}). It is no longer trusted.`, 'high');
      } else if (prior) {
        await d1(env, 'UPDATE research_registry SET last_checked_at=? WHERE hypothesis=?', [nowIso, key]);
      }
      continue;
    }

    candidates++;
    const edge = tradeDecisionForEdge(result.medianEdgeBps, costPct);
    if (!prior) {
      await d1(env, `INSERT INTO research_registry
        (hypothesis, family, asset_class, symbol, horizon_days, status, discovered_at, discovery_n,
         discovery_effect, discovery_z, tests_in_family, last_checked_at, status_changed_at, notes)
        VALUES (?,?,?,?,?, 'provisional', ?,?,?,?,?,?,?,?)`,
      [key, `microstructure:${cell.family}`, 'crypto', cell.symbol, 0, nowIso, result.windows,
        result.pooled.mean, result.pooled.z, familySizes[cell.family], nowIso, nowIso,
        `${cell.leader} -> ${cell.follower} at ${cell.lag}s; ${result.verdict}; ${edge.reason}`]);
      console.log(`[microstructure] NEW provisional ${key}: mean corr ${result.pooled.mean.toFixed(4)}, z ${result.pooled.z.toFixed(2)} (bar ${result.zBar.toFixed(2)}), ${result.windows} windows, ${edge.reason}`);
    } else {
      // Out-of-sample is simply the windows recorded after discovery — data
      // that did not exist when the pattern was found, and the one test a
      // search over this space cannot fake.
      const oos = obs.filter((o) => o.observedAt > prior.discovered_at && o.peakAtZero);
      const oosTest = meanZTest(oos.map((o) => o.corr));
      const held = oosTest.z != null
        && Math.abs(oosTest.z) >= RELIABILITY_SIGNIFICANCE_Z
        && Math.sign(oosTest.mean) === Math.sign(prior.discovery_effect);
      const contradicted = oosTest.z != null
        && Math.abs(oosTest.z) >= RELIABILITY_SIGNIFICANCE_Z
        && Math.sign(oosTest.mean) !== Math.sign(prior.discovery_effect);
      const verdict = contradicted ? 'contradicted' : held ? 'held' : 'insufficient';
      const status = nextStatus(verdict, prior.status);
      await d1(env, `UPDATE research_registry SET status=?, oos_n=?, oos_effect=?, oos_z=?, oos_checks=oos_checks+1,
        last_checked_at=?, status_changed_at=CASE WHEN ?<>status THEN ? ELSE status_changed_at END, notes=?
        WHERE hypothesis=?`,
      [status, oosTest.n, dbNumber(oosTest.mean), dbNumber(oosTest.z), nowIso, status, nowIso,
        `oos ${verdict} on ${oosTest.n} post-discovery windows; ${edge.reason}`, key]);
      if (status === 'confirmed' && prior.status !== 'confirmed') {
        promoted++;
        await notify('Microstructure pattern CONFIRMED out-of-sample',
          `${key}\nmean corr ${result.pooled.mean.toFixed(4)} (z ${result.pooled.z.toFixed(2)}, bar ${result.zBar.toFixed(2)})\n` +
          `held on ${oosTest.n} post-discovery windows\n${edge.reason}\n` +
          `Trade decision: ${edge.decision.toUpperCase()} — this does NOT authorize the futures bot on its own.`, 'high');
      }
      if (status === 'decayed' && prior.status !== 'decayed') decayed++;
      console.log(`[microstructure] ${key}: ${prior.status} -> ${status} (oos ${verdict}, n=${oosTest.n}), ${edge.reason}`);
    }

    await d1(env, `INSERT OR REPLACE INTO microstructure_findings
      (hypothesis, symbol, family, leader, follower, lag_seconds, windows, mean_corr, pooled_z, z_bar,
       tests_in_family, median_edge_bps, assumed_round_trip_cost_pct, trade_decision, decision_reason, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [key, cell.symbol, cell.family, cell.leader, cell.follower, cell.lag, result.windows,
      dbNumber(result.pooled.mean), dbNumber(result.pooled.z), dbNumber(result.zBar),
      familySizes[cell.family], dbNumber(result.medianEdgeBps), costPct, edge.decision, edge.reason, nowIso]);
  }

  console.log(`[microstructure] evaluated ${cells.length} cells: ${candidates} clear their family-corrected bar, ${promoted} newly confirmed out-of-sample, ${decayed} decayed`);
  if (!candidates) {
    console.log('[microstructure] NO cross-venue or perp-vs-spot lead/lag survives correction. That is a complete result, not a failure: these venues are arbitraged to within a second of each other.');
  }
}

// Importable for tests without running a collection pass.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('microstructure run failed:', e); process.exit(1); });
}
