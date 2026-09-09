// Automatic retrospective — "what moved, and why didn't we call it?"
//
// User-requested 2026-08-31. The prompt was a specific miss ("arb and a
// couple of cryptos jumped in the past couple of hours, examine that to
// figure out what you missed so we can catch it with them or other coins
// next time") plus the generalisation that matters more: "these sort of
// retrospective examination/analysis should be built in the module so it
// can be done automatically for learning and continuous improvement."
//
// This is that job. Every run it asks three questions, in order:
//
//   1. What actually moved?  Answered from a WIDER scan than the engine's
//      own universe (CRYPTO_UNIVERSE = top 100). That widening is the
//      whole point: on the day this was written, six of the eight biggest
//      movers — OP, CRV, SAFE, PONS, JASMY and CASHCAT — sat below rank
//      100 and were therefore not merely mis-scored but never fetched at
//      all. A retrospective built on the engine's own universe would have
//      reported a clean sheet, which is precisely the blind spot that let
//      the miss happen.
//
//   2. Was it detectable in advance?  Answered from Binance GLOBAL hourly
//      bars (see BINANCE_GLOBAL_BASE in worker.js) via
//      describeMissedMove — the earliest hour where quote volume AND
//      trade count had both lifted clear of their trailing medians into
//      a rising bar.
//
//   3. What did the engine say at the time?  Answered from the score
//      snapshot the hourly build already writes, so the classification
//      (see classifyMiss) reflects the engine's real state before the
//      move, not a reconstruction after it.
//
// The output is deliberately structured, countable rows rather than
// commentary: retrospective_misses for the individual episodes, and
// retrospective_patterns for the aggregate that says which CAUSE
// dominates. One missed move is an anecdote; "62% of last month's misses
// were out-of-universe" is an instruction about what to fix.
//
// Read-mostly and cheap: one wide CoinGecko page-pair, then Binance global
// klines only for assets that actually moved, so a quiet day costs almost
// nothing.
//
// Required env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID
// Optional env: NTFY_TOPIC (summary push), RETRO_LOOKBACK_HOURS, RETRO_MIN_MOVE_PCT,
// RETRO_FAVORITE_BASELINE_MIN_SAMPLES, RETRO_FAVORITE_BASELINE_LOOKBACK_DAYS,
// RETRO_FEATURE_MAX_AGE_HOURS, RETRO_FEATURE_MIN_INDEPENDENT_DATES,
// RETRO_LEAD_LAG_MAX_STALENESS_HOURS, RETRO_LEAD_LAG_MIN_RUN_ASSETS,
// RETRO_LEAD_LAG_HISTORY_DAYS, RETRO_LEAD_LAG_MIN_DISCOVERY_DATES,
// RETRO_LEAD_LAG_MIN_HOLDOUT_DATES, RETRO_LEAD_LAG_MIN_OOS_DATES
// Invoked by .github/workflows/signals-retrospective.yml.
import { pathToFileURL } from 'node:url';
import { d1, chunk, forEachConcurrent } from './d1-client.mjs';
import {
  binanceGlobalKlines, binanceGlobalTradablePairs, describeMissedMove, classifyMiss,
  isNonDirectionalAsset, COINGECKO_BACKOFFS_MS, CRYPTO_UNIVERSE, CRYPTO_MIN_MCAP, CRYPTO_MIN_VOLUME,
  FAVORITE_SYMBOLS, TECHNIQUE_META, pearsonCorr
} from '../worker.js';

const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID, NTFY_TOPIC } = process.env;
const env = { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID, NTFY_TOPIC };

// How far down the market cap ranking to look for movers. Deliberately
// wider than CRYPTO_UNIVERSE — see this file's header. 300 costs two
// CoinGecko pages and covers every asset that realistically has the
// liquidity to be tradable at all.
const SCAN_RANKS = Number(process.env.RETRO_SCAN_RANKS || 300);
// A move worth explaining. Below this the "miss" is noise, and cataloguing
// noise would drown the aggregate that makes this job useful.
const MIN_MOVE_PCT = Number(process.env.RETRO_MIN_MOVE_PCT || 12);
const LOOKBACK_HOURS = Number(process.env.RETRO_LOOKBACK_HOURS || 48);
// A separate knob from MIN_MOVE_PCT on purpose: that one asks "was this a
// big enough day to explain", this one asks "was enough of it still
// available once the tell fired to be worth alerting about". A move only
// detectable near its own top is not an actionable lesson.
const MIN_ACTIONABLE_GAIN_PCT = Number(process.env.RETRO_MIN_ACTIONABLE_GAIN_PCT || 8);
// A favorite earns an asset-relative trigger only from observations that
// predate the move being explained. Sixty daily returns is enough to make a
// robust percentile meaningful without pretending that a few volatile weeks
// define the asset; one trailing year keeps the estimate responsive to a
// changed volatility regime without selecting a window after seeing a move.
const FAVORITE_BASELINE_MIN_SAMPLES = Number(process.env.RETRO_FAVORITE_BASELINE_MIN_SAMPLES || 60);
const FAVORITE_BASELINE_LOOKBACK_DAYS = Number(process.env.RETRO_FAVORITE_BASELINE_LOOKBACK_DAYS || 365);
// Frozen engine state can be older when an hourly build was delayed. It stays
// auditable but snapshots beyond this limit are not treated as describing the
// setup immediately before the event.
const FEATURE_MAX_AGE_HOURS = Number(process.env.RETRO_FEATURE_MAX_AGE_HOURS || 24);
const FEATURE_MIN_INDEPENDENT_DATES = Number(process.env.RETRO_FEATURE_MIN_INDEPENDENT_DATES || 20);
const FEATURE_FAMILY_ALPHA = 0.01;
const OUTCOME_WINDOW_HOURS = 24;
// A second, prospective lane records EVERY eligible daily outcome (not only
// unusual moves) against predictor state that existed before its outcome
// window. Four pre-registered separations cover near-window confirmation,
// intraday lead, one-day lead, and multi-day lead without choosing the best lag
// after seeing the result. The archive retains enough technique-vote history
// for all four anchors.
export const RETRO_LEAD_LAG_HOURS = Object.freeze([0, 6, 24, 72]);
const LEAD_LAG_MAX_STALENESS_HOURS = Number(process.env.RETRO_LEAD_LAG_MAX_STALENESS_HOURS || 4);
const LEAD_LAG_MIN_RUN_ASSETS = Number(process.env.RETRO_LEAD_LAG_MIN_RUN_ASSETS || 20);
const LEAD_LAG_HISTORY_DAYS = Number(process.env.RETRO_LEAD_LAG_HISTORY_DAYS || 730);
const LEAD_LAG_MIN_DISCOVERY_DATES = Number(process.env.RETRO_LEAD_LAG_MIN_DISCOVERY_DATES || 40);
const LEAD_LAG_MIN_HOLDOUT_DATES = Number(process.env.RETRO_LEAD_LAG_MIN_HOLDOUT_DATES || 20);
const LEAD_LAG_MIN_OOS_DATES = Number(process.env.RETRO_LEAD_LAG_MIN_OOS_DATES || 20);
const LEAD_LAG_FAMILY_ALPHA = 0.01;
const LEAD_LAG_MARKET_METRIC_MIN_TRAINING = 60;
// Pre-register a small set of economically coherent pairs. Mining every pair
// of ~30 techniques would create hundreds of mostly redundant hypotheses per
// asset. These pairs are tested as one family alongside the single indicators.
export const RETRO_TECHNIQUE_COMBOS = Object.freeze([
  Object.freeze(['bollinger', 'rsi']),
  Object.freeze(['divergence', 'obv']),
  Object.freeze(['macd', 'momentum']),
  Object.freeze(['openinterest', 'positioning']),
  Object.freeze(['reversal', 'volume']),
  Object.freeze(['seasonal', 'leadlag'])
]);
// These are the only market-cycle series collected by market-context.mjs.
// Pin the complete identity, not just the metric name, so adding a provider or
// model version later creates an explicit new research family instead of
// silently expanding this one after looking at its results.
export const RETRO_MARKET_CONTEXT_FEATURES = Object.freeze([
  'altcoin_season_index|coinmarketcap-keyless|fcs-market-context-v1',
  'btc_dominance_pct|coingecko-global|fcs-market-context-v1',
  'btc_mayer_multiple|fcs-asset-daily-bars|fcs-market-context-v1',
  'btc_mvrv|coinmetrics-community|fcs-market-context-v1'
]);
const RETRO_MARKET_CONTEXT_FEATURE_SET = new Set(RETRO_MARKET_CONTEXT_FEATURES);
// Possible cells in the pre-registered family: all (1), quarter (4), weekday
// (7), target regime (2), and quarter x target regime (8). Charging possible
// cells rather than only whichever ones happen to contain data prevents a
// missing-data pattern from making the significance bar easier.
const RETRO_CONTEXT_CELL_COUNT = 1 + 4 + 7 + 2 + 8;
const RETRO_PREDICTORS_PER_TARGET = Object.keys(TECHNIQUE_META).length + 1
  + RETRO_TECHNIQUE_COMBOS.length + Math.max(0, FAVORITE_SYMBOLS.size - 1)
  + 1 + RETRO_MARKET_CONTEXT_FEATURES.length;
export const RETRO_LEAD_LAG_FAMILY_TESTS = FAVORITE_SYMBOLS.size
  * RETRO_LEAD_LAG_HOURS.length * RETRO_CONTEXT_CELL_COUNT
  * RETRO_PREDICTORS_PER_TARGET;
export const RETRO_BASELINE_METHOD_VERSION = 'favorite-lagged-range-vol-v1';
// v2 starts a clean evidence series after exact publication-state snapshots
// replaced lossy board reconstruction and the seasonal family was frozen.
export const RETRO_FEATURE_METHOD_VERSION = 'retrospective-vote-correlation-v2';
export const RETRO_LEAD_LAG_METHOD_VERSION = 'retrospective-seasonal-leadlag-v2';
const FETCH_TIMEOUT_MS = 20000;
const BINANCE_PACING_MS = 250;

// CoinGecko identifiers are intentionally explicit: symbol-only lookup is
// ambiguous (multiple tokens can share a ticker). The ordinary top-300 scan
// should contain every current favorite; this map supports one bounded rescue
// request if market-cap rank changes enough that an always-tracked asset falls
// outside it.
const FAVORITE_COINGECKO_IDS = new Map([
  ['BTC', 'bitcoin'],
  ['ETH', 'ethereum'],
  ['SOL', 'solana'],
  ['XLM', 'stellar'],
  ['XRP', 'ripple'],
  ['HYPE', 'hyperliquid'],
  ['HBAR', 'hedera-hashgraph']
]);

