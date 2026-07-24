// ===========================================================================
// FRONTIER CAPITAL SIGNALS — Cloudflare Worker (single file, no Vercel)
//
// One Worker serves the dashboard AND runs the confluence engine:
//   GET  /signals            -> 301 to /signals/
//   GET  /signals/           -> dashboard HTML
//   GET  /signals/api/signals-> JSON (served from KV cache, <=60 min old)
//   cron 0 * * * *           -> rebuilds the payload into KV every hour
//
// The rest of frontiercapitalsignals.com is untouched: this Worker only
// runs on the route you bind (frontiercapitalsignals.com/signals*).
//
// ---- SETUP (Cloudflare dashboard, ~2 min) --------------------------------
//   1. Workers & Pages -> KV -> Create namespace "FCS_CACHE".
//   2. Workers & Pages -> Create Worker -> paste this whole file -> Deploy.
//   3. Worker -> Settings -> Variables -> KV Namespace Bindings:
//        Variable name: FCS_CACHE   Namespace: FCS_CACHE
//   4. Worker -> Settings -> Domains & Routes -> Add route:
//        frontiercapitalsignals.com/signals*   (your zone)
//   5. Worker -> Settings -> Triggers -> Cron Triggers -> add: 0 * * * *
//   6. (optional valuation override) Settings -> Variables -> add
//        TREFIS_OVERRIDES = {"AAPL":275.0,"NFLX":88.0}
//   Then open https://frontiercapitalsignals.com/signals
//
//   wrangler alternative: put this at src/worker.js with a wrangler.toml
//   declaring the KV binding + [triggers] crons = ["0 * * * *"], then
//   `npx wrangler deploy`.
// ===========================================================================

const MOUNT = '/signals';
export const CACHE_KEY = 'signals:latest';
// Confirmed live: a single simple/price call for ~20 displayed crypto ids
// got a 429 from CoinGecko with no unusual traffic at all — the same
// shared-egress-IP rate-limiting GitHub Actions runners hit earlier on the
// per-coin history endpoint (see getCryptoDailyHistory), just from
// Workers' shared IP range instead of Actions'. Caching the whole
// /api/prices result for LIVE_PRICE_CACHE_SECONDS caps upstream calls to
// at most once per that window regardless of visitor count — the fix has
// to live here, not in a retry, since the problem is request *volume*
// against a rate limit, not a transient blip a retry would smooth over.
// 60 is also KV's own minimum expirationTtl, so this is as tight as KV
// allows anyway.
export const LIVE_PRICE_CACHE_KEY = 'signals:live-prices';
const LIVE_PRICE_CACHE_SECONDS = 60;

// ----------------------------- CONFIG ---------------------------------------

export const CACHE_SECONDS = 3600;
// Top 100 by market cap, not 200: a smaller, higher-liquidity universe reads
// cleaner technically, and the saved request budget instead goes toward a
// real per-coin daily-history fetch (see getCryptoDailyHistory) rather than
// relying only on the 7-day hourly sparkline for every technique.
export const CRYPTO_UNIVERSE = 100;
export const CRYPTO_MIN_MCAP = 30_000_000;
export const CRYPTO_MIN_VOLUME = 2_000_000;
// 365, not 210: a real 52-week window for dwellAtExtreme(), matching
// 365 is the actual ceiling, not a choice: confirmed live that CoinGecko's
// free/public tier hard-rejects anything past 1 year (error code 10012,
// "Public API users are limited to querying historical data within the
// past 365 days") — a real production outage caught the same day this
// was bumped to 2000 hoping for multi-year seasonal-analog data (every
// single one of ~76 coins failed that run, 0/76 vs the usual ~36-37/76).
// Practical effect: seasonalAnalog() can never find a candidate year for
// crypto on this plan (it needs cycleLength + windowDays + forwardDays,
// so >365 days, to compare even one year back) — it'll correctly return
// null every time via its own length check, same code path as "too young,"
// just universally true for crypto rather than only the newest coins.
// Equities don't have this ceiling (Yahoo's own history goes back
// years), so seasonalAnalog is effectively equities-only in practice.
export const CRYPTO_HISTORY_DAYS = 365;
// Sequential, not concurrent: a live run showed ~100% of per-coin history
// calls failing when fired in bursts of 5 from a GitHub Actions runner
// (shared CI IP ranges are more rate-limit-prone against CoinGecko's free
// tier than an arbitrary residential IP). One request at a time with a
// real gap between them is slower but reliable — there's no CPU/wall-clock
// pressure here like there would be inside a Worker request.
const CRYPTO_HISTORY_BATCH = 1;
const CRYPTO_HISTORY_DELAY_MS = 3000;

export const CRYPTO_BLOCKLIST = new Set([
  'usdt','usdc','usds','usde','dai','fdusd','pyusd','tusd','usdp','gusd','frax',
  'lusd','susd','usdd','usdy','usd0','usdtb','rlusd','eurc','eurt','usdx','buidl',
  'wbtc','weth','wsteth','steth','cbbtc','cbeth','reth','weeth','rseth','ezeth',
  'jitosol','msol','bnsol','tbtc','lbtc','solvbtc','wbeth','frxeth','sfrxeth',
  'oseth','lseth','swbtc','meth','susds','sdai','xaut','jlp','wbnb'
]);

export const STOCK_WATCHLIST = [
  'AAPL','MSFT','NVDA','GOOGL','AMZN','META','TSLA','AVGO',
  'JPM','GS','MS','BAC','WFC','C','V','MA',
  'XOM','CVX','COP','MPC','VLO','PBF','DINO',
  'GE','BA','CAT','DE','LMT','RTX',
  'NFLX','DIS','TSM','ASML','AMD','MU','INTC','QCOM',
  'ORCL','IBM','CRM','NOW','PLTR',
  'CRWD','PANW','ZS','DDOG','SNOW','NET',
  'DELL','SMCI','UNH','LLY','JNJ','ISRG',
  'COIN','HOOD','MSTR','DASH','UBER','LCID'
];

export const OVERVIEW_SYMBOLS = ['SPY', 'QQQ', '^VIX'];

const FETCH_TIMEOUT_MS = 9000;
const POOL_CONCURRENCY = 8;
const UA = 'Mozilla/5.0 (compatible; FrontierCapitalSignals/2.0)';

// ----------------------------- CORE MATH ------------------------------------

export const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));

export function sma(values, period) {
  if (!values || values.length < period) return null;
  let s = 0;
  for (let i = values.length - period; i < values.length; i++) s += values[i];
  return s / period;
}

export function ema(values, period) {
  if (!values || values.length < period) return null;
  const k = 2 / (period + 1);
  let e = 0;
  for (let i = 0; i < period; i++) e += values[i];
  e /= period;
  const out = new Array(period - 1).fill(null);
  out.push(e);
  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
    out.push(e);
  }
  return out;
}

// Full RSI history, not just the latest value — same Wilder's-smoothing
// math as before, just keeping every intermediate value instead of
// discarding all but the last. Lets the reversal technique below ask "what
// was RSI's recent low/high" rather than only "what is RSI right now."
export function rsiSeries(closes, period = 14) {
  if (!closes || closes.length < period + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) g += d; else l -= d;
  }
  let ag = g / period, al = l / period;
  const out = [al === 0 ? 100 : 100 - 100 / (1 + ag / al)];
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
    out.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al));
  }
  return out;
}

export function rsi(closes, period = 14) {
  const series = rsiSeries(closes, period);
  return series ? series[series.length - 1] : null;
}

// Min/max RSI over the trailing `lookback` bars — "did this asset actually
// bottom/top and turn," not just "is RSI currently below/above a line."
export function rsiRecentRange(closes, lookback = 10, period = 14) {
  const series = rsiSeries(closes, period);
  if (!series || !series.length) return { min: null, max: null };
  const window = series.slice(-lookback);
  return { min: Math.min(...window), max: Math.max(...window) };
}

export function macd(closes, fast = 12, slow = 26, signalP = 9) {
  if (!closes || closes.length < slow + signalP + 1) return null;
  const ef = ema(closes, fast);
  const es = ema(closes, slow);
  const line = [];
  for (let i = 0; i < closes.length; i++) {
    if (ef[i] != null && es[i] != null) line.push(ef[i] - es[i]);
  }
  const sig = ema(line, signalP);
  if (!sig) return null;
  const n = line.length - 1;
  return {
    line: line[n],
    signal: sig[n],
    hist: line[n] - sig[n],
    prevHist: sig[n - 1] != null ? line[n - 1] - sig[n - 1] : null
  };
}

export function slopePct(values, n) {
  if (!values || values.length < 3) return 0;
  const v = values.slice(-n);
  const N = v.length;
  const xm = (N - 1) / 2;
  const ym = v.reduce((a, b) => a + b, 0) / N;
  let num = 0, den = 0;
  for (let i = 0; i < N; i++) { num += (i - xm) * (v[i] - ym); den += (i - xm) ** 2; }
  if (!den || !ym) return 0;
  return ((num / den) / ym) * 100;
}

export function rangePos(values, price) {
  if (!values || !values.length) return null;
  const hi = Math.max(...values), lo = Math.min(...values);
  if (hi === lo) return 0.5;
  // Clamped: price and values can now come from two different API calls for
  // crypto (live current_price vs. daily-history closes), so a live price
  // can legitimately sit just outside the historical window (e.g. mid-breakout).
  return clamp((price - lo) / (hi - lo), 0, 1);
}

// Bollinger bands with squeeze detection (bandwidth now vs 10 bars ago).
export function bollinger(closes, period = 20, numStd = 2) {
  if (!closes || closes.length < period + 10) return null;
  const calc = (arr) => {
    const m = sma(arr, period);
    let ss = 0;
    for (let i = arr.length - period; i < arr.length; i++) ss += (arr[i] - m) ** 2;
    const sd = Math.sqrt(ss / period);
    return { mid: m, upper: m + numStd * sd, lower: m - numStd * sd, bw: m ? (2 * numStd * sd) / m : 0 };
  };
  const now = calc(closes);
  const prev = calc(closes.slice(0, -10));
  const price = closes[closes.length - 1];
  const span = now.upper - now.lower;
  return {
    ...now,
    pctB: span ? (price - now.lower) / span : 0.5,
    bwPrev: prev.bw,
    expanding: now.bw > prev.bw * 1.15,
    squeezed: prev.bw > 0 && now.bw < prev.bw * 0.8
  };
}

// Stochastic %K/%D. Uses true highs/lows when given, close-only otherwise.
export function stochastic(closes, highs, lows, kP = 14, dP = 3) {
  if (!closes || closes.length < kP + dP + 1) return null;
  const H = highs && highs.length === closes.length ? highs : closes;
  const L = lows && lows.length === closes.length ? lows : closes;
  const kSeries = [];
  for (let i = kP - 1; i < closes.length; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - kP + 1; j <= i; j++) { if (H[j] > hi) hi = H[j]; if (L[j] < lo) lo = L[j]; }
    kSeries.push(hi === lo ? 50 : ((closes[i] - lo) / (hi - lo)) * 100);
  }
  const dNow = sma(kSeries, dP);
  const dPrev = sma(kSeries.slice(0, -1), dP);
  const kNow = kSeries[kSeries.length - 1];
  const kPrev = kSeries[kSeries.length - 2];
  return { k: kNow, d: dNow, crossUp: kPrev <= dPrev && kNow > dNow, crossDown: kPrev >= dPrev && kNow < dNow };
}

// On-balance volume slope over the last n bars, as % of |OBV| scale.
export function obvSlope(closes, volumes, n = 15) {
  if (!closes || !volumes || closes.length !== volumes.length || closes.length < n + 2) return null;
  const obv = [0];
  for (let i = 1; i < closes.length; i++) {
    obv.push(obv[i - 1] + (closes[i] > closes[i - 1] ? volumes[i] : closes[i] < closes[i - 1] ? -volumes[i] : 0));
  }
  const seg = obv.slice(-n);
  const scale = Math.max(...seg.map(Math.abs), 1);
  const norm = seg.map(v => v / scale);
  const N = norm.length, xm = (N - 1) / 2, ym = norm.reduce((a, b) => a + b, 0) / N;
  let num = 0, den = 0;
  for (let i = 0; i < N; i++) { num += (i - xm) * (norm[i] - ym); den += (i - xm) ** 2; }
  return den ? (num / den) * 100 : 0;
}

// Swing structure over ~2 windows: HH/HL bullish, LH/LL bearish.
export function swingStructure(closes, look = 40) {
  if (!closes || closes.length < look) return 0;
  const seg = closes.slice(-look);
  const half = Math.floor(look / 2);
  const a = seg.slice(0, half), b = seg.slice(half);
  const hh = Math.max(...b) > Math.max(...a);
  const hl = Math.min(...b) > Math.min(...a);
  const lh = Math.max(...b) < Math.max(...a);
  const ll = Math.min(...b) < Math.min(...a);
  if (hh && hl) return 1;
  if (lh && ll) return -1;
  return 0;
}

// Divergence proxy: fresh price extreme without momentum support.
export function divergenceProxy(closes, rsiNow, look = 25) {
  if (!closes || closes.length < look + 5 || rsiNow == null) return 0;
  const recent = closes.slice(-5);
  const prior = closes.slice(-look - 5, -5);
  const price = closes[closes.length - 1];
  if (Math.max(...recent) >= Math.max(...prior) && rsiNow < 63 && price >= Math.max(...prior) * 0.995) return -1;
  if (Math.min(...recent) <= Math.min(...prior) && rsiNow > 37 && price <= Math.min(...prior) * 1.005) return 1;
  return 0;
}

// Volatility regime: recent realized vol vs the longer baseline.
export function volRegime(closes, shortN = 20, longN = 100) {
  if (!closes || closes.length < longN + 2) return null;
  const rets = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1]) rets.push((closes[i] / closes[i - 1]) - 1);
  }
  const sd = (arr) => {
    const m = arr.reduce((a, b) => a + b, 0) / arr.length;
    return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length);
  };
  const recent = sd(rets.slice(-shortN));
  const base = sd(rets.slice(-longN));
  return base ? recent / base : null;
}

// ----------------------------- CONFLUENCE -----------------------------------
// Each technique votes dir: +1 bull, -1 bear, 0 neutral, null = no data.
// Weight expresses how much independent information the technique carries.

// Below this many matured (symbol, technique, horizon) outcomes, a
// technique's measured accuracy is too noisy to act on — it keeps the
// static baseline weight (multiplier 1) until enough history accumulates.
export const MIN_RELIABILITY_SAMPLES = 20;

// reliability: optional flat map built by scripts/reliability.mjs from D1,
// `${symbol}|${techniqueId}` -> { accuracy, total } (accuracy already
// blended across the 24h/168h horizons there). accuracy 1.0 (always right
// for this asset) -> 1.5x weight; accuracy 0.0 (always wrong) -> 0.5x;
// accuracy 0.5 (coin flip, no information) -> 1x, unchanged from today.
export function reliabilityMultiplier(reliability, symbol, techniqueId) {
  if (!reliability) return 1;
  const rec = reliability[`${symbol}|${techniqueId}`];
  if (!rec || rec.total < MIN_RELIABILITY_SAMPLES) return 1;
  return clamp(0.5 + rec.accuracy, 0.5, 1.5);
}

// Classifies each technique as leading (anticipates a move before it's
// confirmed) or lagging/confirming (describes a move already underway),
// plus a typical resolution horizon in days — the fallback estimate below
// uses this when there isn't yet enough of this asset's own history to
// answer the question directly. This is a judgment call, documented here
// and in the dashboard's methodology section, not a physical law: moving
// averages and swing structure are textbook lagging/descriptive reads;
// divergence, squeeze detection, reversal patterns, OBV, and crowding
// (funding/positioning) are textbook leading reads; valuation is "leading"
// only on a much longer mean-reversion clock.
export const TECHNIQUE_META = {
  momentum:    { leading: false, horizonDays: 5 },
  rsi:         { leading: true,  horizonDays: 3 },
  macd:        { leading: false, horizonDays: 5 },
  ma:          { leading: false, horizonDays: 10 },
  bollinger:   { leading: true,  horizonDays: 2 },
  stoch:       { leading: true,  horizonDays: 2 },
  range:       { leading: false, horizonDays: 5 },
  volume:      { leading: false, horizonDays: 2 },
  obv:         { leading: true,  horizonDays: 5 },
  structure:   { leading: false, horizonDays: 7 },
  divergence:  { leading: true,  horizonDays: 3 },
  volatility:  { leading: true,  horizonDays: 4 },
  reversal:    { leading: true,  horizonDays: 2 },
  valuation:   { leading: true,  horizonDays: 30 },
  positioning: { leading: true,  horizonDays: 3 },
  attention:   { leading: true,  horizonDays: 2 },
  dwell:       { leading: true,  horizonDays: 5 },
  seasonal:    { leading: true,  horizonDays: 7 }
};

