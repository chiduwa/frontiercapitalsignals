// Cross-sectional expected-return lane: coefficient fitting, forecast logging,
// maturity scoring, and the economic-edge evidence the publication gate reads.
//
// WHY THIS EXISTS
//
// The production confluence model scores each asset against absolute constants
// ("RSI >= 70 is bearish") with hand-assigned weights. Over the first 9,524
// independent outcomes of the v7 ledger it scored below its own no-skill
// baseline in both asset classes, and its bearish calls carried a HIGHER mean
// forward return than its bullish ones. Two of its hard-coded rules were
// measured against this project's own 8-year daily archive and found inverted
// (see the deletion note in worker.js's confluence()).
//
// The failure is structural, not a matter of tuning. Three things were wrong:
//
//   1. Absolute thresholds. A constant cannot mean the same thing in a bull
//      and a bear tape. Peer rank can.
//   2. Hard-coded signs. A rule file cannot notice that it has become
//      backwards. A rolling regression can, and does so without anyone
//      editing anything.
//   3. Direction as the target. On our archive the top cross-sectional
//      momentum quintile earned +2.11%/week against a +1.26% universe mean
//      while its hit rate, 46%, matched every other quintile's. The edge is
//      entirely in magnitude. A direction-accuracy scoreboard is blind to it.
//
// This module fixes all three, and reuses data the hourly build has already
// paid for: it reads asset_daily_bars and nothing else. No new supplier, no
// new API budget, no new rate limit. The fit is a few seconds of arithmetic
// in the daily GitHub Actions job.
//
// WHAT IS DELIBERATELY NOT CLAIMED
//
// The design follows Fieberg, Liedtke, Poddig, Walker & Zaremba (JFQA 2025),
// whose long-short factor reports ~3.9%/week gross. That magnitude is NOT
// reproduced here and is not the basis for anything below. Their sample runs
// 2015-2022, includes micro-caps, and depends on a short leg that our own
// archive shows losing money in 2018, 2022 and 2024. What replicated on our
// data is the shape only: top quintile over the equal-weighted universe,
// positive in 8 of 9 calendar years, ~+0.85%/week before costs. Everything in
// this file is sized for that number, not the paper's.
//
// The lane publishes nothing on its own. Forecasts are logged, matured, folded
// into decile evidence, and only then may the gate expose them.
import { d1, d1Batch, chunk } from './d1-client.mjs';
import { loadBarQuarantine } from './bar-quarantine.mjs';
import {
  XS_FEATURES, crossSectionalRanks, XS_MIN_UNIVERSE,
  rsi, macd, bollinger, stochastic, obvSlope, sma, slopePct, rangePos,
  realizedVolPct
} from '../worker.js';

export const XS_METHOD_VERSION = 'fcs-cross-sectional-v1';

// Estimation window, in weekly cross-sections.
//
// CTREND uses 52. That works with their ~3,000-coin cross-sections; it does
// not work with ours. Measured directly (a window sweep over 26/39/52/65/80
// weeks on a 60-symbol slice): no feature's |t| grew with T the way a real
// effect's must, the strongest feature changed identity at every window
// length, and rvol hit t = -3.04 at 39 weeks while sitting between -1.0 and
// -1.7 at every other length. That last one is the whole problem in one
// number — at 52 weeks this lane is underpowered enough that which feature
// "wins" is mostly which noise realisation you sampled.
//
// 156 weeks (3 years) roughly halves the Fama-MacBeth standard error against
// 52, and the archive has depth back to 2014 to pay for it. The cost is
// adaptation speed: a sign flip now takes about a year to show up in the mean.
// That is the correct trade here specifically because this lane publishes
// nothing on its own — a slow, well-estimated coefficient feeding a gate that
// demands its own separate out-of-sample evidence is strictly safer than a
// fast, noisy one.
export const XS_ESTIMATION_WEEKS = 156;
// Below this the window is too thin for a t-stat and the whole class abstains.
export const XS_MIN_ESTIMATION_WEEKS = 78;
// Bars of history each weekly observation needs before its features are
// computable at all (sma200 and the 252-bar range position are the binding
// constraints).
export const XS_WARMUP_BARS = 260;
// Family-wise error control. ~20 features are tested per class per horizon and
// the winner is kept, which is the textbook setup for manufacturing a
// significant-looking coefficient out of noise. Ranking is by construction a
// multiple-testing exercise, so the threshold is Bonferroni over the number of
// features actually tested rather than a flat 1.96.
export const XS_FAMILY_ALPHA = 0.05;
// A feature whose per-week betas agree with their own mean less often than
// this is significant because of a handful of outsized weeks, not because it
// persists. Both bars must be cleared.
export const XS_MIN_SIGN_CONSISTENCY = 0.55;

