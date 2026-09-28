// The decoupling watch's I/O: history, D1 and pushes. The rule itself is pure
// and lives in decoupling-watch.mjs; this file only feeds it and records what
// it said, BEFORE the 24 hours it is judged on, then scores it afterwards.
//
// Runs inside the hourly live scan (scripts/live-scan.mjs). Every D1 call and
// fetch goes through the `query`, `fetchJson` and `notify` it is handed, so the
// test suite can drive it end to end without a network.
import { d1 } from './d1-client.mjs';
import { BINANCE_GLOBAL_BASE } from '../worker.js';
import {
  DECOUPLING_VERSION, DECOUPLING_UNIVERSE, DW, DW_EVIDENCE, hourStart,
  decouplingChain, scoreDecoupling, decouplingNotifyGate, decouplingAlert
} from './decoupling-watch.mjs';

const HOUR = 3600000;
// Beta for any hour needs the 30 days before its UTC midnight, and the coin's
// excess sd needs 30 days of those: about 61 days behind the hour judged, plus
// the 25 hours a setup waits to be scored. Two pages of 1000 bars cover it.
export const DW_HISTORY_HOURS = 2000;
export const DW_MAX_PUSHES = 4;
// Only a side whose evidence held in BOTH study years may reach a phone
// (DW_EVIDENCE[side].push); the other is logged, scored and shown.
const pushes = (side) => (side > 0 ? DW_EVIDENCE.ahead : DW_EVIDENCE.behind).push;
const PUSHED_SIDES = [1, -1].filter(pushes);

async function defaultFetchJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'fcs-live-scan' } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; } finally { clearTimeout(t); }
}

// Up to `hours` closed-or-open hourly bars, newest last, paging back with endTime.
export async function fetchDeepBars(symbol, { hours = DW_HISTORY_HOURS, fetchJson = defaultFetchJson } = {}) {
  const pair = `${symbol}USDT`;
  const rows = [];
  let endTime = null;
  while (rows.length < hours) {
    const url = `${BINANCE_GLOBAL_BASE}/klines?symbol=${encodeURIComponent(pair)}&interval=1h&limit=1000${endTime != null ? `&endTime=${endTime}` : ''}`;
    const page = await fetchJson(url);
    if (!Array.isArray(page) || !page.length) break;
    rows.unshift(...page);
    if (page.length < 1000) break;
    endTime = Number(page[0][0]) - 1;
  }
  const seen = new Map();
  for (const r of rows) seen.set(Number(r[0]), r);
  return [...seen.values()].sort((a, b) => Number(a[0]) - Number(b[0])).map((r) => ({
    openTime: new Date(Number(r[0])).toISOString(), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]),
    close: Number(r[4]), volume: Number(r[5]), quoteVolume: Number(r[7]), trades: Number(r[8])
  })).filter((b) => Number.isFinite(b.close) && b.close > 0);
}

// Open-interest change in CONTRACTS over the setup's 8 hours, from the
// sampler's own ticks (oi_tick), when it watches the coin. Context only: the
// rule does not need it (docs/DECOUPLING.md: it held as well without).
export async function oiChangePct(env, symbol, closeMs, { query = d1 } = {}) {
  const win = DW.setupHours * HOUR;
  const rows = await query(env, `SELECT ts, oi_contracts FROM oi_tick
    WHERE symbol = ? AND ts BETWEEN ? AND ? AND oi_contracts > 0 ORDER BY ts`,
    [symbol, closeMs - win - 15 * 60000, closeMs]);
  if (!rows || rows.length < 2) return null;
  const startRow = rows.find((r) => Number(r.ts) >= closeMs - win - 15 * 60000 && Number(r.ts) <= closeMs - win + 15 * 60000);
  const endRow = rows[rows.length - 1];
  if (!startRow || Number(endRow.ts) < closeMs - 15 * 60000) return null;
  return (Number(endRow.oi_contracts) / Number(startRow.oi_contracts) - 1) * 100;
}

