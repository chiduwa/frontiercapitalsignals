// The coin rotation's I/O (the logic is coin-rotation.mjs). Runs inside the
// hourly live scan, on the hourly bars it already fetched: 1,000 hours per
// coin is 41 days, just enough for the 40-day look back. Each run forms the
// latest complete UTC day's cohorts if they are not logged yet (so a missed
// run is caught up by the next), scores every cohort whose days have passed,
// and keeps each horizon's live record. It pushes once when a horizon starts
// clearing its costs on its live record, and again only after it has fallen
// back and recovered. Nothing is traded.
import { d1 } from './d1-client.mjs';
import {
  ROTATION_VERSION, ROT, addDays, dailyFromHourly, rotationUniverse, formCohort, scoreCohort, breakInWindow,
  rotationRecord, rotationAlertState, rotationAlert
} from './coin-rotation.mjs';

// The same rotation replayed on 2021-01 to 2026-09 (docs/CADENCE.md, section
// 7; research-2026-09-28-cadence/scripts/rotation_replay.mjs), net of the
// same costs: what the live record is to be read against.
export const ROT_EVIDENCE = Object.freeze({
  universe: 'the 100 most-traded Binance coins each day, 2021-02 to 2026-09 (coins still listed today: survivors)',
  2: { '2021-23': { netPerCohort: -0.00078, netPerYear: -0.1429, t: -1.01, laggardsPerCohort: -0.00139, laggardsPerYear: -0.254, laggardsT: -4.14, rounds: 1054 },
       '2024-26': { netPerCohort: -0.00165, netPerYear: -0.3011, t: -2.47, laggardsPerCohort: -0.00182, laggardsPerYear: -0.3319, laggardsT: -5.79, rounds: 999 } },
  40: { '2021-23': { netPerCohort: 0.03732, netPerYear: 0.3405, t: 2.94, laggardsPerCohort: 0.01424, laggardsPerYear: 0.1299, laggardsT: 2.65, rounds: 1054 },
        '2024-26': { netPerCohort: 0.03473, netPerYear: 0.3169, t: 1.96, laggardsPerCohort: 0.01313, laggardsPerYear: 0.1198, laggardsT: 1.73, rounds: 961 } }
});

const HOUR = 3600000, DAY = 86400000;
// The latest UTC day whose last hour has closed.
export const latestCompleteDay = (nowMs) => new Date(Math.floor(nowMs / DAY) * DAY - DAY).toISOString().slice(0, 10);

export async function runCoinRotation({ env, nowMs = Date.now(), barsBySymbol, dryRun = false, query = d1,
  notify = async () => false, log = console.log } = {}) {
  const daily = {};
  for (const [s, bars] of Object.entries(barsBySymbol || {})) daily[s] = dailyFromHourly(bars);
  const formedOn = latestCompleteDay(nowMs);
  const nowIso = new Date(nowMs).toISOString();
  const universe = rotationUniverse(daily, formedOn);
  let formed = 0, scored = 0, pushed = 0;

  // 1. today's cohorts, once
  for (const k of ROT.horizons) {
    const exists = dryRun ? [] : await query(env, `SELECT 1 FROM coin_rotation_cohorts WHERE model_version = ? AND horizon_days = ? AND formed_on = ?`,
      [ROTATION_VERSION, k, formedOn]);
    if (exists && exists.length) continue;
    const c = universe.length >= ROT.minScored ? formCohort(daily, universe, formedOn, k) : null;
    if (!c) { log(`coin rotation: no ${k}-day cohort for ${formedOn} (universe ${universe.length})`); continue; }
    if (!dryRun) {
      await query(env, `INSERT INTO coin_rotation_cohorts (model_version, horizon_days, formed_on, matures_on, universe_n, longs_json, shorts_json, created_at)
        VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(model_version, horizon_days, formed_on) DO NOTHING`,
        [ROTATION_VERSION, k, formedOn, c.maturesOn, c.universeN, JSON.stringify(c.longs), JSON.stringify(c.shorts), nowIso]);
    }
    formed++;
  }

  // 2. score what has matured
  const due = dryRun ? [] : await query(env, `SELECT horizon_days, formed_on, matures_on, longs_json, shorts_json FROM coin_rotation_cohorts
    WHERE model_version = ? AND scored_at IS NULL AND matures_on <= ?`, [ROTATION_VERSION, formedOn]);
  for (const row of due || []) {
    const cohort = { longs: JSON.parse(row.longs_json), shorts: JSON.parse(row.shorts_json) };
    const s = scoreCohort(cohort, (sym) => daily[sym]?.close.get(row.matures_on) ?? null,
      { broken: (sym) => Boolean(daily[sym]) && breakInWindow(daily[sym].close, row.formed_on, row.matures_on) });
    if (!s) continue;                                    // its exit day is not in the bars: the next run tries again
    await query(env, `UPDATE coin_rotation_cohorts SET long_ret = ?, short_ret = ?, spread = ?, net_spread = ?, universe_ret = ?,
        laggards_excess = ?, n_scored = ?, scored_at = ? WHERE model_version = ? AND horizon_days = ? AND formed_on = ?`,
      [s.longRet, s.shortRet, s.spread, s.netSpread, s.universeRet, s.laggardsExcess, s.nScored, nowIso,
       ROTATION_VERSION, Number(row.horizon_days), row.formed_on]);
    scored++;
  }

  // 3. each horizon's live record, and a push when one starts clearing its costs
  if (!dryRun) {
    for (const k of ROT.horizons) {
      const rows = await query(env, `SELECT formed_on, net_spread, laggards_excess FROM coin_rotation_cohorts
        WHERE model_version = ? AND horizon_days = ? AND scored_at IS NOT NULL ORDER BY formed_on`, [ROTATION_VERSION, k]);
      const rec = rotationRecord(rows || [], k);
      const prevRows = await query(env, 'SELECT state FROM coin_rotation_alerts WHERE model_version = ? AND horizon_days = ?', [ROTATION_VERSION, k]);
      const prev = prevRows?.[0]?.state || 'not';
      const next = rotationAlertState(rec, prev);
      if (next === prev) continue;
      await query(env, `INSERT INTO coin_rotation_alerts (model_version, horizon_days, state, changed_at, detail) VALUES (?,?,?,?,?)
        ON CONFLICT(model_version, horizon_days) DO UPDATE SET state = excluded.state, changed_at = excluded.changed_at, detail = excluded.detail`,
        [ROTATION_VERSION, k, next, nowIso, `t=${rec.t?.toFixed(2)} over ${rec.cohorts} rounds, net ${rec.netPerCohort} a round`]);
      if (next === 'paying') {
        const a = rotationAlert(rec);
        if (await notify({ title: a.title, message: a.message, priority: 'default', tags: ['arrows_counterclockwise'] })) pushed++;
      }
    }
    await query(env, `INSERT INTO coin_rotation_runs (run_at, model_version, formed, scored) VALUES (?,?,?,?)
      ON CONFLICT(run_at) DO UPDATE SET formed = excluded.formed, scored = excluded.scored`, [nowIso, ROTATION_VERSION, formed, scored]);
  }
  log(`coin rotation: ${formedOn}, universe ${universe.length}, ${formed} cohort(s) formed, ${scored} scored` + (pushed ? `, ${pushed} pushed` : ''));
  return { formedOn, universe: universe.length, formed, scored, pushed };
}