export function horizonLabel(days) {
  if (days <= 1.5) return '~1 day';
  if (days <= 3.5) return '1-3 days';
  if (days <= 6) return '3-6 days';
  if (days <= 10) return '~1 week';
  if (days <= 20) return '1-3 weeks';
  return '3+ weeks';
}

// Estimates the window this specific call is expected to resolve in.
// Prefers a data-driven answer — this asset's own measured accuracy at the
// 24h vs 168h horizon, restricted to the techniques currently voting this
// direction — over the static methodology table, once there's enough of
// that asset's own history to trust (same MIN_RELIABILITY_SAMPLES gate as
// the weighting itself). Returns null only when nothing applicable voted.
export function horizonEstimate(applicable, dir, symbol, reliabilityByHorizon) {
  const active = applicable.filter(t => t.dir === dir);
  if (!active.length) return null;

  if (reliabilityByHorizon) {
    const acc24 = { correct: 0, total: 0 };
    const acc168 = { correct: 0, total: 0 };
    for (const t of active) {
      const r24 = reliabilityByHorizon[24] && reliabilityByHorizon[24][`${symbol}|${t.id}`];
      const r168 = reliabilityByHorizon[168] && reliabilityByHorizon[168][`${symbol}|${t.id}`];
      // Only folds a technique's own numbers in once IT individually has
      // matured enough outcomes — several techniques voting on the same
      // asset in the same hour are correlated (they're marked right or
      // wrong together, off the same underlying price move), so summing
      // their thin counts together would let that correlation masquerade
      // as independent confidence. Same bar as reliabilityMultiplier uses,
      // deliberately, so "enough history to trust" means the same thing
      // in both places.
      if (r24 && r24.total >= MIN_RELIABILITY_SAMPLES) { acc24.correct += r24.correct; acc24.total += r24.total; }
      if (r168 && r168.total >= MIN_RELIABILITY_SAMPLES) { acc168.correct += r168.correct; acc168.total += r168.total; }
    }
    if (acc24.total > 0 || acc168.total > 0) {
      const a24 = acc24.total > 0 ? acc24.correct / acc24.total : null;
      const a168 = acc168.total > 0 ? acc168.correct / acc168.total : null;
      if (a24 != null && (a168 == null || a24 >= a168)) return { label: horizonLabel(1), days: 1, basis: 'historical' };
      if (a168 != null) return { label: horizonLabel(7), days: 7, basis: 'historical' };
    }
  }

  let wSum = 0, hSum = 0;
  for (const t of active) {
    const meta = TECHNIQUE_META[t.id];
    if (!meta) continue;
    wSum += t.w; hSum += t.w * meta.horizonDays;
  }
  if (!wSum) return null;
  const days = hSum / wSum;
  return { label: horizonLabel(days), days, basis: 'methodology' };
}

// Realized daily volatility (stdev of daily pct returns, over the trailing
// `lookback` days), expressed as a percentage. Purely a statistical
// property of the asset's own price history already being fetched — no
// new data source, and not subject to the cross-technique correlation
// problem since it never touches technique votes at all.
export function realizedVolPct(closes, lookback = 30) {
  if (!closes || closes.length < 10) return null;
  const window = closes.slice(-(lookback + 1));
  const rets = [];
  for (let i = 1; i < window.length; i++) {
    if (window[i - 1]) rets.push((window[i] / window[i - 1] - 1) * 100);
  }
  if (rets.length < 5) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
  return Math.sqrt(variance);
}

// How many trailing days of an asset's own history give the best-calibrated
// volatility estimate — not "which lookback gives the widest or narrowest
// band" but "which lookback's implied stdev is actually the right size,"
// checked the standard way volatility models get backtested: for a
// correctly-calibrated stdev estimate, the realized move divided by that
// stdev, squared, should average to 1.0 across many observations (a
// squared standardized residual, mean 1 by construction whenever the
// stdev estimate is right; above 1 means the estimate was too small —
// realized moves are bigger than implied — below 1 means too large). This
// uses every test point's full magnitude rather than collapsing it to a
// yes/no "was it inside the band" flag, which matters in practice — an
// early version of this scored plain in/out-of-band coverage against the
// usual ~68% one-stdev target instead, and empirically it was dominated by
// sampling noise at the sample sizes an asset's real history actually
// gives (crypto's 365-day cap leaves only a few hundred test points at
// best): candidates that should have clearly differed in a synthetic
// regime-shift test instead came back within noise of each other. Mean
// squared standardized residual discriminates far more cleanly at the
// same sample sizes, confirmed on the same synthetic tests.
//
// A too-short lookback is noisy and whipsaws; a too-long one smooths over
// a real regime change; this picks whichever candidate actually calibrates
// best against this specific asset's own realized history, walked with no
// lookahead (every test point's vol estimate uses only data available up
// to that point).
//
// This is a within-run backtest over price history already being fetched,
// deliberately distinct from (and much faster-feedback than) the live
// evaluateMatured() reliability loop: it doesn't need to wait weeks for
// matured outcomes to accumulate, it recomputes fresh every build from
// whatever history currently exists, and it naturally adapts as more
// history accrues or the asset's own volatility regime shifts. Falls back
// to null — the fixed default lookback stays in effect — for an asset too
// young to have enough history to test at all, same "abstain rather than
// guess" pattern as everywhere else in this engine.
const VOL_LOOKBACK_CANDIDATES = [10, 20, 30, 60, 90];
const VOL_LOOKBACK_HORIZON_DAYS = 7; // calibrate against the standard weekly risk horizon
const MIN_BACKTEST_SAMPLES = 40;

export function bestVolLookback(
  closes,
  candidates = VOL_LOOKBACK_CANDIDATES,
  horizonDays = VOL_LOOKBACK_HORIZON_DAYS
) {
  if (!closes) return null;
  const maxLookback = Math.max(...candidates);
  const firstTestIdx = maxLookback + 1;
  const lastTestIdx = closes.length - horizonDays - 1;
  if (lastTestIdx - firstTestIdx < MIN_BACKTEST_SAMPLES) return null;

  let best = null;
  for (const lookback of candidates) {
    let sumSq = 0, total = 0;
    for (let i = firstTestIdx; i <= lastTestIdx; i++) {
      const vol = realizedVolPct(closes.slice(0, i + 1), lookback);
      if (vol == null || !(vol > 0)) continue;
      const impliedMove = vol * Math.sqrt(horizonDays);
      const actualMovePct = ((closes[i + horizonDays] / closes[i]) - 1) * 100;
      total++;
      sumSq += (actualMovePct / impliedMove) ** 2;
    }
    if (total < MIN_BACKTEST_SAMPLES) continue;
    const meanSqResidual = sumSq / total;
    const distance = Math.abs(meanSqResidual - 1);
    if (!best || distance < best.distance) best = { lookback, meanSqResidual, samples: total, distance };
  }
  if (!best) return null;
  return { lookback: best.lookback, meanSqResidual: best.meanSqResidual, samples: best.samples };
}

// How long an asset has been sitting at its own extreme, not just whether
// it currently is. A fresh one-day touch of a high and a multi-week base
// at the same level are different setups — this distinguishes them
// directly from the real historical closes already being fetched, no new
// data source. `lookback` bounds the "N-bar high/low" (up to ~365 daily
// bars = a real 52-week range, not just whatever the shorter crypto
// sparkline covers).
export function dwellAtExtreme(closes, lookback = 252, bandPct = 5) {
  if (!closes || closes.length < 20) return null;
  const window = closes.slice(-lookback);
  const hi = Math.max(...window), lo = Math.min(...window);
  const price = closes[closes.length - 1];
  const nearHigh = hi > 0 && price >= hi * (1 - bandPct / 100);
  const nearLow = lo > 0 && price <= lo * (1 + bandPct / 100);
  if (!nearHigh && !nearLow) return { dir: 0, days: 0 };
  const dir = nearHigh ? 1 : -1;
  const threshold = nearHigh ? hi * (1 - bandPct / 100) : lo * (1 + bandPct / 100);
  let days = 0;
  for (let i = closes.length - 1; i >= 0; i--) {
    const within = dir === 1 ? closes[i] >= threshold : closes[i] <= threshold;
    if (!within) break;
    days++;
  }
  return { dir, days };
}

// Pearson correlation of daily returns against a benchmark (BTC for
// crypto, SPY for equities) over the trailing `lookback` days — is this
// asset moving with the market right now, or on its own? An asset
// decoupling from a market that's still trending is a different setup
// than one just riding the market's own move.
export function correlationWithBenchmark(closes, benchCloses, lookback = 30) {
  if (!closes || !benchCloses || closes.length < 2 || benchCloses.length < 2) return null;
  const retsOf = (series) => {
    const out = [];
    for (let i = 1; i < series.length; i++) if (series[i - 1]) out.push(series[i] / series[i - 1] - 1);
    return out;
  };
  const retsA = retsOf(closes), retsB = retsOf(benchCloses);
  const n = Math.min(retsA.length, retsB.length, lookback);
  if (n < 10) return null;
  const a = retsA.slice(-n), b = retsB.slice(-n);
  const meanA = a.reduce((x, y) => x + y, 0) / n, meanB = b.reduce((x, y) => x + y, 0) / n;
  let cov = 0, varA = 0, varB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA, db = b[i] - meanB;
    cov += da * db; varA += da * da; varB += db * db;
  }
  if (varA === 0 || varB === 0) return null;
  return cov / Math.sqrt(varA * varB);
}

// Does this asset's own price history contain a period that behaved like
// its last `windowDays`, roughly one or more "years" (cycleLength bars —
// 365 for continuously-traded crypto, ~252 trading days for equities) ago?
// If so, what happened in the `forwardDays` right after that analog period
// is a genuine, data-grounded forward hint, distinct from anything the
// other techniques compute — most assets are too young to have any
// candidate years at all (returns null, not a guess), and a real 5-6 year
// history is really only common for the oldest large-caps (BTC, ETH,
// long-listed equities). Uses the exact same correlation math as
// correlationWithBenchmark, just against the asset's own past instead of a
// different asset, and requires a real resemblance (|corr| >= 0.5) before
// it counts at all — with only a handful of candidate years to compare
// against, a looser bar would just be fitting noise.
export function seasonalAnalog(closes, cycleLength, windowDays = 90, forwardDays = 7, maxCycles = 6) {
  if (!closes || closes.length < cycleLength + windowDays + forwardDays) return null;
  const currentWindow = closes.slice(-windowDays);
  let best = null;
  for (let cycle = 1; cycle <= maxCycles; cycle++) {
    const anchor = closes.length - cycle * cycleLength; // "cycle years ago" from now, in bars
    const start = anchor - windowDays;
    const forwardEnd = anchor + forwardDays;
    if (start < 0 || forwardEnd > closes.length) continue;
    const pastWindow = closes.slice(start, anchor);
    if (pastWindow.length < windowDays || !closes[anchor]) continue;
    const corr = correlationWithBenchmark(currentWindow, pastWindow, windowDays - 1);
    if (corr == null) continue;
    if (!best || Math.abs(corr) > Math.abs(best.corr)) {
      const forwardReturnPct = ((closes[forwardEnd] / closes[anchor]) - 1) * 100;
      best = { cycle, corr, forwardReturnPct };
    }
  }
  if (!best || Math.abs(best.corr) < 0.5) return null;
  const dir = best.forwardReturnPct > 0.5 ? 1 : best.forwardReturnPct < -0.5 ? -1 : 0;
  return { cycle: best.cycle, corr: best.corr, forwardReturnPct: best.forwardReturnPct, dir };
}

// Surfaces "this asset leans on certain indicators more than others" —
// the best individually-proven technique for this specific asset, once
// one exists with enough of its own matured history to trust (same bar as
// reliabilityMultiplier/horizonEstimate). Returns null, not a guess, until
// then.
export function topIndicator(reliability, symbol) {
  if (!reliability) return null;
  let best = null;
  for (const id of Object.keys(TECHNIQUE_META)) {
    const rec = reliability[`${symbol}|${id}`];
    if (rec && rec.total >= MIN_RELIABILITY_SAMPLES && (!best || rec.accuracy > best.accuracy)) {
      best = { id, accuracy: rec.accuracy, total: rec.total };
    }
  }
  return best;
}

// A single track-record score out of 100 for this asset, pooling three
// kinds of matured, falsifiable calls this engine actually makes:
//  - "composite": did price move in the direction the overall confluence
//    score called, by the horizon's end (technique_id 'composite', logged
//    once per asset per run in rankBoards).
//  - "reversal"/"dwell": did the two pivot-style techniques' calls pan
//    out — reused directly from their existing per-technique reliability
//    rows rather than logging a separate synthetic vote, since they
//    already are exactly "this asset is at/near an extreme and about to
//    turn" calls.
//  - range containment: was the realized price actually inside the
//    predicted [low, high] band at maturity (range_reliability, pooled
//    across both horizons by loadRangeReliability).
// Pooled by raw sample count rather than a hand-picked weighting across
// the three (e.g. "40% direction, 30% range, 30% pivot") — an arbitrary
// split would itself be a fabricated-precision choice; treating every
// matured prediction as one equally-weighted vote is the plain, honest
// default. Returns null below MIN_RELIABILITY_SAMPLES pooled outcomes —
// "a reasonable number of predictions" before a score means anything,
// the same bar every other reliability read in this engine uses.
export function assetPredictionScore(symbol, reliability, rangeReliability) {
  const pick = (techniqueId) => {
    const rec = reliability && reliability[`${symbol}|${techniqueId}`];
    return rec && rec.total ? { correct: rec.correct, total: rec.total } : { correct: 0, total: 0 };
  };
  const composite = pick('composite');
  const reversal = pick('reversal');
  const dwell = pick('dwell');
  const range = (rangeReliability && rangeReliability[symbol]) || { hits: 0, total: 0 };

  const totalCorrect = composite.correct + reversal.correct + dwell.correct + range.hits;
  const totalCount = composite.total + reversal.total + dwell.total + range.total;
  if (totalCount < MIN_RELIABILITY_SAMPLES) return null;
  return { score: Math.round(100 * totalCorrect / totalCount), samples: totalCount };
}

// Expected price range for the horizon estimate above — a band, never a
// point figure, and its width comes from real volatility (this asset's own
// historical realized move size at this horizon once there's enough of
// its own history logged via evaluateMatured, falling back to its recent
// realized daily volatility scaled by the square root of time, the
// standard random-walk approximation, until then). The band's center
// shifts modestly toward the called direction only once the score shows
// real conviction (score <= 50 gives a symmetric band with no directional
// assumption at all), and the shift is capped well inside the band so it
// never collapses into a false point prediction.
export function predictedRange(price, horizonDays, score, dir, moveStats, symbol, fallbackVolPct) {
  if (price == null || horizonDays == null || !dir) return null;
  const bucket = horizonDays <= 4 ? 24 : 168;
  const learned = moveStats && moveStats[`${symbol}|${bucket}`];
  let movePct, basis;
  if (learned && learned.n >= MIN_RELIABILITY_SAMPLES && learned.stdevPct > 0) {
    movePct = learned.stdevPct;
    basis = 'historical';
  } else if (fallbackVolPct != null) {
    movePct = fallbackVolPct * Math.sqrt(Math.max(horizonDays, 0.5));
    basis = 'methodology';
  } else {
    return null;
  }
  if (!(movePct > 0)) return null;
  const conviction = clamp((score - 50) / 50, 0, 1) * 0.5; // 0 at score<=50, up to 0.5x the band width at score=100
  const driftPct = dir * conviction * movePct;
  return {
    low: price * (1 + (driftPct - movePct) / 100),
    high: price * (1 + (driftPct + movePct) / 100),
    basis
  };
}

