// D1 and market-data side of the per-asset model tournament. The modelling
// lives in model-tournament.py; this file only moves data, so the forward
// ledger's rules are enforced where they are written:
//
//   data   <panel.json> <input.json>    tournament rows + 4-hour Binance opens
//   export <state.json>                 registry + the ledger the lifecycle needs
//   import <results.json>               forecasts, scores, registry, history, run
//
// A forecast is INSERT OR IGNORE: the first one issued for a model/asset/date
// stands, whatever runs after it. A score fills a row only while its loss is
// still NULL. Nothing here can rewrite what a model said before its outcome.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { d1, d1Batch, chunk, pageAll } from './d1-client.mjs';
import { researchRows } from './tracked-research-data.mjs';
import { BINANCE_KLINES_URL } from './archive.mjs';

export const TOURNAMENT_VERSION = 'model-tournament-v1';
const FOUR_HOURS = 4 * 3600000;
const DAY = 86400000;

async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(timer); }
}

/**
 * [openTimeMs, open] for every 4-hour Binance candle since `days` ago: the
 * price the spot bot would pay at each of its six daily firings. A candle's
 * open is known the moment it starts, so an in-progress candle counts.
 */
export async function binanceFourHourOpens(symbol, { days = 800, nowMs = Date.now(), fetcher = fetchJson } = {}) {
  const pair = `${String(symbol).toUpperCase()}USDT`;
  const out = [];
  let from = nowMs - days * DAY;
  for (let page = 0; page < 8; page++) {
    const j = await fetcher(`${BINANCE_KLINES_URL}?symbol=${encodeURIComponent(pair)}&interval=4h&startTime=${from}&limit=1000`);
    if (!Array.isArray(j) || !j.length) break;
    for (const k of j) {
      const t = Number(k[0]), open = Number(k[1]);
      if (Number.isFinite(t) && t <= nowMs && open > 0) out.push([t, open]);
    }
    if (j.length < 1000) break;
    from = Number(j[j.length - 1][0]) + FOUR_HOURS;
  }
  return out;
}

// A shared ticker is not a shared asset: the last open must sit within 3x of
// the archive's last close, or the series is not this coin's.
export function sameAsset(opens, lastClose) {
  if (!opens.length || !(lastClose > 0)) return false;
  const ratio = opens[opens.length - 1][1] / lastClose;
  return ratio > 1 / 3 && ratio < 3;
}

export async function buildTournamentInput(panel, { fetcher = fetchJson, nowMs = Date.now(), log = console.log } = {}) {
  const built = researchRows(panel, { tournament: true });
  const klines = {};
  for (const symbol of built.symbols) {
    const bars = panel.assets.find(a => a.symbol === symbol)?.bars || [];
    try {
      const opens = await binanceFourHourOpens(symbol, { fetcher, nowMs });
      if (sameAsset(opens, bars[bars.length - 1]?.close)) klines[symbol] = opens;
      else log(`timing: ${symbol} has no same-asset Binance 4h series; no timing slot`);
    } catch (e) {
      log(`timing: ${symbol} 4h candles unavailable (${e.message}); no timing slot this run`);
    }
  }
  return { asOf: built.asOf, symbols: built.symbols, rows: built.rows, klines };
}

const pagedQuery = (query, env, sql, params, pageSize = 5000) =>
  pageAll((limit, offset) => query(env, `${sql} LIMIT ${limit} OFFSET ${offset}`, params), pageSize);

/** Registry (every row, retired included: it records what was tried) and
 *  the ledger of every model still in play, back `sinceDays`. */
export async function exportState(env, { query = d1, sinceDays = 900, nowMs = Date.now() } = {}) {
  const registry = await pagedQuery(query, env,
    'SELECT * FROM model_registry ORDER BY model_id, symbol, horizon', []);
  const active = [...new Set(registry.filter(r => r.status !== 'retired').map(r => r.model_id))].sort();
  const since = new Date(nowMs - sinceDays * DAY).toISOString().slice(0, 10);
  const ledger = [];
  for (const ids of chunk(active, 50)) {
    ledger.push(...await pagedQuery(query, env,
      `SELECT model_id, symbol, target, horizon, as_of, target_date, forecast_json, loss FROM model_forecasts
       WHERE as_of >= ? AND model_id IN (${ids.map(() => '?').join(',')})
       ORDER BY model_id, symbol, horizon, as_of`, [since, ...ids]));
  }
  return { registry, ledger };
}

const REGISTRY_COLUMNS = ['model_id', 'symbol', 'target', 'horizon', 'spec_json', 'status', 'alpha_index', 'admitted_at',
  'epoch_start', 'incumbent_id', 'status_changed_at', 'e_value', 'e_worse', 'forward_n', 'forward_mean_diff',
  'backtest_json', 'reason', 'updated_at'];
const REGISTRY_MUTABLE = ['status', 'alpha_index', 'epoch_start', 'incumbent_id', 'status_changed_at', 'e_value',
  'e_worse', 'forward_n', 'forward_mean_diff', 'reason', 'updated_at'];

