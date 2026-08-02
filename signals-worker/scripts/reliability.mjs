// D1-backed reliability learning loop for the confluence engine. Runs from
// build-signals.mjs (plain Node, GitHub Actions) — the Worker itself never
// touches D1, only the hourly build needs this, not request-time serving.
// Talks to Cloudflare's D1 HTTP API directly via d1-client.mjs, shared with
// the archive/backfill scripts so there's one D1 client, not a hand-copied
// duplicate that could drift.
import { MIN_RELIABILITY_SAMPLES, slotsForTimestamp } from '../worker.js';
import { d1, chunk } from './d1-client.mjs';

// Matches the horizons timeOfDaySignal (worker.js) checks.
const TOD_HORIZONS_HOURS = [1, 4];
// How far a logged asset_price_log row is allowed to sit from the ideal
// "horizon hours ago" instant and still count as that horizon's
// observation — the hourly cadence isn't perfectly on-the-hour (see
// signals-refresh.yml's :13-past note), so this tolerates normal jitter
// while still rejecting a genuinely skipped cycle (which just means that
// horizon is skipped this run, not mismeasured).
const TOD_MATCH_TOLERANCE_MIN = 40;

const HORIZONS_HOURS = [24, 168];
const EVAL_COLUMN = { 24: 'evaluated_24', 168: 'evaluated_168' };
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
// A bit past the longer 168h horizon, for the price-log join plus buffer.
const RETENTION_HOURS = 200;
// Hard cap regardless of evaluated status, so a symbol that drops out of
// the universe (delisted stock, coin falls out of top-100) can't leave
// orphaned rows growing forever.
const HARD_CAP_HOURS = 24 * 30;

// Returns { blended, byHorizon }. `blended` sums raw correct/total across
// horizons (equivalent to a total-weighted average of each horizon's
// accuracy, so a horizon with more matured samples gets proportionally
// more say) — this is what evaluateTechniques() uses to weight a
// technique's vote. `byHorizon` keeps 24h and 168h separate — this is what
// confluence()'s horizonEstimate() uses to answer "at which horizon has
// this asset's own history actually been more accurate," which a blended
// number can't answer.
export async function loadReliability(env) {
  const rows = await d1(env, 'SELECT symbol, technique_id, horizon_hours, correct, total FROM technique_reliability WHERE total > 0');
  const acc = {};
  const byHorizon = { 24: {}, 168: {} };
  for (const r of rows) {
    const key = `${r.symbol}|${r.technique_id}`;
    if (!acc[key]) acc[key] = { correct: 0, total: 0 };
    acc[key].correct += r.correct;
    acc[key].total += r.total;
    if (byHorizon[r.horizon_hours]) byHorizon[r.horizon_hours][key] = { correct: r.correct, total: r.total };
  }
  const blended = {};
  for (const [key, v] of Object.entries(acc)) {
    blended[key] = { correct: v.correct, accuracy: v.total ? v.correct / v.total : 0.5, total: v.total };
  }
  return { blended, byHorizon };
}

// Range-prediction hit rate (was realized price actually inside the
// predicted band), pooled across both horizons per symbol — mirrors how
// `blended` above pools technique_reliability across horizons. Consumed
// by assetPredictionScore() in worker.js as one of the pooled inputs to
// an asset's overall track-record score.
export async function loadRangeReliability(env) {
  const rows = await d1(env, 'SELECT symbol, SUM(hits) AS hits, SUM(total) AS total FROM range_reliability WHERE total > 0 GROUP BY symbol');
  const out = {};
  for (const r of rows) out[r.symbol] = { hits: r.hits, total: r.total };
  return out;
}

// Persists this run's per-asset price and per-technique directional votes,
// to be scored once they mature (see evaluateMatured).
export async function logRun(env, runAt, log) {
  for (const batch of chunk(log.prices, CHUNK)) {
    const placeholders = batch.map(() => '(?,?,?,?)').join(',');
    const params = batch.flatMap((p) => [runAt, p.asset_class, p.symbol, p.price]);
    await d1(env, `INSERT OR REPLACE INTO asset_price_log (run_at, asset_class, symbol, price) VALUES ${placeholders}`, params);
  }
  for (const batch of chunk(log.votes, CHUNK)) {
    const placeholders = batch.map(() => '(?,?,?,?,?)').join(',');
    const params = batch.flatMap((v) => [runAt, v.asset_class, v.symbol, v.technique_id, v.dir]);
    await d1(env, `INSERT OR REPLACE INTO technique_votes (run_at, asset_class, symbol, technique_id, dir) VALUES ${placeholders}`, params);
  }
  for (const batch of chunk(log.ranges || [], CHUNK)) {
    const placeholders = batch.map(() => '(?,?,?,?,?,?)').join(',');
    const params = batch.flatMap((r) => [runAt, r.asset_class, r.symbol, r.horizon_hours, r.low, r.high]);
    await d1(env, `INSERT OR REPLACE INTO range_log (run_at, asset_class, symbol, horizon_hours, low, high) VALUES ${placeholders}`, params);
  }
}

