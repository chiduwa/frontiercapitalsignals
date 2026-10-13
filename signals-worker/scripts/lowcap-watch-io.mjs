// D1 and payload side of the low-cap watch (scripts/lowcap-watch.py does the
// fetching and modelling; docs/LOWCAP_SPIKES.md has the evidence):
//
//   export <state.json>     ledger rows still waiting for a 30- or 90-day outcome,
//                           and every row already scored (for the live record)
//   import <results.json>   today's cohort (insert-only), outcomes, the run summary
//
// Every low cap is written once per as-of close with both of its ranks, before
// its outcomes exist, and scored in place later. The first ranking of a close is
// its record: a rerun adds nothing and the page shows what was recorded.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { d1, d1Batch, chunk, pageAll } from './d1-client.mjs';

export const WATCH_VERSION = 'lowcap-watch-v1';
export const TOP_N = 10;
// The job runs once a day and GitHub starts daily crons hours late, so a summary
// is live for a day and a half before the page calls it stale.
export const STALE_HOURS = 36;

const ROW_COLS = ['model_version', 'as_of', 'symbol', 'pair', 'close', 'mcap', 'qv90', 'eligible', 'inflow_rank',
  'inflow_score', 'spike_rank', 'spike_score', 'detail_json', 'issued_at'];
// D1 binds at most 100 parameters per statement: 14 columns x 7 rows = 98.
const ROWS_PER_INSERT = Math.floor(100 / ROW_COLS.length);

export async function exportState(env, { query = d1 } = {}) {
  const page = (where) => pageAll((limit, offset) => query(env, `SELECT as_of, symbol, pair, close, qv90, eligible,
      inflow_rank, spike_rank, fwd_qv_ratio, inflow3x, scored30_at, max_close_mult, ret90, tp50, tp100, delisted, scored90_at
    FROM lowcap_watch WHERE model_version = ? AND ${where} ORDER BY as_of, symbol LIMIT ${limit} OFFSET ${offset}`, [WATCH_VERSION]));
  return {
    open: await page('(scored30_at IS NULL OR scored90_at IS NULL)'),
    scored: await page('(scored30_at IS NOT NULL OR scored90_at IS NOT NULL)')
  };
}

function insertStatements(version, runAt, rows) {
  return chunk(rows, ROWS_PER_INSERT).map((g) => ({
    sql: `INSERT OR IGNORE INTO lowcap_watch (${ROW_COLS.join(', ')}) VALUES ${g.map(() => `(${ROW_COLS.map(() => '?').join(',')})`).join(',')}`,
    params: g.flatMap((r) => [version, r.as_of, r.symbol, r.pair, r.close, r.mcap ?? null, r.qv90 ?? null, r.eligible ? 1 : 0,
      r.inflow_rank, r.inflow_score, r.spike_rank, r.spike_score, JSON.stringify(r.detail || {}), runAt])
  }));
}

function scoreStatements(version, runAt, scores) {
  const out = [];
  for (const s of scores || []) {
    if (s.score30) out.push({
      sql: `UPDATE lowcap_watch SET fwd_qv_ratio = ?, inflow3x = ?, scored30_at = ?
        WHERE model_version = ? AND as_of = ? AND symbol = ? AND scored30_at IS NULL`,
      params: [s.fwd_qv_ratio ?? null, s.inflow3x ?? null, runAt, version, s.as_of, s.symbol]
    });
    if (s.score90) out.push({
      sql: `UPDATE lowcap_watch SET max_close_mult = ?, ret90 = ?, tp50 = ?, tp100 = ?, delisted = ?, scored90_at = ?
        WHERE model_version = ? AND as_of = ? AND symbol = ? AND scored90_at IS NULL`,
      params: [s.max_close_mult ?? null, s.ret90 ?? null, s.tp50 ?? null, s.tp100 ?? null, s.delisted ?? null, runAt,
        version, s.as_of, s.symbol]
    });
  }
  return out;
}

