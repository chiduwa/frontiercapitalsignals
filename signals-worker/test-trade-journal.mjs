import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  constantTimeCredentialEqual, dispatchTradeJournalAlerts,
  handleTradeJournalRequest, isTradeJournalRequestAuthorized, loadTradeJournal,
  loadTradeJournalDeliveryStatus, parseRetryAfterMs, parseTradeJournalQuery
} from './trade-journal.js';

class MockStatement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.params = []; }
  bind(...params) { this.params = params; return this; }
  async all() {
    this.db.activeReads++;
    this.db.maxConcurrentReads = Math.max(this.db.maxConcurrentReads, this.db.activeReads);
    await Promise.resolve();
    try { return { results: this.db.query(this.sql, this.params) }; }
    finally { this.db.activeReads--; }
  }
}

class MockDb {
  constructor() {
    this.reads = 0;
    this.activeReads = 0;
    this.maxConcurrentReads = 0;
    this.queries = [];
    this.notificationRows = null;
    this.notificationParams = null;
  }
  prepare(sql) { return new MockStatement(this, sql); }
  query(sql, params = []) {
    this.reads++;
    this.queries.push({ sql, params });
    if (sql.includes('MAX(rowid)')) {
      this.notificationParams = params;
      return this.notificationRows || [{
        fill_count: 0, manual_count: 0, unknown_count: 0,
        futures_realized_pnl: null, symbols: null, max_ingested_at: null,
        max_rowid: null
      }];
    }
    if (sql.includes('COUNT(*) AS n FROM account_journal_fills')) return [{ n: 1 }];
    if (sql.includes('FROM account_journal_current_positions')) return [{
      symbol: 'PEPEUSDT', position_side: 'BOTH', side: 'BUY', position_amt: 1000,
      quantity: 1000, entry_price: 0.00001, break_even_price: 0.0000101,
      mark_price: 0.000011, unrealized_pnl: 0.001, liquidation_price: 0.000005,
      leverage: 5, margin_type: 'cross', isolated_margin: 0, notional: 0.011,
      origin: 'unknown', classification_method: 'no_exact_bot_position_ownership',
      classification_evidence: 'no durable bot row', observed_at: '2026-09-09T00:00:00Z'
    }];
    if (sql.includes('GROUP BY market, origin')) return [{
      market: 'futures', origin: 'unknown', fill_count: 2, order_count: 1,
      symbol_count: 1, first_fill_at: '2026-09-08T00:00:00Z',
      last_fill_at: '2026-09-08T00:01:00Z', buy_quote_quantity: 10,
      sell_quote_quantity: 12, realized_pnl: 1.25
    }];
    if (sql.includes('GROUP BY substr(event_time')) return [];
    if (sql.includes('FROM account_journal_fills WHERE')) return [{
      market: 'futures', symbol: 'PEPEUSDT', trade_id: '1', order_id: '2',
      client_order_id: 'web,order', event_time: '2026-09-08T00:01:00Z',
      side: 'SELL', position_side: 'BOTH', price: 0.0000123, quantity: 1000,
      quote_quantity: 0.0123, realized_pnl: 1.25, commission: 0.01,
      commission_asset: 'USDT', is_maker: 0, origin: 'unknown',
      classification_method: 'no_provenance_match',
      classification_evidence: 'no documented origin field'
    }];
    if (sql.includes('account_journal_review_queue')) return [{ n: 2 }];
    if (sql.includes('account_journal_runs')) return [{
      run_id: 'r1', started_at: '2026-09-08T00:00:00Z', completed_at: '2026-09-08T00:02:00Z',
      status: 'ok', markets_requested: 2, symbols_requested: 9,
      fills_seen: 2, pages_read: 9, error_count: 0, error_summary: null
    }];
    throw new Error(`unexpected SQL: ${sql}`);
  }
}

