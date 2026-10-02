// D1, notification and payload side of the big-move watch
// (scripts/big-move-watch.py does the modelling):
//
//   series <series.json> [<meta.json>]   every crypto series, aligned, quarantine applied;
//                                        before the archive has the newest close, that
//                                        close is added in memory (the early pass)
//   export <state.json>      open watch rows to score + the scored record
//   import <results.json>    today's watch (insert-only), scores, run, one push
//
// A watch row is written once, before its two days have passed, and scored
// in place later; nothing here can rewrite what was flagged.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { d1, d1Batch, chunk, readAllDailyBars, pageAll } from './d1-client.mjs';
import { sanitizeBars } from './panel-features.mjs';
import { isQuantizedSeries, binanceDailyBars, yahooRecentBars, isYahooCryptoDataTrustworthy } from './archive.mjs';
import { isNonDirectionalAsset } from '../worker.js';

export const WATCH_VERSION = 'big-move-watch-v1';

// The early pass (2026-10-02). The watch ranks at the 00:00 UTC close, but it
// used to wait for Signals Daily to write that close into the archive, and
// GitHub starts Signals Daily 5-7 hours after its 02:37 cron: the digest went
// out at 08:45-09:42 UTC. On the watch's own picks (2024-01..2026-08 hourly
// bars, docs/ROTATION.md section 9), 30% of the +-12% touches it exists to
// catch had already happened 10 hours after the close; a fresh +-12% from the
// alert price still came for 53% of picks alerted at +1h against 44% at +10h.
//
// So the Worker's cron dispatches the watch at 00:20 UTC, and this adds the
// just-closed day to each coin from the supplier its archive already uses,
// in memory only: the archive itself is still written by Signals Daily, and
// nothing here ever reaches asset_daily_bars.
//   * Binance and Yahoo only: their bars are true UTC closes, final at 00:00.
//     CoinGecko's midnight sample is not (archive.mjs), so those coins wait
//     for the archive and are simply not ranked in the early pass.
//   * The fetched bar for the archive's newest day must match the stored close,
//     or the coin is left out: same supplier, same coin, or nothing.
//   * Only when the archive does not yet have the day: once half the true-close
//     coins have it, the archive is current and nothing is added.
//   * A pass that reaches fewer than 80% of the coins it should is refused, and
//     the archive-backed run after Signals Daily issues the watch instead.
// The meta file marks the series provisional, and big-move-watch.py then ranks
// without scoring: earlier rows are still judged only on the archive, exactly
// as before, so the live record's method does not change.
export const EARLY = Object.freeze({
  sources: ['binance', 'yahoo'],
  lookbackDays: 40,             // both fetchers refuse fewer than 30 bars
  agreeTolerance: 0.005,
  archiveCurrentShare: 0.5,
  minCoverage: 0.8,
  concurrency: 6
});

const shiftDay = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

export async function topUpLatestDay(rows, {
  nowMs = Date.now(), fetchBinance = binanceDailyBars, fetchYahoo = yahooRecentBars, concurrency = EARLY.concurrency
} = {}) {
  const target = shiftDay(new Date(nowMs).toISOString().slice(0, 10), -1);   // the UTC day that closed last
  const prev = shiftDay(target, -1);
  const last = new Map();
  for (const r of rows) {
    const l = last.get(r.symbol);
    if (!l || r.date > l.date) last.set(r.symbol, r);
  }
  const live = [...last.values()].filter(r => EARLY.sources.includes(r.source) && r.date >= prev);
  const meta = { target, provisional: false, eligible: 0, toppedUp: 0, skipped: [] };
  if (!live.length || live.filter(r => r.date >= target).length / live.length >= EARLY.archiveCurrentShare) return { rows, meta };
  const eligible = live.filter(r => r.date === prev && Number(r.close) > 0);
  meta.eligible = eligible.length;
  const added = [];
  let next = 0;
  async function lane() {
    while (next < eligible.length) {
      const r = eligible[next++];
      try {
        const bars = r.source === 'binance'
          ? await fetchBinance(r.symbol, Number(r.close), { nowMs, startMs: Date.parse(`${target}T00:00:00Z`) - EARLY.lookbackDays * 86400000 })
          : await fetchYahoo(`${r.symbol}-USD`, EARLY.lookbackDays, { nowMs });
        if (r.source === 'yahoo' && !isYahooCryptoDataTrustworthy(bars, Number(r.close), nowMs)) throw new Error('fails the identity check');
        const byDate = new Map(bars.map(b => [b.date, b]));
        const same = byDate.get(prev), fresh = byDate.get(target);
        if (!same || !(Math.abs(same.close / Number(r.close) - 1) <= EARLY.agreeTolerance)) throw new Error(`does not match the stored ${prev} close`);
        if (!fresh || !(fresh.close > 0)) throw new Error(`no completed ${target} bar yet`);
        added.push({ symbol: r.symbol, date: target, close: fresh.close, high: fresh.high ?? null, low: fresh.low ?? null,
          volume: fresh.volume ?? null, source: r.source });
      } catch (e) {
        meta.skipped.push(`${r.symbol} (${r.source}: ${e.message || e})`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, eligible.length) }, lane));
  meta.toppedUp = added.length;
  meta.provisional = added.length > 0;
  if (added.length < EARLY.minCoverage * meta.eligible) {
    throw new Error(`early pass refused: ${added.length} of ${meta.eligible} coins have a completed ${target} close `
      + `(first misses: ${meta.skipped.slice(0, 5).join('; ')}); the run after Signals Daily will issue the watch`);
  }
  return { rows: rows.concat(added), meta };
}