function validateConfig() {
  for (const [name, v] of Object.entries({ CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, FCS_D1_DATABASE_ID })) {
    if (!v) throw new Error(`Missing required env var: ${name}`);
  }
  for (const [name, v] of Object.entries({
    RETRO_SCAN_RANKS: SCAN_RANKS,
    RETRO_MIN_MOVE_PCT: MIN_MOVE_PCT,
    RETRO_LOOKBACK_HOURS: LOOKBACK_HOURS,
    RETRO_MIN_ACTIONABLE_GAIN_PCT: MIN_ACTIONABLE_GAIN_PCT,
    RETRO_FAVORITE_BASELINE_MIN_SAMPLES: FAVORITE_BASELINE_MIN_SAMPLES,
    RETRO_FAVORITE_BASELINE_LOOKBACK_DAYS: FAVORITE_BASELINE_LOOKBACK_DAYS,
    RETRO_FEATURE_MAX_AGE_HOURS: FEATURE_MAX_AGE_HOURS,
    RETRO_FEATURE_MIN_INDEPENDENT_DATES: FEATURE_MIN_INDEPENDENT_DATES,
    RETRO_LEAD_LAG_MAX_STALENESS_HOURS: LEAD_LAG_MAX_STALENESS_HOURS,
    RETRO_LEAD_LAG_MIN_RUN_ASSETS: LEAD_LAG_MIN_RUN_ASSETS,
    RETRO_LEAD_LAG_HISTORY_DAYS: LEAD_LAG_HISTORY_DAYS,
    RETRO_LEAD_LAG_MIN_DISCOVERY_DATES: LEAD_LAG_MIN_DISCOVERY_DATES,
    RETRO_LEAD_LAG_MIN_HOLDOUT_DATES: LEAD_LAG_MIN_HOLDOUT_DATES,
    RETRO_LEAD_LAG_MIN_OOS_DATES: LEAD_LAG_MIN_OOS_DATES
  })) {
    if (!Number.isFinite(v) || v <= 0) throw new Error(`${name} must be a positive number`);
  }
}

export function quantile(values, p) {
  const sorted = (values || []).filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!sorted.length || !Number.isFinite(p) || p < 0 || p > 1) return null;
  if (sorted.length === 1) return sorted[0];
  const at = (sorted.length - 1) * p;
  const lo = Math.floor(at), hi = Math.ceil(at);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

// A robust, lagged estimate of an asset's own ordinary one-day movement.
// The comparison target is CoinGecko's rolling 24h return, so the primary
// component is the p80 absolute close return. Median high-low range and
// realised close-return volatility stop a quiet close from understating a
// path that was actually volatile. The broad threshold remains a hard upper
// bound: this helper can increase retrospective coverage for a favorite, but
// can never make the broad-universe scan more permissive.
export function favoriteMoveBaseline(bars, { globalThreshold = 12, minSamples = 60 } = {}) {
  const sorted = (bars || [])
    .filter((b) => b && b.date && Number.isFinite(Number(b.close)) && Number(b.close) > 0)
    .map((b) => ({ ...b, close: Number(b.close), high: b.high == null ? null : Number(b.high), low: b.low == null ? null : Number(b.low) }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const returns = [], ranges = [];
  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1].close;
    if (!(previous > 0)) continue;
    returns.push((sorted[i].close / previous - 1) * 100);
    if (Number.isFinite(sorted[i].high) && Number.isFinite(sorted[i].low) && sorted[i].high >= sorted[i].low) {
      ranges.push((sorted[i].high - sorted[i].low) / previous * 100);
    }
  }
  const absReturnP80 = quantile(returns.map(Math.abs), 0.8);
  const dailyRangeP50 = quantile(ranges, 0.5);
  const mean = returns.length ? returns.reduce((sum, x) => sum + x, 0) / returns.length : null;
  const realisedVol = returns.length > 1
    ? Math.sqrt(returns.reduce((sum, x) => sum + (x - mean) ** 2, 0) / (returns.length - 1))
    : null;
  const candidates = [absReturnP80, dailyRangeP50, realisedVol].filter((x) => Number.isFinite(x) && x > 0);
  const candidateThreshold = candidates.length ? Math.max(...candidates) : null;
  const enough = returns.length >= minSamples && candidateThreshold != null;
  const status = !enough ? 'insufficient' : candidateThreshold < globalThreshold ? 'adaptive' : 'global';
  return {
    fitThrough: sorted.length ? sorted[sorted.length - 1].date : null,
    samples: returns.length,
    absReturnP80Pct: absReturnP80,
    dailyRangeP50Pct: dailyRangeP50,
    realizedVolatilityPct: realisedVol,
    candidateThresholdPct: candidateThreshold,
    effectiveThresholdPct: status === 'adaptive' ? candidateThreshold : globalThreshold,
    globalThresholdPct: globalThreshold,
    status,
    methodVersion: RETRO_BASELINE_METHOD_VERSION
  };
}

export function retrospectiveTrigger({ symbol, movePct, baseline, globalThreshold = 12, favoriteSymbols = FAVORITE_SYMBOLS }) {
  if (!Number.isFinite(movePct)) return { triggered: false, thresholdPct: globalThreshold, basis: 'invalid-move' };
  const favorite = favoriteSymbols.has(String(symbol || '').toUpperCase());
  const adaptive = favorite && baseline && baseline.status === 'adaptive'
    && Number.isFinite(baseline.effectiveThresholdPct) && baseline.effectiveThresholdPct > 0
    && baseline.effectiveThresholdPct < globalThreshold;
  const thresholdPct = adaptive ? baseline.effectiveThresholdPct : globalThreshold;
  return {
    triggered: Math.abs(movePct) >= thresholdPct,
    thresholdPct,
    basis: adaptive ? RETRO_BASELINE_METHOD_VERSION : 'global-fixed-v1',
    alwaysTracked: favorite,
    baselineSamples: baseline ? baseline.samples : null,
    baselineFitThrough: baseline ? baseline.fitThrough : null
  };
}

// Coarse enough to accumulate evidence, specific enough to distinguish the
// weekday/session environments the user asked to study. The timestamp is the
// beginning of the outcome window, never the retrospective run after it.
export function retrospectiveTimeBucket(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return 'unknown';
  const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const start = Math.floor(d.getUTCHours() / 6) * 6;
  return `${days[d.getUTCDay()]}_utc_${String(start).padStart(2, '0')}_${String(start + 5).padStart(2, '0')}`;
}

// Peter John Acklam's rational approximation, used only to turn the explicit
// Bonferroni family alpha into a z threshold. Keeping the adjusted alpha and
// threshold in D1 makes every research-only status reproducible.
export function inverseNormalCdf(p) {
  if (!(p > 0 && p < 1)) return p === 0 ? -Infinity : p === 1 ? Infinity : null;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const low = 0.02425, high = 1 - low;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > high) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
    / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

export function bonferroniZThreshold(tests, familyAlpha = FEATURE_FAMILY_ALPHA) {
  const m = Math.max(1, Math.floor(Number(tests) || 1));
  return inverseNormalCdf(1 - familyAlpha / (2 * m));
}

function fisherCorrelationZ(correlation, n) {
  if (!Number.isFinite(correlation) || n < 4) return null;
  const bounded = Math.max(-0.999999, Math.min(0.999999, correlation));
  return Math.atanh(bounded) * Math.sqrt(n - 3);
}

// Correlation here means point-biserial correlation between the lagged vote
// direction and the eventual move magnitude among outcome-selected episodes.
// It is useful for generating a hypothesis about what was missed, but cannot
// estimate forward expectancy because non-move days are absent by design.
export function buildFeatureCorrelationEvidence(rows, { minIndependentDates = 20, familyAlpha = FEATURE_FAMILY_ALPHA } = {}) {
  const groups = new Map();
  for (const row of rows || []) {
    if (!row || ![-1, 1].includes(Number(row.technique_dir)) || !Number.isFinite(Number(row.move_pct))) continue;
    const regime = row.regime || 'unknown', timeBucket = row.time_bucket || 'unknown';
    const key = [row.asset_class || 'crypto', row.symbol, row.technique_id, regime, timeBucket].join('|');
    if (!groups.has(key)) groups.set(key, { assetClass: row.asset_class || 'crypto', symbol: row.symbol, techniqueId: row.technique_id, regime, timeBucket, rows: [] });
    groups.get(key).rows.push(row);
  }
  const testsInFamily = Math.max(1, groups.size);
  const correctedZThreshold = bonferroniZThreshold(testsInFamily, familyAlpha);
  const out = [];
  for (const group of groups.values()) {
    const ordered = group.rows.slice().sort((a, b) => String(a.run_at).localeCompare(String(b.run_at)));
    // Manual workflow retries can create more than one retrospective run on a
    // date. Only the earliest is an independent observation for inference.
    const byDate = new Map();
    for (const row of ordered) {
      const date = String(row.run_at || '').slice(0, 10);
      if (date && !byDate.has(date)) byDate.set(date, row);
    }
    const independent = [...byDate.values()];
    const x = independent.map((r) => Number(r.technique_dir));
    const y = independent.map((r) => Number(r.move_pct));
    const correlation = pearsonCorr(x, y);
    const midpoint = Math.floor(independent.length / 2);
    const first = independent.slice(0, midpoint), second = independent.slice(midpoint);
    const firstCorr = pearsonCorr(first.map((r) => Number(r.technique_dir)), first.map((r) => Number(r.move_pct)));
    const secondCorr = pearsonCorr(second.map((r) => Number(r.technique_dir)), second.map((r) => Number(r.move_pct)));
    const fisherZ = fisherCorrelationZ(correlation, independent.length);
    const splitConsistent = correlation != null && firstCorr != null && secondCorr != null
      && Math.sign(correlation) === Math.sign(firstCorr) && Math.sign(correlation) === Math.sign(secondCorr);
    const enough = independent.length >= minIndependentDates && correlation != null && firstCorr != null && secondCorr != null;
    const status = !enough
      ? 'insufficient'
      : splitConsistent && fisherZ != null && Math.abs(fisherZ) >= correctedZThreshold
        ? 'notable-retrospective-only'
        : 'descriptive-only';
    out.push({
      ...group,
      n: ordered.length,
      independentDates: independent.length,
      alignmentRate: independent.length ? independent.filter((r) => Number(r.aligned) === 1).length / independent.length : null,
      correlation,
      fisherZ,
      firstHalfCorrelation: firstCorr,
      secondHalfCorrelation: secondCorr,
      testsInFamily,
      correctedZThreshold,
      status,
      liveEdgeEligible: 0,
      methodVersion: RETRO_FEATURE_METHOD_VERSION
    });
  }
  return out;
}

// ---------------- SEASONAL, POINT-IN-TIME LEAD/LAG RESEARCH ----------------

function finiteNumber(value) {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function validIso(value) {
  const millis = new Date(value).getTime();
  return Number.isFinite(millis) ? millis : null;
}

// Contexts are tested separately, not silently intersected into one tiny
// sample. The only explicit intersection is quarter x frozen target regime,
// which directly addresses the user's season-dependent-regime hypothesis and
// is charged as another test in the same Bonferroni family.
export function seasonalConditionCells(iso, targetRegime = 'unknown') {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return [{ type: 'all', value: 'all' }];
  const month = date.getUTCMonth() + 1;
  const quarter = `q${Math.floor((month - 1) / 3) + 1}`;
  const weekday = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][date.getUTCDay()];
  const regime = targetRegime || 'unknown';
  const cells = [
    { type: 'all', value: 'all' },
    { type: 'calendar-quarter', value: quarter },
    { type: 'weekday', value: weekday }
  ];
  if (regime !== 'unknown') {
    cells.push({ type: 'target-regime', value: regime });
    cells.push({ type: 'quarter-target-regime', value: `${quarter}|${regime}` });
  }
  return cells;
}

