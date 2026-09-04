// D1-backed reliability learning loop for the confluence engine. Runs from
// build-signals.mjs (plain Node, GitHub Actions) — the Worker itself never
// touches D1, only the hourly build needs this, not request-time serving.
// Talks to Cloudflare's D1 HTTP API directly via d1-client.mjs, shared with
// the archive/backfill scripts so there's one D1 client, not a hand-copied
// duplicate that could drift.
import { MIN_RELIABILITY_SAMPLES, slotsForTimestamp, assetPredictionScore, scoreBucket, TOD_HORIZONS_HOURS, detectCallFlips, lowerConfidenceBound } from '../worker.js';
import { d1, d1Batch, chunk, forEachConcurrent } from './d1-client.mjs';
import { computeSwingTimeTallies, upsertSwingTimeStats } from './archive.mjs';

// Matches the horizons timeOfDaySignal (worker.js) checks.
// How far a logged asset_price_log row is allowed to sit from the ideal
// "horizon hours ago" instant and still count as that horizon's
// observation — the hourly cadence isn't perfectly on-the-hour (see
// signals-refresh.yml's :13-past note), so this tolerates normal jitter
// while still rejecting a genuinely skipped cycle (which just means that
// horizon is skipped this run, not mismeasured).
const TOD_MATCH_TOLERANCE_MIN = 40;

const HORIZONS_HOURS = [24, 168];
const EVAL_COLUMN = { 24: 'evaluated_24', 168: 'evaluated_168' };
// A completed forecast must be measured at its intended horizon, not at an
// arbitrary later refresh. This allows normal scheduler jitter while rejecting
// multi-hour gaps that would otherwise contaminate the learning record.
const MATURITY_MATCH_MAX_LAG_MINUTES = 90;
// A move smaller than this counts as "flat" (actual_dir 0), not a win for
// either directional call — mirrors the deadband idea already used
// elsewhere in the engine (e.g. Donchian's 3% proximity bands).
const OUTCOME_DEADBAND_PCT = 0.5;
// Rows per multi-row statement. D1's actual limit is 100 bound parameters
// per query (not SQLite's classic ~999) — confirmed live after a real run
// hit "too many SQL variables" at CHUNK=100 (100 rows x 5 cols = 500
// params on the technique_votes insert). 15 rows x 5 cols = 75 keeps a
// comfortable margin under the ceiling for the widest table (votes);
// narrower queries here (IN()-clause selects/updates at 1 param/item) stay
// well under it too, at the cost of a few more round trips, which D1's
// free tier has plenty of headroom for.
const CHUNK = 15;
// technique_votes' own insert is wider than CHUNK was sized for (7 columns
// now, after score + regime) — see its own comment at the write site.
const VOTES_CHUNK = 14;
// Keep enough write requests in flight to finish a full vote log promptly,
// without blasting Cloudflare's shared D1 REST API with hundreds at once.
const D1_WRITE_CONCURRENCY = 4;
// A bit past the longer 168h horizon, for the price-log join plus buffer.
const RETENTION_HOURS = 200;
// Hard cap regardless of evaluated status, so a symbol that drops out of
// the universe (delisted stock, coin falls out of top-100) can't leave
// orphaned rows growing forever.
const HARD_CAP_HOURS = 24 * 30;
// forecast_outcomes has 23 writable columns including exact target/observation
// provenance, within-window extrema, and model/label versions. Four rows use
// 92 bound values, safely
// below D1's real 100-parameter ceiling.
const OUTCOME_INSERT_CHUNK = 4;
export const OUTCOME_MODEL_VERSION = 'confluence-v7';
export const OUTCOME_LABEL_VERSION = 'direction-deadband-0.5pct-v1';
// A composite outcome expands to at most five statements (base reliability,
// regime, pooled calibration, detailed calibration, ledger commit). Eight
// outcomes therefore stay comfortably bounded while amortizing REST latency.
const OUTCOME_AGGREGATE_CHUNK = 8;

function outcomeSeriesIdentity(row) {
  return `${row.asset_class}|${row.symbol}|${row.horizon_minutes}|${row.series_kind}|${row.series_key}`;
}

// Partitions a time-ordered stream into statistically independent forecast
// windows. A 24h forecast repeated hourly is one usable trial per 24h, not 24
// trials whose outcomes share almost the entire price path. `lastAcceptedByKey`
// may come from the permanent outcome ledger, making the rule stable across
// process restarts. The input and prior-state object are never mutated.
export function selectNonOverlappingForecasts(
  rows,
  horizonMinutes,
  lastAcceptedByKey = {},
  keyOf = outcomeSeriesIdentity,
  timeField = 'run_at'
) {
  const gapMs = Number(horizonMinutes) * 60 * 1000;
  const last = { ...lastAcceptedByKey };
  const accepted = [];
  const skipped = [];
  if (!Array.isArray(rows) || !(gapMs > 0)) return { accepted, skipped: Array.isArray(rows) ? rows.slice() : [], lastAcceptedByKey: last };

  const sorted = rows.slice().sort((a, b) => Date.parse(a && a[timeField]) - Date.parse(b && b[timeField]));
  for (const row of sorted) {
    const at = Date.parse(row && row[timeField]);
    const key = keyOf(row);
    if (!Number.isFinite(at) || !key) {
      skipped.push(row);
      continue;
    }
    const previous = Date.parse(last[key]);
    if (Number.isFinite(previous) && at - previous < gapMs) {
      skipped.push(row);
      continue;
    }
    accepted.push(row);
    last[key] = new Date(at).toISOString();
  }
  return { accepted, skipped, lastAcceptedByKey: last };
}

// Returns { blended, byHorizon }. `blended` averages each horizon's hit rate
// but uses only the deepest horizon as its effective sample size: 24h and
// 168h outcomes from the same forecast are related evidence, not two
// independent calls. `byHorizon` keeps 24h and 168h separate — this is what
// confluence()'s horizonEstimate() uses to answer "at which horizon has
// this asset's own history actually been more accurate," which a blended
// number can't answer.
export async function loadReliability(env) {
  const rows = await d1(env, `
    SELECT asset_class, symbol, series_key AS technique_id,
           horizon_minutes / 60 AS horizon_hours,
           SUM(correct) AS correct, COUNT(*) AS total,
           SUM(CASE WHEN dir = 1 THEN 1 ELSE 0 END) AS votes_up,
           SUM(CASE WHEN dir = -1 THEN 1 ELSE 0 END) AS votes_down
    FROM forecast_outcomes
    WHERE series_kind = 'technique' AND aggregated = 1
      AND model_version = ? AND label_version = ?
    GROUP BY asset_class, symbol, series_key, horizon_minutes
  `, [OUTCOME_MODEL_VERSION, OUTCOME_LABEL_VERSION]);
  const acc = {};
  const byHorizon = { 24: {}, 168: {} };
  for (const r of rows) {
    const key = `${r.symbol}|${r.technique_id}`;
    if (!acc[key]) acc[key] = { records: [], votes_up: 0, votes_down: 0 };
    acc[key].records.push(r);
    acc[key].votes_up += r.votes_up || 0;
    acc[key].votes_down += r.votes_down || 0;
    if (byHorizon[r.horizon_hours]) {
      byHorizon[r.horizon_hours][key] = {
        correct: r.correct, total: r.total,
        votes_up: r.votes_up || 0, votes_down: r.votes_down || 0
      };
    }
  }
  const blended = {};
  for (const [key, v] of Object.entries(acc)) {
    const accuracy = v.records.reduce((sum, r) => sum + r.correct / r.total, 0) / v.records.length;
    const total = Math.max(...v.records.map((r) => r.total));
    const rawDirectional = v.votes_up + v.votes_down;
    blended[key] = {
      correct: accuracy * total,
      accuracy,
      total,
      votes_up: rawDirectional ? total * v.votes_up / rawDirectional : 0,
      votes_down: rawDirectional ? total * v.votes_down / rawDirectional : 0
    };
  }
  // Publication and timing need the exact asset + side + horizon record.
  // The legacy aggregate table does not contain direction, so derive these
  // cells from the append-only ledger instead of treating a symbol's long and
  // short outcomes as interchangeable evidence.
  const directionalRows = await d1(env, `
    SELECT asset_class, symbol, series_key AS technique_id, dir,
           horizon_minutes / 60 AS horizon_hours,
           AVG(correct) AS accuracy, COUNT(*) AS total,
           COUNT(DISTINCT substr(run_at, 1, 10)) AS effective_samples
    FROM forecast_outcomes
    WHERE series_kind = 'technique' AND aggregated = 1 AND dir IN (-1, 1)
      AND model_version = ? AND label_version = ?
    GROUP BY asset_class, symbol, series_key, dir, horizon_minutes
  `, [OUTCOME_MODEL_VERSION, OUTCOME_LABEL_VERSION]);
  for (const row of directionalRows) {
    const horizon = Number(row.horizon_hours);
    if (!byHorizon[horizon]) continue;
    const accuracy = Number(row.accuracy);
    const total = Number(row.total);
    const effectiveSamples = Math.min(total, Number(row.effective_samples) || total);
    byHorizon[horizon][`${row.asset_class}|${row.symbol}|${row.technique_id}|${row.dir}`] = {
      correct: accuracy * total, total, accuracy, effectiveSamples
    };
  }
  return { blended, byHorizon };
}

// Realized up/flat/down frequencies per asset class, keyed both per horizon
// ("crypto|24") and pooled across horizons ("crypto|all") for the blended
// records loadReliability returns. This is the no-skill line every
// significance test and weight in worker.js is judged against — see
// noSkillBaseline there, and migrations/0003_direction_baseline.sql for why
// a hardcoded 0.5 was wrong.
export async function loadDirectionBaselines(env) {
  const rows = await d1(env, `
    SELECT asset_class, horizon_minutes / 60 AS horizon_hours,
           SUM(CASE WHEN actual_dir = 1 THEN 1 ELSE 0 END) AS n_up,
           SUM(CASE WHEN actual_dir = 0 THEN 1 ELSE 0 END) AS n_flat,
           SUM(CASE WHEN actual_dir = -1 THEN 1 ELSE 0 END) AS n_down
    FROM forecast_outcomes
    WHERE series_kind = 'market' AND aggregated = 1
      AND model_version = ? AND label_version = ?
    GROUP BY asset_class, horizon_minutes
  `, [OUTCOME_MODEL_VERSION, OUTCOME_LABEL_VERSION]);
  const out = {};
  for (const r of rows) {
    out[`${r.asset_class}|${r.horizon_hours}`] = { n_up: r.n_up, n_flat: r.n_flat, n_down: r.n_down };
    const all = (out[`${r.asset_class}|all`] ??= { n_up: 0, n_flat: 0, n_down: 0 });
    all.n_up += r.n_up;
    all.n_flat += r.n_flat;
    all.n_down += r.n_down;
  }
  return out;
}

// Hierarchical prior for reliability weighting: how a technique has done
// across the broader asset class, independent of any single symbol. This is
// consumed only as a shrinkage prior for an asset's OWN measured record, not
// as a standalone vote weight, so assets with no history still stay neutral.
export async function loadTechniquePriors(env) {
  // Cross-sectional forecasts on one market date and the 24h/168h labels are
  // correlated. Use the ledger to retain the empirical hit rate but size its
  // uncertainty by independent dates, then average horizons instead of summing
  // them as extra trials.
  const rows = await d1(env, `
    SELECT asset_class, series_key AS technique_id, horizon_minutes,
           AVG(correct) AS accuracy,
           COUNT(DISTINCT substr(run_at, 1, 10)) AS effective_periods
    FROM forecast_outcomes
    WHERE series_kind = 'technique' AND aggregated = 1
      AND model_version = ? AND label_version = ?
    GROUP BY asset_class, series_key, horizon_minutes
  `, [OUTCOME_MODEL_VERSION, OUTCOME_LABEL_VERSION]);
  const grouped = {};
  for (const row of rows) (grouped[`${row.asset_class}|${row.technique_id}`] ??= []).push(row);
  const byAssetClass = {};
  const overallAcc = {};
  for (const [key, records] of Object.entries(grouped)) {
    const split = key.indexOf('|');
    const assetClass = key.slice(0, split), techniqueId = key.slice(split + 1);
    const accuracy = records.reduce((sum, row) => sum + Number(row.accuracy), 0) / records.length;
    const total = Math.max(...records.map((row) => Number(row.effective_periods) || 0));
    const rec = { correct: accuracy * total, total, accuracy };
    (byAssetClass[assetClass] ??= {})[techniqueId] = rec;
    (overallAcc[techniqueId] ??= []).push(rec);
  }
  const overall = {};
  for (const [techniqueId, records] of Object.entries(overallAcc)) {
    const accuracy = records.reduce((sum, row) => sum + row.accuracy, 0) / records.length;
    const total = Math.max(...records.map((row) => row.total));
    overall[techniqueId] = { correct: accuracy * total, total, accuracy };
  }
  return { byAssetClass, overall };
}

