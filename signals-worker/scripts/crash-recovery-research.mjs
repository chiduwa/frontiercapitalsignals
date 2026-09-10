// Bounded, incremental research on point-in-time crash-threshold crossings.
//
// This is intentionally NOT a bottom detector or a causal model. A candidate
// exists only when a completed daily close first crosses a fixed drawdown from
// a strictly trailing peak. The next daily close is a reproducible reference
// entry, not a claimed fill. Future lows and return milestones are labels only.
//
// The archive is a bounded current-universe sample and may omit dead/delisted
// assets. Bootstrap and prospective evidence are kept separate. Nothing here
// writes research_registry, model weights, signals, alerts, or orders, and the
// database constrains every live_edge_eligible value to zero.

import { pathToFileURL } from 'node:url';
import { d1, d1Batch, chunk } from './d1-client.mjs';

export const CRASH_RECOVERY_METHOD_VERSION = 'crash-recovery-pit-v1';
export const DEFAULT_CRASH_THRESHOLD_PCT = -30;
export const DEFAULT_PEAK_LOOKBACK_SESSIONS = 252;
export const DEFAULT_EVENT_COOLDOWN_SESSIONS = 63;
export const PUBLICATION_MAX_AGE_HOURS = 48;
export const HORIZONS_BY_ASSET_CLASS = Object.freeze({
  crypto: Object.freeze([365, 730]),
  stock: Object.freeze([252, 504])
});

const DAY_MS = 86_400_000;
const DEFAULT_MAX_SYMBOLS = 80;
const DEFAULT_MAX_BARS_PER_RUN = 120_000;
const DEFAULT_MAX_BARS_PER_SYMBOL = 4_000;
const DEFAULT_BOOTSTRAP_CALENDAR_DAYS = 3_650;
// Enough for a 730-day crypto outcome plus its 252-bar feature lookback, and
// for the equivalent stock-session path. Older still-pending rows widen it.
const DEFAULT_INCREMENTAL_CONTEXT_DAYS = 1_100;
const DEFAULT_MAX_PUBLICATION_LOOKUPS = 200;
const ASSOCIATION_MIN_DESCRIPTIVE_N = 20;
// Shared with the archive's lead/lag guard: a >21x close-to-close jump in one
// daily bar is treated as a source artifact, not capped into a plausible move.
const IMPLAUSIBLE_DAILY_RETURN_PCT = 2_000;

export function finiteNumber(value) {
  if (value == null) return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function isoDaysBefore(date, days) {
  const time = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(time)) throw new Error(`invalid UTC date: ${date}`);
  return new Date(time - days * DAY_MS).toISOString().slice(0, 10);
}

function exclusiveDayAfter(date) {
  return isoDaysBefore(date, -1);
}

function mean(values) {
  const xs = values.filter(Number.isFinite);
  return xs.length ? xs.reduce((sum, value) => sum + value, 0) / xs.length : null;
}

function median(values) {
  const xs = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!xs.length) return null;
  const middle = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[middle] : (xs[middle - 1] + xs[middle]) / 2;
}

function sampleStdev(values) {
  const xs = values.filter(Number.isFinite);
  if (xs.length < 2) return null;
  const avg = mean(xs);
  return Math.sqrt(xs.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (xs.length - 1));
}

