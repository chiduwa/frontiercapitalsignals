import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deliverSurgeBatch, loadPushedBars, sendPush, surgeBarKey
} from './scripts/live-scan-delivery.mjs';

const push = { title: 'Offline regression', message: 'Synthetic test only', priority: 'high', tags: ['warning'] };
const firstAt = '2026-10-13T09:00:00.000Z';
const nextAt = '2026-10-13T10:00:00.000Z';
const hit = (symbol, at, config = 'exhaustion20') => ({ symbol, features: { at }, config: { id: config } });
const pending = h => ({ cfg: h.config, h });
const response = (status, headers) => new Response(null, { status, headers });

function memoryDb(initial = []) {
  const rows = initial.map(row => ({ ...row }));
  const writes = [];
  const query = async (_env, sql, params) => {
    if (/^SELECT/.test(sql)) return rows.filter(row => row.notified === 1 && params.includes(row.cast_at))
      .map(({ symbol, cast_at }) => ({ symbol, cast_at }));
    assert.match(sql, /^UPDATE surge_signal_log SET notified = 1/);
    const [config_id, symbol, cast_at] = params;
    writes.push({ config_id, symbol, cast_at });
    const row = rows.find(r => r.config_id === config_id && r.symbol === symbol && r.cast_at === cast_at);
    if (row) row.notified = 1;
    return [];
  };
  return { rows, writes, query };
}

test('HTTP rejection leaves the cast retryable; later acceptance suppresses only the delivered bar', async () => {
  const h = hit('A', firstAt);
  const db = memoryDb([{ config_id: h.config.id, symbol: 'A', cast_at: firstAt, notified: 0 }]);
  const statuses = [500, 200];
  const logs = [];
  const notify = async p => (await sendPush(p, {
    topic: 'test-only', fetchImpl: async () => response(statuses.shift()), log: x => logs.push(x)
  })).accepted;
  const options = { notify, query: db.query, env: {} };
  assert.equal(await deliverSurgeBatch([pending(h)], push, options), 0);
  assert.equal(db.writes.length, 0);
  assert.equal((await loadPushedBars([h], { query: db.query, env: {} })).size, 0);
  assert.equal(await deliverSurgeBatch([pending(h)], push, options), 1);
  const pushed = await loadPushedBars([h, hit('A', nextAt)], { query: db.query, env: {} });
  assert.equal(pushed.has(surgeBarKey('A', firstAt)), true);
  assert.equal(pushed.has(surgeBarKey('A', nextAt)), false);
  assert.deepEqual(db.writes, [{ config_id: 'exhaustion20', symbol: 'A', cast_at: firstAt }]);
  assert.deepEqual(logs.map(x => [x.outcome, x.status]), [['rejected', 500], ['accepted', 200]]);
});

test('mixed-hour scan retains the new bar even when another symbol is on an older hour', async () => {
  const db = memoryDb([{ config_id: 'exhaustion_calibrated', symbol: 'A', cast_at: firstAt, notified: 1 }]);
  const hits = [hit('A', nextAt), hit('B', firstAt), hit('A', firstAt)];
  const pushed = await loadPushedBars(hits, { env: {}, query: db.query });
  const kept = hits.filter(h => !pushed.has(surgeBarKey(h.symbol, h.features.at)));
  assert.deepEqual(kept.map(h => [h.symbol, h.features.at]), [['A', nextAt], ['B', firstAt]]);
  // Already sent under either rule means the same coin/bar is suppressed.
  assert.equal(pushed.has(surgeBarKey('A', firstAt)), true);
});