// { trending: { "symbol|technique_id": {correct, accuracy, total} }, choppy:
// {...} } — same blended-across-horizons shape loadReliability's own
// `blended` uses, just grouped by regime instead of pooling everything.
// Consumed by reliabilityMultiplier (worker.js) as the regime-specific
// alternative to blended, with the exact same MIN_RELIABILITY_SAMPLES +
// significance bar applied there before it's ever preferred over blended.
export async function loadRegimeReliability(env) {
  const rows = await d1(env, `
    SELECT symbol, series_key AS technique_id, regime,
           horizon_minutes / 60 AS horizon_hours,
           SUM(correct) AS correct, COUNT(*) AS total
    FROM forecast_outcomes
    WHERE series_kind = 'technique' AND aggregated = 1 AND regime IS NOT NULL
      AND model_version = ? AND label_version = ?
    GROUP BY symbol, series_key, regime, horizon_minutes
  `, [OUTCOME_MODEL_VERSION, OUTCOME_LABEL_VERSION]);
  // Average horizon accuracies and use only the deepest horizon as effective n.
  // Summing 24h and 168h records treats two labels on related paths as two
  // independent experiments and can push a regime across the significance bar.
  const acc = { trending: {}, choppy: {} };
  for (const r of rows) {
    if (!acc[r.regime]) continue; // defensive: regime is a free-text column, only these two values are ever written
    const key = `${r.symbol}|${r.technique_id}`;
    (acc[r.regime][key] ??= []).push(r);
  }
  const out = { trending: {}, choppy: {} };
  for (const regime of ['trending', 'choppy']) {
    for (const [key, records] of Object.entries(acc[regime])) {
      const accuracy = records.reduce((sum, r) => sum + r.correct / r.total, 0) / records.length;
      const total = Math.max(...records.map((r) => r.total));
      out[regime][key] = { correct: accuracy * total, accuracy, total };
    }
  }
  return out;
}

// Same blended-across-horizons shape as loadReliability, but keyed by
// symbol|technique_a|technique_b for technique pairs that agreed on direction
// in the same run. evaluateMatured already writes this table; loading it here
// lets live scoring give a SMALL bonus to proven reinforcing pairs rather than
// treating every agreement as equally informative.
export async function loadComboReliability(env) {
  const ledgerRows = await d1(env, `
    SELECT symbol, series_key, horizon_minutes / 60 AS horizon_hours,
           SUM(correct) AS correct, COUNT(*) AS total
    FROM forecast_outcomes
    WHERE series_kind = 'combo' AND aggregated = 1
      AND model_version = ? AND label_version = ?
    GROUP BY symbol, series_key, horizon_minutes
  `, [OUTCOME_MODEL_VERSION, OUTCOME_LABEL_VERSION]);
  const rows = [];
  for (const row of ledgerRows) {
    let pair;
    try { pair = JSON.parse(row.series_key); } catch { pair = null; }
    if (!Array.isArray(pair) || pair.length !== 2) continue;
    rows.push({ ...row, technique_a: pair[0], technique_b: pair[1] });
  }
  const grouped = {};
  for (const row of rows) (grouped[`${row.symbol}|${row.technique_a}|${row.technique_b}`] ??= []).push(row);
  const out = {};
  for (const [key, records] of Object.entries(grouped)) {
    const accuracy = records.reduce((sum, r) => sum + r.correct / r.total, 0) / records.length;
    const total = Math.max(...records.map((r) => r.total));
    out[key] = { correct: accuracy * total, total, accuracy };
  }
  return out;
}

// Range-prediction hit rate (was realized price actually inside the
// predicted band), pooled across both horizons per symbol — mirrors how
// `blended` above pools technique_reliability across horizons. Consumed
// by assetPredictionScore() in worker.js as one of the pooled inputs to
// an asset's overall track-record score.
export async function loadRangeReliability(env) {
  const rows = await d1(env, `
    SELECT asset_class, symbol, horizon_minutes / 60 AS horizon_hours,
           SUM(correct) AS hits, COUNT(*) AS total,
           COUNT(DISTINCT substr(run_at, 1, 10)) AS effective_samples
    FROM forecast_outcomes
    WHERE series_kind = 'range' AND aggregated = 1
      AND model_version = ? AND label_version = 'range-containment-v1'
    GROUP BY asset_class, symbol, horizon_minutes
  `, [OUTCOME_MODEL_VERSION]);
  const out = {};
  const grouped = {};
  for (const r of rows) {
    out[`${r.asset_class}|${r.symbol}|${r.horizon_hours}`] = { hits: r.hits, total: r.total, accuracy: r.hits / r.total, effectiveSamples: Math.min(r.total, r.effective_samples || r.total) };
    (grouped[`${r.asset_class}|${r.symbol}`] ??= []).push(r);
  }
  for (const [key, records] of Object.entries(grouped)) {
    const accuracy = records.reduce((sum, r) => sum + r.hits / r.total, 0) / records.length;
    const total = Math.max(...records.map((r) => r.total));
    const rec = { hits: accuracy * total, total, accuracy, effectiveSamples: Math.max(...records.map((r) => Math.min(r.total, r.effective_samples || r.total))) };
    out[`${key}|all`] = rec;
    // Backward-compatible lookup for the track-record helper. Runtime ticker
    // collision quarantine ensures only one class can own this bare symbol.
    out[key.slice(key.indexOf('|') + 1)] = rec;
  }
  return out;
}

// { bucket: { correct, total, accuracy } } for bucket 0-9 (decile of the
// composite call's own 0-100 score) — does a score of e.g. 85 (bucket 8)
// actually land correct roughly 80-90% of the time? See evaluateMatured
// for how this gets populated.
export async function loadCalibration(env) {
  const rows = await d1(env, `
    SELECT MIN(9, MAX(0, CAST(score / 10 AS INTEGER))) AS bucket,
           SUM(correct) AS correct, COUNT(*) AS total,
           COUNT(DISTINCT substr(run_at, 1, 10)) AS effective_samples
    FROM forecast_outcomes
    WHERE series_kind = 'technique' AND series_key = 'composite'
      AND aggregated = 1 AND score IS NOT NULL
      AND model_version = ? AND label_version = ?
    GROUP BY MIN(9, MAX(0, CAST(score / 10 AS INTEGER)))
  `, [OUTCOME_MODEL_VERSION, OUTCOME_LABEL_VERSION]);
  const out = {};
  for (const r of rows) out[r.bucket] = { correct: r.correct, total: r.total, accuracy: r.total ? r.correct / r.total : 0, effectiveSamples: Math.min(r.total, r.effective_samples || r.total) };
  return out;
}

// More specific than score_calibration's legacy pooled curve: the same score
// bucket can behave differently for crypto vs equities, up vs down calls, and
// one-day vs one-week outcomes. This table warms up alongside the pooled
// curve; callers retain the pooled result as a fallback while a detail cell is
// still thin.
export async function loadDetailedCalibration(env) {
  const rows = await d1(env, `
    SELECT asset_class, dir, horizon_minutes / 60 AS horizon_hours,
           MIN(9, MAX(0, CAST(score / 10 AS INTEGER))) AS bucket,
           SUM(correct) AS correct, COUNT(*) AS total,
           COUNT(DISTINCT substr(run_at, 1, 10)) AS effective_samples
    FROM forecast_outcomes
    WHERE series_kind = 'technique' AND series_key = 'composite'
      AND aggregated = 1 AND score IS NOT NULL AND dir IN (-1, 1)
      AND model_version = ? AND label_version = ?
    GROUP BY asset_class, dir, horizon_minutes,
             MIN(9, MAX(0, CAST(score / 10 AS INTEGER)))
  `, [OUTCOME_MODEL_VERSION, OUTCOME_LABEL_VERSION]);
  const out = {};
  for (const r of rows) {
    out[`${r.asset_class}|${r.dir}|${r.horizon_hours}|${r.bucket}`] = {
      correct: r.correct,
      total: r.total,
      accuracy: r.total ? r.correct / r.total : 0,
      effectiveSamples: Math.min(r.total, r.effective_samples || r.total)
    };
  }
  const classPeriods = await d1(env, `
    SELECT asset_class, COUNT(DISTINCT substr(run_at, 1, 10)) AS independent_periods
    FROM forecast_outcomes
    WHERE series_kind = 'technique' AND series_key = 'composite' AND aggregated = 1
      AND model_version = ? AND label_version = ?
    GROUP BY asset_class
  `, [OUTCOME_MODEL_VERSION, OUTCOME_LABEL_VERSION]);
  out.__classMeta = {};
  for (const row of classPeriods) out.__classMeta[row.asset_class] = { independentPeriods: row.independent_periods };
  return out;
}

// Persists this run's per-asset price and per-technique directional votes,
// to be scored once they mature (see evaluateMatured).
export async function logRun(env, runAt, log) {
  await forEachConcurrent(chunk(log.prices, CHUNK), D1_WRITE_CONCURRENCY, async (batch) => {
    const placeholders = batch.map(() => '(?,?,?,?)').join(',');
    const params = batch.flatMap((p) => [runAt, p.asset_class, p.symbol, p.price]);
    await d1(env, `INSERT OR REPLACE INTO asset_price_log (run_at, asset_class, symbol, price) VALUES ${placeholders}`, params);
  });
  // VOTES_CHUNK, not the shared CHUNK: this insert is now 7 columns
  // (score + regime both added after CHUNK=15 was sized for the original
  // 4-5 column shape). 15 x 7 = 105 would exceed D1's real 100-bound-param
  // cap (confirmed live once already, see CHUNK's own docs above); 14 x 7
  // = 98 stays under it.
  await forEachConcurrent(chunk(log.votes, VOTES_CHUNK), D1_WRITE_CONCURRENCY, async (batch) => {
    // score is nullable and only ever set on the synthetic 'composite' rows
    // (see rankBoards' push-site, worker.js) — null for every real
    // technique vote. regime is nullable too — null whenever the asset
    // didn't have enough history yet to compute swing structure at cast
    // time (see regimeOf, worker.js).
    const placeholders = batch.map(() => '(?,?,?,?,?,?,?)').join(',');
    const params = batch.flatMap((v) => [runAt, v.asset_class, v.symbol, v.technique_id, v.dir, v.score ?? null, v.regime ?? null]);
    await d1(env, `INSERT OR REPLACE INTO technique_votes (run_at, asset_class, symbol, technique_id, dir, score, regime) VALUES ${placeholders}`, params);
  });
  await forEachConcurrent(chunk(log.ranges || [], CHUNK), D1_WRITE_CONCURRENCY, async (batch) => {
    const placeholders = batch.map(() => '(?,?,?,?,?,?)').join(',');
    const params = batch.flatMap((r) => [runAt, r.asset_class, r.symbol, r.horizon_hours, r.low, r.high]);
    await d1(env, `INSERT OR REPLACE INTO range_log (run_at, asset_class, symbol, horizon_hours, low, high) VALUES ${placeholders}`, params);
  });
  // The stable-value research lane (user-requested 2026-08-31). These
  // assets are deliberately absent from every board — a peg has no
  // breakout to call, which is what made "USDG ⏳ Consolidating ↓" wrong
  // — but their supply and turnover are logged here anyway, because the
  // same conversation's other half was that a stablecoin going quiet may
  // itself say something about where the money NOT sitting in it is
  // headed. Observation only: nothing reads this into a live signal
  // until correlation-research.mjs shows the relationship survives
  // out-of-sample. 8 columns x 12 = 96, under D1's 100-bound-param cap.
  // One row per calendar day per asset (see the table's own docs). Most
  // columns take the latest observation; peak_deviation_pct is the
  // exception and accumulates with MAX, because a depeg is an intraday
  // spike that a last-write-wins column would erase. 10 columns x 9 = 90,
  // under D1's 100-bound-param cap.
  const obsDate = runAt.slice(0, 10);
  await forEachConcurrent(chunk(log.stableValue || [], 9), D1_WRITE_CONCURRENCY, async (batch) => {
    await d1(env, `
      INSERT INTO stable_value_observations
        (obs_date, symbol, name, price, mcap, volume, median_bar_pct, chg24h, peak_deviation_pct, basis, last_seen_at)
      VALUES ${batch.map(() => '(?,?,?,?,?,?,?,?,?,?,?)').join(',')}
      ON CONFLICT(obs_date, symbol) DO UPDATE SET
        price = excluded.price, mcap = excluded.mcap, volume = excluded.volume,
        median_bar_pct = excluded.median_bar_pct, chg24h = excluded.chg24h,
        peak_deviation_pct = MAX(COALESCE(stable_value_observations.peak_deviation_pct, 0), COALESCE(excluded.peak_deviation_pct, 0)),
        basis = excluded.basis, last_seen_at = excluded.last_seen_at`,
      batch.flatMap((r) => [obsDate, r.symbol, r.name ?? null, r.price ?? null, r.mcap ?? null, r.volume ?? null, r.medianBarPct ?? null, r.chg24h ?? null, r.deviationPct ?? null, r.basis, runAt]));
  });
}

