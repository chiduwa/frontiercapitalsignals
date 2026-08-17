// D1-backed reliability learning loop for the confluence engine. Runs from
// build-signals.mjs (plain Node, GitHub Actions) — the Worker itself never
// touches D1, only the hourly build needs this, not request-time serving.
// Talks to Cloudflare's D1 HTTP API directly via d1-client.mjs, shared with
// the archive/backfill scripts so there's one D1 client, not a hand-copied
// duplicate that could drift.
import { MIN_RELIABILITY_SAMPLES, slotsForTimestamp, assetPredictionScore, scoreBucket, TOD_HORIZONS_HOURS } from '../worker.js';
import { d1, chunk } from './d1-client.mjs';
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

// { trending: { "symbol|technique_id": {correct, accuracy, total} }, choppy:
// {...} } — same blended-across-horizons shape loadReliability's own
// `blended` uses, just grouped by regime instead of pooling everything.
// Consumed by reliabilityMultiplier (worker.js) as the regime-specific
// alternative to blended, with the exact same MIN_RELIABILITY_SAMPLES +
// significance bar applied there before it's ever preferred over blended.
export async function loadRegimeReliability(env) {
  const rows = await d1(env, 'SELECT symbol, technique_id, regime, correct, total FROM technique_regime_reliability WHERE total > 0');
  // Pool across horizon_hours (two rows per symbol|technique|regime, one
  // per HORIZONS_HOURS entry) exactly the way loadReliability's own
  // `blended` pools across horizons — accumulate first, compute accuracy
  // once totals are final, not per-row (a per-row overwrite would silently
  // drop whichever horizon's row got processed first).
  const acc = { trending: {}, choppy: {} };
  for (const r of rows) {
    if (!acc[r.regime]) continue; // defensive: regime is a free-text column, only these two values are ever written
    const key = `${r.symbol}|${r.technique_id}`;
    if (!acc[r.regime][key]) acc[r.regime][key] = { correct: 0, total: 0 };
    acc[r.regime][key].correct += r.correct;
    acc[r.regime][key].total += r.total;
  }
  const out = { trending: {}, choppy: {} };
  for (const regime of ['trending', 'choppy']) {
    for (const [key, v] of Object.entries(acc[regime])) {
      out[regime][key] = { correct: v.correct, accuracy: v.total ? v.correct / v.total : 0.5, total: v.total };
    }
  }
  return out;
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

// { bucket: { correct, total, accuracy } } for bucket 0-9 (decile of the
// composite call's own 0-100 score) — does a score of e.g. 85 (bucket 8)
// actually land correct roughly 80-90% of the time? See evaluateMatured
// for how this gets populated.
export async function loadCalibration(env) {
  const rows = await d1(env, 'SELECT bucket, correct, total FROM score_calibration WHERE total > 0');
  const out = {};
  for (const r of rows) out[r.bucket] = { correct: r.correct, total: r.total, accuracy: r.total ? r.correct / r.total : 0 };
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
  // VOTES_CHUNK, not the shared CHUNK: this insert is now 7 columns
  // (score + regime both added after CHUNK=15 was sized for the original
  // 4-5 column shape). 15 x 7 = 105 would exceed D1's real 100-bound-param
  // cap (confirmed live once already, see CHUNK's own docs above); 14 x 7
  // = 98 stays under it.
  for (const batch of chunk(log.votes, VOTES_CHUNK)) {
    // score is nullable and only ever set on the synthetic 'composite' rows
    // (see rankBoards' push-site, worker.js) — null for every real
    // technique vote. regime is nullable too — null whenever the asset
    // didn't have enough history yet to compute swing structure at cast
    // time (see regimeOf, worker.js).
    const placeholders = batch.map(() => '(?,?,?,?,?,?,?)').join(',');
    const params = batch.flatMap((v) => [runAt, v.asset_class, v.symbol, v.technique_id, v.dir, v.score ?? null, v.regime ?? null]);
    await d1(env, `INSERT OR REPLACE INTO technique_votes (run_at, asset_class, symbol, technique_id, dir, score, regime) VALUES ${placeholders}`, params);
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
    const due = await d1(env, `SELECT run_at, asset_class, symbol, technique_id, dir, score, regime FROM technique_votes WHERE run_at <= ? AND ${col} = 0`, [cutoff]);
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
    // Decile of the composite call's own 0-100 score -> {correct, total} —
    // pooled across both horizons here, same "blend, don't split" choice
    // loadReliability already makes for technique_reliability. Piggybacks
    // on this same due-rows pass (zero extra D1 reads): a composite row's
    // score is already in hand exactly when its correctness is computed.
    const calibDeltas = {};
    const seenMoves = new Set();
    const evaluatedSymbolsByRunAt = {}; // only mark rows we could actually score
    // Phase 5: which technique pairs agreed on direction this (run_at,
    // symbol), grouped here for free off rows already in hand — the actual
    // pairing/tally happens in one pass after this loop, once actualDir is
    // known for every group. 'composite' is excluded (it's the aggregate
    // call, not an individual technique) and only genuinely directional
    // votes count (dir 1/-1) — a neutral flag like earningsrisk's has
    // nothing to "agree" on a direction with.
    const comboGroups = {}; // "run_at|symbol" -> { symbol, actualDir, votes: [{technique_id, dir}] }
    // Phase 6: same due-rows pass, bucketed by the regime frozen on the row
    // at cast time (see the `regime` column/regimeOf, worker.js) — null
    // regime (not enough history to compute structure when the vote was
    // cast, or a row written before this column existed) is simply skipped
    // here, same as it already is everywhere else.
    const regimeDeltas = {}; // "symbol|technique_id|regime" -> { symbol, technique_id, regime, correct, total }
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

      if (r.technique_id === 'composite' && r.score != null) {
        const bucket = scoreBucket(r.score);
        if (!calibDeltas[bucket]) calibDeltas[bucket] = { correct: 0, total: 0 };
        calibDeltas[bucket].total += 1;
        if (r.dir === actualDir) calibDeltas[bucket].correct += 1;
      }

      if (r.regime) {
        const rk = `${r.symbol}|${r.technique_id}|${r.regime}`;
        if (!regimeDeltas[rk]) regimeDeltas[rk] = { symbol: r.symbol, technique_id: r.technique_id, regime: r.regime, correct: 0, total: 0 };
        regimeDeltas[rk].total += 1;
        if (r.dir === actualDir) regimeDeltas[rk].correct += 1;
      }

      if (r.technique_id !== 'composite' && (r.dir === 1 || r.dir === -1)) {
        const gk = `${r.run_at}|${r.symbol}`;
        (comboGroups[gk] ??= { symbol: r.symbol, actualDir, votes: [] }).votes.push({ technique_id: r.technique_id, dir: r.dir });
      }

      const moveKey = `${r.run_at}|${r.symbol}`;
      if (!seenMoves.has(moveKey)) {
        seenMoves.add(moveKey);
        if (!moveDeltas[r.symbol]) moveDeltas[r.symbol] = { n: 0, sumPct: 0, sumPctSq: 0 };
        moveDeltas[r.symbol].n += 1;
        moveDeltas[r.symbol].sumPct += pct;
        moveDeltas[r.symbol].sumPctSq += pct * pct;
      }
    }

    // One pass over each group's votes, pairing techniques that voted the
    // SAME direction (disagreeing pairs aren't a "combo" — there's no
    // shared call to score). O(k^2) in the number of techniques that voted
    // directionally that hour for that symbol (k is typically small — most
    // techniques sit at 0/null most of the time, see evaluateTechniques'
    // own "never fire alone" discipline throughout), not O(k^2) over the
    // full technique roster.
    const comboDeltas = {}; // "symbol|a|b" -> { symbol, a, b, correct, total }
    for (const g of Object.values(comboGroups)) {
      const votes = g.votes;
      for (let i = 0; i < votes.length; i++) {
        for (let j = i + 1; j < votes.length; j++) {
          if (votes[i].dir !== votes[j].dir) continue;
          const [a, b] = [votes[i].technique_id, votes[j].technique_id].sort();
          const ck = `${g.symbol}|${a}|${b}`;
          if (!comboDeltas[ck]) comboDeltas[ck] = { symbol: g.symbol, a, b, correct: 0, total: 0 };
          comboDeltas[ck].total += 1;
          if (votes[i].dir === g.actualDir) comboDeltas[ck].correct += 1;
        }
      }
    }
    for (const d of Object.values(comboDeltas)) {
      await d1(env, `
        INSERT INTO technique_combo_reliability (symbol, technique_a, technique_b, horizon_hours, correct, total, accuracy, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (symbol, technique_a, technique_b, horizon_hours) DO UPDATE SET
          correct = technique_combo_reliability.correct + excluded.correct,
          total = technique_combo_reliability.total + excluded.total,
          accuracy = CAST(technique_combo_reliability.correct + excluded.correct AS REAL) / (technique_combo_reliability.total + excluded.total),
          updated_at = excluded.updated_at
      `, [d.symbol, d.a, d.b, h, d.correct, d.total, d.total ? d.correct / d.total : 0, nowIso]);
    }

    for (const d of Object.values(regimeDeltas)) {
      await d1(env, `
        INSERT INTO technique_regime_reliability (symbol, technique_id, horizon_hours, regime, correct, total, accuracy, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (symbol, technique_id, horizon_hours, regime) DO UPDATE SET
          correct = technique_regime_reliability.correct + excluded.correct,
          total = technique_regime_reliability.total + excluded.total,
          accuracy = CAST(technique_regime_reliability.correct + excluded.correct AS REAL) / (technique_regime_reliability.total + excluded.total),
          updated_at = excluded.updated_at
      `, [d.symbol, d.technique_id, h, d.regime, d.correct, d.total, d.total ? d.correct / d.total : 0, nowIso]);
    }

    for (const [bucket, d] of Object.entries(calibDeltas)) {
      await d1(env, `
        INSERT INTO score_calibration (bucket, correct, total, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (bucket) DO UPDATE SET
          correct = score_calibration.correct + excluded.correct,
          total = score_calibration.total + excluded.total,
          updated_at = excluded.updated_at
      `, [Number(bucket), d.correct, d.total, nowIso]);
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
export async function snapshotAssetScores(env, date, reliability, rangeReliability) {
  const symbols = new Set();
  for (const key of Object.keys(reliability || {})) symbols.add(key.split('|')[0]);
  for (const symbol of Object.keys(rangeReliability || {})) symbols.add(symbol);
  if (!symbols.size) return 0;

  const classRows = await d1(env, 'SELECT DISTINCT symbol, asset_class FROM technique_reliability');
  const classBySymbol = Object.fromEntries(classRows.map((r) => [r.symbol, r.asset_class]));

  const rows = [];
  for (const symbol of symbols) {
    const score = assetPredictionScore(symbol, reliability, rangeReliability);
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

export { MIN_RELIABILITY_SAMPLES };