test('explicit transient rejection retries once, respecting a short Retry-After, then records acceptance', async () => {
  const h = hit('A', firstAt);
  const db = memoryDb([{ config_id: h.config.id, symbol: 'A', cast_at: firstAt, notified: 0 }]);
  const statuses = [429, 200], waits = [], logs = [], calls = [];
  const notify = async p => (await sendPush(p, {
    topic: 'test-only', sleep: async ms => waits.push(ms), log: x => logs.push(x),
    fetchImpl: async (url, request) => {
      assert.equal(db.writes.length, 0, 'do not write delivery before HTTP acceptance');
      calls.push({ url, request });
      return response(statuses.shift(), { 'Retry-After': '1' });
    }
  })).accepted;
  assert.equal(await deliverSurgeBatch([pending(h)], push, { notify, env: {}, query: db.query }), 1);
  assert.equal(calls.length, 2);
  assert.deepEqual(waits, [1000]);
  assert.equal(db.writes.length, 1);
  assert.equal(calls[0].request.body, push.message);
  assert.equal(calls[0].request.headers.Priority, 'high');
  assert.deepEqual(logs.map(x => x.outcome), ['rejected', 'accepted']);
});

test('retries are bounded and do not shorten a long Retry-After', async () => {
  const waits = [];
  let calls = 0;
  const repeated = await sendPush(push, {
    topic: 'test-only', sleep: async ms => waits.push(ms),
    fetchImpl: async () => { calls++; return response(503); }
  });
  assert.equal(calls, 2);
  assert.equal(repeated.accepted, false);
  assert.deepEqual(waits, [1000]);
  calls = 0;
  const deferred = await sendPush(push, {
    topic: 'test-only', sleep: async () => assert.fail('must defer a long retry delay'),
    fetchImpl: async () => { calls++; return response(429, { 'Retry-After': '3600' }); }
  });
  assert.equal(calls, 1);
  assert.equal(deferred.outcome, 'rejected');
});

test('HTTP-date Retry-After is respected and permanent rejection does not retry', async () => {
  const now = Date.parse('2026-10-13T10:00:00Z'), waits = [];
  let calls = 0;
  await sendPush(push, {
    topic: 'test-only', now: () => now, sleep: async ms => waits.push(ms),
    fetchImpl: async () => response(++calls === 1 ? 503 : 200, {
      'Retry-After': new Date(now + 2000).toUTCString()
    })
  });
  assert.deepEqual(waits, [2000]);
  calls = 0;
  const rejected = await sendPush(push, {
    topic: 'test-only', sleep: async () => assert.fail('401 must not retry'),
    fetchImpl: async () => { calls++; return response(401); }
  });
  assert.equal(calls, 1);
  assert.equal(rejected.accepted, false);
});

test('transport uncertainty never retries in the same call or writes delivered state', async () => {
  let calls = 0;
  const logs = [];
  const db = memoryDb();
  const notify = async p => (await sendPush(p, {
    topic: 'private-topic-must-not-be-logged', log: x => logs.push(x),
    fetchImpl: async () => { calls++; throw new Error('private-topic-must-not-be-logged'); },
    sleep: async () => assert.fail('unknown POST acceptance must not immediately retry')
  })).accepted;
  assert.equal(await deliverSurgeBatch([pending(hit('A', firstAt))], push, { notify, env: {}, query: db.query }), 0);
  assert.equal(calls, 1);
  assert.equal(db.writes.length, 0);
  assert.equal(logs[0].outcome, 'unconfirmed');
  assert.doesNotMatch(JSON.stringify(logs), /private-topic/);
});

test('timeout aborts the request and remains unconfirmed without an immediate retry', async () => {
  let calls = 0;
  const outcome = await sendPush(push, {
    topic: 'test-only', timeoutMs: 5,
    fetchImpl: async (_url, { signal }) => {
      calls++;
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    },
    sleep: async () => assert.fail('timeout may follow server acceptance')
  });
  assert.equal(calls, 1);
  assert.equal(outcome.reason, 'timeout');
  assert.equal(outcome.outcome, 'unconfirmed');
});

test('empty scans and disabled notification require no database or network mutation', async () => {
  const noQuery = async () => assert.fail('unexpected database access');
  assert.equal((await loadPushedBars([], { env: {}, query: noQuery })).size, 0);
  assert.equal(await deliverSurgeBatch([], push, { notify: noQuery, query: noQuery, env: {} }), 0);
  assert.equal((await sendPush(push, { fetchImpl: noQuery })).outcome, 'disabled');
});