// Per-asset realized move size at each horizon, learned continuously —
// { blended, byHorizon } from loadReliability answers "which technique is
// reliable"; this answers "how big does this asset's move actually tend
// to be," which predictedRange() uses once there's enough of an asset's
// own history to trust over the generic realized-volatility fallback.
// Keyed by "symbol|horizon_hours" -> { meanPct, stdevPct, n }, computed
// from running sum/sum-of-squares (Welford-lite, fine at this volume).
export async function loadMoveStats(env) {
  const rows = await d1(env, `
    SELECT symbol, horizon_minutes / 60 AS horizon_hours, COUNT(*) AS n,
           SUM(return_pct) AS sum_pct, SUM(return_pct * return_pct) AS sum_pct_sq
    FROM forecast_outcomes
    WHERE series_kind = 'market' AND aggregated = 1 AND return_pct IS NOT NULL
      AND model_version = ? AND label_version = ?
    GROUP BY symbol, horizon_minutes
  `, [OUTCOME_MODEL_VERSION, OUTCOME_LABEL_VERSION]);
  const out = {};
  for (const r of rows) {
    const mean = r.sum_pct / r.n;
    const variance = Math.max(0, r.sum_pct_sq / r.n - mean * mean);
    out[`${r.symbol}|${r.horizon_hours}`] = { meanPct: mean, stdevPct: Math.sqrt(variance), n: r.n };
  }
  return out;
}


// Path-shape evidence: WHEN inside a matured forecast the favorable extreme
// actually arrived, and how much of it was still there at the declared
// horizon. Directional accuracy answers "did it go the called way"; it says
// nothing about entry or exit, which is the whole point of this project.
// Both numbers come from columns the ledger already stores (migration 0013),
// so this costs no extra fetch and no extra write — it is the aggregation
// step the audit listed as the next model version's path-dependent labels.
//
// Deliberately backward-looking and measurement-only. It is a per-asset
// track record of matured, non-overlapping forecasts, NOT a claim about the
// current setup, and it never feeds a score, a weight, or a publication
// gate. Same discipline as everything else here: below the sample floor a
// row simply does not exist rather than being shown thin.
export const EXCURSION_MIN_SAMPLES = 30;

// Turns grouped ledger rows into the published summary. Kept pure so the
// side-awareness (a short's favorable extreme is the path LOW) and the
// degenerate-path exclusion are covered by the regression suite rather than
// only being exercised against live D1.
export function summarizeExcursionEvidence(rows, minSamples = EXCURSION_MIN_SAMPLES) {
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const n = Number(r && r.n);
    const horizonHours = Number(r && r.horizon_hours);
    if (!Number.isFinite(n) || n < minSamples || !(horizonHours > 0)) continue;
    const dir = Number(r.dir);
    if (dir !== 1 && dir !== -1) continue;
    const mfePct = Number(r.sum_mfe) / n;
    const maePct = Number(r.sum_mae) / n;
    const heldPct = Number(r.sum_signed_return) / n;
    const hoursToPeak = Number(r.sum_minutes_to_peak) / n / 60;
    if (![mfePct, maePct, heldPct, hoursToPeak].every(Number.isFinite)) continue;
    const adverseFirst = n - Number(r.n_favorable_first);
    // The favorable extreme cannot be worse than the price at maturity: the
    // maturity observation is itself a point on the measured path. So
    // give-back is a non-negative quantity by construction, and a large one
    // means the declared horizon is systematically selling after the top.
    const giveBackPct = Math.max(0, mfePct - heldPct);
    out.push({
      assetClass: r.asset_class,
      symbol: r.symbol,
      dir,
      horizonHours,
      n,
      // Best price the call ever offered, and when.
      mfePct,
      hoursToPeak,
      peakShare: Math.min(1, Math.max(0, hoursToPeak / horizonHours)),
      // What holding to the declared horizon actually returned, signed so a
      // short that fell is positive, and what that cost against the peak.
      heldPct,
      giveBackPct,
      // Worst excursion against the call. This is the honest answer to "could
      // I have bought lower": a persistently negative mean, with the adverse
      // extreme usually arriving first, says the signal price was not the
      // best available entry.
      maePct,
      adverseFirstRate: adverseFirst / n,
      // Conservative floor on that rate, so a thin or lucky-looking split is
      // not presented as a reliable "wait for a better fill" instruction.
      adverseFirstLower: lowerConfidenceBound(adverseFirst, n)
    });
  }
  // Largest measured give-back first: those are the assets whose declared
  // horizon is demonstrably exiting too late.
  return out.sort((a, b) => b.giveBackPct - a.giveBackPct);
}

export async function loadExcursionEvidence(env, minSamples = EXCURSION_MIN_SAMPLES) {
  const rows = await d1(env, `
    SELECT asset_class, symbol, dir, horizon_minutes / 60 AS horizon_hours,
           COUNT(*) AS n,
           SUM(CASE WHEN dir = 1 THEN path_high_pct ELSE -path_low_pct END) AS sum_mfe,
           SUM(CASE WHEN dir = 1 THEN path_low_pct ELSE -path_high_pct END) AS sum_mae,
           SUM(CASE WHEN dir = 1 THEN minutes_to_high ELSE minutes_to_low END) AS sum_minutes_to_peak,
           SUM(CASE WHEN dir = 1 THEN return_pct ELSE -return_pct END) AS sum_signed_return,
           SUM(CASE WHEN (CASE WHEN dir = 1 THEN minutes_to_high ELSE minutes_to_low END)
                       < (CASE WHEN dir = 1 THEN minutes_to_low ELSE minutes_to_high END)
                    THEN 1 ELSE 0 END) AS n_favorable_first
    FROM forecast_outcomes
    WHERE series_kind = 'technique' AND series_key = 'composite'
      AND aggregated = 1 AND dir IN (-1, 1)
      AND model_version = ? AND label_version = ?
      AND return_pct IS NOT NULL
      AND path_high_pct IS NOT NULL AND path_low_pct IS NOT NULL
      AND minutes_to_high IS NOT NULL AND minutes_to_low IS NOT NULL
      -- A window whose only known point is its own entry carries no path
      -- information at all; counting it would drag every mean toward zero
      -- and manufacture a "no give-back, no heat" reading out of missing
      -- data. Same failure mode as the zero-median daily range (0004).
      AND (path_high_pct > 0 OR path_low_pct < 0)
    GROUP BY asset_class, symbol, dir, horizon_minutes
  `, [OUTCOME_MODEL_VERSION, OUTCOME_LABEL_VERSION]);
  return summarizeExcursionEvidence(rows, minSamples);
}

// Chooses the first valid observation at or after a forecast's exact target
// instant. An observation before the target would shorten the forecast window;
// one beyond the bounded lag window would turn an intended 24h/168h outcome
// into a different, stale horizon. Kept pure for regression coverage.
export function selectMaturityPrice(priceRows, targetAt, maxLagMinutes = MATURITY_MATCH_MAX_LAG_MINUTES) {
  const targetMs = typeof targetAt === 'number' ? targetAt : Date.parse(targetAt);
  const maxLagMs = Number(maxLagMinutes) * 60 * 1000;
  if (!Array.isArray(priceRows) || !Number.isFinite(targetMs) || !Number.isFinite(maxLagMs) || maxLagMs < 0) return null;

  let match = null;
  for (const row of priceRows) {
    const runAt = row && (row.run_at || row.observed_at);
    const observedMs = Date.parse(runAt);
    const price = Number(row && row.price);
    if (!Number.isFinite(observedMs) || !Number.isFinite(price)) continue;
    if (observedMs < targetMs || observedMs > targetMs + maxLagMs) continue;
    if (!match || observedMs < match.observedMs) match = { price, run_at: runAt, observedMs };
  }
  return match ? { price: match.price, run_at: match.run_at } : null;
}

// Objective path labels for later scalp/swing research. These do not predict
// a top or bottom; they record the realized high/low and when each first
// occurred inside the exact forecast window so a future model can test those
// claims without reconstructing them from pruned operational logs.
export function pathExcursionStats(priceRows, entryPrice, runAt, observedAt) {
  const entry = Number(entryPrice);
  const startMs = Date.parse(runAt);
  const endMs = Date.parse(observedAt);
  if (!Array.isArray(priceRows) || !(entry > 0) || !Number.isFinite(startMs)
    || !Number.isFinite(endMs) || endMs < startMs) return null;
  const valid = [{ run_at: new Date(startMs).toISOString(), price: entry, at: startMs }];
  for (const row of priceRows) {
    const at = Date.parse(row && (row.run_at || row.observed_at));
    const price = Number(row && row.price);
    if (!Number.isFinite(at) || !(price > 0) || at < startMs || at > endMs) continue;
    valid.push({ run_at: row.run_at || row.observed_at, price, at });
  }
  let high = valid[0], low = valid[0];
  for (const point of valid) {
    if (point.price > high.price || (point.price === high.price && point.at < high.at)) high = point;
    if (point.price < low.price || (point.price === low.price && point.at < low.at)) low = point;
  }
  return {
    path_high_pct: ((high.price / entry) - 1) * 100,
    path_low_pct: ((low.price / entry) - 1) * 100,
    minutes_to_high: Math.max(0, (high.at - startMs) / 60000),
    minutes_to_low: Math.max(0, (low.at - startMs) / 60000)
  };
}

function maturityTarget(runAt, horizonHours) {
  const runMs = Date.parse(runAt);
  if (!Number.isFinite(runMs)) return null;
  const targetMs = runMs + horizonHours * 3600 * 1000;
  return {
    targetAt: new Date(targetMs).toISOString(),
    maxAt: new Date(targetMs + MATURITY_MATCH_MAX_LAG_MINUTES * 60 * 1000).toISOString()
  };
}

async function loadForecastStartPrices(env, targets) {
  const out = {};
  for (const batch of chunk(targets, CHUNK)) {
    const values = batch.map(() => '(?,?,?)').join(',');
    const params = batch.flatMap((t) => [t.runAt, t.assetClass, t.symbol]);
    const rows = await d1(env, `
      WITH requested(origin_run_at, asset_class, symbol) AS (VALUES ${values})
      SELECT requested.origin_run_at, requested.asset_class, requested.symbol, p.price
      FROM requested
      JOIN asset_price_log p ON p.run_at = requested.origin_run_at
        AND p.asset_class = requested.asset_class AND p.symbol = requested.symbol
    `, params);
    for (const r of rows) out[`${r.origin_run_at}|${r.asset_class}|${r.symbol}`] = r.price;
  }
  return out;
}

async function loadMaturityPriceRows(env, targets) {
  const out = {};
  // Five parameters per requested target keep this at 75 values per query
  // under D1's 100-bound-parameter cap (CHUNK is 15).
  for (const batch of chunk(targets, CHUNK)) {
    const values = batch.map(() => '(?,?,?,?,?)').join(',');
    const params = batch.flatMap((t) => [t.runAt, t.assetClass, t.symbol, t.targetAt, t.maxAt]);
    const rows = await d1(env, `
      WITH requested(origin_run_at, asset_class, symbol, target_at, max_at) AS (VALUES ${values})
      SELECT requested.origin_run_at, requested.asset_class, requested.symbol, p.run_at, p.price
      FROM requested
      JOIN asset_price_log p ON p.asset_class = requested.asset_class AND p.symbol = requested.symbol
        AND p.run_at >= requested.target_at
        AND p.run_at <= requested.max_at
    `, params);
    for (const r of rows) (out[`${r.origin_run_at}|${r.asset_class}|${r.symbol}`] ??= []).push(r);
  }
  return out;
}

async function loadForecastPathRows(env, targets) {
  const out = {};
  for (const batch of chunk(targets, CHUNK)) {
    const values = batch.map(() => '(?,?,?,?,?)').join(',');
    const params = batch.flatMap((t) => [t.runAt, t.assetClass, t.symbol, t.runAt, t.maxAt]);
    const rows = await d1(env, `
      WITH requested(origin_run_at, asset_class, symbol, start_at, max_at) AS (VALUES ${values})
      SELECT requested.origin_run_at, requested.asset_class, requested.symbol, p.run_at, p.price
      FROM requested
      JOIN asset_price_log p ON p.asset_class = requested.asset_class AND p.symbol = requested.symbol
        AND p.run_at >= requested.start_at AND p.run_at <= requested.max_at
      ORDER BY p.run_at
    `, params);
    for (const row of rows) (out[`${row.origin_run_at}|${row.asset_class}|${row.symbol}`] ??= []).push(row);
  }
  return out;
}