export function buildSeries(rows, quarantine = []) {
  const bad = new Set(quarantine.map(q => `${q.symbol}|${q.date}`));
  const bySymbol = new Map();
  for (const r of rows) {
    if (bad.has(`${r.symbol}|${r.date}`)) continue;
    if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, []);
    bySymbol.get(r.symbol).push(r);
  }
  const out = {};
  for (const [symbol, raw] of bySymbol) {
    const bars = sanitizeBars(raw);
    if (!bars || bars.length < 120) continue;
    // A peg never makes a move worth watching, and a series stored at too few
    // decimals (or frozen) only "moves" when its rounding flips.
    if (isNonDirectionalAsset({ symbol }, bars.map(b => b.close)) || isQuantizedSeries(bars.map(b => b.close))) continue;
    out[symbol] = bars.map(b => [b.date, b.close, b.high ?? null, b.low ?? null, b.volume ?? null]);
  }
  return out;
}

export async function loadSeries(env, { topUp = true, nowMs = Date.now(), fetchers = {} } = {}) {
  let rows = await readAllDailyBars(env, 'symbol, date, close, high, low, volume, source',
    { symbolWhere: "asset_class = 'crypto'", extraWhere: "asset_class = 'crypto'" });
  let meta = { provisional: false };
  if (topUp) ({ rows, meta } = await topUpLatestDay(rows, { nowMs, ...fetchers }));
  const quarantine = await d1(env, "SELECT symbol, date FROM asset_bar_quarantine WHERE asset_class = 'crypto'");
  return { series: buildSeries(rows, quarantine), meta };
}

export async function exportState(env, { query = d1 } = {}) {
  const rows = await pageAll((limit, offset) => query(env, `SELECT as_of, symbol, big, day_base_rate FROM big_move_watch
    WHERE model_version = ? ORDER BY as_of, symbol LIMIT ${limit} OFFSET ${offset}`, [WATCH_VERSION]));
  return {
    open: rows.filter(r => r.big === null || r.big === undefined).map(r => ({ as_of: r.as_of, symbol: r.symbol })),
    scored: rows.filter(r => r.big !== null && r.big !== undefined)
      .map(r => ({ as_of: r.as_of, symbol: r.symbol, big: Number(r.big), day_base_rate: Number(r.day_base_rate) }))
  };
}

