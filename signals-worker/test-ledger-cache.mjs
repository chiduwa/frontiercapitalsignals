import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ledgerRows, chunkedScan, ledgerCacheStatus, resetLedgerCacheRun, CHUNK_SLOT, FRESH_HOURS, HARD_HOURS, RESCANS_PER_RUN } from './scripts/ledger-cache.mjs';

const env = { CLOUDFLARE_ACCOUNT_ID: 'a', FCS_D1_DATABASE_ID: 'd', CLOUDFLARE_API_TOKEN: 't', FCS_KV_NAMESPACE_ID: 'k' };
const NOW = Date.parse('2026-11-05T12:00:00Z');
const now = () => NOW;
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();
const respond = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const d1Ok = (results) => respond({ success: true, result: [{ success: true, results }] });

// A fake Cloudflare: KV in a Map, and D1 answered by `onQuery`.
function cloud(t, { kv = {}, onQuery = () => d1Ok([{ n: 'scanned' }]) } = {}) {
  const store = new Map(Object.entries(kv).map(([k, v]) => [k, JSON.stringify(v)]));
  const seen = { queries: 0, puts: [] };
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (String(url).includes('/d1/')) { seen.queries++; return onQuery(JSON.parse(options.body)); }
    const key = decodeURIComponent(String(url).split('/values/')[1].split('?')[0]);
    if (options.method === 'PUT') { store.set(key, options.body); seen.puts.push({ key, url: String(url) }); return respond({ success: true }); }
    return store.has(key) ? respond(JSON.parse(store.get(key))) : respond(null, 404);
  });
  resetLedgerCacheRun();
  return { seen, store };
}

// Runs once to learn the key, then ages the entry in place.
async function primed(t, name, sql, params, ageHours, extra = {}) {
  const c = cloud(t, extra);
  await ledgerRows(env, name, sql, params, { now });
  const key = [...c.store.keys()].find((k) => k.includes(`:${name}:`));
  c.store.set(key, JSON.stringify({ computedAt: hoursAgo(ageHours), rows: [{ n: 'cached' }] }));
  c.seen.queries = 0;
  c.seen.puts.length = 0;
  resetLedgerCacheRun();
  return c;
}

test('without a KV namespace it is a plain query, and the chunk slot is removed', async (t) => {
  let sent;
  t.mock.method(globalThis, 'fetch', async (_url, options) => { sent = JSON.parse(options.body).sql; return d1Ok([{ n: 1 }]); });
  assert.deepEqual(await ledgerRows({ CLOUDFLARE_ACCOUNT_ID: 'a' }, 'x', `SELECT 1 ${CHUNK_SLOT}`, [], { chunked: true }), [{ n: 1 }]);
  assert.equal(sent, 'SELECT 1 ');
});

test('a cold cache scans and stores, with an expiry so abandoned keys clean up', async (t) => {
  const c = cloud(t);
  assert.deepEqual(await ledgerRows(env, 'x', 'SELECT 1', [], { now }), [{ n: 'scanned' }]);
  assert.equal(c.seen.queries, 1);
  assert.match(c.seen.puts[0].url, /expiration_ttl=\d+/);
});

test('a result inside the fresh window is reused without touching D1', async (t) => {
  const c = await primed(t, 'x', 'SELECT 1', [], FRESH_HOURS - 0.5);
  assert.deepEqual(await ledgerRows(env, 'x', 'SELECT 1', [], { now }), [{ n: 'cached' }]);
  assert.equal(c.seen.queries, 0);
});

test('a new model version in the parameters never reads the old result', async (t) => {
  const c = await primed(t, 'x', 'SELECT 1', ['confluence-v9'], 1);
  assert.deepEqual(await ledgerRows(env, 'x', 'SELECT 1', ['confluence-v10'], { now }), [{ n: 'scanned' }]);
  assert.equal(c.seen.queries, 1);
});

test('a build rescans only its budget of stale results, serving the rest', async (t) => {
  const c = cloud(t);
  const names = Array.from({ length: RESCANS_PER_RUN + 3 }, (_, i) => `q${i}`);
  for (const n of names) await ledgerRows(env, n, `SELECT '${n}'`, [], { now });
  for (const key of [...c.store.keys()]) c.store.set(key, JSON.stringify({ computedAt: hoursAgo(FRESH_HOURS + 1), rows: [{ n: 'cached' }] }));
  c.seen.queries = 0;
  resetLedgerCacheRun();
  const got = [];
  for (const n of names) got.push((await ledgerRows(env, n, `SELECT '${n}'`, [], { now }))[0].n);
  assert.equal(c.seen.queries, RESCANS_PER_RUN, 'the scans must not stack in one build');
  assert.deepEqual(got, [...Array(RESCANS_PER_RUN).fill('scanned'), ...Array(3).fill('cached')]);
  assert.equal(ledgerCacheStatus().oldestHours, FRESH_HOURS + 1);
});