async function loadAcceptedOutcomeTimes(env, horizonMinutes) {
  const rows = await d1(env, `
    SELECT asset_class, symbol, horizon_minutes, series_kind, series_key, MAX(run_at) AS last_run_at
    FROM forecast_outcomes
    WHERE horizon_minutes = ?
    GROUP BY asset_class, symbol, horizon_minutes, series_kind, series_key
  `, [horizonMinutes]);
  const out = {};
  for (const row of rows) out[outcomeSeriesIdentity(row)] = row.last_run_at;
  return out;
}

export async function insertForecastOutcomes(env, rows) {
  const allowedKinds = new Set(['technique', 'combo', 'market', 'range', 'intraday']);
  for (const row of rows) {
    if (!row || !Number.isFinite(Date.parse(row.run_at)) || !row.asset_class || !row.symbol
      || !Number.isInteger(Number(row.horizon_minutes)) || Number(row.horizon_minutes) <= 0
      || !allowedKinds.has(row.series_kind) || !row.series_key
      || ![0, 1].includes(Number(row.correct)) || !Number.isFinite(Date.parse(row.evaluated_at))) {
      throw new Error(`invalid forecast outcome: ${JSON.stringify(row)}`);
    }
    for (const field of ['entry_price', 'exit_price']) {
      if (row[field] != null && (!Number.isFinite(Number(row[field])) || Number(row[field]) <= 0)) {
        throw new Error(`invalid ${field} in forecast outcome`);
      }
    }
    for (const field of ['path_high_pct', 'path_low_pct', 'minutes_to_high', 'minutes_to_low']) {
      if (row[field] != null && !Number.isFinite(Number(row[field]))) throw new Error(`invalid ${field} in forecast outcome`);
    }
    if ((row.minutes_to_high != null && Number(row.minutes_to_high) < 0)
      || (row.minutes_to_low != null && Number(row.minutes_to_low) < 0)) {
      throw new Error('negative time-to-extreme in forecast outcome');
    }
    if (row.path_high_pct != null && row.path_low_pct != null
      && Number(row.path_high_pct) < Number(row.path_low_pct)) {
      throw new Error('forecast outcome path high is below path low');
    }
    if (row.target_at != null && !Number.isFinite(Date.parse(row.target_at))) throw new Error('invalid target_at in forecast outcome');
    if (row.observed_at != null && !Number.isFinite(Date.parse(row.observed_at))) throw new Error('invalid observed_at in forecast outcome');
    if (row.target_at && row.observed_at && Date.parse(row.observed_at) < Date.parse(row.target_at)) {
      throw new Error('forecast outcome observation predates its target');
    }
  }
  for (const batch of chunk(rows, OUTCOME_INSERT_CHUNK)) {
    const placeholders = batch.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',');
    const params = batch.flatMap((row) => [
      row.run_at, row.asset_class, row.symbol, row.horizon_minutes,
      row.series_kind, row.series_key, row.dir ?? null, row.actual_dir ?? null,
      row.correct ? 1 : 0, row.score ?? null, row.regime ?? null,
      row.return_pct ?? null, row.target_at ?? null, row.observed_at ?? null,
      row.entry_price ?? null, row.exit_price ?? null,
      row.path_high_pct ?? null, row.path_low_pct ?? null,
      row.minutes_to_high ?? null, row.minutes_to_low ?? null,
      row.model_version || (row.series_kind === 'intraday' ? 'intraday-v1' : OUTCOME_MODEL_VERSION),
      row.label_version || (row.series_kind === 'range' ? 'range-containment-v1' : OUTCOME_LABEL_VERSION),
      row.evaluated_at
    ]);
    await d1(env, `
      INSERT INTO forecast_outcomes
        (run_at, asset_class, symbol, horizon_minutes, series_kind, series_key,
         dir, actual_dir, correct, score, regime, return_pct, target_at,
         observed_at, entry_price, exit_price, path_high_pct, path_low_pct,
         minutes_to_high, minutes_to_low, model_version, label_version, evaluated_at)
      VALUES ${placeholders}
      ON CONFLICT(run_at, asset_class, symbol, horizon_minutes, series_kind, series_key) DO NOTHING
    `, params);
  }
}

function outcomeAggregateStatements(row, nowIso) {
  const statements = [];
  const horizonHours = row.horizon_minutes / 60;
  if (row.series_kind === 'technique') {
    statements.push({
      sql: `
        INSERT INTO technique_reliability
          (asset_class, symbol, technique_id, horizon_hours, correct, total, accuracy, votes_up, votes_down, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
        ON CONFLICT (symbol, technique_id, horizon_hours) DO UPDATE SET
          correct = technique_reliability.correct + excluded.correct,
          total = technique_reliability.total + 1,
          accuracy = CAST(technique_reliability.correct + excluded.correct AS REAL) / (technique_reliability.total + 1),
          votes_up = technique_reliability.votes_up + excluded.votes_up,
          votes_down = technique_reliability.votes_down + excluded.votes_down,
          updated_at = excluded.updated_at
      `,
      params: [row.asset_class, row.symbol, row.series_key, horizonHours, row.correct, row.correct, row.dir === 1 ? 1 : 0, row.dir === -1 ? 1 : 0, nowIso]
    });
    if (row.regime) {
      statements.push({
        sql: `
          INSERT INTO technique_regime_reliability
            (symbol, technique_id, horizon_hours, regime, correct, total, accuracy, updated_at)
          VALUES (?, ?, ?, ?, ?, 1, ?, ?)
          ON CONFLICT (symbol, technique_id, horizon_hours, regime) DO UPDATE SET
            correct = technique_regime_reliability.correct + excluded.correct,
            total = technique_regime_reliability.total + 1,
            accuracy = CAST(technique_regime_reliability.correct + excluded.correct AS REAL) / (technique_regime_reliability.total + 1),
            updated_at = excluded.updated_at
        `,
        params: [row.symbol, row.series_key, horizonHours, row.regime, row.correct, row.correct, nowIso]
      });
    }
    if (row.series_key === 'composite' && row.score != null && (row.dir === 1 || row.dir === -1)) {
      const bucket = scoreBucket(row.score);
      statements.push({
        sql: `
          INSERT INTO score_calibration (bucket, correct, total, updated_at)
          VALUES (?, ?, 1, ?)
          ON CONFLICT (bucket) DO UPDATE SET
            correct = score_calibration.correct + excluded.correct,
            total = score_calibration.total + 1,
            updated_at = excluded.updated_at
        `,
        params: [bucket, row.correct, nowIso]
      });
      statements.push({
        sql: `
          INSERT INTO score_calibration_detail
            (asset_class, dir, horizon_hours, bucket, correct, total, updated_at)
          VALUES (?, ?, ?, ?, ?, 1, ?)
          ON CONFLICT (asset_class, dir, horizon_hours, bucket) DO UPDATE SET
            correct = score_calibration_detail.correct + excluded.correct,
            total = score_calibration_detail.total + 1,
            updated_at = excluded.updated_at
        `,
        params: [row.asset_class, row.dir, horizonHours, bucket, row.correct, nowIso]
      });
    }
  } else if (row.series_kind === 'combo') {
    let pair;
    try { pair = JSON.parse(row.series_key); } catch { pair = null; }
    if (Array.isArray(pair) && pair.length === 2) {
      statements.push({
        sql: `
          INSERT INTO technique_combo_reliability
            (symbol, technique_a, technique_b, horizon_hours, correct, total, accuracy, updated_at)
          VALUES (?, ?, ?, ?, ?, 1, ?, ?)
          ON CONFLICT (symbol, technique_a, technique_b, horizon_hours) DO UPDATE SET
            correct = technique_combo_reliability.correct + excluded.correct,
            total = technique_combo_reliability.total + 1,
            accuracy = CAST(technique_combo_reliability.correct + excluded.correct AS REAL) / (technique_combo_reliability.total + 1),
            updated_at = excluded.updated_at
        `,
        params: [row.symbol, pair[0], pair[1], horizonHours, row.correct, row.correct, nowIso]
      });
    }
  } else if (row.series_kind === 'market') {
    statements.push({
      sql: `
        INSERT INTO direction_baseline (asset_class, horizon_hours, n_up, n_flat, n_down, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (asset_class, horizon_hours) DO UPDATE SET
          n_up = direction_baseline.n_up + excluded.n_up,
          n_flat = direction_baseline.n_flat + excluded.n_flat,
          n_down = direction_baseline.n_down + excluded.n_down,
          updated_at = excluded.updated_at
      `,
      params: [row.asset_class, horizonHours, row.actual_dir === 1 ? 1 : 0, row.actual_dir === 0 ? 1 : 0, row.actual_dir === -1 ? 1 : 0, nowIso]
    });
    statements.push({
      sql: `
        INSERT INTO asset_move_stats (symbol, horizon_hours, n, sum_pct, sum_pct_sq, updated_at)
        VALUES (?, ?, 1, ?, ?, ?)
        ON CONFLICT (symbol, horizon_hours) DO UPDATE SET
          n = asset_move_stats.n + 1,
          sum_pct = asset_move_stats.sum_pct + excluded.sum_pct,
          sum_pct_sq = asset_move_stats.sum_pct_sq + excluded.sum_pct_sq,
          updated_at = excluded.updated_at
      `,
      params: [row.symbol, horizonHours, row.return_pct, row.return_pct * row.return_pct, nowIso]
    });
  } else if (row.series_kind === 'range') {
    statements.push({
      sql: `
        INSERT INTO range_reliability (asset_class, symbol, horizon_hours, hits, total, accuracy, updated_at)
        VALUES (?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT (symbol, horizon_hours) DO UPDATE SET
          hits = range_reliability.hits + excluded.hits,
          total = range_reliability.total + 1,
          accuracy = CAST(range_reliability.hits + excluded.hits AS REAL) / (range_reliability.total + 1),
          updated_at = excluded.updated_at
      `,
      params: [row.asset_class, row.symbol, horizonHours, row.correct, row.correct, nowIso]
    });
  } else if (row.series_kind === 'intraday') {
    statements.push({
      sql: `
        INSERT INTO intraday_reliability (asset_class, symbol, horizon_minutes, correct, total, accuracy, updated_at)
        VALUES (?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT (symbol, horizon_minutes) DO UPDATE SET
          correct = intraday_reliability.correct + excluded.correct,
          total = intraday_reliability.total + 1,
          accuracy = CAST(intraday_reliability.correct + excluded.correct AS REAL) / (intraday_reliability.total + 1),
          updated_at = excluded.updated_at
      `,
      params: [row.asset_class, row.symbol, row.horizon_minutes, row.correct, row.correct, nowIso]
    });
  }
  // Claim + guarded increments + commit all run in one D1 batch transaction.
  // Two workflows may select the same pending row concurrently; only the one
  // whose 0 -> -1 claim succeeds is allowed to increment aggregates. A failed
  // batch rolls the claim back, so there is no stranded in-progress state.
  const guarded = statements.map((statement) => {
    const values = statement.sql.match(/VALUES\s*\(([^)]*)\)/i);
    if (!values) throw new Error(`aggregate statement has no simple VALUES clause for outcome ${row.id}`);
    return {
      sql: statement.sql.replace(values[0], `SELECT ${values[1]} FROM forecast_outcomes WHERE id = ? AND aggregated = -1`),
      params: [...statement.params, row.id]
    };
  });
  return [
    { sql: 'UPDATE forecast_outcomes SET aggregated = -1 WHERE id = ? AND aggregated = 0', params: [row.id] },
    ...guarded,
    { sql: 'UPDATE forecast_outcomes SET aggregated = 1 WHERE id = ? AND aggregated = -1', params: [row.id] }
  ];
}

// Recoverable aggregation: a job may die after a ledger insert and before this
// function. The next run sees `aggregated = 0` and finishes it. Conversely, D1
// batches the derived increments with the flag update transactionally, so a
// retry can never increment the same outcome twice.
export async function aggregatePendingForecastOutcomes(env, nowIso) {
  const pending = await d1(env, `
    SELECT id, run_at, asset_class, symbol, horizon_minutes, series_kind,
           series_key, dir, actual_dir, correct, score, regime, return_pct
    FROM forecast_outcomes WHERE aggregated = 0 ORDER BY id
  `);
  for (const batch of chunk(pending, OUTCOME_AGGREGATE_CHUNK)) {
    const statements = batch.flatMap((row) => outcomeAggregateStatements(row, nowIso));
    await d1Batch(env, statements);
  }
  return pending.length;
}

