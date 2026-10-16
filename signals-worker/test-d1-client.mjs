import test from 'node:test';
import assert from 'node:assert/strict';
import { d1, d1Batch, statementKind, safeToRepeat, upsertChangedSql } from './scripts/d1-client.mjs';

const noRetry = { retryDelaysMs: [] };

for (const [name, call] of [
  ['query', () => d1({}, 'SELECT 1', [], noRetry)],
  ['batch', () => d1Batch({}, [{ sql: 'SELECT 1' }], noRetry)]
]) {
  test(`${name}: the deadline covers a stalled response body`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let signal;
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      signal = options.signal;
      return { ok: true, status: 200, json: () => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }) };
    });
    const result = call();
    await Promise.resolve();
    await Promise.resolve();
    t.mock.timers.tick(30001);
    assert.equal(signal.aborted, true, 'headers arriving must not disable the body deadline');
    await assert.rejects(result, /D1 .*failed/);
  });

  test(`${name}: a successful response retains the existing shape`, async t => {
    t.mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200,
      json: async () => ({ success: true, result: [{ success: true, results: [{ n: 1 }] }] }) }));
    assert.deepEqual(await call(), name === 'query' ? [{ n: 1 }] : [[{ n: 1 }]]);
  });
}

// ---- retries: the failures that actually ended runs ---------------------------
// Each response below is copied from a failed Actions log (09-30..10-15).
const OK = { ok: true, status: 200, json: async () => ({ success: true, result: [{ success: true, results: [{ n: 1 }] }] }) };
const INTERNAL = { ok: false, status: 500, json: async () => ({ success: false,
  errors: [{ code: 7500, message: 'internal error; reference = e_PVSMDp_4c20b433946b47478767f4ce9d9ce21b' }] }) };
const SIZE_CEILING = { ok: false, status: 503, json: async () => ({ success: false, errors: [{ code: 7010, message: 'Service unavailable' }] }) };
const BAD_SQL = { ok: false, status: 400, json: async () => ({ success: false,
  errors: [{ code: 7500, message: 'near "SELEC": syntax error at offset 0: SQLITE_ERROR' }] }) };
const RATE_LIMITED = { ok: false, status: 429, json: async () => ({ success: false, errors: [{ code: 971, message: 'Please wait' }] }) };
const socketClosed = () => Object.assign(new TypeError('fetch failed'),
  { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) });