test('the same query twice in one build reads KV and D1 once (the post-evaluation reload)', async (t) => {
  const c = cloud(t);
  await ledgerRows(env, 'x', 'SELECT 1', [], { now });
  await ledgerRows(env, 'x', 'SELECT 1', [], { now });
  assert.equal(c.seen.queries, 1);
});

const noRetries = (fn) => async (t) => {
  // d1() waits out a 429 for about 95 s; a 400 throws at once and takes the same path.
  await fn(t, () => respond({ success: false, errors: [{ code: 7500, message: 'no such table' }] }, 400));
};

test('a failed scan serves the previous result and reports it', noRetries(async (t, fail) => {
  const c = await primed(t, 'x', 'SELECT 1', [], FRESH_HOURS + 1);
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (String(url).includes('/d1/')) return fail();
    const key = decodeURIComponent(String(url).split('/values/')[1].split('?')[0]);
    return respond(JSON.parse(c.store.get(key)));
  });
  assert.deepEqual(await ledgerRows(env, 'x', 'SELECT 1', [], { now }), [{ n: 'cached' }]);
  assert.deepEqual(ledgerCacheStatus().failed, ['x']);
}));

test('past the hard limit a failed scan surfaces instead of serving stale evidence', noRetries(async (t, fail) => {
  const c = await primed(t, 'x', 'SELECT 1', [], HARD_HOURS + 1);
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (String(url).includes('/d1/')) return fail();
    const key = decodeURIComponent(String(url).split('/values/')[1].split('?')[0]);
    return respond(JSON.parse(c.store.get(key)));
  });
  await assert.rejects(ledgerRows(env, 'x', 'SELECT 1', [], { now }), /no such table/);
}));

test('past the hard limit the budget does not apply: it must rescan', async (t) => {
  const c = await primed(t, 'x', 'SELECT 1', [], HARD_HOURS + 1);
  for (let i = 0; i < RESCANS_PER_RUN; i++) await ledgerRows(env, `used${i}`, `SELECT ${i}`, [], { now });
  c.seen.queries = 0;
  assert.deepEqual(await ledgerRows(env, 'x', 'SELECT 1', [], { now }), [{ n: 'scanned' }]);
  assert.equal(c.seen.queries, 1);
});

test('an unreadable KV degrades to scanning, and a failed write does not lose the rows', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async (url) => (String(url).includes('/d1/') ? d1Ok([{ n: 'scanned' }]) : respond(null, 500)));
  resetLedgerCacheRun();
  assert.deepEqual(await ledgerRows(env, 'x', 'SELECT 1', [], { now }), [{ n: 'scanned' }]);
});

test('chunked rows equal the single query, whatever the symbol looks like', async (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE technique_reliability (asset_class TEXT);
    CREATE TABLE forecast_outcomes (asset_class TEXT, symbol TEXT, series_key TEXT, correct INTEGER, run_at TEXT)`);
  const symbols = ['1INCH', '0G', 'A', 'AAPL', 'B', 'BTC', 'C', 'D', 'DOGE', 'F', 'G', 'K', 'L', 'NVDA', 'O', 'R', 'S', 'SOL', 'T', 'U', 'WIF', 'ZEC', 'a16z', 'zzz', '币安人生', '龙', '🐸'];
  const insert = db.prepare('INSERT INTO forecast_outcomes VALUES (?,?,?,?,?)');
  for (const cls of ['crypto', 'stock']) {
    db.prepare('INSERT INTO technique_reliability VALUES (?)').run(cls);
    symbols.forEach((sym, i) => { for (let k = 0; k < 7; k++) insert.run(cls, sym, k % 2 ? 'macd' : 'rsi', (i + k) % 2, `2026-10-${String(10 + k % 3).padStart(2, '0')}`); });
  }
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const { sql, params } = JSON.parse(options.body);
    return d1Ok(db.prepare(sql).all(...params));
  });
  const sql = `SELECT asset_class, symbol, series_key, SUM(correct) AS c, COUNT(*) AS n, COUNT(DISTINCT run_at) AS days
    FROM forecast_outcomes WHERE series_key != ? ${CHUNK_SLOT} GROUP BY asset_class, symbol, series_key`;
  const key = (r) => `${r.asset_class}|${r.symbol}|${r.series_key}`;
  const sort = (rows) => rows.map((r) => ({ ...r })).sort((a, b) => key(a).localeCompare(key(b)));
  const whole = db.prepare(sql.replace(CHUNK_SLOT, '')).all('none');
  const chunks = await chunkedScan(env, sql, ['none'], { pauseMs: 0 });
  assert.equal(whole.length, symbols.length * 2 * 2);
  assert.deepEqual(sort(chunks), sort(whole));
});