export const XS_HORIZONS_DAYS = [7, 1];

// Two-sided Bonferroni z-threshold for `tests` simultaneous tests. Inverse
// normal via Acklam's rational approximation — same approach as the
// microstructure lane, kept local so this module has no cross-lane dependency.
export function bonferroniZ(tests, familyAlpha = XS_FAMILY_ALPHA) {
  const n = Math.max(1, Math.floor(tests));
  const p = 1 - (familyAlpha / n) / 2;
  return normalInvCdf(p);
}

export function normalInvCdf(p) {
  if (!(p > 0 && p < 1)) return NaN;
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
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
         (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// ---------------------------------------------------------------------------
// Historical feature construction
// ---------------------------------------------------------------------------

// Rebuilds a metrics-shaped object from archive bars, as of bar index `i`,
// using ONLY bars[0..i]. The slicing is the whole point: every window below is
// closed at i, so a feature can never see its own future.
//
// This calls the same exported indicator functions worker.js uses at runtime,
// and the resulting object is handed to the same XS_FEATURES[].get accessors.
// That is deliberate and load-bearing: if the fitter computed its own version
// of RSI, a coefficient fitted on one definition would be applied to another
// and nothing would ever report an error. Sharing the functions makes that
// class of bug impossible rather than merely unlikely.
//
// Fields the archive cannot supply (market cap, funding, open interest) are
// left undefined. Their features then evaluate to null, never get a fitted
// coefficient, and are never selected — which is the correct outcome, not a
// silent degradation.
export function archiveMetrics(symbol, bars, i) {
  if (i < XS_WARMUP_BARS - 1 || i >= bars.length) return null;
  const window = bars.slice(0, i + 1);
  const closes = window.map((b) => b.close);
  const volumes = window.map((b) => b.volume).filter((v) => Number.isFinite(v));
  const haveVolume = volumes.length === window.length;
  const price = closes[closes.length - 1];
  if (!(price > 0)) return null;

  const pct = (nBack) => {
    const prev = closes[closes.length - 1 - nBack];
    return prev > 0 ? (price / prev - 1) * 100 : null;
  };
  const mean7d = closes.slice(-7).reduce((a, b) => a + b, 0) / 7;
  const md = macd(closes);

  return {
    symbol,
    price,
    chg24h: pct(1),
    chg7d: pct(7),
    chg30d: pct(30),
    volPct: realizedVolPct(closes, 30),
    rsi: rsi(closes),
    rangePos: rangePos(closes.slice(-252), price),
    stretch: mean7d > 0 ? ((price / mean7d) - 1) * 100 : null,
    slope: slopePct(closes, 15),
    sma50: sma(closes, 50),
    sma200: closes.length >= 200 ? sma(closes, 200) : null,
    macdHist: md && md.hist,
    bb: bollinger(closes),
    stoch: stochastic(closes),
    obv: haveVolume ? obvSlope(closes, volumes, 15) : null
    // mcap / volume / fundingPercentile / oiPercentile intentionally absent.
  };
}

// True when `to` is `days` calendar days after `from`, within a tolerance that
// absorbs a weekend or a one-off missing bar but not a real gap. Crypto trades
// every day so its bars should be exact; equities skip weekends and holidays,
// which is why the tolerance scales with the horizon rather than being flat.
export const XS_DATE_TOLERANCE_DAYS = 4;
export function spansExpectedDays(from, to, days, tolerance = XS_DATE_TOLERANCE_DAYS) {
  const a = Date.parse(`${from}T00:00:00Z`), b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const actual = (b - a) / 86400000;
  if (actual <= 0) return false;
  // A 1-day horizon over a weekend is 3 calendar days; a 7-day horizon over a
  // holiday week is 9. Both are legitimate. Twice the horizon plus the flat
  // tolerance is not.
  return actual >= days && actual <= days + tolerance + Math.floor(days * 0.4);
}

// Groups flat archive rows into per-symbol, date-ascending bar arrays.
// `quarantine` is an optional index from loadBarQuarantine (bar-quarantine.mjs,
// migration 0034). When supplied, corrupt bars are dropped and a symbol whose
// ticker was remapped keeps only the history AFTER its most recent identity
// change — otherwise every indicator here (SMA200, range position, stretch)
// would be computed across two different tokens spliced into one series.
//
// Optional rather than mandatory so this function stays usable in tests and in
// any caller that has no D1 handle; callers that fit or trade should pass it.
export function groupBars(rows, quarantine = null) {
  const bySymbol = new Map();
  for (const r of rows) {
    const close = Number(r.close);
    if (!(close > 0)) continue;
    if (quarantine && quarantine.bad.has(`${r.symbol}|${r.date}`)) continue;
    if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, []);
    bySymbol.get(r.symbol).push({ date: r.date, close, volume: Number(r.volume) });
  }
  for (const bars of bySymbol.values()) bars.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (quarantine) {
    for (const [symbol, bars] of bySymbol) {
      const boundaries = quarantine.boundaries.get(symbol);
      if (!boundaries || !boundaries.length) continue;
      const lastBoundary = boundaries[boundaries.length - 1];
      bySymbol.set(symbol, bars.filter((b) => b.date >= lastBoundary));
    }
  }
  return bySymbol;
}

// Builds the weekly cross-sections the regression runs on.
//
// Sampling is every `strideDays` bars anchored at the END of the series, so the
// most recent observation is always a complete one and the spacing between
// observations is exactly the forecast horizon. Non-overlapping sampling is
// not an optimisation here: overlapping weekly windows are the exact defect
// that inflated the v6 ledger's sample sizes, and repeating it in a new lane
// would reproduce the same false confidence with different arithmetic.
export function buildWeeklyCrossSections(barsBySymbol, horizonDays, maxWeeks = XS_ESTIMATION_WEEKS) {
  const stride = horizonDays === 1 ? 7 : horizonDays; // 1d forecasts still sampled weekly, for independence
  const sections = new Map(); // anchorDate -> [{ symbol, metrics, forward }]
  if (!barsBySymbol || !barsBySymbol.size) return [];

  // Anchors are CALENDAR dates shared by the whole universe, not per-symbol bar
  // indices. Every symbol in asset_daily_bars has gaps — BTC itself has 11
  // missing days in a 827-day window — and different symbols have different
  // ones. Walking back N bars per symbol therefore lands each one on a slightly
  // different day, so the "cross-section" for a given anchor ends up holding
  // whichever subset of symbols happened to share a gap pattern. Measured on a
  // 60-symbol validation slice, index anchoring produced cross-sections 27 wide
  // out of a possible 60. A cross-sectional rank computed over half the
  // universe is a rank against a biased sample of peers, which is exactly the
  // error this lane exists to avoid.
  let maxDate = '';
  for (const bars of barsBySymbol.values()) {
    if (bars.length && bars[bars.length - 1].date > maxDate) maxDate = bars[bars.length - 1].date;
  }
  if (!maxDate) return [];

  const lastAnchorMs = Date.parse(`${maxDate}T00:00:00Z`) - horizonDays * 86400000;
  const anchors = [];
  for (let k = 0; k < maxWeeks; k++) {
    anchors.push(new Date(lastAnchorMs - k * stride * 86400000).toISOString().slice(0, 10));
  }

  // date -> index, per symbol, so anchor lookup is O(1) rather than a scan.
  const indexBySymbol = new Map();
  for (const [symbol, bars] of barsBySymbol) {
    const idx = new Map();
    for (let i = 0; i < bars.length; i++) idx.set(bars[i].date, i);
    indexBySymbol.set(symbol, idx);
  }

  for (const [symbol, bars] of barsBySymbol) {
    if (bars.length < XS_WARMUP_BARS + horizonDays + 1) continue;
    const idx = indexBySymbol.get(symbol);
    for (const anchor of anchors) {
      // Exact-date match only. Tolerating "the nearest bar within a few days"
      // would silently stagger symbols against each other again and reintroduce
      // the very misalignment this loop was rewritten to remove; a symbol
      // missing that day simply sits this cross-section out.
      const i = idx.get(anchor);
      if (i === undefined || i < XS_WARMUP_BARS - 1) continue;

      // Forward bar located by DATE, then checked. Bar index distance is not
      // calendar distance: stepping i+horizonDays across a gap produces a
      // "7-day" return spanning weeks. Caught during validation, where one
      // symbol that redenominated across a 46-day gap produced a single
      // +120,933% observation that moved every fitted beta by two orders of
      // magnitude and flattened the whole fit to t ~= 1.0.
      const targetDate = new Date(Date.parse(`${anchor}T00:00:00Z`) + horizonDays * 86400000).toISOString().slice(0, 10);
      let j = idx.get(targetDate);
      if (j === undefined) {
        // Equities have no weekend bars, so an exact target date often does not
        // exist. Take the first bar strictly after the target and let
        // spansExpectedDays decide whether it is close enough to count.
        j = i + 1;
        while (j < bars.length && bars[j].date < targetDate) j++;
        if (j >= bars.length) continue;
      }
      if (!spansExpectedDays(bars[i].date, bars[j].date, horizonDays)) continue;

      const m = archiveMetrics(symbol, bars, i);
      if (!m) continue;
      const entry = bars[i].close, exit = bars[j].close;
      if (!(entry > 0) || !(exit > 0)) continue;
      if (!sections.has(anchor)) sections.set(anchor, []);
      sections.get(anchor).push({ symbol, metrics: m, forward: (exit / entry - 1) * 100 });
    }
  }

  // A cross-section is only usable if enough names share the same anchor date.
  // Sparse anchors (a handful of symbols whose calendars happened to line up)
  // would otherwise contribute a regression run on five points.
  return [...sections.entries()]
    .filter(([, members]) => members.length >= XS_MIN_UNIVERSE)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, members]) => ({ date, members }));
}