// Finds technique_votes rows old enough to have matured for each horizon
// and not yet scored for it, compares that run's logged price against the
// first price logged at its own target horizon (within normal scheduler
// jitter), and folds the correct/incorrect outcome into
// technique_reliability. Also folds the *realized move size* into
// asset_move_stats — once per (symbol, run_at, horizon), not once per
// technique-vote row, since several techniques voting on the same asset in
// the same hour all describe the exact same underlying price move, not
// independent observations of it (the same correlation trap fixed in
// horizonEstimate's confidence gate). Returns how many (symbol, technique,
// horizon) outcomes were scored this call.
export async function evaluateMatured(env, nowIso) {
  const now = new Date(nowIso).getTime();
  let evaluatedCount = 0;

  // Finish any ledger rows left behind by a process/network failure before
  // considering fresh maturities. This is safe on every run and makes recovery
  // independent of whether another raw vote is currently due.
  await aggregatePendingForecastOutcomes(env, nowIso);

  for (const h of HORIZONS_HOURS) {
    const cutoff = new Date(now - h * 3600 * 1000).toISOString();
    const col = EVAL_COLUMN[h];
    const due = await d1(env, `SELECT run_at, asset_class, symbol, technique_id, dir, score, regime FROM technique_votes WHERE run_at <= ? AND ${col} = 0 ORDER BY run_at`, [cutoff]);
    // Range predictions logged at this same horizon (see RANGE_LOG_HORIZONS_DAYS
    // in worker.js) — each row matures once, at its own horizon_hours, so
    // there's no evaluated flag to filter on here, just the cutoff.
    const dueRanges = await d1(env, 'SELECT run_at, asset_class, symbol, low, high FROM range_log WHERE horizon_hours = ? AND run_at <= ?', [h, cutoff]);
    if (!due.length && !dueRanges.length) continue;

    // Deduplicate requests before querying: every technique vote for one
    // (run_at, symbol) shares the same entry and horizon-target price.
    const targetByKey = {};
    for (const r of [...due, ...dueRanges]) {
      const key = `${r.run_at}|${r.asset_class}|${r.symbol}`;
      if (targetByKey[key]) continue;
      const target = maturityTarget(r.run_at, h);
      if (target) targetByKey[key] = { runAt: r.run_at, assetClass: r.asset_class, symbol: r.symbol, ...target };
    }
    const allTargets = Object.values(targetByKey);
    const priceBefore = await loadForecastStartPrices(env, allTargets);
    const maturityRows = await loadMaturityPriceRows(env, allTargets);
    const pathRows = await loadForecastPathRows(env, allTargets);
    const priceAtTarget = {};
    for (const target of allTargets) {
      const key = `${target.runAt}|${target.assetClass}|${target.symbol}`;
      const match = selectMaturityPrice(maturityRows[key], target.targetAt);
      if (match) priceAtTarget[key] = match;
    }

    const horizonMinutes = h * 60;
    let acceptedState = await loadAcceptedOutcomeTimes(env, horizonMinutes);
    const evaluableVotes = [];
    const moveByEvent = {};
    const evaluatedVotesByRunAndClass = {};
    for (const r of due) {
      const eventKey = `${r.run_at}|${r.asset_class}|${r.symbol}`;
      const before = priceBefore[eventKey];
      const match = priceAtTarget[eventKey];
      const after = match && match.price;
      if (before == null || after == null || !before) continue;
      const returnPct = ((after / before) - 1) * 100;
      const target = targetByKey[eventKey];
      const path = pathExcursionStats(pathRows[eventKey], before, r.run_at, match.run_at);
      const actualDir = returnPct > OUTCOME_DEADBAND_PCT ? 1 : returnPct < -OUTCOME_DEADBAND_PCT ? -1 : 0;
      const candidate = {
        ...r, horizon_minutes: horizonMinutes, series_kind: 'technique',
        series_key: r.technique_id, actual_dir: actualDir, return_pct: returnPct,
        target_at: target.targetAt, observed_at: match.run_at,
        entry_price: before, exit_price: after, ...(path || {})
      };
      evaluableVotes.push(candidate);
      moveByEvent[eventKey] = {
        run_at: r.run_at, asset_class: r.asset_class, symbol: r.symbol,
        horizon_minutes: horizonMinutes, series_kind: 'market', series_key: 'market',
        actual_dir: actualDir, return_pct: returnPct,
        target_at: target.targetAt, observed_at: match.run_at,
        entry_price: before, exit_price: after, ...(path || {})
      };
      const markKey = `${r.run_at}|${r.asset_class}`;
      (evaluatedVotesByRunAndClass[markKey] ??= new Set()).add(r.symbol);
    }

    const techniquePartition = selectNonOverlappingForecasts(evaluableVotes, horizonMinutes, acceptedState);
    acceptedState = techniquePartition.lastAcceptedByKey;
    const marketPartition = selectNonOverlappingForecasts(Object.values(moveByEvent), horizonMinutes, acceptedState);
    acceptedState = marketPartition.lastAcceptedByKey;

    // Pair only technique votes that independently earned admission to this
    // horizon's ledger. Correlated same-run agreement is useful context, but it
    // does not manufacture extra time-series observations.
    const comboGroups = {};
    for (const row of techniquePartition.accepted) {
      if (row.technique_id === 'composite' || !(row.dir === 1 || row.dir === -1)) continue;
      const key = `${row.run_at}|${row.asset_class}|${row.symbol}`;
      (comboGroups[key] ??= { ...moveByEvent[key], votes: [] }).votes.push(row);
    }
    const comboCandidates = [];
    for (const group of Object.values(comboGroups)) {
      for (let i = 0; i < group.votes.length; i++) {
        for (let j = i + 1; j < group.votes.length; j++) {
          if (group.votes[i].dir !== group.votes[j].dir) continue;
          const [a, b] = [group.votes[i].technique_id, group.votes[j].technique_id].sort();
          comboCandidates.push({
            run_at: group.run_at, asset_class: group.asset_class, symbol: group.symbol,
            horizon_minutes: horizonMinutes, series_kind: 'combo', series_key: JSON.stringify([a, b]),
            dir: group.votes[i].dir, actual_dir: group.actual_dir, return_pct: group.return_pct
          });
        }
      }
    }
    const comboPartition = selectNonOverlappingForecasts(comboCandidates, horizonMinutes, acceptedState);
    acceptedState = comboPartition.lastAcceptedByKey;

    const evaluableRanges = [];
    const evaluatedRangesByRunAndClass = {};
    for (const r of dueRanges) {
      const eventKey = `${r.run_at}|${r.asset_class}|${r.symbol}`;
      const match = priceAtTarget[eventKey];
      const after = match && match.price;
      if (after == null) continue;
      const target = targetByKey[eventKey];
      const before = priceBefore[eventKey];
      const path = pathExcursionStats(pathRows[eventKey], before, r.run_at, match.run_at);
      evaluableRanges.push({
        ...r, horizon_minutes: horizonMinutes, series_kind: 'range', series_key: 'range',
        correct: after >= r.low && after <= r.high ? 1 : 0,
        target_at: target.targetAt, observed_at: match.run_at,
        entry_price: before ?? null, exit_price: after, ...(path || {})
      });
      const markKey = `${r.run_at}|${r.asset_class}`;
      (evaluatedRangesByRunAndClass[markKey] ??= new Set()).add(r.symbol);
    }
    const rangePartition = selectNonOverlappingForecasts(evaluableRanges, horizonMinutes, acceptedState);

    const outcomes = [
      ...techniquePartition.accepted.map((r) => ({
        run_at: r.run_at, asset_class: r.asset_class, symbol: r.symbol,
        horizon_minutes: horizonMinutes, series_kind: 'technique', series_key: r.technique_id,
        dir: r.dir, actual_dir: r.actual_dir, correct: r.dir === r.actual_dir ? 1 : 0,
        score: r.score, regime: r.regime, return_pct: r.return_pct,
        target_at: r.target_at, observed_at: r.observed_at,
        entry_price: r.entry_price, exit_price: r.exit_price,
        path_high_pct: r.path_high_pct, path_low_pct: r.path_low_pct,
        minutes_to_high: r.minutes_to_high, minutes_to_low: r.minutes_to_low,
        model_version: OUTCOME_MODEL_VERSION, label_version: OUTCOME_LABEL_VERSION,
        evaluated_at: nowIso
      })),
      ...marketPartition.accepted.map((r) => ({ ...r, correct: 1, model_version: OUTCOME_MODEL_VERSION, label_version: OUTCOME_LABEL_VERSION, evaluated_at: nowIso })),
      ...comboPartition.accepted.map((r) => ({ ...r, correct: r.dir === r.actual_dir ? 1 : 0, model_version: OUTCOME_MODEL_VERSION, label_version: OUTCOME_LABEL_VERSION, evaluated_at: nowIso })),
      ...rangePartition.accepted.map((r) => ({
        run_at: r.run_at, asset_class: r.asset_class, symbol: r.symbol,
        horizon_minutes: horizonMinutes, series_kind: 'range', series_key: 'range',
        correct: r.correct, target_at: r.target_at, observed_at: r.observed_at,
        entry_price: r.entry_price, exit_price: r.exit_price,
        path_high_pct: r.path_high_pct, path_low_pct: r.path_low_pct,
        minutes_to_high: r.minutes_to_high, minutes_to_low: r.minutes_to_low,
        model_version: OUTCOME_MODEL_VERSION, label_version: 'range-containment-v1',
        evaluated_at: nowIso
      }))
    ];

    if (outcomes.length) await insertForecastOutcomes(env, outcomes);
    evaluatedCount += techniquePartition.accepted.length;

    // Mark every forecast with a valid exact-target observation, including
    // overlapping rows intentionally omitted from the independent ledger.
    // Ledger inserts happen first, so a failure here only causes a harmless
    // re-scan; the unique index prevents duplicate outcomes.
    const evaluationMarkJobs = Object.entries(evaluatedVotesByRunAndClass).flatMap(([runAndClass, symSet]) => {
      const splitAt = runAndClass.lastIndexOf('|');
      const runAt = runAndClass.slice(0, splitAt);
      const assetClass = runAndClass.slice(splitAt + 1);
      return chunk([...symSet], CHUNK).map((symbolsBatch) => ({ runAt, assetClass, symbolsBatch }));
    });
    await forEachConcurrent(evaluationMarkJobs, D1_WRITE_CONCURRENCY, async ({ runAt, assetClass, symbolsBatch }) => {
      const placeholders = symbolsBatch.map(() => '?').join(',');
      await d1(env, `UPDATE technique_votes SET ${col} = 1 WHERE run_at = ? AND asset_class = ? AND symbol IN (${placeholders})`, [runAt, assetClass, ...symbolsBatch]);
    });

    const rangeDeletionJobs = Object.entries(evaluatedRangesByRunAndClass).flatMap(([runAndClass, symSet]) => {
      const splitAt = runAndClass.lastIndexOf('|');
      const runAt = runAndClass.slice(0, splitAt);
      const assetClass = runAndClass.slice(splitAt + 1);
      return chunk([...symSet], CHUNK).map((symbolsBatch) => ({ runAt, assetClass, symbolsBatch }));
    });
    await forEachConcurrent(rangeDeletionJobs, D1_WRITE_CONCURRENCY, async ({ runAt, assetClass, symbolsBatch }) => {
      const placeholders = symbolsBatch.map(() => '?').join(',');
      await d1(env, `DELETE FROM range_log WHERE horizon_hours = ? AND run_at = ? AND asset_class = ? AND symbol IN (${placeholders})`, [h, runAt, assetClass, ...symbolsBatch]);
    });

    await aggregatePendingForecastOutcomes(env, nowIso);
  }

  const retentionCutoff = new Date(now - RETENTION_HOURS * 3600 * 1000).toISOString();
  await d1(env, 'DELETE FROM technique_votes WHERE run_at < ? AND evaluated_24 = 1 AND evaluated_168 = 1', [retentionCutoff]);
  await d1(env, 'DELETE FROM asset_price_log WHERE run_at < ?', [retentionCutoff]);
  const hardCapCutoff = new Date(now - HARD_CAP_HOURS * 3600 * 1000).toISOString();
  await d1(env, 'DELETE FROM technique_votes WHERE run_at < ?', [hardCapCutoff]);
  await d1(env, 'DELETE FROM asset_price_log WHERE run_at < ?', [hardCapCutoff]);
  // range_log rows are deleted as soon as they mature (see above), so this
  // hard cap only ever catches ones that never got the chance to (symbol
  // vanished from the universe before priceNow could see it again).
  await d1(env, 'DELETE FROM range_log WHERE run_at < ?', [hardCapCutoff]);

  return evaluatedCount;
}

