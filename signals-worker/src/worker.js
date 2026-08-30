// ===========================================================================
// FRONTIER CAPITAL SIGNALS — Cloudflare Worker (single file, no Vercel)
//
// One Worker serves the dashboard and holds the confluence engine:
//   GET  /signals            -> 301 to /signals/
//   GET  /signals/           -> dashboard HTML
//   GET  /signals/api/signals-> JSON (served from KV cache, <=60 min old)
//   cron */5 * * * *         -> dispatches the external refresh workflow
//                                only when the KV payload is stale
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
//   5. Worker -> Settings -> Triggers -> Cron Triggers -> add: */5 * * * *
//   6. Worker -> Settings -> Variables -> add the GITHUB_ACTIONS_TOKEN
//        secret (see README) to enable stale-cache refresh dispatches.
//   7. (optional valuation override) Settings -> Variables -> add
//        TREFIS_OVERRIDES = {"AAPL":275.0,"NFLX":88.0}
//   Then open https://frontiercapitalsignals.com/signals
//
//   wrangler alternative: put this at src/worker.js with a wrangler.toml
//   declaring the KV binding + [triggers] crons = ["*/5 * * * *"], then
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
// Written by scripts/intraday-tick.mjs (its own ~5-minute cron, not this
// Worker) — a single pre-computed KV read here, same "Worker never
// computes, only serves" shape as CACHE_KEY/getCached below, just a
// separate key and a shorter freshness window (the intraday pipeline is
// meant to be far fresher than the hourly-ish engine).
export const INTRADAY_CACHE_KEY = 'signals:intraday';
const INTRADAY_FRESH_SECONDS = 45 * 60;

// ----------------------------- CONFIG ---------------------------------------

export const CACHE_SECONDS = 3600;
// GitHub Actions' native cron can delay or drop clusters of scheduled runs.
// Cloudflare invokes this lightweight Worker cron independently; it reads one
// KV value and only asks GitHub to run the existing heavy external build after
// the cached payload actually becomes stale. The KV lock avoids repeat
// dispatches while a delayed GitHub job is still starting.
const REFRESH_DISPATCH_LOCK_KEY = 'signals:refresh-dispatch-lock';
const REFRESH_DISPATCH_LOCK_SECONDS = 30 * 60;
// Cooldown after a FAILED dispatch. Deliberately much shorter than the success
// lock (a failure means no build was started, so recovery should be retried
// soon) but long enough that a broken token cannot turn every inbound request
// into an outbound GitHub call.
const REFRESH_DISPATCH_FAILURE_COOLDOWN_SECONDS = 5 * 60;
// Running session extremes for the day-trading read, plus the alert state that
// stops one stretched asset from re-notifying every 5 minutes. Both live in KV
// rather than D1: they are written on every cron tick, and D1 bills per row
// written (see the 2026-08-25 cost work) where KV does not.
const SESSION_EXTREMES_KEY = 'signals:session-extremes';
const SESSION_EXTREMES_TTL_SECONDS = 3 * 24 * 3600;
const DAY_RANGE_ALERT_STATE_KEY = 'signals:day-range-alert-state';
// One alert per symbol per side per session. A stretched asset stays stretched
// for hours; re-firing every tick would make the channel useless.
const DAY_RANGE_ALERT_TTL_SECONDS = 36 * 3600;
const REFRESH_DISPATCH_STATUS_KEY = 'signals:refresh-dispatch-status';
const REFRESH_DISPATCH_STATUS_SECONDS = 24 * 60 * 60;
const GITHUB_REFRESH_DISPATCH_URL = 'https://api.github.com/repos/chiduwa/frontiercapitalsignals/actions/workflows/signals-refresh.yml/dispatches';
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

// Always evaluated and always shown in their own pinned dashboard section
// (see rankBoards' favorites below), regardless of current rank or
// whether they'd otherwise crack the top-10 breakout/breakdown boards —
// the user wants these specific 4 visible every run, not just when they
// happen to place. Also bypasses the CRYPTO_MIN_MCAP/CRYPTO_MIN_VOLUME
// floor below (still subject to CRYPTO_BLOCKLIST and simply needing to be
// in CoinGecko's fetched top-CRYPTO_UNIVERSE page at all), so "always"
// actually means always, not "usually, since they're currently large-cap."
export const FAVORITE_SYMBOLS = new Set(['BTC', 'ETH', 'SOL', 'XLM', 'XRP', 'HYPE', 'HBAR']);

export const CRYPTO_BLOCKLIST = new Set([
  'usdt','usdc','usds','usde','dai','fdusd','pyusd','tusd','usdp','gusd','frax',
  'lusd','susd','usdd','usdy','usd0','usdtb','rlusd','eurc','eurt','usdx','buidl',
  'wbtc','weth','wsteth','steth','cbbtc','cbeth','reth','weeth','rseth','ezeth',
  'jitosol','msol','bnsol','tbtc','lbtc','solvbtc','wbeth','frxeth','sfrxeth',
  'oseth','lseth','swbtc','meth','susds','sdai','xaut','jlp','wbnb',
  // Found live 2026-08-24 while verifying the long-term-potential
  // category: all three traded in a tight $0.96-$1.01 band across their
  // full archived history (confirmed via direct query, not assumed from
  // the ticker name) — stable-value assets that slipped past this list
  // and were showing up as false "long-term potential" candidates simply
  // by virtue of never moving much at all.
  'bfusd','gho','usd1'
]);

// Ticker blocklists are necessary but not sufficient: CoinGecko can add a
// newly launched peg before it is known here. Keep obvious USD-pegged assets
// out of directional boards even when their ticker is new, without excluding
// ordinary assets whose names merely contain "usd".
export function isStableValueAsset(asset) {
  const symbol = String(asset?.symbol || '').toLowerCase();
  const id = String(asset?.id || '').toLowerCase();
  const name = String(asset?.name || '').toLowerCase();
  if (CRYPTO_BLOCKLIST.has(symbol)) return true;
  if (/^(usd|usdt|usdc|usde|usds|dai|fdusd|pyusd|tusd|usdp|gusd|frax|lusd|susd|usdd|usdy|usd0|usdtb|rlusd|eurc|eurt|bfusd|gho|usd1)$/.test(symbol)) return true;
  if (/(stablecoin|usd coin|tether|dai stablecoin|frax usd|pax dollar|trueusd|gemini dollar|usdd)/.test(name) || /(^|-)usd-?stable/.test(id)) return true;
  return false;
}

export function dailyMovementStats(bars) {
  const moves = [];
  for (let i = 1; i < (bars || []).length; i++) {
    const prev = bars[i - 1]?.close, close = bars[i]?.close;
    if (prev > 0 && close > 0) moves.push({ date: bars[i].date || null, pct: (close / prev - 1) * 100, dollar: close - prev });
  }
  if (!moves.length) return null;
  const by = (field, sign) => moves.reduce((best, row) => sign * row[field] > sign * best[field] ? row : best, moves[0]);
  const sorted = moves.map((m) => Math.abs(m.pct)).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return {
    highestGain: by('pct', 1),
    highestLoss: by('pct', -1),
    medianAbsPct: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
    samples: moves.length
  };
}

export const STOCK_WATCHLIST = [
  'AAPL','MSFT','NVDA','GOOGL','AMZN','META','TSLA','AVGO',
  'JPM','GS','MS','BAC','WFC','C','V','MA',
  'XOM','CVX','COP','MPC','VLO','PBF','DINO',
  'GE','BA','CAT','DE','LMT','RTX',
  'NFLX','DIS','TSM','ASML','AMD','MU','INTC','QCOM',
  'ORCL','IBM','CRM','NOW','PLTR',
  'CRWD','PANW','ZS','DDOG','SNOW','NET',
  'DELL','SMCI','UNH','LLY','JNJ','ISRG',
  'COIN','HOOD','MSTR','DASH','UBER','LCID','SNAP'
];

export const OVERVIEW_SYMBOLS = ['SPY', 'QQQ', '^VIX'];

// Macro benchmarks: not screened against the confluence score like crypto/
// stocks are (nothing "trades" DXY/Gold/Oil here), fetched purely as
// market-wide context and — via the permanent archive (see
// scripts/backfill-history.mjs, which includes these in its universe) — as
// candidate leaders for the cross-asset lead/lag engine. A lot of textbook
// lead/lag relationships run through exactly these three (a rising dollar
// often leads crypto/gold weaker, oil leads inflation-sensitive equities,
// etc.). `yahoo` is the fetch ticker; `symbol` is the stable name used
// everywhere else in the pipeline (archive rows, payload.overview, D1).
// UST2Y/UST10Y confirmed live on Yahoo with no auth needed (same no-crumb
// chart endpoint as yahooDaily): ^TNX is the 10-year yield directly,
// 2YY=F is 2-year yield futures (no clean ^-prefixed 2Y spot index exists
// on Yahoo). Their daily spread (UST10Y - UST2Y, the standard "2s10s"
// convention — negative means an inverted curve, a classic recession
// signal) is computed separately as a derived SPREAD:2s10s pseudo-symbol,
// same pattern as the SECTOR:* composites from the prior round.
export const BENCHMARK_SYMBOLS = [
  { symbol: 'DXY', yahoo: 'DX-Y.NYB', label: 'US Dollar Index' },
  { symbol: 'GOLD', yahoo: 'GC=F', label: 'Gold futures' },
  { symbol: 'OIL', yahoo: 'CL=F', label: 'WTI crude futures' },
  { symbol: 'UST2Y', yahoo: '2YY=F', label: '2-Year Treasury yield' },
  { symbol: 'UST10Y', yahoo: '^TNX', label: '10-Year Treasury yield' }
];

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

