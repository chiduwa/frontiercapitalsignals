import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { classifyOrder } from '../src/classify.mjs';
import { loadConfig } from '../src/config.mjs';
import {
  createBinanceClient, incrementIdentifier, normalizeAlgoExecutionOrder,
  normalizeAlgoState, normalizeOrder, normalizeTrade, parseBinanceJson, timeWindows
} from '../src/binance.mjs';
import {
  attachProvenance, loadAlgoExecutionOrders, loadPendingAlgoStates,
  markAlgoPolled, persistAlgoStates, persistJournalPage,
  reclassifyJournalFills, reclassifyStoredFill
} from '../src/store.mjs';
import {
  fetchFuturesAlgoOrders, mergeFuturesOrderProvenance, scanFuturesOrderWindow
} from '../src/index.mjs';

const baseEnv = {
  BINANCE_API_KEY: 'futures-key', BINANCE_API_SECRET: 'futures-secret',
  BINANCE_SPOT_API_KEY: 'spot-key', BINANCE_SPOT_API_SECRET: 'spot-secret',
  CLOUDFLARE_API_TOKEN: 'cf', CLOUDFLARE_ACCOUNT_ID: 'acct', FCS_D1_DATABASE_ID: 'db'
};

async function withLocalD1(database, action) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    try {
      if (Array.isArray(body.batch)) {
        database.exec('BEGIN');
        try {
          for (const statement of body.batch) {
            database.prepare(statement.sql).run(...(statement.params || []));
          }
          database.exec('COMMIT');
        } catch (error) {
          database.exec('ROLLBACK');
          throw error;
        }
        return { ok: true, status: 200, json: async () => ({
          success: true,
          result: body.batch.map(() => ({ success: true, results: [] }))
        }) };
      }
      const statement = database.prepare(body.sql);
      const isRead = /^\s*(SELECT|WITH|PRAGMA)\b/i.test(body.sql);
      const results = isRead
        ? statement.all(...(body.params || []))
        : (statement.run(...(body.params || [])), []);
      return { ok: true, status: 200, json: async () => ({
        success: true, result: [{ success: true, results }]
      }) };
    } catch (error) {
      return { ok: false, status: 500, json: async () => ({
        success: false, errors: [{ message: error.message }]
      }) };
    }
  };
  try { return await action(); }
  finally { globalThis.fetch = originalFetch; }
}

test('configuration defaults to the bot-reserved provenance prefixes and tracked symbols', () => {
  const config = loadConfig(baseEnv, Date.parse('2026-09-08T00:00:00Z'));
  assert.deepEqual(config.botPrefixes, ['fcsf-', 'fcss-']);
  assert.deepEqual(config.assistedPrefixes, ['fcsa-']);
  assert.ok(config.futures.configuredSymbols.includes('PEPEUSDT'));
  assert.ok(config.spot.configuredSymbols.includes('FILUSDT'));
  assert.equal(config.tradePageLimit, 1000);
  assert.equal(config.maxAlgoPollsPerSymbol, 25);
});

test('overlapping manual and bot prefixes are rejected', () => {
  assert.throws(() => loadConfig({
    ...baseEnv, JOURNAL_BOT_CLIENT_PREFIXES: 'fcs-', JOURNAL_MANUAL_CLIENT_PREFIXES: 'fcs-manual-'
  }), /must not overlap/);
});

