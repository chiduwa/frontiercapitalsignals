// Rebuilds the FULL metrics object evaluateTechniques() consumes, from archive
// bars alone, as of bar index `i`, using only bars[0..i].
//
// scripts/cross-sectional.mjs already has archiveMetrics(), but that one exists
// to feed XS_FEATURES — about a dozen scalar accessors. The technique library
// reads ~41 distinct `m.*` fields with several compound shapes (m.fib,
// m.dwell, m.seasonal, m.val), so replaying confluence() needs a wider object.
// This is that object. archiveMetrics is deliberately left alone: the XS lane's
// fitted coefficients are keyed to exactly the fields it produces today, and
// widening it would silently change what those coefficients were fitted on.
//
// THREE RULES, all load-bearing:
//
// 1. No look-ahead. Every window below closes at `i`. The forward bar is never
//    touched here — locating it and checking the span is the caller's job, and
//    scripts/replay-history.mjs does it by DATE (never index arithmetic) for
//    the reason documented in buildWeeklyCrossSections.
//
// 2. Same functions as live. Every indicator is imported from worker.js rather
//    than reimplemented. If this file computed its own RSI, a replayed record
//    would be measuring a different model than the live one and nothing would
//    ever report an error. Sharing the functions makes that impossible instead
//    of merely unlikely.
//
// 3. Missing input means the technique ABSTAINS, never guesses. A field the
//    archive cannot supply is left undefined, its technique's guard fails, and
//    it casts no vote at all — which is the model's existing behaviour for a
//    cold asset, not a degradation invented here.
//
// What the archive cannot supply, and which technique therefore sits out:
//
//   m.val              valuation     Wall Street consensus targets are a live
//                                    snapshot; Yahoo publishes no history.
//   m.trending         attention     CoinGecko's trending list is not archived.
//   m.daysToEarnings   earnings      No historical earnings calendar stored.
//   m.sentimentScore   sentiment     Per-asset community/news sentiment has no
//                                    history (the GLOBAL fear & greed series
//                                    does, but it is not this field).
//   m.ivPercentile     impliedvol    iv_daily starts 2026-08 and is thin.
//   m.funding          positioning   funding_rate_daily starts 2026-03-30; see
//                                    replayNonPriceMetrics for why partial
//                                    coverage is worse than none here.
//   m.chgShort         momentum      1h change; archive is daily grain. The
//                                    technique falls back to chg24h on its own
//                                    (`cS ?? c24`), so it still votes.
//
// That is 6 techniques dark out of ~27, and the replayed composite is honest
// about it: those votes are absent rather than imputed, exactly as they are for
// any live asset whose supplier did not answer. It also means a replayed
// composite is a STRICT SUBSET of the live panel, never a different one — the
// direction of that difference matters, because a subset can only be less
// informed than the live model, so a replayed record that shows skill is a
// lower bound on the live one rather than an unrelated number.

import {
  rsi, rsiRecentRange, macd, sma, slopePct, rangePos, rangeBounds,
  bollinger, stochastic, obvSlope, swingStructure, divergenceProxy,
  volRegime, dwellAtExtreme, fibonacciLevels, realizedVolPct,
  correlationWithBenchmark, seasonalAnalog, dailyMovementStats
} from '../worker.js';

// Bars needed before any metric is emitted. 260 matches XS_WARMUP_BARS: SMA200
// needs 200, seasonalAnalog wants a full cycle, and dwellAtExtreme/rangePos
// both look back 252. Below this the object would be mostly nulls and the
// composite would be a vote of three techniques pretending to be a panel.
export const REPLAY_WARMUP_BARS = 260;

// Cycle length seasonalAnalog is asked to match against, in bars. Crypto trades
// every day so a year is 365 bars; equities ~252. Mirrors how buildCryptoMetrics
// and buildStockMetrics each call it live.
const SEASONAL_CYCLE = { crypto: 365, stock: 252 };