// Select one complete historical engine cross-section per pre-registered lag.
// Strict `< anchor` prevents a vote timestamped at the outcome boundary from
// leaking into its own prediction. A run needs both the absolute asset floor
// and at least 80% of the deepest run observed in this window; that rejects a
// partially written run without hard-coding today's universe size. A short
// staleness bound abstains when the hourly builder was delayed instead of
// substituting an old opinion.
export function selectLaggedPredictorRuns(voteRows, cutoffIso, {
  lags = RETRO_LEAD_LAG_HOURS,
  maxStalenessHours = 4,
  minRunAssets = 20
} = {}) {
  const cutoffMs = validIso(cutoffIso);
  if (cutoffMs == null) return [];
  const runs = new Map();
  for (const row of voteRows || []) {
    const runMs = validIso(row && row.run_at);
    const dir = finiteNumber(row && row.dir);
    if (runMs == null || !row.symbol || !row.technique_id || ![-1, 1].includes(dir)) continue;
    const bucket = runs.get(row.run_at) || { runAt: row.run_at, runMs, rows: [], symbols: new Set() };
    bucket.rows.push({ ...row, dir });
    bucket.symbols.add(String(row.symbol).toUpperCase());
    runs.set(row.run_at, bucket);
  }
  const maxObservedAssets = Math.max(0, ...[...runs.values()].map((run) => run.symbols.size));
  const completenessFloor = Math.max(minRunAssets, Math.ceil(maxObservedAssets * 0.8));
  const complete = [...runs.values()]
    .filter((run) => run.symbols.size >= completenessFloor)
    .sort((a, b) => a.runMs - b.runMs);
  const selected = [];
  for (const rawLag of lags || []) {
    const lagHours = finiteNumber(rawLag);
    if (lagHours == null || lagHours < 0) continue;
    const anchorMs = cutoffMs - lagHours * 3600000;
    let chosen = null;
    for (const run of complete) {
      if (run.runMs < anchorMs) chosen = run;
      else break;
    }
    if (!chosen) continue;
    const ageHours = (anchorMs - chosen.runMs) / 3600000;
    if (!(ageHours >= 0 && ageHours <= maxStalenessHours)) continue;
    selected.push({
      lagHours,
      anchorAt: new Date(anchorMs).toISOString(),
      sourceRunAt: chosen.runAt,
      sourceAgeHours: ageHours,
      votes: chosen.rows
    });
  }
  return selected;
}

// Market-cycle metrics are usable only when both the provider timestamp and
// our first-known timestamp precede the lag anchor. A causal percentile needs
// a real training distribution; raw levels are retained in D1 elsewhere but
// are not smuggled into this correlation scan while that percentile is thin.
export function pointInTimeMarketMetrics(rows, anchorIso, {
  minTraining = 60,
  freshnessHoursByMetric = { altcoin_season_index: 48, btc_dominance_pct: 48 },
  defaultFreshnessHours = 72,
  registeredFeatures = RETRO_MARKET_CONTEXT_FEATURE_SET
} = {}) {
  const anchorMs = validIso(anchorIso);
  if (anchorMs == null) return {};
  const anchorDate = new Date(anchorMs).toISOString().slice(0, 10);
  const latest = new Map();
  for (const row of rows || []) {
    const knownMs = validIso(row && row.known_at);
    const sourceMs = validIso(row && row.source_timestamp);
    const percentile = finiteNumber(row && row.training_percentile);
    const trainingN = finiteNumber(row && row.training_n);
    const freshnessHours = finiteNumber(freshnessHoursByMetric[row && row.metric]) ?? defaultFreshnessHours;
    if (!row || !row.metric || !row.provider || !row.method_version
      || knownMs == null || sourceMs == null || !(knownMs < anchorMs) || !(sourceMs < anchorMs)
      || (anchorMs - sourceMs) / 3600000 > freshnessHours
      || String(row.context_date || '') > anchorDate || percentile == null || trainingN == null
      || trainingN < minTraining || percentile < 0 || percentile > 1) continue;
    const key = `${row.metric}|${row.provider}|${row.method_version}`;
    if (registeredFeatures && !registeredFeatures.has(key)) continue;
    const previous = latest.get(key);
    if (!previous || String(row.context_date).localeCompare(String(previous.context_date)) > 0
      || (row.context_date === previous.context_date && knownMs > previous.knownMs)) {
      latest.set(key, { ...row, percentile, trainingN, knownMs, sourceMs });
    }
  }
  const out = {};
  for (const key of [...latest.keys()].sort()) {
    const row = latest.get(key);
    out[key] = [row.percentile, row.source_timestamp, row.known_at, row.trainingN];
  }
  return out;
}

export function compactLeadLagPredictorFrames(selectedRuns, marketContextRows = []) {
  return (selectedRuns || []).map((run) => {
    const assets = {};
    for (const vote of run.votes || []) {
      const symbol = String(vote.symbol || '').toUpperCase();
      const dir = finiteNumber(vote.dir);
      if (!symbol || !vote.technique_id || ![-1, 1].includes(dir)) continue;
      const asset = (assets[symbol] ??= { r: vote.regime || 'unknown', v: {} });
      if (asset.r === 'unknown' && vote.regime) asset.r = vote.regime;
      asset.v[vote.technique_id] = [dir, finiteNumber(vote.score)];
    }
    const symbols = Object.keys(assets).sort();
    const composite = symbols.map((symbol) => assets[symbol].v.composite).filter(Boolean);
    const breadth = composite.length >= 10
      ? [composite.reduce((sum, vote) => sum + vote[0], 0) / composite.length, composite.length, symbols.length]
      : null;
    const orderedAssets = {};
    for (const symbol of symbols) orderedAssets[symbol] = assets[symbol];
    return {
      l: run.lagHours,
      a: run.anchorAt,
      s: run.sourceRunAt,
      h: run.sourceAgeHours,
      assets: orderedAssets,
      breadth,
      metrics: pointInTimeMarketMetrics(marketContextRows, run.anchorAt, {
        minTraining: LEAD_LAG_MARKET_METRIC_MIN_TRAINING
      })
    };
  }).sort((a, b) => a.l - b.l);
}

// One compact row per date prevents the all-target x all-feature Cartesian
// product from becoming millions of D1 writes. It still archives outcomes for
// every eligible engine asset, so a symbol can be added to research later
// without backfilling its history after seeing that it moved.
export function buildLeadLagDailySnapshot({ runAt, windowStartAt, rankedMarkets, selectedRuns, marketContextRows = [] }) {
  const runMs = validIso(runAt), windowStartMs = validIso(windowStartAt);
  if (runMs == null || windowStartMs == null || !(windowStartMs < runMs)) return null;
  const frames = compactLeadLagPredictorFrames(selectedRuns, marketContextRows);
  if (!frames.length) return null;
  const base = frames.slice().sort((a, b) => a.l - b.l)[0];
  const eligibleSymbols = new Set(Object.keys(base.assets || {}));
  const outcomes = {};
  for (const entry of (rankedMarkets || []).slice().sort((a, b) => Number(a.rank) - Number(b.rank))) {
    const market = entry && (entry.c || entry.market || entry);
    const rank = finiteNumber(entry && entry.rank);
    const symbol = String(market && market.symbol || '').toUpperCase();
    const movePct = finiteNumber(market && market.price_change_percentage_24h);
    // Eligibility is frozen by membership in the pre-window engine frame.
    // Endpoint rank, liquidity and peg behaviour are outcomes of the same
    // window and cannot be allowed to delete losers after their returns are
    // known. Rank remains descriptive only.
    if (!symbol || outcomes[symbol] || !eligibleSymbols.has(symbol) || movePct == null) continue;
    outcomes[symbol] = { p: movePct, rank };
  }
  if (!Object.keys(outcomes).length) return null;
  return {
    observationDate: String(runAt).slice(0, 10),
    runAt,
    windowStartAt,
    windowEndAt: runAt,
    outcomeProvider: 'coingecko-rolling-24h',
    outcomes,
    frames,
    methodVersion: RETRO_LEAD_LAG_METHOD_VERSION
  };
}

function techniqueIndicatorRole(techniqueId) {
  const meta = TECHNIQUE_META && TECHNIQUE_META[techniqueId];
  if (!meta) return techniqueId === 'composite' ? 'mixed' : 'unclassified';
  return meta.leading ? 'leading' : 'confirming-lagging';
}

function signedVoteValue(vote, techniqueId) {
  if (!Array.isArray(vote) || ![-1, 1].includes(Number(vote[0]))) return null;
  const direction = Number(vote[0]);
  const score = finiteNumber(vote[1]);
  // Only composite has a calibrated 0-100 score. A zero or missing score does
  // not erase a real direction; all ordinary techniques stay {-1,+1}.
  return techniqueId === 'composite' && score != null && score > 0
    ? direction * Math.min(1, score / 100)
    : direction;
}

function safeJsonObject(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch { return null; }
}