// ---------------------------------------------------------------------------
// Fama-MacBeth estimation
// ---------------------------------------------------------------------------

// Fraction clipped from each tail of every weekly cross-section of forward
// returns. 2% of a ~150-name crypto cross-section is the three biggest winners
// and three biggest losers of the week.
export const XS_WINSOR_PCT = 0.02;

// Clips the extreme tails of `values` to the given percentile bounds, leaving
// every other element untouched. Non-finite entries pass through unchanged so
// the caller's index alignment survives.
export function winsorise(values, pct = XS_WINSOR_PCT) {
  const finite = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (finite.length < 10) return values.slice();
  const k = Math.max(1, Math.floor(finite.length * pct));
  const lo = finite[k], hi = finite[finite.length - 1 - k];
  if (!(hi > lo)) return values.slice();
  return values.map((v) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : v));
}

// Univariate OLS of y on x. Ranks are symmetric about zero, so alpha comes out
// as roughly that week's mean cross-sectional return: a drift term that shifts
// every asset equally and therefore cannot change the ordering. It is kept so
// the published number reads as an expected return rather than a unitless
// score, and dropped from every ranking decision.
export function ols(x, y) {
  const n = x.length;
  if (n < 3) return null;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += x[i]; sy += y[i]; }
  const mx = sx / n, my = sy / n;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { const dx = x[i] - mx; sxy += dx * (y[i] - my); sxx += dx * dx; }
  if (!(sxx > 0)) return null;
  const beta = sxy / sxx;
  return { alpha: my - beta * mx, beta };
}

