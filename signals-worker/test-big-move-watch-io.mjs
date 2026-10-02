// The big-move watch's ledger and push, against real SQLite built from the
// migration: a flagged coin is never rewritten, a score fills only an empty
// row, the daily push goes out once per close however often the job reruns,
// and quarantined bars and pegs never reach the model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { importResults, exportState, loadBigMoveWatch, buildSeries, digest, topUpLatestDay, recoverOutcomes, EARLY, WATCH_VERSION } from './scripts/big-move-watch-io.mjs';

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
  for (let i = 0; i < 200; i++) rows.push({ symbol: 'BONK', date: day(i), close: [4e-6, 4e-6, 5e-6, 4e-6, 3e-6][i % 5], high: 5e-6, low: 3e-6, volume: 1e6, source: 'yahoo' });
  const s = buildSeries(rows, [{ symbol: 'ALT', date: day(50) }]);
  assert.deepEqual(Object.keys(s), ['ALT'], 'the peg and the six-decimal series are both left out');
  assert.ok(!s.ALT.some(r => r[0] === day(50)), 'the quarantined bar is gone');
});

test('the digest names the coins, the odds and that direction is unknown', () => {
  const m = digest(results().summary);
  assert.match(m.title, /AIOZ, ZETA/);
  assert.match(m.message, /1\. AIOZ\s+49%/);
  assert.equal(digest({ watch: [] }), null);
});

test('a later ranking of the same close adds no coins; its summary shows what was recorded and pushed', async () => {
  const { db, query, batch } = database();
  await importResults({}, results(), { batch, query, notify: async () => true, topic: 't' });
  const later = results({ runAt: '2026-09-23T21:00:00Z', watch: [watchRow('NEW', 1, 0.6), watchRow('AIOZ', 2, 0.4)],
    summary: { ...results().summary, watch: [watchRow('NEW', 1, 0.6), watchRow('AIOZ', 2, 0.4)] } });
  await importResults({}, later, { batch, query, notify: async () => true, topic: 't' });
  assert.deepEqual(db.prepare("SELECT symbol FROM big_move_watch WHERE as_of = '2026-09-22' ORDER BY rank").all().map(r => r.symbol), ['AIOZ', 'ZETA']);
  const shown = await loadBigMoveWatch({}, Date.parse('2026-09-23T22:00:00Z'), query);
  assert.deepEqual(shown.watch.map(r => r.symbol), ['AIOZ', 'ZETA']);
  assert.equal(shown.watch[0].vol20_pct, 9.5, 'the recorded details travel with the recorded coins');
  assert.equal(shown.recordedAt, '2026-09-23T15:40:00Z');
});

// ---- the early pass: the just-closed day, in memory, from the coin's own supplier ----
const NOW = Date.parse('2026-10-03T00:21:00Z');                 // target close 2026-10-02
const dayN = i => new Date(Date.UTC(2026, 9, 2) - i * 86400000).toISOString().slice(0, 10);   // dayN(0) = 2026-10-02
function archive({ through = 1, coins = { BIN: 'binance', YAH: 'yahoo', CGK: 'coingecko' } } = {}) {
  const rows = [];
  for (const [symbol, source] of Object.entries(coins))
    for (let i = 120; i >= through; i--) rows.push({ symbol, date: dayN(i), close: 10 + i / 100, high: 11, low: 9, volume: 1e6, source });
  return rows;
}
const fresh = (symbol, { prevClose = 10.01, lastClose = 12 } = {}) => {
  const bars = [];
  for (let i = 40; i >= 2; i--) bars.push({ date: dayN(i), close: 10 + i / 100, high: 11, low: 9, volume: 1e6 });
  bars.push({ date: dayN(1), close: prevClose, high: 11, low: 9, volume: 1e6 });
  if (lastClose != null) bars.push({ date: dayN(0), close: lastClose, high: 12.5, low: 9.5, volume: 3e6 });
  return bars;
};

test('the early pass adds only the just-closed day, and only from the supplier the archive already uses', async () => {
  const calls = [];
  const { rows, meta } = await topUpLatestDay(archive(), { nowMs: NOW,
    fetchBinance: async (s, ref) => { calls.push(['binance', s, ref]); return fresh(s); },
    fetchYahoo: async (t) => { calls.push(['yahoo', t]); return fresh(t); } });
  assert.deepEqual(calls.map(c => c.slice(0, 2)), [['binance', 'BIN'], ['yahoo', 'YAH-USD']], 'CoinGecko coins are never topped up');
  assert.equal(calls[0][2], 10.01, 'the identity reference is the stored close');
  const added = rows.filter(r => r.date === dayN(0));
  assert.deepEqual(added.map(r => [r.symbol, r.source, r.close, r.volume]).sort(), [['BIN', 'binance', 12, 3e6], ['YAH', 'yahoo', 12, 3e6]]);
  assert.equal(meta.provisional, true);
  assert.equal(meta.target, '2026-10-02');
  assert.equal(meta.toppedUp, 2);
});