export function evaluateTechniques(m, kind, reliability, marketContext) {
  const T = [];
  const push = (id, w, dir, note) => T.push({ id, w: w * reliabilityMultiplier(reliability, m.symbol, id), dir, note });
  const cS = m.chgShort, c24 = m.chg24h, c7 = m.chg7d, c30 = m.chg30d;

  // T1 multi-horizon momentum
  if (c24 != null && c7 != null) {
    const s = cS ?? c24;
    if (s >= 0 && c24 >= 0 && c7 > 1) push('momentum', 1.2, 1, 'momentum aligned across horizons');
    else if (s <= 0 && c24 <= 0 && c7 < -1) push('momentum', 1.2, -1, 'momentum negative across horizons');
    else push('momentum', 1.2, 0, null);
  } else push('momentum', 1.2, null, null);

  // T2 RSI regime + direction
  if (m.rsi != null) {
    const rising = m.rsiPrev != null ? m.rsi > m.rsiPrev : null;
    if (m.rsi >= 80) push('rsi', 1.2, -1, `RSI ${m.rsi.toFixed(0)} extreme`);
    else if (m.rsi >= 70) push('rsi', 1.2, -1, `RSI ${m.rsi.toFixed(0)} overbought`);
    else if (m.rsi < 30 && (c24 ?? 0) > 0) push('rsi', 1.2, 1, `RSI ${m.rsi.toFixed(0)} washed out, turning`);
    else if (m.rsi >= 40 && m.rsi <= 65 && rising !== false) push('rsi', 1.2, 1, `RSI ${m.rsi.toFixed(0)} rebuilding`);
    else if (m.rsi < 40 && rising === false) push('rsi', 1.2, -1, `RSI ${m.rsi.toFixed(0)} sinking`);
    else push('rsi', 1.2, 0, null);
  } else push('rsi', 1.2, null, null);

  // T3 MACD
  if (m.macdHist != null && m.macdPrevHist != null) {
    if (m.macdHist > 0 && m.macdHist >= m.macdPrevHist) push('macd', 1.0, 1, 'MACD histogram rising');
    else if (m.macdHist < 0 && m.macdHist <= m.macdPrevHist) push('macd', 1.0, -1, 'MACD histogram falling');
    else if (m.macdHist < m.macdPrevHist && m.rsi != null && m.rsi > 65) push('macd', 1.0, -1, 'MACD rolling over while hot');
    else push('macd', 1.0, 0, null);
  } else push('macd', 1.0, null, null);

  // T4 moving-average structure. Crypto gets the real SMA20/50/200 stack
  // too now, when getCryptoDailyHistory succeeded for that coin (same
  // branch as stocks); falls back to the coarser 7-day-mean check otherwise.
  if ((kind === 'stock' || kind === 'crypto') && m.sma20 != null && m.sma50 != null) {
    const above200 = m.sma200 != null ? m.price > m.sma200 : true;
    if (m.price > m.sma20 && m.sma20 > m.sma50 && above200) push('ma', 1.0, 1, 'price > SMA20 > SMA50 stack');
    else if (m.price < m.sma20 && m.sma20 < m.sma50) push('ma', 1.0, -1, 'below falling MA stack');
    else push('ma', 1.0, 0, null);
  } else if (kind === 'crypto' && m.mean7d != null) {
    if (m.price > m.mean7d && (m.slope ?? 0) > 0) push('ma', 1.0, 1, 'above 7d mean, slope up');
    else if (m.price < m.mean7d && (m.slope ?? 0) < 0) push('ma', 1.0, -1, 'below 7d mean, slope down');
    else push('ma', 1.0, 0, null);
  } else push('ma', 1.0, null, null);

  // T5 Bollinger
  if (m.bb) {
    if (m.bb.pctB > 1.05) push('bollinger', 0.8, -1, 'closed outside upper band');
    else if (m.bb.pctB >= 0.55 && m.bb.pctB <= 1.0 && m.bb.expanding) push('bollinger', 0.8, 1, m.bb.squeezed ? 'squeeze releasing upward' : 'riding upper band, bands expanding');
    else if (m.bb.pctB < 0.05 && (c24 ?? 0) > 0) push('bollinger', 0.8, 1, 'reversal off lower band');
    else if (m.bb.pctB < 0.3 && (c24 ?? 0) < 0) push('bollinger', 0.8, -1, 'pressing lower band');
    else push('bollinger', 0.8, 0, null);
  } else push('bollinger', 0.8, null, null);

  // T6 stochastic
  if (m.stoch) {
    if (m.stoch.crossUp && m.stoch.k < 45) push('stoch', 0.8, 1, 'stochastic cross up from lows');
    else if (m.stoch.crossDown && m.stoch.k > 60) push('stoch', 0.8, -1, 'stochastic cross down from highs');
    else if (m.stoch.k > m.stoch.d && m.stoch.k >= 40 && m.stoch.k <= 82) push('stoch', 0.8, 1, null);
    else if (m.stoch.k < m.stoch.d && m.stoch.k > 75) push('stoch', 0.8, -1, null);
    else push('stoch', 0.8, 0, null);
  } else push('stoch', 0.8, null, null);

  // T7 Donchian 20 breakout / breakdown
  if (m.donchianHi != null && m.donchianLo != null) {
    if (m.price > m.donchianHi) push('range', 1.0, 1, 'fresh 20-bar breakout');
    else if (m.price >= m.donchianHi * 0.97) push('range', 1.0, 1, 'pressing 20-bar high');
    else if (m.price < m.donchianLo) push('range', 1.0, -1, 'fresh 20-bar breakdown');
    else if (m.price <= m.donchianLo * 1.03) push('range', 1.0, -1, 'pressing 20-bar low');
    else push('range', 1.0, 0, null);
  } else push('range', 1.0, null, null);

  // T8 volume confirmation
  if (m.volRatio != null) {
    if (m.volRatio >= 1.3 && (c24 ?? 0) > 0 && (m.rsi ?? 50) < 75) push('volume', 1.0, 1, `volume ${m.volRatio.toFixed(1)}x baseline on strength`);
    else if (m.volRatio >= 2.5 && ((m.rangePos ?? 0) > 0.85 || (c24 ?? 0) < 0)) push('volume', 1.0, -1, `volume climax ${m.volRatio.toFixed(1)}x`);
    else if (m.volRatio >= 1.5 && (c24 ?? 0) < 0) push('volume', 1.0, -1, 'heavy volume on weakness');
    else push('volume', 1.0, 0, null);
  } else push('volume', 1.0, null, null);

  // T9 OBV. Stocks always have per-bar volume; crypto only has it when
  // getCryptoDailyHistory succeeded (m.obv is null otherwise, so this
  // abstains cleanly on the sparkline-fallback path, same as any other
  // technique with insufficient data).
  if (m.obv != null) {
    if (m.obv > 0.5 && (c7 ?? 0) > 0) push('obv', 0.8, 1, 'OBV confirming');
    else if (m.obv < -0.5 && (c7 ?? 0) > 2) push('obv', 0.8, -1, 'OBV diverging from price');
    else if (m.obv < -0.5 && (c7 ?? 0) < 0) push('obv', 0.8, -1, 'distribution in volume');
    else push('obv', 0.8, 0, null);
  } else push('obv', 0.8, null, null);

  // T10 swing structure
  if (m.structure != null) {
    if (m.structure === 1) push('structure', 1.0, 1, 'higher highs and higher lows');
    else if (m.structure === -1) push('structure', 1.0, -1, 'lower highs and lower lows');
    else push('structure', 1.0, 0, null);
  } else push('structure', 1.0, null, null);

  // T11 divergence proxy
  if (m.divergence != null) {
    if (m.divergence === -1) push('divergence', 0.9, -1, 'new highs without momentum support');
    else if (m.divergence === 1) push('divergence', 0.9, 1, 'new lows rejected by momentum');
    else push('divergence', 0.9, 0, null);
  } else push('divergence', 0.9, null, null);

  // T12 volatility regime
  if (m.volReg != null) {
    const bigMove = kind === 'crypto' ? 20 : 10;
    if (m.volReg < 0.7 && (m.rangePos ?? 0) > 0.6) push('volatility', 0.7, 1, 'volatility compressed near highs (coiled)');
    else if (m.volReg > 2.2 && (c7 ?? 0) > bigMove) push('volatility', 0.7, -1, 'climactic volatility expansion');
    else push('volatility', 0.7, 0, null);
  } else push('volatility', 0.7, null, null);

  // T13 valuation / positioning
  if (kind === 'stock') {
    if (m.val && m.val.upside != null) {
      if (m.val.upside >= 12 && (m.val.recMean == null || m.val.recMean <= 2.6)) push('valuation', 1.1, 1, `${m.val.upside.toFixed(0)}% below consensus target`);
      else if (m.val.upside <= -5) push('valuation', 1.1, -1, `${Math.abs(m.val.upside).toFixed(0)}% above consensus target`);
      else if (m.val.recMean != null && m.val.recMean >= 3.6) push('valuation', 1.1, -1, 'street rated underperform');
      else push('valuation', 1.1, 0, null);
    } else push('valuation', 1.1, null, null);
  } else {
    const f = m.funding;
    const bigMove = 20;
    if (f != null) {
      if (f >= 0.0005 && (c7 ?? 0) > bigMove) push('positioning', 1.0, -1, `crowded longs, funding ${(f * 100).toFixed(3)}%`);
      else if (f <= 0 && (c7 ?? 0) > 0) push('positioning', 1.0, 1, 'rally with skeptical funding');
      else if (f >= 0.0008) push('positioning', 1.0, -1, 'extreme positive funding');
      else push('positioning', 1.0, 0, null);
    } else push('positioning', 1.0, null, null);
    if (m.trending) {
      if ((m.rsi ?? 50) >= 72) push('attention', 0.6, -1, 'trending list + overbought = crowded');
      else if ((m.rsi ?? 50) >= 40 && (m.rsi ?? 50) <= 65) push('attention', 0.6, 1, 'attention building, not stretched');
      else push('attention', 0.6, 0, null);
    }
  }

  // T14 reversal: not a static RSI level ("RSI < 30") but a genuine
  // trough-and-turn or peak-and-turn pattern — RSI actually bottomed or
  // topped over the recent window and has started reversing back — and it
  // never fires on RSI alone. At least one independent signal (stochastic
  // cross, a Bollinger band extreme, swing structure, OBV, or the
  // divergence proxy) has to agree before this votes. Market-wide
  // sentiment (Fear & Greed for crypto, where VIX sits in its own recent
  // range for equities — both fetched already but otherwise unused in any
  // per-asset scoring) doesn't create the signal, it just adds weight when
  // it lines up: an asset-level bottom during broad capitulation is a more
  // reliable read than the same pattern in isolation.
  const troughedAndTurning = m.rsiRecentMin != null && m.rsi != null && m.rsiPrev != null
    && m.rsiRecentMin < 32 && m.rsi > m.rsiRecentMin + 5 && m.rsi > m.rsiPrev;
  const peakedAndTurning = m.rsiRecentMax != null && m.rsi != null && m.rsiPrev != null
    && m.rsiRecentMax > 68 && m.rsi < m.rsiRecentMax - 5 && m.rsi < m.rsiPrev;
  const bullConfirm = (m.stoch && m.stoch.crossUp)
    || (m.bb && m.bb.pctB < 0.1)
    || m.structure === 1
    || m.divergence === 1
    || (m.obv != null && m.obv > 0);
  const bearConfirm = (m.stoch && m.stoch.crossDown)
    || (m.bb && m.bb.pctB > 0.9)
    || m.structure === -1
    || m.divergence === -1
    || (m.obv != null && m.obv < 0);

  if (troughedAndTurning && bullConfirm) {
    let w = 1.1, note = `RSI bottomed near ${m.rsiRecentMin.toFixed(0)}, turning up`;
    if (kind === 'crypto' && marketContext && marketContext.fearGreed != null && marketContext.fearGreed <= 25) {
      w += 0.3; note = 'oversold bottom + market-wide extreme fear';
    } else if (kind === 'stock' && marketContext && marketContext.vixRangePos != null && marketContext.vixRangePos >= 0.7) {
      w += 0.3; note = 'oversold bottom + VIX spiking';
    }
    push('reversal', w, 1, note);
  } else if (peakedAndTurning && bearConfirm) {
    let w = 1.1, note = `RSI topped near ${m.rsiRecentMax.toFixed(0)}, turning down`;
    if (kind === 'crypto' && marketContext && marketContext.fearGreed != null && marketContext.fearGreed >= 75) {
      w += 0.3; note = 'overbought top + market-wide extreme greed';
    } else if (kind === 'stock' && marketContext && marketContext.vixRangePos != null && marketContext.vixRangePos <= 0.3) {
      w += 0.3; note = 'overbought top + VIX complacent';
    }
    push('reversal', w, -1, note);
  } else if (m.rsiRecentMin != null && m.rsiRecentMax != null) {
    push('reversal', 1.1, 0, null);
  } else {
    push('reversal', 1.1, null, null);
  }

  // T15 dwell: not just "is this asset at an extreme" but "how long has it
  // been coiled there" — a fresh one-day touch and a multi-week base at
  // the same level are different setups. Long dwell at a low, especially
  // while decoupled from the broader market (its own move, not just
  // riding the market down), is treated as stored energy for a bounce —
  // classic accumulation-at-lows/distribution-at-highs — and the mirror
  // case at highs. This is a prior, not a certainty: it starts at a
  // modest weight and the adaptive-weighting loop corrects it per asset
  // from real outcomes exactly like every other technique here, so if
  // dwell-at-lows turns out to actually predict further downside for a
  // specific asset, its weight (and the reversal direction it's paired
  // with) gets pushed down for that asset over time, not just left wrong.
  const MIN_DWELL_DAYS = 5;
  if (m.dwell && m.dwell.dir !== 0 && m.dwell.days >= MIN_DWELL_DAYS) {
    const decoupled = m.corr != null && Math.abs(m.corr) < 0.3;
    const w = decoupled ? 1.0 : 0.7;
    if (m.dwell.dir === -1) push('dwell', w, 1, `coiled near its own long-run low for ${m.dwell.days}d${decoupled ? ', decoupled from the broader market' : ''}`);
    else push('dwell', w, -1, `coiled near its own long-run high for ${m.dwell.days}d${decoupled ? ', decoupled from the broader market' : ''}`);
  } else if (m.dwell) {
    push('dwell', 0.8, 0, null);
  } else {
    push('dwell', 0.8, null, null);
  }

  // T16 seasonal: does this asset's own history contain a period that
  // looks like where it is right now (roughly a year, or several years,
  // ago), and if so what happened next back then? Only fires when there's
  // a real resemblance (seasonalAnalog already gates on correlation
  // strength) — most assets are too young to have any candidate years at
  // all, which is the common case, not an error.
  if (m.seasonal) {
    const conf = clamp((Math.abs(m.seasonal.corr) - 0.5) / 0.5, 0, 1); // 0 right at the 0.5 gate, 1 at a perfect match
    const w = 0.7 + 0.4 * conf;
    const cycleLabel = m.seasonal.cycle === 1 ? 'last year' : `${m.seasonal.cycle} years ago`;
    if (m.seasonal.dir === 1) push('seasonal', w, 1, `resembles ${cycleLabel}'s pattern, which rallied next`);
    else if (m.seasonal.dir === -1) push('seasonal', w, -1, `resembles ${cycleLabel}'s pattern, which fell next`);
    else push('seasonal', w, 0, null);
  } else {
    push('seasonal', 0.9, null, null);
  }

  return T;
}

export function confluence(m, kind, reliability, marketContext, reliabilityByHorizon) {
  const T = evaluateTechniques(m, kind, reliability, marketContext);
  const applicable = T.filter(t => t.dir !== null);
  const totalW = applicable.reduce((a, t) => a + t.w, 0) || 1;
  let bullW = 0, bearW = 0, bullN = 0, bearN = 0;
  for (const t of applicable) {
    if (t.dir === 1) { bullW += t.w; bullN++; }
    else if (t.dir === -1) { bearW += t.w; bearN++; }
  }
  let long = 100 * (bullW - 0.5 * bearW) / totalW;
  let short = 100 * (bearW - 0.5 * bullW) / totalW;

  // Two documented kickers for setup extremity.
  const huge = kind === 'crypto' ? 45 : 22;
  if ((m.chg30d ?? 0) < -15 && (m.chg7d ?? 0) > 0 && (m.rsi ?? 50) < 55) long += 8;
  if ((m.chg7d ?? 0) >= huge) short += 10;

  const notes = (dir) => applicable
    .filter(t => t.dir === dir && t.note)
    .sort((a, b) => b.w - a.w)
    .slice(0, 3)
    .map(t => t.note);

  return {
    long: clamp(Math.round(long)),
    short: clamp(Math.round(short)),
    bull: bullN,
    bear: bearN,
    total: applicable.length,
    longNotes: notes(1),
    shortNotes: notes(-1),
    longHorizon: horizonEstimate(applicable, 1, m.symbol, reliabilityByHorizon),
    shortHorizon: horizonEstimate(applicable, -1, m.symbol, reliabilityByHorizon),
    // Directional-only (dir 0/null are not falsifiable predictions), for
    // scripts/reliability.mjs to log and later score against actual outcomes.
    // Not part of the served payload — rankBoards/buildPayload strip this
    // into a separate log structure before the payload goes to KV.
    votes: applicable.filter(t => t.dir === 1 || t.dir === -1).map(t => ({ id: t.id, dir: t.dir }))
  };
}