// Runs one univariate cross-sectional regression per feature per week, then
// averages the weekly coefficients Fama-MacBeth style. The standard error is
// taken across weeks, not across assets, which is the only version that is
// honest about cross-sectional correlation: 150 coins moving together in one
// week is one observation of the market, not 150 independent ones.
export function fitCoefficients(sections, { minWeeks = XS_MIN_ESTIMATION_WEEKS, familyAlpha = XS_FAMILY_ALPHA } = {}) {
  if (!Array.isArray(sections) || sections.length < minWeeks) {
    return { ok: false, reason: `insufficient cross-sections: ${sections ? sections.length : 0} < ${minWeeks}`, coefficients: {} };
  }

  const perFeature = {};
  for (const f of XS_FEATURES) perFeature[f.id] = { alphas: [], betas: [] };

  for (const section of sections) {
    const metrics = section.members.map((m) => m.metrics);
    // Winsorised within its own cross-section, NOT across the whole history:
    // "extreme relative to this week's peers" is the meaningful comparison,
    // and a pooled cut would clip every observation in a violent week and
    // none in a quiet one. Clipping rather than dropping keeps the number of
    // assets per weekly regression constant, so one clipped outlier cannot
    // also change that week's rank structure.
    //
    // This is not cosmetic. Measured on the validation slice, the untrimmed
    // p99 weekly return is +32.6% against a -0.5% median: OLS on the raw
    // series is fitted almost entirely to a handful of names per year. The
    // goal is to estimate which features rank assets well, not to be dragged
    // by whichever coin tripled.
    const forward = winsorise(section.members.map((m) => m.forward), XS_WINSOR_PCT);
    for (const f of XS_FEATURES) {
      const raw = metrics.map((m) => { const v = f.get(m); return Number.isFinite(v) ? v : null; });
      const ranks = crossSectionalRanks(raw);
      const x = [], y = [];
      for (let i = 0; i < ranks.length; i++) {
        if (ranks[i] == null || !Number.isFinite(forward[i])) continue;
        x.push(ranks[i]); y.push(forward[i]);
      }
      if (x.length < XS_MIN_UNIVERSE) continue;
      const fit = ols(x, y);
      if (!fit) continue;
      perFeature[f.id].alphas.push(fit.alpha);
      perFeature[f.id].betas.push(fit.beta);
    }
  }

  // Only features that actually produced enough weekly estimates are part of
  // the test family. Counting the ones that never ran would make the
  // correction stricter than the search actually was.
  const tested = XS_FEATURES.filter((f) => perFeature[f.id].betas.length >= minWeeks);
  const zThreshold = bonferroniZ(Math.max(1, tested.length), familyAlpha);

  const coefficients = {};
  for (const f of XS_FEATURES) {
    const { alphas, betas } = perFeature[f.id];
    const weeks = betas.length;
    if (weeks < minWeeks) {
      coefficients[f.id] = { alpha: 0, beta: 0, tStat: 0, weeks, signConsistency: null, selected: false, zThreshold, featuresTested: tested.length };
      continue;
    }
    const meanBeta = betas.reduce((a, b) => a + b, 0) / weeks;
    const meanAlpha = alphas.reduce((a, b) => a + b, 0) / weeks;
    const variance = betas.reduce((acc, b) => acc + (b - meanBeta) ** 2, 0) / (weeks - 1);
    const se = Math.sqrt(variance / weeks);
    const tStat = se > 0 ? meanBeta / se : 0;
    const agreeing = betas.filter((b) => (b > 0) === (meanBeta > 0)).length;
    const signConsistency = agreeing / weeks;
    coefficients[f.id] = {
      alpha: meanAlpha,
      beta: meanBeta,
      tStat,
      weeks,
      signConsistency,
      selected: Math.abs(tStat) >= zThreshold && signConsistency >= XS_MIN_SIGN_CONSISTENCY,
      zThreshold,
      featuresTested: tested.length
    };
  }

  const selected = Object.keys(coefficients).filter((k) => coefficients[k].selected);
  // Features that produced NO estimate at all, as opposed to one that failed
  // the threshold. A feature the archive fit cannot compute (no mcap, no
  // funding, no open interest in asset_daily_bars) silently yields zero betas
  // and drops out of `tested`, which is correct for the correction but used to
  // be invisible — it let the feature list imply that positioning and size had
  // been evaluated when they had never once been computed. Surfaced so a
  // permanently-dead feature shows up in the refit log instead of hiding.
  const untested = XS_FEATURES.map((f) => f.id).filter((id) => perFeature[id].betas.length === 0);
  return { ok: selected.length > 0, reason: selected.length ? null : 'no feature cleared the family-wise threshold', coefficients, sections: sections.length, zThreshold, selected, untested };
}

