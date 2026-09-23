// The big-move watch's ledger and push, against real SQLite built from the
// migration: a flagged coin is never rewritten, a score fills only an empty
// row, the daily push goes out once per close however often the job reruns,
// and quarantined bars and pegs never reach the model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { importResults, exportState, loadBigMoveWatch, buildSeries, digest, WATCH_VERSION } from './scripts/big-move-watch-io.mjs';

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('./migrations/0050_big_move_watch.sql', import.meta.url), 'utf8'));
  const query = async (_e, sql, p = []) => db.prepare(sql).all(...p);
  const batch = async (_e, st) => { for (const s of st) db.prepare(s.sql).run(...s.params); };
  return { db, query, batch };
}
const watchRow = (symbol, rank, p) => ({ as_of: '2026-09-22', symbol, rank, p, close: 1, vol20_pct: 9.5, move_today_pct: 31, r5_pct: 50, volume_ratio: 7 });
const results = (over = {}) => ({ version: WATCH_VERSION, runAt: '2026-09-23T15:40:00Z', asOf: '2026-09-22', inputHash: 'h',
  watch: [watchRow('AIOZ', 1, 0.49), watchRow('ZETA', 2, 0.36)], scores: [],
  summary: { asOf: '2026-09-22', watch: [watchRow('AIOZ', 1, 0.49), watchRow('ZETA', 2, 0.36)], notifying: true, statusNote: 'proven at discovery' }, ...over });

test('a flagged coin is written once; a rerun cannot change what was flagged, or push twice', async () => {
  const { db, query, batch } = database();
  const pushes = [];
  const notify = async (_t, m) => { pushes.push(m); return true; };
  const first = await importResults({}, results(), { batch, query, notify, topic: 't' });
  const again = await importResults({}, results({ runAt: '2026-09-23T18:00:00Z', watch: [watchRow('AIOZ', 1, 0.99)] }), { batch, query, notify, topic: 't' });
  assert.equal(db.prepare("SELECT p FROM big_move_watch WHERE symbol = 'AIOZ'").get().p, 0.49);
  assert.equal(first.notified, true);
  assert.equal(again.notified, false, 'one push per as-of close');
  assert.equal(pushes.length, 1);
  assert.match(pushes[0].message, /Direction unknown/);
});

test('a score fills an empty row only, and export splits open from scored', async () => {
  const { db, query, batch } = database();
  await importResults({}, results(), { batch, query, notify: async () => false });
  const score = (big) => ({ as_of: '2026-09-22', symbol: 'AIOZ', move_pct: big ? -18 : 2, big, day_base_rate: 0.09 });
  await importResults({}, results({ runAt: 'r2', watch: [], scores: [score(1)] }), { batch, query, notify: async () => false });
  await importResults({}, results({ runAt: 'r3', watch: [], scores: [score(0)] }), { batch, query, notify: async () => false });
  assert.equal(db.prepare("SELECT big FROM big_move_watch WHERE symbol = 'AIOZ'").get().big, 1);
  const state = await exportState({}, { query });
  assert.deepEqual(state.open.map(r => r.symbol), ['ZETA']);
  assert.deepEqual(state.scored, [{ as_of: '2026-09-22', symbol: 'AIOZ', big: 1, day_base_rate: 0.09 }]);
});

test('a demoted watch does not push', async () => {
  const { query, batch } = database();
  let pushed = 0;
  await importResults({}, results({ summary: { ...results().summary, notifying: false } }), { batch, query, notify: async () => { pushed++; return true; } });
  assert.equal(pushed, 0);
});

test('the payload loader reports live or stale', async () => {
  const { query, batch } = database();
  assert.equal((await loadBigMoveWatch({}, Date.now(), query)).status, 'awaiting-first-run');
  await importResults({}, results(), { batch, query, notify: async () => false });
  assert.equal((await loadBigMoveWatch({}, Date.parse('2026-09-23T20:00:00Z'), query)).status, 'live');
  assert.equal((await loadBigMoveWatch({}, Date.parse('2026-09-26T20:00:00Z'), query)).status, 'stale');
});

test('quarantined bars and pegs never reach the model', () => {
  const day = i => new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10);
  const rows = [];
  for (let i = 0; i < 200; i++) {
    rows.push({ symbol: 'ALT', date: day(i), close: 1 + 0.1 * Math.sin(i), high: 1.2, low: 0.9, volume: 1e6, source: 'binance' });
    rows.push({ symbol: 'USDC', date: day(i), close: 1 + (i % 2 ? 0.0001 : -0.0001), high: 1, low: 1, volume: 1e9, source: 'binance' });
  }
  const s = buildSeries(rows, [{ symbol: 'ALT', date: day(50) }]);
  assert.deepEqual(Object.keys(s), ['ALT']);
  assert.ok(!s.ALT.some(r => r[0] === day(50)), 'the quarantined bar is gone');
});

test('the digest names the coins, the odds and that direction is unknown', () => {
  const m = digest(results().summary);
  assert.match(m.title, /AIOZ, ZETA/);
  assert.match(m.message, /1\. AIOZ\s+49%/);
  assert.equal(digest({ watch: [] }), null);
});