class SqliteStatement {
  constructor(database, sql) { this.database = database; this.sql = sql; this.params = []; }
  bind(...params) { this.params = params; return this; }
  async all() { return { results: this.database.prepare(this.sql).all(...this.params) }; }
}

class SqliteD1 {
  constructor(database) { this.database = database; }
  prepare(sql) { return new SqliteStatement(this.database, sql); }
}

function populatedJournalDatabase() {
  const database = new DatabaseSync(':memory:');
  database.exec(readFileSync(new URL(
    './migrations/0021_manual_trade_journal.sql', import.meta.url
  ), 'utf8'));
  database.exec(readFileSync(new URL(
    './migrations/0028_account_journal_query_indexes.sql', import.meta.url
  ), 'utf8'));
  database.exec(readFileSync(new URL(
    './migrations/0031_account_journal_position_snapshots.sql', import.meta.url
  ), 'utf8'));
  const orders = [
    ['spot', 'PEPEUSDT', 's1'],
    ['futures', 'PEPEUSDT', 'f1'],
    ['futures', 'FILUSDT', 'f2'],
    ['futures', 'PEPEUSDT', 'f3']
  ];
  const order = database.prepare(`INSERT INTO account_journal_orders
    (market, symbol, order_id, ingested_at) VALUES (?, ?, ?, '2026-09-09T00:00:00.000Z')`);
  for (const row of orders) order.run(...row);
  const fill = database.prepare(`INSERT INTO account_journal_fills
    (market, symbol, trade_id, order_id, event_time, side, position_side,
     price, quantity, quote_quantity, realized_pnl, commission,
     commission_asset, origin, classification_method, ingested_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'test', '2026-09-09T00:00:00.000Z')`);
  fill.run('spot', 'PEPEUSDT', '1', 's1', '2026-09-06T10:00:00.000Z', 'BUY', null,
    0.00001, 1000, 0.01, null, 0.000001, 'BNB', 'manual');
  fill.run('futures', 'PEPEUSDT', '2', 'f1', '2026-09-07T10:00:00.000Z', 'SELL', 'BOTH',
    0.000012, 1000, 0.012, 2.5, 0.00001, 'USDT', 'manual');
  fill.run('futures', 'FILUSDT', '3', 'f2', '2026-09-08T10:00:00.000Z', 'SELL', 'BOTH',
    2.1, 2, 4.2, -1.25, 0.002, 'USDT', 'bot');
  fill.run('futures', 'PEPEUSDT', '4', 'f3', '2026-09-09T10:00:00.000Z', 'SELL', 'BOTH',
    0.000013, 1000, 0.013, 0, 0.00001, 'USDT', 'manual');
  return database;
}

class MockKv {
  constructor(value = null) { this.value = value; this.puts = []; }
  async get() { return this.value; }
  async put(key, value) { this.puts.push({ key, value }); this.value = value; }
}

test('credential comparison and both supported authorization schemes work', async () => {
  assert.equal(await constantTimeCredentialEqual('secret', 'secret'), true);
  assert.equal(await constantTimeCredentialEqual('secret', 'different'), false);
  const env = { TRADE_JOURNAL_TOKEN: 'secret' };
  assert.equal(await isTradeJournalRequestAuthorized(new Request('https://x/signals/trades', {
    headers: { Authorization: 'Bearer secret' }
  }), env), true);
  assert.equal(await isTradeJournalRequestAuthorized(new Request('https://x/signals/trades', {
    headers: { Authorization: `Basic ${btoa('fcs:secret')}` }
  }), env), true);
  assert.equal(await isTradeJournalRequestAuthorized(new Request('https://x/signals/trades', {
    headers: { Authorization: `Basic ${btoa('someone:secret')}` }
  }), env), false);
});

test('unauthorized requests perform no database query and are never cacheable', async () => {
  const db = new MockDb();
  const request = new Request('https://x/signals/trades');
  const response = await handleTradeJournalRequest(request, {
    TRADE_JOURNAL_TOKEN: 'secret', FCS_DB: db
  }, new URL(request.url));
  assert.equal(response.status, 401);
  assert.equal(db.reads, 0);
  assert.match(response.headers.get('www-authenticate'), /Basic/);
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
});

