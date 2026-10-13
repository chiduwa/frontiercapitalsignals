// The low-cap watch's ledger, against real SQLite built from the migration: a
// cohort is written once and a rerun cannot change it, an outcome fills only an
// empty column, the page shows the recorded order, and the spike list never
// travels without a live gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { importResults, exportState, loadLowcapWatch, alignToRecord, WATCH_VERSION, STALE_HOURS } from './scripts/lowcap-watch-io.mjs';

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('./migrations/0062_lowcap_watch.sql', import.meta.url), 'utf8'));
  const query = async (_e, sql, p = []) => db.prepare(sql).all(...p);
  const statements = [];
  const batch = async (_e, st) => { for (const s of st) { statements.push(s); db.prepare(s.sql).run(...s.params); } };
  return { db, query, batch, statements };
}

const row = (symbol, inflow_rank, spike_rank, eligible = 1) => ({ as_of: '2026-10-12', symbol, pair: `${symbol}USDT`, close: 1, mcap: 1e7,
  qv90: 1e5, eligible, inflow_rank, inflow_score: 1 / inflow_rank, spike_rank, spike_score: 1 / spike_rank, detail: { name: symbol, mom30: 0.1 } });
const item = (symbol, rank) => ({ rank, symbol, pair: `${symbol}USDT`, name: symbol, mcap: 1e7 });
const results = (over = {}) => ({
  version: WATCH_VERSION, asOf: '2026-10-12', runAt: '2026-10-13T03:00:00Z', inputHash: 'h',
  rows: [row('AAA', 1, 3), row('BBB', 2, 1), row('CCC', 3, 2, 0), ...Array.from({ length: 20 }, (_, i) => row(`Z${i}`, i + 4, i + 4))],
  scores: [],
  summary: { asOf: '2026-10-12', inflowWatch: { status: 'live', list: [item('AAA', 1), item('BBB', 2)] }, spike: { status: 'shadow' }, avoid: [] },
  ...over
});

test('a cohort is written once, whole, and a rerun cannot change it', async () => {
  const { db, query, batch } = database();
  const first = await importResults({}, results(), { batch, query });
  assert.equal(first.inserted, true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lowcap_watch').get().n, 23, 'every low cap, not only the picks');
  const rerun = results({ runAt: '2026-10-13T09:00:00Z', rows: [row('AAA', 9, 9), row('NEW', 1, 1)],
    summary: { asOf: '2026-10-12', inflowWatch: { status: 'live', list: [item('NEW', 1), item('AAA', 2)] }, spike: { status: 'shadow' } } });
  const again = await importResults({}, rerun, { batch, query });
  assert.equal(again.inserted, false);
  assert.equal(db.prepare("SELECT inflow_rank FROM lowcap_watch WHERE symbol = 'AAA'").get().inflow_rank, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM lowcap_watch WHERE symbol = 'NEW'").get().n, 0);
  const page = await loadLowcapWatch({}, Date.parse('2026-10-13T10:00:00Z'), query);
  assert.deepEqual(page.inflowWatch.list.slice(0, 2).map((x) => x.symbol), ['AAA', 'BBB'], 'the page shows the recorded order');
  assert.ok(!page.inflowWatch.list.some((x) => x.symbol === 'CCC'), 'an ineligible coin is never on the list');
});

test('inserts stay under D1\'s 100 bound parameters per statement', async () => {
  const { query, batch, statements } = database();
  await importResults({}, results(), { batch, query });
  assert.ok(statements.length >= 4);
  for (const s of statements) assert.ok(s.params.length <= 100, `${s.params.length} params`);
});

test('an outcome fills an empty column only, and export splits open from scored', async () => {
  const { db, query, batch } = database();
  await importResults({}, results(), { batch, query });
  const s30 = (inflow3x) => ({ as_of: '2026-10-12', symbol: 'AAA', score30: true, fwd_qv_ratio: inflow3x ? 4 : 1, inflow3x });
  await importResults({}, results({ runAt: 'r2', rows: [], scores: [s30(1)] }), { batch, query });
  await importResults({}, results({ runAt: 'r3', rows: [], scores: [s30(0)] }), { batch, query });
  assert.equal(db.prepare("SELECT inflow3x FROM lowcap_watch WHERE symbol = 'AAA'").get().inflow3x, 1);
  let state = await exportState({}, { query });
  assert.ok(state.open.some((r) => r.symbol === 'AAA'), '90-day outcome still open');
  assert.ok(state.scored.some((r) => r.symbol === 'AAA' && r.inflow3x === 1));
  await importResults({}, results({ runAt: 'r4', rows: [], scores: [{ as_of: '2026-10-12', symbol: 'AAA', score90: true,
    max_close_mult: 2.4, ret90: -0.3, tp50: 0.5, tp100: 1, delisted: 0 }] }), { batch, query });
  state = await exportState({}, { query });
  assert.ok(!state.open.some((r) => r.symbol === 'AAA'));
  assert.equal(state.scored.find((r) => r.symbol === 'AAA').tp100, 1);
});

test('the payload loader: first run, live, stale, and no spike list without a live gate', async () => {
  const { query, batch } = database();
  assert.deepEqual(await loadLowcapWatch({}, Date.now(), query), { status: 'awaiting-first-run' });
  const smuggled = results({ summary: { asOf: '2026-10-12', inflowWatch: { status: 'live', list: [] },
    spike: { status: 'shadow', list: [item('BBB', 1)] } } });
  await importResults({}, smuggled, { batch, query });
  const live = await loadLowcapWatch({}, Date.parse('2026-10-13T05:00:00Z'), query);
  assert.equal(live.status, 'live');
  assert.equal(live.spike.list, undefined, 'a shadow spike list is stripped before it reaches the page');
  const stale = await loadLowcapWatch({}, Date.parse('2026-10-13T03:00:00Z') + (STALE_HOURS + 1) * 3600000, query);
  assert.equal(stale.status, 'stale');
});

test('a live spike gate keeps its list, rebuilt in recorded order', () => {
  const recorded = [{ symbol: 'AAA', eligible: 1, inflow_rank: 1, spike_rank: 3, detail_json: '{}' },
    { symbol: 'BBB', eligible: 1, inflow_rank: 2, spike_rank: 1, detail_json: '{}' },
    { symbol: 'CCC', eligible: 0, inflow_rank: 3, spike_rank: 2, detail_json: '{}' }];
  const out = alignToRecord({ inflowWatch: { status: 'live', list: [] }, spike: { status: 'live', list: [] } }, recorded);
  assert.deepEqual(out.spike.list.map((x) => x.symbol), ['BBB', 'AAA']);
  assert.deepEqual(out.inflowWatch.list.map((x) => [x.rank, x.symbol]), [[1, 'AAA'], [2, 'BBB']]);
});