// Minimum gap a genuinely FRESH flip needs from the previous one already
// logged for the same symbol, so a call that's whipsawing every single
// hour doesn't spam call_flip_log with a near-duplicate row per build —
// the unique index on (symbol, flip_run_at) already prevents re-logging
// the EXACT same flip_run_at twice, this additionally skips a flip that's
// really just the continuation of one already caught within the last hour.
const CALL_FLIP_MIN_GAP_HOURS = 0.75;
// call_flip_log's insert is 9 columns wide — CHUNK (15) was sized for a
// narrower table (see its own comment above); 15 x 9 = 135 would exceed
// D1's real 100-bound-parameter cap, confirmed live (2026-08-22, this
// table's very first run: a large first-ever backlog of historical flips
// across the whole tracked universe landed in one batch and hit exactly
// this ceiling — "too many SQL variables at offset 387"). 11 x 9 = 99
// stays under it, matching VOTES_CHUNK's own reasoning for a wider row.
const CALL_FLIP_CHUNK = 11;
// How long to wait before judging whether a flip's NEW direction actually
// held — 24h, not the engine's usual 24h/168h pair: a flip is inherently a
// short-timescale question (the user's own framing was "within a few
// minutes or hours"), and a single well-chosen horizon here starts
// yielding real findings sooner than doubling up would.
const CALL_FLIP_EVAL_HORIZON_HOURS = 24;
// Reuses evaluateMatured's own OUTCOME_DEADBAND_PCT threshold for "did
// price even move enough to call it a direction" — same question, same
// answer, not a second judgment call about how big a move counts.
// detectAndLogCallFlips only needs each symbol's last couple of composite
// rows to catch a FRESH flip — a much shorter window than RETENTION_HOURS
// (200h). Found live, 2026-08-22: at 200h, this function rescans and
// recomputes flips across a symbol's ENTIRE retained history every single
// run — the unique index makes re-INSERTing them harmless, but the
// query + in-memory detectCallFlips pass over that much history was
// costing ~11 minutes every hour regardless (confirmed: "2085 new
// flip(s) logged" on a run immediately after one that had already logged
// 2101 -- almost entirely the same flips, reprocessed and silently
// ignored). 8h comfortably covers even a rough multi-hour gap between
// builds (this project's worst observed gaps today, itself an anomaly,
// topped out under an hour) while cutting the scanned window ~25x. The
// one-time historical backfill already captured everything older than
// this on the very first run this feature existed — narrowing the window
// now doesn't lose that, it just stops needlessly re-walking it forever.
const CALL_FLIP_DETECT_LOOKBACK_HOURS = 8;

// Scans this run's own recently-logged composite calls (technique_votes
// WHERE technique_id='composite' — already recorded every run for the
// calibration curve, see logRun/evaluateMatured; nothing new is written
// there) for direction reversals, appending any newly-found ones to
// call_flip_log. INSERT OR IGNORE + the unique (symbol, flip_run_at) index
// makes this idempotent — safe to call every run without double-counting
// a flip already caught on a prior pass.
export async function detectAndLogCallFlips(env, nowIso) {
  const cutoff = new Date(new Date(nowIso).getTime() - CALL_FLIP_DETECT_LOOKBACK_HOURS * 3600 * 1000).toISOString();
  const rows = await d1(env, `
    SELECT symbol, asset_class, run_at, dir, score FROM technique_votes
    WHERE technique_id = 'composite' AND run_at >= ? ORDER BY symbol, run_at
  `, [cutoff]);

  const bySymbol = {};
  for (const r of rows) (bySymbol[r.symbol] ??= { assetClass: r.asset_class, rows: [] }).rows.push(r);

  const toInsert = [];
  for (const [symbol, { assetClass, rows: symRows }] of Object.entries(bySymbol)) {
    const flips = detectCallFlips(symRows);
    let lastLoggedAt = null;
    for (const f of flips) {
      if (lastLoggedAt != null && (new Date(f.newRunAt) - new Date(lastLoggedAt)) / 3600000 < CALL_FLIP_MIN_GAP_HOURS) continue;
      lastLoggedAt = f.newRunAt;
      toInsert.push({ symbol, assetClass, ...f });
    }
  }
  if (!toInsert.length) return 0;

  let written = 0;
  for (const batch of chunk(toInsert, CALL_FLIP_CHUNK)) {
    const placeholders = batch.map(() => '(?,?,?,?,?,?,?,?,?)').join(',');
    const params = batch.flatMap((f) => [f.symbol, f.assetClass, f.priorDir, f.priorScore, f.priorRunAt, f.newDir, f.newScore, f.newRunAt, f.hoursBetween]);
    await d1(env, `
      INSERT OR IGNORE INTO call_flip_log (symbol, asset_class, prior_dir, prior_score, prior_run_at, new_dir, new_score, flip_run_at, hours_between)
      VALUES ${placeholders}
    `, params);
    written += batch.length;
  }
  return written;
}

// Judges every call_flip_log row old enough to have matured (24h since the
// flip itself): did the NEW direction actually hold (price kept moving
// that way), did it revert back toward the OLD direction (the flip was
// whipsaw noise — the original call would have aged better), or was the
// move too small to call either way (same OUTCOME_DEADBAND_PCT flat-zone
// evaluateMatured already uses). Uses the same bounded exact-target matching
// as evaluateMatured rather than a later arbitrary current price, so a
// "24h" flip result is actually a 24h result.
export async function evaluateCallFlips(env, nowIso) {
  const cutoff = new Date(new Date(nowIso).getTime() - CALL_FLIP_EVAL_HORIZON_HOURS * 3600 * 1000).toISOString();
  const due = await d1(env, 'SELECT id, asset_class, symbol, new_dir, flip_run_at FROM call_flip_log WHERE outcome IS NULL AND flip_run_at <= ?', [cutoff]);
  if (!due.length) return 0;

  const targetByKey = {};
  for (const r of due) {
    const key = `${r.flip_run_at}|${r.asset_class}|${r.symbol}`;
    if (targetByKey[key]) continue;
    const target = maturityTarget(r.flip_run_at, CALL_FLIP_EVAL_HORIZON_HOURS);
    if (target) targetByKey[key] = { runAt: r.flip_run_at, assetClass: r.asset_class, symbol: r.symbol, ...target };
  }
  const targets = Object.values(targetByKey);
  const priceAtFlip = await loadForecastStartPrices(env, targets);
  const maturityRows = await loadMaturityPriceRows(env, targets);
  const priceAtTarget = {};
  for (const target of targets) {
    const key = `${target.runAt}|${target.assetClass}|${target.symbol}`;
    const match = selectMaturityPrice(maturityRows[key], target.targetAt);
    if (match) priceAtTarget[key] = match.price;
  }

  let evaluated = 0;
  for (const r of due) {
    const eventKey = `${r.flip_run_at}|${r.asset_class}|${r.symbol}`;
    const before = priceAtFlip[eventKey];
    const after = priceAtTarget[eventKey];
    if (before == null || after == null) continue; // no exact entry/target observation; leave unscored rather than mislabeling the flip
    const movePct = ((after / before) - 1) * 100;
    const actualDir = Math.abs(movePct) < OUTCOME_DEADBAND_PCT ? 0 : (movePct > 0 ? 1 : -1);
    const outcome = actualDir === 0 ? 'flat' : (actualDir === r.new_dir ? 'held' : 'reverted');
    await d1(env, 'UPDATE call_flip_log SET outcome = ?, outcome_checked_at = ? WHERE id = ?', [outcome, nowIso, r.id]);
    evaluated++;
  }
  return evaluated;
}

// Per-symbol flip history for display: how many times has this asset's
// call reversed recently, and once evaluated, how often did the new
// direction actually hold vs revert. Two different consumers, two
// different gates — recentFlips needs just ONE row to be worth a caution
// note on the dashboard (even a single fresh flip is worth flagging, same
// as WLFI's own case), while stability needs a real sample before its
// held/reverted rate means anything, same MIN_RELIABILITY_SAMPLES bar
// reliabilityMultiplier itself already requires elsewhere for "enough
// history to trust." withinHours default (48) is deliberately short — a
// flip from a week ago isn't "recently switched" any more, it's just this
// asset's current call.
export async function loadCallFlipData(env, nowIso, withinHours = 48) {
  const recentCutoff = new Date(new Date(nowIso).getTime() - withinHours * 3600 * 1000).toISOString();
  const recentRows = await d1(env, 'SELECT symbol, prior_dir, new_dir, flip_run_at, hours_between FROM call_flip_log WHERE flip_run_at >= ? ORDER BY flip_run_at DESC', [recentCutoff]);
  const recentFlips = {};
  for (const r of recentRows) {
    if (r.symbol in recentFlips) continue; // most recent only (rows are DESC), one caution note per asset, not a stack
    recentFlips[r.symbol] = { fromDir: r.prior_dir, toDir: r.new_dir, flipRunAt: r.flip_run_at, hoursBetween: r.hours_between };
  }

  const statRows = await d1(env, `
    SELECT symbol, COUNT(*) as n, SUM(CASE WHEN outcome = 'held' THEN 1 ELSE 0 END) as held, SUM(CASE WHEN outcome = 'reverted' THEN 1 ELSE 0 END) as reverted
    FROM call_flip_log WHERE outcome IN ('held', 'reverted') GROUP BY symbol
  `);
  const stability = {};
  for (const r of statRows) {
    if (r.n < MIN_RELIABILITY_SAMPLES) continue;
    stability[r.symbol] = { n: r.n, heldRate: r.held / r.n, revertedRate: r.reverted / r.n };
  }

  return { recentFlips, stability };
}

// { meanPct, stdevPct, n } per "symbol|slot|horizon_hours" — mirrors
// loadMoveStats' shape exactly, just with the added slot dimension.
// Consumed by timeOfDaySignal (worker.js) once a slot clears its own
// sample/effect-size bar.
export async function loadTimeOfDayStats(env) {
  const rows = await d1(env, 'SELECT symbol, slot, horizon_hours, n, sum_pct, sum_pct_sq FROM time_of_day_stats WHERE n > 0');
  const out = {};
  for (const r of rows) {
    const mean = r.sum_pct / r.n;
    const variance = Math.max(0, r.sum_pct_sq / r.n - mean * mean);
    out[`${r.symbol}|${r.slot}|${r.horizon_hours}`] = { meanPct: mean, stdevPct: Math.sqrt(variance), n: r.n };
  }
  return out;
}

// Computes and persists the realized return from "horizon hours ago" to
// "now" for every symbol, bucketed by the clock slot(s) the *earlier*
// instant belonged to (see slotsForTimestamp in worker.js). Unlike
// evaluateMatured above, this needs nothing to mature: both endpoints
// (a `horizon` hours old asset_price_log row, and this run's own
// just-logged prices) already exist by the time this runs, so it's a
// realized statistic computed immediately, not a forecast scored later.
// `thisRunPrices` is `{ symbol: { price, assetClass } }`, built by the
// caller from the same log.prices this run already logged via logRun —
// reused directly rather than re-querying what's already in memory.
export async function evaluateTimeOfDay(env, nowIso, thisRunPrices) {
  const now = new Date(nowIso).getTime();
  let updates = 0;
  for (const h of TOD_HORIZONS_HOURS) {
    const targetMs = now - h * 3600 * 1000;
    const toleranceMs = TOD_MATCH_TOLERANCE_MIN * 60 * 1000;
    const rows = await d1(env, 'SELECT run_at, symbol, price FROM asset_price_log WHERE run_at BETWEEN ? AND ?', [
      new Date(targetMs - toleranceMs).toISOString(),
      new Date(targetMs + toleranceMs).toISOString()
    ]);
    if (!rows.length) continue;

    // Nearest logged row per symbol to the ideal "h hours ago" instant.
    const nearest = {};
    for (const r of rows) {
      const diff = Math.abs(new Date(r.run_at).getTime() - targetMs);
      if (!nearest[r.symbol] || diff < nearest[r.symbol].diff) nearest[r.symbol] = { run_at: r.run_at, price: r.price, diff };
    }

    const deltas = {}; // "symbol|slot" -> { sumPct, sumPctSq, n, assetClass }
    for (const [symbol, before] of Object.entries(nearest)) {
      const after = thisRunPrices[symbol];
      if (!after || after.price == null || !before.price) continue;
      const pct = ((after.price / before.price) - 1) * 100;
      for (const slot of slotsForTimestamp(before.run_at)) {
        const key = `${symbol}|${slot}`;
        if (!deltas[key]) deltas[key] = { sumPct: 0, sumPctSq: 0, n: 0, assetClass: after.assetClass };
        deltas[key].sumPct += pct;
        deltas[key].sumPctSq += pct * pct;
        deltas[key].n += 1;
      }
    }

    await forEachConcurrent(Object.entries(deltas), D1_WRITE_CONCURRENCY, async ([key, d_]) => {
      const [symbol, slot] = key.split('|');
      await d1(env, `
        INSERT INTO time_of_day_stats (symbol, asset_class, slot, horizon_hours, n, sum_pct, sum_pct_sq, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (symbol, slot, horizon_hours) DO UPDATE SET
          n = time_of_day_stats.n + excluded.n,
          sum_pct = time_of_day_stats.sum_pct + excluded.sum_pct,
          sum_pct_sq = time_of_day_stats.sum_pct_sq + excluded.sum_pct_sq,
          updated_at = excluded.updated_at
      `, [symbol, d_.assetClass, slot, h, d_.n, d_.sumPct, d_.sumPctSq, nowIso]);
      updates++;
    });
  }
  return updates;
}