test('journal data keeps bot/manual/unknown definitions and spot caveat explicit', async () => {
  const db = new MockDb();
  const data = await loadTradeJournal(
    { FCS_DB: db },
    new URL('https://x/signals/api/trades?origin=external&days=14'),
    Date.parse('2026-09-09T12:00:00.000Z')
  );
  assert.equal(data.selection, 'external');
  assert.equal(data.days, 14);
  assert.equal(data.reviewCount, 2);
  assert.equal(data.coverage.retentionPolicy, 'no-automatic-expiry');
  assert.deepEqual(data.alertDelivery, {
    configured: false, state: 'disabled', lastSentAt: null
  });
  assert.match(data.definitions.unknown, /never presumed manual/);
  assert.match(data.definitions.spotPnl, /do not supply realized P&L/);
  assert.match(data.definitions.pnlFilter, /futures fills/);
  assert.match(db.queries[0].sql, /COUNT\(\*\) AS n FROM account_journal_fills/);
  // One sequential current-position read plus the existing count and
  // six-query historical analytics fanout.
  assert.equal(db.reads, 8);
  assert.equal(db.maxConcurrentReads, 6);

  const request = new Request('https://x/signals/trades?origin=external&days=14', {
    headers: { Authorization: 'Bearer secret' }
  });
  const response = await handleTradeJournalRequest(request, {
    TRADE_JOURNAL_TOKEN: 'secret', FCS_DB: new MockDb()
  }, new URL(request.url), 'html');
  assert.match(await response.text(), /name="days" value="14"/);
});

test('period presets, side=all, and UTC custom dates are parsed deterministically', () => {
  const now = Date.parse('2026-09-09T12:00:00.000Z');
  const week = parseTradeJournalQuery(new URL(
    'https://x/signals/api/trades?period=week&side=all'
  ), now);
  assert.equal(week.side, 'all');
  assert.equal(week.fromTime, '2026-09-02T12:00:00.000Z');
  assert.equal(parseTradeJournalQuery(new URL(
    'https://x/signals/api/trades?period=month'
  ), now).rollingDays, 30);
  assert.equal(parseTradeJournalQuery(new URL(
    'https://x/signals/api/trades?period=year'
  ), now).rollingDays, 365);
  assert.equal(parseTradeJournalQuery(new URL(
    'https://x/signals/api/trades?period=all'
  ), now).fromTime, null);

  const custom = parseTradeJournalQuery(new URL(
    'https://x/signals/api/trades?period=custom&from=2026-09-01&to=2026-09-08'
  ), now);
  assert.equal(custom.fromTime, '2026-09-01T00:00:00.000Z');
  assert.equal(custom.toExclusive, '2026-09-09T00:00:00.000Z');
});

test('combined filters and P&L use only Binance-reported futures values', async () => {
  const database = populatedJournalDatabase();
  try {
    const data = await loadTradeJournal({ FCS_DB: new SqliteD1(database) }, new URL(
      'https://x/signals/api/trades?period=custom&from=2026-09-01&to=2026-09-08' +
      '&symbol=pepeusdt&market=futures&origin=manual&side=sell&pnl=win' +
      '&min_pnl=1&max_pnl=3&sort=pnl&direction=asc&page=1&page_size=1'
    ), Date.parse('2026-09-09T12:00:00.000Z'));
    assert.equal(data.pagination.totalRows, 1);
    assert.equal(data.fills.length, 1);
    assert.equal(data.fills[0].trade_id, '2');
    assert.equal(data.fills[0].realized_pnl, 2.5);
    assert.equal(data.filters.symbol, 'PEPEUSDT');
    assert.equal(data.daily[0].realized_pnl, 2.5);
    assert.equal(data.fees[0].commission_asset, 'USDT');

    const spot = await loadTradeJournal({ FCS_DB: new SqliteD1(database) }, new URL(
      'https://x/signals/api/trades?period=all&market=spot&origin=all'
    ), Date.parse('2026-09-09T12:00:00.000Z'));
    assert.equal(spot.fills[0].realized_pnl, null);
    assert.equal(spot.origins[0].realized_pnl, null);
    assert.equal(spot.daily[0].realized_pnl, null);
  } finally { database.close(); }
});