test('classification requires affirmative provenance evidence', () => {
  const evidence = { overrides: new Map(), botOrderIds: new Set() };
  const config = {
    botPrefixes: ['fcsf-', 'fcss-'], assistedPrefixes: ['fcsa-'], manualPrefixes: ['mine-']
  };
  assert.equal(classifyOrder({ orderId: '1', clientOrderId: 'fcsf-entry-a' }, evidence, config).origin, 'bot');
  assert.equal(classifyOrder({ orderId: '2', clientOrderId: 'mine-discretionary' }, evidence, config).origin, 'manual');
  assert.equal(classifyOrder({ orderId: '3', clientOrderId: 'web-looking-but-undocumented' }, evidence, config).origin, 'unknown');
  assert.equal(classifyOrder({ orderId: '4', clientOrderId: null }, evidence, config).origin, 'unknown');
  const assisted = classifyOrder({ orderId: '5', clientOrderId: 'fcsa-emergency-stop' }, evidence, config);
  assert.equal(assisted.origin, 'unknown');
  assert.equal(assisted.method, 'bot_assisted_external_protection');
});

test('exact overrides and exact bot-ledger order IDs outrank prefixes', () => {
  const evidence = {
    overrides: new Map([['10', { origin: 'manual', note: 'reviewed' }]]),
    botOrderIds: new Set(['11'])
  };
  const config = { botPrefixes: [], manualPrefixes: [] };
  assert.equal(classifyOrder({ orderId: '10', clientOrderId: null }, evidence, config).origin, 'manual');
  assert.equal(classifyOrder({ orderId: '11', clientOrderId: null }, evidence, config).origin, 'bot');
});

test('normalizers preserve exchange facts and never synthesize spot PnL', () => {
  const at = '2026-09-08T00:00:01.000Z';
  const order = normalizeOrder('spot', {
    symbol: 'btcusdt', orderId: 8, clientOrderId: 'abc', side: 'BUY', type: 'MARKET',
    status: 'FILLED', time: 1788825600000, updateTime: 1788825601000
  }, at);
  assert.equal(order.symbol, 'BTCUSDT');
  assert.equal(order.clientOrderId, 'abc');
  const spot = normalizeTrade('spot', {
    symbol: 'BTCUSDT', id: 4, orderId: 8, price: '100', qty: '0.25', quoteQty: '25',
    commission: '0.01', commissionAsset: 'BNB', time: 1788825600000,
    isBuyer: true, isMaker: false, realizedPnl: '999'
  }, at);
  assert.equal(spot.side, 'BUY');
  assert.equal(spot.realizedPnl, null);
  assert.equal(spot.quoteQuantity, 25);
  const future = normalizeTrade('futures', {
    symbol: 'ETHUSDT', id: 5, orderId: 9, price: '2000', qty: '0.1', quoteQty: '200',
    commission: '0.', commissionAsset: 'USDT', realizedPnl: '-1.5',
    side: 'SELL', positionSide: 'BOTH', maker: true, time: 1788825600000
  }, at);
  assert.equal(future.realizedPnl, -1.5);
  assert.equal(future.isMaker, true);
});

test('algo history maps only a real triggered execution ID to its client provenance', () => {
  const at = '2026-09-08T00:00:01.000Z';
  const raw = {
    symbol: 'solusdt', algoId: 2146760, clientAlgoId: 'fcsf-tp-proof',
    actualOrderId: '987654321', side: 'SELL', orderType: 'TAKE_PROFIT_MARKET',
    actualType: 'MARKET', algoStatus: 'FINISHED', createTime: 1788825500000,
    updateTime: 1788825601000, triggerTime: 1788825600000
  };
  const state = normalizeAlgoState(raw, at);
  assert.equal(state.algoId, '2146760');
  assert.equal(state.actualOrderId, '987654321');
  assert.equal(state.clientAlgoId, 'fcsf-tp-proof');

  const order = normalizeAlgoExecutionOrder(raw, at);
  assert.equal(order.orderId, '987654321');
  assert.equal(order.clientOrderId, 'fcsf-tp-proof');
  assert.equal(order.orderType, 'MARKET');
  assert.equal(order.status, null);
  assert.equal(order.orderTime, '2026-09-08T00:00:00.000Z');

  assert.equal(normalizeAlgoExecutionOrder({ ...raw, actualOrderId: '' }, at), null);
  assert.equal(normalizeAlgoExecutionOrder({ ...raw, actualOrderId: '0' }, at), null);
  assert.equal(normalizeAlgoState({ ...raw, algoId: 'not-an-id' }, at), null);
});