// ---------------------------------------------------------------------------
// D1 persistence
// ---------------------------------------------------------------------------

const ARCHIVE_LOOKBACK_DAYS = XS_WARMUP_BARS + XS_ESTIMATION_WEEKS * 7 + 30;

// Symbols per D1 request. A 3-year window over ~157 crypto symbols is roughly
// 217,000 rows; asking for that in one REST call is how you turn a working
// query into the 30-second timeout d1() was given after the last unbounded
// hang. Paging by symbol keeps each response to a few thousand rows.
const ARCHIVE_SYMBOL_PAGE = 20;

export async function loadArchiveBars(env, assetClass, lookbackDays = ARCHIVE_LOOKBACK_DAYS) {
  const since = new Date(Date.now() - lookbackDays * 86400000).toISOString().slice(0, 10);
  const symbolRows = await d1(
    env,
    `SELECT DISTINCT symbol FROM asset_daily_bars WHERE asset_class = ?1 AND date >= ?2 ORDER BY symbol`,
    [assetClass, since]
  );
  const symbols = symbolRows.map((r) => r.symbol);
  const all = [];
  for (const page of chunk(symbols, ARCHIVE_SYMBOL_PAGE)) {
    const placeholders = page.map((_, i) => `?${i + 3}`).join(',');
    const rows = await d1(
      env,
      `SELECT symbol, date, close, volume FROM asset_daily_bars
        WHERE asset_class = ?1 AND date >= ?2 AND close > 0 AND symbol IN (${placeholders})
        ORDER BY symbol, date`,
      [assetClass, since, ...page]
    );
    for (const r of rows) all.push(r);
  }
  // Corrupt bars are excluded from every fit. asset_daily_bars carries 41 rows
  // that are outright wrong (migration 0034) — a ticker remapped to a different
  // token, or a print orders of magnitude off. winsorise() already hid them
  // from the regression's tails, but they still poison the INDICATORS computed
  // per symbol before any cross-section is formed.
  const quarantine = await loadBarQuarantine(d1, env, { assetClass });
  return groupBars(all, quarantine);
}

