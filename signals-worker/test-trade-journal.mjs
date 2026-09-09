import test from 'node:test';
import assert from 'node:assert/strict';
import {
  constantTimeCredentialEqual, dispatchTradeJournalAlerts,
  handleTradeJournalRequest, isTradeJournalRequestAuthorized, loadTradeJournal
} from './trade-journal.js';

class MockStatement {
  constructor(db, sql) { this.db = db; this.sql = sql; this.params = []; }
  bind(...params) { this.params = params; return this; }
  async all() { return { results: this.db.query(this.sql, this.params) }; }
}

class MockDb {
  constructor() { this.reads = 0; this.notificationRows = null; this.notificationParams = null; }
  prepare(sql) { return new MockStatement(this, sql); }
  query(sql, params = []) {
    this.reads++;
    if (sql.includes('MAX(ingested_at)')) {
      this.notificationParams = params;
      return this.notificationRows || [{
        fill_count: 0, manual_count: 0, unknown_count: 0,
        futures_realized_pnl: null, symbols: null, max_ingested_at: null,
        max_rowid: null
      }];
    }
    if (sql.includes('account_journal_origin_summary')) return [{
      market: 'futures', origin: 'unknown', fill_count: 2, order_count: 1,
      symbol_count: 1, first_fill_at: '2026-09-08T00:00:00Z',
      last_fill_at: '2026-09-08T00:01:00Z', buy_quote_quantity: 10,
      sell_quote_quantity: 12, realized_pnl: 1.25
    }];
    if (sql.includes('account_journal_fills WHERE')) return [{
      market: 'futures', symbol: 'PEPEUSDT', trade_id: '1', order_id: '2',
      client_order_id: 'web,order', event_time: '2026-09-08T00:01:00Z',
      side: 'SELL', position_side: 'BOTH', price: 0.0000123, quantity: 1000,
      quote_quantity: 0.0123, realized_pnl: 1.25, commission: 0.01,
      commission_asset: 'USDT', is_maker: 0, origin: 'unknown',
      classification_method: 'no_provenance_match',
      classification_evidence: 'no documented origin field'
    }];
    if (sql.includes('account_journal_daily_stats')) return [];
    if (sql.includes('account_journal_daily_fees')) return [];
    if (sql.includes('account_journal_review_queue')) return [{ n: 2 }];
    if (sql.includes('account_journal_runs')) return [{
      run_id: 'r1', started_at: '2026-09-08T00:00:00Z', completed_at: '2026-09-08T00:02:00Z',
      status: 'ok', markets_requested: 2, symbols_requested: 9,
      fills_seen: 2, pages_read: 9, error_count: 0, error_summary: null
    }];
    throw new Error(`unexpected SQL: ${sql}`);
  }
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
  const data = await loadTradeJournal({ FCS_DB: new MockDb() }, new URL('https://x/signals/api/trades?origin=external&days=14'));
  assert.equal(data.selection, 'external');
  assert.equal(data.reviewCount, 2);
  assert.match(data.definitions.unknown, /never presumed manual/);
  assert.match(data.definitions.spotPnl, /do not supply realized P&L/);
});

test('authenticated HTML and CSV responses are private and escaped/quoted', async () => {
  const env = { TRADE_JOURNAL_TOKEN: 'secret', FCS_DB: new MockDb() };
  const htmlRequest = new Request('https://x/signals/trades', { headers: { Authorization: 'Bearer secret' } });
  const html = await handleTradeJournalRequest(htmlRequest, env, new URL(htmlRequest.url), 'html');
  assert.equal(html.status, 200);
  assert.match(await html.text(), /Unknown.*does not mean manual/s);
  assert.match(html.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(html.headers.get('access-control-allow-origin'), null);

  const csvRequest = new Request('https://x/signals/api/trades.csv', { headers: { Authorization: 'Bearer secret' } });
  const csv = await handleTradeJournalRequest(csvRequest, env, new URL(csvRequest.url), 'csv');
  assert.match(await csv.text(), /"web,order"/);
  assert.match(csv.headers.get('content-disposition'), /attachment/);
});

test('notification watermark advances only after a successful push', async () => {
  const db = new MockDb();
  db.notificationRows = [{
    fill_count: 3, manual_count: 1, unknown_count: 2,
    futures_realized_pnl: -0.5, symbols: 'spot:FILUSDT,futures:PEPEUSDT',
    max_ingested_at: '2026-09-08T12:00:00.000Z', max_rowid: 42
  }];
  const kv = new MockKv();
  const originalFetch = globalThis.fetch;
  let pushed;
  globalThis.fetch = async (url, options) => {
    pushed = { url: String(url), options };
    return { ok: true, status: 200 };
  };
  try {
    const count = await dispatchTradeJournalAlerts({ FCS_DB: db, FCS_CACHE: kv, NTFY_TOPIC: 'private topic' });
    assert.equal(count, 3);
    assert.match(pushed.url, /private%20topic$/);
    assert.match(pushed.options.body, /1 proven manual, 2 awaiting provenance review/);
    assert.match(pushed.options.body, /Spot realized P&L.*not supplied/);
    assert.equal(kv.puts.length, 1);
    assert.deepEqual(JSON.parse(kv.puts[0].value).maxRowid, 42);
  } finally { globalThis.fetch = originalFetch; }
});

test('a failed notification leaves the watermark unchanged for retry', async () => {
  const db = new MockDb();
  db.notificationRows = [{
    fill_count: 1, manual_count: 0, unknown_count: 1,
    futures_realized_pnl: 0, symbols: 'spot:FILUSDT',
    max_ingested_at: '2026-09-08T13:00:00.000Z', max_rowid: 43
  }];
  const kv = new MockKv();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 503 });
  try {
    await assert.rejects(() => dispatchTradeJournalAlerts({ FCS_DB: db, FCS_CACHE: kv, NTFY_TOPIC: 't' }), /HTTP 503/);
    assert.equal(kv.puts.length, 0);
  } finally { globalThis.fetch = originalFetch; }
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
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200 });
  try {
    await dispatchTradeJournalAlerts({ FCS_DB: db, FCS_CACHE: kv, NTFY_TOPIC: 't' });
    assert.deepEqual(db.notificationParams, [77]);
    assert.equal(JSON.parse(kv.value).maxRowid, 78);
  } finally { globalThis.fetch = originalFetch; }
});