// The dashboard's view: each horizon's live record, the latest cohort's biggest
// laggards and leaders, and the historical reference.
export async function loadCoinRotation(env, nowMs = Date.now(), query = d1) {
  const runs = await query(env, 'SELECT run_at FROM coin_rotation_runs WHERE model_version = ? ORDER BY run_at DESC LIMIT 1', [ROTATION_VERSION]);
  if (!runs || !runs.length) return { status: 'awaiting-first-run' };
  const horizons = {};
  for (const k of ROT.horizons) {
    const scored = await query(env, `SELECT formed_on, net_spread, laggards_excess FROM coin_rotation_cohorts
      WHERE model_version = ? AND horizon_days = ? AND scored_at IS NOT NULL ORDER BY formed_on`, [ROTATION_VERSION, k]) || [];
    const latest = (await query(env, `SELECT formed_on, matures_on, universe_n, longs_json, shorts_json FROM coin_rotation_cohorts
      WHERE model_version = ? AND horizon_days = ? ORDER BY formed_on DESC LIMIT 1`, [ROTATION_VERSION, k]) || [])[0];
    const open = (await query(env, `SELECT COUNT(*) AS n FROM coin_rotation_cohorts WHERE model_version = ? AND horizon_days = ? AND scored_at IS NULL`,
      [ROTATION_VERSION, k]) || [])[0];
    const alert = (await query(env, 'SELECT state, changed_at FROM coin_rotation_alerts WHERE model_version = ? AND horizon_days = ?', [ROTATION_VERSION, k]) || [])[0];
    let current = null;
    if (latest) {
      const L = JSON.parse(latest.longs_json), S = JSON.parse(latest.shorts_json);
      current = { formedOn: latest.formed_on, maturesOn: latest.matures_on, universeN: latest.universe_n, nLaggards: L.length, nLeaders: S.length,
        laggards: L.slice(0, 5).map(([s, , r]) => [s, r]), leaders: S.slice(0, 5).map(([s, , r]) => [s, r]) };
    }
    horizons[k] = { record: rotationRecord(scored, k), open: Number(open?.n || 0), current, state: alert?.state || 'not', stateSince: alert?.changed_at || null };
  }
  const ageHours = (nowMs - Date.parse(runs[0].run_at)) / HOUR;
  return { status: Number.isFinite(ageHours) && ageHours >= 0 && ageHours <= 3 ? 'live' : 'stale', lastRunAt: runs[0].run_at, horizons, evidence: ROT_EVIDENCE };
}
