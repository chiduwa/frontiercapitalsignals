// D1, notification and payload side of the big-move watch
// (scripts/big-move-watch.py does the modelling):
//
//   series <series.json>     every crypto series, aligned, quarantine applied
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
import { isQuantizedSeries } from './archive.mjs';
import { isNonDirectionalAsset } from '../worker.js';

export const WATCH_VERSION = 'big-move-watch-v1';

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

export async function loadSeries(env) {
  const rows = await readAllDailyBars(env, 'symbol, date, close, high, low, volume, source',
    { symbolWhere: "asset_class = 'crypto'", extraWhere: "asset_class = 'crypto'" });
  const quarantine = await d1(env, "SELECT symbol, date FROM asset_bar_quarantine WHERE asset_class = 'crypto'");
  return buildSeries(rows, quarantine);
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
  const [cmd, a] = process.argv.slice(2);
  const env = { CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
    FCS_D1_DATABASE_ID: process.env.FCS_D1_DATABASE_ID };
  if (cmd === 'series') {
    const series = await loadSeries(env);
    await writeFile(a, JSON.stringify(series));
    console.log(`big-move series: ${Object.keys(series).length} coins`);
  } else if (cmd === 'export') {
    const state = await exportState(env);
    await writeFile(a, JSON.stringify(state));
    console.log(`big-move state: ${state.open.length} open, ${state.scored.length} scored`);
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