// One directional read per asset, distinct from the long/short pair above
// (those are independent bullish-lean/bearish-lean scores, not a
// complementary pair — an asset can score high on both at once). This is
// "which way does this asset's confluence actually point, if either,"
// used to log a single composite vote per asset per run and to size its
// logged range prediction (see rankBoards) — the basis for the per-asset
// track record surfaced once enough of these have matured. Null when
// neither side leads: an exact tie carries no falsifiable direction to
// log, same abstain logic as any per-technique vote.
export function compositeCall(c) {
  if (!c || c.long === c.short) return null;
  return c.long > c.short ? { dir: 1, score: c.long } : { dir: -1, score: c.short };
}

// ----------------------------- FETCH HELPERS --------------------------------

async function fetchWithTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...opts,
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, 'Accept': 'application/json,text/plain,*/*', ...(opts.headers || {}) }
    });
  } finally {
    clearTimeout(t);
  }
}

async function fetchJson(url, opts) {
  const res = await fetchWithTimeout(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url.slice(0, 80)}`);
  return res.json();
}

async function fetchText(url, opts) {
  const res = await fetchWithTimeout(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url.slice(0, 80)}`);
  return res.text();
}

export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx]); }
      catch (e) { out[idx] = { _error: String((e && e.message) || e), _item: items[idx] }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

// Batched-with-pauses pool, distinct from pool() above: CoinGecko's free
// public tier has no documented per-minute rate limit, and issuing ~100
// per-coin history calls at plain concurrency risks silent 429s. This trades
// a slower build (still fine under GitHub Actions, no wall-clock pressure
// like a Worker request has) for staying well under any plausible limit.
export async function poolPaced(items, batchSize, delayMs, fn) {
  const out = new Array(items.length);
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const results = await Promise.all(batch.map((item) =>
      fn(item).catch((e) => ({ _error: String((e && e.message) || e), _item: item }))
    ));
    for (let j = 0; j < results.length; j++) out[i + j] = results[j];
    if (i + batchSize < items.length) await new Promise((r) => setTimeout(r, delayMs));
  }
  return out;
}

// ----------------------------- DATA SOURCES ---------------------------------

async function getCryptoMarkets() {
  const url = 'https://api.coingecko.com/api/v3/coins/markets'
    + `?vs_currency=usd&order=market_cap_desc&per_page=${CRYPTO_UNIVERSE}&page=1`
    + '&sparkline=true&price_change_percentage=1h,24h,7d,30d';
  return fetchJson(url);
}

// Real daily bars (close + volume) per coin, so crypto's indicators mean the
// same thing they do for equities — "RSI(14)" computed off 14 hourly points
// (the old sparkline-only approach) is a materially different, noisier
// number than the conventional daily RSI(14). Free tier auto-returns daily
// granularity for days > 90; https://docs.coingecko.com/reference/coins-id-market-chart.
//
// Retries on 429 specifically (with backoff): CI runners share IP ranges
// that are already heavily used against CoinGecko's free tier, so a burst
// of ~100 per-coin calls is more likely to get rate-limited here than the
// same calls from an arbitrary residential IP — worth one or two retries
// before giving up and falling back to the 7-day sparkline for that coin.
export async function getCryptoDailyHistory(id, days = CRYPTO_HISTORY_DAYS) {
  const url = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(id)}/market_chart`
    + `?vs_currency=usd&days=${days}&interval=daily`;
  const backoffsMs = [3000, 6000];
  let lastErr;
  for (let attempt = 0; attempt <= backoffsMs.length; attempt++) {
    try {
      const j = await fetchJson(url);
      const closes = ((j && j.prices) || []).map((p) => p[1]).filter((v) => v != null);
      const vols = ((j && j.total_volumes) || []).map((v) => v[1]).filter((v) => v != null);
      if (closes.length < 60) throw new Error(`thin daily history for ${id}`);
      return { closes, volumes: vols.length === closes.length ? vols : null };
    } catch (e) {
      lastErr = e;
      const is429 = /^HTTP 429/.test(String(e && e.message));
      if (!is429 || attempt === backoffsMs.length) break;
      await new Promise((r) => setTimeout(r, backoffsMs[attempt]));
    }
  }
  throw lastErr;
}

// Live spot price + 24h change for a batch of CoinGecko ids in one call —
// used by the /api/prices route for between-build price ticks, distinct
// from getCryptoMarkets (which the hourly build uses for the full metrics
// set). Never throws on a bad/missing id: just omits it from the result,
// since one delisted or renamed id shouldn't take down every other price.
async function coingeckoSimplePrice(ids) {
  if (!ids.length) return {};
  const url = 'https://api.coingecko.com/api/v3/simple/price'
    + `?ids=${ids.map(encodeURIComponent).join(',')}&vs_currencies=usd&include_24hr_change=true`;
  const j = await fetchJson(url);
  const out = {};
  for (const id of ids) {
    const v = j && j[id];
    if (v && v.usd != null) out[id] = { price: v.usd, chg24h: v.usd_24h_change != null ? v.usd_24h_change : null };
  }
  return out;
}

async function getGlobal() {
  const j = await fetchJson('https://api.coingecko.com/api/v3/global');
  const d = j && j.data;
  if (!d) return null;
  return {
    total_mcap: d.total_market_cap && d.total_market_cap.usd,
    mcap_chg24h: d.market_cap_change_percentage_24h_usd,
    btc_dominance: d.market_cap_percentage && d.market_cap_percentage.btc
  };
}

async function getFearGreed() {
  const j = await fetchJson('https://api.alternative.me/fng/?limit=1');
  const d = j && j.data && j.data[0];
  return d ? { value: Number(d.value), label: d.value_classification } : null;
}

async function getTrending() {
  const j = await fetchJson('https://api.coingecko.com/api/v3/search/trending');
  const set = new Set();
  for (const c of (j && j.coins) || []) {
    if (c.item && c.item.symbol) set.add(c.item.symbol.toUpperCase());
  }
  return set;
}

// Bybit linear perp tickers: one call returns funding for every USDT perp.
async function getFundingMap() {
  const j = await fetchJson('https://api.bybit.com/v5/market/tickers?category=linear');
  const map = {};
  for (const t of (j && j.result && j.result.list) || []) {
    if (t.symbol && t.symbol.endsWith('USDT') && t.fundingRate !== undefined) {
      const base = t.symbol.slice(0, -4);
      const f = parseFloat(t.fundingRate);
      if (Number.isFinite(f)) map[base] = f;
    }
  }
  if (!Object.keys(map).length) throw new Error('empty funding map');
  return map;
}

async function yahooDaily(symbol, range = '1y') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`
    + `?range=${range}&interval=1d&includePrePost=false&events=div%2Csplit`;
  const j = await fetchJson(url);
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  if (!r || !r.timestamp) throw new Error(`empty chart for ${symbol}`);
  const q = r.indicators.quote[0];
  const closes = [], volumes = [], highs = [], lows = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    if (q.close[i] != null) {
      closes.push(q.close[i]);
      volumes.push(q.volume[i] || 0);
      highs.push(q.high[i] != null ? q.high[i] : q.close[i]);
      lows.push(q.low[i] != null ? q.low[i] : q.close[i]);
    }
  }
  const price = (r.meta && r.meta.regularMarketPrice) || closes[closes.length - 1];
  return { symbol, price, closes, volumes, highs, lows, source: 'yahoo' };
}

// Live spot price + 24h change for one equity symbol — the same chart
// endpoint yahooDaily uses, but the smallest request that still returns a
// fresh meta.regularMarketPrice (no need for a year of daily bars just to
// read today's tick). Used by /api/prices, called once per displayed
// symbol in parallel (see pool() at the call site), not per build.
async function yahooQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`;
  const j = await fetchJson(url);
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  const meta = r && r.meta;
  if (!meta || meta.regularMarketPrice == null) throw new Error(`no live quote for ${symbol}`);
  const prevClose = meta.previousClose != null ? meta.previousClose : meta.chartPreviousClose;
  const price = meta.regularMarketPrice;
  return { symbol, price, chg24h: prevClose ? ((price / prevClose) - 1) * 100 : null };
}

async function stooqDaily(symbol) {
  const s = symbol.toLowerCase().replace('^', '') + '.us';
  const txt = await fetchText(`https://stooq.com/q/d/l/?s=${s}&i=d`);
  const rows = txt.trim().split('\n').slice(1);
  if (rows.length < 60) throw new Error(`stooq thin for ${symbol}`);
  const closes = [], volumes = [], highs = [], lows = [];
  // ~10 years of trading days, matching the Yahoo path's '10y' fetch — the
  // Stooq fallback shouldn't quietly give seasonalAnalog() far less history.
  for (const row of rows.slice(-2600)) {
    const p = row.split(',');
    const c = parseFloat(p[4]);
    if (Number.isFinite(c)) {
      closes.push(c);
      highs.push(parseFloat(p[2]) || c);
      lows.push(parseFloat(p[3]) || c);
      volumes.push(parseFloat(p[5]) || 0);
    }
  }
  return { symbol, price: closes[closes.length - 1], closes, volumes, highs, lows, source: 'stooq' };
}

async function getStock(symbol) {
  // '10y', not the default '1y': seasonalAnalog() needs multiple years of
  // history to find calendar-analogous periods. Same single request either
  // way, just a longer response.
  try { return await yahooDaily(symbol, '10y'); }
  catch { return await stooqDaily(symbol); }
}

// ---- Yahoo analyst targets (quoteSummary needs a crumb + cookie handshake).
let _crumbCache = null; // { cookie, crumb, at } persists across warm invocations