test('algo provenance wins while standard execution facts remain authoritative', () => {
  const execution = normalizeOrder('futures', {
    symbol: 'SOLUSDT', orderId: '987654321', clientOrderId: 'system-child-id',
    side: 'SELL', type: 'MARKET', status: 'FILLED', time: 1788825600000
  }, '2026-09-08T00:00:01.000Z');
  const parent = normalizeAlgoExecutionOrder({
    symbol: 'SOLUSDT', algoId: '12', actualOrderId: '987654321',
    clientAlgoId: 'fcsf-stop-proof', side: 'SELL', orderType: 'STOP_MARKET',
    algoStatus: 'FINISHED', createTime: 1788825500000,
    updateTime: 1788825601000, triggerTime: 1788825600000
  }, '2026-09-08T00:00:01.000Z');
  const [merged] = mergeFuturesOrderProvenance([execution], [parent]);
  assert.equal(merged.clientOrderId, 'fcsf-stop-proof');
  assert.equal(merged.orderType, 'MARKET');
  assert.equal(merged.status, 'FILLED');
});

test('provenance attaches order client IDs without changing fill facts', () => {
  const fill = normalizeTrade('futures', {
    symbol: 'SOLUSDT', id: 7, orderId: 10, price: '100', qty: '2', quoteQty: '200',
    commission: '0.08', commissionAsset: 'USDT', realizedPnl: '4', side: 'SELL',
    positionSide: 'BOTH', maker: false, time: 1788825600000
  }, '2026-09-08T00:00:01.000Z');
  const order = normalizeOrder('futures', {
    symbol: 'SOLUSDT', orderId: 10, clientOrderId: 'fcsf-texit-x', side: 'SELL',
    type: 'MARKET', status: 'FILLED', time: 1788825600000
  }, '2026-09-08T00:00:01.000Z');
  const [result] = attachProvenance([fill], [order], {
    overrides: new Map(), botOrderIds: new Set()
  }, { botPrefixes: ['fcsf-'], manualPrefixes: [] });
  assert.equal(result.origin, 'bot');
  assert.equal(result.realizedPnl, 4);
  assert.equal(result.clientOrderId, 'fcsf-texit-x');
});

test('stored fills are reclassified when later order evidence or overrides arrive', () => {
  const prior = {
    market: 'futures', symbol: 'SOLUSDT', tradeId: '7', orderId: '10',
    clientOrderId: null, orderClientOrderId: 'fcsf-tp-late', origin: 'unknown',
    classificationMethod: 'client_order_id_unavailable',
    classificationEvidence: 'no durable client order ID or exact ownership evidence is available'
  };
  const config = {
    botPrefixes: ['fcsf-'], assistedPrefixes: ['fcsa-'], manualPrefixes: []
  };
  const evidence = { overrides: new Map(), botOrderIds: new Set() };
  const update = reclassifyStoredFill(prior, evidence, config);
  assert.equal(update.clientOrderId, 'fcsf-tp-late');
  assert.equal(update.origin, 'bot');
  assert.equal(update.classificationMethod, 'client_order_prefix');

  const manual = reclassifyStoredFill({
    ...prior,
    clientOrderId: 'fcsf-tp-late',
    origin: 'bot',
    classificationMethod: 'client_order_prefix',
    classificationEvidence: 'reserved bot prefix: fcsf-'
  }, {
    overrides: new Map([['10', { origin: 'manual', note: 'operator reviewed' }]]),
    botOrderIds: new Set()
  }, config);
  assert.equal(manual.origin, 'manual');
  assert.equal(manual.classificationMethod, 'explicit_override');
  assert.equal(manual.classificationEvidence, 'operator reviewed');
});