export function flattenLeadLagDailySnapshots(records, {
  targetSymbols = FAVORITE_SYMBOLS,
  crossAssetSymbols = FAVORITE_SYMBOLS,
  combos = RETRO_TECHNIQUE_COMBOS
} = {}) {
  const wantedTargets = new Set([...(targetSymbols || [])].map((symbol) => String(symbol).toUpperCase()));
  const crossSources = [...new Set([...(crossAssetSymbols || [])].map((symbol) => String(symbol).toUpperCase()))].sort();
  const output = [];
  for (const record of records || []) {
    const outcomes = safeJsonObject(record.outcomes ?? record.outcomes_json);
    const framePayload = safeJsonObject(record.predictors ?? record.predictors_json);
    const frames = Array.isArray(framePayload) ? framePayload : framePayload && framePayload.frames;
    const windowStartAt = record.windowStartAt || record.window_start_at;
    const observationDate = record.observationDate || record.observation_date;
    if (!outcomes || !Array.isArray(frames) || validIso(windowStartAt) == null || !observationDate) continue;
    for (const [targetSymbol, outcome] of Object.entries(outcomes)) {
      if (!wantedTargets.has(targetSymbol)) continue;
      const outcomeReturn = finiteNumber(outcome && outcome.p);
      if (outcomeReturn == null) continue;
      for (const frame of frames) {
        const lagHours = finiteNumber(frame && frame.l);
        const sourceRunMs = validIso(frame && frame.s);
        const windowStartMs = validIso(windowStartAt);
        if (lagHours == null || lagHours < 0 || sourceRunMs == null || !(sourceRunMs < windowStartMs - lagHours * 3600000)) continue;
        // Regime belongs to this predictor frame. Reusing the nearest frame's
        // regime at every lag would leak a later state into earlier predictors.
        const contexts = seasonalConditionCells(windowStartAt,
          (frame.assets && frame.assets[targetSymbol] && frame.assets[targetSymbol].r) || 'unknown');
        const predictors = [];
        const own = frame.assets && frame.assets[targetSymbol];
        if (own && own.v) {
          for (const [techniqueId, vote] of Object.entries(own.v)) {
            const value = signedVoteValue(vote, techniqueId);
            if (value == null) continue;
            predictors.push({ kind: 'technique', source: targetSymbol, id: techniqueId, role: techniqueIndicatorRole(techniqueId), value, sourceAt: frame.s });
          }
          for (const pair of combos || []) {
            const [a, b] = pair;
            const av = own.v[a], bv = own.v[b];
            if (!av || !bv || Number(av[0]) !== Number(bv[0])) continue;
            const roles = [techniqueIndicatorRole(a), techniqueIndicatorRole(b)];
            predictors.push({
              kind: 'technique-combo', source: targetSymbol, id: [a, b].slice().sort().join('+'),
              role: roles[0] === roles[1] ? roles[0] : 'mixed', value: Number(av[0]), sourceAt: frame.s
            });
          }
        }
        for (const source of crossSources) {
          if (source === targetSymbol) continue;
          const sourceAsset = frame.assets && frame.assets[source];
          const value = signedVoteValue(sourceAsset && sourceAsset.v && sourceAsset.v.composite, 'composite');
          if (value == null) continue;
          predictors.push({ kind: 'cross-asset-composite', source, id: 'composite', role: 'cross-asset-leader-candidate', value, sourceAt: frame.s });
        }
        if (Array.isArray(frame.breadth) && finiteNumber(frame.breadth[0]) != null) {
          predictors.push({ kind: 'asset-combination', source: '__CRYPTO_BREADTH__', id: 'composite-breadth', role: 'cross-asset-breadth', value: Number(frame.breadth[0]), sourceAt: frame.s });
        }
        for (const [metricId, metric] of Object.entries(frame.metrics || {})) {
          if (!Array.isArray(metric) || finiteNumber(metric[0]) == null) continue;
          const sourceMs = validIso(metric[1]);
          const knownMs = validIso(metric[2]);
          if (sourceMs == null || knownMs == null) continue;
          const availableAt = new Date(Math.max(sourceMs, knownMs)).toISOString();
          predictors.push({ kind: 'market-cycle-metric', source: '__MARKET__', id: metricId, role: 'cycle-leading-candidate', value: Number(metric[0]), sourceAt: availableAt });
        }
        const seen = new Set();
        for (const predictor of predictors) {
          if (!Number.isFinite(predictor.value)) continue;
          const signature = `${predictor.kind}|${predictor.source}|${predictor.id}`;
          if (seen.has(signature)) continue;
          seen.add(signature);
          const sourceAtMs = validIso(predictor.sourceAt);
          if (sourceAtMs == null || !(sourceAtMs < windowStartMs - lagHours * 3600000)) continue;
          const actualLeadHours = (windowStartMs - sourceAtMs) / 3600000;
          for (const context of contexts) {
            output.push({
              observation_date: observationDate,
              window_end_at: record.windowEndAt || record.window_end_at || record.runAt || record.run_at,
              asset_class: 'crypto', target_symbol: targetSymbol,
              feature_kind: predictor.kind, source_symbol: predictor.source,
              feature_id: predictor.id, indicator_role: predictor.role,
              lag_hours: lagHours, actual_lead_hours: actualLeadHours,
              context_type: context.type, context_value: context.value,
              predictor_value: predictor.value, outcome_return_pct: outcomeReturn
            });
          }
        }
      }
    }
  }
  return output;
}

// Serially correlated market returns make a plain Fisher/IID z-score too
// optimistic. This uses the larger of an IID null standard error and a
// Bartlett-weighted Newey-West standard error of the standardized cross-
// product, so negative autocorrelation can never make the gate easier.
export function hacCorrelationStats(rows, maxLag = 5) {
  const clean = (rows || []).map((row) => ({
    x: finiteNumber(row && (row.predictor_value ?? row.x)),
    y: finiteNumber(row && (row.outcome_return_pct ?? row.y))
  })).filter((row) => row.x != null && row.y != null);
  if (clean.length < 10) return { n: clean.length, correlation: null, z: null };
  const x = clean.map((row) => row.x), y = clean.map((row) => row.y);
  const correlation = pearsonCorr(x, y);
  if (correlation == null) return { n: clean.length, correlation: null, z: null };
  const meanX = x.reduce((sum, value) => sum + value, 0) / x.length;
  const meanY = y.reduce((sum, value) => sum + value, 0) / y.length;
  const sdX = Math.sqrt(x.reduce((sum, value) => sum + (value - meanX) ** 2, 0) / x.length);
  const sdY = Math.sqrt(y.reduce((sum, value) => sum + (value - meanY) ** 2, 0) / y.length);
  if (!(sdX > 0 && sdY > 0)) return { n: clean.length, correlation: null, z: null };
  const products = clean.map((row) => ((row.x - meanX) / sdX) * ((row.y - meanY) / sdY));
  const centered = products.map((value) => value - correlation);
  let longRunVariance = centered.reduce((sum, value) => sum + value * value, 0) / centered.length;
  const lagLimit = Math.min(Math.max(0, Math.floor(maxLag)), centered.length - 1);
  for (let lag = 1; lag <= lagLimit; lag++) {
    let covariance = 0;
    for (let index = lag; index < centered.length; index++) covariance += centered[index] * centered[index - lag];
    covariance /= centered.length;
    longRunVariance += 2 * (1 - lag / (lagLimit + 1)) * covariance;
  }
  const hacSe = Math.sqrt(Math.max(0, longRunVariance) / centered.length);
  const iidNullSe = 1 / Math.sqrt(Math.max(1, centered.length - 3));
  const standardError = Math.max(iidNullSe, hacSe);
  return { n: clean.length, correlation, z: standardError > 0 ? correlation / standardError : null };
}

export function walkForwardCorrelationStability(rows, {
  foldsWanted = 3, minTrain = 20, minTest = 10
} = {}) {
  const ordered = (rows || []).slice().sort((a, b) => String(a.observation_date).localeCompare(String(b.observation_date)));
  const foldCount = Math.max(2, Math.floor(foldsWanted));
  const initialTrain = Math.floor(ordered.length / 2);
  const remaining = ordered.length - initialTrain;
  const width = Math.max(1, Math.floor(remaining / foldCount));
  const folds = [];
  for (let fold = 0; fold < foldCount; fold++) {
    const start = initialTrain + fold * width;
    const end = fold === foldCount - 1 ? ordered.length : Math.min(ordered.length, start + width);
    if (start >= end) continue;
    const train = ordered.slice(0, start), test = ordered.slice(start, end);
    if (train.length < minTrain || test.length < minTest) continue;
    const trainStats = hacCorrelationStats(train), testStats = hacCorrelationStats(test);
    if (trainStats.correlation == null || testStats.correlation == null) continue;
    folds.push({
      trainThrough: train[train.length - 1].observation_date,
      testThrough: test[test.length - 1].observation_date,
      trainCorrelation: trainStats.correlation,
      testCorrelation: testStats.correlation,
      passed: Math.sign(trainStats.correlation) === Math.sign(testStats.correlation)
    });
  }
  const positiveFolds = folds.filter((fold) => fold.passed).length;
  const verdict = folds.length < 2 ? 'insufficient' : positiveFolds / folds.length >= 2 / 3 ? 'passed' : 'failed';
  return { verdict, folds, positiveFolds };
}

function leadLagCellKey(row) {
  return [row.asset_class || 'crypto', row.target_symbol, row.feature_kind, row.source_symbol,
    row.feature_id, row.indicator_role, Number(row.lag_hours), row.context_type, row.context_value].join('\u001f');
}

function nextDiscoveryCheckpoint(minimum, n) {
  let checkpoint = 1;
  while (checkpoint < minimum) checkpoint *= 2;
  while (checkpoint < n) checkpoint *= 2;
  const base = (() => { let value = 1; while (value < minimum) value *= 2; return value; })();
  return { checkpoint, due: n === checkpoint, stage: Math.max(0, Math.round(Math.log2(checkpoint / base))) };
}

function priorNumber(prior, snake, camel) {
  return finiteNumber(prior && (prior[snake] ?? prior[camel]));
}

