// Guards the D1 read-cost fixes of 2026-09-30. Each replaced a full-table
// read with an index SEARCH returning the same rows (verified on production);
// this keeps them that way. Run: node --test test-query-plans.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = readFileSync(new URL('./scripts/schema.sql', import.meta.url), 'utf8');
const db = new DatabaseSync(':memory:');
db.exec(SCHEMA);
const plan = (sql) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((r) => r.detail).join(' | ');

// INDEXED BY is a hard dependency: if the named index is ever renamed or
// dropped the statement stops preparing, and on the Oracle host that is the
// OI sampler not starting. Fail here instead.
test('every INDEXED BY names an index the schema snapshot declares', () => {
  const sources = [
    ...readdirSync(new URL('./scripts/', import.meta.url)).filter((f) => f.endsWith('.mjs')).map((f) => `scripts/${f}`),
    'worker.js'
  ];
  const declared = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((r) => r.name));
  const used = [];
  for (const file of sources) {
    const text = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
    for (const m of text.matchAll(/INDEXED BY (\w+)/g)) used.push([file, m[1]]);
  }
  assert.ok(used.length >= 2, 'the OI sampler hints are present');
  for (const [file, index] of used) assert.ok(declared.has(index), `${file}: INDEXED BY ${index} is not in scripts/schema.sql`);
});