export async function persistCoefficients(env, assetClass, horizonDays, fit, fitThrough) {
  const now = new Date().toISOString();
  const statements = [];
  for (const [featureId, c] of Object.entries(fit.coefficients)) {
    statements.push({
      sql: `INSERT INTO xs_feature_coefficients
              (asset_class, horizon_days, feature_id, alpha, beta, t_stat, weeks, sign_consistency,
               selected, z_threshold, features_tested, fit_through, method_version, updated_at)
            VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)
            ON CONFLICT(asset_class, horizon_days, feature_id) DO UPDATE SET
              alpha=excluded.alpha, beta=excluded.beta, t_stat=excluded.t_stat, weeks=excluded.weeks,
              sign_consistency=excluded.sign_consistency, selected=excluded.selected,
              z_threshold=excluded.z_threshold, features_tested=excluded.features_tested,
              fit_through=excluded.fit_through, method_version=excluded.method_version,
              updated_at=excluded.updated_at`,
      params: [assetClass, horizonDays, featureId, c.alpha, c.beta, c.tStat, c.weeks,
               c.signConsistency, c.selected ? 1 : 0, c.zThreshold, c.featuresTested,
               fitThrough, XS_METHOD_VERSION, now]
    });
    statements.push({
      sql: `INSERT INTO xs_coefficient_history (fit_at, asset_class, horizon_days, feature_id, beta, t_stat, weeks, selected, method_version)
            VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`,
      params: [now, assetClass, horizonDays, featureId, c.beta, c.tStat, c.weeks, c.selected ? 1 : 0, XS_METHOD_VERSION]
    });
  }
  for (const group of chunk(statements, 25)) await d1Batch(env, group);
}

// Read side, used by build-signals.mjs. Returns
// { [assetClass]: { [horizonDays]: { [featureId]: { alpha, beta, selected } } } }.
// Only rows matching the current method version are honoured: a coefficient
// fitted by an older definition of a feature must not be applied to the new
// one.
export async function loadXsCoefficients(env) {
  if (!env || !env.FCS_D1_DATABASE_ID) return {};
  let rows;
  try {
    rows = await d1(
      env,
      `SELECT asset_class, horizon_days, feature_id, alpha, beta, selected
         FROM xs_feature_coefficients WHERE method_version = ?1`,
      [XS_METHOD_VERSION]
    );
  } catch (err) {
    console.error('loadXsCoefficients failed, cross-sectional lane will abstain:', err.message);
    return {};
  }
  const out = {};
  for (const r of rows) {
    const cls = r.asset_class, h = String(r.horizon_days);
    if (!out[cls]) out[cls] = {};
    if (!out[cls][h]) out[cls][h] = {};
    out[cls][h][r.feature_id] = { alpha: Number(r.alpha), beta: Number(r.beta), selected: Number(r.selected) === 1 };
  }
  return out;
}

// Writes this build's casts to the shadow ledger.
//
// The unique index on (asset_class, symbol, horizon_days, target_date) is the
// idempotency boundary, and DO NOTHING on conflict is what enforces it. The
// build runs hourly; without this, a 7-day forecast would be inserted ~168
// times over substantially the same future and every downstream count would be
// inflated by the same factor. That is precisely the defect that made the v6
// direction model look certain, and it is not being rebuilt here under a new
// name. The FIRST cast for a target date wins; later ones in the same window
// are dropped rather than averaged, so the recorded entry price is one an
// observer could actually have acted on.
export async function writeXsForecasts(env, forecasts) {
  if (!env || !env.FCS_D1_DATABASE_ID || !Array.isArray(forecasts) || !forecasts.length) return { written: 0 };
  const now = new Date();
  const runAt = now.toISOString();
  const statements = [];
  for (const f of forecasts) {
    if (!(f.entry_price > 0) || !Number.isFinite(f.expected_return_pct)) continue;
    const targetDate = new Date(now.getTime() + f.horizon_days * 86400000).toISOString().slice(0, 10);
    statements.push({
      sql: `INSERT INTO xs_forecast_log
              (run_at, asset_class, symbol, horizon_days, target_date, expected_return_pct, percentile,
               decile, entry_price, features_used, universe_size, method_version)
            VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
            ON CONFLICT(asset_class, symbol, horizon_days, target_date) DO NOTHING`,
      params: [runAt, f.asset_class, f.symbol, f.horizon_days, targetDate, f.expected_return_pct,
               f.percentile, f.decile, f.entry_price, f.features_used, f.universe_size, XS_METHOD_VERSION]
    });
  }
  for (const group of chunk(statements, 25)) await d1Batch(env, group);
  return { written: statements.length };
}