// The archive writes only the coins in that day's universe, so a pick whose
// coin drops out right after it was flagged never gets the close two days on,
// and its row stayed open for good: 6 of the first ~75 matured rows (NEET,
// NIL, RHEA, NOCK, 2026-09-24..28). A coin usually leaves the universe after a
// fall, so the record was quietly losing likely hits. Such a row is scored
// from the supplier the archive used for that coin, on the same terms as the
// early pass: the flagged day's close must match the stored one, the outcome
// day must be complete. CoinGecko-sourced coins stay open (no true close).
// Only rows the archive itself cannot score are touched, and the day's base
// rate still comes from the archive alone (big-move-watch.py).
export async function recoverOutcomes(env, open, {
  nowMs = Date.now(), query = d1, fetchBinance = binanceDailyBars, fetchYahoo = yahooRecentBars, horizonDays = 2
} = {}) {
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const due = (open || []).filter(r => shiftDay(r.as_of, horizonDays) < shiftDay(today, -1));
  if (!due.length) return [];
  const symbols = [...new Set(due.map(r => r.symbol))];
  const from = due.map(r => r.as_of).sort()[0];
  const stored = [];
  for (const g of chunk(symbols, 50)) {
    stored.push(...await query(env, `SELECT symbol, date, close, source FROM asset_daily_bars WHERE asset_class = 'crypto'
      AND date >= ? AND symbol IN (${g.map(() => '?').join(',')})`, [from, ...g]));
  }
  const at = new Map(stored.map(r => [`${r.symbol}|${r.date}`, r]));
  const out = [];
  for (const r of due) {
    const end = shiftDay(r.as_of, horizonDays), flagged = at.get(`${r.symbol}|${r.as_of}`);
    if (at.has(`${r.symbol}|${end}`) || !flagged || !EARLY.sources.includes(flagged.source) || !(Number(flagged.close) > 0)) continue;
    try {
      const days = Math.ceil((nowMs - Date.parse(`${r.as_of}T00:00:00Z`)) / 86400000) + EARLY.lookbackDays;
      const bars = flagged.source === 'binance'
        ? await fetchBinance(r.symbol, Number(flagged.close), { nowMs, startMs: Date.parse(`${r.as_of}T00:00:00Z`) - EARLY.lookbackDays * 86400000 })
        : await fetchYahoo(`${r.symbol}-USD`, days, { nowMs });
      if (isQuantizedSeries(bars.map(b => b.close))) continue;          // a rounding flip is not a move
      const byDate = new Map(bars.map(b => [b.date, b]));
      const same = byDate.get(r.as_of), last = byDate.get(end);
      if (!same || !(Math.abs(same.close / Number(flagged.close) - 1) <= EARLY.agreeTolerance) || !(last?.close > 0)) continue;
      out.push({ as_of: r.as_of, symbol: r.symbol, fwd2: last.close / Number(flagged.close) - 1, source: flagged.source });
    } catch (e) {
      console.warn(`big-move outcome for ${r.symbol} ${r.as_of} not recovered (${flagged.source}: ${e.message || e})`);
    }
  }
  return out;
}

export function digest(summary) {
  const w = summary.watch || [];
  if (!w.length) return null;
  const pct = (x, signed) => Number.isFinite(x) ? `${signed && x >= 0 ? '+' : ''}${x.toFixed(1)}%` : 'n/a';
  const lines = w.map(r => `${r.rank}. ${r.symbol}  ${(r.p * 100).toFixed(0)}%  (vol ${pct(r.vol20_pct)}/day, today ${pct(r.move_today_pct, true)})`);
  return {
    title: `Big-move watch: ${w.slice(0, 3).map(r => r.symbol).join(', ')}${w.length > 3 ? ` +${w.length - 3}` : ''}`,
    message: `Most likely to move 12%+ either way over the next 2 days (from the ${summary.asOf} close). `
      + `Direction unknown.\n\n${lines.join('\n')}\n\nBasis: ${summary.statusNote}. Not financial advice.`
  };
}

async function push(topic, { title, message }) {
  if (!topic) return false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', Title: title, Tags: 'eyes',
        Click: 'https://frontiercapitalsignals.com/signals/' },
      body: message
    });
    return res.ok;
  } catch (e) {
    console.error('ntfy failed (non-fatal):', e.message || e);
    return false;
  } finally { clearTimeout(timer); }
}

