import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { loadMicrostructureRegistry, writeOosAssessment, writeProvisional } from './scripts/microstructure.mjs';
import { loadRegistry as loadDiscoveryRegistry } from './scripts/discovery.mjs';

const fast = { retryDelaysMs: [0, 0, 0] };
const key = 'micro:leadlag:SOL:binance:spot>okx:spot:lag3';
const discoveredAt = '2026-10-01T00:00:00.000Z';
const now = '2026-10-21T09:51:21.000Z';
const cell = { family: 'leadlag', symbol: 'SOL', leader: 'binance:spot', follower: 'okx:spot', lag: 3 };
const result = { windows: 80, pooled: { mean: .3, z: 5 } };
const oos = { n: 300, mean: .2, z: 4 };

// Real SQLite executes the production SQL. The first response can be lost
// before OR after its commit, which is precisely what an HTTP 500 cannot tell
// the caller. No network, credentials or notifications are used by these tests.
function database(t, { failAt = null, failCount = 1, httpStatus = 500 } = {}) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(readFileSync(new URL('./scripts/schema.sql', import.meta.url), 'utf8'));
  let writes = 0;
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const { sql, params = [] } = JSON.parse(init.body);
    const write = !/^\s*SELECT\b/i.test(sql);
    if (write) writes++;
    const fail = write && writes <= failCount && failAt;
    const rows = fail && failAt === 'before' ? [] : db.prepare(sql).all(...params);
    if (fail) return { ok: false, status: httpStatus, json: async () => ({ success: false,
      errors: [{ code: 7500, message: 'internal error; reference = test' }] }) };
    return { ok: true, status: 200, json: async () => ({ success: true, result: [{ success: true, results: rows }] }) };
  });
  return { db, writes: () => writes };
}

function seed(db, { hypothesis = key, family = 'microstructure:leadlag', status = 'provisional', changed = discoveredAt } = {}) {
  db.prepare(`INSERT INTO research_registry
    (hypothesis, family, symbol, status, discovered_at, discovery_n, discovery_effect, discovery_z,
     oos_checks, status_changed_at) VALUES (?, ?, 'SOL', ?, ?, 80, .3, 5, 7, ?)`)
    .run(hypothesis, family, status, discoveredAt, changed);
}
const stored = db => db.prepare('SELECT * FROM research_registry WHERE hypothesis = ?').get(key);