// ---------------------------------------------------------------------------
// Maturity scoring and evidence
// ---------------------------------------------------------------------------

// Fills realised returns for every logged forecast whose target date has a bar,
// then folds the matured rows into decile evidence. Excess return against the
// equal-weighted class is the scored quantity; see the migration for why a hit
// rate is not.
export async function scoreMaturedForecasts(env) {
  const pending = await d1(
    env,
    `SELECT f.id, f.asset_class, f.symbol, f.horizon_days, f.target_date, f.entry_price, b.close AS exit_price
       FROM xs_forecast_log f
       JOIN asset_daily_bars b ON b.symbol = f.symbol AND b.date = f.target_date AND b.asset_class = f.asset_class
      WHERE f.realised_return_pct IS NULL
      LIMIT 5000`,
    []
  );
  if (!pending.length) return { scored: 0 };

  // Universe return for each (class, horizon, target_date) cohort, so a row is
  // scored against holding everything rather than against zero.
  const cohorts = new Map();
  for (const p of pending) {
    const key = `${p.asset_class}|${p.horizon_days}|${p.target_date}`;
    const ret = (Number(p.exit_price) / Number(p.entry_price) - 1) * 100;
    if (!Number.isFinite(ret)) continue;
    if (!cohorts.has(key)) cohorts.set(key, []);
    cohorts.get(key).push({ id: p.id, ret });
  }

  const now = new Date().toISOString();
  const statements = [];
  for (const rows of cohorts.values()) {
    const mean = rows.reduce((a, r) => a + r.ret, 0) / rows.length;
    for (const r of rows) {
      statements.push({
        sql: `UPDATE xs_forecast_log SET realised_return_pct = ?1, universe_return_pct = ?2, observed_at = ?3 WHERE id = ?4`,
        params: [r.ret, mean, now, r.id]
      });
    }
  }
  for (const group of chunk(statements, 25)) await d1Batch(env, group);
  return { scored: statements.length };
}

export async function foldDecileEvidence(env) {
  const rows = await d1(
    env,
    `SELECT asset_class, horizon_days, decile,
            COUNT(*) AS n,
            AVG(realised_return_pct - universe_return_pct) AS mean_excess,
            AVG(realised_return_pct) AS mean_raw,
            AVG(CASE WHEN realised_return_pct > universe_return_pct THEN 1.0 ELSE 0.0 END) AS hit,
            AVG((realised_return_pct - universe_return_pct) * (realised_return_pct - universe_return_pct)) AS mean_sq
       FROM xs_forecast_log
      WHERE realised_return_pct IS NOT NULL AND universe_return_pct IS NOT NULL
        AND method_version = ?1
      GROUP BY asset_class, horizon_days, decile`,
    [XS_METHOD_VERSION]
  );
  const now = new Date().toISOString();
  const statements = rows.map((r) => {
    const n = Number(r.n);
    const mean = Number(r.mean_excess);
    const variance = Math.max(0, Number(r.mean_sq) - mean * mean);
    const sd = Math.sqrt(variance * (n > 1 ? n / (n - 1) : 1));
    const tStat = n > 1 && sd > 0 ? mean / (sd / Math.sqrt(n)) : null;
    return {
      sql: `INSERT INTO xs_decile_evidence
              (asset_class, horizon_days, decile, n, mean_excess_pct, sd_excess_pct, t_stat, mean_raw_pct, hit_rate, updated_at, method_version)
            VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
            ON CONFLICT(asset_class, horizon_days, decile) DO UPDATE SET
              n=excluded.n, mean_excess_pct=excluded.mean_excess_pct, sd_excess_pct=excluded.sd_excess_pct,
              t_stat=excluded.t_stat, mean_raw_pct=excluded.mean_raw_pct, hit_rate=excluded.hit_rate,
              updated_at=excluded.updated_at`,
      params: [r.asset_class, Number(r.horizon_days), Number(r.decile), n, mean, sd, tStat, Number(r.mean_raw), Number(r.hit), now, XS_METHOD_VERSION]
    };
  });
  for (const group of chunk(statements, 25)) await d1Batch(env, group);
  return { deciles: statements.length };
}