// Candidate discovery is allowed only at doubling checkpoints (64, 128, ...
// with the defaults). Alpha is spent geometrically across those repeated
// looks, while Bonferroni covers every asset/feature/lag/context cell tested at
// that checkpoint. A chronological validation tail and anchored walk-forward
// stability must both agree before a candidate is even called provisional.
// It then needs observations dated after the frozen discovery cutoff to earn a
// replicated research label. Neither label can alter a live weight here.
export function buildSeasonalLeadLagEvidence(rows, priorRows = [], {
  minDiscoveryDates = 40,
  minHoldoutDates = 20,
  minOosDates = 20,
  familyAlpha = LEAD_LAG_FAMILY_ALPHA,
  minPersistDates = 1,
  testsInFamilyOverride = null,
  oosTestsInFamilyOverride = null
} = {}) {
  const groups = new Map();
  for (const row of rows || []) {
    if (!row || !row.observation_date || finiteNumber(row.predictor_value) == null || finiteNumber(row.outcome_return_pct) == null) continue;
    const key = leadLagCellKey(row);
    if (!groups.has(key)) groups.set(key, { key, meta: row, rows: [] });
    groups.get(key).rows.push(row);
  }
  const prior = new Map();
  for (const row of priorRows || []) prior.set(leadLagCellKey(row), row);
  const testsInFamily = finiteNumber(testsInFamilyOverride) != null
    ? Math.max(1, Math.floor(Number(testsInFamilyOverride)))
    : Math.max(1, groups.size);
  const oosTestsInFamily = finiteNumber(oosTestsInFamilyOverride) != null
    ? Math.max(1, Math.floor(Number(oosTestsInFamilyOverride)))
    : Math.max(1, (priorRows || []).filter((row) => row && (row.discovery_fit_through ?? row.discoveryFitThrough)).length);
  const minimum = minDiscoveryDates + minHoldoutDates;
  const output = [];
  for (const group of groups.values()) {
    const sorted = group.rows.slice().sort((a, b) => String(a.observation_date).localeCompare(String(b.observation_date)));
    const byDate = new Map();
    for (const row of sorted) if (!byDate.has(row.observation_date)) byDate.set(row.observation_date, row);
    const independent = [...byDate.values()];
    if (independent.length < minPersistDates) continue;
    const overall = hacCorrelationStats(independent);
    const actualLeads = independent.map((row) => finiteNumber(row.actual_lead_hours)).filter((value) => value != null);
    const previous = prior.get(group.key);
    const previousCutoff = previous && (previous.discovery_fit_through ?? previous.discoveryFitThrough);
    let status = independent.length < minimum ? 'insufficient' : 'descriptive-only';
    let discoveredAt = previous && (previous.discovered_at ?? previous.discoveredAt) || null;
    let discoveryFitThrough = previousCutoff || null;
    let discoveryN = 0, discoveryCorrelation = null, discoveryZ = null;
    let holdoutN = 0, holdoutCorrelation = null, holdoutZ = null;
    let oosN = 0, oosCorrelation = null, oosZ = null;
    let oosTests = priorNumber(previous, 'oos_tests_in_family', 'oosTestsInFamily');
    let oosCorrectedZ = priorNumber(previous, 'oos_corrected_z_threshold', 'oosCorrectedZThreshold');
    let oosAlphaSpent = priorNumber(previous, 'oos_alpha_spent', 'oosAlphaSpent');
    let oosNextCheckpointN = priorNumber(previous, 'oos_next_checkpoint_n', 'oosNextCheckpointN');
    let discoveryTests = priorNumber(previous, 'discovery_tests_in_family', 'discoveryTestsInFamily');
    let correctedZ = priorNumber(previous, 'corrected_z_threshold', 'correctedZThreshold');
    let alphaSpent = priorNumber(previous, 'family_alpha_spent', 'familyAlphaSpent');
    let walkForwardVerdict = previous && (previous.walk_forward_verdict ?? previous.walkForwardVerdict) || 'insufficient';
    let walkForwardFolds = priorNumber(previous, 'walk_forward_folds', 'walkForwardFolds') || 0;
    let walkForwardPositive = priorNumber(previous, 'walk_forward_positive_folds', 'walkForwardPositiveFolds') || 0;

    if (previousCutoff) {
      const discovery = independent.filter((row) => row.observation_date <= previousCutoff);
      const oos = independent.filter((row) => row.observation_date > previousCutoff);
      const dStats = hacCorrelationStats(discovery), oStats = hacCorrelationStats(oos);
      discoveryN = dStats.n;
      discoveryCorrelation = priorNumber(previous, 'discovery_correlation', 'discoveryCorrelation') ?? dStats.correlation;
      discoveryZ = priorNumber(previous, 'discovery_hac_z', 'discoveryHacZ') ?? dStats.z;
      holdoutN = priorNumber(previous, 'holdout_n', 'holdoutN') || 0;
      holdoutCorrelation = priorNumber(previous, 'holdout_correlation', 'holdoutCorrelation');
      holdoutZ = priorNumber(previous, 'holdout_hac_z', 'holdoutHacZ');
      oosN = oStats.n; oosCorrelation = oStats.correlation; oosZ = oStats.z;
      status = previous && (previous.status === 'replicated-research-only' || previous.status === 'decayed-research-only')
        ? previous.status
        : 'provisional-research-only';
      const oosSchedule = nextDiscoveryCheckpoint(minOosDates, oosN);
      oosNextCheckpointN = oosSchedule.due ? oosSchedule.checkpoint * 2 : oosSchedule.checkpoint;
      if (oosSchedule.due && oosCorrelation != null && oosZ != null && discoveryCorrelation != null) {
        oosTests = oosTestsInFamily;
        oosAlphaSpent = familyAlpha / (2 ** (oosSchedule.stage + 1));
        oosCorrectedZ = bonferroniZThreshold(oosTests, oosAlphaSpent);
        const sameDirection = Math.sign(oosCorrelation) === Math.sign(discoveryCorrelation);
        if (Math.abs(oosZ) >= oosCorrectedZ && sameDirection) status = 'replicated-research-only';
        else if (Math.abs(oosZ) >= oosCorrectedZ && !sameDirection) status = 'decayed-research-only';
        else status = 'provisional-research-only';
      }
    } else if (independent.length >= minimum) {
      const schedule = nextDiscoveryCheckpoint(minimum, independent.length);
      if (schedule.due) {
        const split = Math.max(minDiscoveryDates, Math.floor(independent.length * 2 / 3));
        const discovery = independent.slice(0, split), holdout = independent.slice(split);
        const dStats = hacCorrelationStats(discovery), hStats = hacCorrelationStats(holdout);
        const walkForward = walkForwardCorrelationStability(independent);
        discoveryN = dStats.n; discoveryCorrelation = dStats.correlation; discoveryZ = dStats.z;
        holdoutN = hStats.n; holdoutCorrelation = hStats.correlation; holdoutZ = hStats.z;
        discoveryTests = testsInFamily;
        alphaSpent = familyAlpha / (2 ** (schedule.stage + 1));
        correctedZ = bonferroniZThreshold(testsInFamily, alphaSpent);
        walkForwardVerdict = walkForward.verdict;
        walkForwardFolds = walkForward.folds.length;
        walkForwardPositive = walkForward.positiveFolds;
        const splitStable = dStats.correlation != null && hStats.correlation != null
          && Math.sign(dStats.correlation) === Math.sign(hStats.correlation);
        const passed = discovery.length >= minDiscoveryDates && holdout.length >= minHoldoutDates
          && splitStable && dStats.z != null && Math.abs(dStats.z) >= correctedZ
          && hStats.z != null && Math.abs(hStats.z) >= 1.96
          && walkForward.verdict === 'passed';
        if (passed) {
          status = 'provisional-research-only';
          discoveryFitThrough = independent[independent.length - 1].observation_date;
          discoveredAt = independent[independent.length - 1].window_end_at || `${discoveryFitThrough}T23:59:59.999Z`;
        }
      }
    }
    const schedule = nextDiscoveryCheckpoint(minimum, independent.length);
    output.push({
      assetClass: group.meta.asset_class || 'crypto', targetSymbol: group.meta.target_symbol,
      featureKind: group.meta.feature_kind, sourceSymbol: group.meta.source_symbol,
      featureId: group.meta.feature_id, indicatorRole: group.meta.indicator_role,
      lagHours: Number(group.meta.lag_hours), contextType: group.meta.context_type,
      contextValue: group.meta.context_value, n: independent.length,
      correlation: overall.correlation, hacZ: overall.z,
      meanActualLeadHours: actualLeads.length ? actualLeads.reduce((sum, value) => sum + value, 0) / actualLeads.length : null,
      discoveryN, discoveryCorrelation, discoveryHacZ: discoveryZ,
      holdoutN, holdoutCorrelation, holdoutHacZ: holdoutZ,
      discoveryTestsInFamily: discoveryTests, correctedZThreshold: correctedZ,
      familyAlphaSpent: alphaSpent,
      nextCheckpointN: previousCutoff ? null : schedule.due ? schedule.checkpoint * 2 : schedule.checkpoint,
      walkForwardVerdict, walkForwardFolds, walkForwardPositiveFolds: walkForwardPositive,
      discoveredAt, discoveryFitThrough, oosN, oosCorrelation, oosHacZ: oosZ,
      oosTestsInFamily: oosTests, oosCorrectedZThreshold: oosCorrectedZ,
      oosAlphaSpent, oosNextCheckpointN,
      status, liveEdgeEligible: 0, methodVersion: RETRO_LEAD_LAG_METHOD_VERSION
    });
  }
  return output;
}