test('pagination is stable, bounded, and rejects an offset beyond the result set', async () => {
  const database = populatedJournalDatabase();
  try {
    const page = await loadTradeJournal({ FCS_DB: new SqliteD1(database) }, new URL(
      'https://x/signals/api/trades?period=all&origin=all&sort=time&direction=desc&page=2&page_size=1'
    ), Date.parse('2026-09-09T12:00:00.000Z'));
    assert.equal(page.pagination.totalRows, 4);
    assert.equal(page.pagination.totalPages, 4);
    assert.equal(page.fills[0].trade_id, '3');
    await assert.rejects(() => loadTradeJournal({ FCS_DB: new SqliteD1(database) }, new URL(
      'https://x/signals/api/trades?period=all&origin=all&page=5&page_size=1'
    )), /page exceeds last page/);
  } finally { database.close(); }
});

test('invalid sort, date, and pagination inputs are rejected before an unsafe query', async () => {
  const cases = [
    'sort=event_time%20DESC%3BDELETE%20FROM%20account_journal_fills',
    'from=2026-02-31',
    'to=9999-12-31',
    'page=10001',
    'min_pnl=2&max_pnl=1'
  ];
  for (const query of cases) {
    const db = new MockDb();
    const request = new Request(`https://x/signals/trades?${query}`, {
      headers: { Authorization: 'Bearer secret' }
    });
    const response = await handleTradeJournalRequest(request, {
      TRADE_JOURNAL_TOKEN: 'secret', FCS_DB: db
    }, new URL(request.url), 'json');
    assert.equal(response.status, 400);
    assert.equal(db.reads, 0);
  }
});

test('query indexes provide symbol/time and reported-P&L access paths', () => {
  const database = populatedJournalDatabase();
  try {
    const symbolPlan = database.prepare(`EXPLAIN QUERY PLAN
      SELECT trade_id FROM account_journal_fills
      WHERE symbol = ? AND event_time >= ? ORDER BY event_time DESC LIMIT 100`)
      .all('PEPEUSDT', '2026-09-01T00:00:00.000Z');
    assert.match(symbolPlan.map((row) => row.detail).join(' '), /idx_account_journal_fills_symbol_time/);
    const pnlPlan = database.prepare(`EXPLAIN QUERY PLAN
      SELECT trade_id FROM account_journal_fills INDEXED BY idx_account_journal_fills_reported_pnl
      WHERE market = 'futures' AND realized_pnl IS NOT NULL AND realized_pnl > 0
      ORDER BY realized_pnl DESC LIMIT 100`).all();
    assert.match(pnlPlan.map((row) => row.detail).join(' '), /idx_account_journal_fills_reported_pnl/);
  } finally { database.close(); }
});