// The low/high of the same window rangePos measures against. Published on each
// board row so the live price layer can recompute rangePos at the new price
// rather than leaving a position that silently belongs to an older price.
export function rangeBounds(values) {
  if (!values || !values.length) return null;
  const hi = Math.max(...values), lo = Math.min(...values);
  if (!Number.isFinite(hi) || !Number.isFinite(lo) || hi === lo) return null;
  return { low: lo, high: hi };
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
const RELIABILITY_PRIOR_SAMPLES = 12;
const CALIBRATION_CONFIDENCE_MIN_SAMPLES = 40;
const DETAILED_CALIBRATION_CONFIDENCE_MIN_SAMPLES = 30;
const ALERT_CONFIDENCE_Z = 1.645; // One-sided 95% Wilson lower bound.
// Minimum demonstrated edge over the measured no-skill baseline before a call
// is marked actionable. Expressed as an edge, not an absolute hit rate, so it
// means the same thing in a class that guesses right 38% of the time as in one
// that guesses right 52% of the time.
const MIN_ACTIONABLE_EDGE = 0.18;
// A whole asset class's composite record needs at least this many matured
// outcomes before it is judged fit (or unfit) to publish. Well above
// MIN_RELIABILITY_SAMPLES: suppressing an entire class is a much heavier call
// than reweighting one technique on one asset.
const CLASS_SKILL_MIN_SAMPLES = 150;

// reliability: optional flat map built by scripts/reliability.mjs from D1,
// `${symbol}|${techniqueId}` -> { accuracy, total } (accuracy already
// blended across the 24h/168h horizons there). accuracy 1.0 (always right
// for this asset) -> 1.5x weight; accuracy 0.0 (always wrong) -> 0.5x;
// accuracy 0.5 (coin flip, no information) -> 1x, unchanged from today.
// A raw hit-rate above 50% at exactly MIN_RELIABILITY_SAMPLES can easily be
// noise, not a real edge — with 25+ techniques now competing for weight
// per asset, *something* will clear a naive ">50% given 20 samples" bar by
// chance alone (the multiple-testing problem). Normal approximation to the
// one-sample binomial proportion test against the null of a fair coin
// (p=0.5) — well-behaved at this sample-size range and symmetric around
// 0.5, unlike an exact binomial computation that needs combinatorics prone
// to precision issues in plain JS at larger n. alpha=0.01 (two-sided,
// z >= ~2.576), stricter than the conventional 0.05 given how many
// techniques are competing, but deliberately not a full Bonferroni
// correction (1 / active-technique-count) — that would shift, and
// destabilize, the bar every time a technique is added or removed, and
// would over-penalize thinner-history assets far more than the noise
// problem it's meant to solve justifies.
// Exported so scripts/correlation-research.mjs can reuse the exact same
// significance bar for its own two-sample tests (twoSampleZTest below) —
// one shared threshold, not two independently-chosen ones that could
// quietly drift apart.
export const RELIABILITY_SIGNIFICANCE_Z = 2.576;

// The no-skill accuracy a directional record should actually be judged
// against. NOT 0.5: outcomes are three-way (up / flat / down, the
// OUTCOME_DEADBAND_PCT zone in reliability.mjs) while a technique only ever
// votes +1 or -1, so a flat outcome marks an up-call and a down-call BOTH
// wrong. That pushes every technique's ceiling below 0.5 before any question
// of skill arises — measured live on this engine's own bars, a coin-flip
// directional call scores ~38-42% at 24h, not 50%.
//
// Testing against 0.5 therefore mislabels genuinely informative techniques as
// "worse than chance" and shrinks them toward a neutral weight, and — the
// other half of the same error — flatters a technique in a class whose true
// baseline sits above 0.5 (stocks at 168h: 52.1% of windows closed up, so
// 52% accuracy there is worth nothing).
//
// `dist` is one { n_up, n_flat, n_down } row from direction_baseline for this
// record's asset class and horizon. `votesUp`/`votesDown` are the record's own
// directional mix: a technique that only ever calls "up" has null accuracy
// P(up), one that splits evenly gets the blend. Falls back to 0.5 only when
// there is no measured distribution yet, which preserves the previous
// behavior for a cold database rather than inventing a number.
export const BASELINE_MIN_SAMPLES = 60;

export function noSkillBaseline(dist, votesUp, votesDown) {
  if (!dist) return 0.5;
  const total = (dist.n_up || 0) + (dist.n_flat || 0) + (dist.n_down || 0);
  if (!total || total < BASELINE_MIN_SAMPLES) return 0.5;
  const pUp = (dist.n_up || 0) / total;
  const pDown = (dist.n_down || 0) / total;
  const up = Number.isFinite(votesUp) ? votesUp : 0;
  const down = Number.isFinite(votesDown) ? votesDown : 0;
  const votes = up + down;
  // No recorded mix (a record written before votes_up/votes_down existed):
  // judge it against the best constant call available, which is the hardest
  // honest bar and never flatters an unknown mix.
  if (!votes) return clamp(Math.max(pUp, pDown), 0, 1);
  return clamp((up * pUp + down * pDown) / votes, 0, 1);
}

// Two-sided binomial proportion test against `p0` — the measured no-skill
// baseline rather than a fair coin. alpha=0.01 (z >= ~2.576), stricter than
// the conventional 0.05 given how many techniques compete for weight per
// asset; deliberately not a full Bonferroni correction, which would shift the
// bar every time a technique is added or removed.
export function isReliabilitySignificant(correct, total, p0 = 0.5) {
  if (!total) return false;
  const base = Number.isFinite(p0) ? clamp(p0, 0.001, 0.999) : 0.5;
  const se = Math.sqrt(base * (1 - base) / total);
  if (!se) return false;
  const z = (correct / total - base) / se;
  return Math.abs(z) >= RELIABILITY_SIGNIFICANCE_Z;
}

// Skill relative to the no-skill baseline, with a one-sided Wilson lower
// bound on the record's own accuracy so a thin, lucky-looking streak cannot
// present as a real edge. Positive `lowerEdge` is the honest bar for "this
// has demonstrated information," and is what the publication gates below use
// instead of a raw hit rate.
export function skillOverBaseline(correct, total, p0) {
  if (!Number.isFinite(correct) || !Number.isFinite(total) || total <= 0) return null;
  const base = Number.isFinite(p0) ? clamp(p0, 0, 1) : 0.5;
  const accuracy = clamp(correct / total, 0, 1);
  const lower = lowerConfidenceBound(correct, total);
  if (lower == null) return null;
  return {
    accuracy,
    baseline: base,
    edge: accuracy - base,
    lowerEdge: lower - base,
    samples: total,
    significant: isReliabilitySignificant(correct, total, base)
  };
}

// 'trending' when this asset's own swing-structure read is clearly
// higher-highs/higher-lows or lower-highs/lower-lows (m.structure 1 or
// -1), 'choppy' when it found neither (0), null when there wasn't enough
// history yet to compute structure at all. One shared label space for both
// sides of the regime split: the write path (rankBoards' votesLog, frozen
// at the moment a vote is cast) and the read path (reliabilityMultiplier
// below, evaluated fresh against the asset's CURRENT regime every call).
export function regimeOf(structure) {
  if (structure == null) return null;
  return structure !== 0 ? 'trending' : 'choppy';
}

// byRegime/regime: optional (Phase 6) — { trending: {...}, choppy: {...} },
// each shaped exactly like `reliability` itself (loadRegimeReliability,
// reliability.mjs), plus the asset's OWN current regime. Prefers the
// asset's regime-specific track record when one exists and clears the
// exact same MIN_RELIABILITY_SAMPLES + significance bar blended does —
// falls back to blended whenever regime-specific samples are too thin
// (a fresh regime split starts empty for every asset) or the current
// regime is unknown (m.structure hasn't got enough history yet). Never a
// stricter bar for regime than blended: this is a more specific answer to
// the same question, not a new one, so it shouldn't need to work harder to
// be trusted.
export function reliabilityMultiplier(reliability, symbol, techniqueId, byRegime, regime) {
  return reliabilityMultiplierForAssetClass(reliability, symbol, techniqueId, byRegime, regime);
}

// Picks the direction_baseline row matching this record and turns it into the
// null accuracy for the record's own directional mix. `baselines` is the map
// loadDirectionBaselines (reliability.mjs) builds, keyed "assetClass|horizon";
// a blended-across-horizons record has no single horizon, so it is judged
// against the union of the class's horizons. Returns 0.5 when nothing has been
// measured yet, which leaves cold-start behavior exactly as it was.
export function baselineFor(baselines, assetClass, horizonHours, record) {
  if (!baselines || !assetClass) return 0.5;
  const dist = horizonHours != null
    ? baselines[`${assetClass}|${horizonHours}`]
    : baselines[`${assetClass}|all`];
  return noSkillBaseline(dist, record && record.votes_up, record && record.votes_down);
}

export function techniquePriorRecord(techniquePriors, assetClass, techniqueId) {
  if (!techniquePriors || !techniqueId) return null;
  return (assetClass && techniquePriors.byAssetClass && techniquePriors.byAssetClass[assetClass] && techniquePriors.byAssetClass[assetClass][techniqueId])
    || (techniquePriors.overall && techniquePriors.overall[techniqueId])
    || null;
}

export function adjustedReliabilityAccuracy(correct, total, baselineAccuracy = 0.5, priorSamples = RELIABILITY_PRIOR_SAMPLES) {
  if (!Number.isFinite(correct) || !Number.isFinite(total) || total <= 0) return clamp(baselineAccuracy, 0, 1);
  const priorN = Number.isFinite(priorSamples) && priorSamples > 0 ? priorSamples : 0;
  const priorAcc = Number.isFinite(baselineAccuracy) ? clamp(baselineAccuracy, 0, 1) : 0.5;
  return clamp((correct + priorAcc * priorN) / (total + priorN), 0, 1);
}

// `baselines` (optional) is loadDirectionBaselines' map. When present, every
// significance test and weight below is judged against the measured no-skill
// line for this asset class instead of a fair coin — the single change that
// stops the loop from reading a whole technique library as "below average"
// purely because flat outcomes count against both directions.
export function reliabilityMultiplierForAssetClass(reliability, symbol, techniqueId, byRegime, regime, assetClass, techniquePriors, baselines) {
  if (!reliability) return 1;
  const prior = techniquePriorRecord(techniquePriors, assetClass, techniqueId);
  const priorSamples = Math.min(RELIABILITY_PRIOR_SAMPLES, prior && Number.isFinite(prior.total) ? prior.total : 0);
  if (regime && byRegime && byRegime[regime]) {
    const rrec = byRegime[regime][`${symbol}|${techniqueId}`];
    if (rrec && rrec.total >= MIN_RELIABILITY_SAMPLES) {
      const base = baselineFor(baselines, assetClass, null, rrec);
      if (isReliabilitySignificant(rrec.correct, rrec.total, base)) {
        // Shrink toward the technique's class-level record when there is one,
        // otherwise toward the measured baseline — never toward a 0.5 that
        // this asset class was never going to reach.
        const priorAcc = prior && Number.isFinite(prior.accuracy) ? prior.accuracy : base;
        return reliabilityWeight(adjustedReliabilityAccuracy(rrec.correct, rrec.total, priorAcc, priorSamples), rrec.total, base);
      }
    }
  }
  const rec = reliability[`${symbol}|${techniqueId}`];
  if (!rec || rec.total < MIN_RELIABILITY_SAMPLES) return 1;
  const base = baselineFor(baselines, assetClass, null, rec);
  if (!isReliabilitySignificant(rec.correct, rec.total, base)) return 1;
  const priorAcc = prior && Number.isFinite(prior.accuracy) ? prior.accuracy : base;
  return reliabilityWeight(adjustedReliabilityAccuracy(rec.correct, rec.total, priorAcc, priorSamples), rec.total, base);
}

// `p0` is the measured no-skill baseline for this record (noSkillBaseline
// above), not a fair coin. Weight 1.0 now means "exactly as good as guessing
// in this asset class at this horizon" wherever that line actually sits,
// instead of assuming it sits at 0.5. Skill is normalized by the headroom
// available on whichever side of the baseline the accuracy falls, so always-
// right still maps to +1 and always-wrong to -1 for any baseline.
// At p0 = 0.5 this reduces exactly to the previous formula.
export function reliabilityWeight(accuracy, total, p0 = 0.5) {
  if (!Number.isFinite(accuracy) || !Number.isFinite(total) || total < MIN_RELIABILITY_SAMPLES) return 1;
  const base = Number.isFinite(p0) ? clamp(p0, 0.001, 0.999) : 0.5;
  const spread = accuracy >= base ? (1 - base) : base;
  const normalized = clamp((accuracy - base) / spread, -1, 1);
  // Preserve the established, significance-gated behavior while a record is
  // still small. Once an asset/technique has a genuinely deep record, reduce
  // the influence of an extreme raw hit rate so long-lived learning does not
  // overfit one historical regime.
  if (total < 100) return clamp(1 + normalized * 0.5, 0.5, 1.5);
  const confidence = Math.min(1, Math.sqrt(total / 100));
  return clamp(1 + normalized * confidence, 0.5, 1.5);
}

export function comboReinforcementMultiplier(comboReliability, symbol, techniqueId, dir, activeTechniques, assetClass, techniquePriors) {
  if (!comboReliability || !symbol || !techniqueId || !dir || !Array.isArray(activeTechniques) || activeTechniques.length < 2) return 1;
  let best = 1;
  for (const other of activeTechniques) {
    if (!other || other.id === techniqueId || other.dir !== dir) continue;
    const [a, b] = [techniqueId, other.id].sort();
    const rec = comboReliability[`${symbol}|${a}|${b}`];
    if (!rec || rec.total < MIN_RELIABILITY_SAMPLES || !isReliabilitySignificant(rec.correct, rec.total)) continue;
    const priorA = techniquePriorRecord(techniquePriors, assetClass, techniqueId);
    const priorB = techniquePriorRecord(techniquePriors, assetClass, other.id);
    const priorAccs = [priorA && priorA.accuracy, priorB && priorB.accuracy].filter(Number.isFinite);
    const priorTotals = [priorA && priorA.total, priorB && priorB.total].filter(Number.isFinite);
    const priorAccuracy = priorAccs.length ? priorAccs.reduce((a_, b_) => a_ + b_, 0) / priorAccs.length : 0.5;
    const priorSamples = Math.min(RELIABILITY_PRIOR_SAMPLES, priorTotals.length ? Math.min(...priorTotals) : 0);
    const adjusted = adjustedReliabilityAccuracy(rec.correct, rec.total, priorAccuracy, priorSamples);
    const boost = clamp(1 + Math.max(0, adjusted - 0.5) * 0.3, 1, 1.15);
    if (boost > best) best = boost;
  }
  return best;
}

// Decile bucket (0-9) of a 0-100 composite score, for the calibration
// curve (see evaluateMatured/loadCalibration in reliability.mjs) — bucket
// 0 covers [0,10), bucket 9 covers [90,100]. Clamped, not just floored:
// score is already clamped to [0,100] by confluence()'s own return, but
// exactly 100 would otherwise floor-divide to bucket 10, off the end.
export function scoreBucket(score) {
  return Math.min(9, Math.max(0, Math.floor(score / 10)));
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
  seasonal:    { leading: true,  horizonDays: 7 },
  fibonacci:   { leading: true,  horizonDays: 3 },
  timeofday:   { leading: true,  horizonDays: 0.2 },
  openinterest:{ leading: false, horizonDays: 3 },
  sentiment:   { leading: true,  horizonDays: 4 },
  leadlag:     { leading: true,  horizonDays: 3 },
  swingtime:   { leading: true,  horizonDays: 0.3 },
  eventshock:  { leading: true,  horizonDays: 3 },
  tvltrend:    { leading: true,  horizonDays: 5 },
  impliedvol:  { leading: true,  horizonDays: 3 },
  earningsrisk:{ leading: true,  horizonDays: 3 },
  srbreak:     { leading: false, horizonDays: 1 },
  accum:       { leading: true,  horizonDays: 5 },
  mktoutlier:  { leading: true,  horizonDays: 4 },
  yieldcurve:  { leading: true,  horizonDays: 5 }
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
    // Gating each technique on its OWN sample count (as this did before) stops
    // a thin record from joining, but it does not fix the correlation itself:
    // summing several techniques' counts still presents N correlated vote
    // streams as N independent ones, because they are marked right or wrong
    // together off the same underlying price move. So accuracy is averaged
    // across contributors rather than pooled, and the effective sample size is
    // the deepest single contributor, not the sum — the conservative reading
    // of "how much independent evidence is really here."
    const collect = (h) => {
      const accs = [];
      let effectiveN = 0;
      for (const t of active) {
        const rec = reliabilityByHorizon[h] && reliabilityByHorizon[h][`${symbol}|${t.id}`];
        if (!rec || rec.total < MIN_RELIABILITY_SAMPLES) continue;
        accs.push(rec.correct / rec.total);
        if (rec.total > effectiveN) effectiveN = rec.total;
      }
      if (!accs.length) return null;
      return { accuracy: accs.reduce((a, b) => a + b, 0) / accs.length, n: effectiveN };
    };
    const h24 = collect(24);
    const h168 = collect(168);

    // Only claim a historical basis when one horizon is measurably better than
    // the other. Picking whichever is nominally higher — as this used to —
    // turns a 50.1%-vs-50.0% coin flip into a confident-looking "resolves in
    // ~1 day," which then feeds currentSignalConfidence's historicalBasis gate.
    if (h24 && h168) {
      const se = Math.sqrt(
        (h24.accuracy * (1 - h24.accuracy)) / Math.max(h24.n, 1) +
        (h168.accuracy * (1 - h168.accuracy)) / Math.max(h168.n, 1)
      );
      const z = se > 0 ? (h24.accuracy - h168.accuracy) / se : 0;
      if (Math.abs(z) >= RELIABILITY_SIGNIFICANCE_Z) {
        return z > 0
          ? { label: horizonLabel(1), days: 1, basis: 'historical' }
          : { label: horizonLabel(7), days: 7, basis: 'historical' };
      }
      // Indistinguishable: fall through to the methodology table below.
    } else if (h24 || h168) {
      // Only one horizon has a usable record at all, so there is nothing to
      // compare it against — that is a real, if one-sided, historical answer.
      return h24
        ? { label: horizonLabel(1), days: 1, basis: 'historical' }
        : { label: horizonLabel(7), days: 7, basis: 'historical' };
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

// Plain Pearson correlation of two equal-length numeric series — the
// shared primitive behind correlationWithBenchmark (same-index-aligned
// trailing windows, both fetched in the same run) and laggedCorrelation
// below (date-aligned across the permanent archive, which the hourly
// fetch never needs to deal with). Kept separate from either caller's own
// alignment logic so there's exactly one implementation of the actual
// statistic.
export function pearsonCorr(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 10) return null;
  const meanA = a.reduce((x, y) => x + y, 0) / n, meanB = b.reduce((x, y) => x + y, 0) / n;
  let cov = 0, varA = 0, varB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA, db = b[i] - meanB;
    cov += da * db; varA += da * da; varB += db * db;
  }
  if (varA === 0 || varB === 0) return null;
  return cov / Math.sqrt(varA * varB);
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
  return pearsonCorr(retsA.slice(-n), retsB.slice(-n));
}

// Correlation between leader's return at day T and follower's return at
// day T+lag, both DATE-aligned first (unlike correlationWithBenchmark,
// which assumes its two inputs are already same-index trailing windows —
// not true across the permanent archive, where different assets can have
// different date ranges or gaps). `leaderReturns`/`followerReturns` are
// `{ date: pctReturn }` maps (built by the caller from asset_daily_bars —
// see computeLeadLag in archive.mjs); this function only does the
// alignment-and-correlate step, kept pure/testable independent of D1.
export function laggedCorrelation(leaderReturns, followerReturns, lag) {
  const leaderDates = Object.keys(leaderReturns).sort();
  const a = [], b = [];
  for (const date of leaderDates) {
    const followerDate = shiftDate(date, lag);
    if (followerDate in followerReturns) {
      a.push(leaderReturns[date]);
      b.push(followerReturns[followerDate]);
    }
  }
  const corr = pearsonCorr(a, b);
  return corr == null ? null : { corr, samples: a.length };
}

function shiftDate(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// The actual data point the leadlag technique needs: how much did this
// symbol move from `lagDays` ago to its most recent archived close? `bars`
// is a small date-sorted-ascending array (see loadRecentBars in
// archive.mjs) — not re-fetched live, the permanent archive already has it.
export function nDayReturnFromBars(bars, lagDays) {
  if (!bars || bars.length < lagDays + 1) return null;
  const now = bars[bars.length - 1].close;
  const before = bars[bars.length - 1 - lagDays].close;
  if (!before) return null;
  return ((now / before) - 1) * 100;
}

// Curated CoinGecko-category -> broad sector bucket mapping. A small
// hand-picked whitelist, not a translation of every one of CoinGecko's
// ~850 raw category strings — most of those are ecosystem tags ("Arbitrum
// Ecosystem") describing what a token is DEPLOYED on, not what kind of
// asset it economically is. Confirmed live against BTC/ETH/SOL/ARB/AAVE/
// UNI/SAND/DOGE/XRP/LINK/DOT which strings actually recur in practice. An
// asset can land in more than one bucket (Uniswap is both DeFi and
// Governance) — that overlap is real, not a bug, the same way sector
// indices in traditional finance overlap (a regional bank is both
// "Financials" and "Regional Banks").
export const SECTOR_CATEGORY_MAP = {
  L1: ['Smart Contract Platform', 'Layer 1 (L1)', 'Layer 0 (L0)'],
  L2: ['Layer 2 (L2)', 'Rollup'],
  DeFi: ['Decentralized Finance (DeFi)', 'Decentralized Exchange (DEX)', 'Yield Farming', 'Lending/Borrowing Protocols', 'Automated Market Maker (AMM)'],
  Governance: ['Governance', 'DAO'],
  Utility: ['Oracle', 'Infrastructure', 'Payment Solutions'],
  Gaming: ['Gaming (GameFi)', 'Metaverse', 'Play To Earn'],
  Meme: ['Meme']
};

export function mapCategoriesToSectors(categories) {
  if (!categories || !categories.length) return [];
  const set = new Set(categories);
  const sectors = [];
  for (const [sector, tags] of Object.entries(SECTOR_CATEGORY_MAP)) {
    if (tags.some((t) => set.has(t))) sectors.push(sector);
  }
  return sectors;
}

// Builds a synthetic composite return-index per sector from each member
// symbol's already-computed { date: pctReturn } map (see archive.mjs's
// returns-from-bars helper) and a sector -> member-symbols map: the simple
// mean of member returns each day, compounded into a start-at-100 index.
// This lets a sector be written into asset_daily_bars as a SECTOR:<name>
// pseudo-symbol and flow through computeLeadLag/loadRecentBars/the leadlag
// technique completely unmodified — nothing downstream needs to know a
// "sector" is anything other than another symbol with a close price.
// Skipped when a sector has fewer than minConstituents members with any
// return data at all, since a 1-2 asset "sector" is just noise dressed up
// as a composite, not a real basket.
//
// `seeds[sector]` (optional) is this sector's own last-already-written
// { date, close } — when given, only dates strictly after it are computed,
// continuing to compound from that real close instead of restarting at
// 100. Without a seed, the full available history is computed (the first
// time a sector ever qualifies). This is what keeps the daily recompute a
// 1-2-row append once a sector is established, matching this pipeline's
// existing discipline elsewhere of never redoing already-done write work
// (row budgets, coverage checks) rather than growing daily cost forever.
export function computeSectorCompositeSeries(returnsBySymbol, symbolsBySector, minConstituents = 3, seeds = {}) {
  const out = {};
  for (const [sector, symbols] of Object.entries(symbolsBySector)) {
    const members = symbols.filter((s) => returnsBySymbol[s]);
    if (members.length < minConstituents) continue;
    const byDate = {};
    for (const s of members) {
      for (const [date, ret] of Object.entries(returnsBySymbol[s])) {
        (byDate[date] ??= []).push(ret);
      }
    }
    const seed = seeds[sector];
    let dates = Object.keys(byDate).sort();
    let close = 100;
    if (seed) {
      dates = dates.filter((d) => d > seed.date);
      close = seed.close;
    }
    const series = [];
    for (const date of dates) {
      const rets = byDate[date];
      const meanRet = rets.reduce((a, b) => a + b, 0) / rets.length;
      close *= 1 + meanRet / 100;
      series.push({ date, close });
    }
    out[sector] = series;
  }
  return out;
}

// Simple daily difference between two already-loaded { date: close } level
// series (e.g. UST10Y/UST2Y yields) — unlike computeSectorCompositeSeries
// above, this is a direct subtraction of levels, not a compounded index of
// returns, so there's no seed/incremental-append complexity needed: a
// single bad input value on one date only ever corrupts that one date's
// spread, it can't compound forward the way the sector-composite bug did.
// Only dates present in both series produce a point; only computed at all
// (out.length checked by the caller) once minPoints of overlap exist, so a
// freshly-added series with almost no history yet doesn't get a
// one-or-two-point "spread" that looks meaningful but isn't.
export function computeSpreadSeries(closesA, closesB, minPoints = 30) {
  const dates = Object.keys(closesA).filter((d) => d in closesB).sort();
  if (dates.length < minPoints) return [];
  return dates.map((date) => ({ date, close: closesA[date] - closesB[date] }));
}

// ------------------------- INTRADAY DAY-TRADING SIGNAL ---------------------
// Purpose-built, not a re-skin of evaluateTechniques/TECHNIQUE_META/push():
// that machinery's "never fire on one signal alone" confluence discipline
// is meaningful because its ~32 techniques are genuinely different reads
// (RSI, OBV, valuation, funding, sentiment...). At the 5-90 minute
// resolution scripts/intraday-tick.mjs's price-only ticks provide, the
// only real input is price — manufacturing several "techniques" off one
// series would fake diversity, not add it. Used by scripts/intraday.mjs
// (signal casting, maturity scoring), never by buildPayload/the confluence
// engine — see scripts/intraday.mjs's top comment for the full "why a
// separate pipeline" reasoning.

// Nearest tick to a target instant, within a tolerance — the same
// "irregular real-world sampling, not clean N-minutes-ago" pattern
// evaluateTimeOfDay (reliability.mjs) already uses for hour-scale
// horizons, just at minute scale. `ticks`: [{tick_at, price}] for ONE
// symbol, any order. Returns null (not a guess) if nothing falls within
// tolerance — a genuinely missed window should abstain, not fabricate a
// stale match.
export function nearestTick(ticks, targetMs, toleranceMs) {
  let best = null, bestDiff = Infinity;
  for (const t of ticks) {
    const diff = Math.abs(new Date(t.tick_at).getTime() - targetMs);
    if (diff <= toleranceMs && diff < bestDiff) { bestDiff = diff; best = t; }
  }
  return best;
}

// Asset-class-keyed: crypto is naturally more volatile intraday than
// equities, so a move that's meaningful signal for AAPL would be routine
// noise for a mid-cap coin, and a bar loose enough for crypto would almost
// never clear for a mega-cap stock.
export const INTRADAY_DEADBAND_PCT = { crypto: 0.3, stock: 0.15 };
// How close to the rolling 24h high/low counts as "at the extreme" for the
// peaked/bottomed flag — a scaled-down version of the same "near a recent
// extreme" idea the Donchian/range technique already uses, just over a 24h
// rolling window instead of a 20-daily-bar one (a different enough
// timeframe that reusing an exact existing constant wouldn't transfer any
// real information).
const INTRADAY_EXTREME_PROXIMITY_PCT = 1.5;
// How far a matched tick is allowed to sit from the ideal target instant —
// generous relative to the 15/60-min lookback windows themselves because
// the real achieved tick cadence is irregular (confirmed live: GitHub's
// scheduler doesn't deliver clean 5-minute firings even on a 5-minute
// cron), not because a looser match is desirable on its own. Exported and
// reused by evaluateIntradayMatured (scripts/intraday.mjs) for the exact
// same reason at maturity-check time, not just at casting time.
export const INTRADAY_TICK_TOLERANCE_MIN = 10;
const INTRADAY_DAY_WINDOW_HOURS = 24;

// ticks: all recent ticks for ONE symbol (ideally covering the last ~24h,
// for the day-high/low read below) — [{tick_at, price}], any order.
// Returns { dir, peaked, bottomed }, all null when there isn't enough data
// to say anything (a missing momentum window) — this codebase's "abstain,
// don't fabricate" discipline, same as every technique in evaluateTechniques.
// dir is 0 (not null) when data exists but the two momentum windows
// disagree or neither clears its deadband — a real "no signal," not
// missing data. Two independent time-windowed momentum reads (now vs.
// ~15 min ago, now vs. ~60 min ago) must agree in sign and both clear the
// deadband before dir fires — a minimal, honest 2-of-2 rule sized to the
// only real information price-only ticks actually carry.
export function intradaySignal(ticks, nowIso, assetClass) {
  if (!ticks || !ticks.length) return { dir: null, peaked: null, bottomed: null };
  const now = new Date(nowIso).getTime();
  const toleranceMs = INTRADAY_TICK_TOLERANCE_MIN * 60 * 1000;

  const current = ticks.reduce((a, b) => (new Date(b.tick_at).getTime() > new Date(a.tick_at).getTime() ? b : a));
  const ref15 = nearestTick(ticks, now - 15 * 60 * 1000, toleranceMs);
  const ref60 = nearestTick(ticks, now - 60 * 60 * 1000, toleranceMs);
  if (!ref15 || !ref60 || !current.price) return { dir: null, peaked: null, bottomed: null };

  const pct15 = ((current.price / ref15.price) - 1) * 100;
  const pct60 = ((current.price / ref60.price) - 1) * 100;
  const deadband = INTRADAY_DEADBAND_PCT[assetClass] ?? INTRADAY_DEADBAND_PCT.crypto;
  const sign15 = pct15 > deadband ? 1 : pct15 < -deadband ? -1 : 0;
  const sign60 = pct60 > deadband ? 1 : pct60 < -deadband ? -1 : 0;
  const dir = (sign15 !== 0 && sign15 === sign60) ? sign15 : 0;

  const dayCutoff = now - INTRADAY_DAY_WINDOW_HOURS * 3600 * 1000;
  const dayTicks = ticks.filter((t) => new Date(t.tick_at).getTime() >= dayCutoff);
  const dayHigh = dayTicks.length ? Math.max(...dayTicks.map((t) => t.price)) : current.price;
  const dayLow = dayTicks.length ? Math.min(...dayTicks.map((t) => t.price)) : current.price;
  const nearHigh = dayHigh > 0 && ((dayHigh - current.price) / dayHigh) * 100 <= INTRADAY_EXTREME_PROXIMITY_PCT;
  const nearLow = dayLow > 0 && ((current.price - dayLow) / dayLow) * 100 <= INTRADAY_EXTREME_PROXIMITY_PCT;

  return {
    dir,
    peaked: dir === -1 && nearHigh,
    bottomed: dir === 1 && nearLow
  };
}

// ------------------------- INTRADAY BACKTEST REPLAY -------------------------
// Backtest-seeds intraday_backtest_reliability (scripts/backtest-intraday.mjs)
// by walking historical ticks through this exact intradaySignal function —
// zero new signal-computation logic, just a driver that scores what the
// SAME live function would have called at each point in history. Kept
// separate from the live intraday_reliability table (not wired into
// buildIntradayDisplayPayload's adaptive-horizon selection) — backtested
// accuracy on dense, regular Binance candles isn't automatically
// comparable to live accuracy on genuinely irregular real-world ticks
// without its own scrutiny first.

// intradaySignal only ever looks back ~25h from "now" (its own day-window
// plus the 60-min momentum lookback) — passing the WHOLE historical array
// at every index would be O(n) per call, O(n^2) total (~4.9B ops for a
// year of 15-min bars), when only a small trailing slice is ever actually
// read. Bounding both the trailing (casting) and forward (scoring)
// windows to small constants keeps the whole replay O(n).
const REPLAY_TRAILING_WINDOW_TICKS = 120; // ~30h at 15-min spacing, with slack for irregular real-world gaps
const REPLAY_FORWARD_WINDOW_TICKS = 12; // ~3h at 15-min spacing — comfortably covers the longest (60-min) horizon plus tolerance

// ticks: one symbol's full historical series, [{tick_at, price}], any
// order. horizonsMin: which forward horizons to score (the caller passes
// INTRADAY_HORIZONS_MIN from scripts/intraday.mjs — not imported directly
// here, since that module already imports FROM this file; the reverse
// would be circular). Returns
// { [horizonMinutes]: {correct, wrongOpposite, wrongFlat, total, observations} }.
// Only genuinely directional casts are scored (same "nothing to score for
// a call that was never made" convention castIntradaySignals already
// uses), and only when a real future tick exists within tolerance of the
// target horizon — a call near the end of the series with no future data
// yet is left out, not scored as a loss.
//
// A "wrong" call is split into two very different outcomes, not lumped
// together: wrongOpposite (the market moved past the deadband in the
// OPPOSITE direction from the call — a genuine reversal) vs. wrongFlat
// (the market just never cleared the deadband either way — no real move
// to have been right or wrong about). This distinction is the whole
// point: an aggregate accuracy number alone can't tell you whether a low
// score means "the signal has the direction backwards" (wrongOpposite-
// heavy, fixable by flipping dir) or "the signal fires into mostly flat
// markets" (wrongFlat-heavy, not fixable by a sign flip at all). Each
// scored observation also carries its cast date, so a caller can pool
// observations across the whole watchlist and run them through
// chronologicalHalfSplit — the same train/test discipline every other
// finding in this project (see correlation-research.mjs) has to clear
// before being trusted.
export function replayIntradaySignal(ticks, assetClass, horizonsMin) {
  const sorted = ticks.slice().sort((a, b) => new Date(a.tick_at).getTime() - new Date(b.tick_at).getTime());
  const toleranceMs = INTRADAY_TICK_TOLERANCE_MIN * 60 * 1000;
  const results = {};
  for (const h of horizonsMin) results[h] = { correct: 0, wrongOpposite: 0, wrongFlat: 0, total: 0, observations: [] };

  for (let i = 0; i < sorted.length; i++) {
    const windowStart = Math.max(0, i - REPLAY_TRAILING_WINDOW_TICKS);
    const window = sorted.slice(windowStart, i + 1);
    const nowIso = sorted[i].tick_at;
    const sig = intradaySignal(window, nowIso, assetClass);
    if (!sig.dir) continue; // abstain or neutral: nothing to score

    const entryPrice = sorted[i].price;
    const nowMs = new Date(nowIso).getTime();
    const future = sorted.slice(i + 1, i + 1 + REPLAY_FORWARD_WINDOW_TICKS);
    for (const h of horizonsMin) {
      const targetMs = nowMs + h * 60 * 1000;
      const match = nearestTick(future, targetMs, toleranceMs);
      if (!match) continue; // no future tick within tolerance yet (near the end of the series) — not scoreable
      const pct = ((match.price / entryPrice) - 1) * 100;
      const deadband = INTRADAY_DEADBAND_PCT[assetClass] ?? INTRADAY_DEADBAND_PCT.crypto;
      const actualDir = pct > deadband ? 1 : pct < -deadband ? -1 : 0;
      results[h].total += 1;
      const outcome = sig.dir === actualDir ? 'correct' : actualDir === -sig.dir ? 'wrongOpposite' : 'wrongFlat';
      results[h][outcome] += 1;
      results[h].observations.push({ date: nowIso.slice(0, 10), outcome });
    }
  }
  return results;
}

// ------------------------- CORRELATION RESEARCH -----------------------------
// Pure, composable building blocks for scripts/correlation-research.mjs —
// pooled hypothesis tests against data already archived (asset_daily_bars,
// sentiment_daily), no new data collection. Deliberately pooled across the
// full universe, not tested per-symbol: per-symbol correlation-hunting
// across dozens of assets is exactly the multiple-testing trap
// isReliabilitySignificant's own docs (above) warn about.

// Same normal-approximation z-test philosophy as isReliabilitySignificant,
// generalized to a two-SAMPLE comparison (is sampleA's mean meaningfully
// different from sampleB's) rather than a one-sample test against a fixed
// null of 0.5. Welch's approximation (unequal variances assumed — no
// reason two different day-buckets would share variance). Returns
// z: null when either sample is too small or has zero variance to say
// anything (not a fabricated 0).
export function twoSampleZTest(sampleA, sampleB) {
  if (!sampleA || !sampleB || sampleA.length < 2 || sampleB.length < 2) return { z: null, meanA: null, meanB: null, effectSize: null, n: (sampleA?.length || 0) + (sampleB?.length || 0) };
  const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = (arr, m) => arr.reduce((a, b) => a + (b - m) * (b - m), 0) / (arr.length - 1);
  const meanA = mean(sampleA), meanB = mean(sampleB);
  const varA = variance(sampleA, meanA), varB = variance(sampleB, meanB);
  const se = Math.sqrt(varA / sampleA.length + varB / sampleB.length);
  const z = se > 0 ? (meanA - meanB) / se : null;
  return { z, meanA, meanB, effectSize: meanA - meanB, n: sampleA.length + sampleB.length };
}

// Trailing-baseline surge ratio: today's volume relative to the mean of
// the PRECEDING lookbackDays — never including today, so this never looks
// ahead. bars: [{date, volume}], any order (sorts internally). Skips the
// first lookbackDays entries (not enough trailing history to compute a
// baseline yet) and any day whose trailing window has too many gaps to
// trust (more than half missing).
export function volumeSurgeSeries(bars, lookbackDays = 20) {
  const sorted = bars.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const out = [];
  for (let i = lookbackDays; i < sorted.length; i++) {
    const trailing = sorted.slice(i - lookbackDays, i).map((b) => b.volume).filter((v) => v != null && v > 0);
    if (trailing.length < lookbackDays * 0.5) continue;
    const baseline = trailing.reduce((a, b) => a + b, 0) / trailing.length;
    if (!baseline || sorted[i].volume == null) continue;
    out.push({ date: sorted[i].date, surgeRatio: sorted[i].volume / baseline });
  }
  return out;
}

// Forward % return from each bar's close to the close `horizonDays` bars
// later — bar-index-based (this archive already stores one row per real
// trading/calendar day, no weekend/holiday gaps to bridge). Returns
// { [date]: { [horizonDays]: pct } }.
export function forwardReturns(bars, horizonsDays = [1, 5]) {
  const sorted = bars.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const out = {};
  for (let i = 0; i < sorted.length; i++) {
    const entry = {};
    for (const h of horizonsDays) {
      const future = sorted[i + h];
      if (!future || !sorted[i].close) continue;
      entry[h] = ((future.close / sorted[i].close) - 1) * 100;
    }
    if (Object.keys(entry).length) out[sorted[i].date] = entry;
  }
  return out;
}

// Splits a list of dates at the chronological midpoint — the train/test
// re-check every correlation-research hypothesis must independently clear
// before counting as a validated finding: a candidate that clears the
// pooled significance bar but doesn't hold up with the same sign in BOTH
// halves of history separately is much more likely a fluke of this
// specific historical window than a real, durable effect.
export function chronologicalHalfSplit(dates) {
  const sorted = [...new Set(dates)].sort();
  const mid = Math.floor(sorted.length / 2);
  return { firstHalf: new Set(sorted.slice(0, mid)), secondHalf: new Set(sorted.slice(mid)) };
}

// Finds every historical episode where this asset moved at least
// thresholdPct% within windowDays days, either direction — the "≥20% in a
// week or less" pattern behind correlation-research.mjs's consolidation-
// then-breakout study. Detection point is the FIRST day a trailing
// windowDays return crosses the threshold; cooldownDays then suppresses
// re-detecting the same underlying move as it keeps extending (a real
// multi-week breakout would otherwise get counted dozens of times, once
// per day it stays past the threshold — the same "don't double-count one
// underlying event" discipline evaluateMatured's seenMoves and
// walkSrLevels' broken-cluster retirement already use). Also walks forward
// up to maxForwardDays to find the actual peak/trough — the fuller move,
// not just the triggering windowDays slice — and how many days it took,
// the real magnitude/duration behind "how far do these usually go and how
// long do they take." `startIdx`/`detectedIdx` are the bar-array indices
// (not just dates), so a caller can slice bars[0:startIdx] to look at
// exactly what preceded this episode with no lookahead.
export function detectMoveEpisodes(bars, thresholdPct = 20, windowDays = 7, cooldownDays = 21, maxForwardDays = 30) {
  const sorted = bars.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const episodes = [];
  let cooldownUntil = -1;
  for (let i = windowDays; i < sorted.length; i++) {
    if (i <= cooldownUntil) continue;
    const startClose = sorted[i - windowDays].close;
    const nowClose = sorted[i].close;
    if (!startClose || !nowClose) continue;
    const ret = ((nowClose / startClose) - 1) * 100;
    if (Math.abs(ret) < thresholdPct) continue;

    const dir = ret > 0 ? 1 : -1;
    let extremeIdx = i, extremeClose = nowClose;
    for (let j = i + 1; j < Math.min(sorted.length, i + maxForwardDays); j++) {
      const c = sorted[j].close;
      if (c == null) continue;
      if ((dir === 1 && c > extremeClose) || (dir === -1 && c < extremeClose)) { extremeClose = c; extremeIdx = j; }
    }
    episodes.push({
      startIdx: i - windowDays, startDate: sorted[i - windowDays].date,
      detectedIdx: i, detectedDate: sorted[i].date,
      dir, triggerPct: ret,
      fullMovePct: ((extremeClose / startClose) - 1) * 100,
      daysToExtreme: extremeIdx - i,
      extremeDate: sorted[extremeIdx].date
    });
    cooldownUntil = Math.max(extremeIdx, i + cooldownDays);
  }
  return episodes;
}

// Filters a symbol's own detectMoveEpisodes() output down to the ones
// that were preceded by an extended run in the OPPOSITE direction — "dipped
// suddenly after days of continuous rising" (user-requested, grounded in
// the real 2026-08-22 case: BTC/ETH/SOL/XRP/XLM/HBAR all hit fresh highs
// then pulled back 3-11% intraday after the 08-20/21 rally, while still
// net-positive for the day). A plain detectMoveEpisodes() bearish episode
// doesn't tell you whether it followed a rally or just more of the same
// downtrend — this adds that precondition, plus the piece
// detectMoveEpisodes doesn't measure at all: what happens AFTER the
// episode's own extreme. If price later reclaims the pre-episode level,
// this was an outlier/blip within a rally that resumed; if it doesn't
// within reclaimWindowDays, that's the operational definition of a
// genuine pivot used here. This is the direct answer to "when are they
// outliers and when can we know the market/asset is pivoting."
// bars: full sorted [{date, close}] history for one symbol. episodes:
// that same symbol's own detectMoveEpisodes() output (whatever extra
// fields the caller already attached, e.g. symbol/assetClass, pass
// through unchanged via spread).
export function detectExhaustionReversals(bars, episodes, priorRunLookbackDays = 10, priorRunThresholdPct = 12, reclaimWindowDays = 30) {
  const sorted = bars.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
  const out = [];
  for (const e of episodes) {
    const priorIdx = e.startIdx - priorRunLookbackDays;
    if (priorIdx < 0) continue;
    const priorClose = sorted[priorIdx].close;
    const startClose = sorted[e.startIdx].close;
    if (!priorClose || !startClose) continue;
    const priorRunPct = ((startClose / priorClose) - 1) * 100;
    // Bearish episode (dip) must be preceded by a prior RISE; bullish
    // episode (spike) must be preceded by a prior DECLINE (a capitulation
    // bounce) — the opposite-direction precondition is what makes this
    // "exhaustion" rather than plain momentum/continuation, which
    // detectMoveEpisodes on its own doesn't distinguish.
    const qualifies = e.dir === -1 ? priorRunPct >= priorRunThresholdPct : priorRunPct <= -priorRunThresholdPct;
    if (!qualifies) continue;

    const extremeIdx = e.detectedIdx + e.daysToExtreme;
    let reclaimedIdx = null;
    for (let j = extremeIdx + 1; j < Math.min(sorted.length, extremeIdx + reclaimWindowDays); j++) {
      const c = sorted[j].close;
      if (c == null) continue;
      if ((e.dir === -1 && c >= startClose) || (e.dir === 1 && c <= startClose)) { reclaimedIdx = j; break; }
    }
    out.push({
      ...e,
      priorRunPct,
      outcome: reclaimedIdx != null ? 'reclaimed' : 'held',
      daysToReclaim: reclaimedIdx != null ? (reclaimedIdx - extremeIdx) : null
    });
  }
  return out;
}

// Finds every historical "bottomed, then went on a sustained multi-month/
// year moonshot" episode in one symbol's own history — user-requested
// 2026-08-24, grounded in a real, extreme, currently-unfolding case:
// ZEC's real archived low was $18.29 on 2024-07-05; as of 2026-08-23 it's
// $786.42, a confirmed 43x, still accelerating (+60% in the week before
// that last read alone). A different question from detectMoveEpisodes
// (fast, ≤7-day moves) or detectExhaustionReversals (days-to-weeks
// reversal-after-a-run) — this is deliberately long-horizon and large-
// magnitude: a genuine, isolated trough (the lowest close within
// troughWindowDays on EITHER side — not just any daily dip) that
// eventually multiplies by at least minMultiple within maxForwardDays.
// cooldownDays after the eventual peak stops one long bottoming-and-
// rallying process from being counted many times over as price
// oscillates near its own trough before the real move starts, same
// double-counting concern detectMoveEpisodes' own cooldown already
// guards against. Returns each found episode's trough and eventual
// crossing/peak — the raw material correlation-research.mjs uses to ask
// what, if anything, was different about conditions BEFORE the trough
// in cases that went on to multiply vs. troughs that didn't.
export function detectBottomThenMoonshot(bars, troughWindowDays = 90, minMultiple = 10, maxForwardDays = 1095, cooldownDays = 180) {
  const sorted = bars.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
  const n = sorted.length;
  const episodes = [];
  let cooldownUntil = -1;
  for (let i = 0; i < n; i++) {
    if (i <= cooldownUntil) continue;
    const troughClose = sorted[i].close;
    if (troughClose == null || troughClose <= 0) continue;

    let isMin = true;
    const lo = Math.max(0, i - troughWindowDays), hi = Math.min(n - 1, i + troughWindowDays);
    for (let j = lo; j <= hi; j++) {
      if (j === i) continue;
      if (sorted[j].close != null && sorted[j].close < troughClose) { isMin = false; break; }
    }
    if (!isMin) continue;

    // Walk forward tracking the running peak — but if a NEW, DEEPER low
    // appears before the target multiple is ever reached, this candidate
    // wasn't really "the" trough, just an early stop on a longer, grinding
    // decline (real case found live testing this against ZEC: an isolated
    // local min in Nov 2022 — genuinely the FTX-crash-era bottom at the
    // time — got superseded by an even deeper low 20 months later in July
    // 2024, which is where the real 40x+ move actually launched from).
    // Neither recording an episode nor setting a cooldown here lets the
    // loop continue naturally and pick up that deeper point as its own
    // candidate once i reaches it.
    let firstCrossIdx = -1, peakIdx = i, peakClose = troughClose, deeperLowFound = false;
    for (let j = i + 1; j < Math.min(n, i + maxForwardDays); j++) {
      const c = sorted[j].close;
      if (c == null) continue;
      if (c < troughClose) { deeperLowFound = true; break; }
      if (c > peakClose) { peakClose = c; peakIdx = j; }
      if (firstCrossIdx === -1 && c / troughClose >= minMultiple) firstCrossIdx = j;
    }
    if (deeperLowFound || firstCrossIdx === -1) continue; // not the real trough, or never reached minMultiple within the horizon

    episodes.push({
      troughIdx: i, troughDate: sorted[i].date, troughClose,
      firstCrossIdx, firstCrossDate: sorted[firstCrossIdx].date, daysToMultiple: firstCrossIdx - i,
      peakIdx, peakDate: sorted[peakIdx].date, peakClose, peakMultiple: peakClose / troughClose
    });
    cooldownUntil = Math.max(peakIdx, i + cooldownDays);
  }
  return episodes;
}

// The LIVE counterpart to detectBottomThenMoonshot, for the "long-term
// potential" category (user-requested 2026-08-24). That function is
// necessarily retrospective — confirming a trough needs troughWindowDays
// of FUTURE price action on both sides, which a still-unfolding low
// doesn't have yet. This instead asks "is this asset CURRENTLY sitting
// near a fresh multi-month/year low that hasn't been undercut in a
// while" — the honest, forward-looking version of the same question,
// with no claim about which specific candidates will actually go on to
// multiply. Real research against this project's own archived history
// (correlation-research.mjs, 2026-08-24) found the base rate for a
// genuine isolated trough — 38% went on to >=10x within ~3 years — but
// found NONE of drawdown-depth, pre-trough volatility compression, or
// market-wide coincidence reliably distinguish which specific troughs
// succeed (the coincidence test actually ran backwards: moonshot troughs
// were LESS commonly part of a crowded, market-wide bottom than ordinary
// ones, not more). So this deliberately does not try to rank or filter
// candidates by any of those — there's no validated basis to. Purely
// descriptive: the historical base rate is the only number this, or
// anything built on it, should ever claim. Not financial advice.
export function detectPossibleLongTermBottom(bars, lookbackDays = 365, minDaysSinceLow = 30, nearLowPct = 30) {
  const sorted = bars.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
  const n = sorted.length;
  if (n < lookbackDays) return null;
  const window = sorted.slice(n - lookbackDays);
  let lowIdx = 0, lowClose = window[0].close;
  for (let i = 1; i < window.length; i++) {
    if (window[i].close != null && window[i].close < lowClose) { lowClose = window[i].close; lowIdx = i; }
  }
  const current = window[window.length - 1].close;
  if (current == null || lowClose == null || lowClose <= 0) return null;
  const daysSinceLow = window.length - 1 - lowIdx;
  const pctAboveLow = ((current / lowClose) - 1) * 100;
  if (daysSinceLow < minDaysSinceLow || pctAboveLow > nearLowPct) return null;
  return { lowClose, lowDate: window[lowIdx].date, daysSinceLow, currentClose: current, pctAboveLow };
}

// The level change over lookbackDays index-positions, ending at the latest
// bar on or before targetDate — used by correlation-research.mjs to ask
// "how much did this yield series move in the N trading days before this
// crypto episode started." Index-based, not calendar-day-based, so a
// 5-day-a-week series (Treasury yields, weekends/holidays) is handled
// correctly without special-casing gaps — the same reasoning
// detectMoveEpisodes' own windowDays already relies on for a series with
// its own natural cadence. Returns the raw level difference (e.g. yield
// percentage points), not a % return — the economically meaningful unit
// for something like a Treasury yield, where "4.5% -> 4.3%" is a "-0.2"
// move, not a "-4.4% return." `sortedBars`: [{date, close}], ascending.
export function levelChangeBefore(sortedBars, targetDate, lookbackDays) {
  if (!sortedBars || !sortedBars.length) return null;
  let idx = -1;
  for (let i = sortedBars.length - 1; i >= 0; i--) {
    if (sortedBars[i].date <= targetDate) { idx = i; break; }
  }
  if (idx < lookbackDays) return null;
  const now = sortedBars[idx].close, then = sortedBars[idx - lookbackDays].close;
  return (now == null || then == null) ? null : now - then;
}

// Cross-sectional utility/community "quality" score (user-requested "spot
// crypto with the most useful utility and community") — percentile rank
// against every other tracked asset with data that day, not an absolute
// number: raw GitHub/community counts are wildly different scales per
// project, and coverage is genuinely uneven (loadQualityData's own docs,
// reliability.mjs — many coins have no linked GitHub repo on CoinGecko at
// all, confirmed live). Deliberately informational only, never a
// directional vote — a coin can have excellent fundamentals and still
// chop sideways short-term, so this never touches confluence()'s score,
// the same discipline the earningsrisk technique already uses for a
// different kind of non-directional flag. `basis` is how many of the 4
// metrics actually contributed for this symbol, so a thin single-metric
// score can be shown differently from a well-rounded one.
export function computeQualityScores(qualityData) {
  const metrics = ['githubCommits4w', 'githubPrContributors', 'communityReach', 'watchlistUsers'];
  const sorted = {};
  for (const metric of metrics) {
    sorted[metric] = Object.values(qualityData).map((q) => q[metric]).filter((v) => v != null).sort((a, b) => a - b);
  }
  const out = {};
  for (const [symbol, q] of Object.entries(qualityData)) {
    const percentiles = [];
    for (const metric of metrics) {
      if (q[metric] == null || sorted[metric].length < 10) continue; // too few peers with this metric yet to rank meaningfully
      percentiles.push(percentileRank(sorted[metric], q[metric]));
    }
    if (percentiles.length) {
      out[symbol] = { score: Math.round((percentiles.reduce((a, b) => a + b, 0) / percentiles.length) * 100), basis: percentiles.length };
    }
  }
  return out;
}

// Detects sustained multi-month outperformance vs a benchmark — the "new
// entrant rotates into relevance" pattern (Solana's 2020-21 rise; the
// question behind whether Hyperliquid is doing the same now, user-
// requested 2026-08-21). Deliberately NOT "did this asset pump this
// week" — detectMoveEpisodes/srbreak/accum already cover that — this
// wants PERSISTENCE: the asset's own trailing-windowDays relative return
// vs the benchmark has stayed at or above thresholdPct at
// minConsecutiveChecks separate checkpoints in a row, spaced stepDays
// apart, not just touched it once. `assetBars`/`benchmarkBars`:
// [{date, close}], any order. Returns every such streak found (a symbol
// can rotate more than once across its history), each with when it
// started, how many checkpoints it held, and the peak relative strength
// reached — the real magnitude/duration behind "is this a genuine
// rotation, and how strong."
export function detectOutperformanceRotation(assetBars, benchmarkBars, windowDays = 90, thresholdPct = 50, stepDays = 30, minConsecutiveChecks = 3) {
  const assetSorted = assetBars.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
  const benchByDate = {};
  for (const b of benchmarkBars) benchByDate[b.date] = b.close;
  const benchDates = Object.keys(benchByDate).sort();

  const nearestBenchClose = (targetDate) => {
    let lo = 0, hi = benchDates.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (benchDates[mid] < targetDate) lo = mid + 1; else hi = mid; }
    const idx = (lo < benchDates.length && benchDates[lo] === targetDate) ? lo : lo - 1;
    return idx >= 0 ? benchByDate[benchDates[idx]] : null;
  };

  const rotations = [];
  let streak = null; // { startIdx, startDate, checkpoints, peakRel }
  for (let i = windowDays; i < assetSorted.length; i += stepDays) {
    const now = assetSorted[i], then = assetSorted[i - windowDays];
    if (!now.close || !then.close) continue;
    const assetRet = ((now.close / then.close) - 1) * 100;
    const benchNow = nearestBenchClose(now.date), benchThen = nearestBenchClose(then.date);
    if (benchNow == null || benchThen == null || !benchThen) continue;
    const benchRet = ((benchNow / benchThen) - 1) * 100;
    const rel = assetRet - benchRet;

    if (rel >= thresholdPct) {
      if (!streak) streak = { startIdx: i, startDate: now.date, checkpoints: 0, peakRel: -Infinity };
      streak.checkpoints++;
      streak.peakRel = Math.max(streak.peakRel, rel);
      streak.endDate = now.date;
    } else {
      if (streak && streak.checkpoints >= minConsecutiveChecks) rotations.push(streak);
      streak = null;
    }
  }
  if (streak && streak.checkpoints >= minConsecutiveChecks) rotations.push(streak);
  return rotations;
}

// Buckets each bar's forward return by that DAY's Fear & Greed reading,
// using the same >=75/<=25 "extreme" thresholds the live `sentiment`
// technique already acts on (evaluateTechniques, marketContext.fearGreed)
// — not new arbitrary cutoffs. `sentimentByDate` is a plain {date: value}
// map (alternative.me's daily fear_greed_altme reading). Returns
// {[horizonDays]: {low: [{date,value}], high: [{date,value}], normal: [{date,value}]}}
// for the caller to pool across symbols and hand to twoSampleZTest — same
// pooled-not-per-symbol discipline as every other correlation-research
// hypothesis here.
export function sentimentExtremeForwardReturns(bars, sentimentByDate, horizonsDays = [1, 5]) {
  const fwd = forwardReturns(bars, horizonsDays);
  const out = Object.fromEntries(horizonsDays.map((h) => [h, { low: [], high: [], normal: [] }]));
  for (const bar of bars) {
    const fg = sentimentByDate[bar.date];
    if (fg == null) continue;
    const entry = fwd[bar.date];
    if (!entry) continue;
    const bucket = fg <= 25 ? 'low' : fg >= 75 ? 'high' : 'normal';
    for (const h of horizonsDays) {
      if (entry[h] == null) continue;
      out[h][bucket].push({ date: bar.date, value: entry[h] });
    }
  }
  return out;
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

// Every technique's measured accuracy for one asset — not just the single
// best one topIndicator returns above, the full per-technique picture,
// including the 24h-vs-168h split technique_reliability already tracks per
// (symbol, technique). That split is itself an empirically-measured
// leading/lagging read for THIS specific asset (does RSI resolve faster or
// slower for DOGE than the static TECHNIQUE_META guess assumes?) distinct
// from the hardcoded methodology table — surfaced here rather than only
// used internally by horizonEstimate's blended average. This is drill-down
// detail (see the /api/asset/:symbol route), not something every hourly
// dashboard row needs, so it stays out of the main payload.
export function techniqueBreakdown(reliability, reliabilityByHorizon, symbol) {
  const out = [];
  for (const id of Object.keys(TECHNIQUE_META)) {
    const rec = reliability && reliability[`${symbol}|${id}`];
    if (!rec || rec.total < MIN_RELIABILITY_SAMPLES) continue;
    const byHorizon = {};
    for (const h of [24, 168]) {
      const hr = reliabilityByHorizon && reliabilityByHorizon[h] && reliabilityByHorizon[h][`${symbol}|${id}`];
      if (hr && hr.total >= MIN_RELIABILITY_SAMPLES) byHorizon[h] = { accuracy: hr.correct / hr.total, total: hr.total };
    }
    out.push({
      id, accuracy: rec.accuracy, total: rec.total,
      leading: TECHNIQUE_META[id].leading,
      ...(Object.keys(byHorizon).length ? { byHorizon } : {})
    });
  }
  return out.sort((a, b) => b.accuracy - a.accuracy);
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
// This previously pooled range containment in with the directional records
// and reported one blended percentage as an asset's "prediction accuracy."
// That was measuring two incomparable things: a range band is BUILT to
// contain the price (it ran 61.2% across the live table, and rises with band
// width), while a directional call sits near its no-skill baseline. Pooling
// them let containment carry the average, which is what produced assets
// showing 95%+ "prediction accuracy" on a directional leaderboard.
//
// The two are now reported separately and the headline is directional skill
// measured against noSkillBaseline, not a raw hit rate. `proven` is the only
// field that should ever gate publication: it requires the Wilson lower bound
// on the accuracy to clear the baseline, so neither a thin lucky streak nor a
// hit rate that merely matches what constant guessing would have achieved can
// present as an edge.
export function assetPredictionScore(symbol, reliability, rangeReliability, assetClass, baselines) {
  const pick = (techniqueId) => {
    const rec = reliability && reliability[`${symbol}|${techniqueId}`];
    return rec && rec.total
      ? { correct: rec.correct, total: rec.total, votes_up: rec.votes_up, votes_down: rec.votes_down }
      : { correct: 0, total: 0, votes_up: 0, votes_down: 0 };
  };
  // Directional records only. 'reversal' and 'dwell' are genuine directional
  // calls like 'composite'; containment is not, and no longer joins them.
  const directional = ['composite', 'reversal', 'dwell'].map(pick);
  const correct = directional.reduce((a, r) => a + r.correct, 0);
  const total = directional.reduce((a, r) => a + r.total, 0);
  const votesUp = directional.reduce((a, r) => a + (r.votes_up || 0), 0);
  const votesDown = directional.reduce((a, r) => a + (r.votes_down || 0), 0);

  const rangeRec = (rangeReliability && rangeReliability[symbol]) || null;
  const range = rangeRec && rangeRec.total
    ? { containment: Math.round(100 * rangeRec.hits / rangeRec.total), samples: rangeRec.total }
    : null;

  if (total < MIN_RELIABILITY_SAMPLES) return null;

  const dist = assetClass && baselines ? baselines[`${assetClass}|all`] : null;
  const baseline = noSkillBaseline(dist, votesUp, votesDown);
  const skill = skillOverBaseline(correct, total, baseline);

  return {
    score: Math.round(100 * correct / total),
    samples: total,
    baseline: Math.round(100 * baseline),
    edge: skill ? Math.round(1000 * skill.edge) / 10 : null,
    lowerEdge: skill ? Math.round(1000 * skill.lowerEdge) / 10 : null,
    proven: !!(skill && skill.lowerEdge > 0 && skill.significant),
    range
  };
}

// A conservative one-sided Wilson bound prevents a tiny perfect-looking
// history from being presented as an equally certain result. The returned
// value is an evidence-aware lower estimate, not a guaranteed probability.
export function lowerConfidenceBound(correct, total, z = ALERT_CONFIDENCE_Z) {
  if (!Number.isFinite(correct) || !Number.isFinite(total) || !Number.isFinite(z) || total <= 0 || z < 0) return null;
  const n = total;
  const p = clamp(correct / n, 0, 1);
  const zSq = z * z;
  const denominator = 1 + zSq / n;
  const center = p + zSq / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + zSq / (4 * n)) / n);
  return clamp((center - margin) / denominator, 0, 1);
}

// Empirical confidence for THIS current directional call, not the asset's
// whole long-run track record. It combines the score bucket's calibration
// with this asset's own composite-call record at the matching 24h or 168h
// horizon. Detailed calibration is preferred once it has enough evidence:
// asset class, direction, horizon, and score bucket; the legacy pooled curve
// remains a fallback while that cell warms up. Historical range/horizon basis
// and current agreement are gates only, never invented probability inputs.
// Whether a whole asset class has demonstrated directional skill, pooled
// across every direction, horizon and score bucket its composite has been
// scored on. Measured against the class's own no-skill baseline, so "no
// demonstrated edge" means "no better than constant guessing in this class"
// rather than "under 50%".
//
// Live at the time this was written: crypto cleared its baseline decisively
// (+22.6pts at 24h, +15.0pts at 168h) while stocks sat significantly BELOW a
// constant call (-10.2pts at both horizons, n=481). Pooling the two produced a
// 49.8% headline that read as "no edge anywhere" and hid both results.
//
// Nothing here is hardcoded per class: a class is published when its own
// numbers earn it and suppressed when they don't, so stocks re-qualify
// automatically if they start clearing the bar.
export function assetClassSkill(detailedCalibration, baselines, assetClass) {
  if (!detailedCalibration || !assetClass) return null;
  let correct = 0, total = 0, votesUp = 0, votesDown = 0;
  for (const [key, rec] of Object.entries(detailedCalibration)) {
    const [cls, dir] = key.split('|');
    if (cls !== assetClass || !rec || !rec.total) continue;
    correct += rec.correct;
    total += rec.total;
    if (dir === '1') votesUp += rec.total;
    else if (dir === '-1') votesDown += rec.total;
  }
  if (total < CLASS_SKILL_MIN_SAMPLES) return null;
  const dist = baselines ? baselines[`${assetClass}|all`] : null;
  const baseline = noSkillBaseline(dist, votesUp, votesDown);
  const skill = skillOverBaseline(correct, total, baseline);
  if (!skill) return null;
  return {
    ...skill,
    assetClass,
    // Publish only on positive evidence. A class whose lower bound sits at or
    // below its baseline has not shown an edge, and is abstained on rather
    // than shipped with a caveat — the same abstain-rather-than-guess rule the
    // engine already applies to thin per-asset records.
    proven: skill.lowerEdge > 0
  };
}

// Strips the directional call from a board whose asset class has not
// demonstrated skill, while leaving every descriptive field (price, ranges,
// indicators, track record) intact. Votes are still logged and still scored by
// evaluateMatured, so the class keeps accumulating the evidence it needs to
// re-qualify — abstaining from publishing a call is not the same as stopping
// measurement of it.
export function abstainBoards(boards, skill) {
  // `skill === null` means "not enough evidence to judge this class yet", which
  // is NOT the same as "judged and found wanting" — a cold database must keep
  // publishing exactly as before rather than silently blanking every board.
  // Only a class that has been measured (CLASS_SKILL_MIN_SAMPLES outcomes) and
  // failed to clear its own baseline is abstained on.
  if (!boards || !skill || skill.proven) return boards;
  const note = {
    reason: 'no-demonstrated-edge',
    measured: skill ? { accuracy: Math.round(1000 * skill.accuracy) / 10, baseline: Math.round(1000 * skill.baseline) / 10, edge: Math.round(1000 * skill.edge) / 10, samples: skill.samples } : null
  };
  const strip = (rows) => (Array.isArray(rows) ? rows.map((r) => (
    r && (r.dir === 1 || r.dir === -1) ? { ...r, dir: 0, abstained: note } : r
  )) : rows);
  const out = {};
  for (const [k, v] of Object.entries(boards)) out[k] = strip(v);
  return out;
}

export function currentSignalConfidence(signal, calibration, assetCompositeRecord, baselines) {
  if (!signal || !(signal.dir === 1 || signal.dir === -1) || !Number.isFinite(signal.score)) return null;
  const bucket = scoreBucket(signal.score);
  const horizonHours = signal.horizon && Number.isFinite(signal.horizon.days)
    ? (signal.horizon.days <= 4 ? 24 : 168)
    : null;
  const pooledCalibration = calibration && calibration.pooled ? calibration.pooled : calibration;
  const detailedCalibration = calibration && calibration.detailed;
  const detailedKey = horizonHours != null && signal.asset_class
    ? `${signal.asset_class}|${signal.dir}|${horizonHours}|${bucket}`
    : null;
  const detailed = detailedKey && detailedCalibration && detailedCalibration[detailedKey];
  const pooled = pooledCalibration && pooledCalibration[bucket];
  const calibrationRecord = detailed && detailed.total >= DETAILED_CALIBRATION_CONFIDENCE_MIN_SAMPLES
    ? { ...detailed, source: 'asset-class-direction-horizon' }
    : pooled && pooled.total >= CALIBRATION_CONFIDENCE_MIN_SAMPLES
      ? { ...pooled, source: 'pooled' }
      : null;

  const components = [];
  const addComponent = (record, minSamples, source) => {
    if (!record || !Number.isFinite(record.correct) || !Number.isFinite(record.total) || record.total < minSamples) return null;
    const accuracy = clamp(record.correct / record.total, 0, 1);
    const lowerBound = lowerConfidenceBound(record.correct, record.total);
    if (lowerBound == null) return null;
    const component = { accuracy, lowerBound, samples: record.total, source };
    components.push(component);
    return component;
  };
  const calibrationComponent = calibrationRecord
    ? addComponent(calibrationRecord, calibrationRecord.source === 'pooled' ? CALIBRATION_CONFIDENCE_MIN_SAMPLES : DETAILED_CALIBRATION_CONFIDENCE_MIN_SAMPLES, calibrationRecord.source)
    : null;
  const assetComponent = addComponent(assetCompositeRecord, MIN_RELIABILITY_SAMPLES, 'asset-composite');
  if (!components.length) return null;

  const weightOf = (n) => Math.sqrt(Math.min(Math.max(n, 1), 400));
  const estimatedWinRate = components.reduce((sum, c) => sum + c.lowerBound * weightOf(c.samples), 0)
    / components.reduce((sum, c) => sum + weightOf(c.samples), 0);
  const rawEstimatedWinRate = components.reduce((sum, c) => sum + c.accuracy * weightOf(c.samples), 0)
    / components.reduce((sum, c) => sum + weightOf(c.samples), 0);
  const agreementRatio = signal.total ? signal.agree / signal.total : 0;
  const historicalBasis = !!((signal.horizon && signal.horizon.basis === 'historical') || (signal.range && signal.range.basis === 'historical'));
  const hasAssetCompositeRecord = !!assetComponent;
  const strongCalibration = !!(calibrationComponent && calibrationComponent.samples >= 100);

  // The bar is skill over this class's measured no-skill line, not a flat
  // 0.68 hit rate. A flat threshold means wildly different things in different
  // classes: at 24h a crypto call guesses right ~38% of the time with no
  // information at all, while a stock call at 168h guesses right ~52% — so
  // "68%" was demanding +30pts of edge in one place and +16pts in another,
  // purely as an artifact of where each baseline happens to sit.
  // estimatedWinRate is already a Wilson lower bound, so this reads as: at 95%
  // confidence, at least MIN_ACTIONABLE_EDGE better than guessing.
  const baseline = noSkillBaseline(
    baselines && signal.asset_class ? baselines[`${signal.asset_class}|${horizonHours != null ? horizonHours : 'all'}`] : null,
    signal.dir === 1 ? 1 : 0,
    signal.dir === -1 ? 1 : 0
  );
  const edgeOverBaseline = estimatedWinRate - baseline;
  const actionable = edgeOverBaseline >= MIN_ACTIONABLE_EDGE
    && signal.score >= (hasAssetCompositeRecord || historicalBasis ? 78 : 88)
    && agreementRatio >= (hasAssetCompositeRecord ? 0.45 : 0.55)
    && (historicalBasis || hasAssetCompositeRecord || strongCalibration);

  return {
    estimatedWinRate,
    rawEstimatedWinRate,
    baseline,
    edgeOverBaseline,
    bucket,
    horizonHours,
    agreementRatio,
    actionable,
    historicalBasis,
    calibration: calibrationComponent,
    assetCompositeRecord: assetComponent
  };
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

// Fraction of `sortedValues` that sit at or below `value` — a plain
// percentile rank, used to turn an absolute reading (funding rate, open
// interest) into an asset-relative one ("high for THIS asset," not high
// against an arbitrary fixed number every asset is judged by alike).
// Binary search since `sortedValues` is already sorted ascending by the
// caller (see loadFundingHistory in reliability.mjs).
export function percentileRank(sortedValues, value) {
  if (!sortedValues || !sortedValues.length || value == null) return null;
  let lo = 0, hi = sortedValues.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedValues[mid] < value) lo = mid + 1; else hi = mid;
  }
  return lo / sortedValues.length;
}