test('durable algo polling and post-ingest reclassification update historical fills', async () => {
  const database = new DatabaseSync(':memory:');
  database.exec(readFileSync(new URL(
    '../../signals-worker/migrations/0021_manual_trade_journal.sql', import.meta.url
  ), 'utf8'));
  database.exec(readFileSync(new URL(
    '../../signals-worker/migrations/0027_account_journal_algo_state.sql', import.meta.url
  ), 'utf8'));
  const config = {
    cloudflare: {
      CLOUDFLARE_API_TOKEN: 'test', CLOUDFLARE_ACCOUNT_ID: 'test', FCS_D1_DATABASE_ID: 'test'
    },
    botPrefixes: ['fcsf-'], assistedPrefixes: ['fcsa-'], manualPrefixes: []
  };
  const ingestedAt = '2026-09-08T00:00:01.000Z';

  await withLocalD1(database, async () => {
    const pendingState = normalizeAlgoState({
      symbol: 'SOLUSDT', algoId: '11', clientAlgoId: 'fcsf-stop-pending',
      actualOrderId: '', side: 'SELL', orderType: 'STOP_MARKET',
      algoStatus: 'NEW', createTime: 1788825500000, updateTime: 1788825500000,
      triggerTime: 0
    }, ingestedAt);
    await persistAlgoStates(config, [pendingState]);
    assert.equal((await loadPendingAlgoStates(config, 'SOLUSDT', 25)).length, 1);
    await markAlgoPolled(config, 'SOLUSDT', '11', ingestedAt, true);
    assert.equal((await loadPendingAlgoStates(config, 'SOLUSDT', 25)).length, 0);

    const triggeredState = normalizeAlgoState({
      symbol: 'SOLUSDT', algoId: '12', clientAlgoId: 'fcsf-tp-durable',
      actualOrderId: '987654321', side: 'SELL', orderType: 'TAKE_PROFIT_MARKET',
      algoStatus: 'FINISHED', createTime: 1788825500000,
      updateTime: 1788825601000, triggerTime: 1788825600000
    }, ingestedAt);
    await persistAlgoStates(config, [triggeredState], ingestedAt);
    const [mappedOrder] = await loadAlgoExecutionOrders(config, 'SOLUSDT', ingestedAt);
    await persistJournalPage(config, {
      market: 'futures', symbol: 'SOLUSDT', orders: [mappedOrder], stream: 'orders',
      cursorTimeMs: 1788825601000, updatedAt: ingestedAt
    });
    // A later standard-order refresh may expose Binance's child execution ID
    // rather than the parent clientAlgoId. Durable algo state must still win.
    database.prepare(`UPDATE account_journal_orders SET client_order_id = 'system-child-id'
      WHERE market = 'futures' AND symbol = 'SOLUSDT' AND order_id = '987654321'`).run();

    database.prepare(`INSERT INTO account_journal_fills
      (market, symbol, trade_id, order_id, event_time, side, price, quantity,
       origin, classification_method, ingested_at)
      VALUES ('futures', 'SOLUSDT', '7', '987654321', ?, 'SELL', 100, 2,
              'unknown', 'client_order_id_unavailable', ?)`).run(ingestedAt, ingestedAt);

    assert.deepEqual(await reclassifyJournalFills(config), {
      rowsChecked: 1, rowsUpdated: 1
    });
    let fill = database.prepare(`SELECT client_order_id, origin, classification_method
      FROM account_journal_fills WHERE trade_id = '7'`).get();
    assert.equal(fill.client_order_id, 'fcsf-tp-durable');
    assert.equal(fill.origin, 'bot');
    assert.equal(fill.classification_method, 'client_order_prefix');

    database.prepare(`INSERT INTO account_journal_origin_overrides
      (market, symbol, order_id, origin, note, set_at)
      VALUES ('futures', 'SOLUSDT', '987654321', 'manual', 'reviewed owner', ?)`)
      .run(ingestedAt);
    assert.deepEqual(await reclassifyJournalFills(config), {
      rowsChecked: 1, rowsUpdated: 1
    });
    fill = database.prepare(`SELECT origin, classification_method, classification_evidence
      FROM account_journal_fills WHERE trade_id = '7'`).get();
    assert.equal(fill.origin, 'manual');
    assert.equal(fill.classification_method, 'explicit_override');
    assert.equal(fill.classification_evidence, 'reviewed owner');
  });
  database.close();
});