test('authenticated HTML and CSV responses are private and escaped/quoted', async () => {
  const env = { TRADE_JOURNAL_TOKEN: 'secret', FCS_DB: new MockDb() };
  const htmlRequest = new Request('https://x/signals/trades', { headers: { Authorization: 'Bearer secret' } });
  const html = await handleTradeJournalRequest(htmlRequest, env, new URL(htmlRequest.url), 'html');
  assert.equal(html.status, 200);
  const body = await html.text();
  assert.match(body, /Unknown.*does not mean manual/s);
  assert.match(body, /name="symbol"/);
  assert.match(body, /Download this CSV page/);
  assert.match(body, /never deletes raw fills/);
  assert.match(html.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(html.headers.get('content-security-policy'), /form-action 'self'/);
  assert.equal(html.headers.get('access-control-allow-origin'), null);

  const csvRequest = new Request('https://x/signals/api/trades.csv', { headers: { Authorization: 'Bearer secret' } });
  const csv = await handleTradeJournalRequest(csvRequest, env, new URL(csvRequest.url), 'csv');
  assert.match(await csv.text(), /"web,order"/);
  assert.match(csv.headers.get('content-disposition'), /attachment/);
});

test('CSV neutralizes untrusted spreadsheet formulas without changing numeric losses', async () => {
  const db = new MockDb();
  const originalQuery = db.query.bind(db);
  db.query = (sql, params) => {
    const rows = originalQuery(sql, params);
    if (sql.includes('client_order_id') && sql.includes('FROM account_journal_fills WHERE')) {
      rows[0].client_order_id = '=HYPERLINK("https://example.invalid")';
      rows[0].classification_evidence = '+cmd';
      rows[0].realized_pnl = -2.5;
    }
    return rows;
  };
  const request = new Request('https://x/signals/api/trades.csv', {
    headers: { Authorization: 'Bearer secret' }
  });
  const response = await handleTradeJournalRequest(request, {
    TRADE_JOURNAL_TOKEN: 'secret', FCS_DB: db
  }, new URL(request.url), 'csv');
  const body = await response.text();
  assert.match(body, /'\=HYPERLINK/);
  assert.match(body, /'\+cmd/);
  assert.match(body, /,-2\.5,/);
});

test('notification watermark advances only after a successful push', async () => {
  const db = new MockDb();
  db.notificationRows = [{
    fill_count: 3, manual_count: 1, unknown_count: 2,
    futures_realized_pnl: -0.5, symbols: 'spot:FILUSDT,futures:PEPEUSDT',
    max_ingested_at: '2026-09-08T12:00:00.000Z', max_rowid: 42
  }];
  const kv = new MockKv();
  let pushed;
  const fetchImpl = async (url, options) => {
    pushed = { url: String(url), options };
    return { ok: true, status: 200 };
  };
  const count = await dispatchTradeJournalAlerts(
    { FCS_DB: db, FCS_CACHE: kv, NTFY_TOPIC: 'private topic' },
    { nowMs: Date.parse('2026-09-08T12:01:00.000Z'), fetchImpl }
  );
  assert.equal(count, 3);
  assert.match(pushed.url, /private%20topic$/);
  assert.match(pushed.options.body, /1 proven manual, 2 awaiting provenance review/);
  assert.match(pushed.options.body, /Spot realized P&L.*not supplied/);
  assert.equal(kv.puts.length, 1);
  const state = JSON.parse(kv.puts[0].value);
  assert.equal(state.maxRowid, 42);
  assert.equal(state.sentAt, '2026-09-08T12:01:00.000Z');
  assert.equal(state.consecutiveFailures, 0);
});

test('Retry-After accepts delta-seconds and HTTP dates without shortening long valid delays', () => {
  const now = Date.parse('2026-09-08T21:00:00.000Z');
  assert.equal(parseRetryAfterMs('120', now), 120_000);
  assert.equal(parseRetryAfterMs('Tue, 08 Sep 2026 22:00:00 GMT', now), 3_600_000);
  assert.equal(parseRetryAfterMs(String(10 * 24 * 60 * 60), now), 10 * 24 * 60 * 60 * 1000);
  assert.equal(parseRetryAfterMs('not a delay', now), null);
});

test('daily-quota 429 persists a midnight-UTC cooldown without advancing the watermark', async () => {
  const db = new MockDb();
  db.notificationRows = [{
    fill_count: 1, manual_count: 0, unknown_count: 1,
    futures_realized_pnl: 0, symbols: 'spot:FILUSDT',
    max_ingested_at: '2026-09-08T13:00:00.000Z', max_rowid: 43
  }];
  const kv = new MockKv(JSON.stringify({
    maxRowid: 41, sentAt: '2026-09-08T12:00:00.000Z'
  }));
  const nowMs = Date.parse('2026-09-08T21:00:00.000Z');
  const fetchImpl = async () => new Response(JSON.stringify({
    code: 42908,
    http: 429,
    error: 'limit reached: daily message quota reached; private provider detail'
  }), {
    status: 429,
    headers: { 'Content-Type': 'application/json', 'Retry-After': '3600' }
  });
  await assert.rejects(() => dispatchTradeJournalAlerts(
    { FCS_DB: db, FCS_CACHE: kv, NTFY_TOPIC: 'private-topic' },
    { nowMs, fetchImpl }
  ), /HTTP 429 \(provider code 42908\)/);
  assert.equal(kv.puts.length, 1);
  const state = JSON.parse(kv.value);
  assert.equal(state.maxRowid, 41);
  assert.equal(state.attemptedMaxRowid, 43);
  assert.equal(state.attemptedFillCount, 1);
  assert.equal(state.providerHttpStatus, 429);
  assert.equal(state.providerErrorCode, 42908);
  assert.equal(state.consecutiveFailures, 1);
  assert.equal(state.nextAttemptAt, '2026-09-09T00:05:00.000Z');
  assert.doesNotMatch(kv.value, /private-topic|daily message quota|private provider detail/);
});

test('burst-limit 429 uses Retry-After instead of the daily midnight cooldown', async () => {
  const db = new MockDb();
  db.notificationRows = [{
    fill_count: 1, manual_count: 0, unknown_count: 1,
    futures_realized_pnl: null, symbols: 'spot:FILUSDT',
    max_ingested_at: '2026-09-08T13:00:00.000Z', max_rowid: 43
  }];
  const kv = new MockKv(JSON.stringify({ maxRowid: 41 }));
  const nowMs = Date.parse('2026-09-08T21:00:00.000Z');
  await assert.rejects(() => dispatchTradeJournalAlerts(
    { FCS_DB: db, FCS_CACHE: kv, NTFY_TOPIC: 't' },
    {
      nowMs,
      fetchImpl: async () => new Response(JSON.stringify({ code: 42901 }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': '1800' }
      })
    }
  ), /provider code 42901/);
  assert.equal(JSON.parse(kv.value).nextAttemptAt, '2026-09-08T21:30:00.000Z');
});

test('durable cooldown skips both D1 and provider until retry time', async () => {
  const db = new MockDb();
  db.notificationRows = [{
    fill_count: 1, manual_count: 0, unknown_count: 1,
    futures_realized_pnl: null, symbols: 'spot:PEPEUSDT',
    max_ingested_at: '2026-09-08T14:00:00.000Z', max_rowid: 78
  }];
  const kv = new MockKv(JSON.stringify({
    maxRowid: 77,
    consecutiveFailures: 1,
    nextAttemptAt: '2026-09-09T00:05:00.000Z',
    providerHttpStatus: 429,
    providerErrorCode: 42908
  }));
  let fetches = 0;
  const result = await dispatchTradeJournalAlerts(
    { FCS_DB: db, FCS_CACHE: kv, NTFY_TOPIC: 't' },
    {
      nowMs: Date.parse('2026-09-08T23:00:00.000Z'),
      fetchImpl: async () => { fetches++; return { ok: true, status: 200 }; }
    }
  );
  assert.equal(result, 0);
  assert.equal(db.reads, 0);
  assert.equal(fetches, 0);
  assert.equal(kv.puts.length, 0);
});

test('successful retry advances the watermark, clears failure state, and supports an optional token', async () => {
  const db = new MockDb();
  db.notificationRows = [{
    fill_count: 2, manual_count: 1, unknown_count: 1,
    futures_realized_pnl: null, symbols: 'spot:PEPEUSDT',
    max_ingested_at: '2026-09-09T00:04:00.000Z', max_rowid: 80
  }];
  const kv = new MockKv(JSON.stringify({
    maxRowid: 77,
    sentAt: '2026-09-08T12:00:00.000Z',
    consecutiveFailures: 3,
    nextAttemptAt: '2026-09-09T00:05:00.000Z',
    providerHttpStatus: 429,
    providerErrorCode: 42908
  }));
  let authorization;
  const count = await dispatchTradeJournalAlerts({
    FCS_DB: db, FCS_CACHE: kv, NTFY_TOPIC: 't', NTFY_TOKEN: 'token-value'
  }, {
    nowMs: Date.parse('2026-09-09T00:05:01.000Z'),
    fetchImpl: async (_url, options) => {
      authorization = options.headers.Authorization;
      return { ok: true, status: 200 };
    }
  });
  assert.equal(count, 2);
  assert.equal(authorization, 'Bearer token-value');
  const state = JSON.parse(kv.value);
  assert.equal(state.maxRowid, 80);
  assert.equal(state.consecutiveFailures, 0);
  assert.equal(state.nextAttemptAt, null);
  assert.equal(state.providerHttpStatus, null);
  assert.equal(state.providerErrorCode, null);
  assert.doesNotMatch(kv.value, /token-value/);
});

test('alert paging uses row identity so equal ingestion timestamps cannot be skipped', async () => {
  const db = new MockDb();
  db.notificationRows = [{
    fill_count: 1, manual_count: 0, unknown_count: 1,
    futures_realized_pnl: null, symbols: 'spot:PEPEUSDT',
    max_ingested_at: '2026-09-08T14:00:00.000Z', max_rowid: 78
  }];
  const kv = new MockKv(JSON.stringify({
    maxRowid: 77, maxIngestedAt: '2026-09-08T14:00:00.000Z'
  }));
  await dispatchTradeJournalAlerts(
    { FCS_DB: db, FCS_CACHE: kv, NTFY_TOPIC: 't' },
    { fetchImpl: async () => ({ ok: true, status: 200 }) }
  );
  assert.deepEqual(db.notificationParams, [77]);
  assert.equal(JSON.parse(kv.value).maxRowid, 78);
});

test('authenticated journal exposes sanitized delivery health in JSON and HTML', async () => {
  const kv = new MockKv(JSON.stringify({
    maxRowid: 77,
    sentAt: '2026-09-08T12:00:00.000Z',
    lastAttemptAt: '2026-09-08T21:00:00.000Z',
    lastFailureAt: '2026-09-08T21:00:00.000Z',
    nextAttemptAt: '2099-09-09T00:05:00.000Z',
    consecutiveFailures: 2,
    attemptedFillCount: 3,
    attemptedMaxRowid: 80,
    providerHttpStatus: 429,
    providerErrorCode: 42908,
    failureKind: 'http',
    injected: 'must not escape normalization'
  }));
  const env = {
    TRADE_JOURNAL_TOKEN: 'journal-secret',
    FCS_DB: new MockDb(),
    FCS_CACHE: kv,
    NTFY_TOPIC: 'private-topic',
    NTFY_TOKEN: 'provider-secret'
  };
  const status = await loadTradeJournalDeliveryStatus(env, Date.parse('2026-09-08T22:00:00.000Z'));
  assert.equal(status.state, 'cooldown');
  assert.equal(status.providerHttpStatus, 429);
  assert.equal(status.providerErrorCode, 42908);
  assert.equal(status.lastSentAt, '2026-09-08T12:00:00.000Z');
  assert.equal(Object.hasOwn(status, 'injected'), false);

  const jsonRequest = new Request('https://x/signals/api/trades', {
    headers: { Authorization: 'Bearer journal-secret' }
  });
  const jsonResponse = await handleTradeJournalRequest(jsonRequest, env, new URL(jsonRequest.url), 'json');
  const jsonText = await jsonResponse.text();
  const body = JSON.parse(jsonText);
  assert.equal(body.alertDelivery.state, 'cooldown');
  assert.equal(body.alertDelivery.providerErrorCode, 42908);
  assert.doesNotMatch(jsonText, /private-topic|provider-secret|journal-secret|must not escape/);

  const htmlRequest = new Request('https://x/signals/trades', {
    headers: { Authorization: 'Bearer journal-secret' }
  });
  const htmlResponse = await handleTradeJournalRequest(htmlRequest, env, new URL(htmlRequest.url), 'html');
  const html = await htmlResponse.text();
  assert.match(html, /Account journal alert delivery:.*cooldown until.*provider HTTP 429.*provider code 42908/s);
  assert.match(html, /last sent 2026-09-08 12:00:00.000Z/);
  assert.doesNotMatch(html, /private-topic|provider-secret|journal-secret|must not escape/);
});

test('unavailable delivery state cannot bypass a stored cooldown or send an alert', async () => {
  const db = new MockDb();
  let fetches = 0;
  const env = {
    FCS_DB: db, NTFY_TOPIC: 'private-topic',
    FCS_CACHE: { get: async () => { throw new Error('private failure detail'); } }
  };
  await assert.rejects(() => dispatchTradeJournalAlerts(env, {
    fetchImpl: async () => { fetches++; }
  }), /^Error: account journal delivery state unavailable$/);
  assert.equal(db.reads, 0);
  assert.equal(fetches, 0);
  assert.equal((await loadTradeJournalDeliveryStatus(env)).state, 'unavailable');
});

test('network failures retain the watermark, back off, and never expose the raw error', async () => {
  const db = new MockDb();
  db.notificationRows = [{ fill_count: 1, max_rowid: 43 }];
  const kv = new MockKv(JSON.stringify({ maxRowid: 41 }));
  const env = { FCS_DB: db, FCS_CACHE: kv, NTFY_TOPIC: 'private-topic' };
  const initialTime = Date.parse('2026-09-08T21:00:00.000Z');
  for (const [i, name] of ['Error', 'AbortError'].entries()) {
    const nowMs = initialTime + i * 5 * 60_000;
    await assert.rejects(() => dispatchTradeJournalAlerts(env, {
      nowMs,
      fetchImpl: async () => {
        const error = new Error('private-topic provider-secret');
        error.name = name;
        throw error;
      }
    }), (error) => {
      assert.doesNotMatch(String(error), /private-topic|provider-secret/);
      assert.equal(error.cause, undefined);
      return true;
    });
    const state = JSON.parse(kv.value);
    assert.equal(state.maxRowid, 41);
    assert.equal(state.providerHttpStatus, null);
    assert.equal(state.providerErrorCode, null);
    assert.equal(state.failureKind, i ? 'timeout' : 'network');
    assert.equal(state.consecutiveFailures, i + 1);
    assert.equal(Date.parse(state.nextAttemptAt) - nowMs, 5 * 60_000 * (2 ** i));
  }
});

test('missing or oversized provider error codes remain unknown, never a fabricated zero', async () => {
  for (const payload of [{ code: null }, { code: 42908, detail: 'x'.repeat(5000) }]) {
    const db = new MockDb();
    db.notificationRows = [{ fill_count: 1, max_rowid: 43 }];
    const kv = new MockKv(JSON.stringify({ maxRowid: 41 }));
    await assert.rejects(() => dispatchTradeJournalAlerts(
      { FCS_DB: db, FCS_CACHE: kv, NTFY_TOPIC: 't' },
      {
        nowMs: Date.parse('2026-09-08T21:00:00.000Z'),
        fetchImpl: async () => new Response(JSON.stringify(payload), {
          status: 429, headers: { 'Content-Type': 'application/json' }
        })
      }
    ), /HTTP 429$/);
    assert.equal(JSON.parse(kv.value).providerErrorCode, null);
    assert.equal(JSON.parse(kv.value).nextAttemptAt, '2026-09-08T21:05:00.000Z');
  }
});