export async function runDecouplingWatch({ env, nowMs = Date.now(), tradable = null, dryRun = false,
  query = d1, fetchJson = defaultFetchJson, notify = async () => false, log = console.log } = {}) {
  const universe = DECOUPLING_UNIVERSE.filter((s) => !tradable || tradable.has(s));
  const bars = {};
  for (const s of universe) {
    try { bars[s] = await fetchDeepBars(s, { fetchJson }); } catch { /* sits this run out */ }
  }
  const nowIso = new Date(nowMs).toISOString();

  // 1. score every setup whose 24 hours have closed
  let scored = 0;
  const due = dryRun ? [] : await query(env, `SELECT symbol, cast_at FROM decoupling_watch
    WHERE model_version = ? AND scored_at IS NULL AND cast_at <= ?`,
    [DECOUPLING_VERSION, new Date(hourStart(nowMs) - (DW.horizonHours + 1) * HOUR).toISOString()]);
  for (const row of due || []) {
    const r = scoreDecoupling(bars, row.symbol, row.cast_at, { nowMs });
    if (!r) continue;
    await query(env, `UPDATE decoupling_watch SET outcome_excess_pct = ?, big = ?, base_rate = ?, market_n = ?, scored_at = ?
      WHERE model_version = ? AND symbol = ? AND cast_at = ?`,
      [r.excessPct, r.big, r.baseRate, r.marketN, nowIso, DECOUPLING_VERSION, row.symbol, row.cast_at]);
    scored++;
  }

  // 2. new setups: the rule replayed with the study's cooldown, seeded with
  // what is already logged. Taken in the last few hours = new (a skipped run
  // is caught up); anything older was either logged then or is mid-move now.
  const lastRows = dryRun ? [] : await query(env, `SELECT symbol, MAX(cast_at) AS last_cast FROM decoupling_watch
    WHERE model_version = ? AND cast_at > ? GROUP BY symbol`,
    [DECOUPLING_VERSION, new Date(hourStart(nowMs) - (DW.chainHours + DW.cooldownHours) * HOUR).toISOString()]);
  const lastCastMs = Object.fromEntries((lastRows || []).map((r) => [r.symbol, Date.parse(r.last_cast)]));
  const { taken, evaluated, end } = decouplingChain(bars, { nowMs, lastCastMs });
  const setups = taken.filter((s) => s.index === end);
  const fresh = taken.filter((s) => s.index > end - DW.catchUpHours);
  for (const s of fresh) {
    const closeMs = Date.parse(s.at) + HOUR;
    try { s.oiChangePct = await oiChangePct(env, s.symbol, closeMs, { query }); } catch { s.oiChangePct = null; }
  }

  // 3. log before the outcome exists, then push, gated on the pushed side's live record
  const history = dryRun ? [] : await query(env, `SELECT cast_at, big, base_rate FROM decoupling_watch
    WHERE model_version = ? AND scored_at IS NOT NULL AND side IN (${PUSHED_SIDES.join(', ')})`, [DECOUPLING_VERSION]);
  const gate = decouplingNotifyGate(history || []);
  let pushed = 0;
  for (const s of fresh.sort((a, b) => Math.abs(b.excessZ) - Math.abs(a.excessZ))) {
    if (!dryRun) {
      await query(env, `INSERT INTO decoupling_watch (model_version, symbol, cast_at, side, close, volume_ratio, rel_volume, excess_z, excess_pct,
          market_pct, beta, threshold, oi_change_pct, notified, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?) ON CONFLICT(model_version, symbol, cast_at) DO NOTHING`,
        [DECOUPLING_VERSION, s.symbol, s.at, s.side, s.close, s.volumeRatio, s.relVolume, s.excessZ, s.excessPct, s.marketPct,
         Number.isFinite(s.beta) ? s.beta : null, s.threshold, Number.isFinite(s.oiChangePct) ? s.oiChangePct : null, nowIso]);
    }
    if (!pushes(s.side) || !gate.allowed || pushed >= DW_MAX_PUSHES) continue;
    const { title, message } = decouplingAlert(s, { oiChangePct: s.oiChangePct });
    const ok = await notify({ title, message: `${message}\n\nBasis: ${gate.why}.`, priority: 'default', tags: [s.side > 0 ? 'rocket' : 'small_red_triangle_down'] });
    if (ok) {
      pushed++;
      if (!dryRun) await query(env, `UPDATE decoupling_watch SET notified = 1 WHERE model_version = ? AND symbol = ? AND cast_at = ?`,
        [DECOUPLING_VERSION, s.symbol, s.at]);
    }
  }
  if (!dryRun) {
    await query(env, `INSERT INTO decoupling_watch_runs (run_at, model_version, evaluated, setups, notified) VALUES (?,?,?,?,?)
      ON CONFLICT(run_at) DO UPDATE SET evaluated = excluded.evaluated, setups = excluded.setups, notified = excluded.notified`,
      [nowIso, DECOUPLING_VERSION, evaluated, fresh.length, pushed]);
  }
  log(`decoupling watch: ${evaluated}/${universe.length} coins evaluated, ${setups.length} taken this hour, ${fresh.length} new `
    + `(${fresh.filter((s) => pushes(s.side)).length} on a pushed side), `
    + `${pushed} pushed (${gate.allowed ? 'notifying' : 'silent'}: ${gate.why}); ${scored} scored`);
  return { evaluated, setups: fresh, scored, pushed, gate };
}

// The dashboard's view: the last 72 hours of setups, each with what has
// happened since, and each side's live record against the same-window base rate.
export async function loadDecouplingWatch(env, nowMs = Date.now(), query = d1) {
  const runs = await query(env, `SELECT run_at, evaluated FROM decoupling_watch_runs WHERE model_version = ?
    ORDER BY run_at DESC LIMIT 1`, [DECOUPLING_VERSION]);
  if (!runs || !runs.length) return { status: 'awaiting-first-run' };
  const since = new Date(nowMs - 72 * HOUR).toISOString();
  const recent = await query(env, `SELECT symbol, cast_at, side, close, volume_ratio, rel_volume, excess_z, excess_pct, market_pct,
      oi_change_pct, notified, outcome_excess_pct, big, base_rate FROM decoupling_watch
    WHERE model_version = ? AND cast_at >= ? ORDER BY cast_at DESC LIMIT 40`, [DECOUPLING_VERSION, since]);
  const history = await query(env, `SELECT cast_at, side, big, base_rate FROM decoupling_watch
    WHERE model_version = ? AND scored_at IS NOT NULL`, [DECOUPLING_VERSION]) || [];
  const ahead = decouplingNotifyGate(history.filter((r) => Number(r.side) > 0));
  const behind = decouplingNotifyGate(history.filter((r) => Number(r.side) < 0));
  const gate = decouplingNotifyGate(history.filter((r) => PUSHED_SIDES.includes(Number(r.side))));
  const ageHours = (nowMs - Date.parse(runs[0].run_at)) / HOUR;
  return {
    status: Number.isFinite(ageHours) && ageHours >= 0 && ageHours <= 3 ? 'live' : 'stale',
    lastRunAt: runs[0].run_at, evaluated: runs[0].evaluated, universe: DECOUPLING_UNIVERSE.length,
    recent: recent || [], live: { ahead: ahead.record, behind: behind.record },
    evidence: DW_EVIDENCE, notifying: gate.allowed, statusNote: gate.why
  };
}