for (const failAt of ['before', 'after']) {
  test(`OOS assessment recovers from 7500 ${failAt} commit without double counting`, async t => {
    const { db, writes } = database(t, { failAt });
    seed(db);
    const prior = (await loadMicrostructureRegistry({})).get(key);
    await writeOosAssessment({}, key, prior, 'confirmed', oos, now, 'oos held', fast);
    assert.equal(writes(), 2, 'the failed D1 write must actually be retried');
    const row = stored(db);
    assert.equal(row.oos_checks, 8, 'one assessment despite two executions');
    assert.equal(row.status, 'confirmed');
    assert.equal(row.status_changed_at, now);
    assert.equal(row.last_checked_at, now);
    assert.equal(row.oos_n, 300);
    assert.equal(row.oos_effect, .2);
    assert.equal(row.oos_z, 4);
    assert.equal(row.discovered_at, discoveredAt);

    // A genuinely later evaluation still increments once, preserving the
    // transition timestamp when its status has not changed.
    const next = '2026-10-21T10:06:00.000Z';
    const updated = (await loadMicrostructureRegistry({})).get(key);
    await writeOosAssessment({}, key, updated, 'confirmed', oos, next, 'still held', fast);
    assert.equal(stored(db).oos_checks, 9);
    assert.equal(stored(db).status_changed_at, now);
    assert.equal(stored(db).last_checked_at, next);
    const latest = stored(db);
    await writeOosAssessment({}, key, prior, 'confirmed', oos, now, 'late old request', fast);
    assert.deepEqual(stored(db), latest, 'a delayed request must not overwrite a newer evaluation');
  });

  test(`new discovery recovers from 7500 ${failAt} commit without duplicating its key`, async t => {
    const { db, writes } = database(t, { failAt });
    await writeProvisional({}, key, cell, result, 240, now, 'new finding', fast);
    assert.equal(writes(), 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM research_registry').get().n, 1);
    assert.equal(stored(db).status, 'provisional');
    assert.equal(stored(db).discovered_at, now);
    assert.equal(stored(db).oos_checks, 0);
  });
}

for (const changed of [discoveredAt, null]) {
  test(`an unchanged status preserves its original ${changed === null ? 'null' : 'dated'} timestamp on retry`, async t => {
    const { db } = database(t, { failAt: 'after' });
    seed(db, { status: 'confirmed', changed });
    const prior = (await loadMicrostructureRegistry({})).get(key);
    await writeOosAssessment({}, key, prior, 'confirmed', { n: 1, mean: NaN, z: null }, now, 'insufficient', fast);
    assert.equal(stored(db).status_changed_at, changed);
    assert.equal(stored(db).oos_effect, null);
    assert.equal(stored(db).oos_z, null);
    assert.equal(stored(db).oos_checks, 8);
  });
}

test('retrying discovery cannot reset an existing lifecycle or delete its child findings', async t => {
  const { db } = database(t, { failAt: 'after' });
  seed(db, { status: 'confirmed' });
  db.prepare(`INSERT INTO microstructure_findings
    (hypothesis,symbol,family,leader,follower,lag_seconds,assumed_round_trip_cost_pct,decision_reason,updated_at)
    VALUES (?,'SOL','leadlag','binance:spot','okx:spot',3,.1,'below costs',?)`).run(key, discoveredAt);
  await writeProvisional({}, key, cell, result, 240, now, 'new finding', fast);
  assert.equal(stored(db).status, 'confirmed');
  assert.equal(stored(db).discovered_at, discoveredAt);
  assert.equal(stored(db).oos_checks, 7);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM microstructure_findings').get().n, 1);
});

test('a persistent outage fails visibly after bounded retries and never inflates the counter', async t => {
  const { db, writes } = database(t, { failAt: 'after', failCount: 4 });
  seed(db);
  const prior = (await loadMicrostructureRegistry({})).get(key);
  await assert.rejects(writeOosAssessment({}, key, prior, 'confirmed', oos, now, 'held', fast), /HTTP 500/);
  assert.equal(writes(), 4);
  assert.equal(stored(db).oos_checks, 8);
});

test('a permanent rejection is not hidden by retries', async t => {
  const { db, writes } = database(t, { failAt: 'before', httpStatus: 400 });
  seed(db);
  const prior = (await loadMicrostructureRegistry({})).get(key);
  await assert.rejects(writeOosAssessment({}, key, prior, 'confirmed', oos, now, 'held', fast), /HTTP 400/);
  assert.equal(writes(), 1);
  assert.equal(stored(db).oos_checks, 7);
});

test('daily discovery only assesses its own families; microstructure retains one serialized writer', async t => {
  const { db } = database(t);
  seed(db);
  const families = ['overnight-vs-intraday', 'day-of-week', 'turn-of-month', 'run-reversal', 'market-context'];
  for (const family of [...families, 'future-other-lane']) seed(db, { hypothesis: family, family });
  const rows = await loadDiscoveryRegistry();
  assert.deepEqual(rows.map(r => r.family).sort(), families.sort());
  assert.deepEqual([...(await loadMicrostructureRegistry({})).keys()], [key]);

  const workflow = readFileSync(new URL('../.github/workflows/signals-microstructure.yml', import.meta.url), 'utf8');
  assert.match(workflow, /concurrency:\s*\n\s+group: signals-microstructure\s*\n\s+cancel-in-progress: false/);
});