// Within this % of a level counts as "at" it for the Fibonacci technique
// below — tight enough that "near" means a genuine reaction zone, not
// price merely passing through on its way elsewhere.
const FIB_PROXIMITY_PCT = 1.2;

// Fibonacci retracement levels of the most recent swing (highest-high /
// lowest-low over `lookback` bars) — a plain statistic, not a full zigzag/
// pivot detector, matching this engine's existing preference for
// explainable reads over heavier pattern recognition elsewhere (Donchian,
// dwellAtExtreme). Which extreme is more recent decides the live leg
// direction: if the high came after the low, the swing ran up and price is
// now expected to retrace DOWN toward these levels as support; if the low
// came after the high, the swing ran down and price is expected to bounce
// UP toward these levels as resistance. The technique below only ever
// watches whichever side is live, never both at once — the standard way
// this tool is actually used.
export function fibonacciLevels(closes, lookback = 90) {
  if (!closes || closes.length < lookback) return null;
  const window = closes.slice(-lookback);
  let hiIdx = 0, loIdx = 0;
  for (let i = 1; i < window.length; i++) {
    if (window[i] > window[hiIdx]) hiIdx = i;
    if (window[i] < window[loIdx]) loIdx = i;
  }
  const hi = window[hiIdx], lo = window[loIdx];
  if (!(hi > lo)) return null;
  const span = hi - lo;
  return {
    hi, lo,
    legUp: hiIdx > loIdx,
    l382: hi - 0.382 * span,
    l500: hi - 0.5 * span,
    l618: hi - 0.618 * span
  };
}

// Local hour-of-day in an arbitrary IANA timezone for a given instant,
// DST-aware via Intl rather than a hardcoded fixed offset — so "midnight
// ET"/"London open"/"Tokyo open" all fall out of the same one calculation
// correctly year-round, with no separate DST branch to get wrong twice a
// year (Tokyo has no DST at all, so it's just as correct there by not
// needing to special-case it).
export function hourInZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).formatToParts(date);
  return Number(parts.find((p) => p.type === 'hour').value);
}

// Kept as a thin wrapper (rather than removed) since it's already used
// directly elsewhere (tests, docs) — NY-local hour specifically.
export function etHour(date) {
  return hourInZone(date, 'America/New_York');
}

// The clock "slots" a given instant belongs to, for the time-of-day
// behavioral profile (time_of_day_stats) and the swing-time-of-day profile
// (swing_time_stats): UTC hour-of-day (captures midnight UTC, and crypto
// funding settlement hours 00/08/16 UTC directly, since perp funding times
// are themselves UTC-aligned), NY/London/Tokyo-local hour-of-day (captures
// midnight ET and the NYSE's 9am/4pm hours, London's open around 8am
// local, and Tokyo's open around 9am local — all without any separate
// named-session list, DST-aware via hourInZone above), and UTC day-of-week
// (Sunday=0..Saturday=6, JS's own convention). Deliberately generic rather
// than a hardcoded list of "named sessions": every slot here falls out of
// the same handful of calendar reads, so there's nothing bespoke to
// maintain as sessions change.
export function slotsForTimestamp(iso) {
  const d = new Date(iso);
  const hourUtc = String(d.getUTCHours()).padStart(2, '0');
  const hourEt = String(hourInZone(d, 'America/New_York')).padStart(2, '0');
  const hourLdn = String(hourInZone(d, 'Europe/London')).padStart(2, '0');
  const hourTyo = String(hourInZone(d, 'Asia/Tokyo')).padStart(2, '0');
  return [`hour_utc_${hourUtc}`, `hour_et_${hourEt}`, `hour_ldn_${hourLdn}`, `hour_tyo_${hourTyo}`, `dow_utc_${d.getUTCDay()}`];
}

// Below this many observations, a slot's measured mean/stdev is too noisy
// to act on — same reasoning as MIN_RELIABILITY_SAMPLES elsewhere, applied
// to time-of-day stats specifically since they accumulate at only 1-2
// samples/day/slot (far slower than technique votes, which get one sample
// per applicable run) and would otherwise fire on a handful of coincidental
// observations.
const TOD_MIN_SAMPLES = 20;
// How many standard deviations the slot's mean return sits from zero —
// below this, a positive or negative mean is indistinguishable from noise
// even with enough raw sample count. Deliberately modest (not a strict
// statistical-significance bar): this is one vote among many in the
// confluence score, not a standalone claim, and the per-asset reliability
// loop will down-weight it over time if it doesn't actually pan out.
const TOD_MIN_EFFECT = 0.4;

// Does this asset have a real, measured behavioral bias at the CURRENT
// clock slot(s)? Checks every slot `nowIso` belongs to, across both
// tracked horizons (1h, 4h ahead), and returns whichever candidate has the
// strongest effect size — not the first match, so a asset's occasional
// coincidentally-large mean at a thin slot can't crowd out a better-
// supported one. Returns null (abstain) until a slot has both real sample
// depth and a real effect size, same "no data yet" pattern as every other
// technique here.
// Shared with scripts/reliability.mjs's evaluateTimeOfDay (imports this
// instead of declaring its own copy) — previously duplicated independently
// in two places (a bare [1, 4] literal here, a separate const there),
// which is exactly the kind of drift risk a positional-arg mismatch
// elsewhere in this codebase already got caught for once.
export const TOD_HORIZONS_HOURS = [1, 4];

export function timeOfDaySignal(todStats, symbol, nowIso) {
  if (!todStats) return null;
  let best = null;
  for (const slot of slotsForTimestamp(nowIso)) {
    for (const h of TOD_HORIZONS_HOURS) {
      const rec = todStats[`${symbol}|${slot}|${h}`];
      if (!rec || rec.n < TOD_MIN_SAMPLES || !(rec.stdevPct > 0)) continue;
      const effect = Math.abs(rec.meanPct) / rec.stdevPct;
      if (effect < TOD_MIN_EFFECT) continue;
      if (!best || effect > best.effect) best = { slot, horizonHours: h, meanPct: rec.meanPct, effect, n: rec.n };
    }
  }
  if (!best) return null;
  return { dir: best.meanPct > 0 ? 1 : -1, slot: best.slot, horizonHours: best.horizonHours, meanPct: best.meanPct, n: best.n };
}

// How far a matched bar is allowed to sit from the ideal "h hours ahead"
// target instant — mirrors reliability.mjs's TOD_MATCH_TOLERANCE_MIN (40)
// exactly (same reasoning: builds run on an imperfect cadence, small
// jitter shouldn't reject an otherwise-good match), duplicated as a value
// rather than imported since reliability.mjs already imports FROM this
// file — the reverse direction would be circular.
const TOD_TALLY_TOLERANCE_MIN = 40;

// Historical bootstrap for time_of_day_stats: given one symbol's hourly
// bars (`{ts, close}`, any order — the exact shape yahooHourlyBars/
// computeSwingTimeTallies already produce, and what a Binance-klines
// mapper produces too), computes the same running (sumPct, sumPctSq, n)
// aggregate evaluateTimeOfDay (reliability.mjs) tallies live off
// asset_price_log, just from deep history in one pass instead of one
// sample at a time. Bucketed by the slot of the EARLIER bar (the one h
// hours before the move), not the later one — matches evaluateTimeOfDay's
// own semantics exactly: "did this clock-time historically precede a
// move," not "what time did the move land at." Nearest-bar-within-
// tolerance matching (not a fixed array-index offset) because hourly bars
// for equities have real gaps (market hours only) that a naive index
// offset would misread as consecutive real hours.
export function computeTimeOfDayTallies(hourlyBars, horizons = TOD_HORIZONS_HOURS) {
  const sorted = hourlyBars.slice().sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  const toleranceMs = TOD_TALLY_TOLERANCE_MIN * 60 * 1000;
  const tallies = {}; // "slot|h" -> { sumPct, sumPctSq, n }
  for (let i = 0; i < sorted.length; i++) {
    const before = sorted[i];
    const beforeMs = new Date(before.ts).getTime();
    for (const h of horizons) {
      const targetMs = beforeMs + h * 3600 * 1000;
      let best = null, bestDiff = Infinity;
      for (let j = i + 1; j < sorted.length; j++) {
        const diff = new Date(sorted[j].ts).getTime() - targetMs;
        if (diff > toleranceMs) break; // sorted ascending — nothing further out can be closer
        if (Math.abs(diff) <= toleranceMs && Math.abs(diff) < bestDiff) { bestDiff = Math.abs(diff); best = sorted[j]; }
      }
      if (!best || !before.close) continue;
      const pct = ((best.close / before.close) - 1) * 100;
      for (const slot of slotsForTimestamp(before.ts)) {
        const key = `${slot}|${h}`;
        if (!tallies[key]) tallies[key] = { sumPct: 0, sumPctSq: 0, n: 0 };
        tallies[key].sumPct += pct;
        tallies[key].sumPctSq += pct * pct;
        tallies[key].n += 1;
      }
    }
  }
  return tallies;
}

// The compound question behind the user's own "00:00 EST" example: does a
// SPECIFIC clock slot's forward-return behavior differ between
// sentiment-extreme and sentiment-normal days, not just "is there a
// time-of-day effect" in isolation? Given one symbol's raw hourly bars
// (same shape as above) and a day-level Fear & Greed reading per date,
// isolates every bar whose timestamp falls in `slot` (matching
// slotsForTimestamp's own naming), matches forward to `horizonHours`
// ahead via the same nearest-bar-within-tolerance logic
// computeTimeOfDayTallies uses just above (real gaps in equity hourly
// bars make a fixed index offset wrong), and buckets the resulting %
// moves by that day's sentiment reading (same >=75/<=25 extreme
// thresholds as sentimentExtremeForwardReturns). Returns
// {extreme: [{date,value}], normal: [{date,value}]} for the caller to
// twoSampleZTest. Deliberately restricted by the caller to a small named
// set of headline slots (hour_et_00 plus UTC 00/08/16), not all ~50
// possible slots — see correlation-research.mjs for the Bonferroni
// correction across that small set.
export function timeOfDaySentimentSplit(hourlyBars, sentimentByDate, slot, horizonHours) {
  const sorted = hourlyBars.slice().sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  const toleranceMs = TOD_TALLY_TOLERANCE_MIN * 60 * 1000;
  const out = { extreme: [], normal: [] };
  for (let i = 0; i < sorted.length; i++) {
    const before = sorted[i];
    if (!before.close || !slotsForTimestamp(before.ts).includes(slot)) continue;
    const beforeMs = new Date(before.ts).getTime();
    const targetMs = beforeMs + horizonHours * 3600 * 1000;
    let best = null, bestDiff = Infinity;
    for (let j = i + 1; j < sorted.length; j++) {
      const diff = new Date(sorted[j].ts).getTime() - targetMs;
      if (diff > toleranceMs) break; // sorted ascending — nothing further out can be closer
      if (Math.abs(diff) <= toleranceMs && Math.abs(diff) < bestDiff) { bestDiff = Math.abs(diff); best = sorted[j]; }
    }
    if (!best) continue;
    const date = before.ts.slice(0, 10);
    const fg = sentimentByDate[date];
    if (fg == null) continue;
    const pct = ((best.close / before.close) - 1) * 100;
    const bucket = fg <= 25 || fg >= 75 ? 'extreme' : 'normal';
    out[bucket].push({ date, value: pct });
  }
  return out;
}