// Below this many stored days, a symbol's funding/OI percentile is too
// thin to trust — same "not enough of this asset's own history yet"
// pattern as everywhere else, gating the technique's historical-vs-
// methodology basis switch (see the 'positioning'/'openinterest'
// techniques in worker.js).
const FUNDING_HISTORY_MIN_DAYS = 20;

// { [symbol]: { fundingRates: sortedAscending[], openInterests: sortedAscending[] } }
// from the permanent funding_rate_daily archive — consumed by
// percentileRank (worker.js) to turn today's live funding/OI reading into
// an asset-relative percentile. A symbol only gets an array once it has
// FUNDING_HISTORY_MIN_DAYS real days on record; until then its entry is
// omitted (not a thin/misleading array), same abstain-not-guess pattern
// used throughout this engine.
export async function loadFundingHistory(env) {
  const rows = await d1(env, 'SELECT symbol, funding_rate, open_interest FROM funding_rate_daily');
  const bySymbol = {};
  for (const r of rows) {
    const rec = (bySymbol[r.symbol] ??= { fundingRates: [], openInterests: [] });
    if (r.funding_rate != null) rec.fundingRates.push(r.funding_rate);
    if (r.open_interest != null) rec.openInterests.push(r.open_interest);
  }
  const out = {};
  for (const [symbol, rec] of Object.entries(bySymbol)) {
    const fundingRates = rec.fundingRates.length >= FUNDING_HISTORY_MIN_DAYS ? rec.fundingRates.slice().sort((a, b) => a - b) : null;
    const openInterests = rec.openInterests.length >= FUNDING_HISTORY_MIN_DAYS ? rec.openInterests.slice().sort((a, b) => a - b) : null;
    if (fundingRates || openInterests) out[symbol] = { fundingRates, openInterests };
  }
  return out;
}

// { [symbol]: { dvols: sortedAscending[], current: number } } from the
// permanent iv_daily archive — same percentileRank consumption pattern as
// loadFundingHistory, adapted for a source with no separate "live" fetch:
// unlike funding (a true live-per-hour value ranked against archived
// history), DVOL's only source IS the archived daily history, so its own
// most-recent point doubles as "today's" reading, ranked against the full
// sorted series including itself.
export async function loadIvHistory(env) {
  const rows = await d1(env, 'SELECT symbol, date, dvol FROM iv_daily ORDER BY date ASC');
  const bySymbol = {};
  for (const r of rows) {
    const rec = (bySymbol[r.symbol] ??= { dvols: [], current: null });
    rec.dvols.push(r.dvol);
    rec.current = r.dvol; // last write wins, ascending date order -> most recent
  }
  const out = {};
  for (const [symbol, rec] of Object.entries(bySymbol)) {
    if (rec.dvols.length < FUNDING_HISTORY_MIN_DAYS) continue;
    out[symbol] = { dvols: rec.dvols.slice().sort((a, b) => a - b), current: rec.current };
  }
  return out;
}

// { [symbol]: number (-1..1) } pooling CoinGecko's community up-vote %
// (rescaled from 0-100 to -1..1) and CryptoPanic's already -1..1 news
// score, from the MOST RECENT sentiment_daily row per symbol — "today's
// reading," not a smoothed average (the technique_reliability learning
// loop already handles smoothing accuracy over time; this should reflect
// current mood). Consumed as m.sentimentScore by the 'sentiment'
// technique in worker.js.
export async function loadSentimentMap(env) {
  const rows = await d1(env, `
    SELECT symbol, coingecko_up_pct, cryptopanic_score, date FROM sentiment_daily
    WHERE symbol != '' AND (coingecko_up_pct IS NOT NULL OR cryptopanic_score IS NOT NULL)
    ORDER BY date DESC
  `);
  const out = {};
  for (const r of rows) {
    if (r.symbol in out) continue; // first hit per symbol (DESC order) = most recent
    const parts = [];
    if (r.coingecko_up_pct != null) parts.push((r.coingecko_up_pct - 50) / 50);
    if (r.cryptopanic_score != null) parts.push(r.cryptopanic_score);
    if (parts.length) out[r.symbol] = parts.reduce((a, b) => a + b, 0) / parts.length;
  }
  return out;
}

// Raw utility/community fields per symbol (github_commits_4w etc., see
// sentiment_daily's own docs, schema.sql) — separate from loadSentimentMap
// above deliberately: that one blends coingecko_up_pct/cryptopanic_score
// into a single -1..1 SENTIMENT number for the `sentiment` technique's own
// use; this is a different concept (fundamentals, not mood) computed into
// a cross-sectional percentile composite by computeQualityScores
// (worker.js), which needs the raw per-metric numbers, not a pre-blended
// score. Same source table, same "most recent row per symbol" pattern.
export async function loadQualityData(env) {
  const rows = await d1(env, `
    SELECT symbol, github_commits_4w, github_pr_contributors, community_reach, watchlist_users, date FROM sentiment_daily
    WHERE symbol != '' AND (github_commits_4w IS NOT NULL OR github_pr_contributors IS NOT NULL OR community_reach IS NOT NULL OR watchlist_users IS NOT NULL)
    ORDER BY date DESC
  `);
  const out = {};
  for (const r of rows) {
    if (r.symbol in out) continue; // first hit per symbol (DESC order) = most recent
    out[r.symbol] = {
      githubCommits4w: r.github_commits_4w, githubPrContributors: r.github_pr_contributors,
      communityReach: r.community_reach, watchlistUsers: r.watchlist_users
    };
  }
  return out;
}

// Which crypto symbols are currently in a sustained multi-month
// outperformance streak vs the broad market (asset_rotation_status,
// computeOutperformanceRotations/archive.mjs, run daily) — the "Solana-
// then/Hyperliquid-now" pattern. Grouped by symbol for a plain property
// read, same shape loadRecentEvents/loadSrLevels use.
export async function loadRotationStatus(env) {
  const rows = await d1(env, 'SELECT symbol, start_date, end_date, checkpoints, peak_rel_pct FROM asset_rotation_status');
  const out = {};
  for (const r of rows) out[r.symbol] = { startDate: r.start_date, endDate: r.end_date, checkpoints: r.checkpoints, peakRel: r.peak_rel_pct };
  return out;
}

// "Long-term potential" candidates (user-requested 2026-08-24) —
// computeLongTermBottomCandidates/replaceLongTermBottomCandidates
// (archive.mjs) refresh this daily; see detectPossibleLongTermBottom's
// own docs (worker.js) for the real research behind it and why it
// carries no ranking/confidence signal. Purely descriptive; not
// financial advice.
export async function loadLongTermBottomStatus(env) {
  const rows = await d1(env, 'SELECT symbol, low_close, low_date, days_since_low, current_close, pct_above_low FROM long_term_bottom_status');
  const out = {};
  for (const r of rows) out[r.symbol] = { lowClose: r.low_close, lowDate: r.low_date, daysSinceLow: r.days_since_low, currentClose: r.current_close, pctAboveLow: r.pct_above_low };
  return out;
}

// { [followerSymbol]: [{leaderSymbol, lagDays, corr, samples}] } — grouped
// by follower for direct per-asset lookup by the leadlag technique
// (worker.js). Relationships are (re)computed daily by computeLeadLag
// (scripts/archive.mjs, driven from scripts/daily-refresh.mjs); this just
// loads whatever's currently registered.
export async function loadLeadLagSignals(env) {
  const rows = await d1(env, 'SELECT leader_symbol, follower_symbol, lag_days, corr, samples FROM lead_lag_signals');
  const out = {};
  for (const r of rows) {
    (out[r.follower_symbol] ??= []).push({ leaderSymbol: r.leader_symbol, lagDays: r.lag_days, corr: r.corr, samples: r.samples });
  }
  return out;
}

// Snapshots assetPredictionScore() for every symbol with enough matured
// history into asset_score_snapshots, keyed by (symbol, date) — turns the
// existing cumulative all-time score into a real trend line. Upserts (not
// INSERT OR IGNORE): called every hour, so today's row reflects the latest
// computation each time it runs, while past days stay frozen once their
// own date has passed — a live-updating "today" with real history behind
// it, not a once-a-day snapshot that could miss the day entirely if that
// one run failed.
export async function snapshotAssetScores(env, date, reliability, rangeReliability, baselines) {
  const symbols = new Set();
  for (const key of Object.keys(reliability || {})) symbols.add(key.split('|')[0]);
  for (const symbol of Object.keys(rangeReliability || {})) symbols.add(symbol);
  if (!symbols.size) return 0;

  const classRows = await d1(env, 'SELECT DISTINCT symbol, asset_class FROM technique_reliability');
  const classBySymbol = Object.fromEntries(classRows.map((r) => [r.symbol, r.asset_class]));

  const rows = [];
  for (const symbol of symbols) {
    const score = assetPredictionScore(symbol, reliability, rangeReliability, classBySymbol[symbol], baselines);
    if (score && classBySymbol[symbol]) rows.push({ symbol, assetClass: classBySymbol[symbol], score: score.score, samples: score.samples });
  }
  let written = 0;
  for (const batch of chunk(rows, 15)) {
    const placeholders = batch.map(() => '(?,?,?,?,?)').join(',');
    const params = batch.flatMap((r) => [r.symbol, r.assetClass, date, r.score, r.samples]);
    await d1(env, `
      INSERT INTO asset_score_snapshots (symbol, asset_class, snapshot_date, score, samples)
      VALUES ${placeholders}
      ON CONFLICT (symbol, snapshot_date) DO UPDATE SET
        score = excluded.score,
        samples = excluded.samples
    `, params);
    written += batch.length;
  }
  return written;
}

// Forward half of the swing-time-of-day profile (see computeSwingTimeTallies
// in archive.mjs for the one-time backfill half — same day-bucketing logic,
// so both build one consistent statistic, not two different ones). Pulls
// the previous UTC calendar day's rows straight from asset_price_log
// (already retained ~200h, comfortably covers "yesterday"), finds that
// day's max/min price and which clock slots those hours belong to, and
// tallies them. Runs once/day from daily-refresh.mjs.
export async function evaluateYesterdaySwingTimes(env, nowIso) {
  const now = new Date(nowIso);
  const y = new Date(now);
  y.setUTCDate(y.getUTCDate() - 1);
  const dayStart = new Date(Date.UTC(y.getUTCFullYear(), y.getUTCMonth(), y.getUTCDate())).toISOString();
  const dayEnd = new Date(Date.UTC(y.getUTCFullYear(), y.getUTCMonth(), y.getUTCDate(), 23, 59, 59, 999)).toISOString();

  const rows = await d1(env, 'SELECT run_at, asset_class, symbol, price FROM asset_price_log WHERE run_at BETWEEN ? AND ?', [dayStart, dayEnd]);
  const bySymbol = {};
  for (const r of rows) {
    (bySymbol[r.symbol] ??= { assetClass: r.asset_class, bars: [] }).bars.push({ ts: r.run_at, close: r.price });
  }

  let updated = 0;
  for (const [symbol, { assetClass, bars }] of Object.entries(bySymbol)) {
    const { tallies, totalDays } = computeSwingTimeTallies(bars);
    if (totalDays > 0) {
      await upsertSwingTimeStats(env, symbol, assetClass, tallies, totalDays, nowIso);
      updated++;
    }
  }
  return updated;
}

// { [symbol|slot|extremeType]: { count, totalDays } } — consumed by
// swingTimeSignal (worker.js) to check whether the CURRENT clock slot has
// a proven tendency to hold this asset's daily high or low.
export async function loadSwingTimeStats(env) {
  const rows = await d1(env, 'SELECT symbol, slot, extreme_type, count, total_days FROM swing_time_stats WHERE total_days > 0');
  const out = {};
  for (const r of rows) out[`${r.symbol}|${r.slot}|${r.extreme_type}`] = { count: r.count, totalDays: r.total_days };
  return out;
}