async function fetchJsonOnce(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    // "HTTP 429" prefix exactly, so the retry below can recognise it —
    // same message shape worker.js's fetchJson uses.
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

// CoinGecko's free tier rate-limits by IP and CI runners share heavily
// used ranges. A single un-retried 429 took the Signals Daily job down on
// both 2026-08-31 and 2026-09-01 (see getCryptoMarkets in worker.js);
// this job makes the same class of call on its own daily schedule and
// would have failed identically. Only 429 is retried — a 404 will not fix
// itself by being asked again.
async function fetchJson(url) {
  let lastErr;
  for (let attempt = 0; attempt <= COINGECKO_BACKOFFS_MS.length; attempt++) {
    try {
      return await fetchJsonOnce(url);
    } catch (e) {
      lastErr = e;
      if (!/^HTTP 429/.test(String(e && e.message)) || attempt === COINGECKO_BACKOFFS_MS.length) break;
      console.log(`  rate-limited, backing off ${COINGECKO_BACKOFFS_MS[attempt]}ms`);
      await new Promise((r) => setTimeout(r, COINGECKO_BACKOFFS_MS[attempt]));
    }
  }
  throw lastErr;
}

// The wide scan.
//
// PAGE_SIZE is deliberately FIXED across every page rather than shrunk to
// fit the remaining budget on the last one. CoinGecko's pagination offset
// is per_page * (page - 1), so varying it re-reads earlier ranks instead
// of continuing past them: asking for per_page=250 then per_page=50&page=2
// returns ranks 1-250 followed by ranks 50-99, never reaching 251-300.
// Confirmed live against the API, and it would have left this job blind to
// exactly the rank band it exists to cover while silently double-counting
// the band it already had.
const PAGE_SIZE = 250;
async function scanMarkets() {
  const out = [];
  const pages = Math.ceil(SCAN_RANKS / PAGE_SIZE);
  for (let page = 1; page <= pages; page++) {
    const url = 'https://api.coingecko.com/api/v3/coins/markets'
      + `?vs_currency=usd&order=market_cap_desc&per_page=${PAGE_SIZE}&page=${page}`
      + '&sparkline=true&price_change_percentage=24h';
    const rows = await fetchJson(url);
    if (!Array.isArray(rows) || !rows.length) break;
    out.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    if (page < pages) await new Promise((r) => setTimeout(r, 1500)); // free tier pacing
  }
  // Defensive dedupe by id: a coin can shift rank between two paged calls
  // and land in both, or in neither. Losing one is unavoidable; counting
  // one twice would corrupt the aggregate this job exists to produce.
  const seen = new Set();
  return out.filter((c) => c && c.id && !seen.has(c.id) && seen.add(c.id)).slice(0, SCAN_RANKS);
}

async function rescueMissingFavoriteMarkets(markets) {
  const have = new Set((markets || []).map((c) => String(c && c.symbol || '').toUpperCase()));
  const missingIds = [...FAVORITE_SYMBOLS]
    .filter((symbol) => !have.has(symbol))
    .map((symbol) => FAVORITE_COINGECKO_IDS.get(symbol))
    .filter(Boolean);
  if (!missingIds.length) return markets;
  const url = 'https://api.coingecko.com/api/v3/coins/markets'
    + `?vs_currency=usd&ids=${missingIds.map(encodeURIComponent).join('%2C')}`
    + `&order=market_cap_desc&per_page=${missingIds.length}&page=1`
    + '&sparkline=true&price_change_percentage=24h';
  const rescued = await fetchJson(url);
  const seenIds = new Set((markets || []).map((c) => c && c.id).filter(Boolean));
  return (markets || []).concat((Array.isArray(rescued) ? rescued : [])
    .filter((c) => c && c.id && !seenIds.has(c.id) && seenIds.add(c.id)));
}

async function loadFavoriteBaselines(computedAt, fitBeforeDate) {
  const symbols = [...FAVORITE_SYMBOLS];
  const start = new Date(`${fitBeforeDate}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - FAVORITE_BASELINE_LOOKBACK_DAYS);
  const startDate = start.toISOString().slice(0, 10);
  const placeholders = symbols.map(() => '?').join(',');
  const rows = await d1(env, `
    SELECT symbol, date, close, high, low
      FROM asset_daily_bars
     WHERE asset_class = 'crypto' AND symbol IN (${placeholders})
       AND date >= ? AND date < ?
     ORDER BY symbol, date`, [...symbols, startDate, fitBeforeDate]);
  const bySymbol = Object.fromEntries(symbols.map((symbol) => [symbol, []]));
  for (const row of rows) if (bySymbol[row.symbol]) bySymbol[row.symbol].push(row);
  const baselines = {};
  for (const symbol of symbols) {
    baselines[symbol] = favoriteMoveBaseline(bySymbol[symbol], {
      globalThreshold: MIN_MOVE_PCT,
      minSamples: FAVORITE_BASELINE_MIN_SAMPLES
    });
  }

  await forEachConcurrent(chunk(symbols, 20), 2, async (batch) => {
    for (const symbol of batch) {
      const b = baselines[symbol];
      await d1(env, `
        INSERT INTO retrospective_asset_baselines
          (computed_at, asset_class, symbol, fit_through, samples, abs_return_p80_pct,
           daily_range_p50_pct, realized_volatility_pct, candidate_threshold_pct,
           effective_threshold_pct, global_threshold_pct, status, method_version)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(computed_at, asset_class, symbol) DO NOTHING`,
      [computedAt, 'crypto', symbol, b.fitThrough, b.samples, b.absReturnP80Pct,
       b.dailyRangeP50Pct, b.realizedVolatilityPct, b.candidateThresholdPct,
       b.effectiveThresholdPct, b.globalThresholdPct, b.status, b.methodVersion]);
    }
  });
  return baselines;
}

// Decode the exact post-sanitizer object logged at publication time. Fail
// closed on malformed or internally inconsistent rows: a retrospective with
// no grade is preferable to a plausible grade invented from partial data.
export function decodePublicationSnapshot(row, symbols = []) {
  if (!row || validIso(row.run_at ?? row.runAt) == null) return null;
  const universe = safeJsonObject(row.universe_json ?? row.universe);
  const boards = safeJsonObject(row.boards_json ?? row.boards);
  if (!Array.isArray(universe) || !Array.isArray(boards)) return null;
  const universeSet = new Set(universe.map((symbol) => String(symbol || '').toUpperCase()).filter(Boolean));
  const declaredCount = finiteNumber(row.universe_count ?? row.universeCount);
  if (declaredCount != null && declaredCount !== universeSet.size) return null;
  const wanted = new Set((symbols || []).map((symbol) => String(symbol).toUpperCase()));
  const states = {};
  for (const item of boards) {
    const symbol = String(item && item.symbol || '').toUpperCase();
    if (!symbol || (wanted.size && !wanted.has(symbol)) || !universeSet.has(symbol)) continue;
    const state = (states[symbol] ??= { directions: [], rows: [], withheld: false, score: null });
    const dir = Number(item.dir);
    state.rows.push(item);
    if ((dir === 1 || dir === -1) && !state.directions.includes(dir)) state.directions.push(dir);
    const score = finiteNumber(item.score);
    if (score != null && (state.score == null || score > state.score)) state.score = score;
  }
  for (const state of Object.values(states)) {
    state.directions.sort((a, b) => a - b);
    state.withheld = state.rows.length > 0 && state.directions.length === 0;
  }
  return { runAt: row.run_at ?? row.runAt, universe: universeSet, states };
}

async function loadEngineStateBefore(symbols, sinceIso, cutoffIso) {
  if (!symbols.length) return null;
  const rows = await d1(env, `
    SELECT run_at, universe_json, boards_json, universe_count
      FROM signal_publication_snapshots
     WHERE asset_class = 'crypto' AND run_at >= ? AND run_at < ?
     ORDER BY run_at DESC
     LIMIT 1`, [sinceIso, cutoffIso]);
  return rows.length ? decodePublicationSnapshot(rows[0], symbols) : null;
}

// Latest complete engine run strictly BEFORE the selected move window. This
// query is bounded to the mover symbols (unlike board reconstruction above,
// which needs the whole universe) and therefore adds one read, not an N+1
// query per asset. Regime is already frozen at vote time by logRun.
async function loadFeatureSnapshotsBefore(symbols, cutoffIso) {
  if (!symbols.length) return {};
  const since = new Date(new Date(cutoffIso).getTime() - FEATURE_MAX_AGE_HOURS * 3600 * 1000).toISOString();
  // D1 enforces a 100-bound-parameter limit. A volatile broad-market day can
  // select more than 98 movers, so query bounded symbol batches rather than
  // letting the retrospective fail precisely when it is most valuable.
  const rows = [];
  for (const batch of chunk([...new Set(symbols)], 90)) {
    const placeholders = batch.map(() => '?').join(',');
    rows.push(...await d1(env, `
      SELECT symbol, technique_id, dir, score, regime, run_at
        FROM technique_votes
       WHERE asset_class = 'crypto' AND symbol IN (${placeholders})
         AND run_at >= ? AND run_at < ?
       ORDER BY symbol, run_at ASC, technique_id`, [...batch, since, cutoffIso]));
  }
  const latest = {};
  for (const row of rows) {
    if (!latest[row.symbol] || row.run_at > latest[row.symbol].runAt) {
      latest[row.symbol] = { runAt: row.run_at, votes: [row] };
    } else if (row.run_at === latest[row.symbol].runAt) {
      latest[row.symbol].votes.push(row);
    }
  }
  return latest;
}

export function buildMissFeatureSnapshotRows(episodes, snapshots) {
  const out = [];
  for (const episode of episodes || []) {
    // This ledger answers "what did we miss?" It deliberately excludes
    // caught episodes; it is hypothesis generation, not a performance claim.
    if (!episode || episode.cause === 'caught') continue;
    const frozen = snapshots && snapshots[episode.symbol];
    const cutoff = episode.feature_cutoff_at;
    if (!frozen || !cutoff || !(frozen.runAt < cutoff)) continue;
    const sourceLagHours = (new Date(cutoff).getTime() - new Date(frozen.runAt).getTime()) / 3600000;
    if (!Number.isFinite(sourceLagHours) || sourceLagHours < 0 || sourceLagHours > FEATURE_MAX_AGE_HOURS) continue;
    for (const vote of frozen.votes || []) {
      const techniqueDir = Number(vote.dir);
      if (![-1, 1].includes(techniqueDir)) continue;
      out.push({
        run_at: episode.run_at,
        asset_class: episode.asset_class,
        symbol: episode.symbol,
        feature_cutoff_at: cutoff,
        source_run_at: frozen.runAt,
        technique_id: vote.technique_id,
        technique_dir: techniqueDir,
        technique_score: vote.score == null ? null : Number(vote.score),
        move_pct: Number(episode.move_pct),
        move_dir: Number(episode.move_dir),
        aligned: techniqueDir === Number(episode.move_dir) ? 1 : 0,
        regime: vote.regime || 'unknown',
        time_bucket: retrospectiveTimeBucket(cutoff),
        source_lag_hours: sourceLagHours,
        method_version: RETRO_FEATURE_METHOD_VERSION
      });
    }
  }
  return out;
}

async function writeFeatureSnapshots(rows) {
  if (!rows.length) return;
  await forEachConcurrent(chunk(rows, 20), 3, async (batch) => {
    for (const r of batch) {
      await d1(env, `
        INSERT INTO retrospective_feature_snapshots
          (run_at, asset_class, symbol, feature_cutoff_at, source_run_at,
           technique_id, technique_dir, technique_score, move_pct, move_dir,
           aligned, regime, time_bucket, source_lag_hours, method_version)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(run_at, asset_class, symbol, technique_id, method_version) DO NOTHING`,
      [r.run_at, r.asset_class, r.symbol, r.feature_cutoff_at, r.source_run_at,
       r.technique_id, r.technique_dir, r.technique_score, r.move_pct, r.move_dir,
       r.aligned, r.regime, r.time_bucket, r.source_lag_hours, r.method_version]);
    }
  });
}

async function refreshFeatureCorrelations(nowIso) {
  const snapshots = await d1(env, `
    SELECT run_at, asset_class, symbol, technique_id, technique_dir, move_pct,
           aligned, regime, time_bucket
      FROM retrospective_feature_snapshots
     WHERE method_version = ?
     ORDER BY run_at ASC`, [RETRO_FEATURE_METHOD_VERSION]);
  const evidence = buildFeatureCorrelationEvidence(snapshots, {
    minIndependentDates: FEATURE_MIN_INDEPENDENT_DATES,
    familyAlpha: FEATURE_FAMILY_ALPHA
  });
  await forEachConcurrent(chunk(evidence, 20), 3, async (batch) => {
    for (const e of batch) {
      await d1(env, `
        INSERT INTO retrospective_feature_correlations
          (asset_class, symbol, technique_id, regime, time_bucket, n,
           independent_dates, alignment_rate, correlation, fisher_z,
           first_half_correlation, second_half_correlation, tests_in_family,
           corrected_z_threshold, status, live_edge_eligible, updated_at, method_version)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(asset_class, symbol, technique_id, regime, time_bucket, method_version)
        DO UPDATE SET
          n = excluded.n,
          independent_dates = excluded.independent_dates,
          alignment_rate = excluded.alignment_rate,
          correlation = excluded.correlation,
          fisher_z = excluded.fisher_z,
          first_half_correlation = excluded.first_half_correlation,
          second_half_correlation = excluded.second_half_correlation,
          tests_in_family = excluded.tests_in_family,
          corrected_z_threshold = excluded.corrected_z_threshold,
          status = excluded.status,
          live_edge_eligible = 0,
          updated_at = excluded.updated_at`,
      [e.assetClass, e.symbol, e.techniqueId, e.regime, e.timeBucket, e.n,
       e.independentDates, e.alignmentRate, e.correlation, e.fisherZ,
       e.firstHalfCorrelation, e.secondHalfCorrelation, e.testsInFamily,
       e.correctedZThreshold, e.status, 0, nowIso, e.methodVersion]);
    }
  });
  return evidence;
}

async function loadPointInTimeLeadLagInputs(cutoffIso) {
  const cutoffMs = new Date(cutoffIso).getTime();
  const oldest = new Date(cutoffMs - (Math.max(...RETRO_LEAD_LAG_HOURS) + LEAD_LAG_MAX_STALENESS_HOURS + 1) * 3600000).toISOString();
  const votes = await d1(env, `
    SELECT run_at, symbol, technique_id, dir, score, regime
      FROM technique_votes
     WHERE asset_class = 'crypto' AND run_at >= ? AND run_at < ?
     ORDER BY run_at, symbol, technique_id`, [oldest, cutoffIso]);
  const selectedRuns = selectLaggedPredictorRuns(votes, cutoffIso, {
    lags: RETRO_LEAD_LAG_HOURS,
    maxStalenessHours: LEAD_LAG_MAX_STALENESS_HOURS,
    minRunAssets: LEAD_LAG_MIN_RUN_ASSETS
  });
  // known_at/source_timestamp are filtered again independently at every lag
  // anchor by pointInTimeMarketMetrics. This coarse bound just avoids pulling
  // records that could not be known by even the newest anchor.
  const marketContextRows = await d1(env, `
    SELECT metric, context_date, value, source_timestamp, known_at, provider,
           method_version, training_percentile, training_n
      FROM market_context_daily
     WHERE known_at < ? AND source_timestamp < ?
     ORDER BY metric, context_date`, [cutoffIso, cutoffIso]);
  return { selectedRuns, marketContextRows };
}

async function writeLeadLagDailySnapshot(snapshot) {
  if (!snapshot) return false;
  await d1(env, `
    INSERT INTO retrospective_lead_lag_daily
      (observation_date, run_at, window_start_at, window_end_at,
       outcome_provider, outcomes_json, predictors_json, method_version)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(observation_date, method_version) DO NOTHING`,
  [snapshot.observationDate, snapshot.runAt, snapshot.windowStartAt, snapshot.windowEndAt,
   snapshot.outcomeProvider, JSON.stringify(snapshot.outcomes), JSON.stringify({ frames: snapshot.frames }),
   snapshot.methodVersion]);
  return true;
}

async function writeSeasonalLeadLagEvidence(evidence, nowIso) {
  if (!evidence.length) return;
  await forEachConcurrent(chunk(evidence, 100), 3, async (batch) => {
    await d1(env, `
      INSERT INTO retrospective_seasonal_lead_lag
        (asset_class, target_symbol, feature_kind, source_symbol, feature_id,
         indicator_role, lag_hours, context_type, context_value, n,
         correlation, hac_z, mean_actual_lead_hours, discovery_n,
         discovery_correlation, discovery_hac_z, holdout_n,
         holdout_correlation, holdout_hac_z, discovery_tests_in_family,
         corrected_z_threshold, family_alpha_spent, next_checkpoint_n,
         walk_forward_verdict, walk_forward_folds,
         walk_forward_positive_folds, discovered_at, discovery_fit_through,
         oos_n, oos_correlation, oos_hac_z, oos_tests_in_family,
         oos_corrected_z_threshold, oos_alpha_spent, oos_next_checkpoint_n,
         status, live_edge_eligible, updated_at, method_version)
      SELECT
        json_extract(value, '$.assetClass'),
        json_extract(value, '$.targetSymbol'),
        json_extract(value, '$.featureKind'),
        json_extract(value, '$.sourceSymbol'),
        json_extract(value, '$.featureId'),
        json_extract(value, '$.indicatorRole'),
        json_extract(value, '$.lagHours'),
        json_extract(value, '$.contextType'),
        json_extract(value, '$.contextValue'),
        json_extract(value, '$.n'),
        json_extract(value, '$.correlation'),
        json_extract(value, '$.hacZ'),
        json_extract(value, '$.meanActualLeadHours'),
        json_extract(value, '$.discoveryN'),
        json_extract(value, '$.discoveryCorrelation'),
        json_extract(value, '$.discoveryHacZ'),
        json_extract(value, '$.holdoutN'),
        json_extract(value, '$.holdoutCorrelation'),
        json_extract(value, '$.holdoutHacZ'),
        json_extract(value, '$.discoveryTestsInFamily'),
        json_extract(value, '$.correctedZThreshold'),
        json_extract(value, '$.familyAlphaSpent'),
        json_extract(value, '$.nextCheckpointN'),
        json_extract(value, '$.walkForwardVerdict'),
        json_extract(value, '$.walkForwardFolds'),
        json_extract(value, '$.walkForwardPositiveFolds'),
        json_extract(value, '$.discoveredAt'),
        json_extract(value, '$.discoveryFitThrough'),
        json_extract(value, '$.oosN'),
        json_extract(value, '$.oosCorrelation'),
        json_extract(value, '$.oosHacZ'),
        json_extract(value, '$.oosTestsInFamily'),
        json_extract(value, '$.oosCorrectedZThreshold'),
        json_extract(value, '$.oosAlphaSpent'),
        json_extract(value, '$.oosNextCheckpointN'),
        json_extract(value, '$.status'),
        0,
        ?,
        json_extract(value, '$.methodVersion')
      FROM json_each(?)
      WHERE 1
      ON CONFLICT(asset_class, target_symbol, feature_kind, source_symbol,
                  feature_id, lag_hours, context_type, context_value,
                  method_version)
      DO UPDATE SET
        indicator_role = excluded.indicator_role,
        n = excluded.n,
        correlation = excluded.correlation,
        hac_z = excluded.hac_z,
        mean_actual_lead_hours = excluded.mean_actual_lead_hours,
        discovery_n = excluded.discovery_n,
        discovery_correlation = excluded.discovery_correlation,
        discovery_hac_z = excluded.discovery_hac_z,
        holdout_n = excluded.holdout_n,
        holdout_correlation = excluded.holdout_correlation,
        holdout_hac_z = excluded.holdout_hac_z,
        discovery_tests_in_family = excluded.discovery_tests_in_family,
        corrected_z_threshold = excluded.corrected_z_threshold,
        family_alpha_spent = excluded.family_alpha_spent,
        next_checkpoint_n = excluded.next_checkpoint_n,
        walk_forward_verdict = excluded.walk_forward_verdict,
        walk_forward_folds = excluded.walk_forward_folds,
        walk_forward_positive_folds = excluded.walk_forward_positive_folds,
        discovered_at = excluded.discovered_at,
        discovery_fit_through = excluded.discovery_fit_through,
        oos_n = excluded.oos_n,
        oos_correlation = excluded.oos_correlation,
        oos_hac_z = excluded.oos_hac_z,
        oos_tests_in_family = excluded.oos_tests_in_family,
        oos_corrected_z_threshold = excluded.oos_corrected_z_threshold,
        oos_alpha_spent = excluded.oos_alpha_spent,
        oos_next_checkpoint_n = excluded.oos_next_checkpoint_n,
        status = excluded.status,
        live_edge_eligible = 0,
        updated_at = excluded.updated_at`, [nowIso, JSON.stringify(batch)]);
  });
}

async function refreshSeasonalLeadLagEvidence(nowIso, targetSymbols) {
  const start = new Date(new Date(nowIso).getTime() - LEAD_LAG_HISTORY_DAYS * 86400000).toISOString().slice(0, 10);
  const daily = await d1(env, `
    SELECT observation_date, run_at, window_start_at, window_end_at,
           outcomes_json, predictors_json
      FROM retrospective_lead_lag_daily
     WHERE method_version = ? AND observation_date >= ?
     ORDER BY observation_date`, [RETRO_LEAD_LAG_METHOD_VERSION, start]);
  const prior = await d1(env, `
    SELECT *
      FROM retrospective_seasonal_lead_lag
     WHERE method_version = ?`, [RETRO_LEAD_LAG_METHOD_VERSION]);
  let observationCount = 0;
  const evidence = [];
  // Expand one target at a time. At two years of daily history, materializing
  // every target x lag x predictor x context at once would create millions of
  // JS objects. The statistical family remains global and fixed through the
  // explicit override, so this memory bound does not weaken multiplicity.
  for (const targetSymbol of [...targetSymbols].sort()) {
    const observations = flattenLeadLagDailySnapshots(daily, {
      targetSymbols: new Set([targetSymbol]),
      crossAssetSymbols: FAVORITE_SYMBOLS
    });
    observationCount += observations.length;
    const targetPrior = prior.filter((row) => row.target_symbol === targetSymbol);
    const targetEvidence = buildSeasonalLeadLagEvidence(observations, targetPrior, {
      minDiscoveryDates: LEAD_LAG_MIN_DISCOVERY_DATES,
      minHoldoutDates: LEAD_LAG_MIN_HOLDOUT_DATES,
      minOosDates: LEAD_LAG_MIN_OOS_DATES,
      familyAlpha: LEAD_LAG_FAMILY_ALPHA,
      minPersistDates: 10,
      testsInFamilyOverride: RETRO_LEAD_LAG_FAMILY_TESTS,
      oosTestsInFamilyOverride: RETRO_LEAD_LAG_FAMILY_TESTS
    });
    await writeSeasonalLeadLagEvidence(targetEvidence, nowIso);
    evidence.push(...targetEvidence);
  }
  return { observations: observationCount, evidence };
}

async function notify(title, message) {
  if (!NTFY_TOPIC) return false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    try {
      await fetch(`https://ntfy.sh/${encodeURIComponent(NTFY_TOPIC)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain; charset=utf-8', Title: title, Priority: 'default', Tags: 'mag', Click: 'https://frontiercapitalsignals.com/signals/' },
        body: message, signal: ctrl.signal
      });
    } finally { clearTimeout(t); }
    return true;
  } catch (e) { console.error('ntfy failed (non-fatal):', e.message || e); return false; }
}