export function importStatements(results) {
  const statements = [];
  for (const g of chunk(results.forecasts || [], 9)) statements.push({
    sql: `INSERT OR IGNORE INTO model_forecasts
      (model_id, symbol, target, horizon, as_of, target_date, forecast_json, issued_at, code_version, input_hash)
      VALUES ${g.map(() => '(?,?,?,?,?,?,?,?,?,?)').join(',')}`,
    params: g.flatMap(f => [f.model_id, f.symbol, f.target, f.horizon, f.as_of, f.target_date, f.forecast_json,
      f.issued_at, f.code_version, f.input_hash ?? null])
  });
  for (const s of results.scores || []) statements.push({
    sql: `UPDATE model_forecasts SET outcome_json = ?, loss = ?, scored_at = ?
      WHERE model_id = ? AND symbol = ? AND horizon = ? AND as_of = ? AND loss IS NULL`,
    params: [s.outcome_json, s.loss, s.scored_at, s.model_id, s.symbol, s.horizon, s.as_of]
  });
  for (const g of chunk(results.registry || [], 5)) statements.push({
    sql: `INSERT INTO model_registry (${REGISTRY_COLUMNS.join(', ')})
      VALUES ${g.map(() => `(${REGISTRY_COLUMNS.map(() => '?').join(',')})`).join(',')}
      ON CONFLICT (model_id, symbol, horizon) DO UPDATE SET
        ${REGISTRY_MUTABLE.map(c => `${c} = excluded.${c}`).join(', ')},
        backtest_json = COALESCE(excluded.backtest_json, model_registry.backtest_json)`,
    params: g.flatMap(r => REGISTRY_COLUMNS.map(c => r[c] ?? null))
  });
  for (const g of chunk(results.transitions || [], 10)) statements.push({
    sql: `INSERT OR IGNORE INTO model_registry_history
      (model_id, symbol, horizon, from_status, to_status, at, reason, e_value, forward_n)
      VALUES ${g.map(() => '(?,?,?,?,?,?,?,?,?)').join(',')}`,
    params: g.flatMap(t => [t.model_id, t.symbol, t.horizon, t.from_status ?? null, t.to_status, t.at, t.reason ?? null,
      t.e_value ?? null, t.forward_n ?? null])
  });
  return statements;
}

export async function importResults(env, results, { batch = d1Batch, query = d1 } = {}) {
  const statements = importStatements(results);
  for (const group of chunk(statements, 25)) await batch(env, group);
  // The run row lands last, so a half-written import is never read as a run.
  await query(env, `INSERT OR IGNORE INTO model_tournament_runs
    (run_id, model_version, created_at, as_of, input_hash, summary_json) VALUES (?,?,?,?,?,?)`,
  [`${results.version}:${results.runAt}`, results.version, results.runAt, results.asOf, results.inputHash || '',
    JSON.stringify(results.summary)]);
  return statements.length;
}

/** What build-signals publishes: the latest run, with each slot marked
 *  actionable only when its incumbent was promoted on forward evidence and
 *  the run is fresh. */
export async function loadTournamentHealth(env, nowMs = Date.now(), query = d1) {
  const rows = await query(env, `SELECT created_at, summary_json FROM model_tournament_runs
    WHERE model_version = ? ORDER BY created_at DESC LIMIT 1`, [TOURNAMENT_VERSION]);
  if (!rows.length) return { status: 'awaiting-first-run', actionable: false };
  const summary = JSON.parse(rows[0].summary_json);
  const ageHours = (nowMs - Date.parse(rows[0].created_at)) / 3600000;
  const fresh = Number.isFinite(ageHours) && ageHours >= 0 && ageHours <= 36;
  let any = false;
  for (const slots of Object.values(summary.assets || {})) {
    for (const slot of Object.values(slots)) {
      slot.actionable = fresh && !!slot.promoted;
      any ||= slot.actionable;
    }
  }
  return { ...summary, ageHours, status: fresh ? 'live' : 'stale', actionable: any };
}

async function main() {
  const [cmd, a, b] = process.argv.slice(2);
  const env = {
    CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
    CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
    FCS_D1_DATABASE_ID: process.env.FCS_D1_DATABASE_ID
  };
  if (cmd === 'data') {
    const input = await buildTournamentInput(JSON.parse(await readFile(a, 'utf8')));
    await writeFile(b, JSON.stringify(input));
    console.log(`tournament input: ${input.rows.length} rows, ${Object.keys(input.klines).length} timing series, as of ${input.asOf}`);
  } else if (cmd === 'export') {
    const state = await exportState(env);
    await writeFile(a, JSON.stringify(state));
    console.log(`tournament state: ${state.registry.length} registry rows, ${state.ledger.length} ledger rows`);
  } else if (cmd === 'import') {
    const n = await importResults(env, JSON.parse(await readFile(a, 'utf8')));
    console.log(`tournament import: ${n} statements`);
  } else {
    throw new Error('usage: model-tournament-io.mjs data|export|import ...');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e); process.exit(1); });
}