async function getCrumb() {
  if (_crumbCache && Date.now() - _crumbCache.at < 6 * 3600 * 1000) return _crumbCache;
  const r1 = await fetchWithTimeout('https://fc.yahoo.com/', { redirect: 'manual' });
  let cookie = '';
  const getSetCookie = r1.headers.getSetCookie ? r1.headers.getSetCookie() : null;
  if (getSetCookie && getSetCookie.length) cookie = getSetCookie.map(c => c.split(';')[0]).join('; ');
  else {
    const raw = r1.headers.get('set-cookie');
    if (raw) cookie = raw.split(';')[0];
  }
  if (!cookie) throw new Error('no yahoo cookie');
  const crumb = (await fetchText('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: { Cookie: cookie } })).trim();
  if (!crumb || crumb.includes('<')) throw new Error('no yahoo crumb');
  _crumbCache = { cookie, crumb, at: Date.now() };
  return _crumbCache;
}

async function getValuation(symbol, auth) {
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}`
    + `?modules=financialData%2CdefaultKeyStatistics&crumb=${encodeURIComponent(auth.crumb)}`;
  const j = await fetchJson(url, { headers: { Cookie: auth.cookie } });
  const r = j && j.quoteSummary && j.quoteSummary.result && j.quoteSummary.result[0];
  if (!r) throw new Error(`no summary for ${symbol}`);
  const raw = (x) => (x && typeof x.raw === 'number') ? x.raw : null;
  const fd = r.financialData || {};
  const ks = r.defaultKeyStatistics || {};
  return {
    symbol,
    target: raw(fd.targetMeanPrice),
    targetHigh: raw(fd.targetHighPrice),
    targetLow: raw(fd.targetLowPrice),
    analysts: raw(fd.numberOfAnalystOpinions),
    recMean: raw(fd.recommendationMean),
    recKey: fd.recommendationKey || null,
    fwdPE: raw(ks.forwardPE)
  };
}

async function getAllValuations(symbols) {
  const auth = await getCrumb();
  const rows = await pool(symbols, POOL_CONCURRENCY, (s) => getValuation(s, auth));
  const map = {};
  let ok = 0;
  for (const r of rows) {
    if (r && !r._error && r.symbol) { map[r.symbol] = r; ok++; }
  }
  return { map, ok };
}

export function parseTrefisOverrides(envValue) {
  if (!envValue) return {};
  try {
    const j = JSON.parse(envValue);
    const out = {};
    for (const [k, v] of Object.entries(j)) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) out[k.toUpperCase()] = n;
    }
    return out;
  } catch { return {}; }
}

// ----------------------------- METRIC BUILDERS ------------------------------

export function buildCryptoMetrics(item, extras = {}) {
  const spark = item.sparkline_in_7d && item.sparkline_in_7d.price
    ? item.sparkline_in_7d.price.filter(v => v != null)
    : [];
  if (spark.length < 60) return null;

  // Prefer real daily bars (getCryptoDailyHistory) over the 7-day hourly
  // sparkline: daily closes are what "RSI(14)", "MACD(12/26/9)" etc.
  // conventionally mean, and only daily bars are long enough for SMA200 and
  // 20-daily-bar Donchian. Fall back to the sparkline (old behavior) if the
  // per-coin history fetch failed for this asset this run.
  const daily = extras.daily && extras.daily.closes && extras.daily.closes.length >= 60 ? extras.daily : null;
  const closes = daily ? daily.closes : spark;
  const volumes = daily ? daily.volumes : null;
  const haveDaily = !!daily;

  const price = item.current_price;
  const mcap = item.market_cap || 0;
  const vol = item.total_volume || 0;
  const symbol = (item.symbol || '').toUpperCase();
  const mean7d = spark.reduce((a, b) => a + b, 0) / spark.length;
  const md = macd(closes);
  const rNow = rsi(closes);
  const rRange = rsiRecentRange(closes, haveDaily ? 10 : 24);
  // Only from real daily bars — an hourly-sparkline-derived "daily" vol
  // (or "52-week" range, or correlation) on the fallback path would be a
  // materially different, wrong number. The lookback itself is chosen per
  // asset (see bestVolLookback's docs) once there's enough of this coin's
  // own history to back-test candidates against; falls back to the fixed
  // 30-day default for a coin too young to test (the common case at
  // crypto's 365-day history cap).
  const volLookback = haveDaily ? bestVolLookback(closes) : null;
  const volPct = haveDaily ? realizedVolPct(closes, volLookback ? volLookback.lookback : undefined) : null;
  // 365, not stocks' 252: crypto trades every calendar day, not just
  // weekdays, so a "1-year cycle" in daily bars is 365 bars here.
  const dwell = haveDaily ? dwellAtExtreme(closes, 365) : null;
  const corr = haveDaily && extras.benchCloses ? correlationWithBenchmark(closes, extras.benchCloses, 30) : null;
  const seasonal = haveDaily ? seasonalAnalog(closes, 365) : null;

  return {
    symbol,
    id: item.id,
    name: item.name,
    dwell,
    corr,
    seasonal,
    volPct,
    volLookbackDays: volLookback ? volLookback.lookback : null,
    price,
    mcap,
    volume: vol,
    rank: item.market_cap_rank,
    chgShort: item.price_change_percentage_1h_in_currency,
    chg24h: item.price_change_percentage_24h_in_currency ?? item.price_change_percentage_24h,
    chg7d: item.price_change_percentage_7d_in_currency,
    chg30d: item.price_change_percentage_30d_in_currency,
    rsi: rNow,
    rsiPrev: rsi(closes.slice(0, -3)),
    rsiRecentMin: rRange.min,
    rsiRecentMax: rRange.max,
    rangePos: rangePos(closes.slice(-252), price),
    mean7d,
    stretch: mean7d ? ((price / mean7d) - 1) * 100 : null,
    slope: slopePct(closes, haveDaily ? 15 : 72),
    sma20: haveDaily ? sma(closes, 20) : null,
    sma50: haveDaily ? sma(closes, 50) : null,
    sma200: haveDaily && closes.length >= 200 ? sma(closes, 200) : null,
    volRatio: mcap > 0 ? (vol / mcap) / 0.08 : null,   // 1.0 ~= typical 8% daily turnover
    macdHist: md && md.hist,
    macdPrevHist: md && md.prevHist,
    bb: bollinger(closes),
    stoch: stochastic(closes),                           // close-only variant, no crypto highs/lows either way
    donchianHi: closes.length > 21 ? Math.max(...closes.slice(-21, -1)) : null,
    donchianLo: closes.length > 21 ? Math.min(...closes.slice(-21, -1)) : null,
    obv: haveDaily && volumes ? obvSlope(closes, volumes, 15) : null,
    structure: swingStructure(closes, haveDaily ? 40 : 48),
    divergence: divergenceProxy(closes, rNow, haveDaily ? 25 : 36),
    volReg: volRegime(closes, haveDaily ? 20 : 24, haveDaily ? 100 : 120),
    funding: extras.funding != null ? extras.funding : null,
    trending: !!extras.trending
  };
}

export function buildStockMetrics(row, valuation, override, benchCloses) {
  const { symbol, price, closes, volumes, highs, lows } = row;
  if (!closes || closes.length < 60) return null;

  const n = closes.length;
  const pct = (back) => n > back ? ((price / closes[n - 1 - back]) - 1) * 100 : null;
  const s20 = sma(closes, 20);
  const s50 = sma(closes, 50);
  const s200 = closes.length >= 200 ? sma(closes, 200) : null;
  const avgVol20 = sma(volumes, 20);
  const md = macd(closes);
  const rNow = rsi(closes);
  const rRange = rsiRecentRange(closes, 10);
  // Lookback chosen per asset once there's enough of this stock's own
  // history to back-test candidates against (see bestVolLookback) —
  // equities' 10y of history means this resolves to a real pick for
  // nearly every name, unlike crypto's 365-day cap.
  const volLookback = bestVolLookback(closes);
  const volPct = realizedVolPct(closes, volLookback ? volLookback.lookback : undefined);
  const dwell = dwellAtExtreme(closes, 252);
  const corr = benchCloses ? correlationWithBenchmark(closes, benchCloses, 30) : null;
  const seasonal = seasonalAnalog(closes, 252);
  const hi52 = Math.max(...closes);

  let val = null;
  const target = override != null ? override : (valuation && valuation.target);
  if (target != null && price) {
    val = {
      target,
      upside: ((target / price) - 1) * 100,
      recMean: valuation ? valuation.recMean : null,
      recKey: valuation ? valuation.recKey : null,
      analysts: valuation ? valuation.analysts : null,
      fwdPE: valuation ? valuation.fwdPE : null,
      source: override != null ? 'override' : 'street'
    };
  }

  return {
    symbol,
    name: symbol,
    price,
    volPct,
    volLookbackDays: volLookback ? volLookback.lookback : null,
    dwell,
    corr,
    seasonal,
    chgShort: pct(1),
    chg24h: pct(1),
    chg7d: pct(5),
    chg30d: pct(21),
    rsi: rNow,
    rsiPrev: rsi(closes.slice(0, -3)),
    rsiRecentMin: rRange.min,
    rsiRecentMax: rRange.max,
    rangePos: rangePos(closes.slice(-252), price),
    stretch: s20 ? ((price / s20) - 1) * 100 : null,
    slope: slopePct(closes, 15),
    volRatio: avgVol20 ? (volumes[n - 1] / avgVol20) : null,
    macdHist: md && md.hist,
    macdPrevHist: md && md.prevHist,
    sma20: s20,
    sma50: s50,
    sma200: s200,
    bb: bollinger(closes),
    stoch: stochastic(closes, highs, lows),
    donchianHi: n > 21 ? Math.max(...closes.slice(-21, -1)) : null,
    donchianLo: n > 21 ? Math.min(...closes.slice(-21, -1)) : null,
    obv: obvSlope(closes, volumes, 15),
    structure: swingStructure(closes, 40),
    divergence: divergenceProxy(closes, rNow, 25),
    volReg: volRegime(closes, 20, 100),
    distHigh52w: hi52 ? ((price / hi52) - 1) * 100 : null,
    val,
    source: row.source
  };
}

// Matches HORIZONS_HOURS = [24, 168] in scripts/reliability.mjs (1 day, 7
// days) so every logged range prediction matures on exactly the same
// schedule as technique_votes — an apples-to-apples "was the 1-day band
// right 1 day later" and "was the 7-day band right 7 days later," never a
// mismatched horizon between what's logged and what's checked.
const RANGE_LOG_HORIZONS_DAYS = [1, 7];

function rankBoards(metrics, kind, reliability, marketContext, reliabilityByHorizon, moveStats) {
  const scored = metrics.map(m => ({ m, c: confluence(m, kind, reliability, marketContext, reliabilityByHorizon) }));
  // Full-universe vote log (not just the top-10 shown on each board) so the
  // reliability learning loop sees every asset, not only that hour's winners.
  const votesLog = [];
  // Full-universe range-prediction log, same reasoning: a boring, rarely-
  // ranked asset can still build a real track record.
  const rangeLog = [];
  for (const { m, c } of scored) {
    for (const v of c.votes) votesLog.push({ asset_class: kind, symbol: m.symbol, technique_id: v.id, dir: v.dir });
    // One composite directional vote per asset per run — reuses the exact
    // same technique_votes/technique_reliability machinery as every other
    // technique (see compositeCall's docs), just keyed 'composite'.
    const cc = compositeCall(c);
    if (cc) {
      votesLog.push({ asset_class: kind, symbol: m.symbol, technique_id: 'composite', dir: cc.dir });
      for (const horizonDays of RANGE_LOG_HORIZONS_DAYS) {
        const r = predictedRange(m.price, horizonDays, cc.score, cc.dir, moveStats, m.symbol, m.volPct);
        if (r) rangeLog.push({ asset_class: kind, symbol: m.symbol, horizon_hours: horizonDays * 24, low: r.low, high: r.high });
      }
    }
  }
  const priceLog = scored.map(({ m }) => ({ asset_class: kind, symbol: m.symbol, price: m.price }));
  // Full universe with names, for the track-record leaderboard — deliberately
  // not limited to the top 10 per side like breakout/breakdown are, since an
  // asset can build a strong record without ever topping either board.
  const allSymbols = scored.map(({ m }) => ({ symbol: m.symbol, name: m.name }));
  const entry = (x, side) => {
    const dir = side === 'long' ? 1 : -1;
    const score = side === 'long' ? x.c.long : x.c.short;
    const horizon = side === 'long' ? x.c.longHorizon : x.c.shortHorizon;
    return {
      symbol: x.m.symbol,
      name: x.m.name,
      price: x.m.price,
      chg24h: x.m.chg24h,
      chg7d: x.m.chg7d,
      rsi: x.m.rsi,
      volRatio: x.m.volRatio,
      rangePos: x.m.rangePos,
      score,
      conf: { agree: side === 'long' ? x.c.bull : x.c.bear, total: x.c.total },
      drivers: side === 'long' ? x.c.longNotes : x.c.shortNotes,
      horizon,
      range: horizon ? predictedRange(x.m.price, horizon.days, score, dir, moveStats, x.m.symbol, x.m.volPct) : null,
      topIndicator: topIndicator(reliability, x.m.symbol),
      ...(x.m.val ? { val: { target: x.m.val.target, upside: x.m.val.upside, recKey: x.m.val.recKey, source: x.m.val.source } } : {}),
      ...(x.m.funding != null ? { funding: x.m.funding } : {}),
      ...(x.m.distHigh52w != null ? { distHigh52w: x.m.distHigh52w } : {}),
      ...(x.m.rank != null ? { mcapRank: x.m.rank } : {}),
      ...(x.m.volLookbackDays != null ? { volLookbackDays: x.m.volLookbackDays } : {}),
      ...(x.m.id ? { id: x.m.id } : {}) // CoinGecko coin id (crypto only) — lets the dashboard link out to a real coin page
    };
  };
  const sortSide = (side) => scored
    .slice()
    .sort((a, b) => (side === 'long' ? b.c.long - a.c.long : b.c.short - a.c.short)
      || (side === 'long' ? b.c.bull - a.c.bull : b.c.bear - a.c.bear))
    .slice(0, 10)
    .map(x => entry(x, side));
  return { breakout: sortSide('long'), breakdown: sortSide('short'), universe: metrics.length, votesLog, priceLog, rangeLog, allSymbols };
}

// ----------------------------- HANDLER --------------------------------------

// ----------------------------- BUILD PAYLOAD --------------------------------
// The full engine: ~130 outbound fetches plus indicator math across ~260
// assets. Exported so scripts/build-signals.mjs (run from GitHub Actions,
// not from the Worker) can import this exact implementation rather than a
// hand-copied duplicate that could drift from it.

// Returns { payload, log }: `payload` is the servable JSON (what goes to KV
// and the dashboard); `log` is the per-asset vote/price data reliability.mjs
// needs to score past forecasts and isn't meant to be public.
export async function buildPayload(env, reliability, reliabilityByHorizon, moveStats, rangeReliability) {
  const started = Date.now();
  const overrides = parseTrefisOverrides(env && env.TREFIS_OVERRIDES);

  const [cryptoR, globalR, fngR, trendR, fundR, stocksR, overviewR, valR] = await Promise.allSettled([
    getCryptoMarkets(),
    getGlobal(),
    getFearGreed(),
    getTrending(),
    getFundingMap(),
    pool(STOCK_WATCHLIST, POOL_CONCURRENCY, getStock),
    // '6mo', not '1mo': SPY's closes double as the equities correlation
    // benchmark now, and 1 month (~21 daily bars) is too thin for a real
    // 30-day-returns correlation. Same single fetch either way, just more
    // history per call.
    pool(OVERVIEW_SYMBOLS, 3, (s) => yahooDaily(s, '6mo')),
    getAllValuations(STOCK_WATCHLIST)
  ]);

  const trending = trendR.status === 'fulfilled' ? trendR.value : new Set();
  const funding = fundR.status === 'fulfilled' ? fundR.value : {};

  // Market-wide context, computed once and handed to every asset's
  // scoring (see the "reversal" technique): Fear & Greed for crypto, and
  // where VIX sits in its own recent range for equities (a fixed VIX level
  // means different things in calm vs turbulent years, so "elevated
  // relative to its own last month" is the meaningful read, not an
  // absolute threshold). Computed from data already being fetched for the
  // overview tiles — no extra calls.
  const idx = {};
  if (overviewR.status === 'fulfilled') {
    for (const r of overviewR.value) {
      if (r && !r._error && r.closes && r.closes.length >= 2) {
        const prev = r.closes[r.closes.length - 2];
        idx[r.symbol] = {
          price: r.price,
          chg24h: prev ? ((r.price / prev) - 1) * 100 : null,
          rangePos: rangePos(r.closes, r.price)
        };
      }
    }
  }
  const marketContext = {
    fearGreed: fngR.status === 'fulfilled' && fngR.value ? fngR.value.value : null,
    vixRangePos: idx['^VIX'] ? idx['^VIX'].rangePos : null
  };

  let cryptoBoards = { breakout: [], breakdown: [], universe: 0 };
  let btc = null, eth = null;
  let cryptoDailyOk = 0, cryptoDailyTotal = 0;
  if (cryptoR.status === 'fulfilled' && Array.isArray(cryptoR.value)) {
    const raw = cryptoR.value;
    for (const c of raw) {
      if (c.id === 'bitcoin') btc = { price: c.current_price, chg24h: c.price_change_percentage_24h };
      if (c.id === 'ethereum') eth = { price: c.current_price, chg24h: c.price_change_percentage_24h };
    }
    const qualifying = raw
      .filter(c => !CRYPTO_BLOCKLIST.has((c.symbol || '').toLowerCase()))
      .filter(c => (c.market_cap || 0) >= CRYPTO_MIN_MCAP && (c.total_volume || 0) >= CRYPTO_MIN_VOLUME);

    // Paced, not pooled at full concurrency: ~100 per-coin calls against
    // CoinGecko's free tier, one call per qualifying coin (no batched
    // multi-coin history endpoint exists on that tier).
    const histories = await poolPaced(qualifying, CRYPTO_HISTORY_BATCH, CRYPTO_HISTORY_DELAY_MS, (c) => getCryptoDailyHistory(c.id));
    cryptoDailyTotal = histories.length;
    cryptoDailyOk = histories.filter(h => h && !h._error).length;

    const btcIdx = qualifying.findIndex(c => c.id === 'bitcoin');
    const btcCloses = btcIdx >= 0 && histories[btcIdx] && !histories[btcIdx]._error ? histories[btcIdx].closes : null;

    const metrics = qualifying
      .map((c, i) => {
        const sym = (c.symbol || '').toUpperCase();
        const h = histories[i];
        const daily = h && !h._error ? h : null;
        return buildCryptoMetrics(c, { funding: funding[sym], trending: trending.has(sym), daily, benchCloses: btcCloses });
      })
      .filter(Boolean);
    cryptoBoards = rankBoards(metrics, 'crypto', reliability, marketContext, reliabilityByHorizon, moveStats);
  }

  let stockBoards = { breakout: [], breakdown: [], universe: 0 };
  const stockFailures = [];
  const valMap = valR.status === 'fulfilled' ? valR.value.map : {};
  if (stocksR.status === 'fulfilled') {
    const spyRow = overviewR.status === 'fulfilled' ? overviewR.value.find(r => r && !r._error && r.symbol === 'SPY') : null;
    const spyCloses = spyRow ? spyRow.closes : null;
    const metrics = [];
    for (const r of stocksR.value) {
      if (r && !r._error) {
        const m = buildStockMetrics(r, valMap[r.symbol], overrides[r.symbol], spyCloses);
        if (m) metrics.push(m);
      } else stockFailures.push(r && r._item);
    }
    stockBoards = rankBoards(metrics, 'stock', reliability, marketContext, reliabilityByHorizon, moveStats);
  }

  // If both primary sources yielded nothing, this is a real outage: throw so
  // the caller serves the last good cache instead of overwriting it with an
  // empty payload.
  if (cryptoBoards.universe === 0 && stockBoards.universe === 0) {
    throw new Error('all primary data sources failed');
  }

  // Pull the reliability-learning log out before the boards go into the
  // public payload — votesLog/priceLog/rangeLog/allSymbols are internal
  // bookkeeping, not something the dashboard or API consumer needs to see.
  const { votesLog: cryptoVotes, priceLog: cryptoPrices, rangeLog: cryptoRanges, allSymbols: cryptoAll, ...cryptoPublic } = cryptoBoards;
  const { votesLog: stockVotes, priceLog: stockPrices, rangeLog: stockRanges, allSymbols: stockAll, ...stockPublic } = stockBoards;
  const log = {
    generated_at: new Date().toISOString(),
    votes: [...(cryptoVotes || []), ...(stockVotes || [])],
    prices: [...(cryptoPrices || []), ...(stockPrices || [])],
    ranges: [...(cryptoRanges || []), ...(stockRanges || [])]
  };

  // Track record: which assets (either class) have a pooled, matured
  // prediction score above 95/100 — see assetPredictionScore's docs for
  // exactly what's pooled. Full universe, not just this hour's top 10 per
  // side, since a strong record doesn't require currently ranking.
  const highAccuracyFor = (list, assetClass) => list
    .map(({ symbol, name }) => {
      const s = assetPredictionScore(symbol, reliability, rangeReliability);
      return s ? { symbol, name, asset_class: assetClass, score: s.score, samples: s.samples } : null;
    })
    .filter((r) => r && r.score > 95);
  const highAccuracy = [
    ...highAccuracyFor(cryptoAll || [], 'crypto'),
    ...highAccuracyFor(stockAll || [], 'stock')
  ].sort((a, b) => b.score - a.score);

  const payload = {
    generated_at: log.generated_at,
    cache_seconds: CACHE_SECONDS,
    build_ms: Date.now() - started,
    model: 'confluence-v4 (16 techniques, directional agreement)',
    health: {
      coingecko: cryptoR.status === 'fulfilled',
      global: globalR.status === 'fulfilled' && !!globalR.value,
      fear_greed: fngR.status === 'fulfilled' && !!fngR.value,
      trending: trendR.status === 'fulfilled',
      funding: fundR.status === 'fulfilled',
      valuation_ok: valR.status === 'fulfilled' ? valR.value.ok : 0,
      stocks_ok: STOCK_WATCHLIST.length - stockFailures.length,
      stocks_total: STOCK_WATCHLIST.length,
      crypto_daily_ok: cryptoDailyOk,
      crypto_daily_total: cryptoDailyTotal,
      trefis_overrides: Object.keys(overrides).length
    },
    overview: {
      btc, eth,
      global: globalR.status === 'fulfilled' ? globalR.value : null,
      fear_greed: fngR.status === 'fulfilled' ? fngR.value : null,
      spy: idx['SPY'] || null,
      qqq: idx['QQQ'] || null,
      vix: idx['^VIX'] || null
    },
    crypto: cryptoPublic,
    stocks: stockPublic,
    highAccuracy,
    sources: {
      crypto: 'CoinGecko (top 100 by market cap, daily history per coin) + trending list',
      derivatives: 'Bybit linear perp funding rates',
      sentiment: 'alternative.me Fear & Greed',
      equities: 'Yahoo Finance daily OHLCV, Stooq fallback',
      valuation: 'Wall Street consensus targets via Yahoo; TREFIS_OVERRIDES env accepted',
      note: 'Mechanical confluence composites. Not investment advice.'
    }
  };

  return { payload, log };
}

// ----------------------------- KV CACHE -------------------------------------

async function getCached(env) {
  if (!env || !env.FCS_CACHE) return null;
  try {
    const raw = await env.FCS_CACHE.get(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function isFresh(payload) {
  if (!payload || !payload.generated_at) return false;
  return (Date.now() - new Date(payload.generated_at).getTime()) < CACHE_SECONDS * 1000;
}

async function getCachedLivePrices(env) {
  if (!env || !env.FCS_CACHE) return null;
  try {
    const raw = await env.FCS_CACHE.get(LIVE_PRICE_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function putCachedLivePrices(env, body) {
  if (!env || !env.FCS_CACHE) return;
  try {
    await env.FCS_CACHE.put(LIVE_PRICE_CACHE_KEY, JSON.stringify(body), { expirationTtl: LIVE_PRICE_CACHE_SECONDS });
  } catch { /* best-effort — a failed cache write just means the next request fetches fresh again */ }
}

const PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Frontier Capital Signals — Hourly confluence screens</title>
<meta name="description" content="Hourly confluence screens across the top 100 cryptos and 60 US equities. Up to 16 techniques per asset must agree before a signal ranks.">
<!-- Consent Mode v2 defaults, same scheme as the main site (fcs_consent_v1 in
     localStorage, shared across the whole origin since localStorage is
     origin- not path-scoped): respects a prior choice made on the main site,
     or auto-grants for visitors outside the EEA/UK/CH via the same
     /api/region endpoint. Visitors who land directly on /signals inside the
     EEA without ever visiting the main site stay denied — this page has no
     consent banner of its own, so that's the safe default, not a bug. -->
<script>(function(){
window.dataLayer=window.dataLayer||[];
function gtag(){dataLayer.push(arguments);}
window.gtag=window.gtag||gtag;
var stored=null;
try{stored=JSON.parse(localStorage.getItem('fcs_consent_v1'));}catch(e){}
if(stored){
gtag('consent','default',{
ad_storage:stored.advertising?'granted':'denied',
ad_user_data:stored.advertising?'granted':'denied',
ad_personalization:stored.advertising?'granted':'denied',
analytics_storage:stored.analytics?'granted':'denied'
});
}else{
gtag('consent','default',{ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied',analytics_storage:'denied',wait_for_update:500});
fetch('/api/region').then(function(r){return r.json();}).then(function(d){
if(!d.requiresConsent){gtag('consent','update',{ad_storage:'granted',ad_user_data:'granted',ad_personalization:'granted',analytics_storage:'granted'});}
}).catch(function(){});
}
})();</script>
<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','GTM-5Q7JC6JX');</script>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%230A101D'/%3E%3Crect x='6' y='18' width='4' height='8' fill='%23FFB224'/%3E%3Crect x='13' y='12' width='4' height='14' fill='%23FFB224'/%3E%3Crect x='20' y='6' width='4' height='20' fill='%23FFB224'/%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;700;800;900&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root{
    --ink-0:#0A101D; --ink-1:#101828; --ink-2:#182338; --line:#1E2A42;
    --paper:#E9EEF7; --muted:#8A96AC; --dim:#5D6A82;
    --amber:#FFB224; --up:#3DDC97; --down:#FF7A85;
    --mono:'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,monospace;
    --disp:'Archivo',system-ui,-apple-system,sans-serif;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--ink-0);color:var(--paper);font-family:var(--disp);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased}
  a{color:var(--amber);text-decoration:none}
  a:hover{text-decoration:underline}
  :focus-visible{outline:2px solid var(--amber);outline-offset:2px;border-radius:2px}
  .wrap{max-width:1240px;margin:0 auto;padding:0 20px}

  .statusbar{border-bottom:1px solid var(--line);background:rgba(10,16,29,.92);backdrop-filter:blur(6px);position:sticky;top:0;z-index:20}
  .statusbar .wrap{display:flex;align-items:center;gap:18px;height:38px;font-family:var(--mono);font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);white-space:nowrap;overflow-x:auto;scrollbar-width:none}
  .statusbar .wrap::-webkit-scrollbar{display:none}
  .sys{display:flex;align-items:center;gap:7px;color:var(--paper)}
  .dot{width:7px;height:7px;border-radius:50%;background:var(--amber);box-shadow:0 0 8px var(--amber)}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
  .dot.live{animation:pulse 2.2s ease-in-out infinite}
  .spacer{flex:1}
  .stat b{color:var(--paper);font-weight:600}
  .stat.warn b{color:var(--amber)}

  .masthead{padding:58px 0 34px}
  .masthead h1{font-weight:900;font-size:clamp(42px,7.2vw,94px);line-height:.94;letter-spacing:-.025em;text-transform:uppercase}
  .masthead h1 .amber{color:var(--amber)}
  .mast-grid{display:flex;flex-wrap:wrap;gap:28px;align-items:flex-end;justify-content:space-between}
  .dek{max-width:540px;color:var(--muted);font-size:13.5px;line-height:1.65;margin-top:18px}
  .dek b{color:var(--paper);font-weight:600}
  .mast-meta{font-family:var(--mono);font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--dim);text-align:right;line-height:2.1}
  .mast-meta b{color:var(--amber);font-weight:600}
  .mast-rule{height:2px;background:linear-gradient(90deg,var(--amber) 0,var(--amber) 180px,var(--line) 180px);margin-top:26px}

  .overview{display:grid;grid-template-columns:repeat(7,1fr);gap:1px;background:var(--line);border:1px solid var(--line);margin:26px 0 40px}
  .tile{background:var(--ink-1);padding:14px 14px 12px;min-width:0}
  .tile .lbl{font-family:var(--mono);font-size:9.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--dim);margin-bottom:7px}
  .tile .val{font-family:var(--mono);font-weight:600;font-size:clamp(15px,1.5vw,19px);color:var(--paper);white-space:nowrap}
  .tile .sub{font-family:var(--mono);font-size:11px;margin-top:4px}
  .up{color:var(--up)} .down{color:var(--down)} .flat{color:var(--muted)} .amber-t{color:var(--amber)}

  .boards{display:grid;grid-template-columns:1fr 1fr;gap:22px;margin-bottom:44px}
  .board{background:var(--ink-1);border:1px solid var(--line)}
  .board.long{border-top:2px solid var(--amber)}
  .board.short{border-top:2px solid var(--down)}
  .board-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:16px 18px 12px}
  .eyebrow{font-family:var(--mono);font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:var(--dim)}
  .board.long .eyebrow b{color:var(--amber);font-weight:600}
  .board.short .eyebrow b{color:var(--down);font-weight:600}
  .board-title{font-weight:800;font-size:19px;letter-spacing:-.01em;margin-top:3px}
  .board-count{font-family:var(--mono);font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);white-space:nowrap}

  .tbl-wrap{overflow-x:auto}
  table{width:100%;border-collapse:collapse;font-family:var(--mono);font-size:12.5px}
  thead th{font-size:9.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--dim);font-weight:500;text-align:right;padding:8px 10px;border-top:1px solid var(--line);border-bottom:1px solid var(--line);white-space:nowrap}
  thead th:nth-child(1),thead th:nth-child(2){text-align:left}
  th.sortable{cursor:pointer;user-select:none}
  th.sortable:hover{color:var(--paper)}
  th.sortable.active{color:var(--amber)}
  tbody td{padding:10px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap;vertical-align:top}
  tbody td:nth-child(1),tbody td:nth-child(2){text-align:left}
  tbody tr:last-child td{border-bottom:none}
  tbody tr:hover{background:#131E32}
  .rk{color:var(--dim);font-size:11px;padding-top:12px}
  .asset .sym{font-weight:600;color:var(--paper);font-size:13px}
  .asset .nm{color:var(--muted);font-size:10.5px;margin-left:7px;font-family:var(--disp)}
  .asset .why{display:block;color:var(--dim);font-size:10.5px;margin-top:3px;font-family:var(--disp);white-space:normal;max-width:280px;line-height:1.45}
  a.sym-link{text-decoration:none}
  a.sym-link:hover .sym{color:var(--amber);text-decoration:underline}
  .rsi-hi{color:var(--down)} .rsi-lo{color:var(--up)}

  .sigcell{display:flex;flex-direction:column;align-items:flex-end;gap:3px}
  .sigrow{display:flex;align-items:center;gap:9px}
  .meter{display:inline-flex;gap:2px}
  .meter i{width:6px;height:13px;background:var(--ink-2);border-radius:1px}
  .board.long .meter i.on{background:var(--amber);box-shadow:0 0 5px rgba(255,178,36,.45)}
  .board.short .meter i.on{background:var(--down);box-shadow:0 0 5px rgba(255,122,133,.4)}
  .score{font-weight:600;min-width:24px;color:var(--paper)}
  .conf{font-size:9.5px;letter-spacing:.12em;color:var(--dim);text-transform:uppercase}
  .horizon{font-size:9.5px;letter-spacing:.06em;padding:1px 6px;border-radius:3px;border:1px solid var(--line);cursor:help}
  .horizon.hz-hist{color:var(--amber);border-color:rgba(255,178,36,.35)}
  .horizon.hz-meth{color:var(--dim)}
  .range{font-size:11px;cursor:help}
  .range.hz-hist{color:var(--amber)}
  .range.hz-meth{color:var(--muted)}
  .topind{display:block;color:var(--dim);font-size:10px;margin-top:3px;font-family:var(--disp);white-space:normal}

  .track-record{background:var(--ink-1);border:1px solid var(--line);border-top:2px solid var(--amber);margin-bottom:44px;padding:18px 18px 6px}
  .tr-title{font-weight:800;font-size:17px;letter-spacing:-.01em;margin-top:3px}
  .tr-empty{color:var(--muted);font-size:12.5px;line-height:1.75;max-width:760px;font-family:var(--mono);padding:2px 0 16px}
  .tr-list{display:flex;flex-direction:column;gap:1px;background:var(--line);margin-top:14px}
  .tr-row{display:flex;align-items:center;gap:14px;background:var(--ink-1);padding:10px 12px;font-family:var(--mono);font-size:12.5px}
  .tr-sym{font-weight:600;color:var(--paper);min-width:64px}
  .tr-name{color:var(--muted);flex:1;font-family:var(--disp);font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .tr-class{color:var(--dim);font-size:9.5px;letter-spacing:.1em;min-width:56px}
  .tr-score{color:var(--up);font-weight:700;min-width:48px;text-align:right}
  .tr-samples{color:var(--dim);font-size:10.5px;min-width:76px;text-align:right;white-space:nowrap}

  @keyframes rise{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}
  tbody tr.in{animation:rise .35s ease both}
  @keyframes flashtick{0%{background:rgba(255,178,36,.4)}100%{background:transparent}}
  .live-price-cell.flash, .live-chg-cell.flash{animation:flashtick 1s ease}
  @media (prefers-reduced-motion:reduce){tbody tr.in{animation:none}.dot.live{animation:none}.live-price-cell.flash,.live-chg-cell.flash{animation:none}}

  .notice{background:var(--ink-1);border:1px solid var(--line);padding:26px;font-family:var(--mono);font-size:12.5px;color:var(--muted);line-height:1.8;margin-bottom:40px}
  .notice b{color:var(--paper)}
  .notice code{color:var(--amber)}

  details{border:1px solid var(--line);background:var(--ink-1);margin-bottom:44px}
  summary{cursor:pointer;padding:15px 18px;font-family:var(--mono);font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--muted);list-style:none;display:flex;justify-content:space-between}
  summary::-webkit-details-marker{display:none}
  summary::after{content:'+';color:var(--amber);font-size:14px}
  details[open] summary::after{content:'–'}
  .method{padding:4px 18px 22px;color:var(--muted);font-size:13px;line-height:1.75;max-width:880px}
  .method p{margin-bottom:12px}
  .method b{color:var(--paper);font-weight:600}
  footer{border-top:1px solid var(--line);padding:26px 0 46px;color:var(--dim);font-size:12px;line-height:1.8}
  footer .legal{max-width:880px;margin-bottom:14px}
  footer .cols{font-family:var(--mono);font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;display:flex;flex-wrap:wrap;gap:8px 26px}

  @media (max-width:1080px){.overview{grid-template-columns:repeat(4,1fr)}}
  @media (max-width:980px){.boards{grid-template-columns:1fr}}
  @media (max-width:620px){
    .overview{grid-template-columns:repeat(2,1fr)}
    .masthead{padding:40px 0 26px}
    .mast-meta{text-align:left}
    .asset .why{max-width:200px}
  }
</style>
</head>
<body>

<div class="statusbar">
  <div class="wrap">
    <span class="sys"><span class="dot live" id="sysDot"></span>FCS&nbsp;/&nbsp;<span id="sysState">CONNECTING</span></span>
    <span class="stat">UTC <b id="clock">--:--:--</b></span>
    <span class="spacer"></span>
    <span class="stat" id="healthStat">FEEDS <b>—</b></span>
    <span class="stat">LAST SYNC <b id="lastSync">—</b></span>
    <span class="stat">NEXT CHECK <b id="countdown">—</b></span>
    <span class="stat" title="Price and 24h change tick independently of the hourly analysis rebuild">PRICES <b id="liveStamp">—</b></span>
  </div>
</div>

<div class="wrap">

  <header class="masthead">
    <div class="mast-grid">
      <div>
        <h1>Frontier Capital<br><span class="amber">Signals</span></h1>
        <p class="dek">Confluence screens across the <b>top 100 cryptos</b> and <b>60 US equities</b>. Up to <b>16 independent techniques</b> per asset, from RSI, MACD and Bollinger structure to volume, funding rates, Wall Street price targets, reversal-pattern detection and multi-year seasonal analogs, must point the <b>same direction</b> before a signal ranks — each with an <b>expected timeframe</b> learned from its own track record. <b>Analysis syncs hourly; price and 24h change tick live</b> in between.</p>
      </div>
      <div class="mast-meta">
        ANALYSIS REFRESH <b>HOURLY</b><br>
        PRICE TICKS <b>LIVE</b><br>
        UNIVERSE <b id="metaUniverse">—</b><br>
        TECHNIQUES PER ASSET <b>UP TO 16</b>
      </div>
    </div>
    <div class="mast-rule"></div>
  </header>

  <section class="overview" id="overview" aria-label="Market overview">
  </section>

  <div id="stateBox"></div>

  <main class="boards" id="boards">
  </main>

  <section class="track-record" id="trackRecord" aria-label="Prediction track record"></section>

  <details>
    <summary>Methodology and data</summary>
    <div class="method">
      <p><b>The confluence model.</b> Every asset is evaluated by up to 16 independent techniques. Each one votes bullish, bearish, or neutral. The breakout score measures how much weighted evidence points up net of evidence pointing down; the breakdown score mirrors it. The small fraction under each score (for example 9/16) is the raw count of techniques agreeing with that direction out of those that had enough data to vote. High score plus high agreement is the strongest read.</p>
      <p><b>The 16 techniques.</b> Multi-horizon momentum alignment; Wilder RSI(14) regime and direction; MACD(12/26/9) histogram level and direction; moving-average stack (SMA20/50/200, computed from real daily bars for both equities and crypto); Bollinger %B with squeeze-and-expansion detection; stochastic (14,3) crosses; Donchian 20-bar breakout or breakdown proximity; volume confirmation versus baseline; on-balance volume trend; swing structure of higher-highs and higher-lows; a momentum divergence proxy that flags new price extremes without RSI support; a volatility regime read separating coiled compression from climactic expansion; a reversal-pattern read (below); how long an asset has been coiled at its own long-run high or low and whether it's decoupled from the broader market (below); a seasonal-analog read comparing the current pattern against the asset's own history one or more years back (below); and a valuation-or-positioning layer.</p>
      <p><b>Reversal detection.</b> A separate read from plain RSI level: it looks for RSI having actually bottomed or topped over the last ~10 bars and turned back, confirmed by at least one independent signal (a stochastic cross, a Bollinger band extreme, swing structure, on-balance volume, or the divergence proxy) — it never fires on RSI alone. Market-wide sentiment adds confidence on top when it lines up: extreme fear on the Fear &amp; Greed index for a crypto bottom, or VIX sitting high in its own recent range for an equity bottom (and the mirror image — extreme greed or a complacent VIX — for tops).</p>
      <p><b>Dwell time and market correlation.</b> Real 52-week (or as much history as exists) highs and lows, and specifically how many days an asset has been sitting within a few percent of one, not just whether it currently is — a fresh one-day touch and a multi-week base at the same level are different setups. Long dwell at a low is read as stored energy for a bounce, the mirror at a high for a pullback, and it carries extra weight when the asset has also decoupled from its usual correlation with the broader market (BTC for crypto, SPY for equities) over the last 30 days, since a move happening on its own is a different setup than one just riding the market. This is a starting assumption, not a fixed rule — the adaptive weighting above corrects it per asset from what actually happens next.</p>
      <p><b>Seasonal analogs.</b> Where an asset has enough of its own history, the current pattern over the last ~90 days is compared against the same-length window roughly one, two, or more years back, using the same correlation math as the market-correlation read above but against the asset's own past. A real resemblance has to clear a fairly high bar (a correlation of at least 0.5) before it counts at all, since only a handful of candidate years exist to compare against and a looser bar would just be fitting noise. When one clears that bar, what happened in the days right after that historical analog becomes a genuine, data-grounded forward hint. In practice this only applies to equities: CoinGecko's free tier caps crypto history at 365 days, which isn't enough to compare against even one year back, so this abstains for every crypto asset rather than reaching for a shorter, less meaningful comparison.</p>
      <p><b>The valuation layer.</b> For equities, Wall Street consensus mean price targets and recommendation ratings: trading well below a buy-rated consensus target votes bullish, trading above the consensus target votes bearish. Trefis does not publish a public API, so consensus targets stand in for model-based estimates; site operators can supply Trefis or other model values through a server-side override, in which case the payload labels the source. For crypto, the layer uses perpetual futures funding rates (crowded positive funding on a parabolic move votes bearish, skeptical funding during an uptrend votes bullish) and trending-list crowding.</p>
      <p><b>Adaptive weighting.</b> Every hour's directional calls are logged and checked back against what the asset's price actually did 24 hours and 7 days later. Once a technique has enough scored history for a specific asset, its weight for that asset going forward is nudged up if it has been reliably right and down if it has been reliably wrong, capped at plus or minus 50%. A technique that is only a coin flip for a given asset keeps its plain baseline weight.</p>
      <p><b>Leading vs. lagging, and the expected timeframe.</b> Techniques are split into two kinds. Leading techniques try to anticipate a move before it's confirmed: RSI, Bollinger squeeze, stochastic crosses, OBV, the divergence proxy, the volatility regime read, reversal-pattern detection, and the valuation/positioning layer. Lagging techniques describe a move already underway: momentum alignment, MACD, the moving-average stack, Donchian breakout proximity, volume confirmation, and swing structure. The small window shown next to each score (for example <b>1-3 days</b>) is this engine's estimate of when that specific call is expected to resolve, built from whichever techniques are actually voting on that asset right now. Where an asset has enough of its own scored history, the window uses that asset's real measured accuracy at the 24-hour versus 7-day mark (marked with a check and shown in amber) instead of a generic estimate — the same historical record the adaptive weighting above draws on, just answering "how soon" instead of "how much weight." Without enough history yet, it falls back to a weighted average of the active techniques' typical horizons (shown in gray) — an informed estimate, not a measurement.</p>
      <p><b>Expected range.</b> The Range column is a band around the current price, not a point prediction, for the same timeframe as the horizon chip next to it. Its width comes from real volatility: this asset's own historical realized move size at that horizon once evaluateMatured has scored enough of its own outcomes (amber, marked historical), or its recent realized daily volatility scaled by the square root of time otherwise (gray, marked methodology) — the standard random-walk approximation for "how far a price plausibly wanders in N days." The band's center only shifts toward the called direction once the score shows real conviction, and the shift is capped well inside the band, so a weak score gives a wide, roughly symmetric range rather than a false point estimate.</p>
      <p><b>How far back the methodology-basis range looks.</b> The gray (methodology) band isn't measured over a single fixed number of days for every asset — it's calibrated per asset. Several candidate lookback windows (10, 20, 30, 60, and 90 days) are backtested against that asset's own price history every hour: for each candidate, the tool checks whether the volatility estimate it would have produced at many past points actually matched what happened next, and keeps whichever window comes closest to correctly sized (hovering your cursor over a gray band shows which one won). A too-short lookback whipsaws on noise; a too-long one smooths over a real shift in how much an asset has started moving. This is a fast, within-run check using history already being fetched — distinct from, and much quicker to react than, the slower live-outcome learning loop described above — so it needs a real backtest sample to trust (an asset too young for that, common at crypto's 365-day history cap, just keeps the plain 30-day default).</p>
      <p><b>Which indicator this asset leans on.</b> "Leans on X (n%)" under an asset's name names whichever technique has, on its own, the strongest individually-proven track record for that specific asset — some assets really are better predicted by one kind of signal than another, and this surfaces that once a technique has enough of its own scored history to say so, using the same adaptive-weighting data above.</p>
      <p><b>Prediction-score track record (95%+ list).</b> Below the boards, a running scorecard pools three kinds of matured, falsifiable calls per asset: whether its overall composite call (not any single technique) pointed the right direction by the horizon's end; whether the predicted price range actually contained the real price at maturity; and whether its pivot-style calls (the reversal and dwell techniques above) panned out. Every matured outcome across those three counts as one equally-weighted vote rather than a hand-picked blend — a made-up weighting scheme would just be a different kind of guess — so the score is simply correct-calls divided by total-calls, out of 100. An asset only appears once it has a reasonable number of matured predictions behind it (the same minimum-sample bar used everywhere else in this engine); below that, it's left off the list rather than shown with a noisy, overconfident number. This is a track record of this engine's own past calls, not a forecast that the streak continues.</p>
      <p><b>Data.</b> CoinGecko free API for the top 100 coins by market cap with real daily price and volume history per coin, plus global stats and trending (stablecoins and wrappers excluded), alternative.me Fear &amp; Greed, Bybit linear perp funding rates, Yahoo Finance daily OHLCV with Stooq CSV fallback, and Yahoo analyst estimates. Free feeds can lag or drop symbols; the feeds counter in the status bar shows current coverage, and any technique without data simply abstains rather than guessing.</p>
      <p><b>Refresh mechanics.</b> A scheduled job rebuilds the full payload — scores, ranges, horizons, every technique call — hourly and writes it to this page's cache; every visit reads that cache, so the page itself never runs the engine. This page also re-checks every 10 minutes so a new hour's data appears without a reload. Price and 24-hour change are the one exception: this page separately polls a lightweight endpoint roughly every 20 seconds for a live tick, straight from CoinGecko and Yahoo, without touching the hourly analysis — so the number in the Price column can move between rebuilds, but the score, range, and every technique read next to it stay fixed until the next hourly rebuild.</p>
      <p><b>What the scores are not.</b> A score of 70 with 10/16 agreement is a strong mechanical setup, not a 70% probability; the timeframe next to it is an estimate of when the setup should resolve, not a guarantee it will; and the range is a plausible band from real volatility, not a target price. The model has no knowledge of token unlocks, earnings dates, lawsuits, or macro events.</p>
    </div>
  </details>

  <footer>
    <p class="legal">Frontier Capital Signals is an informational research tool. Nothing on this page is investment advice, a recommendation, or a solicitation to buy or sell any asset. Scores are mechanical indicator composites with no knowledge of news, fundamentals beyond analyst consensus, token unlocks or earnings. Crypto and equity markets involve substantial risk of loss. Data is provided by third-party feeds without warranty and may be delayed or incomplete. Do your own research.</p>
    <div class="cols">
      <span>© <span id="yr"></span> Frontier Capital Signals</span>
      <span>Data: CoinGecko · alternative.me · Bybit · Yahoo Finance / Stooq</span>
      <span>Model: confluence-v2</span>
    </div>
  </footer>

</div>

<script>
(function(){
  'use strict';
  var REFETCH_MS = 10*60*1000;
  var nextCheckAt = Date.now() + REFETCH_MS;
  var state = { data:null, error:null, sort:{} };

  // Base-path aware so the page works at / on the origin and at /signals/
  // when mounted behind the Cloudflare proxy worker.
  var BASE = location.pathname.endsWith('/') ? location.pathname : location.pathname + '/';
  var DATA_URL = BASE + 'api/signals';
  var PRICES_URL = BASE + 'api/prices';

  var $ = function(id){ return document.getElementById(id); };
  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }

  function fmtPrice(v){
    if(v==null||!isFinite(v)) return '—';
    var a=Math.abs(v);
    if(a>=1000) return v.toLocaleString('en-US',{maximumFractionDigits:2,minimumFractionDigits:2});
    if(a>=1) return v.toFixed(2);
    if(a>=0.01) return v.toFixed(4);
    return v.toPrecision(3);
  }
  function fmtPct(v,dp){
    if(v==null||!isFinite(v)) return '—';
    dp = dp==null?1:dp;
    return (v>0?'+':'')+v.toFixed(dp)+'%';
  }
  function pctCls(v){ if(v==null||!isFinite(v)) return 'flat'; return v>0?'up':(v<0?'down':'flat'); }
  function fmtBig(v){
    if(v==null||!isFinite(v)) return '—';
    if(v>=1e12) return '$'+(v/1e12).toFixed(2)+'T';
    if(v>=1e9) return '$'+(v/1e9).toFixed(1)+'B';
    if(v>=1e6) return '$'+(v/1e6).toFixed(0)+'M';
    return '$'+Math.round(v).toLocaleString('en-US');
  }
  function pad(n){ return n<10?'0'+n:''+n; }

  setInterval(function(){
    var d=new Date();
    $('clock').textContent = pad(d.getUTCHours())+':'+pad(d.getUTCMinutes())+':'+pad(d.getUTCSeconds());
    var ms=Math.max(0,nextCheckAt-Date.now());
    var m=Math.floor(ms/60000), s=Math.floor((ms%60000)/1000);
    $('countdown').textContent = pad(m)+':'+pad(s);
  },1000);
  $('yr').textContent = new Date().getUTCFullYear();

  function tile(label, valHtml, subHtml){
    return '<div class="tile"><div class="lbl">'+label+'</div><div class="val">'+valHtml+'</div>'+(subHtml?'<div class="sub">'+subHtml+'</div>':'')+'</div>';
  }
  function fgTone(v){ if(v==null) return 'flat'; if(v<=25) return 'down'; if(v>=65) return 'up'; return 'amber-t'; }

  function renderOverview(o){
    if(!o) return;
    var g=o.global||{}, fg=o.fear_greed;
    var html='';
    html+=tile('BTC / USD', o.btc?fmtPrice(o.btc.price):'—', o.btc?'<span class="'+pctCls(o.btc.chg24h)+'">'+fmtPct(o.btc.chg24h)+' 24h</span>':'');
    html+=tile('ETH / USD', o.eth?fmtPrice(o.eth.price):'—', o.eth?'<span class="'+pctCls(o.eth.chg24h)+'">'+fmtPct(o.eth.chg24h)+' 24h</span>':'');
    html+=tile('TOTAL CRYPTO MCAP', fmtBig(g.total_mcap), g.mcap_chg24h!=null?'<span class="'+pctCls(g.mcap_chg24h)+'">'+fmtPct(g.mcap_chg24h)+' 24h</span>':'');
    html+=tile('BTC DOMINANCE', g.btc_dominance!=null?g.btc_dominance.toFixed(1)+'%':'—','');
    html+=tile('FEAR &amp; GREED', fg?'<span class="'+fgTone(fg.value)+'">'+fg.value+'</span>':'—', fg?'<span class="'+fgTone(fg.value)+'">'+esc(fg.label)+'</span>':'');
    html+=tile('SPY', o.spy?fmtPrice(o.spy.price):'—', o.spy?'<span class="'+pctCls(o.spy.chg24h)+'">'+fmtPct(o.spy.chg24h)+' 1d</span>':'');
    html+=tile('VIX', o.vix?o.vix.price.toFixed(2):'—', o.vix?'<span class="'+pctCls(o.vix.chg24h)+'">'+fmtPct(o.vix.chg24h)+' 1d</span>':'');
    $('overview').innerHTML=html;
  }

  function meter(score){
    var on=Math.round((score||0)/10), h='';
    for(var i=0;i<10;i++) h+='<i class="'+(i<on?'on':'')+'"></i>';
    return '<span class="meter" role="img" aria-label="signal '+score+' of 100">'+h+'</span>';
  }
  function rsiCls(v){ if(v==null) return ''; if(v>=70) return 'rsi-hi'; if(v<=30) return 'rsi-lo'; return ''; }

  function assetUrl(assetClass,r){
    if(assetClass==='stock') return 'https://finance.yahoo.com/quote/'+encodeURIComponent(r.symbol);
    if(assetClass==='crypto'&&r.id) return 'https://www.coingecko.com/en/coins/'+encodeURIComponent(r.id);
    return null;
  }

  var SORT_COLS_LEFT = [
    {key:'symbol', label:'Asset', dir:1},
    {key:'price', label:'Price', dir:-1},
    {key:'chg24h', label:'24h', dir:-1},
    {key:'chg7d', label:'7d', dir:-1},
    {key:'rsi', label:'RSI', dir:-1}
  ];
  var SIGNAL_COL = {key:'score', label:'Signal', dir:-1};
  function sortableTh(c, spec, boardId){
    var active = spec&&spec.key===c.key;
    var arrow = active ? (spec.dir===1?' ▲':' ▼') : '';
    return '<th class="sortable'+(active?' active':'')+'" data-board="'+boardId+'" data-key="'+c.key+'" data-dir="'+(active?spec.dir:c.dir)+'">'+c.label+arrow+'</th>';
  }
  function sortRows(rows, spec){
    if(!spec||!rows) return rows;
    var key=spec.key, dir=spec.dir;
    return rows.slice().sort(function(a,b){
      var av=a[key], bv=b[key];
      if(av==null&&bv==null) return 0;
      if(av==null) return 1;
      if(bv==null) return -1;
      if(av<bv) return -dir;
      if(av>bv) return dir;
      return 0;
    });
  }

  function boardHtml(cfg, rowsIn, universe){
    var spec = state.sort[cfg.boardId];
    var rows = spec ? sortRows(rowsIn, spec) : rowsIn;
    var h='<section class="board '+cfg.side+'" aria-label="'+cfg.title+'">';
    h+='<div class="board-head"><div><div class="eyebrow">'+cfg.eyebrow+'</div><div class="board-title">'+cfg.title+'</div></div>';
    h+='<div class="board-count">TOP '+(rows?rows.length:0)+' / '+(universe||0)+' SCREENED</div></div>';
    h+='<div class="tbl-wrap"><table><thead><tr>';
    h+='<th>#</th>';
    SORT_COLS_LEFT.forEach(function(c){ h+=sortableTh(c, spec, cfg.boardId); });
    h+='<th>Range</th>';
    h+=sortableTh(SIGNAL_COL, spec, cfg.boardId);
    h+='</tr></thead><tbody>';
    if(rows&&rows.length){
      rows.forEach(function(r,i){
        var url = assetUrl(cfg.assetClass, r);
        var symHtml = url
          ? '<a class="sym-link" target="_blank" rel="noopener noreferrer" href="'+url+'" data-symbol="'+esc(r.symbol)+'" data-class="'+cfg.assetClass+'" data-side="'+cfg.side+'" data-rank="'+(i+1)+'" data-score="'+r.score+'"><span class="sym">'+esc(r.symbol)+'</span></a>'
          : '<span class="sym">'+esc(r.symbol)+'</span>';
        var name = r.name && r.name!==r.symbol ? '<span class="nm">'+esc(r.name)+'</span>' : '';
        var why = (r.drivers&&r.drivers.length)?'<span class="why">'+esc(r.drivers.join(' · '))+'</span>':'';
        var topInd = r.topIndicator ? '<span class="topind" title="Best individually-proven indicator for '+esc(r.symbol)+' so far, out of '+r.topIndicator.total+' scored calls">Leans on '+esc(r.topIndicator.id)+' ('+Math.round(r.topIndicator.accuracy*100)+'%)</span>' : '';
        var conf = r.conf ? '<span class="conf">'+r.conf.agree+'/'+r.conf.total+' aligned</span>' : '';
        var horizon = r.horizon ? '<span class="horizon '+(r.horizon.basis==='historical'?'hz-hist':'hz-meth')+'" title="'+(r.horizon.basis==='historical'?"Based on this asset's own historical accuracy by horizon":"Methodology estimate, not yet enough of this asset's own history to say")+'">'+esc(r.horizon.label)+(r.horizon.basis==='historical'?' ✓':'')+'</span>' : '';
        var rangeTitle = r.range && r.range.basis==='historical'
          ? "Band width from this asset's own historical move size at this horizon"
          : "Band width estimated from this asset's recent realized volatility, scaled to the horizon"+(r.volLookbackDays?" (a "+r.volLookbackDays+"-day lookback, calibrated to this asset)":"");
        var range = r.range ? '<span class="range '+(r.range.basis==='historical'?'hz-hist':'hz-meth')+'" title="'+rangeTitle+'">'+fmtPrice(r.range.low)+'–'+fmtPrice(r.range.high)+'</span>' : '<span class="dim">—</span>';
        h+='<tr class="in" style="animation-delay:'+(i*30)+'ms" data-symbol="'+esc(r.symbol)+'" data-class="'+cfg.assetClass+'">'
          +'<td class="rk">'+(i+1)+'</td>'
          +'<td class="asset">'+symHtml+name+why+topInd+'</td>'
          +'<td class="live-price-cell"><span class="live-price">'+fmtPrice(r.price)+'</span></td>'
          +'<td class="live-chg-cell '+pctCls(r.chg24h)+'"><span class="live-chg">'+fmtPct(r.chg24h)+'</span></td>'
          +'<td class="'+pctCls(r.chg7d)+'">'+fmtPct(r.chg7d)+'</td>'
          +'<td class="'+rsiCls(r.rsi)+'">'+(r.rsi!=null?r.rsi.toFixed(0):'—')+'</td>'
          +'<td>'+range+'</td>'
          +'<td><span class="sigcell"><span class="sigrow">'+meter(r.score)+'<span class="score">'+r.score+'</span></span>'+conf+horizon+'</span></td>'
          +'</tr>';
      });
    } else {
      h+='<tr><td colspan="8" style="text-align:left;padding:16px 10px;color:var(--dim)">No qualifying setups this hour.</td></tr>';
    }
    h+='</tbody></table></div></section>';
    return h;
  }

  function renderBoards(d){
    var b='';
    b+=boardHtml({side:'long', assetClass:'crypto', boardId:'crypto-long', eyebrow:'CRYPTO · <b>LONG SIDE</b>', title:'Breakout watch'}, d.crypto.breakout, d.crypto.universe);
    b+=boardHtml({side:'short', assetClass:'crypto', boardId:'crypto-short', eyebrow:'CRYPTO · <b>RISK SIDE</b>', title:'Breakdown risk'}, d.crypto.breakdown, d.crypto.universe);
    b+=boardHtml({side:'long', assetClass:'stock', boardId:'stock-long', eyebrow:'US EQUITIES · <b>LONG SIDE</b>', title:'Breakout watch'}, d.stocks.breakout, d.stocks.universe);
    b+=boardHtml({side:'short', assetClass:'stock', boardId:'stock-short', eyebrow:'US EQUITIES · <b>RISK SIDE</b>', title:'Breakdown risk'}, d.stocks.breakdown, d.stocks.universe);
    $('boards').innerHTML=b;
  }

  function renderTrackRecord(d){
    var list = d.highAccuracy||[];
    var head = '<div><div class="eyebrow">TRACK RECORD</div><div class="tr-title">95%+ prediction accuracy so far</div></div>';
    var el = $('trackRecord');
    if(!list.length){
      el.innerHTML = head + '<div class="tr-empty">No asset has crossed the 95% mark yet. Each asset needs a meaningful number of matured, scored predictions first — pooling its composite directional calls, its price-range accuracy, and its pivot-style (reversal/dwell) calls — before a score shows at all, so this fills in gradually as the hourly track record accumulates. Not empty because nothing works; empty because not enough has matured to say yet.</div>';
      return;
    }
    var rows = list.map(function(r){
      return '<div class="tr-row"><span class="tr-sym">'+esc(r.symbol)+'</span><span class="tr-name">'+esc(r.name||'')+'</span><span class="tr-class">'+(r.asset_class==='crypto'?'CRYPTO':'EQUITY')+'</span><span class="tr-score">'+r.score+'%</span><span class="tr-samples">'+r.samples+' calls</span></div>';
    }).join('');
    el.innerHTML = head + '<div class="tr-list">'+rows+'</div>';
  }

  // Delegated so re-renders (refresh, sort change) never need re-binding.
  $('boards').addEventListener('click', function(e){
    var link = e.target.closest('.sym-link');
    if(link){
      pushEvent('signals_asset_click',{
        symbol: link.getAttribute('data-symbol'),
        asset_class: link.getAttribute('data-class'),
        side: link.getAttribute('data-side'),
        rank: Number(link.getAttribute('data-rank')),
        score: Number(link.getAttribute('data-score'))
      });
      return;
    }
    var th = e.target.closest('th.sortable');
    if(th && state.data){
      var board = th.getAttribute('data-board'), key = th.getAttribute('data-key');
      var dir = Number(th.getAttribute('data-dir'));
      var prev = state.sort[board];
      // Same column clicked again: flip direction. Otherwise use the column's sensible default.
      var newDir = (prev && prev.key===key) ? -prev.dir : dir;
      state.sort[board] = {key:key, dir:newDir};
      pushEvent('signals_sort_change',{board:board, sort_key:key, sort_dir:newDir===1?'asc':'desc'});
      renderBoards(state.data);
    }
  });

  function renderStatus(d){
    var t=new Date(d.generated_at);
    $('lastSync').textContent = pad(t.getUTCHours())+':'+pad(t.getUTCMinutes())+' UTC';
    var hs=$('healthStat');
    var eq=d.health.stocks_ok+'/'+d.health.stocks_total;
    var cg=d.health.coingecko?'CG OK':'CG DOWN';
    var val='VAL '+(d.health.valuation_ok||0);
    var cd='CG-D '+(d.health.crypto_daily_ok||0)+'/'+(d.health.crypto_daily_total||0);
    hs.innerHTML='FEEDS <b>'+cg+' · '+cd+' · EQ '+eq+' · '+val+'</b>';
    hs.className='stat'+((!d.health.coingecko||d.health.stocks_ok<d.health.stocks_total*0.8)?' warn':'');
    var ageH=(Date.now()-t.getTime())/36e5;
    $('sysState').textContent = ageH>2 ? 'STALE' : 'LIVE';
    $('sysDot').style.background = ageH>2 ? 'var(--down)' : 'var(--amber)';
    $('metaUniverse').textContent = (d.crypto.universe||0)+' + '+(d.stocks.universe||0);
    $('stateBox').innerHTML = ageH>2
      ? '<div class="notice"><b>Feed is stale.</b> Showing the last successful sync from '+t.toUTCString()+'. The engine rebuilds on the next request once upstream sources respond.</div>'
      : '';
  }

  function renderError(msg){
    $('sysState').textContent='OFFLINE';
    $('sysDot').style.background='var(--down)';
    $('stateBox').innerHTML='<div class="notice"><b>Signal feed unreachable.</b><br>'
      +'This dashboard reads from its own <code>api/signals</code> function relative to this page. If you opened this file directly from disk, that function is not running.<br>'
      +'Deploy the project (see README) or run it locally with <code>npx vercel dev</code>, then reload.<br>'
      +'<span style="color:var(--dim)">Detail: '+esc(msg)+'</span></div>';
  }

  var firstLoadTracked=false;
  function pushEvent(name,params){
    window.dataLayer=window.dataLayer||[];
    window.dataLayer.push(Object.assign({event:name},params||{}));
  }

  var LIVE_MS = 20*1000;
  function flashCell(el){
    if(!el) return;
    el.classList.remove('flash');
    void el.offsetWidth; // restart the CSS animation on repeated ticks
    el.classList.add('flash');
  }

  // Between-build price ticks. Independent of load()/REFETCH_MS on purpose:
  // this only ever touches price and 24h change text already in the DOM,
  // never re-renders or re-sorts a board, so it can't disturb someone
  // mid-sort or mid-scroll the way a full renderBoards() would.
  function updateLivePrices(){
    fetch(PRICES_URL,{cache:'no-store'})
      .then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
      .then(function(d){
        if(!d || (!d.crypto && !d.stocks)) return;
        var rows = document.querySelectorAll('#boards tr[data-symbol]');
        rows.forEach(function(row){
          var sym = row.getAttribute('data-symbol'), cls = row.getAttribute('data-class');
          var map = cls==='crypto' ? d.crypto : cls==='stock' ? d.stocks : null;
          var v = map && map[sym];
          if(!v) return;
          var priceEl = row.querySelector('.live-price');
          if(priceEl && v.price!=null){
            var newPrice = fmtPrice(v.price);
            if(priceEl.textContent!==newPrice){ priceEl.textContent=newPrice; flashCell(row.querySelector('.live-price-cell')); }
          }
          var chgEl = row.querySelector('.live-chg');
          if(chgEl && v.chg24h!=null){
            var newChg = fmtPct(v.chg24h);
            if(chgEl.textContent!==newChg){
              chgEl.textContent=newChg;
              var chgCell = row.querySelector('.live-chg-cell');
              chgCell.className='live-chg-cell '+pctCls(v.chg24h);
              flashCell(chgCell);
            }
          }
        });
        var t=new Date();
        $('liveStamp').textContent = pad(t.getUTCHours())+':'+pad(t.getUTCMinutes())+':'+pad(t.getUTCSeconds())+' UTC';
      })
      .catch(function(){ /* silent: a missed live tick isn't a feed error, load() already surfaces those */ });
  }

  function load(){
    var cacheState=null;
    fetch(DATA_URL,{cache:'no-store'})
      .then(function(r){ cacheState=r.headers.get('x-fcs-cache'); if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
      .then(function(d){
        state.data=d; state.error=null;
        renderStatus(d); renderOverview(d.overview); renderBoards(d); renderTrackRecord(d);
        if(!firstLoadTracked){
          firstLoadTracked=true;
          pushEvent('signals_data_loaded',{
            cache_state: cacheState||'unknown',
            data_age_minutes: Math.round((Date.now()-new Date(d.generated_at).getTime())/60000),
            crypto_universe: d.crypto.universe||0,
            stocks_universe: d.stocks.universe||0
          });
        }
      })
      .catch(function(e){
        state.error=e;
        if(!state.data){
          renderError(e.message||String(e));
          pushEvent('signals_feed_error',{error_detail:String(e.message||e).slice(0,100)});
        }
      })
      .finally(function(){ nextCheckAt = Date.now()+REFETCH_MS; });
  }
  load();
  setTimeout(updateLivePrices, 2000); // small delay so the boards exist to patch into
  var methodologyEl=document.querySelector('details');
  if(methodologyEl) methodologyEl.addEventListener('toggle',function(){
    if(methodologyEl.open) pushEvent('signals_methodology_open',{});
  });
  setInterval(load, REFETCH_MS);
  setInterval(updateLivePrices, LIVE_MS);
})();
</script>
</body>
</html>
`;

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin'
};

const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline' https://www.googletagmanager.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data: https://www.google-analytics.com",
  "connect-src 'self' https://www.googletagmanager.com https://www.google-analytics.com https://analytics.google.com https://region1.google-analytics.com",
  "frame-ancestors 'none'",
  "base-uri 'none'"
].join('; ');