function validUtcDay(value) {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const time = Date.parse(`${text}T00:00:00.000Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === text;
}

export function normalizeDailyBars(rows) {
  const byDate = new Map();
  for (const row of rows || []) {
    const close = finiteNumber(row && row.close);
    const date = String(row && row.date || '');
    if (!validUtcDay(date) || close == null || close <= 0) continue;
    byDate.set(date, {
      date,
      close,
      volume: finiteNumber(row.volume),
      source: row.source == null ? null : String(row.source)
    });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function boundedBarResult(rows, allowance) {
  const raw = Array.isArray(rows) ? rows : [];
  const keptRaw = raw.slice(0, allowance);
  const bars = normalizeDailyBars(keptRaw);
  let implausibleMoves = 0;
  for (let index = 1; index < bars.length; index++) {
    const move = returnPct(bars[index - 1].close, bars[index].close);
    if (move != null && Math.abs(move) > IMPLAUSIBLE_DAILY_RETURN_PCT) implausibleMoves++;
  }
  return {
    bars,
    truncated: raw.length > allowance,
    rejected: keptRaw.length - bars.length,
    implausibleMoves,
    rowsRead: raw.length
  };
}

// A truncation sentinel has to fit inside the declared physical read budget.
// When the query fills that budget, retain all but the final row and treat that
// row as proof that the requested range was not fully observed.
export function physicalBarReadPlan(physicalAllowance) {
  const queryLimit = Math.max(0, Math.floor(finiteNumber(physicalAllowance) ?? 0));
  return { queryLimit, usableAllowance: Math.max(0, queryLimit - 1) };
}

export function physicalBarReadResult(rows, physicalAllowance) {
  const plan = physicalBarReadPlan(physicalAllowance);
  const observed = (Array.isArray(rows) ? rows : []).slice(0, plan.queryLimit);
  return boundedBarResult(observed, plan.usableAllowance);
}

// A date with too little prior history can never become a valid historical
// signal merely because future bars arrive: every feature is point-in-time.
// It is therefore safe to rotate past the latest currently archived date; the
// incremental overlap will still examine every later potentially-valid date.
export function insufficientHistoryCheckpoint(bars, sourceMaxDate,
  requiredBars = DEFAULT_PEAK_LOOKBACK_SESSIONS + 2) {
  if (Array.isArray(bars) && bars.length >= requiredBars) return null;
  const latestLoaded = Array.isArray(bars) && bars.length ? bars[bars.length - 1].date : null;
  return validUtcDay(latestLoaded) ? latestLoaded
    : validUtcDay(sourceMaxDate) ? sourceMaxDate : null;
}

function returnPct(from, to) {
  return from > 0 && to > 0 ? (to / from - 1) * 100 : null;
}

export function drawdownDepthBucket(drawdownPct) {
  if (drawdownPct <= -55) return '55-plus';
  if (drawdownPct <= -40) return '40-to-55';
  return '30-to-40';
}

export function calendarCohort(date) {
  if (!validUtcDay(date)) return null;
  const month = Number(date.slice(5, 7));
  return `${date.slice(0, 4)}-Q${Math.floor((month - 1) / 3) + 1}`;
}

function benchmarkFrameAt(date, benchmarkBars) {
  if (!benchmarkBars.length) return { benchmarkReturn20Pct: null, benchmarkRegime: null };
  const index = benchmarkBars.findIndex((bar) => bar.date === date);
  if (index < 20) return { benchmarkReturn20Pct: null, benchmarkRegime: null };
  const value = returnPct(benchmarkBars[index - 20].close, benchmarkBars[index].close);
  return {
    benchmarkReturn20Pct: value,
    benchmarkRegime: value == null ? null : value > 0 ? 'up' : value < 0 ? 'down' : 'flat'
  };
}

function pointInTimeFeatures(bars, index, lookbackSessions, benchmarkBars) {
  const prior = bars.slice(index - lookbackSessions, index);
  if (prior.length !== lookbackSessions) return null;
  let trailingPeakClose = -Infinity;
  let trailingPeakIndex = -1;
  for (let offset = 0; offset < prior.length; offset++) {
    if (prior[offset].close >= trailingPeakClose) {
      trailingPeakClose = prior[offset].close;
      trailingPeakIndex = index - lookbackSessions + offset;
    }
  }
  if (!(trailingPeakClose > 0)) return null;
  const current = bars[index];
  const trailingReturn20Pct = index >= 20 ? returnPct(bars[index - 20].close, current.close) : null;
  const returns = [];
  for (let i = index - 19; i <= index; i++) {
    if (i < 1) continue;
    const value = returnPct(bars[i - 1].close, bars[i].close);
    if (value != null) returns.push(value);
  }
  const priorVolumes = bars.slice(index - 20, index)
    .map((bar) => bar.volume)
    .filter((value) => value != null && value > 0);
  const volumeBaseline = priorVolumes.length === 20 ? median(priorVolumes) : null;
  const sma200 = index >= 200 ? mean(bars.slice(index - 200, index).map((bar) => bar.close)) : null;
  const benchmark = benchmarkFrameAt(current.date, benchmarkBars);
  return {
    trailingPeakClose,
    drawdownPct: returnPct(trailingPeakClose, current.close),
    peakAgeSessions: index - trailingPeakIndex,
    trailingReturn20Pct,
    realizedVol20Pct: returns.length === 20 ? sampleStdev(returns) : null,
    volumeRatio20: volumeBaseline != null && current.volume != null && current.volume >= 0
      ? current.volume / volumeBaseline : null,
    distanceSma200Pct: sma200 == null ? null : returnPct(sma200, current.close),
    benchmarkReturn20Pct: benchmark.benchmarkReturn20Pct,
    relativeStrength20Pct: trailingReturn20Pct != null && benchmark.benchmarkReturn20Pct != null
      ? trailingReturn20Pct - benchmark.benchmarkReturn20Pct : null,
    benchmarkRegime: benchmark.benchmarkRegime
  };
}

function firstMultipleSession(path, entryClose, multiple) {
  for (let offset = 1; offset < path.length; offset++) {
    if (path[offset].close >= entryClose * multiple) return offset;
  }
  return null;
}

export function forwardOutcomeForSignal(bars, signalIndex, trailingPeakClose, horizonSessions, maturedAt) {
  const eligibleIndex = signalIndex + 1;
  if (eligibleIndex >= bars.length) return {
    horizonSessions, observedForwardSessions: 0, outcomeStatus: 'pending',
    outcomeLabel: null, recoveredPriorPeak: null, sessionsToRecovery: null,
    first2xSessions: null, first5xSessions: null, first10xSessions: null,
    first20xSessions: null, forwardTerminalReturnPct: null,
    forwardMaxReturnPct: null, forwardMaxAdversePct: null,
    hindsightLowClose: null, hindsightLowDate: null,
    sessionsToHindsightLow: null, maturedAt: null
  };
  const observedForwardSessions = Math.min(horizonSessions, bars.length - 1 - eligibleIndex);
  if (observedForwardSessions < horizonSessions) return {
    horizonSessions, observedForwardSessions, outcomeStatus: 'pending',
    outcomeLabel: null, recoveredPriorPeak: null, sessionsToRecovery: null,
    first2xSessions: null, first5xSessions: null, first10xSessions: null,
    first20xSessions: null, forwardTerminalReturnPct: null,
    forwardMaxReturnPct: null, forwardMaxAdversePct: null,
    hindsightLowClose: null, hindsightLowDate: null,
    sessionsToHindsightLow: null, maturedAt: null
  };
  const entry = bars[eligibleIndex];
  const path = bars.slice(eligibleIndex, eligibleIndex + horizonSessions + 1);
  let sessionsToRecovery = null;
  let lowOffset = 0;
  for (let offset = 0; offset < path.length; offset++) {
    if (sessionsToRecovery == null && path[offset].close >= trailingPeakClose) sessionsToRecovery = offset;
    if (path[offset].close < path[lowOffset].close) lowOffset = offset;
  }
  const returns = path.map((bar) => returnPct(entry.close, bar.close));
  const recovered = sessionsToRecovery != null;
  return {
    horizonSessions,
    observedForwardSessions: horizonSessions,
    outcomeStatus: 'matured',
    outcomeLabel: recovered ? 'recovered-prior-peak' : 'failed-recovery',
    recoveredPriorPeak: recovered ? 1 : 0,
    sessionsToRecovery,
    first2xSessions: firstMultipleSession(path, entry.close, 2),
    first5xSessions: firstMultipleSession(path, entry.close, 5),
    first10xSessions: firstMultipleSession(path, entry.close, 10),
    first20xSessions: firstMultipleSession(path, entry.close, 20),
    forwardTerminalReturnPct: returns[returns.length - 1],
    forwardMaxReturnPct: Math.max(...returns),
    forwardMaxAdversePct: Math.min(...returns),
    hindsightLowClose: path[lowOffset].close,
    hindsightLowDate: path[lowOffset].date,
    sessionsToHindsightLow: lowOffset,
    maturedAt
  };
}

export function detectCrashRecoveryEpisodes(rawBars, options = {}) {
  const bars = normalizeDailyBars(rawBars);
  const thresholdPct = finiteNumber(options.thresholdPct) ?? DEFAULT_CRASH_THRESHOLD_PCT;
  if (!(thresholdPct < 0 && thresholdPct > -100)) {
    throw new RangeError('crash threshold must be strictly between -100 and 0 percent');
  }
  const lookbackSessions = boundedInteger(options.lookbackSessions,
    DEFAULT_PEAK_LOOKBACK_SESSIONS, 20, 2_000);
  const cooldownSessions = boundedInteger(options.cooldownSessions,
    DEFAULT_EVENT_COOLDOWN_SESSIONS, 1, 2_000);
  const horizons = [...new Set((options.horizonSessions || [252])
    .map((value) => boundedInteger(value, 252, 1, 2_000)))].sort((a, b) => a - b);
  const maturedAt = options.maturedAt || new Date().toISOString();
  const benchmarkBars = normalizeDailyBars(options.benchmarkBars || []);
  const benchmarkSymbol = options.benchmarkSymbol || null;
  const episodes = [];
  let lastAcceptedIndex = -Infinity;
  for (let index = lookbackSessions + 1; index < bars.length; index++) {
    const frame = pointInTimeFeatures(bars, index, lookbackSessions, benchmarkBars);
    const priorFrame = pointInTimeFeatures(bars, index - 1, lookbackSessions, benchmarkBars);
    if (!frame || !priorFrame) continue;
    const crossed = frame.drawdownPct <= thresholdPct && priorFrame.drawdownPct > thresholdPct;
    if (!crossed || index - lastAcceptedIndex < cooldownSessions) continue;
    lastAcceptedIndex = index;
    const entry = bars[index + 1] || null;
    episodes.push({
      signalDate: bars[index].date,
      eligibleAt: entry && entry.date,
      featureCutoffDate: bars[index].date,
      signalClose: bars[index].close,
      referenceEntryClose: entry && entry.close,
      signalSource: bars[index].source,
      entrySource: entry && entry.source,
      thresholdPct,
      peakLookbackSessions: lookbackSessions,
      trailingPeakClose: frame.trailingPeakClose,
      drawdownPct: frame.drawdownPct,
      peakAgeSessions: frame.peakAgeSessions,
      trailingReturn20Pct: frame.trailingReturn20Pct,
      realizedVol20Pct: frame.realizedVol20Pct,
      volumeRatio20: frame.volumeRatio20,
      distanceSma200Pct: frame.distanceSma200Pct,
      benchmarkSymbol,
      benchmarkReturn20Pct: frame.benchmarkReturn20Pct,
      relativeStrength20Pct: frame.relativeStrength20Pct,
      benchmarkRegime: frame.benchmarkRegime,
      depthBucket: drawdownDepthBucket(frame.drawdownPct),
      cohortId: calendarCohort(bars[index].date),
      outcomes: horizons.map((horizon) => forwardOutcomeForSignal(
        bars, index, frame.trailingPeakClose, horizon, maturedAt
      ))
    });
  }
  return episodes;
}

function numericBucket(value, cuts, labels) {
  if (!Number.isFinite(value)) return 'unavailable';
  for (let index = 0; index < cuts.length; index++) if (value <= cuts[index]) return labels[index];
  return labels[labels.length - 1];
}

export function publicationCallBucket(episode) {
  if (episode.publicationState === 'published') {
    return episode.publishedDirection === 1 ? 'published-long'
      : episode.publishedDirection === -1 ? 'published-short' : 'unavailable';
  }
  return episode.publicationState || 'unavailable';
}

export function associationFeatureBuckets(episode) {
  return [
    ['all-events', 'all'],
    ['drawdown-depth', episode.depthBucket],
    ['momentum-20', numericBucket(episode.trailingReturn20Pct, [-25, -10],
      ['loss-25-plus', 'loss-10-to-25', 'above-minus-10'])],
    ['realized-volatility-20', numericBucket(episode.realizedVol20Pct, [2, 5],
      ['up-to-2', '2-to-5', '5-plus'])],
    ['volume-ratio-20', numericBucket(episode.volumeRatio20, [0.8, 1.2],
      ['below-0.8', '0.8-to-1.2', '1.2-plus'])],
    ['distance-sma-200', numericBucket(episode.distanceSma200Pct, [-40, -20],
      ['below-40-plus', 'below-20-to-40', 'above-minus-20'])],
    ['benchmark-return-20', numericBucket(episode.benchmarkReturn20Pct, [-5, 0, 5],
      ['down-5-plus', 'down-0-to-5', 'up-0-to-5', 'up-5-plus'])],
    ['relative-strength-20', numericBucket(episode.relativeStrength20Pct, [-10, 0, 10],
      ['lag-10-plus', 'lag-0-to-10', 'lead-0-to-10', 'lead-10-plus'])],
    ['benchmark-regime', episode.benchmarkRegime || 'unavailable'],
    ['publication-call', publicationCallBucket(episode)]
  ];
}

export function decodePublicationForSymbol(row, symbol) {
  if (!row || !Number.isFinite(Date.parse(row.run_at))) return null;
  let universe;
  let boards;
  try {
    universe = JSON.parse(row.universe_json);
    boards = JSON.parse(row.boards_json);
  } catch {
    return null;
  }
  if (!Array.isArray(universe) || !Array.isArray(boards)) return null;
  const universeSet = new Set(universe.map((value) => String(value || '').toUpperCase()).filter(Boolean));
  const declared = finiteNumber(row.universe_count);
  if (declared != null && declared !== universeSet.size) return null;
  const wanted = String(symbol || '').toUpperCase();
  if (!universeSet.has(wanted)) return {
    publicationSnapshotAt: row.run_at, publicationState: 'not-in-universe',
    publishedDirection: null, publishedScore: null, publicationCallUsable: 0,
    publicationAlignmentReason: 'exact-pre-signal-snapshot:not-in-universe'
  };
  const matching = boards.filter((item) => String(item && item.symbol || '').toUpperCase() === wanted);
  const directions = [...new Set(matching.map((item) => finiteNumber(item && item.dir))
    .filter((direction) => direction === -1 || direction === 1))];
  const scores = matching.map((item) => finiteNumber(item && item.score))
    .filter((value) => value != null);
  const score = scores.length ? Math.max(...scores) : null;
  if (directions.length > 1) return {
    publicationSnapshotAt: row.run_at, publicationState: 'conflicted',
    publishedDirection: null, publishedScore: score, publicationCallUsable: 0,
    publicationAlignmentReason: 'exact-pre-signal-snapshot:conflicting-directions'
  };
  if (directions.length === 1) return {
    publicationSnapshotAt: row.run_at, publicationState: 'published',
    publishedDirection: directions[0], publishedScore: score, publicationCallUsable: 1,
    publicationAlignmentReason: 'exact-pre-signal-snapshot:published'
  };
  const state = matching.length ? 'withheld' : 'not-surfaced';
  return {
    publicationSnapshotAt: row.run_at, publicationState: state,
    publishedDirection: null, publishedScore: score, publicationCallUsable: 0,
    publicationAlignmentReason: `exact-pre-signal-snapshot:${state}`
  };
}

function unavailablePublication(reason) {
  return {
    publicationSnapshotAt: null, publicationState: 'unavailable',
    publishedDirection: null, publishedScore: null, publicationCallUsable: null,
    publicationAlignmentReason: reason
  };
}

export function createPublicationResolver(query, env, coverage, maxLookups) {
  const cache = new Map();
  let lookups = 0;
  let capped = false;
  return {
    async resolve(assetClass, symbol, signalDate) {
      const cutoff = `${signalDate}T00:00:00.000Z`;
      const classCoverage = coverage[assetClass];
      if (!classCoverage || !classCoverage.first_at || cutoff <= classCoverage.first_at) {
        return unavailablePublication('unavailable:no-exact-publication-history-before-signal');
      }
      const key = `${assetClass}|${signalDate}`;
      if (!cache.has(key)) {
        if (lookups >= maxLookups) {
          capped = true;
          return { deferred: true, reason: 'publication-lookup-resource-cap' };
        }
        lookups++;
        const since = new Date(Date.parse(cutoff) - PUBLICATION_MAX_AGE_HOURS * 3_600_000).toISOString();
        cache.set(key, query(env, `
          SELECT run_at, universe_json, boards_json, universe_count
          FROM signal_publication_snapshots
          WHERE asset_class = ? AND run_at >= ? AND run_at < ?
          ORDER BY run_at DESC LIMIT 1`, [assetClass, since, cutoff]));
      }
      const rows = await cache.get(key);
      if (!rows || !rows.length) {
        return unavailablePublication('unavailable:no-exact-pre-signal-snapshot-within-48h');
      }
      return decodePublicationForSymbol(rows[0], symbol)
        || unavailablePublication('unavailable:malformed-exact-publication-snapshot');
    },
    stats() { return { lookups, capped }; }
  };
}

export function checkpointBeforeSignal(bars, signalDate, priorCheckpoint = null) {
  const index = bars.findIndex((bar) => bar.date === signalDate);
  const candidate = index > 0 ? bars[index - 1].date : priorCheckpoint;
  if (!candidate) return null;
  return priorCheckpoint && candidate < priorCheckpoint ? priorCheckpoint : candidate;
}

function evidencePartition(signalDate, bootstrapThroughDate) {
  return signalDate <= bootstrapThroughDate ? 'bootstrap' : 'prospective';
}

function requireEnvironment() {
  const env = {
    CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
    CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
    FCS_D1_DATABASE_ID: process.env.FCS_D1_DATABASE_ID
  };
  for (const [name, value] of Object.entries(env)) if (!value) throw new Error(`Missing required env var: ${name}`);
  return env;
}

function runtimeConfig() {
  return {
    maxSymbols: boundedInteger(process.env.FCS_CRASH_SCAN_MAX_SYMBOLS, DEFAULT_MAX_SYMBOLS, 1, 300),
    maxBarsPerRun: boundedInteger(process.env.FCS_CRASH_SCAN_MAX_BARS,
      DEFAULT_MAX_BARS_PER_RUN, 1_000, 250_000),
    maxBarsPerSymbol: boundedInteger(process.env.FCS_CRASH_SCAN_MAX_BARS_PER_SYMBOL,
      DEFAULT_MAX_BARS_PER_SYMBOL, 600, 5_000),
    bootstrapDays: boundedInteger(process.env.FCS_CRASH_SCAN_BOOTSTRAP_DAYS,
      DEFAULT_BOOTSTRAP_CALENDAR_DAYS, 900, 5_000),
    incrementalContextDays: boundedInteger(process.env.FCS_CRASH_SCAN_CONTEXT_DAYS,
      DEFAULT_INCREMENTAL_CONTEXT_DAYS, 900, 2_000),
    maxPublicationLookups: boundedInteger(process.env.FCS_CRASH_SCAN_MAX_PUBLICATION_LOOKUPS,
      DEFAULT_MAX_PUBLICATION_LOOKUPS, 0, 1_000)
  };
}

async function loadUniverse(env, today) {
  return d1(env, `
    WITH metadata AS (
      SELECT symbol, asset_class, COUNT(*) AS bar_count,
             MIN(date) AS first_date, MAX(date) AS max_date
      FROM asset_daily_bars
      WHERE asset_class IN ('crypto', 'stock') AND date < ?
        AND symbol NOT LIKE 'SECTOR:%' AND symbol NOT LIKE 'MCAP:%'
        AND symbol NOT LIKE 'TVL:%'
      GROUP BY symbol, asset_class
      HAVING COUNT(*) >= ?
    ), clean AS (
      SELECT candidate.* FROM metadata candidate
      WHERE NOT EXISTS (
        SELECT 1 FROM metadata collision
        WHERE collision.symbol = candidate.symbol
          AND collision.asset_class <> candidate.asset_class
      )
    ), pending AS (
      SELECT outcomes.asset_class, outcomes.symbol, MIN(outcomes.signal_date) AS oldest_pending_date
      FROM crash_recovery_outcomes outcomes
      WHERE outcomes.method_version = ? AND outcomes.outcome_status = 'pending'
      GROUP BY outcomes.asset_class, outcomes.symbol
    )
    SELECT clean.*, checkpoints.last_scanned_signal_date,
           checkpoints.bootstrap_through_date, checkpoints.updated_at,
           pending.oldest_pending_date
    FROM clean
    LEFT JOIN crash_recovery_checkpoints checkpoints
      ON checkpoints.asset_class = clean.asset_class
     AND checkpoints.symbol = clean.symbol
     AND checkpoints.method_version = ?
    LEFT JOIN pending
      ON pending.asset_class = clean.asset_class AND pending.symbol = clean.symbol
    ORDER BY CASE WHEN checkpoints.updated_at IS NULL THEN 0 ELSE 1 END,
             checkpoints.updated_at ASC, clean.asset_class, clean.symbol`,
  [today, DEFAULT_PEAK_LOOKBACK_SESSIONS + 2,
    CRASH_RECOVERY_METHOD_VERSION, CRASH_RECOVERY_METHOD_VERSION]);
}

async function loadBars(env, assetClass, symbol, startDate, endExclusive, allowance) {
  const plan = physicalBarReadPlan(allowance);
  const rows = await d1(env, `
    SELECT date, close, volume, source
    FROM asset_daily_bars
    WHERE asset_class = ? AND symbol = ? AND date >= ? AND date < ?
    ORDER BY date ASC LIMIT ?`, [assetClass, symbol, startDate, endExclusive, plan.queryLimit]);
  return physicalBarReadResult(rows, plan.queryLimit);
}

function startDateFor(meta, today, config) {
  let start = meta.last_scanned_signal_date
    ? isoDaysBefore(meta.last_scanned_signal_date, config.incrementalContextDays)
    : isoDaysBefore(today, config.bootstrapDays);
  if (meta.oldest_pending_date && meta.oldest_pending_date < start) start = meta.oldest_pending_date;
  return start;
}

async function loadPublicationCoverage(env) {
  const rows = await d1(env, `SELECT asset_class, MIN(run_at) AS first_at, MAX(run_at) AS last_at
    FROM signal_publication_snapshots GROUP BY asset_class`);
  return Object.fromEntries(rows.map((row) => [row.asset_class, row]));
}

export function episodeInsertStatement(meta, episode, publication, bootstrapThroughDate, nowIso) {
  const columns = [
    'asset_class', 'symbol', 'signal_date', 'method_version', 'eligible_at',
    'feature_cutoff_date', 'signal_close', 'reference_entry_close', 'signal_source',
    'entry_source', 'threshold_pct', 'peak_lookback_sessions', 'trailing_peak_close',
    'drawdown_pct', 'peak_age_sessions', 'trailing_return_20_pct',
    'realized_vol_20_pct', 'volume_ratio_20', 'distance_sma_200_pct',
    'benchmark_symbol', 'benchmark_return_20_pct', 'relative_strength_20_pct',
    'benchmark_regime', 'depth_bucket', 'evidence_partition', 'cohort_id',
    'publication_snapshot_at', 'publication_state', 'published_direction',
    'published_score', 'publication_call_usable', 'publication_alignment_reason',
    'first_recorded_at', 'updated_at', 'scope_label', 'association_label'
  ];
  const params = [
    meta.asset_class, meta.symbol, episode.signalDate, CRASH_RECOVERY_METHOD_VERSION,
    episode.eligibleAt, episode.featureCutoffDate, episode.signalClose,
    episode.referenceEntryClose, episode.signalSource, episode.entrySource,
    episode.thresholdPct, episode.peakLookbackSessions, episode.trailingPeakClose,
    episode.drawdownPct, episode.peakAgeSessions, episode.trailingReturn20Pct,
    episode.realizedVol20Pct, episode.volumeRatio20, episode.distanceSma200Pct,
    episode.benchmarkSymbol, episode.benchmarkReturn20Pct,
    episode.relativeStrength20Pct, episode.benchmarkRegime, episode.depthBucket,
    evidencePartition(episode.signalDate, bootstrapThroughDate), episode.cohortId,
    publication.publicationSnapshotAt, publication.publicationState,
    publication.publishedDirection, publication.publishedScore,
    publication.publicationCallUsable, publication.publicationAlignmentReason,
    nowIso, nowIso, 'crash-threshold-crossing-not-bottom-or-cause',
    'association-not-causal'
  ];
  return {
    sql: `INSERT INTO crash_recovery_episodes (${columns.join(',')}, live_edge_eligible)
      VALUES (${params.map(() => '?').join(',')},0)
      ON CONFLICT(asset_class, symbol, signal_date, method_version) DO UPDATE SET
        eligible_at=COALESCE(crash_recovery_episodes.eligible_at, excluded.eligible_at),
        reference_entry_close=COALESCE(crash_recovery_episodes.reference_entry_close,
          excluded.reference_entry_close),
        entry_source=COALESCE(crash_recovery_episodes.entry_source, excluded.entry_source),
        updated_at=excluded.updated_at`,
    params
  };
}

export function outcomeUpsertStatement(meta, signalDate, outcome, nowIso) {
  const columns = [
    'asset_class', 'symbol', 'signal_date', 'method_version', 'horizon_sessions',
    'outcome_status', 'observed_forward_sessions', 'outcome_label',
    'recovered_prior_peak', 'sessions_to_recovery', 'first_2x_sessions',
    'first_5x_sessions', 'first_10x_sessions', 'first_20x_sessions',
    'forward_terminal_return_pct', 'forward_max_return_pct',
    'forward_max_adverse_pct', 'hindsight_low_close', 'hindsight_low_date',
    'sessions_to_hindsight_low', 'matured_at', 'first_recorded_at', 'updated_at',
    'outcome_only_label'
  ];
  const params = [
    meta.asset_class, meta.symbol, signalDate, CRASH_RECOVERY_METHOD_VERSION,
    outcome.horizonSessions, outcome.outcomeStatus, outcome.observedForwardSessions,
    outcome.outcomeLabel, outcome.recoveredPriorPeak, outcome.sessionsToRecovery,
    outcome.first2xSessions, outcome.first5xSessions, outcome.first10xSessions,
    outcome.first20xSessions, outcome.forwardTerminalReturnPct,
    outcome.forwardMaxReturnPct, outcome.forwardMaxAdversePct,
    outcome.hindsightLowClose, outcome.hindsightLowDate,
    outcome.sessionsToHindsightLow, outcome.maturedAt, nowIso, nowIso,
    'future-path-label-not-model-input'
  ];
  const updates = columns.slice(5).filter((column) => column !== 'first_recorded_at'
    && column !== 'outcome_only_label').map((column) => `${column}=excluded.${column}`).join(',');
  return {
    sql: `INSERT INTO crash_recovery_outcomes (${columns.join(',')}, live_edge_eligible)
      VALUES (${params.map(() => '?').join(',')},0)
      ON CONFLICT(asset_class, symbol, signal_date, method_version, horizon_sessions)
      DO UPDATE SET ${updates}
      WHERE crash_recovery_outcomes.outcome_status = 'pending'`,
    params
  };
}

function entryUpdateStatement(meta, signalDate, entry, nowIso) {
  return {
    sql: `UPDATE crash_recovery_episodes SET eligible_at=?, reference_entry_close=?,
      entry_source=?, updated_at=?
      WHERE asset_class=? AND symbol=? AND signal_date=? AND method_version=?
        AND eligible_at IS NULL`,
    params: [entry.date, entry.close, entry.source, nowIso, meta.asset_class,
      meta.symbol, signalDate, CRASH_RECOVERY_METHOD_VERSION]
  };
}

const ASSOCIATION_FEATURE_SQL = [
  ['all-events', "'all'"],
  ['drawdown-depth', 'episode.depth_bucket'],
  ['momentum-20', `CASE WHEN episode.trailing_return_20_pct IS NULL THEN 'unavailable'
    WHEN episode.trailing_return_20_pct <= -25 THEN 'loss-25-plus'
    WHEN episode.trailing_return_20_pct <= -10 THEN 'loss-10-to-25' ELSE 'above-minus-10' END`],
  ['realized-volatility-20', `CASE WHEN episode.realized_vol_20_pct IS NULL THEN 'unavailable'
    WHEN episode.realized_vol_20_pct <= 2 THEN 'up-to-2'
    WHEN episode.realized_vol_20_pct <= 5 THEN '2-to-5' ELSE '5-plus' END`],
  ['volume-ratio-20', `CASE WHEN episode.volume_ratio_20 IS NULL THEN 'unavailable'
    WHEN episode.volume_ratio_20 <= 0.8 THEN 'below-0.8'
    WHEN episode.volume_ratio_20 <= 1.2 THEN '0.8-to-1.2' ELSE '1.2-plus' END`],
  ['distance-sma-200', `CASE WHEN episode.distance_sma_200_pct IS NULL THEN 'unavailable'
    WHEN episode.distance_sma_200_pct <= -40 THEN 'below-40-plus'
    WHEN episode.distance_sma_200_pct <= -20 THEN 'below-20-to-40' ELSE 'above-minus-20' END`],
  ['benchmark-return-20', `CASE WHEN episode.benchmark_return_20_pct IS NULL THEN 'unavailable'
    WHEN episode.benchmark_return_20_pct <= -5 THEN 'down-5-plus'
    WHEN episode.benchmark_return_20_pct <= 0 THEN 'down-0-to-5'
    WHEN episode.benchmark_return_20_pct <= 5 THEN 'up-0-to-5' ELSE 'up-5-plus' END`],
  ['relative-strength-20', `CASE WHEN episode.relative_strength_20_pct IS NULL THEN 'unavailable'
    WHEN episode.relative_strength_20_pct <= -10 THEN 'lag-10-plus'
    WHEN episode.relative_strength_20_pct <= 0 THEN 'lag-0-to-10'
    WHEN episode.relative_strength_20_pct <= 10 THEN 'lead-0-to-10' ELSE 'lead-10-plus' END`],
  ['benchmark-regime', "COALESCE(episode.benchmark_regime, 'unavailable')"],
  ['publication-call', `CASE
    WHEN episode.publication_state='published' AND episode.published_direction=1 THEN 'published-long'
    WHEN episode.publication_state='published' AND episode.published_direction=-1 THEN 'published-short'
    ELSE episode.publication_state END`]
];

export function associationAggregationSql(bucketSql) {
  return `
    WITH labelled AS (
      SELECT episode.asset_class, outcome.horizon_sessions,
             episode.evidence_partition, ${bucketSql} AS feature_bucket,
             episode.symbol, episode.cohort_id, outcome.recovered_prior_peak,
             outcome.first_2x_sessions, outcome.first_5x_sessions,
             outcome.first_10x_sessions, outcome.first_20x_sessions,
             outcome.forward_terminal_return_pct, outcome.forward_max_return_pct,
             outcome.forward_max_adverse_pct
      FROM crash_recovery_episodes episode
      JOIN crash_recovery_outcomes outcome
        ON outcome.asset_class=episode.asset_class AND outcome.symbol=episode.symbol
       AND outcome.signal_date=episode.signal_date
       AND outcome.method_version=episode.method_version
      WHERE episode.method_version=? AND outcome.outcome_status='matured'
    ), scoped AS (
      SELECT * FROM labelled
      UNION ALL
      SELECT asset_class, horizon_sessions, 'all', feature_bucket, symbol,
             cohort_id, recovered_prior_peak, first_2x_sessions,
             first_5x_sessions, first_10x_sessions, first_20x_sessions,
             forward_terminal_return_pct, forward_max_return_pct,
             forward_max_adverse_pct FROM labelled
    )
    SELECT asset_class, horizon_sessions, evidence_partition, feature_bucket,
           COUNT(*) AS n, COUNT(DISTINCT symbol) AS unique_symbols,
           COUNT(DISTINCT cohort_id) AS unique_cohorts,
           SUM(recovered_prior_peak) AS recovered_n,
           SUM(first_2x_sessions IS NOT NULL) AS reached_2x_n,
           SUM(first_5x_sessions IS NOT NULL) AS reached_5x_n,
           SUM(first_10x_sessions IS NOT NULL) AS reached_10x_n,
           SUM(first_20x_sessions IS NOT NULL) AS reached_20x_n,
           AVG(forward_terminal_return_pct) AS avg_terminal_return_pct,
           AVG(forward_max_return_pct) AS avg_max_return_pct,
           AVG(forward_max_adverse_pct) AS avg_max_adverse_pct
    FROM scoped
    GROUP BY asset_class, horizon_sessions, evidence_partition, feature_bucket`;
}

async function refreshAssociations(env, nowIso) {
  const aggregated = [];
  for (const [featureName, bucketSql] of ASSOCIATION_FEATURE_SQL) {
    const rows = await d1(env, associationAggregationSql(bucketSql),
    [CRASH_RECOVERY_METHOD_VERSION]);
    aggregated.push(...rows.map((row) => ({ ...row, feature_name: featureName })));
  }
  const statements = aggregated.map((row) => {
    const n = Number(row.n);
    const recovered = Number(row.recovered_n);
    return {
      sql: `INSERT INTO crash_recovery_associations (
        method_version, asset_class, horizon_sessions, evidence_partition,
        feature_name, feature_bucket, n, unique_symbols, unique_cohorts,
        recovered_n, failed_n, recovery_rate, reached_2x_n, reached_5x_n,
        reached_10x_n, reached_20x_n, avg_terminal_return_pct,
        avg_max_return_pct, avg_max_adverse_pct, updated_at, evidence_label,
        live_edge_eligible)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'raw-descriptive-association-not-causal',0)
      ON CONFLICT(method_version, asset_class, horizon_sessions,
        evidence_partition, feature_name, feature_bucket) DO UPDATE SET
        n=excluded.n, unique_symbols=excluded.unique_symbols,
        unique_cohorts=excluded.unique_cohorts, recovered_n=excluded.recovered_n,
        failed_n=excluded.failed_n, recovery_rate=excluded.recovery_rate,
        reached_2x_n=excluded.reached_2x_n, reached_5x_n=excluded.reached_5x_n,
        reached_10x_n=excluded.reached_10x_n, reached_20x_n=excluded.reached_20x_n,
        avg_terminal_return_pct=excluded.avg_terminal_return_pct,
        avg_max_return_pct=excluded.avg_max_return_pct,
        avg_max_adverse_pct=excluded.avg_max_adverse_pct,
        updated_at=excluded.updated_at`,
      params: [CRASH_RECOVERY_METHOD_VERSION, row.asset_class,
        Number(row.horizon_sessions), row.evidence_partition, row.feature_name,
        row.feature_bucket, n, Number(row.unique_symbols), Number(row.unique_cohorts),
        recovered, n - recovered, recovered / n, Number(row.reached_2x_n),
        Number(row.reached_5x_n), Number(row.reached_10x_n),
        Number(row.reached_20x_n), finiteNumber(row.avg_terminal_return_pct),
        finiteNumber(row.avg_max_return_pct), finiteNumber(row.avg_max_adverse_pct), nowIso]
    };
  });
  for (const group of chunk(statements, 50)) await d1Batch(env, group);
  await d1(env, `DELETE FROM crash_recovery_associations
    WHERE method_version=? AND updated_at<>?`, [CRASH_RECOVERY_METHOD_VERSION, nowIso]);
  return {
    rows: statements.length,
    sufficientRows: aggregated.filter((row) => Number(row.n) >= ASSOCIATION_MIN_DESCRIPTIVE_N).length
  };
}

function checkpointStatement(meta, throughDate, bootstrapThrough, sourceMaxDate, nowIso) {
  return {
    sql: `INSERT INTO crash_recovery_checkpoints (
      asset_class, symbol, method_version, last_scanned_signal_date,
      bootstrap_through_date, cohort_id, source_max_date, updated_at)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(asset_class, symbol, method_version) DO UPDATE SET
      last_scanned_signal_date=excluded.last_scanned_signal_date,
      source_max_date=excluded.source_max_date, updated_at=excluded.updated_at`,
    params: [meta.asset_class, meta.symbol, CRASH_RECOVERY_METHOD_VERSION,
      throughDate, bootstrapThrough, `bootstrap-through:${bootstrapThrough}`,
      sourceMaxDate, nowIso]
  };
}

async function executeScanner() {
  const env = requireEnvironment();
  const config = runtimeConfig();
  const nowIso = new Date().toISOString();
  const today = nowIso.slice(0, 10);
  const runId = nowIso;
  await d1(env, `INSERT INTO crash_recovery_runs
    (run_id, method_version, status, started_at, live_edge_eligible)
    VALUES (?,?,'running',?,0)`, [runId, CRASH_RECOVERY_METHOD_VERSION, nowIso]);

  let symbolsConsidered = 0;
  let symbolsProcessed = 0;
  let symbolsDeferred = 0;
  let symbolsInsufficientHistory = 0;
  let barsRead = 0;
  let episodesSeen = 0;
  const capReasons = [];
  try {
    const universe = await loadUniverse(env, today);
    symbolsConsidered = universe.length;
    const selected = universe.slice(0, config.maxSymbols);
    if (universe.length > selected.length) capReasons.push(`symbol-cap:${config.maxSymbols}`);
    const coverage = await loadPublicationCoverage(env);
    const publications = createPublicationResolver(d1, env, coverage, config.maxPublicationLookups);

    const starts = selected.map((meta) => startDateFor(meta, today, config));
    const benchmarkStart = starts.length
      ? starts.reduce((earliest, value) => value < earliest ? value : earliest)
      : isoDaysBefore(today, config.incrementalContextDays);
    const benchmarkByClass = {};
    const unavailableBenchmarkClasses = new Set();
    for (const [assetClass, symbol] of [['crypto', 'BTC'], ['stock', 'SPY']]) {
      const benchmarkMeta = universe.find((row) =>
        row.asset_class === assetClass && row.symbol === symbol);
      if (!benchmarkMeta?.max_date) {
        unavailableBenchmarkClasses.add(assetClass);
        capReasons.push(`${assetClass}-benchmark-missing-from-frozen-universe`);
        continue;
      }
      const remaining = config.maxBarsPerRun - barsRead;
      const allowance = Math.min(config.maxBarsPerSymbol, remaining);
      if (allowance < DEFAULT_PEAK_LOOKBACK_SESSIONS + 2) {
        unavailableBenchmarkClasses.add(assetClass);
        capReasons.push(`bar-cap-before-${assetClass}-benchmark:${config.maxBarsPerRun}`);
        continue;
      }
      const loaded = await loadBars(env, assetClass, symbol,
        isoDaysBefore(benchmarkStart, 40), exclusiveDayAfter(benchmarkMeta.max_date), allowance);
      barsRead += loaded.rowsRead;
      if (loaded.truncated || loaded.rejected || loaded.implausibleMoves) {
        unavailableBenchmarkClasses.add(assetClass);
        capReasons.push(`${assetClass}-benchmark-${loaded.truncated ? 'truncated' : 'invalid-bars'}`);
      } else {
        benchmarkByClass[assetClass] = { symbol, bars: loaded.bars };
      }
    }

    for (const meta of selected) {
      if (unavailableBenchmarkClasses.has(meta.asset_class)) {
        symbolsDeferred++;
        continue;
      }
      const remaining = config.maxBarsPerRun - barsRead;
      const allowance = Math.min(config.maxBarsPerSymbol, remaining);
      if (allowance < DEFAULT_PEAK_LOOKBACK_SESSIONS + 2) {
        capReasons.push(`bar-cap:${config.maxBarsPerRun}`);
        symbolsDeferred += selected.length - symbolsProcessed - symbolsDeferred;
        break;
      }
      const startDate = startDateFor(meta, today, config);
      // Freeze the initial universe query's per-symbol high-water mark. Rows
      // appended by a concurrent delayed archive job are considered on the
      // next incremental run instead of giving later symbols fresher evidence
      // than earlier ones in this run.
      const loaded = await loadBars(env, meta.asset_class, meta.symbol, startDate,
        exclusiveDayAfter(meta.max_date), allowance);
      barsRead += loaded.rowsRead;
      if (loaded.truncated || loaded.rejected || loaded.implausibleMoves) {
        symbolsDeferred++;
        capReasons.push(`${meta.asset_class}:${meta.symbol}:${loaded.truncated ? 'truncated-range' : 'invalid-bars'}`);
        continue;
      }
      const bars = loaded.bars;
      const bootstrapThrough = meta.bootstrap_through_date || meta.max_date;
      const sparseCheckpoint = insufficientHistoryCheckpoint(bars, meta.max_date);
      if (sparseCheckpoint) {
        await d1Batch(env, [checkpointStatement(meta, sparseCheckpoint,
          bootstrapThrough, sparseCheckpoint, nowIso)]);
        symbolsProcessed++;
        symbolsInsufficientHistory++;
        continue;
      }
      const benchmark = benchmarkByClass[meta.asset_class] || { symbol: null, bars: [] };
      const detected = detectCrashRecoveryEpisodes(bars, {
        benchmarkBars: benchmark.bars,
        benchmarkSymbol: benchmark.symbol,
        horizonSessions: HORIZONS_BY_ASSET_CLASS[meta.asset_class],
        maturedAt: nowIso
      });
      const newEpisodes = detected.filter((episode) => !meta.last_scanned_signal_date
        || episode.signalDate > meta.last_scanned_signal_date);
      let checkpointThrough = bars[bars.length - 1].date;
      const statements = [];
      for (const episode of newEpisodes) {
        const publication = await publications.resolve(meta.asset_class, meta.symbol, episode.signalDate);
        if (publication.deferred) {
          checkpointThrough = checkpointBeforeSignal(bars, episode.signalDate,
            meta.last_scanned_signal_date);
          capReasons.push(`publication-lookup-cap:${config.maxPublicationLookups}`);
          symbolsDeferred++;
          break;
        }
        statements.push(episodeInsertStatement(meta, episode, publication, bootstrapThrough, nowIso));
        for (const outcome of episode.outcomes) {
          statements.push(outcomeUpsertStatement(meta, episode.signalDate, outcome, nowIso));
        }
        episodesSeen++;
      }

      const storedPending = await d1(env, `
        SELECT outcome.signal_date, outcome.horizon_sessions,
               episode.trailing_peak_close, episode.eligible_at
        FROM crash_recovery_outcomes outcome
        JOIN crash_recovery_episodes episode
          ON episode.asset_class=outcome.asset_class AND episode.symbol=outcome.symbol
         AND episode.signal_date=outcome.signal_date
         AND episode.method_version=outcome.method_version
        WHERE outcome.asset_class=? AND outcome.symbol=?
          AND outcome.method_version=? AND outcome.outcome_status='pending'`,
      [meta.asset_class, meta.symbol, CRASH_RECOVERY_METHOD_VERSION]);
      const indexByDate = new Map(bars.map((bar, index) => [bar.date, index]));
      const entryUpdates = new Set();
      for (const pending of storedPending) {
        const signalIndex = indexByDate.get(pending.signal_date);
        if (signalIndex == null) continue;
        const outcome = forwardOutcomeForSignal(bars, signalIndex,
          Number(pending.trailing_peak_close), Number(pending.horizon_sessions), nowIso);
        statements.push(outcomeUpsertStatement(meta, pending.signal_date, outcome, nowIso));
        const entry = bars[signalIndex + 1];
        if (!pending.eligible_at && entry && !entryUpdates.has(pending.signal_date)) {
          statements.push(entryUpdateStatement(meta, pending.signal_date, entry, nowIso));
          entryUpdates.add(pending.signal_date);
        }
      }
      for (const group of chunk(statements, 50)) await d1Batch(env, group);
      if (checkpointThrough) {
        await d1Batch(env, [checkpointStatement(meta, checkpointThrough,
          bootstrapThrough, bars[bars.length - 1].date, nowIso)]);
        symbolsProcessed++;
      }
    }

    const publicationStats = publications.stats();
    if (publicationStats.capped
      && !capReasons.some((reason) => reason.startsWith('publication-lookup-cap'))) {
      capReasons.push(`publication-lookup-cap:${config.maxPublicationLookups}`);
    }
    const association = await refreshAssociations(env, nowIso);
    const outcomeCounts = await d1(env, `SELECT outcome_status, COUNT(*) AS n
      FROM crash_recovery_outcomes WHERE method_version=? GROUP BY outcome_status`,
    [CRASH_RECOVERY_METHOD_VERSION]);
    const byStatus = Object.fromEntries(outcomeCounts.map((row) => [row.outcome_status, Number(row.n)]));
    const status = capReasons.length ? 'resource-capped' : 'completed';
    const completedAt = new Date().toISOString();
    await d1(env, `UPDATE crash_recovery_runs SET status=?, completed_at=?,
      symbols_considered=?, symbols_processed=?, symbols_deferred=?, bars_read=?,
      episodes_seen=?, outcomes_pending=?, outcomes_matured=?, error_summary=?
      WHERE run_id=?`, [status, completedAt, symbolsConsidered, symbolsProcessed,
      symbolsDeferred, barsRead, episodesSeen, byStatus.pending || 0,
      byStatus.matured || 0, capReasons.length
        ? JSON.stringify({ caps: [...new Set(capReasons)] }) : null, runId]);
    console.log(JSON.stringify({
      runId, status, symbolsConsidered, symbolsProcessed, symbolsDeferred,
      barsRead, episodesSeen, outcomesPending: byStatus.pending || 0,
      outcomesMatured: byStatus.matured || 0, associationRows: association.rows,
      associationRowsWithAtLeast20: association.sufficientRows,
      publicationLookups: publicationStats.lookups,
      symbolsInsufficientHistory,
      capReasons: [...new Set(capReasons)], liveEdgeEligible: false,
      scope: 'bounded-current-archive-crash-threshold-association-not-bottom-or-cause'
    }));
  } catch (error) {
    const message = error && error.stack ? error.stack.slice(0, 2_000) : String(error);
    await d1(env, `UPDATE crash_recovery_runs SET status='failed', completed_at=?,
      symbols_considered=?, symbols_processed=?, symbols_deferred=?, bars_read=?,
      episodes_seen=?, error_summary=? WHERE run_id=?`, [new Date().toISOString(),
      symbolsConsidered, symbolsProcessed, symbolsDeferred, barsRead,
      episodesSeen, message, runId]).catch(() => {});
    throw error;
  }
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) executeScanner().catch((error) => {
  console.error('crash-recovery research failed:', error);
  process.exit(1);
});
