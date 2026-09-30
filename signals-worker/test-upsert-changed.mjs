// upsertChangedSql must end in exactly the state INSERT OR REPLACE did for
// every table backfill-fundamentals writes, while writing nothing for a row
// that arrives unchanged (the whole point: the chain and network lanes refetch
// their entire history every run). Run: node --test test-upsert-changed.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { upsertChangedSql } from './scripts/d1-client.mjs';

const SCHEMA = readFileSync(new URL('./scripts/schema.sql', import.meta.url), 'utf8');
const SOURCE = readFileSync(new URL('./scripts/backfill-fundamentals.mjs', import.meta.url), 'utf8');

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  return db;
}
const changes = (db) => db.prepare('SELECT total_changes() AS n').get().n;
const contents = (db, table) => db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2, 3`).all().map((r) => ({ ...r }));

// PRIMARY_KEYS as declared in backfill-fundamentals.mjs, read from the source
// because the script exits at import time without D1 credentials.
function declaredKeys() {
  const block = SOURCE.match(/const PRIMARY_KEYS = \{([\s\S]*?)\};/);
  assert.ok(block, 'PRIMARY_KEYS block present in backfill-fundamentals.mjs');
  return Object.fromEntries([...block[1].matchAll(/(\w+): \[([^\]]*)\]/g)]
    .map(([, table, cols]) => [table, [...cols.matchAll(/'(\w+)'/g)].map((m) => m[1])]));
}

// The column list each writeRows call sends, also from the source: inline
// arrays for three lanes, the liquidity lane's `cols` const for the fourth.
function writtenColumns() {
  const out = {};
  for (const m of SOURCE.matchAll(/writeRows\('(\w+)',\s*(\[[^\]]*\]|cols)/g)) {
    const list = m[2] === 'cols'
      ? SOURCE.match(/const cols = (\[[^\]]*\])/)[1]
      : m[2];
    out[m[1]] = [...list.matchAll(/'(\w+)'/g)].map((x) => x[1]);
  }
  return out;
}

test('every table writeRows touches satisfies the REPLACE-equivalence contract', () => {
  const db = database();
  const keys = declaredKeys();
  const written = writtenColumns();
  assert.deepEqual(Object.keys(written).sort(), Object.keys(keys).sort(), 'a key is declared for every table written');
  for (const [table, key] of Object.entries(keys)) {
    const info = db.prepare(`PRAGMA table_info(${table})`).all();
    const pk = info.filter((c) => c.pk).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    assert.deepEqual(key, pk, `${table}: declared key is the primary key`);
    // REPLACE resets any column it is not given; an update keeps it. They
    // agree only when every column is written.
    assert.deepEqual([...written[table]].sort(), info.map((c) => c.name).sort(), `${table}: writeRows sends every column`);
    // REPLACE also clears conflicts on OTHER unique indexes; ON CONFLICT(pk)
    // would instead fail. There must be none.
    const uniques = db.prepare(`PRAGMA index_list(${table})`).all().filter((i) => i.unique && i.origin !== 'pk');
    assert.deepEqual(uniques, [], `${table}: no unique index besides the primary key`);
  }
});

test('conditional upsert matches INSERT OR REPLACE and writes nothing for unchanged rows', () => {
  const table = 'network_cost_daily';
  const cols = ['network', 'date', 'hashrate', 'difficulty', 'miners_revenue_usd', 'transactions', 'source'];
  const key = ['network', 'date'];
  const replace = database();
  const upsert = database();
  const send = (rows) => {
    const params = rows.flatMap((r) => cols.map((c) => r[c] ?? null));
    replace.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES `
      + rows.map(() => `(${cols.map(() => '?').join(', ')})`).join(', ')).run(...params);
    upsert.prepare(upsertChangedSql(table, cols, key, rows.length)).run(...params);
    assert.deepEqual(contents(upsert, table), contents(replace, table));
  };
  const day = (d, over = {}) => ({ network: 'BTC', date: `2026-09-${String(d).padStart(2, '0')}`,
    hashrate: 900e6 + d, difficulty: 1.2e14, miners_revenue_usd: 4.1e7 + d * 0.5, transactions: 400000 + d,
    source: 'blockchain.info', ...over });

  send([day(1), day(2), day(3)]);                                   // fresh inserts
  let before = changes(upsert);
  send([day(1), day(2), day(3)]);                                   // identical refetch
  assert.equal(changes(upsert) - before, 0, 'identical history writes nothing');

  before = changes(upsert);
  send([day(1), day(2, { hashrate: 123 }), day(3), day(4)]);        // one correction + one new day
  assert.equal(changes(upsert) - before, 2, 'only the corrected and the new row are written');

  send([day(2, { transactions: null })]);                           // value -> NULL
  send([day(2, { transactions: 7 })]);                              // NULL -> value
  send([day(3, { source: 'mempool' })]);                            // non-numeric column only
  send([day(5), day(5, { hashrate: 1 })]);                          // same key twice in one statement: last wins
  send([day(5, { hashrate: 1 })]);
  before = changes(upsert);
  send([day(1), day(2, { transactions: 7 }), day(3, { source: 'mempool' }), day(4), day(5, { hashrate: 1 })]);
  assert.equal(changes(upsert) - before, 0, 'converged history writes nothing');
});

test('builder rejects a key that is not a strict subset of the columns', () => {
  assert.throws(() => upsertChangedSql('t', ['a', 'b'], ['a', 'b'], 1));
  assert.throws(() => upsertChangedSql('t', ['a', 'b'], ['c'], 1));
  assert.match(upsertChangedSql('t', ['a', 'b'], ['a'], 2),
    /^INSERT INTO t \(a, b\) VALUES \(\?, \?\), \(\?, \?\) ON CONFLICT \(a\) DO UPDATE SET b = excluded\.b WHERE t\.b IS NOT excluded\.b$/);
});