async function main() {
  validateConfig();
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  // CoinGecko's observation is a rolling 24-hour outcome. Every engine vote
  // and historical input used to explain it must precede the beginning of
  // that window; otherwise the retrospective would leak the answer backward.
  const featureCutoffIso = new Date(nowMs - OUTCOME_WINDOW_HOURS * 3600 * 1000).toISOString();
  const sinceIso = new Date(new Date(featureCutoffIso).getTime() - LOOKBACK_HOURS * 3600 * 1000).toISOString();
  console.log(`retrospective: scanning top ${SCAN_RANKS}; broad trigger >=${MIN_MOVE_PCT}%, favorite triggers use lagged own-range baselines`);

  const markets = await rescueMissingFavoriteMarkets(await scanMarkets());
  console.log(`retrospective: scanned ${markets.length} assets`);

  const favoriteBaselines = await loadFavoriteBaselines(nowIso, featureCutoffIso.slice(0, 10));
  const adaptiveCount = Object.values(favoriteBaselines).filter((b) => b.status === 'adaptive').length;
  console.log(`retrospective: ${adaptiveCount}/${FAVORITE_SYMBOLS.size} favorite baselines support a lower asset-relative threshold`);

  // Rank as fetched, so "was this in the engine's universe" is answered by
  // the ranking, not guessed. Note the subtlety the ARB case exposed: a
  // big mover's rank AFTER the move overstates where it sat BEFORE it —
  // ARB read rank 85 once it was already +34%, having started the day
  // around the rank-96 boundary. Recorded as observed, with that caveat
  // carried in the row rather than silently smoothed over.
  // CoinGecko's own market_cap_rank when present, array position only as a
  // fallback. The two agree in the normal case, but the API's figure
  // survives a dropped or duplicated row in a way an index cannot.
  const ranked = markets.map((c, i) => ({ c, rank: c.market_cap_rank || (i + 1) }));

  const movers = ranked.flatMap(({ c, rank }) => {
    const chg = c.price_change_percentage_24h;
    const symbol = String(c.symbol || '').toUpperCase();
    const trigger = retrospectiveTrigger({
      symbol,
      movePct: chg,
      baseline: favoriteBaselines[symbol],
      globalThreshold: MIN_MOVE_PCT
    });
    if (!trigger.triggered) return [];
    // A peg that "moves" 12% is a depeg — a real and important event, but
    // not a missed directional call, and it belongs in the stablecoin
    // research lane rather than in this ledger. See isNonDirectionalAsset.
    const spark = ((c.sparkline_in_7d || {}).price || []).filter((v) => v != null);
    return isNonDirectionalAsset(c, spark) ? [] : [{ c, rank, trigger }];
  });
  console.log(`retrospective: ${movers.length} unusual-move episodes selected without using post-outcome inputs`);
  const moverSymbols = movers.map(({ c }) => (c.symbol || '').toUpperCase());

  // This path runs even on a quiet day. Missing-move research alone is
  // outcome-conditioned; a predictive lead/lag study needs the ordinary days
  // and failed setups too. If no complete point-in-time frame exists, record
  // nothing and say so instead of filling the gap with current data.
  const leadLagInputs = await loadPointInTimeLeadLagInputs(featureCutoffIso);
  const leadLagSnapshot = buildLeadLagDailySnapshot({
    runAt: nowIso,
    windowStartAt: featureCutoffIso,
    rankedMarkets: ranked,
    selectedRuns: leadLagInputs.selectedRuns,
    marketContextRows: leadLagInputs.marketContextRows
  });
  let seasonalLeadLag = { observations: 0, evidence: [] };
  if (leadLagSnapshot) {
    await writeLeadLagDailySnapshot(leadLagSnapshot);
    // Fixed before any outcomes are examined. Adding today's movers (or past
    // misses) after seeing their returns would be target-selection leakage.
    seasonalLeadLag = await refreshSeasonalLeadLagEvidence(nowIso, FAVORITE_SYMBOLS);
    console.log(`retrospective: archived all-outcome lead/lag frame for ${Object.keys(leadLagSnapshot.outcomes).length} assets at ${leadLagSnapshot.frames.length}/${RETRO_LEAD_LAG_HOURS.length} registered lags; ${seasonalLeadLag.evidence.length} seasonal/regime cells persisted`);
  } else {
    console.log('retrospective: no complete pre-window lead/lag frame; research lane abstained without substituting stale/current state');
  }
  if (!movers.length) {
    console.log('retrospective: nothing to explain this run — a clean sheet is a valid outcome, not a failure');
    return;
  }

  const tradable = await binanceGlobalTradablePairs().catch((e) => {
    console.error('binance global exchangeInfo failed, continuing without bar-level analysis:', e.message || e);
    return new Set();
  });
  console.log(`retrospective: binance global has ${tradable.size} tradable USDT pairs`);

  const engineSnapshot = await loadEngineStateBefore(moverSymbols, sinceIso, featureCutoffIso);
  if (!engineSnapshot) {
    console.log('retrospective: no exact pre-window publication snapshot yet; move attribution abstained instead of reconstructing a board');
  }
  const featureSnapshots = engineSnapshot
    ? await loadFeatureSnapshotsBefore(moverSymbols, featureCutoffIso)
    : {};

  const rows = [];
  for (const { c, rank, trigger } of movers) {
    // Publication snapshots begin with migration 0026. During the first warmup
    // day there is deliberately no substitute: endpoint ranks or composite
    // votes cannot truthfully reconstruct what a user saw.
    if (!engineSnapshot) continue;
    const symbol = (c.symbol || '').toUpperCase();
    const chg = c.price_change_percentage_24h;
    const moveDir = chg > 0 ? 1 : -1;
    // These two fields are retained as endpoint descriptors for compatibility;
    // neither participates in the causal grade below.
    const endpointInUniverse = rank <= CRYPTO_UNIVERSE;
    const endpointPassedFloors = (c.market_cap || 0) >= CRYPTO_MIN_MCAP && (c.total_volume || 0) >= CRYPTO_MIN_VOLUME;
    const prewindowInUniverse = engineSnapshot.universe.has(symbol);
    const state = engineSnapshot.states[symbol];
    const directions = state ? state.directions : [];
    const publicationState = !prewindowInUniverse ? 'not-in-universe'
      : directions.length > 1 ? 'conflicted'
        : directions.length === 1 ? 'published'
          : state && state.withheld ? 'withheld' : 'not-surfaced';

    let move = null;
    if (tradable.has(symbol)) {
      try {
        const bars = await binanceGlobalKlines(symbol, '1h', 200);
        move = describeMissedMove(bars, {
          moveDir,
          windowStartAt: featureCutoffIso,
          windowEndAt: nowIso
        });
      } catch (e) {
        console.error(`  ${symbol}: klines failed (${e.message || e})`);
      }
      await new Promise((r) => setTimeout(r, BINANCE_PACING_MS));
    }

    const cause = classifyMiss({
      inUniverse: prewindowInUniverse,
      // Endpoint floors are not causal. Omit them so absence from the exact
      // scored universe is described generically, without inventing why.
      passedFloors: null,
      onBoard: directions.length > 0,
      boardDirections: directions,
      withheld: !!state && state.withheld,
      moveDir,
      scoredAt: engineSnapshot.runAt,
      detectableAt: move ? move.detectableAt : null
    });

    rows.push({
      run_at: nowIso, symbol, name: c.name, asset_class: 'crypto',
      mcap_rank: rank, move_pct: chg, move_dir: moveDir,
      in_universe: endpointInUniverse ? 1 : 0, passed_floors: endpointPassedFloors ? 1 : 0,
      engine_dir: directions.length === 1 ? directions[0] : null,
      engine_score: state ? state.score : null,
      engine_first_seen_at: engineSnapshot.runAt,
      cause,
      detected: move ? (move.detected ? 1 : 0) : null,
      detectable_at: move && move.detected ? move.detectableAt : null,
      detectable_price: move && move.detected ? move.detectablePrice : null,
      surge_ratio: move && move.detected ? move.surgeRatio : null,
      trade_ratio: move && move.detected ? move.tradeRatio : null,
      lead_hours: move && move.detected ? move.leadHours : null,
      gain_to_peak_pct: move && move.detected ? move.gainToPeakPct : null,
      max_drawdown_pct: move && move.detected ? move.maxDrawdownPct : null,
      always_tracked: trigger.alwaysTracked ? 1 : 0,
      trigger_threshold_pct: trigger.thresholdPct,
      trigger_basis: trigger.basis,
      baseline_samples: trigger.baselineSamples,
      baseline_fit_through: trigger.baselineFitThrough,
      feature_cutoff_at: featureCutoffIso,
      prewindow_in_universe: prewindowInUniverse ? 1 : 0,
      publication_snapshot_at: engineSnapshot.runAt,
      publication_state: publicationState,
      state_basis: 'published-snapshot-v1'
    });

    const m = move
      ? (move.detected
        ? `vol ${move.surgeRatio.toFixed(1)}x/tr ${move.tradeRatio.toFixed(1)}x at ${move.detectableAt.slice(5, 16)}, +${move.gainToPeakPct.toFixed(1)}% available over ${move.leadHours}h`
        : (move.reason || 'NO volume warning'))
      : 'no global bars';
    console.log(`  ${symbol.padEnd(10)} rank ${String(rank).padStart(3)} ${chg >= 0 ? '+' : ''}${chg.toFixed(1)}%  threshold=${trigger.thresholdPct.toFixed(1)}% (${trigger.basis})  cause=${cause.padEnd(16)} ${m}`);
  }

  // Append-only ledger. Never updated in place: what the engine believed
  // on a given day is a historical fact, and rewriting it would destroy
  // exactly the record this job exists to build.
  await forEachConcurrent(chunk(rows, 20), 3, async (batch) => {
    for (const r of batch) {
      await d1(env, `
        INSERT INTO retrospective_misses
          (run_at, symbol, name, asset_class, mcap_rank, move_pct, move_dir, in_universe, passed_floors,
           engine_dir, engine_score, engine_first_seen_at, cause, detected, detectable_at, detectable_price,
           surge_ratio, trade_ratio, lead_hours, gain_to_peak_pct, max_drawdown_pct, always_tracked,
           trigger_threshold_pct, trigger_basis, baseline_samples, baseline_fit_through, feature_cutoff_at,
           prewindow_in_universe, publication_snapshot_at, publication_state, state_basis)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(run_at, symbol) DO NOTHING`,
        [r.run_at, r.symbol, r.name, r.asset_class, r.mcap_rank, r.move_pct, r.move_dir, r.in_universe, r.passed_floors,
         r.engine_dir, r.engine_score, r.engine_first_seen_at, r.cause, r.detected, r.detectable_at, r.detectable_price,
         r.surge_ratio, r.trade_ratio, r.lead_hours, r.gain_to_peak_pct, r.max_drawdown_pct, r.always_tracked,
         r.trigger_threshold_pct, r.trigger_basis, r.baseline_samples, r.baseline_fit_through, r.feature_cutoff_at,
         r.prewindow_in_universe, r.publication_snapshot_at, r.publication_state, r.state_basis]);
    }
  });

  const featureRows = buildMissFeatureSnapshotRows(rows, featureSnapshots);
  await writeFeatureSnapshots(featureRows);
  const correlationEvidence = await refreshFeatureCorrelations(nowIso);

  // The aggregate is the actual product. Recomputed wholesale from the
  // full ledger each run rather than incremented, so it always reflects
  // every row currently stored and can never drift from it.
  // Remove stale/legacy aggregates before rebuilding. Only exact publication
  // snapshots are eligible; the earlier reconstructed rows remain available
  // for audit but never influence current learning claims.
  await d1(env, 'DELETE FROM retrospective_patterns');
  const agg = await d1(env, `
    SELECT cause,
           COUNT(*)                AS n,
           AVG(ABS(move_pct))      AS avg_move_pct,
           AVG(gain_to_peak_pct)   AS avg_available_pct,
           AVG(lead_hours)         AS avg_lead_hours,
           SUM(COALESCE(detected, 0)) AS n_detected
      FROM retrospective_misses
     WHERE state_basis = 'published-snapshot-v1'
     GROUP BY cause`);
  const total = agg.reduce((a, r) => a + r.n, 0) || 1;
  for (const r of agg) {
    await d1(env, `
      INSERT INTO retrospective_patterns (cause, n, share, avg_move_pct, avg_available_pct, avg_lead_hours, n_detected, updated_at)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(cause) DO UPDATE SET
        n = excluded.n, share = excluded.share, avg_move_pct = excluded.avg_move_pct,
        avg_available_pct = excluded.avg_available_pct, avg_lead_hours = excluded.avg_lead_hours,
        n_detected = excluded.n_detected, updated_at = excluded.updated_at`,
      [r.cause, r.n, r.n / total, r.avg_move_pct, r.avg_available_pct, r.avg_lead_hours, r.n_detected, nowIso]);
  }

  console.log('\nretrospective: cumulative cause breakdown');
  for (const r of agg.sort((a, b) => b.n - a.n)) {
    console.log(`  ${r.cause.padEnd(16)} n=${String(r.n).padStart(4)} (${(r.n / total * 100).toFixed(0)}%)  avg move ${(r.avg_move_pct || 0).toFixed(1)}%  avg available from first tell ${(r.avg_available_pct || 0).toFixed(1)}%  avg lead ${(r.avg_lead_hours || 0).toFixed(0)}h`);
  }

  // Notify only on what is actionable: moves that WERE detectable in
  // advance and still were not called. A move with no volume warning is
  // not a lesson, it is just a move.
  const actionable = rows.filter((r) => r.cause !== 'caught' && r.detected === 1 && (r.gain_to_peak_pct || 0) >= MIN_ACTIONABLE_GAIN_PCT);
  if (actionable.length) {
    const top = actionable.sort((a, b) => (b.gain_to_peak_pct || 0) - (a.gain_to_peak_pct || 0)).slice(0, 5);
    await notify(
      `Retrospective: ${actionable.length} detectable move${actionable.length === 1 ? '' : 's'} missed`,
      top.map((r) => `${r.symbol} ${r.move_pct >= 0 ? '+' : ''}${r.move_pct.toFixed(0)}% — ${r.cause}; volume tell ${r.surge_ratio.toFixed(1)}x was visible ${Math.round(r.lead_hours)}h before the peak (+${r.gain_to_peak_pct.toFixed(0)}% from there)`).join('\n')
    );
  }
  console.log(`\nretrospective: ${rows.length} episodes recorded, ${actionable.length} were detectable-but-missed; ${featureRows.length} lagged technique observations across ${correlationEvidence.length} miss-conditioned cells; ${seasonalLeadLag.observations} all-outcome seasonal lead/lag observations across ${seasonalLeadLag.evidence.length} research-only cells`);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((e) => { console.error('retrospective failed:', e); process.exit(1); });
}
