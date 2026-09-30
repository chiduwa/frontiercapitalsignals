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