export async function importResults(env, results, { batch = d1Batch, query = d1, notify = push, topic = process.env.NTFY_TOPIC } = {}) {
  // The first ranking of a close is its record. A later run for the same close
  // (the early pass, then the run after Signals Daily, then the evening
  // fallback) still scores and refreshes the summary, but adds no coins: a
  // rerun once left 11 rows under 2026-09-23. Its summary shows what was
  // recorded and pushed, so the page, the push and the ledger agree.
  const recorded = await query(env, `SELECT symbol, rank, p, close, detail_json, issued_at FROM big_move_watch
    WHERE model_version = ? AND as_of = ? ORDER BY rank`, [results.version, results.asOf]);
  if (recorded.length) {
    const watch = recorded.map(r => ({ as_of: results.asOf, symbol: r.symbol, rank: Number(r.rank), p: Number(r.p),
      close: r.close == null ? null : Number(r.close), ...JSON.parse(r.detail_json || '{}') }));
    results = { ...results, watch: [], summary: { ...results.summary, watch, recordedAt: recorded[0].issued_at } };
  }
  const statements = [];
  for (const g of chunk(results.watch || [], 10)) statements.push({
    sql: `INSERT OR IGNORE INTO big_move_watch (model_version, as_of, symbol, rank, p, close, detail_json, issued_at)
      VALUES ${g.map(() => '(?,?,?,?,?,?,?,?)').join(',')}`,
    params: g.flatMap(w => [results.version, w.as_of, w.symbol, w.rank, w.p, w.close,
      JSON.stringify({ vol20_pct: w.vol20_pct, move_today_pct: w.move_today_pct, r5_pct: w.r5_pct, volume_ratio: w.volume_ratio }),
      results.runAt])
  });
  for (const s of results.scores || []) statements.push({
    sql: `UPDATE big_move_watch SET move_pct = ?, big = ?, day_base_rate = ?, scored_at = ?
      WHERE model_version = ? AND as_of = ? AND symbol = ? AND big IS NULL`,
    params: [s.move_pct, s.big, s.day_base_rate, results.runAt, results.version, s.as_of, s.symbol]
  });
  for (const group of chunk(statements, 25)) await batch(env, group);
  const runId = `${results.version}:${results.runAt}`;
  await query(env, `INSERT OR IGNORE INTO big_move_watch_runs (run_id, model_version, created_at, as_of, input_hash, summary_json)
    VALUES (?,?,?,?,?,?)`, [runId, results.version, results.runAt, results.asOf, results.inputHash || '', JSON.stringify(results.summary)]);
  // One push per as-of close, however often the job reruns.
  const sent = await query(env, 'SELECT 1 FROM big_move_watch_runs WHERE model_version = ? AND as_of = ? AND notified_at IS NOT NULL LIMIT 1',
    [results.version, results.asOf]);
  const msg = digest(results.summary);
  if (results.summary.notifying && msg && !sent.length && await notify(topic, msg)) {
    await query(env, 'UPDATE big_move_watch_runs SET notified_at = ? WHERE run_id = ?', [new Date().toISOString(), runId]);
    return { statements: statements.length, notified: true };
  }
  return { statements: statements.length, notified: false };
}

export async function loadBigMoveWatch(env, nowMs = Date.now(), query = d1) {
  const rows = await query(env, `SELECT created_at, summary_json FROM big_move_watch_runs
    WHERE model_version = ? ORDER BY created_at DESC LIMIT 1`, [WATCH_VERSION]);
  if (!rows.length) return { status: 'awaiting-first-run' };
  const summary = JSON.parse(rows[0].summary_json);
  const ageHours = (nowMs - Date.parse(rows[0].created_at)) / 3600000;
  return { ...summary, ageHours, status: Number.isFinite(ageHours) && ageHours >= 0 && ageHours <= 36 ? 'live' : 'stale' };
}

async function main() {
  const [cmd, a, b] = process.argv.slice(2);
  const env = { CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
    FCS_D1_DATABASE_ID: process.env.FCS_D1_DATABASE_ID };
  if (cmd === 'series') {
    const { series, meta } = await loadSeries(env);
    await writeFile(a, JSON.stringify(series));
    if (b) await writeFile(b, JSON.stringify(meta));
    console.log(`big-move series: ${Object.keys(series).length} coins`
      + (meta.provisional ? `; early pass: ${meta.target} close added in memory for ${meta.toppedUp} of ${meta.eligible} coins` : ''));
    if (meta.skipped?.length) console.log(`early pass left out ${meta.skipped.length}: ${meta.skipped.join('; ')}`);
  } else if (cmd === 'export') {
    const state = await exportState(env);
    state.recovered = await recoverOutcomes(env, state.open);
    await writeFile(a, JSON.stringify(state));
    console.log(`big-move state: ${state.open.length} open, ${state.scored.length} scored`
      + (state.recovered.length ? `, ${state.recovered.length} outcomes recovered for coins the archive dropped: ${state.recovered.map(r => `${r.symbol} ${r.as_of}`).join(', ')}` : ''));
  } else if (cmd === 'import') {
    const r = await importResults(env, JSON.parse(await readFile(a, 'utf8')));
    console.log(`big-move import: ${r.statements} statements, notified=${r.notified}`);
  } else {
    throw new Error('usage: big-move-watch-io.mjs series|export|import <file>');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e); process.exit(1); });
}