test('futures algo importer follows a newly discovered parent to its execution order', async () => {
  const database = new DatabaseSync(':memory:');
  database.exec(readFileSync(new URL(
    '../../signals-worker/migrations/0021_manual_trade_journal.sql', import.meta.url
  ), 'utf8'));
  database.exec(readFileSync(new URL(
    '../../signals-worker/migrations/0027_account_journal_algo_state.sql', import.meta.url
  ), 'utf8'));
  const nowMs = Date.parse('2026-09-08T00:00:01.000Z');
  const config = {
    cloudflare: {
      CLOUDFLARE_API_TOKEN: 'test', CLOUDFLARE_ACCOUNT_ID: 'test', FCS_D1_DATABASE_ID: 'test'
    },
    backfillStartMs: nowMs - 1000,
    timeOverlapMs: 300_000,
    maxOrderPages: 20,
    orderPageLimit: 1000,
    maxAlgoPollsPerSymbol: 25
  };
  const calls = [];
  const base = {
    symbol: 'SOLUSDT', algoId: 12, clientAlgoId: 'fcsf-tp-followed',
    actualOrderId: '', side: 'SELL', orderType: 'TAKE_PROFIT_MARKET',
    algoStatus: 'NEW', createTime: nowMs - 500, updateTime: nowMs - 500,
    triggerTime: 0
  };
  const client = {
    signedGet: async (path, params) => {
      calls.push({ path, params });
      if (path === '/fapi/v1/allAlgoOrders') return [base];
      if (path === '/fapi/v1/algoOrder') return {
        ...base,
        actualOrderId: '987654321',
        actualType: 'MARKET',
        algoStatus: 'FINISHED',
        updateTime: nowMs,
        triggerTime: nowMs
      };
      throw new Error(`unexpected path ${path}`);
    }
  };

  await withLocalD1(database, async () => {
    const result = await fetchFuturesAlgoOrders(
      config, client, 'SOLUSDT', nowMs, new Date(nowMs).toISOString()
    );
    assert.equal(result.pages, 2);
    assert.equal(result.orders.length, 1);
    assert.equal(result.orders[0].orderId, '987654321');
    assert.equal(result.orders[0].clientOrderId, 'fcsf-tp-followed');
    assert.equal(result.orders[0].orderType, 'MARKET');
    assert.deepEqual(calls.map((call) => call.path), [
      '/fapi/v1/allAlgoOrders', '/fapi/v1/algoOrder'
    ]);
    assert.equal(calls[0].params.symbol, 'SOLUSDT');
    assert.equal(calls[1].params.clientAlgoId, 'fcsf-tp-followed');
    const stored = database.prepare(`SELECT actual_order_id, algo_status
      FROM account_journal_futures_algos WHERE symbol = 'SOLUSDT' AND algo_id = '12'`).get();
    assert.equal(stored.actual_order_id, '987654321');
    assert.equal(stored.algo_status, 'FINISHED');
  });
  database.close();
});

test('identifier increment is exact beyond Number safe integer range', () => {
  assert.equal(incrementIdentifier('9007199254740995'), '9007199254740996');
  assert.throws(() => incrementIdentifier('not-an-id'), /invalid Binance identifier/);
});