test('a fetched series that disagrees with the stored close is left out, not spliced', async () => {
  const coins = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`C${i}`, 'binance']));
  const { rows, meta } = await topUpLatestDay(archive({ coins }), { nowMs: NOW,
    fetchBinance: async (s) => fresh(s, { prevClose: s === 'C3' ? 10.2 : 10.01 }), fetchYahoo: async () => { throw new Error('unused'); } });
  assert.ok(!rows.some(r => r.symbol === 'C3' && r.date === dayN(0)));
  assert.equal(meta.toppedUp, 9);
  assert.match(meta.skipped.join(' '), /C3 \(binance: does not match the stored/);
});

test('once the archive has the day, nothing is added and the run is a normal one', async () => {
  let fetched = 0;
  const f = async () => { fetched++; return fresh('x'); };
  const { rows, meta } = await topUpLatestDay(archive({ through: 0 }), { nowMs: NOW, fetchBinance: f, fetchYahoo: f });
  assert.equal(fetched, 0);
  assert.equal(meta.provisional, false);
  assert.equal(rows.length, archive({ through: 0 }).length);
});

test('a pass that reaches too few coins is refused, so the archive-backed run issues the watch', async () => {
  const coins = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`C${i}`, 'binance']));
  await assert.rejects(topUpLatestDay(archive({ coins }), { nowMs: NOW,
    fetchBinance: async (s) => { if (Number(s.slice(1)) < 3) throw new Error('HTTP 503'); return fresh(s); },
    fetchYahoo: async () => { throw new Error('unused'); } }), /early pass refused: 7 of 10/);
  assert.ok(EARLY.minCoverage >= 0.8);
});

test('a bar for the day still in progress is never taken as the close', async () => {
  const { meta } = await topUpLatestDay(archive({ coins: { BIN: 'binance' } }).concat(), { nowMs: NOW,
    // the supplier answers with the bar still forming (dated today) and no finished one
    fetchBinance: async (s) => fresh(s, { lastClose: null }).concat([{ date: '2026-10-03', close: 13, high: 13, low: 12, volume: 1 }]),
    fetchYahoo: async () => { throw new Error('unused'); } }).catch(e => ({ meta: { error: e.message } }));
  assert.match(meta.error, /early pass refused: 0 of 1/);
});

test('a provisional series ranks the new close without disturbing earlier bars', () => {
  const rows = archive({ coins: { ALT: 'binance' } });
  const before = buildSeries(rows);
  const after = buildSeries(rows.concat([{ symbol: 'ALT', date: dayN(0), close: 12, high: 12.5, low: 9.5, volume: 3e6, source: 'binance' }]));
  assert.deepEqual(after.ALT.slice(0, -1), before.ALT);
  assert.deepEqual(after.ALT.at(-1), [dayN(0), 12, 12.5, 9.5, 3e6]);
});

test('a pick whose coin left the archive is scored from its own supplier; anything the archive can score is left alone', async () => {
  const stored = [
    { symbol: 'GONE', date: dayN(4), close: 10.04, source: 'binance' },                 // flagged on dayN(4), then dropped
    { symbol: 'KEPT', date: dayN(4), close: 10.04, source: 'binance' }, { symbol: 'KEPT', date: dayN(2), close: 9, source: 'binance' },
    { symbol: 'CGK', date: dayN(4), close: 10.04, source: 'coingecko' },
    { symbol: 'YAH', date: dayN(4), close: 10.04, source: 'yahoo' }];
  const query = async (_e, sql, p) => stored.filter(r => p.slice(1).includes(r.symbol) && r.date >= p[0]);
  const bars = () => { const b = []; for (let i = 44; i >= 0; i--) b.push({ date: dayN(i), close: i === 2 ? 8 : 10 + i / 100 }); return b; };
  const fetched = [];
  const open = ['GONE', 'KEPT', 'CGK', 'YAH'].map(symbol => ({ as_of: dayN(4), symbol })).concat([{ as_of: dayN(1), symbol: 'GONE' }]);
  const out = await recoverOutcomes({}, open, { nowMs: NOW, query,
    fetchBinance: async (s, ref) => { fetched.push([s, ref]); return bars(); },
    fetchYahoo: async (t) => { fetched.push([t]); return bars().map(b => b.date === dayN(4) ? { ...b, close: 11 } : b); } });
  assert.deepEqual(out.map(r => [r.symbol, r.as_of, r.source]), [['GONE', dayN(4), 'binance']]);
  assert.ok(Math.abs(out[0].fwd2 - (8 / 10.04 - 1)) < 1e-12, 'flagged close to the close two days on');
  assert.deepEqual(fetched.map(f => f[0]), ['GONE', 'YAH-USD'], 'the archive-scorable, CoinGecko and not-yet-due rows fetch nothing');
});