// When the close was already recorded, the page must show the recorded order,
// not this rerun's: the published list is rebuilt from the ledger's ranks, and
// display fields come from this run where the coin is in it.
export function alignToRecord(summary, recorded) {
  const pick = (rankCol) => recorded.filter((r) => Number(r.eligible) === 1)
    .sort((a, b) => Number(a[rankCol]) - Number(b[rankCol])).slice(0, TOP_N);
  const fromRun = new Map([...(summary.inflowWatch?.list || []), ...(summary.spike?.list || [])].map((x) => [x.symbol, x]));
  const rebuild = (rows) => rows.map((r, i) => {
    const d = JSON.parse(r.detail_json || '{}');
    return { ...(fromRun.get(r.symbol) || { symbol: r.symbol, pair: r.pair, name: d.name ?? null, mcap: r.mcap == null ? null : Number(r.mcap),
      mom30: d.mom30 ?? null, perp: !!d.hasPerp }), rank: i + 1 };
  });
  const out = { ...summary, recordedAt: recorded[0]?.issued_at || null };
  if (summary.inflowWatch?.status === 'live') out.inflowWatch = { ...summary.inflowWatch, list: rebuild(pick('inflow_rank')) };
  if (summary.spike?.status === 'live') out.spike = { ...summary.spike, list: rebuild(pick('spike_rank')) };
  return out;
}

export async function importResults(env, results, { batch = d1Batch, query = d1 } = {}) {
  const version = results.version || WATCH_VERSION;
  const recorded = await query(env, `SELECT symbol, pair, mcap, eligible, inflow_rank, spike_rank, detail_json, issued_at
    FROM lowcap_watch WHERE model_version = ? AND as_of = ?`, [version, results.asOf]);
  const statements = [
    ...(recorded.length ? [] : insertStatements(version, results.runAt, results.rows || [])),
    ...scoreStatements(version, results.runAt, results.scores)
  ];
  for (const group of chunk(statements, 25)) await batch(env, group);
  const summary = recorded.length ? alignToRecord(results.summary, recorded) : results.summary;
  await query(env, `INSERT OR IGNORE INTO lowcap_watch_runs (run_id, model_version, created_at, as_of, input_hash, summary_json)
    VALUES (?,?,?,?,?,?)`, [`${version}:${results.runAt}`, version, results.runAt, results.asOf, results.inputHash || '', JSON.stringify(summary)]);
  return { statements: statements.length, inserted: !recorded.length, scored: (results.scores || []).length };
}

export async function loadLowcapWatch(env, nowMs = Date.now(), query = d1) {
  const rows = await query(env, `SELECT created_at, summary_json FROM lowcap_watch_runs
    WHERE model_version = ? ORDER BY created_at DESC LIMIT 1`, [WATCH_VERSION]);
  if (!rows.length) return { status: 'awaiting-first-run' };
  const summary = JSON.parse(rows[0].summary_json);
  const ageHours = (nowMs - Date.parse(rows[0].created_at)) / 3600000;
  // Fail closed a second time: a spike list only travels with a live gate.
  if (summary.spike?.status !== 'live' && summary.spike) delete summary.spike.list;
  return { ...summary, lastRunAt: rows[0].created_at, ageHours,
    status: Number.isFinite(ageHours) && ageHours >= 0 && ageHours <= STALE_HOURS ? 'live' : 'stale' };
}

async function main() {
  const [cmd, file] = process.argv.slice(2);
  const env = { CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
    FCS_D1_DATABASE_ID: process.env.FCS_D1_DATABASE_ID };
  if (cmd === 'export') {
    const state = await exportState(env);
    await writeFile(file, JSON.stringify(state));
    console.log(`lowcap state: ${state.open.length} rows open, ${state.scored.length} with an outcome`);
  } else if (cmd === 'import') {
    const r = await importResults(env, JSON.parse(await readFile(file, 'utf8')));
    console.log(`lowcap import: ${r.statements} statements, cohort ${r.inserted ? 'recorded' : 'already recorded (kept)'}, ${r.scored} rows scored`);
  } else {
    throw new Error('usage: lowcap-watch-io.mjs export|import <file>');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