// Recent hack/exploit events per symbol (see asset_events, populated by
// fetchDefiLlamaHacks/matchHacksToUniverse in archive.mjs, run daily).
// Only pulls events within `withinDays` — the eventshock technique
// (worker.js) only cares about recent shocks, not the full ~10-year
// history — so this stays cheap regardless of how large asset_events
// grows over time.
export async function loadRecentEvents(env, nowIso, withinDays = 14) {
  const cutoff = new Date(new Date(nowIso).getTime() - withinDays * 86400000).toISOString().slice(0, 10);
  const rows = await d1(env, 'SELECT symbol, event_date, event_type, severity_usd, description FROM asset_events WHERE symbol IS NOT NULL AND event_date >= ?', [cutoff]);
  const out = {};
  for (const r of rows) (out[r.symbol] ??= []).push({ date: r.event_date, type: r.event_type, severityUsd: r.severity_usd, description: r.description });
  return out;
}

// Current key support/resistance levels per symbol (see
// computeSrLevelsAndBreaks/replaceSrLevels, archive.mjs, run daily off the
// permanent archive). Grouped by symbol so the 'srbreak' technique
// (worker.js) can look up one asset's levels with a plain property read,
// same shape loadRecentEvents uses.
export async function loadSrLevels(env) {
  const rows = await d1(env, 'SELECT symbol, level, level_type, touches FROM asset_sr_levels');
  const out = {};
  for (const r of rows) (out[r.symbol] ??= []).push({ level: r.level, levelType: r.level_type, touches: r.touches });
  return out;
}

// Calibrated move size following a break of a tracked level — same
// mean/stdev-from-running-sums shape loadMoveStats uses, just keyed by
// sr_break_stats' bucket_key (a symbol once it has enough of its own break
// history, else a pooled `asset_class|level_type` key — see
// replaceSrBreakStats' docs) instead of a plain symbol.
export async function loadSrBreakStats(env) {
  const rows = await d1(env, 'SELECT bucket_key, horizon_hours, n, sum_pct, sum_pct_sq FROM sr_break_stats WHERE n > 0');
  const out = {};
  for (const r of rows) {
    const mean = r.sum_pct / r.n;
    const variance = Math.max(0, r.sum_pct_sq / r.n - mean * mean);
    out[`${r.bucket_key}|${r.horizon_hours}`] = { meanPct: mean, stdevPct: Math.sqrt(variance), n: r.n };
  }
  return out;
}

export { MIN_RELIABILITY_SAMPLES };

// Median/p80 daily range per symbol (asset_daily_range, written daily by
// computeDailyRangeStats/archive.mjs). This is the yardstick the day-trading
// range-exhaustion read divides by — see dayRangeSignal in worker.js. Symbols
// whose bars carry no high/low simply have no row and are abstained on.
export async function loadDailyRangeStats(env) {
  const rows = await d1(env, 'SELECT symbol, median_range_pct, p80_range_pct, samples FROM asset_daily_range');
  const out = {};
  for (const r of rows) {
    out[r.symbol] = { medianPct: r.median_range_pct, p80Pct: r.p80_range_pct, samples: r.samples };
  }
  return out;
}

// Best/worst hour-of-day per symbol (time_of_day_edge, recomputed daily by
// computeTimeOfDayEdge/archive.mjs). Only cells that clear BOTH bars are
// returned: a significance bar set for the number of hypotheses tested, and
// the chronological split-half consistency check. Everything else is dropped
// here rather than shipped with a caveat — a "best time" the engine cannot
// stand behind is worse than none.
export async function loadTimeOfDayEdge(env) {
  const rows = await d1(env, 'SELECT symbol, slot, n, mean_pct, t_stat, win_rate, h1_mean, h2_mean FROM time_of_day_edge WHERE consistent = 1 AND ABS(t_stat) >= ?', [TOD_EDGE_SIGNIFICANCE_T]);
  const bySymbol = {};
  for (const r of rows) {
    // Only clock-hour slots drive the buy/sell window; dow_utc_N is a
    // different kind of statement (a whole weekday) and is surfaced through the
    // discovery loop's day-of-week family instead of as an intraday window.
    if (!r.slot.startsWith('hour_')) continue;
    (bySymbol[r.symbol] ??= []).push({
      slot: r.slot, n: r.n, meanPct: r.mean_pct, t: r.t_stat,
      winRate: r.win_rate, h1: r.h1_mean, h2: r.h2_mean
    });
  }
  // Zone slots are NOT independent. Tokyo has no DST, so hour_tyo_05 and
  // hour_utc_20 are literally the same bucket under two names and report
  // identical n and mean; London and New York shift together for most of the
  // year, so hour_ldn_21 and hour_et_16 largely coincide too. Presenting those
  // as separate findings would triple-count one observation.
  //
  // Exact duplicates (same n, same mean to 6dp) are collapsed, keeping the
  // most meaningful label — an exchange-anchored slot says "the US close",
  // where a UTC hour says nothing about why.
  const slotRank = (slot) => (slot.startsWith('hour_et_') ? 0 : slot.startsWith('hour_ldn_') ? 1 : slot.startsWith('hour_utc_') ? 2 : 3);
  const out = {};
  for (const [symbol, hours] of Object.entries(bySymbol)) {
    const seen = new Map();
    for (const h of hours) {
      const key = `${h.n}|${h.meanPct.toFixed(6)}`;
      const prior = seen.get(key);
      if (!prior || slotRank(h.slot) < slotRank(prior.slot)) seen.set(key, h);
    }
    const deduped = [...seen.values()];
    deduped.sort((a, b) => b.meanPct - a.meanPct);
    const best = deduped[0];
    const worst = deduped[deduped.length - 1];
    out[symbol] = {
      hours: deduped,
      // "Buy" = the start of the hour with the strongest positive forward
      // return; "sell" = the start of the strongest negative one. Only offered
      // when the sign actually points that way, never just "the least bad".
      buyHour: best && best.meanPct > 0 ? best : null,
      sellHour: worst && worst.meanPct < 0 ? worst : null
    };
  }
  return out;
}

// ~24 hours x the tracked symbol count is a few hundred hypotheses, so the bar
// is well above a conventional 1.96. Deliberately NOT relaxed on the grounds
// that several assets agree: BTC, ETH, ADA, BNB, BCH and XRP are highly
// correlated, so their agreement is closer to one observation than to six.
//
// Storing four timezone families does not multiply the hypothesis count the way
// it appears to: the zones are largely redundant views of the same 24 buckets
// (see the dedup above), so the effective number of independent tests is still
// roughly 24 per symbol. The headline result clears this bar with room to
// spare either way — hour_et_16 reaches t=5.3-5.9 across BTC, ETH and BNB.
const TOD_EDGE_SIGNIFICANCE_T = 3.3;

// The retrospective's own findings, for display (user-requested
// 2026-08-31). Two parts, and the second is the one that matters:
// `recent` is the individual episodes, `patterns` is the cumulative
// answer to "which failure mode dominates" — the thing that tells the
// engine what to fix next rather than merely what it got wrong once.
//
// Read-only and entirely optional: the retrospective job (scripts/
// retrospective.mjs) runs on its own daily schedule, so on a fresh
// database — or any run before that job has fired even once — these
// tables simply do not exist yet. That is a normal state, not an error,
// so this returns null on any failure rather than taking the hourly build
// down over a display-only section.
export async function loadRetrospective(env, limit = 12) {
  try {
    const [patterns, recent] = await Promise.all([
      d1(env, 'SELECT cause, n, share, avg_move_pct, avg_available_pct, avg_lead_hours, n_detected, updated_at FROM retrospective_patterns ORDER BY n DESC'),
      d1(env, `SELECT run_at, symbol, name, mcap_rank, move_pct, cause, detected, detectable_at, surge_ratio, trade_ratio, lead_hours, gain_to_peak_pct
                 FROM retrospective_misses ORDER BY run_at DESC, ABS(move_pct) DESC LIMIT ?`, [limit])
    ]);
    if (!patterns.length && !recent.length) return null;
    return {
      patterns: patterns.map((r) => ({
        cause: r.cause, n: r.n, share: r.share, avgMovePct: r.avg_move_pct,
        avgAvailablePct: r.avg_available_pct, avgLeadHours: r.avg_lead_hours,
        nDetected: r.n_detected, updatedAt: r.updated_at
      })),
      recent: recent.map((r) => ({
        runAt: r.run_at, symbol: r.symbol, name: r.name, rank: r.mcap_rank,
        movePct: r.move_pct, cause: r.cause, detected: r.detected === 1,
        detectableAt: r.detectable_at, surgeRatio: r.surge_ratio, tradeRatio: r.trade_ratio,
        leadHours: r.lead_hours, gainToPeakPct: r.gain_to_peak_pct
      }))
    };
  } catch (e) {
    console.error('loadRetrospective failed (display-only, ignored):', e.message || e);
    return null;
  }
}

// Display-only view of the automatic quant-research lifecycle. Statistical
// discovery status and trade eligibility are intentionally separate: a row
// can be interesting but still be an explicit abstention after costs or
// walk-forward testing. Nothing here feeds scoring.
export async function loadQuantResearch(env, limit = 20) {
  try {
    const [countRows, rows] = await Promise.all([
      d1(env, `
        SELECT r.status, COALESCE(m.trade_decision, 'abstain') AS trade_decision, COUNT(*) AS n
        FROM research_registry r
        LEFT JOIN research_strategy_metrics m ON m.hypothesis = r.hypothesis
        GROUP BY r.status, COALESCE(m.trade_decision, 'abstain')
      `),
      d1(env, `
        SELECT r.hypothesis, r.family, r.asset_class, r.symbol, r.horizon_days,
               r.status, r.discovered_at, r.discovery_n, r.discovery_effect,
               r.discovery_z, r.tests_in_family, r.oos_n, r.oos_effect, r.oos_z,
               m.strategy_direction, m.assumed_round_trip_cost_pct,
               m.walk_forward_verdict, m.walk_forward_folds,
               m.trade_decision, m.decision_reason, m.oos_trade_n,
               m.oos_net_mean_pct, m.oos_net_lower_95_pct,
               m.oos_win_rate_pct, m.oos_profit_factor,
               m.oos_compound_return_pct, m.oos_max_drawdown_pct,
               m.oos_worst_trade_pct, m.updated_at
        FROM research_registry r
        LEFT JOIN research_strategy_metrics m ON m.hypothesis = r.hypothesis
        ORDER BY
          CASE COALESCE(m.trade_decision, 'abstain')
            WHEN 'confirmed' THEN 0 WHEN 'provisional' THEN 1 ELSE 2 END,
          COALESCE(m.oos_net_lower_95_pct, -999999) DESC,
          r.discovered_at DESC
        LIMIT ?
      `, [limit])
    ]);
    const lifecycle = {};
    const decisions = {};
    for (const row of countRows) {
      lifecycle[row.status] = (lifecycle[row.status] || 0) + Number(row.n);
      decisions[row.trade_decision] = (decisions[row.trade_decision] || 0) + Number(row.n);
    }
    return {
      lifecycle, decisions,
      promotionRule: 'family-corrected discovery -> purged walk-forward -> positive after-cost lower bound -> independent post-discovery confirmation',
      rows: rows.map((row) => ({
        hypothesis: row.hypothesis, family: row.family,
        assetClass: row.asset_class, symbol: row.symbol,
        horizonDays: Number(row.horizon_days), status: row.status,
        discoveredAt: row.discovered_at, discoveryN: Number(row.discovery_n),
        discoveryEffectPct: row.discovery_effect, discoveryZ: row.discovery_z,
        testsInFamily: Number(row.tests_in_family), oosN: Number(row.oos_n || 0),
        oosEffectPct: row.oos_effect, oosZ: row.oos_z,
        side: row.strategy_direction || 'abstain',
        assumedCostPct: row.assumed_round_trip_cost_pct,
        walkForward: row.walk_forward_verdict || 'insufficient',
        walkForwardFolds: Number(row.walk_forward_folds || 0),
        decision: row.trade_decision || 'abstain', reason: row.decision_reason || 'not-yet-evaluated',
        trades: Number(row.oos_trade_n || 0), netMeanPct: row.oos_net_mean_pct,
        netLower95Pct: row.oos_net_lower_95_pct, winRatePct: row.oos_win_rate_pct,
        profitFactor: row.oos_profit_factor, compoundReturnPct: row.oos_compound_return_pct,
        maxDrawdownPct: row.oos_max_drawdown_pct, worstTradePct: row.oos_worst_trade_pct,
        updatedAt: row.updated_at
      }))
    };
  } catch (error) {
    console.error('loadQuantResearch failed (display-only, ignored):', error.message || error);
    return null;
  }
}