// Below this many observed days, a slot's tallied high/low probability is
// too noisy to act on. Days accumulate far slower than hourly technique-
// vote samples (one tally per day per slot, not one per hour), so this
// bar is lower than MIN_RELIABILITY_SAMPLES/TOD_MIN_SAMPLES — still real
// depth, just calibrated to this statistic's slower cadence.
const SWING_TIME_MIN_DAYS = 40;
// How many times above the naive uniform baseline (1/24 for an hour slot,
// 1/7 for day-of-week) a slot's observed probability must be to count as
// a real pattern rather than noise.
const SWING_TIME_MIN_RATIO = 2;

function swingTimeBaseline(slot) {
  return slot.startsWith('dow_utc_') ? 1 / 7 : 1 / 24;
}

// Does this asset have a proven tendency for its daily high or low to
// specifically land in the CURRENT clock slot? Distinct from
// timeOfDaySignal (which measures directional bias in the hour(s) AFTER a
// slot) — this measures where the extreme ITSELF tends to fall. Checks
// every slot `nowIso` belongs to and every extreme type, keeps whichever
// candidate has the strongest ratio-over-baseline with enough days
// observed — same "best candidate, not every candidate" discipline as
// timeOfDaySignal.
export function swingTimeSignal(swingTimeStats, symbol, nowIso) {
  if (!swingTimeStats) return null;
  let best = null;
  for (const slot of slotsForTimestamp(nowIso)) {
    const baseline = swingTimeBaseline(slot);
    for (const extremeType of ['high', 'low']) {
      const rec = swingTimeStats[`${symbol}|${slot}|${extremeType}`];
      if (!rec || rec.totalDays < SWING_TIME_MIN_DAYS) continue;
      const prob = rec.count / rec.totalDays;
      const ratio = prob / baseline;
      if (ratio < SWING_TIME_MIN_RATIO) continue;
      if (!best || ratio > best.ratio) best = { slot, extremeType, prob, ratio, totalDays: rec.totalDays };
    }
  }
  return best;
}

// How many days back a hack/exploit event still counts as "recent" for
// the eventshock technique — a real shock's price impact is overwhelmingly
// concentrated in the first days, not weeks.
const EVENT_SHOCK_WINDOW_DAYS = 14;

// Picks the worst (highest severity-relative-to-mcap × recency) of an
// asset's recent events, or null if none qualify. Severity relative to
// THIS asset's own market cap, not an absolute dollar figure — a $50M
// hack means something very different to a $200M-cap token than a $200B
// one. An unknown dollar amount gets a modest default impact rather than
// being treated as zero, on the theory that DeFiLlama still thought it
// worth recording even without a confirmed figure.
export function selectWorstRecentEvent(events, nowMs, mcap, windowDays = EVENT_SHOCK_WINDOW_DAYS) {
  if (!events || !events.length) return null;
  let best = null;
  for (const ev of events) {
    const ageDays = (nowMs - new Date(ev.date).getTime()) / 86400000;
    if (ageDays < 0 || ageDays > windowDays) continue;
    const relSeverity = ev.severityUsd != null && mcap > 0 ? ev.severityUsd / mcap : 0.05;
    const recencyFactor = clamp(1 - ageDays / windowDays, 0.15, 1);
    const score = relSeverity * recencyFactor;
    if (!best || score > best.score) best = { ...ev, ageDays, relSeverity, recencyFactor, score };
  }
  return best;
}

