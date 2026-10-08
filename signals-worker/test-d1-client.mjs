import test from 'node:test';
import assert from 'node:assert/strict';
import { d1, d1Batch } from './scripts/d1-client.mjs';

for (const [name, call] of [
  ['query', () => d1({}, 'SELECT 1')],
  ['batch', () => d1Batch({}, [{ sql: 'SELECT 1' }])]
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