// ---------------------------------------------------------------------------
// Publication gate
// ---------------------------------------------------------------------------

// Independent matured observations a decile needs before it may be shown.
export const XS_PUBLICATION_MIN_SAMPLES = 200;
// One-sided t on mean excess return. Not a Sharpe, not a hit rate: the claim
// being gated is "this decile beat holding the class", so that is the statistic.
export const XS_PUBLICATION_MIN_T = 2.0;

// Fail-closed, same contract as the direction model's gate: a decile is
// publishable only with its own matured, version-matched evidence. Everything
// else is WITHHELD, and withheld is a normal, expected state — especially in
// the weeks after a fit, when the evidence has deliberately been reset.
export function xsDecileIsPublishable(evidence, assetClass, horizonDays, decile) {
  if (!evidence) return false;
  const row = evidence[`${assetClass}|${horizonDays}|${decile}`];
  if (!row) return false;
  if (!(row.n >= XS_PUBLICATION_MIN_SAMPLES)) return false;
  if (!Number.isFinite(row.tStat)) return false;
  // Only a decile that beat the universe may be published as a buy, and only
  // one that lost to it may be published as an avoid. A decile with a
  // significant t-stat in the wrong direction for its position is a warning
  // that the lane is inverted, not a licence to publish it.
  if (decile >= 5) return row.tStat >= XS_PUBLICATION_MIN_T;
  return row.tStat <= -XS_PUBLICATION_MIN_T;
}

export async function loadDecileEvidence(env) {
  if (!env || !env.FCS_D1_DATABASE_ID) return {};
  let rows;
  try {
    rows = await d1(env, `SELECT asset_class, horizon_days, decile, n, mean_excess_pct, t_stat FROM xs_decile_evidence WHERE method_version = ?1`, [XS_METHOD_VERSION]);
  } catch (err) {
    console.error('loadDecileEvidence failed, cross-sectional lane will abstain:', err.message);
    return {};
  }
  const out = {};
  for (const r of rows) {
    out[`${r.asset_class}|${r.horizon_days}|${r.decile}`] = {
      n: Number(r.n), meanExcessPct: Number(r.mean_excess_pct), tStat: Number(r.t_stat)
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point: refit both classes, both horizons.
// ---------------------------------------------------------------------------

export async function refitAll(env, { classes = ['crypto', 'stock'], horizons = XS_HORIZONS_DAYS } = {}) {
  const report = [];
  for (const assetClass of classes) {
    const bars = await loadArchiveBars(env, assetClass);
    if (!bars.size) { report.push({ assetClass, ok: false, reason: 'no archive bars' }); continue; }
    for (const horizonDays of horizons) {
      const sections = buildWeeklyCrossSections(bars, horizonDays);
      const fit = fitCoefficients(sections);
      const fitThrough = sections.length ? sections[sections.length - 1].date : new Date().toISOString().slice(0, 10);
      if (sections.length) await persistCoefficients(env, assetClass, horizonDays, fit, fitThrough);
      report.push({
        assetClass, horizonDays, ok: fit.ok, reason: fit.reason,
        sections: sections.length, zThreshold: fit.zThreshold,
        selected: fit.selected || [],
        fitThrough
      });
    }
  }
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID } = process.env;
  if (!CLOUDFLARE_API_TOKEN || !CLOUDFLARE_ACCOUNT_ID || !FCS_D1_DATABASE_ID) {
    console.error('Missing required env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID');
    process.exit(1);
  }
  const env = { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID };
  const report = await refitAll(env);
  for (const r of report) {
    console.log(`[xs] ${r.assetClass} ${r.horizonDays ?? '-'}d: ok=${r.ok} sections=${r.sections} z>=${r.zThreshold?.toFixed(2)} selected=[${(r.selected || []).join(', ')}]${r.reason ? ` reason=${r.reason}` : ''}`);
    // Never-estimated features, printed every refit so a structurally dead one
    // cannot keep passing for a tested-and-rejected one.
    if (r.untested && r.untested.length) {
      console.log(`[xs] ${r.assetClass} ${r.horizonDays ?? '-'}d: NOT COMPUTABLE from the archive fit, never tested: [${r.untested.join(', ')}]`);
    }
  }
  const scored = await scoreMaturedForecasts(env);
  const folded = await foldDecileEvidence(env);
  console.log(`[xs] matured rows scored: ${scored.scored}; decile cells folded: ${folded.deciles}`);
}