test('Binance JSON parsing preserves numeric identifier lexemes beyond Number range', () => {
  const [row] = parseBinanceJson(`[{"symbol":"PEPEUSDT","id":9007199254740993123,
    "orderId":1806822347416039490,"algoId":1806822347416039491,
    "actualOrderId":1806822347416039492,"orderListId":1806822347416039493,
    "clientOrderId":"fcsf-entry-exact","time":1788825600000,
    "price":0.00001234,"safeInteger":9007199254740991,
    "unsafeInteger":9007199254740992,"isBuyer":true}]`);
  assert.equal(row.id, '9007199254740993123');
  assert.equal(row.orderId, '1806822347416039490');
  assert.equal(row.algoId, '1806822347416039491');
  assert.equal(row.actualOrderId, '1806822347416039492');
  assert.equal(row.orderListId, '1806822347416039493');
  assert.equal(row.clientOrderId, 'fcsf-entry-exact');
  assert.equal(row.time, 1788825600000);
  assert.equal(row.price, 0.00001234);
  assert.equal(row.safeInteger, 9007199254740991);
  assert.equal(row.unsafeInteger, '9007199254740992');
  assert.equal(row.isBuyer, true);
});

test('adjacent 19-digit Binance order IDs remain distinct after response parsing', () => {
  const rows = parseBinanceJson('[{"orderId":8389766206455564000},{"orderId":8389766206455564001}]');
  assert.deepEqual(rows.map((row) => row.orderId), [
    '8389766206455564000',
    '8389766206455564001'
  ]);
  assert.equal(new Set(rows.map((row) => row.orderId)).size, 2);
});

test('time windows cover the interval once and respect the API width', () => {
  assert.deepEqual(timeWindows(0, 10, 4), [
    { start: 0, end: 3 }, { start: 4, end: 7 }, { start: 8, end: 10 }
  ]);
});

test('saturated account-wide futures order windows are narrowed until complete', async () => {
  const events = Array.from({ length: 30 }, (_, id) => ({ id, time: Math.floor(id / 3) }));
  const budget = { remaining: 100 };
  const result = await scanFuturesOrderWindow(
    async (start, end) => events.filter((row) => row.time >= start && row.time <= end).slice(0, 10),
    0, 9, budget, 10
  );
  assert.equal(result.complete, true);
  assert.equal(result.through, 9);
  assert.deepEqual(result.rows.map((row) => row.id).sort((a, b) => a - b), events.map((row) => row.id));
  assert.ok(budget.remaining < 100);
});

test('order discovery leaves an unread saturated suffix uncheckpointed when bounded', async () => {
  const budget = { remaining: 1 };
  const result = await scanFuturesOrderWindow(
    async () => Array.from({ length: 10 }, (_, id) => ({ id })),
    100, 200, budget, 10
  );
  assert.equal(result.complete, false);
  assert.ok(result.through < 100);
  assert.deepEqual(result.rows, []);
});

test('signed client sends a signature and never puts the API secret in the URL', async () => {
  let seen;
  const client = createBinanceClient({
    key: 'key', secret: 'do-not-leak', base: 'https://example.test',
    fetchImpl: async (url, options) => {
      seen = { url: String(url), options };
      return { ok: true, status: 200, text: async () => '[]' };
    }
  });
  await client.signedGet('/api/v3/myTrades', { symbol: 'BTCUSDT' });
  assert.match(seen.url, /signature=[0-9a-f]{64}/);
  assert.doesNotMatch(seen.url, /do-not-leak/);
  assert.equal(seen.options.headers['X-MBX-APIKEY'], 'key');
});

test('signed client returns exact futures and spot IDs from raw response JSON', async () => {
  const client = createBinanceClient({
    key: 'key', secret: 'secret', base: 'https://example.test',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => '[{"id":1806822347416039494,"orderId":1806822347416039495}]'
    })
  });
  const [row] = await client.signedGet('/fapi/v1/userTrades', { symbol: 'PEPEUSDT' });
  assert.deepEqual(row, {
    id: '1806822347416039494',
    orderId: '1806822347416039495'
  });
});