function json(obj, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=300',
      ...SECURITY_HEADERS,
      ...(extraHeaders || {})
    }
  });
}

// ----------------------------- WORKER ENTRY ---------------------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    let path = url.pathname;

    // Normalize the mount so it works whether bound at /signals* or served
    // at the zone root during local testing.
    if (path === MOUNT) {
      return Response.redirect(url.origin + MOUNT + '/', 301);
    }
    if (path.startsWith(MOUNT)) path = path.slice(MOUNT.length) || '/';

    // API — this Worker only ever reads KV. The engine (buildPayload, ~130
    // outbound fetches + indicator math across ~260 assets) runs in a
    // scheduled GitHub Actions job instead, which writes the result straight
    // into this namespace. Keeping fetch() to a single KV read means this
    // stays well inside Workers Free plan's 50-subrequest / 10ms-CPU caps
    // even though the engine itself does not.
    if (path === '/api/signals' || path === 'api/signals') {
      const cached = await getCached(env);
      if (cached) {
        return json(cached, { 'X-FCS-Cache': isFresh(cached) ? 'hit' : 'stale' });
      }
      return json({ error: 'signals not yet built — waiting on the first scheduled build to populate the cache' }, { 'X-FCS-Cache': 'empty' });
    }

    // Live price ticks between hourly rebuilds — deliberately the one
    // exception to the "single KV read" rule above. Symbols come from the
    // cached payload itself (whatever's currently displayed), never from
    // the request, so a caller can't make this fan out to an arbitrary
    // number of upstream calls. Worst case is one CoinGecko call plus one
    // Yahoo call per displayed equity (at most 20, deduped) — comfortably
    // inside the 50-subrequest cap, and cheap on CPU since there's no
    // indicator math here, just passthrough JSON. Scores, ranges, and
    // every technique call still only change on the hourly rebuild — this
    // route only ever touches price and 24h change.
    if (path === '/api/prices' || path === 'api/prices') {
      const cached = await getCached(env);
      if (!cached) return json({ error: 'signals not yet built' }, { 'Cache-Control': 'no-store' });

      // See LIVE_PRICE_CACHE_KEY's docs: this is what actually keeps
      // CoinGecko's free-tier rate limit from biting under real traffic,
      // not a retry. Response is identical to a fresh fetch either way —
      // X-FCS-Live-Cache just says which path served it.
      const cachedLive = await getCachedLivePrices(env);
      if (cachedLive) return json(cachedLive, { 'Cache-Control': 'no-store', 'X-FCS-Live-Cache': 'hit' });

      const cryptoRows = [...((cached.crypto && cached.crypto.breakout) || []), ...((cached.crypto && cached.crypto.breakdown) || [])];
      const stockRows = [...((cached.stocks && cached.stocks.breakout) || []), ...((cached.stocks && cached.stocks.breakdown) || [])];
      const cryptoIdToSymbol = new Map(cryptoRows.filter(r => r.id).map(r => [r.id, r.symbol]));
      const stockSymbols = [...new Set(stockRows.map(r => r.symbol))];

      const [cryptoPricesById, stockResults] = await Promise.all([
        coingeckoSimplePrice([...cryptoIdToSymbol.keys()]).catch(() => ({})),
        pool(stockSymbols, 10, (s) => yahooQuote(s))
      ]);

      const crypto = {};
      for (const [id, symbol] of cryptoIdToSymbol) {
        if (cryptoPricesById[id]) crypto[symbol] = cryptoPricesById[id];
      }
      const stocks = {};
      for (const r of stockResults) {
        if (r && !r._error) stocks[r.symbol] = { price: r.price, chg24h: r.chg24h };
      }
      // Fall back to the hourly build's own price/chg24h for anything the
      // live fetch missed (rate-limited, thin/renamed id, Yahoo hiccup) —
      // still real data, just not freshly ticked, rather than a gap the
      // dashboard has to guess how to render.
      for (const r of cryptoRows) if (!crypto[r.symbol] && r.price != null) crypto[r.symbol] = { price: r.price, chg24h: r.chg24h };
      for (const r of stockRows) if (!stocks[r.symbol] && r.price != null) stocks[r.symbol] = { price: r.price, chg24h: r.chg24h };

      const body = { crypto, stocks, generated_at: new Date().toISOString() };
      ctx.waitUntil(putCachedLivePrices(env, body));
      return json(body, { 'Cache-Control': 'no-store', 'X-FCS-Live-Cache': 'miss' });
    }

    // Dashboard (any other path under the mount)
    return new Response(PAGE_HTML, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=600',
        'Content-Security-Policy': PAGE_CSP,
        'X-Frame-Options': 'DENY',
        ...SECURITY_HEADERS
      }
    });
  }
};