// `ctx` bundles every param past `reliability` — grew to 7 positional
// fields across several rounds (swing-time, event-severity, sector
// lead-lag) and a mis-ordered positional pair was already caught once
// before running. One object, destructured here and passed through
// confluence/rankBoards unchanged, so a future new field is one extra
// destructured name here, not a new position everywhere up the chain.
export function evaluateTechniques(m, kind, reliability, ctx = {}) {
  const { marketContext, todStats, nowIso, leadLagSignals, leaderReturns, swingTimeStats, recentEvents, tvlSeries, reliabilityByRegime, srLevels, srBreakStats, marketReturn, yieldSpreadChange, techniquePriors, comboReliability, directionBaselines } = ctx;
  const T = [];
  const regime = regimeOf(m.structure);
  const push = (id, w, dir, note) => T.push({ id, w: w * reliabilityMultiplierForAssetClass(reliability, m.symbol, id, reliabilityByRegime, regime, kind, techniquePriors, directionBaselines), dir, note });
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
    // Prefers this asset's own funding-rate percentile (learned from
    // funding_rate_daily, the permanent archive — see loadFundingHistory
    // in reliability.mjs) once enough of its own history exists: a coin
    // whose funding always runs hot needs a different bar than one where
    // it never does, the same "asset teaches the model its own behavior"
    // idea bestVolLookback already applies to volatility. Falls back to
    // the original fixed global thresholds — unchanged — until then, same
    // historical-vs-methodology basis switch used throughout this engine.
    if (f != null) {
      if (m.fundingPercentile != null) {
        const p = m.fundingPercentile;
        if (p >= 0.9 && (c7 ?? 0) > bigMove) push('positioning', 1.0, -1, `crowded longs, funding in its own ${(p * 100).toFixed(0)}th percentile`);
        else if (p <= 0.1 && (c7 ?? 0) > 0) push('positioning', 1.0, 1, 'rally with funding in its own bottom decile');
        else if (p >= 0.97) push('positioning', 1.0, -1, 'funding at a historic extreme for this asset');
        else push('positioning', 1.0, 0, null);
      } else if (f >= 0.0005 && (c7 ?? 0) > bigMove) push('positioning', 1.0, -1, `crowded longs, funding ${(f * 100).toFixed(3)}%`);
      else if (f <= 0 && (c7 ?? 0) > 0) push('positioning', 1.0, 1, 'rally with skeptical funding');
      else if (f >= 0.0008) push('positioning', 1.0, -1, 'extreme positive funding');
      else push('positioning', 1.0, 0, null);
    } else push('positioning', 1.0, null, null);
    if (m.trending) {
      if ((m.rsi ?? 50) >= 72) push('attention', 0.6, -1, 'trending list + overbought = crowded');
      else if ((m.rsi ?? 50) >= 40 && (m.rsi ?? 50) <= 65) push('attention', 0.6, 1, 'attention building, not stretched');
      else push('attention', 0.6, 0, null);
    }

    // T-open interest: OI relative to this asset's OWN recent history
    // (learned the same way, not an absolute dollar figure that means
    // wildly different things for BTC vs. a small-cap alt), combined with
    // price direction. Elevated OI backing a rally is trend confirmation —
    // real new participation, not price just drifting on thin books;
    // elevated OI during a selloff is a crowded, liquidation-prone setup.
    // Thin OI on a big move either way is left neutral, not fabricated
    // into a direction — a big move on thin participation is genuinely
    // ambiguous, not a hidden bullish or bearish tell.
    if (m.openInterest != null && m.oiPercentile != null) {
      const oiBigMove = 8;
      if (m.oiPercentile >= 0.8 && (c7 ?? 0) > oiBigMove) push('openinterest', 0.8, 1, `rally backed by elevated open interest (its own ${(m.oiPercentile * 100).toFixed(0)}th pct)`);
      else if (m.oiPercentile >= 0.8 && (c7 ?? 0) < -oiBigMove) push('openinterest', 0.8, -1, 'selloff with crowded open interest, liquidation risk');
      else push('openinterest', 0.8, 0, null);
    } else {
      push('openinterest', 0.8, null, null);
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

  // T17 Fibonacci retracement: price sitting within a tight band of the
  // 38.2/50/61.8% retracement of the recent swing (the "golden pocket" and
  // its immediate neighbors — the shallower/deeper 23.6%/78.6% levels
  // exist but are too weak a reaction zone on their own to vote from).
  // Never fires on proximity alone — same independent-confirmation bar as
  // the reversal technique (T14): a stochastic cross, Bollinger extreme,
  // swing structure, or the divergence proxy has to agree before a level
  // touch counts as a real reaction rather than price just passing
  // through. Only the swing's live leg direction (see fibonacciLevels)
  // counts — a pullback holding support after an up-leg is bullish, a
  // bounce rejected at resistance after a down-leg is bearish, never both.
  if (m.fib) {
    const price = m.price;
    const band = price * FIB_PROXIMITY_PCT / 100;
    const levels = [['38.2%', m.fib.l382], ['50%', m.fib.l500], ['61.8%', m.fib.l618]];
    const near = levels.find(([, v]) => Math.abs(price - v) <= band);
    const confirmBull = (m.stoch && m.stoch.crossUp) || (m.bb && m.bb.pctB < 0.15) || m.structure === 1 || m.divergence === 1;
    const confirmBear = (m.stoch && m.stoch.crossDown) || (m.bb && m.bb.pctB > 0.85) || m.structure === -1 || m.divergence === -1;
    if (near && m.fib.legUp && confirmBull) push('fibonacci', 0.8, 1, `holding ${near[0]} retracement of its recent up-leg`);
    else if (near && !m.fib.legUp && confirmBear) push('fibonacci', 0.8, -1, `rejected at ${near[0]} retracement of its recent down-leg`);
    else push('fibonacci', 0.8, 0, null);
  } else {
    push('fibonacci', 0.8, null, null);
  }

  // T18 time-of-day: does this asset have a proven, measured behavioral
  // bias at the current UTC hour, NY-local hour (midnight ET, NYSE's
  // 9am/4pm hours), or day of week? See timeOfDaySignal's docs — only
  // fires once a slot has real sample depth and a real effect size, never
  // on a handful of coincidental observations. `nowIso` is required (the
  // technique needs to know what time it is to look itself up); silently
  // abstains without it rather than guessing at "now".
  if (todStats && nowIso) {
    const tod = timeOfDaySignal(todStats, m.symbol, nowIso);
    if (tod) push('timeofday', 0.7, tod.dir, `${tod.dir > 0 ? 'tends to rise' : 'tends to fall'} in the ${tod.horizonHours}h after ${tod.slot.replace(/_/g, ' ')} (${tod.n} obs)`);
    else push('timeofday', 0.7, 0, null);
  } else {
    push('timeofday', 0.7, null, null);
  }

  // T19 sentiment: market-wide extremes — Fear & Greed for crypto, VIX's
  // position in its own recent range for equities — now also scored as
  // their own standalone, falsifiable vote (not just the confidence
  // kicker they already are inside 'reversal'), combined with per-asset
  // community/news sentiment (m.sentimentScore, -1..1, pooled from
  // CoinGecko's up-vote % and CryptoPanic's bullish/bearish news balance
  // by loadSentimentMap — see reliability.mjs) once it exists. Same
  // contrarian read as 'reversal' already uses for VIX: an extreme (fear,
  // or a VIX spike) leans bullish, complacency (greed, or a quiet VIX)
  // leans bearish — consistent with how this engine already treats those
  // two elsewhere, not a new interpretation invented here.
  if (kind === 'crypto') {
    const fg = marketContext && marketContext.fearGreed;
    const per = m.sentimentScore;
    let dir = null, note = null;
    if (fg != null && fg <= 20) { dir = 1; note = 'market-wide extreme fear'; }
    else if (fg != null && fg >= 80) { dir = -1; note = 'market-wide extreme greed'; }
    if (dir == null && per != null && Math.abs(per) >= 0.3) {
      dir = per > 0 ? 1 : -1;
      note = per > 0 ? 'net-bullish community/news sentiment' : 'net-bearish community/news sentiment';
    }
    if (dir != null) push('sentiment', 0.6, dir, note);
    else if (fg != null || per != null) push('sentiment', 0.6, 0, null);
    else push('sentiment', 0.6, null, null);
  } else {
    const vix = marketContext && marketContext.vixRangePos;
    if (vix != null) {
      if (vix >= 0.85) push('sentiment', 0.6, 1, 'VIX near a recent extreme, fear already priced in');
      else if (vix <= 0.15) push('sentiment', 0.6, -1, 'VIX complacent near recent lows');
      else push('sentiment', 0.6, 0, null);
    } else push('sentiment', 0.6, null, null);
  }

  // T20 lead/lag: has ANOTHER asset — not necessarily in the same asset
  // class; crypto can lead stocks, DXY/Gold/Oil can lead either — proven,
  // over the permanent archive, to predict THIS asset's move some number
  // of days later? See computeLeadLag (scripts/archive.mjs, run daily) for
  // how relationships are discovered and scored, and loadLeadLagSignals
  // (reliability.mjs) for how they're loaded each hour. Votes in the
  // direction the relationship implies (correlation sign × the leader's
  // own actual recent move direction) only once the leader has moved
  // meaningfully over the matching window — a flat leader implies nothing
  // either way, so this abstains rather than fabricating a direction from
  // noise. When an asset has several registered leaders, only the
  // strongest-correlation one that actually moved gets to vote — same
  // "best candidate, not every candidate" discipline as timeOfDaySignal.
  // Scored through the exact same technique_reliability pipeline as every
  // other technique, so a relationship that stops working gets weighted
  // down automatically, same as any other technique here.
  const registeredLeaders = leadLagSignals && leadLagSignals[m.symbol];
  if (registeredLeaders && registeredLeaders.length && leaderReturns) {
    let best = null;
    for (const rel of registeredLeaders) {
      const bars = leaderReturns[rel.leaderSymbol];
      const move = bars ? nDayReturnFromBars(bars, rel.lagDays) : null;
      if (move == null || Math.abs(move) < 1) continue; // flat leader this run: no signal to relay
      if (!best || Math.abs(rel.corr) > Math.abs(best.corr)) best = { ...rel, move };
    }
    if (best) {
      const dir = (best.corr > 0 ? 1 : -1) * (best.move > 0 ? 1 : -1);
      // A leader can be a real symbol or a SECTOR:<name> composite (see
      // computeSectorCompositeSeries) — same relationship, just a nicer
      // label than the raw pseudo-symbol string in the displayed note.
      const leaderLabel = best.leaderSymbol.startsWith('SECTOR:') ? `the ${best.leaderSymbol.slice(7)} sector` : best.leaderSymbol;
      push('leadlag', 0.8, dir, `${leaderLabel} moved ${best.move > 0 ? '+' : ''}${best.move.toFixed(1)}% ${best.lagDays}d ago (proven leader, corr ${best.corr.toFixed(2)})`);
    } else {
      push('leadlag', 0.8, 0, null);
    }
  } else {
    push('leadlag', 0.8, null, null);
  }

  // T21 swing-time-of-day: has this asset's daily high or low proven to
  // specifically land in the CURRENT clock slot (see swingTimeSignal) —
  // not just "does it tend to move up/down around now" (timeofday already
  // answers that), but "does the actual swing extreme tend to happen right
  // now"? Never fires on timing alone: also needs the asset to be sitting
  // near its own recent high/low right now (rangePos, already computed),
  // same discipline as reversal/fibonacci — a well-timed slot with price
  // sitting mid-range isn't a real setup, just a coincidence of the clock.
  if (swingTimeStats && nowIso) {
    const swing = swingTimeSignal(swingTimeStats, m.symbol, nowIso);
    const pos = m.rangePos;
    const slotLabel = swing ? swing.slot.replace(/_/g, ' ') : null;
    if (swing && pos != null && swing.extremeType === 'low' && pos <= 0.15) {
      push('swingtime', 0.7, 1, `daily low tends to land at ${slotLabel} for this asset (${(swing.prob * 100).toFixed(0)}% of ${swing.totalDays}d, ${swing.ratio.toFixed(1)}x baseline), and it's there now`);
    } else if (swing && pos != null && swing.extremeType === 'high' && pos >= 0.85) {
      push('swingtime', 0.7, -1, `daily high tends to land at ${slotLabel} for this asset (${(swing.prob * 100).toFixed(0)}% of ${swing.totalDays}d, ${swing.ratio.toFixed(1)}x baseline), and it's there now`);
    } else {
      push('swingtime', 0.7, 0, null);
    }
  } else {
    push('swingtime', 0.7, null, null);
  }

  // T22 event shock: a matched hack/exploit within the last two weeks
  // (see selectWorstRecentEvent, DeFiLlama-sourced — archive.mjs/
  // reliability.mjs) votes bearish, weighted by recency and by severity
  // relative to THIS asset's own market cap. Unlike most techniques here,
  // a real matched event is not treated as ambiguous/abstain-worthy — the
  // direction is unambiguous (this engine's own reasoning, matching how
  // the user who asked for this framed it: a hack "would almost certainly
  // create a crazy downtrend") — but the reliability loop still calibrates
  // the WEIGHT per asset over time if it turns out to over- or under-react
  // for a given one, same as every other technique. Crypto-only (hacks
  // are a crypto-specific concept in this engine).
  if (kind === 'crypto' && recentEvents && nowIso) {
    const best = selectWorstRecentEvent(recentEvents[m.symbol], new Date(nowIso).getTime(), m.mcap);
    if (best) {
      const w = clamp(0.6 + best.relSeverity * 3, 0.6, 1.8) * best.recencyFactor;
      const ageLabel = best.ageDays < 1 ? 'today' : `${Math.round(best.ageDays)}d ago`;
      const sevLabel = best.severityUsd ? `, ~$${(best.severityUsd / 1e6).toFixed(0)}M` : '';
      push('eventshock', w, -1, `${best.type} ${ageLabel}${sevLabel} (${best.description})`);
    } else {
      push('eventshock', 0.6, 0, null);
    }
  } else {
    push('eventshock', 0.6, null, null);
  }

  // T23 TVL trend: sustained capital flowing into or out of a matched
  // DeFiLlama protocol (see matchProtocolsToUniverse, archive.mjs — exact
  // gecko_id match only), reusing nDayReturnFromBars over the archived
  // TVL:<symbol> series the same way the leadlag technique reads a
  // registered leader's own recent bars. TVL alone doesn't prove
  // causation for price (it can rise just from the price appreciation of
  // already-locked collateral, not new capital), so this pairs with price
  // direction before firing — same "real participation, not fabricated
  // from one signal" discipline as openinterest/positioning. Crypto-only
  // (TVL is a DeFi-specific concept; no stock equivalent).
  if (kind === 'crypto' && tvlSeries && tvlSeries[m.symbol]) {
    const trend = nDayReturnFromBars(tvlSeries[m.symbol], 7);
    if (trend != null) {
      const tvlBigMove = 15;
      if (trend > tvlBigMove && (c7 ?? 0) > 0) push('tvltrend', 0.7, 1, `TVL up ${trend.toFixed(0)}% over 7d, capital flowing in`);
      else if (trend < -tvlBigMove && (c7 ?? 0) < 0) push('tvltrend', 0.7, -1, `TVL down ${trend.toFixed(0)}% over 7d, capital flowing out`);
      else push('tvltrend', 0.7, 0, null);
    } else {
      push('tvltrend', 0.7, null, null);
    }
  } else {
    push('tvltrend', 0.7, null, null);
  }

  // T24 implied vol: options-implied volatility (forward-looking — distinct
  // from the REALIZED-vol regime the 'volatility' technique reads via
  // volReg) at an extreme relative to THIS asset's own history, same
  // percentile-vs-own-history pattern as funding/OI. Same contrarian "fear
  // priced in" read already proven for VIX in the sentiment technique
  // (elevated implied vol often precedes reversion, not continuation) —
  // but unlike VIX/sentiment, this only fires paired with the asset's own
  // price actually being stretched toward a recent extreme (rangePos),
  // same "never fire on one signal alone" discipline as reversal/fibonacci.
  // Source differs by kind (Deribit DVOL for crypto — BTC/ETH only, the
  // only two currencies it publishes; Yahoo's front-month ATM-ish options
  // IV for stocks) but both land in the same iv_daily archive and the same
  // m.ivPercentile field (buildCryptoMetrics/buildStockMetrics), so no
  // kind-specific branching is needed here at all.
  if (m.ivPercentile != null && m.rangePos != null) {
    if (m.ivPercentile >= 0.8 && m.rangePos <= 0.15) push('impliedvol', 0.7, 1, `implied vol at its own ${(m.ivPercentile * 100).toFixed(0)}th pct near a recent low, fear priced in`);
    else if (m.ivPercentile >= 0.8 && m.rangePos >= 0.85) push('impliedvol', 0.7, -1, `implied vol at its own ${(m.ivPercentile * 100).toFixed(0)}th pct near a recent high, euphoria priced in`);
    else push('impliedvol', 0.7, 0, null);
  } else {
    push('impliedvol', 0.7, null, null);
  }

  // T25 earnings risk: not a directional call — a flag. When this stock's
  // next reported earnings date falls inside the technique's own horizon
  // window (below), an active call in that window is exposed to gap risk
  // an ordinary technical read doesn't price in, so this votes neutral
  // (dir 0) rather than staying silent, which dilutes confluence's total
  // weight and pulls conviction down without asserting a direction — the
  // same "suppress false confidence" idea as the significance guardrail,
  // applied per-event instead of per-sample. Stocks only (crypto has no
  // earnings calendar); always abstains outside the window or when Yahoo
  // has no estimate on file for this symbol (common for thinner names).
  if (kind === 'stock') {
    const earningsWindowDays = 3;
    const d = m.daysToEarnings;
    if (d != null && d >= 0 && d <= earningsWindowDays) {
      const daysLabel = d < 1 ? 'today' : `in ${Math.round(d)} day${Math.round(d) === 1 ? '' : 's'}`;
      push('earningsrisk', 0.6, 0, `earnings ${daysLabel} — elevated gap risk`);
    } else {
      push('earningsrisk', 0.6, null, null);
    }
  } else {
    push('earningsrisk', 0.6, null, null);
  }

  // T26 support/resistance break, with a calibrated typical move size (see
  // asset_sr_levels/sr_break_stats, computed daily by archive.mjs off the
  // permanent price archive — added after a post-mortem on the 2026-08-19
  // pump found BTC's composite score suppressed through the entire move by
  // chop-era blended technique_reliability; see schema.sql's docs on those
  // two tables for the full finding). A level only ever reaches
  // asset_sr_levels once price has reversed off it more than once
  // (SR_MIN_TOUCHES, archive.mjs) — a real, tested level, not an arbitrary
  // N-bar high/low the way the existing `range` technique's 20-bar
  // Donchian channel is (T7 above, unrelated and unchanged). Confirming,
  // not leading, same family as `range`/`structure`: this describes a
  // break that's already happened, it doesn't anticipate one. The buffer
  // below must stay in sync with archive.mjs's SR_BREAK_BUFFER_PCT — it's
  // what "broken" meant when sr_break_stats' calibration was computed, so
  // using a different one here would make the note's own numbers wrong.
  {
    const SR_LIVE_BREAK_BUFFER_PCT = 0.75;
    const levels = (srLevels && srLevels[m.symbol]) || [];
    let best = null;
    for (const lvl of levels) {
      const brokeDown = lvl.levelType === 'support' && m.price < lvl.level * (1 - SR_LIVE_BREAK_BUFFER_PCT / 100);
      const brokeUp = lvl.levelType === 'resistance' && m.price > lvl.level * (1 + SR_LIVE_BREAK_BUFFER_PCT / 100);
      if (!brokeDown && !brokeUp) continue;
      if (!best || lvl.touches > best.lvl.touches) best = { lvl, dir: brokeDown ? -1 : 1 };
    }
    if (best) {
      const lvlStr = best.lvl.level >= 1 ? best.lvl.level.toFixed(2) : best.lvl.level.toPrecision(3);
      const stat = srBreakStats && (srBreakStats[`${m.symbol}|24`] || srBreakStats[`${kind}|${best.lvl.levelType}|24`]);
      const note = stat
        ? `broke ${best.lvl.levelType} $${lvlStr} — historically ${stat.meanPct >= 0 ? '+' : ''}${stat.meanPct.toFixed(1)}% over 24h (${stat.n} prior break${stat.n === 1 ? '' : 's'})`
        : `broke ${best.lvl.levelType} $${lvlStr} (${best.lvl.touches} prior touches)`;
      push('srbreak', 1.0, best.dir, note);
    } else if (levels.length) {
      push('srbreak', 1.0, 0, null);
    } else {
      push('srbreak', 1.0, null, null);
    }
  }

  // T27 accumulation/distribution: fires WHILE price is still coiled,
  // unlike the 'obv' technique above (T9) which requires real c7 price
  // confirmation before it votes at all — this is deliberately its leading
  // counterpart, answering "is this asset quietly building pressure before
  // it moves" rather than "did volume confirm a move that already
  // happened." Coiled = Bollinger bands actively tightening (bb.squeezed,
  // and not yet releasing) or realized vol well under its own recent
  // baseline (volReg) — with price itself still flat (|chg7d| < 5%), so
  // this is a real base, not just a quiet hour inside an ongoing trend.
  // Within that state, OBV's own slope (used here with no price-
  // confirmation requirement, unlike T9) is the only available read on
  // which way the coiling is leaning — same 0.5 significance threshold T9
  // already uses for "a real lean, not noise."
  if (m.obv != null && (m.bb || m.volReg != null)) {
    const coiled = ((m.bb && m.bb.squeezed && !m.bb.expanding) || (m.volReg != null && m.volReg <= 0.65))
      && Math.abs(m.chg7d ?? 0) < 5;
    if (coiled && m.obv > 0.5) push('accum', 0.9, 1, 'coiled range, OBV building ahead of price');
    else if (coiled && m.obv < -0.5) push('accum', 0.9, -1, 'coiled range, OBV fading ahead of price');
    else push('accum', 0.9, 0, null);
  } else {
    push('accum', 0.9, null, null);
  }

  // T28 market-wide outlier: compares this asset's own recent move against
  // the broad crypto market's (marketReturn — MCAP:TOTAL's real figure
  // once it has enough days, else MCAP:BROAD's proxy composite; see
  // loadMarketReturn's docs, archive.mjs). Crypto only. Genuine
  // idiosyncratic strength/weakness — this asset moving well beyond what
  // the market itself is doing, not just riding it — reads differently
  // than a move fully explained by the market moving too, same
  // "decoupling from the benchmark is informative" reasoning the `dwell`
  // technique (T17) already uses against BTC/SPY specifically; this is
  // the market-wide counterpart. Both figures are 7-day, not 24h: the
  // daily-cadence market archive can be up to ~24h stale relative to this
  // hour's live m.chg7d, which would swamp a 24h comparison but is
  // negligible noise against a 7-day window.
  if (kind === 'crypto' && marketReturn && marketReturn.chg7d != null && m.chg7d != null) {
    const gap = m.chg7d - marketReturn.chg7d;
    const oppositeSign = Math.sign(m.chg7d) !== 0 && Math.sign(marketReturn.chg7d) !== 0 && Math.sign(m.chg7d) !== Math.sign(marketReturn.chg7d);
    if (gap >= 12 || (oppositeSign && m.chg7d >= 3)) push('mktoutlier', 0.8, 1, `up ${m.chg7d.toFixed(0)}% over 7d vs. the broad market's ${marketReturn.chg7d.toFixed(0)}%`);
    else if (gap <= -12 || (oppositeSign && m.chg7d <= -3)) push('mktoutlier', 0.8, -1, `down ${m.chg7d.toFixed(0)}% over 7d vs. the broad market's ${marketReturn.chg7d.toFixed(0)}%`);
    else push('mktoutlier', 0.8, 0, null);
  } else {
    push('mktoutlier', 0.8, null, null);
  }

  // T29 yield curve: the ONE hypothesis (of 19 tested) that survived
  // correlation-research.mjs's pooled + chronological-half-split guardrail
  // in its 2026-08-21 consolidation-then-breakout research pass — real,
  // both halves of history independently significant (z=-2.85 / z=-3.22):
  // the 2s10s Treasury yield spread moving more negative over the
  // preceding 5 days measurably precedes a crypto breakdown episode
  // (>=20% down within <=7 days). Pooled means: -0.003 on an ordinary day
  // vs. -0.029 in the 5 days before such an episode — -0.015 sits roughly
  // halfway, a real move past ordinary noise without requiring the full
  // extreme before firing (this needs to lead, not just confirm).
  // Deliberately asymmetric: the mirror hypothesis (spread rising before
  // a BULLISH episode) was also tested and did NOT clear the guardrail —
  // this only ever votes bearish, never bullish, and crypto only (the
  // spread-level tests, and stocks, weren't part of what validated).
  if (kind === 'crypto' && yieldSpreadChange && yieldSpreadChange.chg5d != null) {
    if (yieldSpreadChange.chg5d <= -0.015) push('yieldcurve', 0.8, -1, `2s10s spread moved ${yieldSpreadChange.chg5d.toFixed(2)}pts over 5d — historically precedes crypto weakness`);
    else push('yieldcurve', 0.8, 0, null);
  } else {
    push('yieldcurve', 0.8, null, null);
  }

  const directional = T.filter((t) => t.dir === 1 || t.dir === -1);
  if (directional.length >= 2 && comboReliability) {
    for (const t of directional) {
      t.w *= comboReinforcementMultiplier(comboReliability, m.symbol, t.id, t.dir, directional, kind, techniquePriors);
    }
  }

  return T;
}

export function confluence(m, kind, reliability, ctx = {}) {
  const { reliabilityByHorizon } = ctx;
  const T = evaluateTechniques(m, kind, reliability, ctx);
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

// Finds every point where this ONE symbol's own logged composite-call
// history reversed direction — user-requested 2026-08-22, grounded in a
// real live case (WLFI: called a bottom a few hours before switching to
// breakdown risk). compositeCall's dir is always +-1, never 0 (an exact
// tie logs nothing at all — see its own docs), so a flip is simply two
// chronologically ADJACENT rows whose dir differs; nothing more elaborate
// is needed to define one. `rows`: this symbol's own composite rows,
// [{run_at, dir, score}], any order (sorted internally) — the caller
// reads these straight from technique_votes WHERE technique_id='composite'
// (reliability.mjs's detectAndLogCallFlips), not a new log: the composite
// call was already being recorded every run for the calibration curve
// (logRun/evaluateMatured), this just reads that existing history from a
// new angle instead of adding a parallel one.
export function detectCallFlips(rows) {
  const sorted = rows.slice().sort((a, b) => (a.run_at < b.run_at ? -1 : a.run_at > b.run_at ? 1 : 0));
  const flips = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1], cur = sorted[i];
    if (cur.dir === prev.dir) continue;
    const hoursBetween = (new Date(cur.run_at) - new Date(prev.run_at)) / 3600000;
    flips.push({
      priorRunAt: prev.run_at, priorDir: prev.dir, priorScore: prev.score,
      newRunAt: cur.run_at, newDir: cur.dir, newScore: cur.score,
      hoursBetween
    });
  }
  return flips;
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

export async function getCryptoMarkets() {
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
      const prices = (j && j.prices) || [];
      return {
        closes,
        volumes: vols.length === closes.length ? vols : null,
        bars: prices.filter((p) => p[1] != null).map((p) => ({ date: new Date(p[0]).toISOString().slice(0, 10), close: p[1] }))
      };
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
export async function coingeckoSimplePrice(ids) {
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

// Binance.US: a second, independent live-price source for /api/prices, so
// neither provider alone carries the full displayed-symbol set every
// cache cycle. See LIVE_PRICE_CACHE_KEY's docs — CoinGecko rate-limiting
// Cloudflare's shared egress IPs is what made that cache necessary; this
// doesn't remove the need for it (KV's expirationTtl floor is 60s
// regardless of provider), but it cuts CoinGecko's own share of that
// traffic and adds headroom as the tracked universe grows. Binance.US, not
// Binance.com: the latter is geo-blocked (HTTP 451) from this project's
// infra, already confirmed live elsewhere in this codebase (archive.mjs's
// Binance.US backfill integration) — reimplemented independently here
// rather than imported from archive.mjs, since worker.js is the engine
// every other script imports FROM, never the reverse.
const BINANCE_US_BASE = 'https://api.binance.us/api/v3';

// Which base symbols have a live, actively-trading USDT pair on Binance.US
// right now. Computed once per hourly build (see buildPayload), not per
// live-price request — the result rides in the KV payload so /api/prices
// never needs its own discovery call. Never throws: an empty Set just
// means every crypto symbol falls back to CoinGecko, same as before this
// existed.
export async function binanceUsTradablePairs() {
  const j = await fetchJson(`${BINANCE_US_BASE}/exchangeInfo`);
  const set = new Set();
  for (const s of (j && j.symbols) || []) {
    if (s.status === 'TRADING' && s.quoteAsset === 'USDT' && s.baseAsset) set.add(s.baseAsset.toUpperCase());
  }
  return set;
}

// Live price + 24h change for a batch of base symbols already confirmed
// tradable on Binance.US (see binanceUsTradablePairs) — mirrors
// coingeckoSimplePrice's shape/contract exactly (never throws on a bad
// symbol, just omits it) so the /api/prices route can treat both sources
// interchangeably.
export async function binanceUsTicker24hr(baseSymbols) {
  if (!baseSymbols.length) return {};
  const pairs = baseSymbols.map((s) => `${s.toUpperCase()}USDT`);
  const url = `${BINANCE_US_BASE}/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(pairs))}`;
  const j = await fetchJson(url);
  const out = {};
  for (const t of Array.isArray(j) ? j : []) {
    if (!t.symbol || !t.symbol.endsWith('USDT')) continue;
    const base = t.symbol.slice(0, -4);
    const price = parseFloat(t.lastPrice);
    const chg24h = parseFloat(t.priceChangePercent);
    if (Number.isFinite(price)) out[base] = { price, chg24h: Number.isFinite(chg24h) ? chg24h : null };
  }
  return out;
}

export async function getGlobal() {
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

// CoinGecko's aggregated derivatives listing: one call returns funding rate
// + open interest for every tracked perpetual across every major exchange.
// Replaced the previous Bybit-only tickers call after that endpoint started
// returning HTTP 403 from GitHub Actions (confirmed live 2026-08-02 —
// technique_reliability had zero 'positioning' rows across its entire
// lifetime, meaning funding had silently never once worked since the
// reliability system shipped on 2026-07-24, masked by the existing
// Promise.allSettled fallback to `funding: {}`). This reuses CoinGecko,
// already the pipeline's proven-reliable primary dependency, instead of
// swapping in yet another single exchange with its own unknown access risk.
// For each base symbol, keeps the USDT-margined perpetual market with the
// highest open interest when more than one exchange lists it — the most
// liquid, representative venue, not just whichever happens to sort first.
// Perp-vs-spot basis: how far the perpetual's own last price sits from its
// spot index, as a %. Computed here rather than trusting CoinGecko's own
// "basis" field on each derivatives record — a live spot-check (price
// 77006.7, index 76902.25) didn't reconcile against that field's reported
// value (-1.81%, vs. the +0.14% this formula gives), and CoinGecko doesn't
// document its exact definition (plausibly annualized or otherwise
// adjusted) — this way the number this project stores and archives
// (funding_rate_daily.basis_pct, schema.sql) has a formula this codebase
// actually understands and can reason about later.
export function perpBasisPct(price, index) {
  if (price == null || index == null || !index) return null;
  return ((price / index) - 1) * 100;
}

// Retries on 429 with the same backoff getCryptoDailyHistory already uses
// against this same CoinGecko host — added after a live 429 (confirmed via
// the real GitHub Actions log, 2026-08-21/22) took out the ENTIRE
// funding/OI/basis snapshot for the day with a single failed request and
// no retry at all. This isn't just about the new basis_pct archiving: the
// live `positioning`/`openinterest` techniques call this same function
// every hourly build too, so an un-retried 429 here silently degrades
// them mid-day exactly the way the old Bybit-403 outage once did (see
// this function's own history) — just from a transient rate limit instead
// of a dead endpoint this time.
export async function getFundingMap() {
  const backoffsMs = [3000, 6000];
  let j, lastErr;
  for (let attempt = 0; attempt <= backoffsMs.length; attempt++) {
    try {
      j = await fetchJson('https://api.coingecko.com/api/v3/derivatives');
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      const is429 = /^HTTP 429/.test(String(e && e.message));
      if (!is429 || attempt === backoffsMs.length) break;
      await new Promise((r) => setTimeout(r, backoffsMs[attempt]));
    }
  }
  if (lastErr) throw lastErr;

  const map = {};
  let bestOi = {};
  for (const t of j || []) {
    if (t.contract_type !== 'perpetual') continue;
    if (!t.index_id || !t.symbol || !t.symbol.toUpperCase().endsWith('USDT')) continue;
    const fundingRate = parseFloat(t.funding_rate);
    if (!Number.isFinite(fundingRate)) continue;
    const oiParsed = parseFloat(t.open_interest);
    const openInterest = Number.isFinite(oiParsed) ? oiParsed : null;
    const priceParsed = parseFloat(t.price);
    const indexParsed = parseFloat(t.index);
    const price = Number.isFinite(priceParsed) ? priceParsed : null;
    const index = Number.isFinite(indexParsed) ? indexParsed : null;
    const base = t.index_id.toUpperCase();
    const rank = openInterest ?? -1;
    if (!(base in bestOi) || rank > bestOi[base]) {
      bestOi[base] = rank;
      map[base] = { fundingRate, openInterest, market: t.market || null, basisPct: perpBasisPct(price, index) };
    }
  }
  if (!Object.keys(map).length) throw new Error('empty derivatives map');
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
  const dates = r.timestamp.map((t) => new Date(t * 1000).toISOString().slice(0, 10));
  return { symbol, price, closes, volumes, highs, lows, dates, source: 'yahoo' };
}

// Live spot price + 24h change for one equity symbol — the same chart
// endpoint yahooDaily uses, but the smallest request that still returns a
// fresh meta.regularMarketPrice (no need for a year of daily bars just to
// read today's tick). Used by /api/prices, called once per displayed
// symbol in parallel (see pool() at the call site), not per build.
export async function yahooQuote(symbol) {
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
  const dates = [];
  for (const row of rows.slice(-2600)) {
    const p = row.split(',');
    const c = parseFloat(p[4]);
    if (Number.isFinite(c)) {
      closes.push(c);
      highs.push(parseFloat(p[2]) || c);
      lows.push(parseFloat(p[3]) || c);
      volumes.push(parseFloat(p[5]) || 0);
      dates.push(p[0]);
    }
  }
  return { symbol, price: closes[closes.length - 1], closes, volumes, highs, lows, dates, source: 'stooq' };
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

export async function getCrumb() {
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

// calendarEvents added to the SAME request as financialData/
// defaultKeyStatistics (comma-separated `modules`, a documented feature of
// this endpoint) rather than a second fetch loop — same "reuse the call
// already happening" discipline as TVL reusing the sentiment call's
// categories field. Response shape for calendarEvents (earnings.earningsDate
// as an array of {raw, fmt} — Yahoo sometimes gives a 2-date estimated
// window, not one exact day) is well-documented/stable but, unlike
// financialData/defaultKeyStatistics on this same endpoint (proven live all
// session via this exact function), could not get a fresh live response to
// confirm during this round's research — Yahoo's crumb endpoint stayed
// rate-limited against the testing IP for hours. Defensive parsing
// throughout (never assume a field exists), so a shape mismatch degrades to
// "no earnings date," not a crash — first real confirmation is production
// log output/D1 data after this ships, same as every other live source
// this session.
async function getValuation(symbol, auth) {
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}`
    + `?modules=financialData%2CdefaultKeyStatistics%2CcalendarEvents&crumb=${encodeURIComponent(auth.crumb)}`;
  const j = await fetchJson(url, { headers: { Cookie: auth.cookie } });
  const r = j && j.quoteSummary && j.quoteSummary.result && j.quoteSummary.result[0];
  if (!r) throw new Error(`no summary for ${symbol}`);
  const raw = (x) => (x && typeof x.raw === 'number') ? x.raw : null;
  const fd = r.financialData || {};
  const ks = r.defaultKeyStatistics || {};
  const earningsDates = (r.calendarEvents && r.calendarEvents.earnings && Array.isArray(r.calendarEvents.earnings.earningsDate))
    ? r.calendarEvents.earnings.earningsDate.map((d) => raw(d)).filter((n) => n != null)
    : [];
  return {
    symbol,
    target: raw(fd.targetMeanPrice),
    targetHigh: raw(fd.targetHighPrice),
    targetLow: raw(fd.targetLowPrice),
    analysts: raw(fd.numberOfAnalystOpinions),
    recMean: raw(fd.recommendationMean),
    recKey: fd.recommendationKey || null,
    fwdPE: raw(ks.forwardPE),
    // Earliest of the (possibly 2-date estimated-window) array — unix
    // seconds, converted by the caller. null when Yahoo has no estimate on
    // file (common for smaller/less-covered names).
    nextEarningsEpoch: earningsDates.length ? Math.min(...earningsDates) : null
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
  const fib = haveDaily ? fibonacciLevels(closes) : null;
  const dailyMoves = haveDaily ? dailyMovementStats(extras.daily.bars || []) : null;

  return {
    symbol,
    id: item.id,
    name: item.name,
    dwell,
    corr,
    seasonal,
    fib,
    dailyMoves,
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
    rangeBounds: rangeBounds(closes.slice(-252)),
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
    funding: extras.funding != null ? extras.funding.fundingRate : null,
    openInterest: extras.funding != null ? extras.funding.openInterest : null,
    fundingPercentile: (extras.fundingHistory && extras.fundingHistory.fundingRates && extras.funding != null)
      ? percentileRank(extras.fundingHistory.fundingRates, extras.funding.fundingRate) : null,
    oiPercentile: (extras.fundingHistory && extras.fundingHistory.openInterests && extras.funding != null)
      ? percentileRank(extras.fundingHistory.openInterests, extras.funding.openInterest) : null,
    // dvol/ivPercentile: Deribit-only (BTC/ETH), see loadIvHistory's docs
    // for why "today's value" is just the archive's own most recent point
    // rather than a separate live fetch the way funding/OI's `extras.funding`
    // is.
    dvol: extras.ivHistory ? extras.ivHistory.current : null,
    ivPercentile: (extras.ivHistory && extras.ivHistory.dvols)
      ? percentileRank(extras.ivHistory.dvols, extras.ivHistory.current) : null,
    sentimentScore: extras.sentimentScore != null ? extras.sentimentScore : null,
    trending: !!extras.trending
  };
}

export function buildStockMetrics(row, valuation, override, benchCloses, ivHist) {
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
  const fib = fibonacciLevels(closes);
  const dailyMoves = dailyMovementStats(closes.map((close, i) => ({ date: row.dates?.[i] || null, close })));
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

  // Independent of `val`/target above — earnings dates flow even for
  // symbols the valuation layer has no analyst target for (e.g. a TREFIS
  // override with no Yahoo target). Unix seconds -> days-from-now; negative
  // means Yahoo's estimate hasn't rolled forward past a since-reported date
  // yet, handled by the earningsrisk technique itself, not filtered here.
  const daysToEarnings = (valuation && valuation.nextEarningsEpoch != null)
    ? (valuation.nextEarningsEpoch * 1000 - Date.now()) / 86400000
    : null;

  return {
    symbol,
    name: symbol,
    price,
    volPct,
    volLookbackDays: volLookback ? volLookback.lookback : null,
    dwell,
    corr,
    seasonal,
    fib,
    dailyMoves,
    chgShort: pct(1),
    chg24h: pct(1),
    chg7d: pct(5),
    chg30d: pct(21),
    rsi: rNow,
    rsiPrev: rsi(closes.slice(0, -3)),
    rsiRecentMin: rRange.min,
    rsiRecentMax: rRange.max,
    rangePos: rangePos(closes.slice(-252), price),
    rangeBounds: rangeBounds(closes.slice(-252)),
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
    daysToEarnings,
    // ATM-ish IV percentile vs. this stock's OWN history (iv_daily, source
    // 'yahoo' — see fetchStockAtmIv/archive.mjs), same shape and same
    // percentileRank helper buildCryptoMetrics already uses for Deribit
    // DVOL, so the impliedvol technique block needs zero kind-specific
    // branching to read it.
    ivPercentile: (ivHist && ivHist.dvols) ? percentileRank(ivHist.dvols, ivHist.current) : null,
    source: row.source
  };
}

// Matches HORIZONS_HOURS = [24, 168] in scripts/reliability.mjs (1 day, 7
// days) so every logged range prediction matures on exactly the same
// schedule as technique_votes — an apples-to-apples "was the 1-day band
// right 1 day later" and "was the 7-day band right 7 days later," never a
// mismatched horizon between what's logged and what's checked.
const RANGE_LOG_HORIZONS_DAYS = [1, 7];

function rankBoards(metrics, kind, reliability, ctx = {}) {
  const { moveStats, qualityScores, rotationStatus, callFlipData, longTermBottomStatus } = ctx;
  const scored = metrics.map(m => ({ m, c: confluence(m, kind, reliability, ctx) }));
  // Full-universe vote log (not just the top-10 shown on each board) so the
  // reliability learning loop sees every asset, not only that hour's winners.
  const votesLog = [];
  // Full-universe range-prediction log, same reasoning: a boring, rarely-
  // ranked asset can still build a real track record.
  const rangeLog = [];
  // Full universe with names, price, and a composite-call range/horizon,
  // for the track-record leaderboard — deliberately not limited to the
  // top 10 per side like breakout/breakdown are, since an asset can build
  // a strong record without ever topping either board, and the person
  // reading a 95%+ list needs a price and an actual predicted band next
  // to it, not just a bare score.
  const allSymbols = [];
  for (const { m, c } of scored) {
    // regime frozen at cast time (see regimeOf's docs) — the SAME value
    // every technique's push() used to weight itself this run, since
    // reliabilityMultiplier reads it fresh off m.structure inside
    // evaluateTechniques; recomputed here rather than threaded out of
    // confluence()'s return only because votesLog is assembled here, not
    // there. Composite gets it too (below) — a composite call is itself
    // regime-conditional in the sense that the votes feeding it were.
    const regime = regimeOf(m.structure);
    for (const v of c.votes) votesLog.push({ asset_class: kind, symbol: m.symbol, technique_id: v.id, dir: v.dir, regime });
    // One composite directional vote per asset per run — reuses the exact
    // same technique_votes/technique_reliability machinery as every other
    // technique (see compositeCall's docs), just keyed 'composite'.
    const cc = compositeCall(c);
    let horizon = null, range = null;
    if (cc) {
      // score alongside dir, composite rows only — see logRun/evaluateMatured
      // (reliability.mjs) for where this feeds the calibration curve.
      votesLog.push({ asset_class: kind, symbol: m.symbol, technique_id: 'composite', dir: cc.dir, score: cc.score, regime });
      for (const horizonDays of RANGE_LOG_HORIZONS_DAYS) {
        const r = predictedRange(m.price, horizonDays, cc.score, cc.dir, moveStats, m.symbol, m.volPct);
        if (r) rangeLog.push({ asset_class: kind, symbol: m.symbol, horizon_hours: horizonDays * 24, low: r.low, high: r.high });
      }
      // Distinct from the fixed 1d/7d pair just logged above (those exist
      // purely so maturity-scoring always compares like with like) — this
      // is the asset's own natural resolution window, same horizonEstimate
      // every top-10 board row already shows, so a leaderboard entry's
      // band covers whatever period this specific call actually expects to
      // resolve in rather than an arbitrary fixed one.
      horizon = cc.dir === 1 ? c.longHorizon : c.shortHorizon;
      range = horizon ? predictedRange(m.price, horizon.days, cc.score, cc.dir, moveStats, m.symbol, m.volPct) : null;
    }
    allSymbols.push({
      symbol: m.symbol,
      name: m.name,
      price: m.price,
      dir: cc ? cc.dir : null,
      score: cc ? cc.score : null,
      agree: cc ? (cc.dir === 1 ? c.bull : c.bear) : 0,
      total: c.total,
      horizon,
      range,
      ...(m.id ? { id: m.id } : {})
    });
  }
  const priceLog = scored.map(({ m }) => ({ asset_class: kind, symbol: m.symbol, price: m.price }));
  const entry = (x, side) => {
    const dir = side === 'long' ? 1 : -1;
    const score = side === 'long' ? x.c.long : x.c.short;
    const horizon = side === 'long' ? x.c.longHorizon : x.c.shortHorizon;
    // Independent of which side this row is shown on — the accum
    // technique's own vote, whichever way it's currently leaning (or null
    // if it didn't fire this run). A coiled range is a distinct, worth-
    // flagging setup regardless of whether the asset's overall score
    // happens to currently lean the same way, so this is read straight
    // off x.c.votes rather than gated on dir === score's own direction.
    const accumVote = x.c.votes.find((v) => v.id === 'accum');
    return {
      symbol: x.m.symbol,
      name: x.m.name,
      price: x.m.price,
      chg24h: x.m.chg24h,
      chg7d: x.m.chg7d,
      rsi: x.m.rsi,
      volRatio: x.m.volRatio,
      rangePos: x.m.rangePos,
      rangeBounds: x.m.rangeBounds,
      score,
      // Which side this specific row was built for — always matches
      // cfg.side for the regular boards (uniform by construction), but the
      // favorites section (below) mixes both, so boardHtml uses this per
      // row rather than the board-level cfg.side for anything row-specific.
      dir,
      consolidating: accumVote ? accumVote.dir : null,
      quality: (qualityScores && qualityScores[x.m.symbol]) || null,
      rotation: (rotationStatus && rotationStatus[x.m.symbol]) || null,
      // The WLFI case (user-requested 2026-08-22): this asset's call
      // reversed direction recently enough to be worth a caution note —
      // "called bottomed, switched to breakdown risk 3h ago" — surfaced
      // regardless of which side x.c currently leans, same reasoning as
      // accumVote above. flipStability only appears once enough of this
      // symbol's OWN past flips have matured to say whether they tend to
      // hold or revert (see loadCallFlipData's MIN_RELIABILITY_SAMPLES
      // gate) — informational either way, never a vote on dir/score.
      recentFlip: (callFlipData && callFlipData.recentFlips[x.m.symbol]) || null,
      flipStability: (callFlipData && callFlipData.stability[x.m.symbol]) || null,
      // "Long-term potential" (user-requested 2026-08-24) — see
      // detectPossibleLongTermBottom's own docs for the real research
      // behind this and why it carries no ranking/confidence number.
      // Informational only, same discipline as quality/rotation — never a
      // vote on dir/score. Not financial advice.
      longTermPotential: (longTermBottomStatus && longTermBottomStatus[x.m.symbol]) || null,
      conf: { agree: side === 'long' ? x.c.bull : x.c.bear, total: x.c.total },
      drivers: side === 'long' ? x.c.longNotes : x.c.shortNotes,
      horizon,
      range: horizon ? predictedRange(x.m.price, horizon.days, score, dir, moveStats, x.m.symbol, x.m.volPct) : null,
      topIndicator: topIndicator(reliability, x.m.symbol),
      ...(x.m.val ? { val: { target: x.m.val.target, upside: x.m.val.upside, recKey: x.m.val.recKey, source: x.m.val.source } } : {}),
      ...(x.m.daysToEarnings != null ? { daysToEarnings: Math.round(x.m.daysToEarnings * 10) / 10 } : {}),
      ...(x.m.funding != null ? { funding: x.m.funding } : {}),
      ...(x.m.openInterest != null ? { openInterest: x.m.openInterest } : {}),
      ...(x.m.distHigh52w != null ? { distHigh52w: x.m.distHigh52w } : {}),
      ...(x.m.rank != null ? { mcapRank: x.m.rank } : {}),
      ...(x.m.volLookbackDays != null ? { volLookbackDays: x.m.volLookbackDays } : {}),
      ...(x.m.dailyMoves ? { dailyMoves: x.m.dailyMoves } : {}),
      ...(x.m.id ? { id: x.m.id } : {}) // CoinGecko coin id (crypto only) — lets the dashboard link out to a real coin page
    };
  };
  const sortSide = (side) => scored
    .slice()
    .sort((a, b) => (side === 'long' ? b.c.long - a.c.long : b.c.short - a.c.short)
      || (side === 'long' ? b.c.bull - a.c.bull : b.c.bear - a.c.bear))
    .slice(0, 10)
    .map(x => entry(x, side));
  // Pinned section, independent of top-10 rank on either board — see
  // FAVORITE_SYMBOLS' own docs. Each favorite shows on whichever side its
  // OWN current confluence actually leans (mirroring compositeCall's own
  // long-vs-short pick), reusing entry() directly rather than a second
  // row-building implementation. Crypto only (FAVORITE_SYMBOLS is an
  // all-crypto list); stocks always get an empty array so the dashboard
  // never has to branch on whether the key exists.
  const favorites = kind === 'crypto'
    ? scored
        .filter(x => FAVORITE_SYMBOLS.has(x.m.symbol))
        .map(x => entry(x, x.c.long >= x.c.short ? 'long' : 'short'))
    : [];
  // "Long-term potential" (user-requested 2026-08-24) — a pinned section
  // same as favorites above, independent of top-10 rank: a quiet asset
  // sitting near a fresh multi-month/year low may not have a strong
  // enough immediate confluence score to make breakout/breakdown at all,
  // but that's exactly the point of this list. Crypto only, same
  // reasoning as favorites (longTermBottomStatus is crypto-only).
  const longTermPotential = longTermBottomStatus
    ? scored
        .filter(x => longTermBottomStatus[x.m.symbol])
        .map(x => entry(x, x.c.long >= x.c.short ? 'long' : 'short'))
    : [];
  return { breakout: sortSide('long'), breakdown: sortSide('short'), universe: metrics.length, votesLog, priceLog, rangeLog, allSymbols, favorites, longTermPotential };
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
export async function buildPayload(env, reliability, reliabilityByHorizon, moveStats, rangeReliability, todStats, fundingHistory, sentimentMap, leadLagSignals, leaderReturns, swingTimeStats, recentEvents, tvlSeries, ivHistory, reliabilityByRegime, srLevels, srBreakStats, marketReturn, yieldSpreadChange, qualityData, rotationStatus, callFlipData, longTermBottomStatus, techniquePriors, comboReliability, directionBaselines, detailedCalibration, dailyRangeStats) {
  const started = Date.now();
  const nowIso = new Date().toISOString();
  const overrides = parseTrefisOverrides(env && env.TREFIS_OVERRIDES);

  const [cryptoR, globalR, fngR, trendR, fundR, stocksR, overviewR, valR, benchR, binR] = await Promise.allSettled([
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
    getAllValuations(STOCK_WATCHLIST),
    // Macro benchmarks (see BENCHMARK_SYMBOLS docs) — fetched by Yahoo
    // ticker, relabeled to the stable `symbol` name before use since the
    // two differ (e.g. yahoo 'DX-Y.NYB' -> symbol 'DXY').
    pool(BENCHMARK_SYMBOLS, 3, (b) => yahooDaily(b.yahoo, '6mo').then((r) => ({ ...r, symbol: b.symbol }))),
    binanceUsTradablePairs()
  ]);

  const trending = trendR.status === 'fulfilled' ? trendR.value : new Set();
  const funding = fundR.status === 'fulfilled' ? fundR.value : {};
  const binanceUsSymbols = binR.status === 'fulfilled' ? [...binR.value] : [];

  // Market-wide context, computed once and handed to every asset's
  // scoring (see the "reversal" technique): Fear & Greed for crypto, and
  // where VIX sits in its own recent range for equities (a fixed VIX level
  // means different things in calm vs turbulent years, so "elevated
  // relative to its own last month" is the meaningful read, not an
  // absolute threshold). Computed from data already being fetched for the
  // overview tiles — no extra calls.
  const idx = {};
  for (const settled of [overviewR, benchR]) {
    if (settled.status !== 'fulfilled') continue;
    for (const r of settled.value) {
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
  // Shared by both rankBoards calls below (crypto and stock) — see
  // evaluateTechniques' docs for why this is one object, not positional args.
  const qualityScores = computeQualityScores(qualityData || {});
  const ctx = { marketContext, reliabilityByHorizon, moveStats, todStats, nowIso, leadLagSignals, leaderReturns, swingTimeStats, recentEvents, tvlSeries, reliabilityByRegime, srLevels, srBreakStats, marketReturn, yieldSpreadChange, qualityScores, rotationStatus, callFlipData, longTermBottomStatus, techniquePriors, comboReliability, directionBaselines };

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
      .filter(c => !isStableValueAsset(c))
      .filter(c => FAVORITE_SYMBOLS.has((c.symbol || '').toUpperCase())
        || ((c.market_cap || 0) >= CRYPTO_MIN_MCAP && (c.total_volume || 0) >= CRYPTO_MIN_VOLUME));

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
        return buildCryptoMetrics(c, { funding: funding[sym], fundingHistory: fundingHistory && fundingHistory[sym], ivHistory: ivHistory && ivHistory[sym], sentimentScore: sentimentMap && sentimentMap[sym], trending: trending.has(sym), daily, benchCloses: btcCloses });
      })
      .filter(Boolean);
    cryptoBoards = rankBoards(metrics, 'crypto', reliability, ctx);
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
        const m = buildStockMetrics(r, valMap[r.symbol], overrides[r.symbol], spyCloses, ivHistory && ivHistory[r.symbol]);
        if (m) metrics.push(m);
      } else stockFailures.push(r && r._item);
    }
    stockBoards = rankBoards(metrics, 'stock', reliability, ctx);
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
  const { votesLog: cryptoVotes, priceLog: cryptoPrices, rangeLog: cryptoRanges, allSymbols: cryptoAll, ...cryptoPublicRaw } = cryptoBoards;
  const { votesLog: stockVotes, priceLog: stockPrices, rangeLog: stockRanges, allSymbols: stockAll, ...stockPublicRaw } = stockBoards;

  // Publish a class's directional calls only while its own measured record
  // clears its own no-skill baseline. The votes above are logged either way,
  // so a suppressed class keeps accumulating the evidence that would let it
  // back in. See assetClassSkill/abstainBoards.
  const cryptoSkill = assetClassSkill(detailedCalibration, directionBaselines, 'crypto');
  const stockSkill = assetClassSkill(detailedCalibration, directionBaselines, 'stock');
  const cryptoPublic = abstainBoards(cryptoPublicRaw, cryptoSkill);
  const stockPublic = abstainBoards(stockPublicRaw, stockSkill);
  const log = {
    generated_at: new Date().toISOString(),
    votes: [...(cryptoVotes || []), ...(stockVotes || [])],
    prices: [...(cryptoPrices || []), ...(stockPrices || [])],
    ranges: [...(cryptoRanges || []), ...(stockRanges || [])]
  };

  // Track record: which assets (either class) have DEMONSTRATED directional
  // skill — the Wilson lower bound on their matured directional accuracy
  // clears the measured no-skill baseline for their class. Full universe, not
  // just this hour's top 10 per side, since a strong record doesn't require
  // currently ranking.
  //
  // The bar used to be a pooled score above 95/100, which range containment
  // could carry on its own (see assetPredictionScore). Ranking is now by
  // lowerEdge — proven points above baseline — so an asset with a modest but
  // real edge outranks one with a flattering raw hit rate and no evidence.
  const enrichAll = (list, assetClass) => list.map((row) => ({ ...row, asset_class: assetClass, trackRecord: assetPredictionScore(row.symbol, reliability, rangeReliability, assetClass, directionBaselines) }));
  const cryptoUniverse = enrichAll(cryptoAll || [], 'crypto');
  const stockUniverse = enrichAll(stockAll || [], 'stock');
  const highAccuracyFor = (list) => list
    .map(({ symbol, name, price, horizon, range, id, trackRecord, asset_class }) => {
      const s = trackRecord;
      if (!s) return null;
      if (!s.proven) return null;
      return {
        symbol, name, asset_class,
        score: s.score, samples: s.samples,
        baseline: s.baseline, edge: s.edge, lowerEdge: s.lowerEdge,
        rangeContainment: s.range,
        price, horizon, range,
        ...(id ? { id } : {})
      };
    })
    .filter(Boolean);
  const highAccuracy = [
    ...highAccuracyFor(cryptoUniverse),
    ...highAccuracyFor(stockUniverse)
  ].sort((a, b) => b.lowerEdge - a.lowerEdge);
  log.signals = [...cryptoUniverse, ...stockUniverse].filter((r) => r.dir === 1 || r.dir === -1);

  const payload = {
    generated_at: log.generated_at,
    cache_seconds: CACHE_SECONDS,
    build_ms: Date.now() - started,
    model: 'confluence-v6 (32 techniques, directional agreement)',
    health: {
      coingecko: cryptoR.status === 'fulfilled',
      global: globalR.status === 'fulfilled' && !!globalR.value,
      fear_greed: fngR.status === 'fulfilled' && !!fngR.value,
      trending: trendR.status === 'fulfilled',
      funding: fundR.status === 'fulfilled',
      binance_us: binR.status === 'fulfilled' && binanceUsSymbols.length > 0,
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
      vix: idx['^VIX'] || null,
      dxy: idx['DXY'] || null,
      gold: idx['GOLD'] || null,
      oil: idx['OIL'] || null,
      ust2y: idx['UST2Y'] || null,
      ust10y: idx['UST10Y'] || null
    },
    crypto: cryptoPublic,
    stocks: stockPublic,
    // Per-class measured skill, so the dashboard can say WHY a class is or
    // isn't showing directional calls instead of silently rendering none.
    classSkill: { crypto: cryptoSkill, stock: stockSkill },
    highAccuracy,
    // Median/p80 daily range for the day-trading universe only (favorites plus
    // whatever has proven skill). Scoped rather than shipping all ~260 assets:
    // the read is only offered where it was asked for, and the payload is
    // already large. The Worker's cron divides today's move by these.
    dailyRange: (() => {
      if (!dailyRangeStats) return null;
      const syms = new Set([...FAVORITE_SYMBOLS, ...highAccuracy.map((r) => r.symbol)]);
      const out = {};
      for (const sym of syms) if (dailyRangeStats[sym]) out[sym] = dailyRangeStats[sym];
      return Object.keys(out).length ? out : null;
    })(),
    // Which crypto symbols /api/prices can live-tick from Binance.US
    // instead of CoinGecko (see binanceUsTradablePairs) — computed once
    // here per hourly build so the live-price route never needs its own
    // discovery call.
    binanceUsSymbols,
    sources: {
      crypto: 'CoinGecko (top 100 by market cap, daily history per coin) + trending list',
      derivatives: 'CoinGecko aggregated derivatives (funding rate + open interest, highest-OI perpetual market per asset)',
      sentiment: 'alternative.me Fear & Greed (full history archived) + VIX positioning + CoinGecko community votes; CoinMarketCap Fear & Greed and CryptoPanic news sentiment where configured',
      equities: 'Yahoo Finance daily OHLCV, Stooq fallback',
      valuation: 'Wall Street consensus targets via Yahoo; TREFIS_OVERRIDES env accepted',
      archive: 'Permanent daily-bar/funding/sentiment history (Yahoo full-depth + CoinGecko fallback) backs Fibonacci, time-of-day, and cross-asset lead/lag detection',
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

async function recordRefreshDispatchStatus(env, status) {
  try {
    await env.FCS_CACHE.put(REFRESH_DISPATCH_STATUS_KEY, JSON.stringify({
      at: new Date().toISOString(),
      ...status
    }), { expirationTtl: REFRESH_DISPATCH_STATUS_SECONDS });
  } catch (error) {
    console.error('Unable to record signals refresh dispatch status:', error.message);
  }
}

async function getRefreshDispatchStatus(env) {
  if (!env || !env.FCS_CACHE) return null;
  try {
    const raw = await env.FCS_CACHE.get(REFRESH_DISPATCH_STATUS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    console.error('Unable to read signals refresh dispatch status:', error.message);
    return null;
  }
}

// Overlays the cron-refreshed price layer onto a built payload without
// touching anything the heavy engine computed. Only price and chg24h are
// replaced (plus a recomputed rangePos where the build gave us the bounds to
// do it honestly) — scores, directions, techniques and ranges are products of
// the model run and must keep the timestamp they were actually computed at.
// Returns the payload unchanged when there is no live layer, so this can never
// make the response worse than it was.
export function mergeLivePrices(payload, live) {
  if (!payload || !live || (!live.crypto && !live.stocks)) return payload;
  const apply = (rows, table) => (Array.isArray(rows) ? rows.map((r) => {
    const tick = r && table && table[r.symbol];
    if (!tick || tick.price == null) return r;
    const out = { ...r, price: tick.price, price_at: live.generated_at };
    if (tick.chg24h != null) out.chg24h = tick.chg24h;
    // rangePos is a pure function of price against the build's own low/high,
    // so it can be kept honest at the new price. Anything needing recomputed
    // indicators is deliberately left alone.
    const b = r.rangeBounds;
    if (b && Number.isFinite(b.low) && Number.isFinite(b.high) && b.high > b.low) {
      out.rangePos = clamp((tick.price - b.low) / (b.high - b.low), 0, 1);
    }
    return out;
  }) : rows);
  const section = (sec, table) => {
    if (!sec || typeof sec !== 'object') return sec;
    const out = {};
    for (const [k, v] of Object.entries(sec)) out[k] = Array.isArray(v) ? apply(v, table) : v;
    return out;
  };
  return {
    ...payload,
    crypto: section(payload.crypto, live.crypto),
    stocks: section(payload.stocks, live.stocks),
    // The model layer's own age is unchanged and still reported by
    // generated_at; this says how fresh the numbers on screen actually are.
    prices_generated_at: live.generated_at
  };
}

// Attaches the day-trading range read to the served payload. Computed at serve
// time from the live price plus the cron-tracked session extremes, so it is as
// current as the price layer rather than as stale as the last heavy build.
export function attachDayRange(payload, live, session) {
  if (!payload || !payload.dailyRange || !session || !session.bySymbol) return payload;
  const rows = indexBoardRows(payload);
  const universe = dayTradingUniverse(payload);
  const out = {};
  for (const key of universe) {
    const [assetClass, symbol] = key.split('|');
    const liveTable = assetClass === 'crypto' ? (live && live.crypto) : (live && live.stocks);
    const tick = (liveTable && liveTable[symbol]) || (rows[key] ? { price: rows[key].price } : null);
    const price = tick && tick.price;
    if (!Number.isFinite(price)) continue;
    const sig = dayRangeSignal(symbol, price, session.bySymbol[key], payload.dailyRange, rows[key]);
    if (sig) out[key] = { ...sig, symbol, asset_class: assetClass };
  }
  if (!Object.keys(out).length) return payload;
  return { ...payload, dayRange: out, dayRange_session_date: session.date };
}

function isFresh(payload, nowMs = Date.now()) {
  if (!payload || !payload.generated_at) return false;
  return (nowMs - new Date(payload.generated_at).getTime()) < CACHE_SECONDS * 1000;
}

// Dispatches the existing GitHub Actions refresh workflow only after the
// serving payload is stale. The token is a Cloudflare Worker secret, never a
// client-facing variable; it needs only the repository's Actions write scope.
// A workflow input tells the build script to retain its normal freshness gate,
// so queued duplicate dispatches stay cheap no-ops rather than forced rebuilds.
export async function dispatchRefreshIfStale(env) {
  const cached = await getCached(env);
  if (isFresh(cached)) return false;
  if (!env || !env.FCS_CACHE) throw new Error('FCS_CACHE binding is required for stale-cache refresh dispatch');
  try {
    if (!env.GITHUB_ACTIONS_TOKEN) throw new Error('GITHUB_ACTIONS_TOKEN Worker secret is required to dispatch a stale signals refresh');
    const existingLock = await env.FCS_CACHE.get(REFRESH_DISPATCH_LOCK_KEY);
    if (existingLock) return false;
    await env.FCS_CACHE.put(REFRESH_DISPATCH_LOCK_KEY, new Date().toISOString(), { expirationTtl: REFRESH_DISPATCH_LOCK_SECONDS });
    const response = await fetch(GITHUB_REFRESH_DISPATCH_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GITHUB_ACTIONS_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ ref: 'main', inputs: { force: 'false' } })
    });
    if (!response.ok) {
      // Capture GitHub's own explanation, not just the status code. A bare
      // "HTTP 403" cost a whole round trip to diagnose: 403 covers a token
      // missing Actions:write, a fine-grained token that never had this repo
      // selected, an expired token, AND a secret that was set on the wrong
      // Worker (this account has both `frontier-capital-signals` and
      // `frontiercapitalsignals`, which differ only by hyphens). GitHub's body
      // distinguishes them; the status code alone does not.
      let detail = '';
      try {
        const body = await response.text();
        if (body) {
          const parsed = JSON.parse(body);
          detail = parsed && parsed.message ? ` — ${parsed.message}` : ` — ${body.slice(0, 200)}`;
        }
      } catch { /* body unavailable or not JSON; the status alone still gets reported */ }
      throw new Error(`GitHub signals refresh dispatch failed: HTTP ${response.status}${detail}`);
    }
    await recordRefreshDispatchStatus(env, { result: 'dispatched' });
  } catch (error) {
    // Previously this DELETED the lock, so a persistently failing dispatch
    // retried on literally every request — which is exactly what happened
    // while the token sat unscoped: a 403 per request, forever, with the
    // failure visible only to anyone who thought to read /api/refresh-status.
    // Hold a short cooldown instead: long enough to stop hammering GitHub,
    // far shorter than the success lock so real recovery is not blocked.
    try {
      await env.FCS_CACHE.put(REFRESH_DISPATCH_LOCK_KEY, new Date().toISOString(), { expirationTtl: REFRESH_DISPATCH_FAILURE_COOLDOWN_SECONDS });
    } catch (lockError) {
      console.error('Unable to set signals refresh dispatch cooldown:', lockError.message);
    }
    await recordRefreshDispatchStatus(env, { result: 'failed', error: error.message });
    throw error;
  }
  return true;
}

// Keeps the live price layer warm on the Cloudflare cron. Writes through the
// same KV key /api/prices serves from, so a visitor gets an already-fresh
// answer with no upstream call on the request path at all.
async function getSessionExtremes(env) {
  if (!env || !env.FCS_CACHE) return null;
  try {
    const raw = await env.FCS_CACHE.get(SESSION_EXTREMES_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function putSessionExtremes(env, value) {
  if (!env || !env.FCS_CACHE) return;
  try {
    await env.FCS_CACHE.put(SESSION_EXTREMES_KEY, JSON.stringify(value), { expirationTtl: SESSION_EXTREMES_TTL_SECONDS });
  } catch (error) {
    console.error('Unable to persist session extremes:', error.message);
  }
}

// Day-trading alerts are sent from the WORKER, not from scripts/notify.mjs.
// notify.mjs runs inside the hourly GitHub build, and GitHub delivered ~6 of
// 24 requested runs a day even after the cadence was cut — an entry alert that
// arrives hours late is worse than none. This path rides the Cloudflare cron
// that actually fires. Same ntfy topic, so it lands in the same channel.
export async function notifyDayRangeEntries(env, entries) {
  if (!env || !env.NTFY_TOPIC || !entries || !entries.length) return 0;
  let sent = 0;
  for (const e of entries) {
    const body = [
      `${e.symbol} (${e.assetClass === 'crypto' ? 'crypto' : 'equity'}) has travelled ${e.movePct >= 0 ? '+' : ''}${e.movePct.toFixed(2)}% today`,
      `(${Math.abs(e.moveInMedians).toFixed(2)}x its median daily range of ${e.medianPct.toFixed(2)}%).`,
      `Sitting at ${(e.posInDayRange * 100).toFixed(0)}% of today's range.`,
      `Candidate ${e.side.toUpperCase()} entry near ${e.price}.`,
      `Confirmations: ${e.reasons.join('; ')}.`,
      `A typical day is worth ~${e.medianAbs.toFixed(e.medianAbs < 1 ? 4 : 2)} at this price.`,
      'Mean-reversion candidate, not a scored prediction — this signal has no measured track record yet.'
    ].join(' ');
    try {
      const res = await fetch(`https://ntfy.sh/${env.NTFY_TOPIC}`, {
        method: 'POST',
        headers: {
          Title: `${e.symbol} stretched ${e.side === 'short' ? 'up' : 'down'} — candidate ${e.side}`,
          Priority: 'default',
          Tags: e.side === 'short' ? 'chart_with_downwards_trend' : 'chart_with_upwards_trend'
        },
        body
      });
      if (res.ok) sent++;
    } catch (error) {
      console.error('Day-range alert failed for', e.symbol, error.message);
    }
  }
  return sent;
}

// Which assets the day-trading read covers. Deliberately narrow, as the user
// scoped it: the always-tracked favorites plus whatever the engine has actually
// proven it can call. Running it across all ~260 assets would multiply the
// alert volume without improving any single entry.
export function dayTradingUniverse(payload) {
  // Emits "assetClass|symbol" keys. FAVORITE_SYMBOLS is a crypto-only list (see
  // its own docs), and highAccuracy rows carry their own asset_class.
  const keys = new Set();
  for (const sym of FAVORITE_SYMBOLS) keys.add(`crypto|${sym}`);
  for (const r of (payload && payload.highAccuracy) || []) {
    if (r && r.symbol && r.asset_class) keys.add(`${r.asset_class}|${r.symbol}`);
  }
  return keys;
}

export async function refreshLivePriceLayer(env) {
  try {
    const cached = await getCached(env);
    if (!cached) return false;
    const body = await buildLivePrices(env, cached);
    if (!body) return false;
    await putCachedLivePrices(env, body);

    // Accumulate today's high/low/open from this tick. This is the only
    // continuously-sampled input the day-trading read has, and it has to come
    // from here: asset_hourly_bars is current for 2 of the 7 favorites, and
    // intraday_price_ticks sits at ~8 samples/day because its GitHub cron is
    // being dropped.
    const nowIso = new Date().toISOString();
    const prevSession = await getSessionExtremes(env);
    const session = updateSessionExtremes(prevSession, body, nowIso);
    await putSessionExtremes(env, session);

    // Alert on newly-stretched assets. Runs here rather than in notify.mjs so
    // entry alerts ride the cron that actually fires.
    await dispatchDayRangeAlerts(env, cached, body, session);
    return true;
  } catch (error) {
    console.error('Live price layer refresh failed:', error.message);
    return false;
  }
}

// Builds the day-range read for the covered universe and fires an alert for any
// asset that has newly become a candidate entry this session.
export async function dispatchDayRangeAlerts(env, cached, prices, session) {
  if (!env || !env.NTFY_TOPIC) return 0;
  const rangeStats = cached && cached.dailyRange;
  if (!rangeStats) return 0;
  const universe = dayTradingUniverse(cached);
  const rowBySymbol = indexBoardRows(cached);

  let state = {};
  try {
    const raw = await env.FCS_CACHE.get(DAY_RANGE_ALERT_STATE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && parsed.date === session.date) state = parsed.fired || {};
  } catch { /* a lost state key costs at most one duplicate alert */ }

  const toSend = [];
  for (const uk of universe) {
    const [assetClass, symbol] = uk.split('|');
    const liveTable = assetClass === 'crypto' ? prices.crypto : prices.stocks;
    const tick = liveTable && liveTable[symbol];
    const price = tick && tick.price;
    if (!Number.isFinite(price)) continue;
    const sig = dayRangeSignal(symbol, price, session.bySymbol && session.bySymbol[uk], rangeStats, rowBySymbol[uk]);
    if (!sig || !sig.entry) continue;
    const key = `${uk}|${sig.entry.side}`;
    if (state[key]) continue;
    state[key] = nowSeconds();
    toSend.push({
      symbol, assetClass, price, side: sig.entry.side, reasons: sig.entry.reasons,
      movePct: sig.movePct, moveInMedians: sig.moveInMedians,
      medianPct: sig.medianPct, medianAbs: sig.medianAbs, posInDayRange: sig.posInDayRange
    });
  }
  if (!toSend.length) return 0;
  const sent = await notifyDayRangeEntries(env, toSend);
  try {
    await env.FCS_CACHE.put(DAY_RANGE_ALERT_STATE_KEY, JSON.stringify({ date: session.date, fired: state }), { expirationTtl: DAY_RANGE_ALERT_TTL_SECONDS });
  } catch (error) {
    console.error('Unable to persist day-range alert state:', error.message);
  }
  return sent;
}

function nowSeconds() { return Math.floor(Date.now() / 1000); }

// Flattens every board row in a payload into one symbol -> row map, so the
// day-range read can pick up RSI/volume/funding/range-position confirmations
// without knowing which board an asset happened to land on.
export function indexBoardRows(payload) {
  const out = {};
  for (const [assetClass, section] of [['crypto', payload && payload.crypto], ['stock', payload && payload.stocks]]) {
    if (!section || typeof section !== 'object') continue;
    for (const v of Object.values(section)) {
      if (!Array.isArray(v)) continue;
      // Keyed "assetClass|symbol": a bare ticker collides across classes (DASH
      // is both Dash and DoorDash) and the first-writer-wins map silently
      // handed one asset's indicators to the other.
      for (const r of v) {
        if (!r || !r.symbol) continue;
        const key = `${assetClass}|${r.symbol}`;
        if (!out[key]) out[key] = r;
      }
    }
  }
  return out;
}

function queueStaleCacheRefresh(env, ctx) {
  if (!ctx || typeof ctx.waitUntil !== 'function') return;
  ctx.waitUntil(dispatchRefreshIfStale(env).catch((error) => {
    console.error('Stale signals payload refresh dispatch failed:', error.message);
  }));
}

async function getCachedIntraday(env) {
  if (!env || !env.FCS_CACHE) return null;
  try {
    const raw = await env.FCS_CACHE.get(INTRADAY_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function isIntradayFresh(payload) {
  if (!payload || !payload.generated_at) return false;
  return (Date.now() - new Date(payload.generated_at).getTime()) < INTRADAY_FRESH_SECONDS * 1000;
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
<meta name="description" content="Hourly confluence screens across the top 100 cryptos and 61 US equities. Up to 32 techniques per asset must agree before a signal ranks.">
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
<link rel="alternate" type="application/rss+xml" title="Frontier Capital Signals — Alerts" href="/signals/api/feed">
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
  .wrap{max-width:1240px;margin:0 auto;padding:0 clamp(14px,2.4vw,20px)}

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
  .mast-links{display:flex;flex-wrap:wrap;gap:10px 14px;margin-bottom:14px}
  .home-link{display:inline-flex;align-items:center;color:var(--dim);font-family:var(--mono);font-size:11px;letter-spacing:.08em;text-transform:uppercase;text-decoration:none}
  .home-link:hover{color:var(--amber)}
  .masthead h1{font-weight:900;font-size:clamp(42px,7.2vw,94px);line-height:.94;letter-spacing:-.025em;text-transform:uppercase}
  .masthead h1 .amber{color:var(--amber)}
  .mast-grid{display:flex;flex-wrap:wrap;gap:28px;align-items:flex-end;justify-content:space-between}
  .dek{max-width:540px;color:var(--muted);font-size:13.5px;line-height:1.65;margin-top:18px}
  .dek b{color:var(--paper);font-weight:600}
  .mast-meta{font-family:var(--mono);font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--dim);text-align:right;line-height:2.1}
  .mast-meta b{color:var(--amber);font-weight:600}
  .mast-rule{height:2px;background:linear-gradient(90deg,var(--amber) 0,var(--amber) 180px,var(--line) 180px);margin-top:26px}

  .quicknav{display:flex;flex-wrap:wrap;gap:10px;border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:14px 0 0;margin:0 0 26px}
  .qnav-link{display:inline-flex;align-items:center;justify-content:center;padding:7px 10px;border:1px solid var(--line);border-radius:999px;color:var(--muted);font-family:var(--mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;text-decoration:none;background:rgba(16,24,40,.7)}
  .qnav-link:hover{color:var(--paper);border-color:rgba(255,178,36,.35);text-decoration:none}

  .xp-banner{background:rgba(255,178,36,.07);border:1px solid rgba(255,178,36,.35);border-left:3px solid var(--amber);padding:12px 16px;margin:22px 0;font-family:var(--mono);font-size:11.5px;line-height:1.7;color:var(--muted)}
  .xp-banner b{color:var(--amber);text-transform:uppercase;letter-spacing:.03em}

  .overview{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:1px;background:var(--line);border:1px solid var(--line);margin:26px 0 40px}
  .tile{background:var(--ink-1);padding:14px 14px 12px;min-width:0}
  .tile .lbl{font-family:var(--mono);font-size:9.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--dim);margin-bottom:7px}
  .tile .val{font-family:var(--mono);font-weight:600;font-size:clamp(15px,1.5vw,19px);color:var(--paper);white-space:nowrap}
  .tile .sub{font-family:var(--mono);font-size:11px;margin-top:4px}
  .up{color:var(--up)} .down{color:var(--down)} .flat{color:var(--muted)} .amber-t{color:var(--amber)}

  .boards{display:grid;grid-template-columns:1fr 1fr;gap:22px;margin-bottom:44px}
  .board{background:var(--ink-1);border:1px solid var(--line)}
  .board.long{border-top:2px solid var(--amber)}
  .board.short{border-top:2px solid var(--down)}
  .board.favorites{border-top:2px solid var(--up)}
  .board-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:16px 18px 12px;flex-wrap:wrap}
  .eyebrow{font-family:var(--mono);font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:var(--dim)}
  .board.long .eyebrow b{color:var(--amber);font-weight:600}
  .board.short .eyebrow b{color:var(--down);font-weight:600}
  .board.favorites .eyebrow b{color:var(--up);font-weight:600}
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
  .board.favorites .meter i.on{background:var(--up);box-shadow:0 0 5px rgba(61,220,151,.45)}
  .score{font-weight:600;min-width:24px;color:var(--paper)}
  .conf{font-size:9.5px;letter-spacing:.12em;color:var(--dim);text-transform:uppercase}
  .horizon{font-size:9.5px;letter-spacing:.06em;padding:1px 6px;border-radius:3px;border:1px solid var(--line);cursor:help}
  .horizon.hz-hist{color:var(--amber);border-color:rgba(255,178,36,.35)}
  .horizon.hz-meth{color:var(--dim)}
  .range{font-size:11px;cursor:help}
  .range.hz-hist{color:var(--amber)}
  .range.hz-meth{color:var(--muted)}
  .topind{display:block;color:var(--dim);font-size:10px;margin-top:3px;font-family:var(--disp);white-space:normal}
  .dir-arrow{font-size:11px;margin-left:5px;cursor:help}
  .dir-arrow.dir-up{color:var(--up)}
  .dir-arrow.dir-down{color:var(--down)}
  .coil{display:block;font-size:10px;letter-spacing:.04em;margin-top:3px;font-family:var(--disp);cursor:help}
  .coil.coil-up{color:var(--up)}
  .coil.coil-down{color:var(--down)}
  .quality{display:block;color:var(--dim);font-size:10px;margin-top:3px;font-family:var(--disp);cursor:help}
  .rotation{display:block;color:var(--amber);font-size:10px;letter-spacing:.04em;margin-top:3px;font-family:var(--disp);cursor:help;font-weight:600}
  .flip-note{display:block;color:var(--amber);font-size:10px;letter-spacing:.04em;margin-top:3px;font-family:var(--disp);cursor:help;font-weight:600}
  .ltp-note{display:block;color:var(--muted);font-size:10px;letter-spacing:.04em;margin-top:3px;font-family:var(--disp);cursor:help}

  .track-record{background:var(--ink-1);border:1px solid var(--line);border-top:2px solid var(--amber);margin-bottom:44px;padding:18px 18px 6px}
  .tr-title{font-weight:800;font-size:17px;letter-spacing:-.01em;margin-top:3px}
  .tr-empty{color:var(--muted);font-size:12.5px;line-height:1.75;max-width:760px;font-family:var(--mono);padding:2px 0 16px}
  .tr-list{display:flex;flex-direction:column;gap:1px;background:var(--line);margin-top:14px}
  .tr-row{display:flex;align-items:center;gap:14px;background:var(--ink-1);padding:10px 12px;font-family:var(--mono);font-size:12.5px;flex-wrap:wrap}
  .tr-asset{display:flex;align-items:baseline;gap:7px;min-width:150px}
  .tr-name{color:var(--muted);font-family:var(--disp);font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:140px}
  .tr-class{color:var(--dim);font-size:9.5px;letter-spacing:.1em;min-width:56px}
  .tr-price{color:var(--paper);min-width:70px}
  .tr-range-wrap{display:flex;align-items:center;gap:8px;flex:1;min-width:170px}
  .tr-score{color:var(--up);font-weight:700;min-width:48px;text-align:right}
  .tr-samples{color:var(--dim);font-size:10.5px;min-width:76px;text-align:right;white-space:nowrap}

  .intraday{background:var(--ink-1);border:1px solid var(--line);border-top:2px solid var(--up);margin:0 0 44px;padding:18px 18px 16px}
  .id-head{margin-bottom:14px}
  .id-empty{color:var(--muted);font-size:12.5px;line-height:1.75;max-width:760px;font-family:var(--mono);padding:2px 0 4px}
  .id-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:1px;background:var(--line);border:1px solid var(--line)}
  .id-card{background:var(--ink-1);padding:10px 12px;min-width:0}
  .id-sym{font-family:var(--mono);font-weight:700;font-size:12.5px;letter-spacing:.03em}
  .id-price{font-family:var(--mono);font-size:12px;color:var(--muted);margin-top:2px}
  .id-dir{font-size:20px;line-height:1;margin:6px 0 4px}
  .id-meta{display:flex;align-items:center;gap:5px;flex-wrap:wrap}
  .id-conf{font-family:var(--mono);font-size:10px;color:var(--dim)}
  .id-flag{font-family:var(--mono);font-size:9px;letter-spacing:.1em;padding:1px 5px;border-radius:3px;font-weight:700}
  .id-flag.id-peaked{color:var(--down);border:1px solid rgba(255,122,133,.35)}
  .id-flag.id-bottomed{color:var(--up);border:1px solid rgba(61,220,151,.35)}
  .id-track{margin-top:14px;font-family:var(--mono);font-size:11px;color:var(--muted);line-height:1.7}
  .id-track.dim{color:var(--dim)}
  .id-tr-item{margin-right:18px}

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

  @media (max-width:1080px){.overview{grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}}
  @media (max-width:980px){.boards{grid-template-columns:1fr}}
  @media (max-width:760px){
    .statusbar .wrap{height:auto;min-height:38px;padding-top:8px;padding-bottom:8px;gap:10px}
    .mast-grid{gap:18px}
    .mast-links{gap:8px 10px}
    .quicknav{gap:8px;padding-top:12px}
    .qnav-link{flex:1 1 calc(50% - 8px)}
    .board-head,.track-record,.intraday,.notice,summary,.method{padding-left:14px;padding-right:14px}
    .tr-row{align-items:flex-start}
    .tr-asset,.tr-range-wrap{min-width:0}
    table{font-size:12px}
    thead{display:none}
    .tbl-wrap{overflow:visible}
    tbody{display:grid;gap:10px;padding:12px}
    tbody tr{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 12px;padding:12px;border:1px solid var(--line);background:#121b2d}
    tbody td{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:0;border:0;white-space:normal;text-align:left}
    tbody td:nth-child(1),tbody td:nth-child(2){text-align:left}
    tbody td.rk{grid-column:1/-1;padding-top:0;color:var(--dim);font-size:10px}
    tbody td.asset{grid-column:1/-1;display:block}
    tbody td.sig-td{grid-column:1/-1}
    tbody td::before{content:attr(data-label);color:var(--dim);font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;flex:0 0 auto}
    tbody td.rk::before,tbody td.asset::before,tbody td.sig-td::before{display:none}
    .asset .nm{display:block;margin:2px 0 0}
    .asset .why{max-width:none}
    .sigcell{align-items:stretch}
    .sigrow{justify-content:space-between}
    .range{display:inline-block;text-align:right}
  }
  @media (max-width:620px){
    .masthead{padding:40px 0 26px}
    .mast-meta{text-align:left}
    .masthead h1{font-size:clamp(34px,13vw,54px)}
    .dek{font-size:12.5px}
    .overview{grid-template-columns:repeat(2,minmax(0,1fr))}
    .tile{padding:12px}
    .tile .val{white-space:normal}
    .id-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
    .id-card{padding:10px}
    .tr-row{gap:8px}
    .tr-price,.tr-score,.tr-samples,.tr-class{min-width:0;text-align:left}
    .day-range{margin:18px 0 8px;padding:14px 16px;border:1px solid var(--line);border-radius:10px;background:var(--panel)}
    .dr-title{font-weight:700;margin:2px 0 6px}
    .dr-note{font-size:12px;line-height:1.5;color:var(--muted);margin-bottom:10px}
    .dr-list{display:flex;flex-direction:column;gap:4px}
    .dr-row{display:grid;grid-template-columns:minmax(56px,.6fr) minmax(64px,.7fr) minmax(56px,.6fr) minmax(120px,1.2fr) minmax(84px,.9fr) minmax(104px,1fr) minmax(150px,1.6fr);gap:8px;align-items:baseline;padding:6px 8px;border-radius:6px;font-size:13px;overflow-x:auto}
    .dr-row.dr-up{background:color-mix(in srgb,var(--down) 12%,transparent)}
    .dr-row.dr-down{background:color-mix(in srgb,var(--up) 12%,transparent)}
    .dr-row.dr-quiet{opacity:.6}
    .dr-row.dr-dislocated{background:color-mix(in srgb,var(--amber) 14%,transparent)}
    .dr-cls{font-size:9px;font-weight:600;color:var(--muted);margin-left:4px;vertical-align:super}
    .dr-sym{font-weight:700}
    .dr-mult{font-variant-numeric:tabular-nums;font-weight:600}
    .dr-move,.dr-med,.dr-used,.dr-pos{font-variant-numeric:tabular-nums;color:var(--muted)}
    .dr-entry{font-weight:700;margin-right:6px}
    .dr-entry.dr-short{color:var(--down)}
    .dr-entry.dr-long{color:var(--up)}
    .dr-why{color:var(--muted);font-size:12px}
    @media(max-width:720px){.dr-row{grid-template-columns:1fr 1fr;row-gap:2px}}
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
        <div class="mast-links">
          <a class="home-link" href="https://frontiercapitalsignals.com/">← Frontier Capital Signals home</a>
          <a class="home-link rss-link" href="/signals/api/feed" title="Subscribe in any RSS reader for a persistent, browsable history of every alert — a complement to the ntfy push channel, which only shows what's live right now">📡 Alerts RSS feed</a>
        </div>
        <h1>Frontier Capital<br><span class="amber">Signals</span></h1>
        <p class="dek">Confluence screens across the <b>top 100 cryptos</b> and <b>61 US equities</b>. Up to <b>32 independent techniques</b> per asset, from RSI, MACD and Bollinger structure to funding-rate percentiles, open interest, Fibonacci retracements, time-of-day/day-of-week bias, intraday swing-timing, hack/exploit severity, market sentiment, options-implied volatility, earnings-calendar risk, key support/resistance breaks, accumulation/distribution, a broad-market composite, and a yield-curve read validated against the tracked history of every major breakout and breakdown, must point the <b>same direction</b> before a signal ranks — each with an <b>expected timeframe</b> learned from its own track record, and every technique weighted by how far it beats the measured no-skill baseline for its asset class rather than a nominal 50%. Prices, funding, and sentiment archive permanently for deep multi-year pattern analysis. <b>Analysis syncs hourly; price and 24h change tick live</b> in between.</p>
      </div>
      <div class="mast-meta">
        ANALYSIS REFRESH <b>HOURLY</b><br>
        PRICE TICKS <b>LIVE</b><br>
        UNIVERSE <b id="metaUniverse">—</b><br>
        TECHNIQUES PER ASSET <b>UP TO 32</b>
      </div>
    </div>
    <div class="mast-rule"></div>
  </header>

  <nav class="quicknav" aria-label="Quick navigation">
    <a class="qnav-link" href="#overview">Overview</a>
    <a class="qnav-link" href="#intraday">Intraday</a>
    <a class="qnav-link" href="#boards">Boards</a>
    <a class="qnav-link" href="#trackRecord">Track record</a>
    <a class="qnav-link" href="#methodology">Methodology</a>
  </nav>

  <div class="xp-banner" role="note">
    <b>Experimental research project — not financial advice.</b> Every score, range, timeframe, and the day-trading signal below are mechanical outputs from an ongoing, evolving model, not recommendations. Nothing here has been reviewed by a financial professional. Trading — especially with leverage — risks losing more than you put in. Do your own research and never rely on this page alone.
  </div>

  <section class="overview" id="overview" aria-label="Market overview">
  </section>

  <section class="intraday" id="intraday" aria-label="Day-trading intraday signal"></section>

  <div id="stateBox"></div>

  <main class="boards" id="boards">
  </main>

  <section class="track-record" id="trackRecord" aria-label="Prediction track record"></section>

  <details id="methodology">
    <summary>Methodology and data</summary>
    <div class="method">
      <p><b>The confluence model.</b> Every asset is evaluated by up to 32 independent techniques. Each one votes bullish, bearish, or neutral. The breakout score measures how much weighted evidence points up net of evidence pointing down; the breakdown score mirrors it. The small fraction under each score (for example 9/32) is the raw count of techniques agreeing with that direction out of those that had enough data to vote. High score plus high agreement is the strongest read.</p>
      <p><b>The 32 techniques.</b> Multi-horizon momentum alignment; Wilder RSI(14) regime and direction; MACD(12/26/9) histogram level and direction; moving-average stack (SMA20/50/200, computed from real daily bars for both equities and crypto); Bollinger %B with squeeze-and-expansion detection; stochastic (14,3) crosses; Donchian 20-bar breakout or breakdown proximity; volume confirmation versus baseline; on-balance volume trend; swing structure of higher-highs and higher-lows; a momentum divergence proxy that flags new price extremes without RSI support; a volatility regime read separating coiled compression from climactic expansion; a reversal-pattern read (below); how long an asset has been coiled at its own long-run high or low and whether it's decoupled from the broader market (below); a seasonal-analog read comparing the current pattern against the asset's own history one or more years back (below); a valuation-or-positioning layer, positioning now weighted by this asset's own funding-rate percentile once enough of its own history exists rather than a fixed global threshold; a Fibonacci retracement read off the asset's most recent swing, direction-aware and never firing without independent confirmation; open interest relative to this asset's own recent history, paired with price direction to separate real participation from a thin, untrusted move; a time-of-day and day-of-week behavioral profile (UTC, New York, London, and Tokyo session hours — which alone captures midnight ET and the NYSE's 9am/4pm hours — and day of week), learned per asset once a slot has real sample depth and a real effect size; market sentiment (Fear &amp; Greed for crypto, VIX's position in its own recent range for equities, pooled with per-asset community/news sentiment where available); a swing-timing read that separately learns what time of day this specific asset's own daily high or low tends to land, firing only when that proven timing pattern and the asset's current price position both confirm; a hack/exploit-severity read that turns a recent, matched security incident from a public hacks tracker into a bearish signal sized to the dollar loss relative to this asset's own market cap, decaying over roughly two weeks; a cross-asset and cross-sector lead/lag read that looks up whichever other assets or curated crypto-sector composites (DeFi, layer-1s, layer-2s, governance tokens, gaming/metaverse, meme, and other baskets) — in either asset class, including the dollar, gold, oil, and the 2-year/10-year Treasury yield spread — have proven, over the full historical archive, to predict this one's moves some number of days later; for crypto, sustained capital flowing into or out of a matched DeFi protocol's on-chain total value locked, paired with price direction before it fires; options-implied volatility (Deribit's DVOL for Bitcoin and Ether, the front-month options chain for equities) at an extreme relative to that asset's own history, a contrarian fear-or-euphoria read that only fires alongside a genuinely stretched price; for equities, an earnings-calendar awareness read that never votes a direction, only flags elevated gap risk and pulls down conviction accordingly, whenever a stock's next reported earnings date falls inside a call's own expected timeframe; a key support/resistance break read that only counts a level once price has reversed off it more than once, sized by how far this asset has historically moved in the 24 hours after that same kind of break; an accumulation/distribution read that looks for a genuinely coiled range — tightening Bollinger bands or realized volatility well under its own baseline, with price itself still flat — and asks which way on-balance volume is quietly leaning inside it, before that lean shows up in price at all; for crypto, a broad-market-outlier read that compares this asset's own 7-day move against the whole tracked crypto market's, voting only when the asset is genuinely decoupled — moving well beyond, or opposite to, what the market itself is doing — not when it's simply riding the same wave everything else is; and, for crypto, a yield-curve read: the one candidate, out of nineteen tested against the full historical record of every major crypto breakout and breakdown, that actually held up independently in both halves of that history — the 2-year/10-year Treasury spread moving more negative over the preceding five days measurably precedes a crypto breakdown, and only that direction, since the mirror case for breakouts did not hold up the same way.</p>
      <p><b>Reversal detection.</b> A separate read from plain RSI level: it looks for RSI having actually bottomed or topped over the last ~10 bars and turned back, confirmed by at least one independent signal (a stochastic cross, a Bollinger band extreme, swing structure, on-balance volume, or the divergence proxy) — it never fires on RSI alone. Market-wide sentiment adds confidence on top when it lines up: extreme fear on the Fear &amp; Greed index for a crypto bottom, or VIX sitting high in its own recent range for an equity bottom (and the mirror image — extreme greed or a complacent VIX — for tops).</p>
      <p><b>Dwell time and market correlation.</b> Real 52-week (or as much history as exists) highs and lows, and specifically how many days an asset has been sitting within a few percent of one, not just whether it currently is — a fresh one-day touch and a multi-week base at the same level are different setups. Long dwell at a low is read as stored energy for a bounce, the mirror at a high for a pullback, and it carries extra weight when the asset has also decoupled from its usual correlation with the broader market (BTC for crypto, SPY for equities) over the last 30 days, since a move happening on its own is a different setup than one just riding the market. This is a starting assumption, not a fixed rule — the adaptive weighting above corrects it per asset from what actually happens next.</p>
      <p><b>Seasonal analogs.</b> Where an asset has enough of its own history, the current pattern over the last ~90 days is compared against the same-length window roughly one, two, or more years back, using the same correlation math as the market-correlation read above but against the asset's own past. A real resemblance has to clear a fairly high bar (a correlation of at least 0.5) before it counts at all, since only a handful of candidate years exist to compare against and a looser bar would just be fitting noise. When one clears that bar, what happened in the days right after that historical analog becomes a genuine, data-grounded forward hint. In practice this only applies to equities: CoinGecko's free tier caps crypto history at 365 days, which isn't enough to compare against even one year back, so this abstains for every crypto asset rather than reaching for a shorter, less meaningful comparison.</p>
      <p><b>The valuation layer.</b> For equities, Wall Street consensus mean price targets and recommendation ratings: trading well below a buy-rated consensus target votes bullish, trading above the consensus target votes bearish. Trefis does not publish a public API, so consensus targets stand in for model-based estimates; site operators can supply Trefis or other model values through a server-side override, in which case the payload labels the source. For crypto, the layer uses perpetual futures funding rates (crowded positive funding on a parabolic move votes bearish, skeptical funding during an uptrend votes bullish) and trending-list crowding.</p>
      <p><b>Adaptive weighting.</b> Every hour's directional calls are logged and checked back against what the asset's price actually did 24 hours and 7 days later. Once a technique has enough scored history for a specific asset, its weight for that asset going forward is nudged up if it has been reliably right and down if it has been reliably wrong, capped at plus or minus 50%. A technique that is only a coin flip for a given asset keeps its plain baseline weight.</p>
      <p><b>Leading vs. lagging, and the expected timeframe.</b> Techniques are split into two kinds. Leading techniques try to anticipate a move before it's confirmed: RSI, Bollinger squeeze, stochastic crosses, OBV, the divergence proxy, the volatility regime read, reversal-pattern detection, the valuation/positioning layer, trending-list crowding, how long an asset has dwelled at its own extreme, the seasonal-analog read, Fibonacci retracement, the time-of-day/day-of-week read, the swing-timing read, sentiment, the hack/exploit-severity read, the cross-asset and cross-sector lead/lag read, on-chain TVL trend, options-implied volatility, the earnings-calendar risk flag, the accumulation/distribution read, the broad-market-outlier read, and the yield-curve read. Lagging (confirming) techniques describe a move already underway: momentum alignment, MACD, the moving-average stack, Donchian breakout proximity, volume confirmation, swing structure, open interest, and the support/resistance break read. This is a methodology classification, not the last word for a given asset — where enough of that asset's own history exists, its measured accuracy at each horizon (below) is the real, asset-specific answer to which of its own signals actually lead versus lag, which can and does differ from this general table. The small window shown next to each score (for example <b>1-3 days</b>) is this engine's estimate of when that specific call is expected to resolve, built from whichever techniques are actually voting on that asset right now. Where an asset has enough of its own scored history, the window uses that asset's real measured accuracy at the 24-hour versus 7-day mark (marked with a check and shown in amber) instead of a generic estimate — the same historical record the adaptive weighting above draws on, just answering "how soon" instead of "how much weight." Without enough history yet, it falls back to a weighted average of the active techniques' typical horizons (shown in gray) — an informed estimate, not a measurement.</p>
      <p><b>Expected range.</b> The Range column is a band around the current price, not a point prediction, for the same timeframe as the horizon chip next to it. Its width comes from real volatility: this asset's own historical realized move size at that horizon once evaluateMatured has scored enough of its own outcomes (amber, marked historical), or its recent realized daily volatility scaled by the square root of time otherwise (gray, marked methodology) — the standard random-walk approximation for "how far a price plausibly wanders in N days." The band's center only shifts toward the called direction once the score shows real conviction, and the shift is capped well inside the band, so a weak score gives a wide, roughly symmetric range rather than a false point estimate.</p>
      <p><b>How far back the methodology-basis range looks.</b> The gray (methodology) band isn't measured over a single fixed number of days for every asset — it's calibrated per asset. Several candidate lookback windows (10, 20, 30, 60, and 90 days) are backtested against that asset's own price history every hour: for each candidate, the tool checks whether the volatility estimate it would have produced at many past points actually matched what happened next, and keeps whichever window comes closest to correctly sized (hovering your cursor over a gray band shows which one won). A too-short lookback whipsaws on noise; a too-long one smooths over a real shift in how much an asset has started moving. This is a fast, within-run check using history already being fetched — distinct from, and much quicker to react than, the slower live-outcome learning loop described above — so it needs a real backtest sample to trust (an asset too young for that, common at crypto's 365-day history cap, just keeps the plain 30-day default).</p>
      <p><b>Which indicator this asset leans on.</b> "Leans on X (n%)" under an asset's name names whichever technique has, on its own, the strongest individually-proven track record for that specific asset — some assets really are better predicted by one kind of signal than another, and this surfaces that once a technique has enough of its own scored history to say so, using the same adaptive-weighting data above.</p>
      <p><b>Prediction-score track record (95%+ list).</b> Below the boards, a running scorecard pools three kinds of matured, falsifiable calls per asset: whether its overall composite call (not any single technique) pointed the right direction by the horizon's end; whether the predicted price range actually contained the real price at maturity; and whether its pivot-style calls (the reversal and dwell techniques above) panned out. Every matured outcome across those three counts as one equally-weighted vote rather than a hand-picked blend — a made-up weighting scheme would just be a different kind of guess — so the score is simply correct-calls divided by total-calls, out of 100. An asset only appears once it has a reasonable number of matured predictions behind it (the same minimum-sample bar used everywhere else in this engine); below that, it's left off the list rather than shown with a noisy, overconfident number. This is a track record of this engine's own past calls, not a forecast that the streak continues. Each listed asset also shows its current price and a predicted range for its own next call — the same horizon-and-range machinery every board row uses, so the period covered varies asset to asset (whatever that asset's own active techniques and history currently point to, typically on the order of a day to a few weeks) rather than one fixed window applied to everyone. All of this is still built from daily price bars, not intraday data, so the shortest period this engine can honestly speak to is about a day, not hours.</p>
      <p><b>Data.</b> CoinGecko free API for the top 100 coins by market cap with real daily price and volume history per coin, plus global stats and trending (stablecoins and wrappers excluded), alternative.me Fear &amp; Greed, Bybit linear perp funding rates, Yahoo Finance daily OHLCV with Stooq CSV fallback, and Yahoo analyst estimates. Free feeds can lag or drop symbols; the feeds counter in the status bar shows current coverage, and any technique without data simply abstains rather than guessing.</p>
      <p><b>Refresh mechanics.</b> A scheduled job rebuilds the full payload — scores, ranges, horizons, every technique call — hourly and writes it to this page's cache; every visit reads that cache, so the page itself never runs the engine. This page also re-checks every 10 minutes so a new hour's data appears without a reload. Price and 24-hour change are the one exception: this page separately polls a lightweight endpoint roughly every 20 seconds for a live tick, straight from CoinGecko and Yahoo, without touching the hourly analysis — so the number in the Price column can move between rebuilds, but the score, range, and every technique read next to it stay fixed until the next hourly rebuild.</p>
      <p><b>What the scores are not.</b> A score of 70 with 10/16 agreement is a strong mechanical setup, not a 70% probability; the timeframe next to it is an estimate of when the setup should resolve, not a guarantee it will; and the range is a plausible band from real volatility, not a target price. The model has no knowledge of token unlocks, earnings dates, lawsuits, or macro events.</p>
    </div>
  </details>

  <footer>
    <p class="legal">Frontier Capital Signals is an experimental, ongoing research project — an informational tool, not a finished or audited product. Nothing on this page is investment advice, a recommendation, or a solicitation to buy or sell any asset. Scores are mechanical indicator composites with no knowledge of news, fundamentals beyond analyst consensus, token unlocks or earnings. The day-trading intraday signal is a further experimental layer on top of that, back-tested and continuously re-scored against its own real-world outcomes rather than a proven method; its paper-trading track record is a transparency readout of the model's own simulated performance, never a projection of real returns. Crypto and equity markets involve substantial risk of loss, and leveraged trading specifically can lose more than the amount put in. Data is provided by third-party feeds without warranty and may be delayed or incomplete. Do your own research, and do not treat any output on this page as a substitute for professional financial advice.</p>
    <div class="cols">
      <span>© <span id="yr"></span> Frontier Capital Signals</span>
      <span>Data: CoinGecko · alternative.me · Bybit · Yahoo Finance / Stooq</span>
      <span>Model: confluence-v6</span>
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
  var INTRADAY_URL = BASE + 'api/intraday';

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

  // Day-trading intraday signal: a separate, much-higher-frequency read
  // than everything above (see /api/intraday's own docs) — its own render
  // function and its own poll loop (loadIntraday/INTRADAY_MS below) so a
  // missed or slow intraday tick never blocks or disturbs the main
  // hourly-cadence dashboard.
  function dirArrow(dir){ return dir===1?'▲':dir===-1?'▼':'●'; }
  function dirCls(dir){ return dir===1?'up':dir===-1?'down':'flat'; }
  function renderIntraday(d){
    var el=$('intraday');
    if(!el) return;
    if(!d||!d.watchlist||!d.watchlist.length){
      el.innerHTML='<div class="eyebrow">DAY-TRADING SIGNAL</div><div class="id-empty">Intraday signals are still warming up — the first tick history needs to accumulate before a call can be made.</div>';
      return;
    }
    var head='<div class="id-head"><div><div class="eyebrow">DAY-TRADING SIGNAL</div><div class="board-title">Intraday direction, refreshed every few minutes</div></div></div>';
    var cards=d.watchlist.map(function(w){
      var flag = w.peaked?'<span class="id-flag id-peaked">PEAKED</span>':w.bottomed?'<span class="id-flag id-bottomed">BOTTOMED</span>':'';
      var horizonTitle = w.basis==='historical'
        ? "This asset's own measured accuracy at this horizon"
        : "Not enough of this asset's own history yet to measure — shortest horizon shown as a default, not a claim";
      var horizon='<span class="horizon '+(w.basis==='historical'?'hz-hist':'hz-meth')+'" title="'+horizonTitle+'">'+esc(w.horizonLabel)+(w.basis==='historical'?' ✓':'')+'</span>';
      var conf = w.confidence!=null ? '<span class="id-conf">'+Math.round(w.confidence*100)+'%</span>' : '';
      return '<div class="id-card" data-symbol="'+esc(w.symbol)+'" data-class="'+esc(w.assetClass)+'">'
        +'<div class="id-sym">'+esc(w.symbol)+'</div>'
        +'<div class="id-price">'+fmtPrice(w.price)+'</div>'
        +'<div class="id-dir '+dirCls(w.dir)+'">'+dirArrow(w.dir)+'</div>'
        +'<div class="id-meta">'+horizon+conf+flag+'</div>'
        +'</div>';
    }).join('');
    var tr=d.trackRecord||{};
    var trLine=['crypto','stock'].map(function(cls){
      var t=tr[cls];
      if(!t||!t.total) return '';
      var label=cls==='crypto'?'CRYPTO':'EQUITY';
      var avg=t.avgReturnPct==null?'—':((t.avgReturnPct>=0?'+':'')+t.avgReturnPct.toFixed(1)+'%');
      return '<span class="id-tr-item">'+label+' self-experiment: '+t.wins+'W&ndash;'+t.losses+'L ('+Math.round((t.winRate||0)*100)+'%), '+t.total+' closed, avg '+avg+' return</span>';
    }).filter(Boolean).join(' &middot; ');
    var trBlock = trLine
      ? '<div class="id-track">'+trLine+'</div>'
      : '<div class="id-track dim">No paper trades have closed yet &mdash; the self-experiment track record fills in as signals mature.</div>';
    el.innerHTML=head+'<div class="id-grid">'+cards+'</div>'+trBlock;
  }
  function loadIntraday(){
    fetch(INTRADAY_URL,{cache:'no-store'})
      .then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
      .then(function(d){ if(d&&!d.error) renderIntraday(d); })
      .catch(function(){ /* silent: a missed intraday tick isn't a feed error, same reasoning as updateLivePrices */ });
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
    var h='<section class="board '+cfg.side+'" id="'+cfg.boardId+'" aria-label="'+cfg.title+'">';
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
        var rowSide = r.dir===-1 ? 'short' : 'long'; // per-row, not cfg.side — the favorites board mixes both
        var symHtml = url
          ? '<a class="sym-link" target="_blank" rel="noopener noreferrer" href="'+url+'" data-symbol="'+esc(r.symbol)+'" data-class="'+cfg.assetClass+'" data-side="'+rowSide+'" data-rank="'+(i+1)+'" data-score="'+r.score+'"><span class="sym">'+esc(r.symbol)+'</span></a>'
          : '<span class="sym">'+esc(r.symbol)+'</span>';
        var name = r.name && r.name!==r.symbol ? '<span class="nm">'+esc(r.name)+'</span>' : '';
        var why = (r.drivers&&r.drivers.length)?'<span class="why">'+esc(r.drivers.join(' · '))+'</span>':'';
        var topInd = r.topIndicator ? '<span class="topind" title="Best individually-proven indicator for '+esc(r.symbol)+' so far, out of '+r.topIndicator.total+' scored calls">Leans on '+esc(r.topIndicator.id)+' ('+Math.round(r.topIndicator.accuracy*100)+'%)</span>' : '';
        var coil = (r.consolidating===1||r.consolidating===-1)
          ? '<span class="coil '+(r.consolidating===1?'coil-up':'coil-down')+'" title="Coiled range detected (tightening Bollinger bands or realized volatility well under baseline) with on-balance volume already leaning '+(r.consolidating===1?'up':'down')+', ahead of price confirming it">⏳ Consolidating '+(r.consolidating===1?'↑':'↓')+'</span>'
          : '';
        var quality = r.quality
          ? '<span class="quality" title="Utility/community percentile vs. every other tracked coin with data today (GitHub commits + PR contributors, Telegram/Reddit reach, CoinGecko watchlist users) -- informational only, never part of the score above">Quality '+r.quality.score+'/100</span>'
          : '';
        var rotation = r.rotation
          ? '<span class="rotation" title="Sustained outperformance vs. the broad crypto market since '+r.rotation.startDate+' -- '+r.rotation.checkpoints+' consecutive monthly checkpoints, peak +'+Math.round(r.rotation.peakRel)+'pts relative strength. The Solana-2021-style pattern -- informational only, never part of the score above">⬆️ Rotating in</span>'
          : '';
        var flipNote = '';
        if(r.recentFlip){
          var flipMs = Date.now() - new Date(r.recentFlip.flipRunAt).getTime();
          var flipAgo = flipMs < 3600000 ? Math.max(1,Math.round(flipMs/60000))+'m' : Math.round(flipMs/3600000)+'h';
          var flipArrow = (r.recentFlip.fromDir===1?'▲':'▼')+'→'+(r.recentFlip.toDir===1?'▲':'▼');
          var stabTitle = r.flipStability
            ? " This asset's past flips held "+Math.round(r.flipStability.heldRate*100)+"% of the time and reverted "+Math.round(r.flipStability.revertedRate*100)+"% of the time, over "+r.flipStability.n+" evaluated flips."
            : " Not enough of this asset's own past flips have matured yet to say whether they tend to hold or revert.";
          flipNote = '<span class="flip-note" title="Call reversed direction '+flipAgo+' ago -- treat with extra caution until it either holds or reverts.'+stabTitle+'">⚠️ Flipped '+flipArrow+' '+flipAgo+' ago</span>';
        }
        var ltpNote = '';
        if(r.longTermPotential){
          var ltp = r.longTermPotential;
          ltpNote = '<span class="ltp-note" title="Currently near a fresh multi-month/year low ('+ltp.daysSinceLow+' days since the low, '+ltp.pctAboveLow.toFixed(0)+'% above it). Historically, a genuine isolated low like this has gone on to 10x or more within about 3 years roughly 38% of the time (56 of 146 real cases studied) -- but no tested signal reliably predicts WHICH specific ones will. This is descriptive history only, not a prediction for this asset, not guaranteed, and not financial advice.">💎 Long-term potential ('+ltp.daysSinceLow+'d since low)</span>';
        }
        var moves = r.dailyMoves;
        var moveNote = moves
          ? '<span class="move-note" title="Computed from the archived daily bars for this asset ('+moves.samples+' daily moves).">1d '+(moves.highestGain.pct>=0?'+':'')+moves.highestGain.pct.toFixed(1)+'% ('+fmtPrice(moves.highestGain.dollar)+') '+esc(moves.highestGain.date||'')+' · low '+moves.highestLoss.pct.toFixed(1)+'% ('+fmtPrice(moves.highestLoss.dollar)+') '+esc(moves.highestLoss.date||'')+' · median |move| '+moves.medianAbsPct.toFixed(2)+'%</span>'
          : '';
        var dirArrow = '<span class="dir-arrow '+(rowSide==='long'?'dir-up':'dir-down')+'" title="'+(rowSide==='long'?'Leaning up':'Leaning down')+'">'+(rowSide==='long'?'▲':'▼')+'</span>';
        var conf = r.conf ? '<span class="conf">'+r.conf.agree+'/'+r.conf.total+' aligned</span>' : '';
        var horizon = r.horizon ? '<span class="horizon '+(r.horizon.basis==='historical'?'hz-hist':'hz-meth')+'" title="'+(r.horizon.basis==='historical'?"Based on this asset's own historical accuracy by horizon":"Methodology estimate, not yet enough of this asset's own history to say")+'">'+esc(r.horizon.label)+(r.horizon.basis==='historical'?' ✓':'')+'</span>' : '';
        var rangeTitle = r.range && r.range.basis==='historical'
          ? "Band width from this asset's own historical move size at this horizon"
          : "Band width estimated from this asset's recent realized volatility, scaled to the horizon"+(r.volLookbackDays?" (a "+r.volLookbackDays+"-day lookback, calibrated to this asset)":"");
        var range = r.range ? '<span class="range '+(r.range.basis==='historical'?'hz-hist':'hz-meth')+'" title="'+rangeTitle+'">'+fmtPrice(r.range.low)+'–'+fmtPrice(r.range.high)+'</span>' : '<span class="dim">—</span>';
        h+='<tr class="in" style="animation-delay:'+(i*30)+'ms" data-symbol="'+esc(r.symbol)+'" data-class="'+cfg.assetClass+'">'
          +'<td class="rk">#'+(i+1)+'</td>'
          +'<td class="asset">'+symHtml+name+why+topInd+coil+quality+rotation+flipNote+ltpNote+moveNote+'</td>'
          +'<td class="live-price-cell" data-label="Price"><span class="live-price">'+fmtPrice(r.price)+'</span></td>'
          +'<td class="live-chg-cell '+pctCls(r.chg24h)+'" data-label="24h"><span class="live-chg">'+fmtPct(r.chg24h)+'</span></td>'
          +'<td class="'+pctCls(r.chg7d)+'" data-label="7d">'+fmtPct(r.chg7d)+'</td>'
          +'<td class="'+rsiCls(r.rsi)+'" data-label="RSI">'+(r.rsi!=null?r.rsi.toFixed(0):'—')+'</td>'
          +'<td data-label="Range">'+range+'</td>'
          +'<td class="sig-td" data-label="Signal"><span class="sigcell"><span class="sigrow">'+meter(r.score)+'<span class="score">'+r.score+'</span>'+dirArrow+'</span>'+conf+horizon+'</span></td>'
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
    if(d.crypto.favorites && d.crypto.favorites.length){
      b+=boardHtml({side:'favorites', assetClass:'crypto', boardId:'crypto-favorites', eyebrow:'CRYPTO · <b>FAVORITES</b>', title:'Always tracked'}, d.crypto.favorites, d.crypto.favorites.length);
    }
    if(d.crypto.longTermPotential && d.crypto.longTermPotential.length){
      b+='<div class="xp-banner" role="note"><b>Not a recommendation, not guaranteed, not financial advice.</b> Long-term candidates are descriptive historical lows only; no tested signal reliably predicts which specific asset will recover.</div>';
      b+=boardHtml({side:'favorites', assetClass:'crypto', boardId:'crypto-ltp', eyebrow:'CRYPTO · <b>LONG-TERM POTENTIAL</b>', title:'Possible multi-month/year lows'}, d.crypto.longTermPotential, d.crypto.longTermPotential.length);
    }
    if(d.stocks.longTermPotential && d.stocks.longTermPotential.length){
      b+='<div class="xp-banner" role="note"><b>Historical context only.</b> These equities are near a fresh long-term low; the list is not a recovery forecast or recommendation.</div>';
      b+=boardHtml({side:'favorites', assetClass:'stock', boardId:'stock-ltp', eyebrow:'EQUITIES · <b>LONG-TERM POTENTIAL</b>', title:'Possible multi-month/year lows'}, d.stocks.longTermPotential, d.stocks.longTermPotential.length);
    }
    b+=boardHtml({side:'long', assetClass:'crypto', boardId:'crypto-long', eyebrow:'CRYPTO · <b>LONG SIDE</b>', title:'Breakout watch'}, d.crypto.breakout, d.crypto.universe);
    b+=boardHtml({side:'short', assetClass:'crypto', boardId:'crypto-short', eyebrow:'CRYPTO · <b>RISK SIDE</b>', title:'Breakdown risk'}, d.crypto.breakdown, d.crypto.universe);
    // A class whose measured record does not clear its own no-skill baseline
    // has its directional calls withheld (see assetClassSkill/abstainBoards).
    // Say so plainly rather than letting a board of dir-less rows read as a
    // rendering bug — and show the numbers behind the decision, since "we are
    // not showing you calls" needs more justification than showing them did.
    // Day-trading range read, above the boards: the "has it moved enough
    // today?" answer the boards themselves don't give.
    var dr = d.dayRange || {};
    var drSyms = Object.keys(dr);
    if(drSyms.length){
      var order = { 'extended-up': 0, 'extended-down': 0, 'dislocated': 1, 'normal': 2, 'quiet': 3 };
      drSyms.sort(function(a,b){
        var oa = order[dr[a].state] != null ? order[dr[a].state] : 3;
        var ob = order[dr[b].state] != null ? order[dr[b].state] : 3;
        if(oa !== ob) return oa - ob;
        return Math.abs(dr[b].moveInMedians||0) - Math.abs(dr[a].moveInMedians||0);
      });
      var drRows = drSyms.map(function(sym){
        var x = dr[sym];
        var cls = x.state === 'extended-up' ? 'dr-up' : x.state === 'extended-down' ? 'dr-down' : x.state === 'quiet' ? 'dr-quiet' : x.state === 'dislocated' ? 'dr-dislocated' : '';
        var entry = x.entry
          ? '<span class="dr-entry dr-'+x.entry.side+'">candidate '+x.entry.side.toUpperCase()+'</span>'
            +'<span class="dr-why">'+esc(x.entry.reasons.join(' · '))+'</span>'
          : x.state === 'dislocated'
            ? '<span class="dr-why">move too large to fade &mdash; treated as a dislocation or bad data, not an entry</span>'
            : '<span class="dim">—</span>';
        var moveTxt = (x.movePct>=0?'+':'')+x.movePct.toFixed(2)+'%';
        var medTxt = x.medianPct.toFixed(2)+'%';
        return '<div class="dr-row '+cls+'">'
          +'<span class="dr-sym">'+esc(x.symbol||sym)+(x.asset_class==='stock'?'<span class="dr-cls">EQ</span>':'')+'</span>'
          +'<span class="dr-move" title="Move from this session&#39;s first observed price">'+moveTxt+'</span>'
          +'<span class="dr-mult" title="Today&#39;s directional move divided by this asset&#39;s median daily high&minus;low range">'
            +(x.moveInMedians!=null?(x.moveInMedians>=0?'+':'')+x.moveInMedians.toFixed(2)+'x':'—')+'</span>'
          +'<span class="dr-med" title="Median daily high&minus;low over '+x.samples+' days, and what that is worth at the current price">'
            +medTxt+' ('+fmtPrice(x.medianAbs)+')</span>'
          +'<span class="dr-used" title="How much of a normal day&#39;s full range today has already travelled">'
            +(x.usedPct!=null?Math.round(x.usedPct)+'% used':'—')+'</span>'
          +'<span class="dr-pos" title="Where the price sits inside today&#39;s own range">'
            +Math.round(x.posInDayRange*100)+'% of day range</span>'
          +'<span class="dr-act">'+entry+'</span>'
          +'</div>';
      }).join('');
      b+='<section class="day-range" id="dayRange" aria-label="Daily range exhaustion">'
        +'<div class="eyebrow">DAY RANGE</div>'
        +'<div class="dr-title">How much of a normal day has already moved</div>'
        +'<div class="dr-note">Median daily range is this asset&#39;s own median high&minus;low over the last 90 days. '
        +'&ldquo;Extended&rdquo; means today&#39;s one-way move already exceeds 80% of its complete daily ranges, and the price is sitting near the day&#39;s extreme. '
        +'Session extremes are tracked from this page&#39;s own 5-minute price ticks, so they start at the first tick after 00:00 UTC. '
        +'<b>These are mean-reversion candidates with no scored track record yet</b> &mdash; they are shown with their evidence, not as predictions.</div>'
        +'<div class="dr-list">'+drRows+'</div></section>';
    }

    var cs = d.classSkill || {};
    if(cs.stock && !cs.stock.proven){
      b+='<div class="xp-banner" role="note"><b>Equity direction calls are withheld.</b> '
        +'Over '+cs.stock.samples+' matured predictions this engine scored '+(100*cs.stock.accuracy).toFixed(1)+'% on US equities, against '+(100*cs.stock.baseline).toFixed(1)+'% for simply guessing the same direction every time — an edge of '+(100*cs.stock.edge).toFixed(1)+' points. '
        +'Rankings, prices and ranges below are still real; the direction is not shown because it has not earned it. Equity calls keep being scored in the background and return automatically once they clear the baseline.</div>';
    }
    b+=boardHtml({side:'long', assetClass:'stock', boardId:'stock-long', eyebrow:'US EQUITIES · <b>LONG SIDE</b>', title:'Breakout watch'}, d.stocks.breakout, d.stocks.universe);
    b+=boardHtml({side:'short', assetClass:'stock', boardId:'stock-short', eyebrow:'US EQUITIES · <b>RISK SIDE</b>', title:'Breakdown risk'}, d.stocks.breakdown, d.stocks.universe);
    $('boards').innerHTML=b;
  }

  function renderTrackRecord(d){
    var list = d.highAccuracy||[];
    var head = '<div><div class="eyebrow">TRACK RECORD</div><div class="tr-title">Proven edge over guessing</div></div>';
    var el = $('trackRecord');
    if(!list.length){
      el.innerHTML = head + '<div class="tr-empty">No asset has yet demonstrated a directional edge over its own baseline. This list used to rank by a raw hit rate that pooled price-range containment in with directional calls — but a range band is built to contain the price, so containment carried the average and assets appeared here on the strength of it. An asset now qualifies only when the lower bound on its directional accuracy clears what constant guessing would have scored in its asset class, which is a much harder and more honest bar. Empty because not enough has matured to prove it, not because nothing works.</div>';
      return;
    }
    var rows = list.map(function(r){
      var url = assetUrl(r.asset_class, r);
      var symHtml = url
        ? '<a class="sym-link" target="_blank" rel="noopener noreferrer" href="'+url+'"><span class="sym">'+esc(r.symbol)+'</span></a>'
        : '<span class="sym">'+esc(r.symbol)+'</span>';
      var rangeHtml = r.range
        ? '<span class="range '+(r.range.basis==='historical'?'hz-hist':'hz-meth')+'" title="'+(r.range.basis==='historical'?"Band from this asset's own historical move size at this horizon":"Band from recent realized volatility, scaled to the horizon")+'">'+fmtPrice(r.range.low)+'–'+fmtPrice(r.range.high)+'</span>'
        : '<span class="dim">—</span>';
      var horizonHtml = r.horizon ? '<span class="horizon '+(r.horizon.basis==='historical'?'hz-hist':'hz-meth')+'">'+esc(r.horizon.label)+'</span>' : '';
      return '<div class="tr-row">'
        +'<span class="tr-asset">'+symHtml+'<span class="tr-name">'+esc(r.name||'')+'</span></span>'
        +'<span class="tr-class">'+(r.asset_class==='crypto'?'CRYPTO':'EQUITY')+'</span>'
        +'<span class="tr-price">'+fmtPrice(r.price)+'</span>'
        +'<span class="tr-range-wrap">'+rangeHtml+horizonHtml+'</span>'
        +'<span class="tr-score" title="'+r.score+'% directional accuracy against a '+r.baseline+'% no-skill baseline for this asset class'+(r.rangeContainment?'; price-range containment '+r.rangeContainment.containment+'% over '+r.rangeContainment.samples+' bands, reported separately and never pooled into this figure':'')+'">+'+r.lowerEdge+' pts</span>'
        +'<span class="tr-samples">'+r.samples+' calls</span>'
        +'</div>';
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
    // Two different clocks, and collapsing them into one badge was misleading:
    // prices are refreshed by the Worker's own Cloudflare cron every few
    // minutes, while the learned model layer only moves when the heavy build
    // runs. A dashboard showing minutes-old prices was being labelled STALE
    // purely because the model behind them was hours old.
    var pt = d.prices_generated_at ? new Date(d.prices_generated_at) : null;
    var priceAgeM = pt ? (Date.now()-pt.getTime())/6e4 : null;
    var pricesFresh = priceAgeM != null && priceAgeM < 15;
    var modelStale = ageH > 2;
    $('sysState').textContent = pricesFresh ? (modelStale ? 'LIVE PRICES' : 'LIVE') : (modelStale ? 'STALE' : 'LIVE');
    $('sysDot').style.background = (!pricesFresh && modelStale) ? 'var(--down)' : 'var(--amber)';
    $('metaUniverse').textContent = (d.crypto.universe||0)+' + '+(d.stocks.universe||0);
    var fmtAge = function(h){ return h < 1 ? Math.round(h*60)+' min' : h.toFixed(1)+' h'; };
    $('stateBox').innerHTML = !modelStale ? ''
      : (pricesFresh
        ? '<div class="notice"><b>Prices are live; the model layer is '+fmtAge(ageH)+' old.</b> '
          +'Prices, changes and range positions were refreshed '+Math.round(priceAgeM)+' min ago. '
          +'Scores, directions and technique weights are from the last full engine run at '+t.toUTCString()+' and will update on the next one.</div>'
        : '<div class="notice"><b>Feed is stale.</b> Showing the last successful sync from '+t.toUTCString()+'. The engine rebuilds on the next request once upstream sources respond.</div>');
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
  var INTRADAY_MS = 60*1000;
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
  loadIntraday();
  setTimeout(updateLivePrices, 2000); // small delay so the boards exist to patch into
  var methodologyEl=document.querySelector('details');
  if(methodologyEl) methodologyEl.addEventListener('toggle',function(){
    if(methodologyEl.open) pushEvent('signals_methodology_open',{});
  });
  setInterval(load, REFETCH_MS);
  setInterval(updateLivePrices, LIVE_MS);
  setInterval(loadIntraday, INTRADAY_MS);
})();
</script>
</body>
</html>
`;

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin'
};

// Best-effort per-IP rate limiter for /api/asset/:symbol specifically —
// scoped to only this route (never /api/signals or /api/prices, which
// real visitor traffic depends on: the dashboard polls /api/prices every
// 20s and /api/signals every 10min — confirmed live in this file's own
// client JS, REFETCH_MS/LIVE_MS below). This route runs 3 real D1 queries
// per call with no caching layer of its own, unlike those two.
//
// CONFIRMED LIVE this does NOT reliably work: 30 truly concurrent requests
// against the deployed Worker all returned 200, none blocked — Cloudflare
// spreads concurrent (and even rapid sequential) requests across multiple
// isolates/data centers, and this in-memory Map only ever sees whatever
// fraction landed on one isolate. Left in as harmless, marginal defense-in-
// depth (it does catch a slow, sustained single-isolate sequence), NOT as
// the real protection. The actual fix is a zone-level Cloudflare Rate
// Limiting rule (Security > WAF > Rate limiting rules), scoped to
// /signals/api/asset/* specifically so it can never touch the two routes
// live traffic actually needs — that's the one that correctly coordinates
// counts across Cloudflare's whole network instead of per-isolate.
// Threshold kept generous (well above the ~10-20/session a human clicking
// through several assets would ever generate, since nothing in the
// dashboard even calls this route yet) so future features that use it
// more have headroom without needing a re-tune.
const RATE_LIMIT_MAX = 40;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_TRACKED_IPS = 5000; // opportunistic cap so a distributed flood can't grow this unboundedly within one long-lived isolate
let assetRouteHits = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  if (assetRouteHits.size > RATE_LIMIT_MAX_TRACKED_IPS) assetRouteHits = new Map(); // cheap reset rather than per-entry pruning
  const rec = assetRouteHits.get(ip);
  if (!rec || now - rec.windowStart > RATE_LIMIT_WINDOW_MS) {
    assetRouteHits.set(ip, { count: 1, windowStart: now });
    return false;
  }
  rec.count++;
  return rec.count > RATE_LIMIT_MAX;
}

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

// XML 1.0's five predefined entities — everything the RSS feed route
// (/api/feed) needs to escape in title/description/link text pulled
// straight from notification_log, which can contain any of these
// (a description like `SYMBOL: "Some & Co." hacked -- $1.2M`).
function xmlEscape(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

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

// Live price/24h-change tick for whatever the current payload displays,
// extracted from the /api/prices route so the Cloudflare cron can keep this
// layer warm on its OWN schedule instead of only refreshing when a request
// happens to arrive.
//
// This is the half of the dashboard that has to be timely. The heavy engine
// (~130 fetches, ~260 assets, 32 techniques, ~10 minutes) runs in GitHub
// Actions, whose scheduler drops firings under load — measured on this repo,
// a 5-minute cron delivered 2 of 288 requested runs in a day and the worst
// observed gap between refreshes was 686 minutes. Cloudflare's cron does not
// have that problem, so prices, changes and range positions are refreshed here
// on a trigger that actually fires, and only the slow-moving learned layer
// (technique weights, calibration, reliability) waits on the heavy build.
export async function buildLivePrices(env, cached) {
  if (!cached) return null;
  const cryptoRows = [...((cached.crypto && cached.crypto.breakout) || []), ...((cached.crypto && cached.crypto.breakdown) || [])];
  const stockRows = [...((cached.stocks && cached.stocks.breakout) || []), ...((cached.stocks && cached.stocks.breakdown) || [])];
  const cryptoIdToSymbol = new Map(cryptoRows.filter(r => r.id).map(r => [r.id, r.symbol]));
  const stockSymbols = [...new Set(stockRows.map(r => r.symbol))];

  // Split the crypto live-tick load across two independent providers
  // (see binanceUsTradablePairs' docs) instead of sending every
  // displayed symbol to CoinGecko alone: whichever symbols have a
  // confirmed-tradable Binance.US USDT pair (computed once at build
  // time, cached_provider list travels in the KV payload) go there;
  // everything else — mostly longer-tail alts Binance.US doesn't list
  // — still goes to CoinGecko, just a smaller batch than before.
  const binanceUsSet = new Set(cached.binanceUsSymbols || []);
  const binanceSymbols = [...cryptoIdToSymbol.values()].filter(s => binanceUsSet.has(s));
  const geckoIds = [...cryptoIdToSymbol.entries()].filter(([, s]) => !binanceUsSet.has(s)).map(([id]) => id);

  const [cryptoPricesById, binancePrices, stockResults] = await Promise.all([
    coingeckoSimplePrice(geckoIds).catch(() => ({})),
    binanceUsTicker24hr(binanceSymbols).catch(() => ({})),
    pool(stockSymbols, 10, (s) => yahooQuote(s))
  ]);

  const crypto = {};
  for (const [id, symbol] of cryptoIdToSymbol) {
    if (binanceUsSet.has(symbol)) {
      if (binancePrices[symbol]) crypto[symbol] = binancePrices[symbol];
    } else if (cryptoPricesById[id]) {
      crypto[symbol] = cryptoPricesById[id];
    }
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

  return { crypto, stocks, generated_at: new Date().toISOString() };
}

// --------------------- DAY-TRADING RANGE EXHAUSTION -------------------------
// User-requested 2026-08-30: "tell me the asset has gone up or down enough for
// the day so I can short or long it."
//
// The yardstick is the asset's own median daily range (high - low), from
// asset_daily_range — a 3% move is noise for an asset that routinely travels
// 8% in a session and a big day for one that usually travels 1.5%, so a fixed
// percentage threshold would be meaningless across a 100-asset universe.
//
// Extension is measured against p80 of that distribution, not a multiple of the
// median: "today's move in ONE direction is already larger than 80% of this
// asset's COMPLETE daily ranges" is a statement about the asset's own realized
// behaviour, where "1.5x the median" would just be an arbitrary constant.
//
// Honesty about what this is: a mean-reversion premise. The one thing this
// engine has actually measured nearby (the intraday backtest, 2 years of
// Binance data) found a real but modest ~54-56% reversal tilt conditional on
// the market having moved — genuine, not dramatic. So these are surfaced as
// candidate entries with their evidence attached, never as predictions, and
// they carry `proven: false` until the logging below has scored enough of them
// to say otherwise. Do not let this graduate to an actionable call on the
// strength of the idea alone.
const DAY_RANGE_MIN_SAMPLES = 20;
const DAY_RANGE_POS_BAR = 0.75;      // must also be sitting near the day's extreme
const DAY_RANGE_QUIET_FRACTION = 0.4; // below 40% of a normal day = nothing to fade yet
const DAY_RANGE_MIN_MEDIAN_PCT = 0.25;  // mirrors MIN_MEANINGFUL_MEDIAN_RANGE_PCT in archive.mjs
// Above this multiple of a normal day, do not offer a fade. Two separate
// reasons, and both point the same way: a move this size is usually a data
// artifact (a bad tick, a mismatched session open, two assets sharing a
// ticker), and on the occasions it is real it is a dislocation — a hack, a
// depeg, a delisting — which is precisely the thing you must not mean-revert
// into. Real dislocations already have their own alerts (checkAndNotifyHacks /
// checkAndNotifySuddenMoves); this read deliberately stays out of their way.
const DAY_RANGE_MAX_PLAUSIBLE_MEDIANS = 8;

// Confirmation, so a stretched reading never fires alone — the same discipline
// every other technique in this engine follows. Each is independently
// meaningful at an extreme, and only their presence is claimed, not their
// weight.
export function dayRangeConfirmations(row, side) {
  const out = [];
  if (!row) return out;
  const rsi = row.rsi;
  if (side === 'short' && rsi != null && rsi >= 70) out.push(`RSI ${rsi.toFixed(0)} overbought`);
  if (side === 'long' && rsi != null && rsi <= 30) out.push(`RSI ${rsi.toFixed(0)} oversold`);
  if (row.volRatio != null && row.volRatio >= 1.5) out.push(`volume ${row.volRatio.toFixed(1)}x average`);
  const f = row.funding && Number.isFinite(row.funding.rate) ? row.funding.rate : null;
  if (side === 'short' && f != null && f > 0.0005) out.push(`funding ${(f * 100).toFixed(3)}% — longs crowded`);
  if (side === 'long' && f != null && f < -0.0005) out.push(`funding ${(f * 100).toFixed(3)}% — shorts crowded`);
  if (side === 'short' && row.rangePos != null && row.rangePos >= 0.95) out.push('at the top of its 1-year range');
  if (side === 'long' && row.rangePos != null && row.rangePos <= 0.05) out.push('at the bottom of its 1-year range');
  return out;
}

// session: { open, high, low } tracked live by the Worker's own cron (see
// updateSessionExtremes) — deliberately NOT from asset_hourly_bars, which only
// has current data for 2 of the 7 favorites, nor from intraday_price_ticks,
// which the dropped GitHub cron left at ~8 samples/day.
export function dayRangeSignal(symbol, price, session, rangeStats, row) {
  const stats = rangeStats && rangeStats[symbol];
  if (!stats || !Number.isFinite(stats.medianPct) || stats.samples < DAY_RANGE_MIN_SAMPLES) return null;
  // A near-zero median is never a usable denominator: it makes every move look
  // infinitely extended and every division produce null or Infinity.
  // computeDailyRangeStats already filters these out at the source (stablecoins
  // and sub-cent precision artifacts); this is the second line of defence so a
  // stale or hand-edited row cannot turn into a stream of false entry alerts.
  if (stats.medianPct < DAY_RANGE_MIN_MEDIAN_PCT) return null;
  if (!session || !Number.isFinite(session.open) || !session.open) return null;
  if (!Number.isFinite(price) || price <= 0) return null;

  const high = Math.max(session.high ?? price, price);
  const low = Math.min(session.low ?? price, price);
  const rangePct = ((high - low) / session.open) * 100;
  const movePct = ((price - session.open) / session.open) * 100;
  const usedPct = stats.medianPct > 0 ? (rangePct / stats.medianPct) * 100 : null;
  const moveInMedians = stats.medianPct > 0 ? movePct / stats.medianPct : null;
  const posInDayRange = high > low ? clamp((price - low) / (high - low), 0, 1) : 0.5;

  const bar = Number.isFinite(stats.p80Pct) && stats.p80Pct > 0 ? stats.p80Pct : stats.medianPct;
  let state = 'normal';
  if (movePct >= bar) state = 'extended-up';
  else if (movePct <= -bar) state = 'extended-down';
  else if (usedPct != null && usedPct < DAY_RANGE_QUIET_FRACTION * 100) state = 'quiet';

  // Implausible or dislocation-sized: report the numbers, offer no entry.
  const beyondPlausible = moveInMedians != null && Math.abs(moveInMedians) > DAY_RANGE_MAX_PLAUSIBLE_MEDIANS;
  if (beyondPlausible) state = 'dislocated';

  let entry = null;
  if (beyondPlausible) entry = null;
  else if (state === 'extended-up' && posInDayRange >= DAY_RANGE_POS_BAR) {
    const reasons = dayRangeConfirmations(row, 'short');
    entry = reasons.length ? { side: 'short', reasons, proven: false } : null;
  } else if (state === 'extended-down' && posInDayRange <= 1 - DAY_RANGE_POS_BAR) {
    const reasons = dayRangeConfirmations(row, 'long');
    entry = reasons.length ? { side: 'long', reasons, proven: false } : null;
  }

  return {
    medianPct: stats.medianPct,
    p80Pct: stats.p80Pct,
    samples: stats.samples,
    // What a normal day is worth in price terms at the CURRENT price — the
    // form that is actually usable for sizing a stop or a target.
    medianAbs: price * stats.medianPct / 100,
    open: session.open, high, low,
    rangePct, usedPct, movePct, moveInMedians, posInDayRange,
    state, entry
  };
}

// Running session high/low/open per symbol, accumulated from the Worker's own
// 5-minute price ticks and kept in KV. Self-sufficient by design: this is the
// one part of the day-trading read that has to be continuously sampled, and
// every GitHub-driven source for it is unreliable here.
//
// Rolls at UTC midnight. A symbol first seen mid-session gets that first tick
// as its open, which is honest (we genuinely do not know where it opened) and
// self-corrects at the next roll.
export function updateSessionExtremes(prev, prices, nowIso) {
  const date = nowIso.slice(0, 10);
  const base = prev && prev.date === date && prev.bySymbol ? prev.bySymbol : {};
  // Carry every symbol already tracked today forward, THEN merge this tick in.
  // Rebuilding from only the current tick would drop any symbol the live fetch
  // happened to miss — and it does miss them routinely (CoinGecko rate limits,
  // a thin/renamed id, a Yahoo hiccup; see buildLivePrices' own fallback). That
  // would silently reset the day's accumulated high/low, which is the one piece
  // of state here that cannot be recovered after the fact.
  const next = { ...base };
  // Keyed "assetClass|symbol", never the bare ticker. A ticker is not unique
  // across asset classes — DASH is Dash the crypto AND DoorDash the equity, and
  // both arrive in the same tick. Keying by symbol alone merged them into one
  // synthetic asset whose session ran from $237 down to $41, produced a -82%
  // "move", and fired a candidate LONG on a stock that had not moved.
  const merge = (table, assetClass) => {
    for (const [symbol, tick] of Object.entries(table || {})) {
      const price = tick && tick.price;
      if (!Number.isFinite(price) || price <= 0) continue;
      const key = `${assetClass}|${symbol}`;
      const cur = next[key];
      next[key] = cur
        ? { open: cur.open, high: Math.max(cur.high, price), low: Math.min(cur.low, price), last: price }
        : { open: price, high: price, low: price, last: price };
    }
  };
  merge(prices && prices.crypto, 'crypto');
  merge(prices && prices.stocks, 'stock');
  return { date, updated_at: nowIso, bySymbol: next };
}

// ----------------------------- WORKER ENTRY ---------------------------------

export default {
  // Cloudflare's cron is the one scheduler in this system that actually fires
  // on time, so it now owns the freshness that users see, rather than only
  // forwarding a request to GitHub Actions and hoping.
  //
  // Two independent jobs, deliberately not chained: refreshing the live price
  // layer must not be skipped just because a GitHub dispatch failed (which it
  // did, silently, with HTTP 403 for as long as the token stayed unscoped).
  scheduled(_controller, env, ctx) {
    ctx.waitUntil(refreshLivePriceLayer(env));
    ctx.waitUntil(dispatchRefreshIfStale(env).catch((error) => {
      console.error('Stale signals payload refresh dispatch failed:', error.message);
    }));
  },

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
        const fresh = isFresh(cached);
        if (!fresh) queueStaleCacheRefresh(env, ctx);
        // Overlay the cron-refreshed price layer. The learned layer (weights,
        // calibration, technique votes) is only as current as the last heavy
        // build, but there is no reason to also show a stale PRICE next to it
        // when a 5-minutes-old one is sitting in KV. Both timestamps travel
        // with the payload so the dashboard can say which half is which
        // instead of flattening it to one "STALE" badge.
        const live = await getCachedLivePrices(env);
        const session = await getSessionExtremes(env);
        const merged = attachDayRange(mergeLivePrices(cached, live), live, session);
        return json(merged, {
          'X-FCS-Cache': fresh ? 'hit' : 'stale',
          'X-FCS-Prices': live ? 'live' : 'build'
        });
      }
      return json({ error: 'signals not yet built — waiting on the first scheduled build to populate the cache' }, { 'X-FCS-Cache': 'empty' });
    }

    if (path === '/api/refresh-status' || path === 'api/refresh-status') {
      const status = await getRefreshDispatchStatus(env);
      return json(status || { result: 'unknown', message: 'No stale-cache dispatch has been recorded in the last 24 hours.' }, { 'Cache-Control': 'no-store' });
    }

    // Day-trading intraday read: single KV read, same "Worker only ever
    // serves a pre-computed payload" shape as /api/signals above, just a
    // separate pipeline/key (scripts/intraday-tick.mjs, its own 5-minute
    // cron) with a much shorter expected freshness window. Deliberately
    // no leverage, liquidation price, or position-size figures in this
    // payload — see scripts/intraday.mjs's paper-trading section for why.
    if (path === '/api/intraday' || path === 'api/intraday') {
      const cached = await getCachedIntraday(env);
      if (cached) {
        return json(cached, { 'X-FCS-Cache': isIntradayFresh(cached) ? 'hit' : 'stale' });
      }
      return json({ error: 'intraday signals not yet built — waiting on the first tick to populate the cache' }, { 'X-FCS-Cache': 'empty' });
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

      const body = await buildLivePrices(env, cached);
      ctx.waitUntil(putCachedLivePrices(env, body));
      return json(body, { 'Cache-Control': 'no-store', 'X-FCS-Live-Cache': 'miss' });
    }

    // Per-asset accuracy drill-down: every technique's measured accuracy
    // for one symbol (not just the single best one the main payload shows
    // via topIndicator), plus its range-prediction hit rate and score
    // history. A deliberate, narrow exception to "the Worker only ever
    // reads KV" (see buildPayload's docs) — that rule exists to keep the
    // *heavy engine* (~130 fetches + indicator math across ~260 assets)
    // off the Worker, not to ban D1 outright. An occasional single-symbol
    // read is trivial by comparison and stays well inside Workers Free
    // plan's per-request limits regardless of which plan is active.
    // RSS feed of every notification actually sent (reversal/peak-bottom,
    // confident-move, hack, sudden-move, consolidation — see scripts/notify.mjs) — user-requested
    // 2026-08-24, "a sort of rss feed on the side for the news and
    // notifications," a persistent, browsable/subscribable complement to
    // the ntfy push channel (which is momentary — nothing to look back
    // through once a notification's gone). Same narrow D1-read exception
    // as /api/asset/ above, same rate limiting.
    if (path === '/api/feed' || path === 'api/feed' || path === '/api/feed.xml' || path === 'api/feed.xml') {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      if (isRateLimited(ip)) {
        return new Response('rate limited, try again shortly', { status: 429, headers: { 'Retry-After': '60', ...SECURITY_HEADERS } });
      }
      if (!env.FCS_DB) return new Response('feed not available (D1 not bound)', { status: 503, headers: SECURITY_HEADERS });
      try {
        const rows = await env.FCS_DB.prepare('SELECT kind, symbol, title, message, click_url, sent_at FROM notification_log ORDER BY sent_at DESC LIMIT 100').all();
        const items = (rows.results || []).map((r) => {
          const link = r.click_url || 'https://frontiercapitalsignals.com/signals/';
          return `<item>
      <title>${xmlEscape(r.title)}</title>
      <link>${xmlEscape(link)}</link>
      <description>${xmlEscape(r.message)}</description>
      <category>${xmlEscape(r.kind)}</category>
      <pubDate>${new Date(r.sent_at).toUTCString()}</pubDate>
      <guid isPermaLink="false">fcs-${xmlEscape(r.kind)}-${xmlEscape(r.symbol)}-${xmlEscape(r.sent_at)}</guid>
    </item>`;
        }).join('\n    ');
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Frontier Capital Signals — Alerts</title>
    <link>https://frontiercapitalsignals.com/signals/</link>
    <description>Peak/bottom signals, confident move alerts, hack alerts, sudden-move alerts, and consolidation alerts from the FCS confluence engine.</description>
    <language>en-us</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    ${items}
  </channel>
</rss>`;
        return new Response(xml, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8', 'Cache-Control': 'public, max-age=300', ...SECURITY_HEADERS } });
      } catch (e) {
        return new Response('feed query failed: ' + String((e && e.message) || e), { status: 500, headers: SECURITY_HEADERS });
      }
    }

    if (path.startsWith('/api/asset/') || path.startsWith('api/asset/')) {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      if (isRateLimited(ip)) {
        return new Response(JSON.stringify({ error: 'rate limited, try again shortly' }), {
          status: 429,
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '60', ...SECURITY_HEADERS }
        });
      }
      const raw = path.slice(path.indexOf('asset/') + 'asset/'.length);
      const symbol = decodeURIComponent(raw).toUpperCase();
      if (!symbol) return json({ error: 'symbol required' });
      if (!env.FCS_DB) return json({ error: 'per-asset detail not available (D1 not bound)' });
      try {
        const [techRows, rangeRows, snapRows] = await Promise.all([
          env.FCS_DB.prepare('SELECT technique_id, horizon_hours, correct, total, accuracy FROM technique_reliability WHERE symbol = ?').bind(symbol).all(),
          env.FCS_DB.prepare('SELECT horizon_hours, hits, total, accuracy FROM range_reliability WHERE symbol = ?').bind(symbol).all(),
          env.FCS_DB.prepare('SELECT snapshot_date, score, samples FROM asset_score_snapshots WHERE symbol = ? ORDER BY snapshot_date DESC LIMIT 90').bind(symbol).all()
        ]);
        const techniques = (techRows.results || []).map((r) => ({
          id: r.technique_id, horizonHours: r.horizon_hours, correct: r.correct, total: r.total, accuracy: r.accuracy,
          leading: TECHNIQUE_META[r.technique_id] ? TECHNIQUE_META[r.technique_id].leading : null
        }));
        const range = (rangeRows.results || []).map((r) => ({ horizonHours: r.horizon_hours, hits: r.hits, total: r.total, accuracy: r.accuracy }));
        const scoreHistory = (snapRows.results || []).map((r) => ({ date: r.snapshot_date, score: r.score, samples: r.samples }));
        // Simple drift flag: trailing-30-snapshot score vs. all-time —
        // enough of a trend line to notice a regime change, not a
        // full statistical test.
        let drift = null;
        if (scoreHistory.length >= 2) {
          const recent = scoreHistory.slice(0, Math.min(30, scoreHistory.length));
          const recentAvg = recent.reduce((a, r) => a + r.score, 0) / recent.length;
          const allTimeAvg = scoreHistory.reduce((a, r) => a + r.score, 0) / scoreHistory.length;
          drift = Math.round(recentAvg - allTimeAvg);
        }
        return json({ symbol, techniques, range, scoreHistory, drift }, { 'Cache-Control': 'public, max-age=300' });
      } catch (e) {
        return json({ error: 'per-asset query failed', detail: String((e && e.message) || e) });
      }
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