// `bars`      one symbol's cleaned, date-ascending bars ({date, close, volume})
// `i`         anchor index; everything is computed as of this bar
// `kind`      'crypto' | 'stock' — selects the horizon conventions that
//             buildCryptoMetrics/buildStockMetrics use live
// `extras`    fundamentals panel (scripts/fundamentals-panel.mjs), looked up by
//             the anchor bar's own DATE so a value can never come from a day the
//             replay has not reached
// `benchCloses` benchmark closes ALREADY SLICED to the same anchor date by the
//             caller, for m.corr. Passing an unsliced benchmark here would be a
//             look-ahead leak through the back door.
export function replayMetrics(symbol, bars, i, { kind = 'crypto', extras = null, benchCloses = null } = {}) {
  if (i < REPLAY_WARMUP_BARS - 1 || i >= bars.length) return null;
  const window = bars.slice(0, i + 1);
  const closes = window.map((b) => b.close);
  const n = closes.length;
  const price = closes[n - 1];
  if (!(price > 0)) return null;

  const volumes = window.map((b) => b.volume);
  const haveVolume = volumes.every((v) => Number.isFinite(v));

  // Bar-count offsets, matching the live builders: crypto bars are calendar
  // days, equity bars are trading days, so "a week" is 7 of one and 5 of the
  // other. Getting this wrong would not error — it would quietly measure a
  // different horizon than the live model does.
  const isCrypto = kind === 'crypto';
  const back7 = isCrypto ? 7 : 5;
  const back30 = isCrypto ? 30 : 21;
  const pct = (nBack) => {
    const prev = closes[n - 1 - nBack];
    return prev > 0 ? (price / prev - 1) * 100 : null;
  };

  const rNow = rsi(closes);
  const rRange = rsiRecentRange(closes);
  const md = macd(closes);
  const s20 = sma(closes, 20), s50 = sma(closes, 50);
  const s200 = n >= 200 ? sma(closes, 200) : null;
  const mean7d = n >= 7 ? closes.slice(-7).reduce((a, b) => a + b, 0) / 7 : null;

  // 20-bar average volume, the denominator buildStockMetrics uses for volRatio.
  const avgVol20 = haveVolume && n >= 20
    ? volumes.slice(-20).reduce((a, b) => a + b, 0) / 20
    : null;

  // Crypto's live volRatio is turnover-based — (volume / market cap) / 0.08 —
  // not volume-vs-its-own-average. The two are different numbers on different
  // scales, so substituting one for the other would make the replayed `volume`
  // technique a DIFFERENT technique wearing the same id, and its record would
  // not transfer to the live model. Market cap is available from the supply
  // panel for 131 symbols over 365 days; where it is not, volRatio is left
  // undefined and `volume` abstains.
  const marketCap = extras && extras.marketCap ? extras.marketCap.get(symbol)?.get(bars[i].date) : null;
  const volRatio = isCrypto
    ? (marketCap > 0 && haveVolume ? (volumes[n - 1] / marketCap) / 0.08 : null)
    : (avgVol20 ? volumes[n - 1] / avgVol20 : null);

  const nonPrice = replayNonPriceMetrics(symbol, bars[i].date, extras);

  return {
    symbol,
    name: symbol,
    inputInterval: '1d',
    historySource: 'archive-replay',
    historyObservations: n,
    dataQuality: 'model-ready',
    price,
    volPct: realizedVolPct(closes, 30),
    // chgShort deliberately absent — see the header. momentum reads `cS ?? c24`.
    chg24h: pct(1),
    chg7d: pct(back7),
    chg30d: pct(back30),
    rsi: rNow,
    // Live uses closes.slice(0, -3) for rsiPrev, not -1: the reversal technique
    // asks "has RSI turned", which a single bar cannot answer on daily grain.
    rsiPrev: rsi(closes.slice(0, -3)),
    rsiRecentMin: rRange.min,
    rsiRecentMax: rRange.max,
    rangePos: rangePos(closes.slice(-252), price),
    rangeBounds: rangeBounds(closes.slice(-252)),
    stretch: s20 ? ((price / s20) - 1) * 100 : null,
    mean7d,
    slope: slopePct(closes, 15),
    volRatio,
    macdHist: md && md.hist,
    macdPrevHist: md && md.prevHist,
    sma20: s20,
    sma50: s50,
    sma200: s200,
    bb: bollinger(closes),
    // No high/low columns in asset_daily_bars. stochastic() already falls back
    // to closes for both when they are absent — the same degradation the live
    // crypto path takes, since CoinGecko's daily history is close-only too.
    stoch: stochastic(closes),
    donchianHi: n > 21 ? Math.max(...closes.slice(-21, -1)) : null,
    donchianLo: n > 21 ? Math.min(...closes.slice(-21, -1)) : null,
    obv: haveVolume ? obvSlope(closes, volumes, 15) : null,
    structure: swingStructure(closes, 40),
    divergence: divergenceProxy(closes, rNow, 25),
    volReg: volRegime(closes, 20, 100),
    dwell: dwellAtExtreme(closes),
    fib: fibonacciLevels(closes),
    corr: benchCloses && benchCloses.length > 10
      ? correlationWithBenchmark(closes, benchCloses, 30)
      : null,
    seasonal: seasonalAnalog(closes, SEASONAL_CYCLE[kind] || 365),
    // Takes BARS, not closes — it reports the date of the largest move, so it
    // needs the objects.
    dailyMoves: dailyMovementStats(window),
    ...nonPrice
  };
}

// Derivatives fields, read by DATE out of the fundamentals panel. Same
// no-lookahead guarantee the price windows get from slicing at i.
//
// `oiPercentile` does NOT come from the panel's `oi_level_pct`. That field is a
// ROLLING 252-day percentile (derivatives-features.mjs) while the live
// `openinterest` technique reads an EXPANDING one. The rolling window is the
// better statistic — docs/DERIVATIVES_EVIDENCE.md §1 shows the expanding form
// saturating at 1.00 for fourteen consecutive days through ZEC's entire run,
// maximally uninformative exactly when the thing it measures was most extreme —
// but "better" is not "the same". A replayed record has to measure the
// technique that is actually live, or its accuracy does not transfer. The
// caller precomputes the expanding series (see expandingOiPercentiles in
// replay-history.mjs) and passes it in `extras.oiExpanding`; the rolling value
// rides along under its own name for any lane that wants the better one.
//
// Funding is deliberately absent. funding_rate_daily begins 2026-03-30, so over
// a multi-year replay it would be null for ~90% of anchors and present for the
// tail — which does not make `positioning` abstain cleanly, it makes it a
// technique that only exists in recent history and would bias its own record
// toward one regime. Left out entirely; positioning abstains throughout.
export function replayNonPriceMetrics(symbol, date, extras) {
  if (!extras) return {};
  const out = {};
  const d = extras.deriv?.get(symbol)?.get(date);
  if (d) {
    if (d.oi_usd != null) out.openInterest = d.oi_usd;
    if (d.oi_level_pct != null) out.oiLevelPctRoll = d.oi_level_pct;
  }
  const expanding = extras.oiExpanding?.get(symbol)?.get(date);
  if (expanding != null) out.oiPercentile = expanding;
  return out;
}