test('the OI sampler reads only its recent window', () => {
  const source = readFileSync(new URL('./scripts/oi-sampler.mjs', import.meta.url), 'utf8');
  const seed = source.match(/'(SELECT symbol, ts, oi_usd, mark_price FROM oi_tick[^']*)'/)[1];
  assert.match(plan(seed.replace('?', '0')), /SEARCH oi_tick USING INDEX idx_oi_tick_ts \(ts>\?\)/);
  const watch = source.match(/`(SELECT symbol FROM derivatives_daily[^`]*)`/)[1];
  assert.match(plan(watch.replace('?', '40')), /SEARCH derivatives_daily USING INDEX idx_derivatives_daily_date \(date>\?\)/);
});

test('the TVL lookup seeks the key instead of scanning every daily bar', () => {
  const source = readFileSync(new URL('./scripts/archive.mjs', import.meta.url), 'utf8');
  const sql = source.match(/"(SELECT DISTINCT symbol FROM asset_daily_bars WHERE symbol >= 'TVL:'[^"]*)"/);
  assert.ok(sql, 'loadTvlSeries uses the prefix range');
  assert.match(plan(sql[1]), /SEARCH asset_daily_bars USING COVERING INDEX \S+ \(symbol>\? AND symbol<\?\)/);
  // Same rows as LIKE for everything daily-refresh writes (always the literal
  // uppercase prefix), including neighbours on both sides of the range.
  const insert = db.prepare(`INSERT INTO asset_daily_bars (symbol, asset_class, date, close, source) VALUES (?, 'tvl', '2026-09-01', 1, 't')`);
  for (const s of ['TVL:AAVE', 'TVL:1INCH', 'TVL:', 'TVL;X', 'TVL9', 'TVLX:1', 'SPREAD:2s10s', 'BTC']) insert.run(s);
  const like = db.prepare("SELECT DISTINCT symbol FROM asset_daily_bars WHERE symbol LIKE 'TVL:%' ORDER BY symbol").all();
  assert.deepEqual(db.prepare(`${sql[1]} ORDER BY symbol`).all(), like);
  db.exec("DELETE FROM asset_daily_bars");
});

test('technique_votes time-range reads use the primary key once the duplicate run_at index is gone', () => {
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'idx_technique_votes_run_at'").get().n, 0);
  for (const sql of [
    "SELECT symbol FROM technique_votes WHERE technique_id = 'reversal' AND run_at >= '2026-09-29' ORDER BY symbol, run_at",
    "SELECT symbol FROM technique_votes WHERE asset_class = 'crypto' AND run_at >= '2026-09-28' AND run_at < '2026-09-29' ORDER BY run_at, symbol, technique_id",
    "DELETE FROM technique_votes WHERE run_at < '2026-01-01' AND evaluated_24 = 1 AND evaluated_168 = 1",
    "DELETE FROM technique_votes WHERE run_at < '2026-01-01'"
  ]) assert.match(plan(sql), /SEARCH technique_votes USING (COVERING )?INDEX sqlite_autoindex_technique_votes_1 \(run_at[<>]/, sql);
  assert.match(plan("SELECT run_at FROM technique_votes WHERE run_at <= '2026-09-28' AND evaluated_24 = 0"),
    /idx_technique_votes_pending_24/);
});

const T0 = 1790000000000;
// Migration 0059 re-stores oi_tick WITHOUT ROWID. Every query that reads the
// table must return byte-identical results before and after, since the flush
// detector, decoupling watch and market explanations all read it.
test('oi_tick WITHOUT ROWID migration leaves every reader result identical', () => {
  const read = (f) => readFileSync(new URL(f, import.meta.url), 'utf8');
  const readers = [
    // [source file, SQL exactly as written there, params]
    ['./scripts/oi-sampler.mjs', 'SELECT symbol, ts, oi_usd, mark_price FROM oi_tick INDEXED BY idx_oi_tick_ts WHERE ts >= ? ORDER BY symbol, ts', [T0 + 3000 * 20000]],
    ['./scripts/oi-sampler.mjs', 'SELECT mark_price FROM oi_tick WHERE symbol = ? AND ts > ? AND ts <= ? ORDER BY ts', ['S7', T0 + 100 * 20000, T0 + 400 * 20000]],
    ['./scripts/decoupling-watch-io.mjs', `SELECT ts, oi_contracts FROM oi_tick
    WHERE symbol = ? AND ts BETWEEN ? AND ? AND oi_contracts > 0 ORDER BY ts`, ['S3', T0 + 50 * 20000, T0 + 900 * 20000]],
    ['./scripts/market-explanations.mjs', 'SELECT symbol,ts,oi_contracts,mark_price FROM oi_tick WHERE symbol IN (?,?,?) AND ts>=? AND ts<=? ORDER BY symbol,ts', ['S1', 'S2', 'S39', T0 + 1000 * 20000, T0 + 3500 * 20000]],
    ['./scripts/market-explanations.mjs', 'SELECT symbol,MAX(ts) last_ts FROM oi_tick WHERE symbol IN (?,?,?) AND ts<=? GROUP BY symbol', ['S1', 'S2', 'S39', T0 + 2000 * 20000]],
    // flush-audit correlates these on its flush_event row (e.symbol, e.first_ts);
    // they run here with those two values bound.
    ['./scripts/flush-audit.mjs', 'SELECT oi_contracts FROM oi_tick t WHERE t.symbol=? AND t.ts<=? ORDER BY t.ts DESC LIMIT 1', ['S5', T0 + 777 * 20000 + 3],
      'SELECT oi_contracts FROM oi_tick t WHERE t.symbol=e.symbol AND t.ts<=e.first_ts ORDER BY t.ts DESC LIMIT 1'],
    ['./scripts/flush-audit.mjs', 'SELECT oi_usd FROM oi_tick t WHERE t.symbol=? AND t.ts<=? ORDER BY t.ts DESC LIMIT 1', ['S5', T0 + 777 * 20000 + 3],
      'SELECT oi_usd FROM oi_tick t WHERE t.symbol=e.symbol AND t.ts<=e.first_ts ORDER BY t.ts DESC LIMIT 1'],
    [null, 'SELECT * FROM oi_tick ORDER BY symbol, ts', []]
  ];
  // Each query must still be the one production runs (whitespace-insensitive).
  // market-explanations builds its IN list from ${placeholders}, so its text
  // is compared up to that point.
  const squash = (x) => x.replace(/\s+/g, ' ').trim();
  for (const [file, sql, , sourceSql] of readers) {
    if (!file) continue;
    const fixed = squash(sourceSql || (sql.includes('IN (?,?,?)') ? sql.split('IN (?,?,?)')[0] + 'IN (' : sql));
    assert.ok(squash(read(file)).includes(fixed), `${file} no longer issues: ${fixed}`);
  }

  const pre = new DatabaseSync(':memory:');
  // The pre-0059 shape, exactly as migration 0037 created it.
  pre.exec(read('./migrations/0037_oi_tick_and_flush_events.sql'));
  let state = 7;
  const rnd = () => ((state = (state * 48271) % 2147483647) / 2147483647);
  const insert = pre.prepare('INSERT OR REPLACE INTO oi_tick (symbol, ts, oi_contracts, oi_usd, mark_price) VALUES (?, ?, ?, ?, ?)');
  // Insert in sweep order (all symbols per tick) like the sampler, with jitter,
  // occasional NULLs and a few REPLACEs of an existing key.
  for (let k = 0; k < 4000; k++) for (let s = 0; s < 40; s++) {
    if (rnd() < 0.02) continue;
    const c = rnd() < 0.01 ? null : 1e6 * rnd();
    insert.run(`S${s}`, T0 + k * 20000 + (s % 7), c, c == null ? null : c * (1 + rnd()), 10 + rnd());
  }
  for (let r = 0; r < 50; r++) insert.run(`S${r % 40}`, T0 + r * 20000 + ((r % 40) % 7), 1.5, 2.5, 3.5);
  const run = (db) => readers.map(([, sql, params]) => JSON.stringify(db.prepare(sql).all(...params)));
  const before = run(pre);
  pre.exec(read('./migrations/0059_oi_tick_without_rowid.sql'));
  assert.deepEqual(run(pre), before);
  const ddl = pre.prepare("SELECT sql FROM sqlite_master WHERE name = 'oi_tick'").get().sql;
  assert.match(ddl, /WITHOUT ROWID/);
  assert.deepEqual(pre.prepare("SELECT name FROM sqlite_master WHERE tbl_name = 'oi_tick' AND type = 'index' ORDER BY name").all().map((r) => r.name),
    ['idx_oi_tick_ts'], 'no hidden autoindex left; the ts index kept its name');
  // Writers and retention behave the same afterwards.
  pre.prepare('INSERT OR REPLACE INTO oi_tick (symbol, ts, oi_contracts, oi_usd, mark_price) VALUES (?, ?, ?, ?, ?)').run('S1', T0, 9, 9, 9);
  assert.equal(pre.prepare('SELECT oi_contracts FROM oi_tick WHERE symbol = ? AND ts = ?').get('S1', T0).oi_contracts, 9);
  const kept = pre.prepare('SELECT COUNT(*) AS n FROM oi_tick WHERE ts >= ?').get(T0 + 2000 * 20000).n;
  pre.prepare('DELETE FROM oi_tick WHERE ts < ?').run(T0 + 2000 * 20000);
  assert.equal(pre.prepare('SELECT COUNT(*) AS n FROM oi_tick').get().n, kept);
  // The fresh-database snapshot matches what the migration produces.
  assert.match(SCHEMA.match(/CREATE TABLE IF NOT EXISTS oi_tick \([\s\S]*?\)[^;]*;/)[0], /WITHOUT ROWID;$/);
});