const refused = () => Object.assign(new TypeError('fetch failed'),
  { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
const timedOut = () => new DOMException('This operation was aborted', 'AbortError');

// Plays `script` in order (a response object, or a function that throws), then OK.
function serve(t, script) {
  let calls = 0;
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => {
    const step = script[calls++];
    if (typeof step === 'function') throw step();
    return step || OK;
  });
  return () => calls;
}
const fast = { retryDelaysMs: [0, 0, 0] };

const INCREMENT = `UPDATE research_registry SET status=?, oos_n=?, oos_checks=oos_checks+1,
  last_checked_at=? WHERE hypothesis=?`;
const RUN_LOG = 'INSERT INTO crash_recovery_runs (run_at, model_version) VALUES (?, ?)';

test('a 7500 internal error on a read is retried and the run carries on', async t => {
  const calls = serve(t, [INTERNAL]);
  assert.deepEqual(await d1({}, 'SELECT observed_at FROM microstructure_observations WHERE symbol = ?', ['BTC'], fast), [{ n: 1 }]);
  assert.equal(calls(), 2);
});

test('a socket closed mid-response is retried for a safe write', async t => {
  const calls = serve(t, [socketClosed]);
  await d1({}, 'INSERT OR REPLACE INTO microstructure_findings (hypothesis, updated_at) VALUES (?,?)', ['k', 'now'], fast);
  assert.equal(calls(), 2);
});

test('our own 30s timeout is retried for a read (Adaptive Research, 10-15)', async t => {
  const calls = serve(t, [timedOut]);
  await d1({}, 'SELECT asset_class, symbol, date, close FROM asset_daily_bars', [], fast);
  assert.equal(calls(), 2);
});

test('an ambiguous failure is NOT retried for a write that would count twice', async t => {
  for (const [sql, failure] of [[INCREMENT, INTERNAL], [RUN_LOG, socketClosed], [RUN_LOG, timedOut]]) {
    const calls = serve(t, [failure]);
    await assert.rejects(d1({}, sql, [], fast));
    assert.equal(calls(), 1, `${sql.slice(0, 30)}... must not be sent a second time`);
    t.mock.restoreAll();
  }
});

test('a request that never reached D1 is retried whatever it is', async t => {
  for (const failure of [RATE_LIMITED, refused]) {
    const calls = serve(t, [failure]);
    await d1({}, RUN_LOG, [], fast);
    assert.equal(calls(), 2);
    t.mock.restoreAll();
  }
});

test('deterministic failures are thrown at once, as before', async t => {
  for (const failure of [SIZE_CEILING, BAD_SQL]) {
    const calls = serve(t, [failure, failure, failure, failure]);
    await assert.rejects(d1({}, 'SELECT * FROM asset_daily_bars', [], fast), /D1 query failed: HTTP (503|400)/);
    assert.equal(calls(), 1);
    t.mock.restoreAll();
  }
});

test('a failure that never clears gives up after the last delay with the original error', async t => {
  const calls = serve(t, [INTERNAL, INTERNAL, INTERNAL, INTERNAL]);
  await assert.rejects(d1({}, 'SELECT 1', [], fast), /D1 query failed: HTTP 500 .*7500/);
  assert.equal(calls(), 4);
});

test('a batch of full-row replaces is retried; one that feeds itself is not', async t => {
  const replace = { sql: 'INSERT OR REPLACE INTO microstructure_observations (window_id, symbol) VALUES (?,?)', params: [1, 'BTC'] };
  let calls = serve(t, [INTERNAL]);
  assert.deepEqual(await d1Batch({}, [replace, replace], fast), [[{ n: 1 }]]);
  assert.equal(calls(), 2);
  t.mock.restoreAll();

  calls = serve(t, [INTERNAL]);
  await assert.rejects(d1Batch({}, [
    { sql: 'DELETE FROM t WHERE x = 1' }, { sql: 'UPDATE t SET x = 1 WHERE y = 2' }], fast));
  assert.equal(calls(), 1);
});

test('statementKind reads the statements this repo actually sends', () => {
  const cases = [
    ['SELECT symbol FROM t WHERE note = \'update me; delete\'', 'read'],
    ['WITH x AS (SELECT 1) SELECT * FROM x', 'read'],
    ['SELECT REPLACE(symbol, \'-\', \'\') FROM t', 'read'],
    ['SELECT updated_at FROM t', 'read'],
    ['INSERT OR REPLACE INTO t (a) VALUES (?)', 'set'],
    ['  insert or ignore into t (a) values (?)', 'set'],
    ['INSERT INTO t (a) VALUES (?) ON CONFLICT (a) DO NOTHING', 'set'],
    [upsertChangedSql('bars', ['symbol', 'date', 'close'], ['symbol', 'date'], 2), 'set'],
    ['CREATE INDEX IF NOT EXISTS i ON t (a)', 'set'],
    ["UPDATE research_registry SET status='decayed', status_changed_at=?, last_checked_at=?,\n notes=? WHERE hypothesis=?", 'update'],
    ['UPDATE research_registry SET last_checked_at=? WHERE hypothesis=?', 'update'],
    ['DELETE FROM asset_rotation_status', 'delete'],
    [INCREMENT, null],
    ['UPDATE r SET status=?, status_changed_at=CASE WHEN ?<>status THEN ? ELSE status_changed_at END WHERE h=?', null],
    ['INSERT INTO s (k, n) VALUES (?,?) ON CONFLICT (k) DO UPDATE SET n = n + excluded.n', null],
    [RUN_LOG, null],
    ['DELETE FROM t WHERE id = (SELECT MAX(id) FROM t)', null],
    ['INSERT OR REPLACE INTO c SELECT k, n + 1 FROM c', null],
    ['WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x', null],
    ['ALTER TABLE t ADD COLUMN a', null],
    ['-- comment\nSELECT 1', 'read'],
    ['/* note */ INSERT INTO t (a) VALUES (?)', null]
  ];
  for (const [sql, kind] of cases) assert.equal(statementKind(sql), kind, sql);
  assert.equal(safeToRepeat(['DELETE FROM t WHERE k = ?']), true, 'one delete on its own repeats safely');
  assert.equal(safeToRepeat(['DELETE FROM t WHERE k = ?', 'INSERT OR IGNORE INTO t (k) VALUES (?)']), false);
});
