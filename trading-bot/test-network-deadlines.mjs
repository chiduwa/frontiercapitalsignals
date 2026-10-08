import test from 'node:test';
import assert from 'node:assert/strict';
for (const key of ['BINANCE_API_KEY', 'BINANCE_API_SECRET', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'FCS_D1_DATABASE_ID']) process.env[key] = 'test';
const { fetchSignals, fetchScalp } = await import('./src/signals.mjs');
const { getMarkPrice, getAccount, isExecutionOutcomeUnknown, placeMarketOrderReconciled } = await import('./src/binance.mjs');

for (const [name, call, bodyMethod] of [
  ['signals', fetchSignals, 'json'], ['scalp', fetchScalp, 'json'],
  ['public exchange data', () => getMarkPrice('BTCUSDT'), 'text'],
  ['signed exchange data', getAccount, 'text']
]) {
  test(`${name}: a stalled body aborts within the deadline`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let signal;
    t.mock.method(globalThis, 'fetch', async (_url, options = {}) => {
      signal = options.signal;
      return { ok: true, status: 200, [bodyMethod]: () => new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      }) };
    });
    const pending = call();
    const rejected = assert.rejects(pending, error => {
      if (name.includes('exchange')) assert.equal(isExecutionOutcomeUnknown(error), true);
      return true;
    });
    await Promise.resolve();
    await Promise.resolve();
    t.mock.timers.tick(20001);
    assert.equal(signal?.aborted, true);
    await rejected;
  });
}

test('a valid signals payload and exchange price retain their exact values', async t => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200,
    json: async () => ({ generated_at: 'saved', crypto: {} }), text: async () => '{"markPrice":"123.45"}' }));
  assert.deepEqual(await fetchSignals(), { generated_at: 'saved', crypto: {} });
  assert.deepEqual(await getMarkPrice('BTCUSDT'), { price: 123.45, fundingRate: null });
});

test('an accepted order with a stalled reply is reconciled, never submitted twice', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let posts = 0, reads = 0, bodyStarted;
  const started = new Promise(resolve => { bodyStarted = resolve; });
  const filled = { symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', status: 'FILLED',
    clientOrderId: 'fcs-test-stall', origQty: '0.001', executedQty: '0.001', reduceOnly: false };
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    if (init.method === 'POST') {
      posts++;
      return { ok: true, status: 200, text: () => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
        bodyStarted();
      }) };
    }
    reads++;
    return reads === 1
      ? { ok: false, status: 400, text: async () => '{"code":-2013,"msg":"Order does not exist"}' }
      : { ok: true, status: 200, text: async () => JSON.stringify(filled) };
  });
  const result = placeMarketOrderReconciled('BTCUSDT', 'BUY', 0.001, { clientOrderId: filled.clientOrderId });
  await started;
  t.mock.timers.tick(20001);
  assert.equal((await result).reconciled, true);
  assert.equal(posts, 1);
  assert.equal(reads, 2);
});