// Per-asset realized move size at each horizon, learned continuously —
// { blended, byHorizon } from loadReliability answers "which technique is
// reliable"; this answers "how big does this asset's move actually tend
// to be," which predictedRange() uses once there's enough of an asset's
// own history to trust over the generic realized-volatility fallback.
// Keyed by "symbol|horizon_hours" -> { meanPct, stdevPct, n }, computed
// from running sum/sum-of-squares (Welford-lite, fine at this volume).
export async function loadMoveStats(env) {
  const rows = await d1(env, 'SELECT symbol, horizon_hours, n, sum_pct, sum_pct_sq FROM asset_move_stats WHERE n > 0');
  const out = {};
  for (const r of rows) {
    const mean = r.sum_pct / r.n;
    const variance = Math.max(0, r.sum_pct_sq / r.n - mean * mean);
    out[`${r.symbol}|${r.horizon_hours}`] = { meanPct: mean, stdevPct: Math.sqrt(variance), n: r.n };
  }
  return out;
}

// Finds technique_votes rows old enough to have matured for each horizon
// and not yet scored for it, compares that run's logged price against the
// most recent price on record for the same symbol, and folds the
// correct/incorrect outcome into technique_reliability. Also folds the
// *realized move size* into asset_move_stats — once per (symbol, run_at,
// horizon), not once per technique-vote row, since several techniques
// voting on the same asset in the same hour all describe the exact same
// underlying price move, not independent observations of it (the same
// correlation trap fixed in horizonEstimate's confidence gate). Returns
// how many (symbol, technique, horizon) outcomes were scored this call.
export async function evaluateMatured(env, nowIso) {
  const now = new Date(nowIso).getTime();
  let evaluatedCount = 0;

  for (const h of HORIZONS_HOURS) {
    const cutoff = new Date(now - h * 3600 * 1000).toISOString();
    const col = EVAL_COLUMN[h];
    const due = await d1(env, `SELECT run_at, asset_class, symbol, technique_id, dir FROM technique_votes WHERE run_at <= ? AND ${col} = 0`, [cutoff]);
    // Range predictions logged at this same horizon (see RANGE_LOG_HORIZONS_DAYS
    // in worker.js) — each row matures once, at its own horizon_hours, so
    // there's no evaluated flag to filter on here, just the cutoff.
    const dueRanges = await d1(env, 'SELECT run_at, asset_class, symbol, low, high FROM range_log WHERE horizon_hours = ? AND run_at <= ?', [h, cutoff]);
    if (!due.length && !dueRanges.length) continue;

    // Most recent logged price per symbol ("now"). Builds run hourly, so
    // the set of distinct symbols among "due"/"dueRanges" rows is at most
    // the universe size, not unbounded.
    const symbols = [...new Set([...due.map((r) => r.symbol), ...dueRanges.map((r) => r.symbol)])];
    const priceNow = {};
    for (const batch of chunk(symbols, CHUNK)) {
      const placeholders = batch.map(() => '?').join(',');
      const rows = await d1(env, `SELECT symbol, price FROM asset_price_log WHERE symbol IN (${placeholders}) ORDER BY run_at DESC`, batch);
      for (const r of rows) if (!(r.symbol in priceNow)) priceNow[r.symbol] = r.price; // first hit per symbol = most recent
    }

    // Price at forecast time. "due" rows cluster into a small number of
    // distinct run_at values each call (roughly one per elapsed hour since
    // this last ran), so this stays a handful of queries, not one per row.
    const runAts = [...new Set([...due.map((r) => r.run_at), ...dueRanges.map((r) => r.run_at)])];
    const priceBefore = {};
    for (const runAt of runAts) {
      const rows = await d1(env, 'SELECT symbol, price FROM asset_price_log WHERE run_at = ?', [runAt]);
      for (const r of rows) priceBefore[`${runAt}|${r.symbol}`] = r.price;
    }

    // Range containment only needs the "after" price (was it inside
    // [low, high]), not "before" — unlike technique_votes' directional
    // check, there's no direction to compare against.
    const rangeDeltas = {}; // symbol -> { hits, total, asset_class }
    for (const r of dueRanges) {
      const after = priceNow[r.symbol];
      if (after == null) continue; // symbol vanished from the universe; hard-cap prune handles it eventually
      if (!rangeDeltas[r.symbol]) rangeDeltas[r.symbol] = { hits: 0, total: 0, asset_class: r.asset_class };
      rangeDeltas[r.symbol].total += 1;
      if (after >= r.low && after <= r.high) rangeDeltas[r.symbol].hits += 1;
    }
    for (const [symbol, d] of Object.entries(rangeDeltas)) {
      await d1(env, `
        INSERT INTO range_reliability (asset_class, symbol, horizon_hours, hits, total, accuracy, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (symbol, horizon_hours) DO UPDATE SET
          hits = range_reliability.hits + excluded.hits,
          total = range_reliability.total + excluded.total,
          accuracy = CAST(range_reliability.hits + excluded.hits AS REAL) / (range_reliability.total + excluded.total),
          updated_at = excluded.updated_at
      `, [d.asset_class, symbol, h, d.hits, d.total, d.total ? d.hits / d.total : 0, nowIso]);
    }
    if (dueRanges.length) await d1(env, 'DELETE FROM range_log WHERE horizon_hours = ? AND run_at <= ?', [h, cutoff]);

    const deltas = {}; // "symbol|technique_id" -> { correct, total, asset_class }
    const moveDeltas = {}; // "symbol" -> { n, sumPct, sumPctSq } — one realized move per (symbol, run_at), deduped across techniques
    const seenMoves = new Set();
    const evaluatedSymbolsByRunAt = {}; // only mark rows we could actually score
    for (const r of due) {
      const before = priceBefore[`${r.run_at}|${r.symbol}`];
      const after = priceNow[r.symbol];
      if (before == null || after == null || !before) continue; // symbol vanished from the universe; leave pending, hard-cap prune handles it eventually
      const pct = ((after / before) - 1) * 100;
      const actualDir = pct > OUTCOME_DEADBAND_PCT ? 1 : pct < -OUTCOME_DEADBAND_PCT ? -1 : 0;
      const key = `${r.symbol}|${r.technique_id}`;
      if (!deltas[key]) deltas[key] = { correct: 0, total: 0, asset_class: r.asset_class };
      deltas[key].total += 1;
      if (r.dir === actualDir) deltas[key].correct += 1;
      (evaluatedSymbolsByRunAt[r.run_at] ??= new Set()).add(r.symbol);

      const moveKey = `${r.run_at}|${r.symbol}`;
      if (!seenMoves.has(moveKey)) {
        seenMoves.add(moveKey);
        if (!moveDeltas[r.symbol]) moveDeltas[r.symbol] = { n: 0, sumPct: 0, sumPctSq: 0 };
        moveDeltas[r.symbol].n += 1;
        moveDeltas[r.symbol].sumPct += pct;
        moveDeltas[r.symbol].sumPctSq += pct * pct;
      }
    }

    for (const [key, d] of Object.entries(deltas)) {
      const [symbol, techniqueId] = key.split('|');
      await d1(env, `
        INSERT INTO technique_reliability (asset_class, symbol, technique_id, horizon_hours, correct, total, accuracy, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (symbol, technique_id, horizon_hours) DO UPDATE SET
          correct = technique_reliability.correct + excluded.correct,
          total = technique_reliability.total + excluded.total,
          accuracy = CAST(technique_reliability.correct + excluded.correct AS REAL) / (technique_reliability.total + excluded.total),
          updated_at = excluded.updated_at
      `, [d.asset_class, symbol, techniqueId, h, d.correct, d.total, d.total ? d.correct / d.total : 0, nowIso]);
      evaluatedCount += d.total;
    }

    for (const [symbol, d] of Object.entries(moveDeltas)) {
      await d1(env, `
        INSERT INTO asset_move_stats (symbol, horizon_hours, n, sum_pct, sum_pct_sq, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (symbol, horizon_hours) DO UPDATE SET
          n = asset_move_stats.n + excluded.n,
          sum_pct = asset_move_stats.sum_pct + excluded.sum_pct,
          sum_pct_sq = asset_move_stats.sum_pct_sq + excluded.sum_pct_sq,
          updated_at = excluded.updated_at
      `, [symbol, h, d.n, d.sumPct, d.sumPctSq, nowIso]);
    }

    for (const [runAt, symSet] of Object.entries(evaluatedSymbolsByRunAt)) {
      for (const batch of chunk([...symSet], CHUNK)) {
        const placeholders = batch.map(() => '?').join(',');
        await d1(env, `UPDATE technique_votes SET ${col} = 1 WHERE run_at = ? AND symbol IN (${placeholders})`, [runAt, ...batch]);
      }
    }
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

    for (const [key, d_] of Object.entries(deltas)) {
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
    }
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

export { MIN_RELIABILITY_SAMPLES };
