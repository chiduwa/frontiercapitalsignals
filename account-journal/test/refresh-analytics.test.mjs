// Pins refreshAnalytics' write-only-the-difference summary refresh to the
// full DELETE + INSERT rebuild it replaced. Both run against the real
// migration schema on node:sqlite through the same fetch stub the store uses
// in production, across every source mutation the journal can make.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { refreshAnalytics } from '../src/store.mjs';

// The pre-2026-09-30 statements, verbatim. This is the oracle.
const REBUILD = [
  'DELETE FROM account_journal_daily_fees',
  `INSERT INTO account_journal_daily_fees
      (day, market, origin, symbol, commission_asset, commission_amount, refreshed_at)
      SELECT substr(event_time, 1, 10), market, origin, symbol, commission_asset,
             SUM(commission), ?
        FROM account_journal_fills
       WHERE commission IS NOT NULL AND commission_asset IS NOT NULL
       GROUP BY substr(event_time, 1, 10), market, origin, symbol, commission_asset`,
  'DELETE FROM account_journal_daily_stats',
  `INSERT INTO account_journal_daily_stats
      (day, market, origin, symbol, fill_count, order_count, buy_fill_count,
       sell_fill_count, buy_quantity, sell_quantity, buy_quote_quantity,
       sell_quote_quantity, realized_pnl, first_fill_at, last_fill_at, refreshed_at)
      SELECT substr(event_time, 1, 10), market, origin, symbol,
             COUNT(*), COUNT(DISTINCT order_id),
             SUM(CASE WHEN side = 'BUY' THEN 1 ELSE 0 END),
             SUM(CASE WHEN side = 'SELL' THEN 1 ELSE 0 END),
             SUM(CASE WHEN side = 'BUY' THEN quantity ELSE 0 END),
             SUM(CASE WHEN side = 'SELL' THEN quantity ELSE 0 END),
             SUM(CASE WHEN side = 'BUY' THEN COALESCE(quote_quantity, 0) ELSE 0 END),
             SUM(CASE WHEN side = 'SELL' THEN COALESCE(quote_quantity, 0) ELSE 0 END),
             CASE WHEN market = 'futures' THEN SUM(realized_pnl) ELSE NULL END,
             MIN(event_time), MAX(event_time), ?
        FROM account_journal_fills
       GROUP BY substr(event_time, 1, 10), market, origin, symbol`
];
const REBUILD_TAKES_NOW = [false, true, false, true];

function journalDatabase() {
  const database = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false });
  for (const migration of ['0021_manual_trade_journal.sql', '0028_account_journal_query_indexes.sql']) {
    database.exec(readFileSync(new URL(`../../signals-worker/migrations/${migration}`, import.meta.url), 'utf8'));
  }
  return database;
}

function rebuild(database, nowIso) {
  database.exec('BEGIN');
  REBUILD.forEach((sql, i) => database.prepare(sql).run(...(REBUILD_TAKES_NOW[i] ? [nowIso] : [])));
  database.exec('COMMIT');
}

// Same wire shape as withLocalD1 in journal.test.mjs: a D1 batch is one
// transaction, rolled back whole on any error.
async function viaD1(database, action) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    const batch = Array.isArray(body.batch) ? body.batch : [body];
    database.exec('BEGIN');
    try {
      for (const statement of batch) database.prepare(statement.sql).run(...(statement.params || []));
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      return { ok: false, status: 500, json: async () => ({ success: false, errors: [{ message: error.message }] }) };
    }
    return { ok: true, status: 200, json: async () => ({
      success: true, result: batch.map(() => ({ success: true, results: [] }))
    }) };
  };
  try { return await action(); }
  finally { globalThis.fetch = originalFetch; }
}

const config = { cloudflare: { CLOUDFLARE_API_TOKEN: 'cf', CLOUDFLARE_ACCOUNT_ID: 'acct', FCS_D1_DATABASE_ID: 'db' } };
async function refresh(database, nowIso) {
  await viaD1(database, () => refreshAnalytics(config, nowIso));
}

const STATS_KEY = 'day, market, origin, symbol';
const FEES_KEY = 'day, market, origin, symbol, commission_asset';
function figures(database) {
  const strip = (rows) => rows.map(({ refreshed_at: _ignored, ...rest }) => ({ ...rest }));
  return {
    stats: strip(database.prepare(`SELECT * FROM account_journal_daily_stats ORDER BY ${STATS_KEY}`).all()),
    fees: strip(database.prepare(`SELECT * FROM account_journal_daily_fees ORDER BY ${FEES_KEY}`).all())
  };
}
function stamps(database) {
  const out = new Map();
  for (const r of database.prepare(`SELECT ${STATS_KEY}, refreshed_at FROM account_journal_daily_stats`).all()) {
    out.set(`stats|${r.day}|${r.market}|${r.origin}|${r.symbol}`, r.refreshed_at);
  }
  for (const r of database.prepare(`SELECT ${FEES_KEY}, refreshed_at FROM account_journal_daily_fees`).all()) {
    out.set(`fees|${r.day}|${r.market}|${r.origin}|${r.symbol}|${r.commission_asset}`, r.refreshed_at);
  }
  return out;
}
const totalChanges = (database) => database.prepare('SELECT total_changes() AS n').get().n;

// Deterministic fills: several days, both markets, all origins, both sides,
// NULL commission / commission asset / quote quantity / realized P&L, and
// several fills per order so COUNT(DISTINCT order_id) is exercised.
function seedFills(database) {
  let state = 20260930;
  const rand = () => ((state = (state * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const insert = database.prepare(`INSERT INTO account_journal_fills
    (market, symbol, trade_id, order_id, event_time, side, position_side, price, quantity,
     quote_quantity, realized_pnl, commission, commission_asset, is_maker, origin,
     classification_method, ingested_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (let i = 0; i < 400; i++) {
    const market = pick(['spot', 'futures']);
    const day = `2026-09-${String(10 + Math.floor(rand() * 12)).padStart(2, '0')}`;
    const time = `${day}T${String(Math.floor(rand() * 24)).padStart(2, '0')}:${String(Math.floor(rand() * 60)).padStart(2, '0')}:00.000Z`;
    const price = 0.5 + rand() * 100;
    const quantity = 0.001 + rand() * 50;
    insert.run(market, pick(['BTCUSDT', 'ETHUSDT', 'PEPEUSDT', 'XTZUSDT', 'SOLUSDT']), `t${i}`,
      `o${Math.floor(i / 3)}`, time, pick(['BUY', 'SELL']), market === 'futures' ? 'BOTH' : null,
      price, quantity, rand() < 0.1 ? null : price * quantity,
      market === 'futures' && rand() < 0.8 ? (rand() - 0.5) * 10 : null,
      rand() < 0.15 ? null : rand() * 0.2, rand() < 0.1 ? null : pick(['USDT', 'BNB', 'XTZ']),
      rand() < 0.5 ? 1 : 0, pick(['bot', 'manual', 'unknown']), 'test', '2026-09-22T00:00:00.000Z');
  }
}

test('summary refresh reaches the same figures as the full rebuild through every source mutation', async () => {
  const oracle = journalDatabase();
  const subject = journalDatabase();
  const mutate = (sql, ...params) => { for (const db of [oracle, subject]) db.prepare(sql).run(...params); };
  seedFills(oracle);
  seedFills(subject);

  let clock = Date.parse('2026-09-30T00:00:00.000Z');
  const step = async (label) => {
    const nowIso = new Date(clock += 60_000).toISOString();
    rebuild(oracle, nowIso);
    await refresh(subject, nowIso);
    assert.deepEqual(figures(subject), figures(oracle), label);
  };

  await step('first refresh of an empty summary');
  const initial = figures(subject);
  assert.ok(initial.stats.length > 50 && initial.fees.length > 50, 'fixture covers many groups');
  assert.ok(initial.stats.some((r) => r.realized_pnl === null) && initial.stats.some((r) => r.realized_pnl !== null));

  mutate(`INSERT INTO account_journal_fills (market, symbol, trade_id, order_id, event_time, side, price, quantity,
    quote_quantity, commission, commission_asset, origin, classification_method, ingested_at)
    SELECT market, symbol, 'late-1', order_id, substr(event_time, 1, 10) || 'T23:59:59.000Z', 'SELL', 3, 2, 6, 0.01,
           'USDT', origin, 'test', '2026-09-30T00:00:00.000Z' FROM account_journal_fills WHERE trade_id = 't7'`);
  await step('late fill into an existing day group');

  mutate(`INSERT INTO account_journal_fills (market, symbol, trade_id, order_id, event_time, side, price, quantity,
    commission, commission_asset, origin, classification_method, ingested_at)
    VALUES ('spot', 'NEWUSDT', 'new-1', 'new-o', '2026-09-29T08:00:00.000Z', 'BUY', 1, 1, 0.001, 'BNB', 'manual', 'test', 'x')`);
  await step('fill that opens a new day, symbol and fee group');

  mutate(`UPDATE account_journal_fills SET commission = commission * 3 + 0.5 WHERE trade_id IN ('t11', 't12')`);
  await step('changed commissions');

  mutate(`UPDATE account_journal_fills SET commission_asset = 'FDUSD' WHERE trade_id = 't20'`);
  await step('changed commission asset moves the fee between groups');

  mutate(`UPDATE account_journal_fills SET commission = NULL WHERE trade_id IN ('new-1')`);
  await step('commission removed empties a fee group');

  mutate(`UPDATE account_journal_fills SET origin = CASE origin WHEN 'bot' THEN 'manual' ELSE 'bot' END
           WHERE trade_id IN ('t3', 't30', 't31', 't32')`);
  await step('origin reclassification moves fills between groups');

  mutate(`UPDATE account_journal_fills SET realized_pnl = COALESCE(realized_pnl, 0) + 1.25, quote_quantity = NULL
           WHERE trade_id IN ('t40', 't41')`);
  await step('changed realized P&L and a quote quantity dropped to NULL');

  mutate(`DELETE FROM account_journal_fills WHERE trade_id IN ('new-1', 't50')`);
  await step('removed source rows delete their now-empty groups');

  // One figure at a time, so a missing per-column comparison cannot hide
  // behind another column that changed in the same step.
  mutate(`INSERT INTO account_journal_fills (market, symbol, trade_id, order_id, event_time, side, price, quantity,
    quote_quantity, realized_pnl, commission, commission_asset, origin, classification_method, ingested_at)
    VALUES ('futures', 'ISOUSDT', 'iso-1', 'iso-a', '2026-09-25T10:00:00.000Z', 'BUY', 10, 1, 10, NULL, 0.1, 'USDT', 'manual', 'test', 'x'),
           ('futures', 'ISOUSDT', 'iso-2', 'iso-a', '2026-09-25T11:00:00.000Z', 'SELL', 10, 2, 20, NULL, 0.2, 'BNB', 'manual', 'test', 'x')`);
  await step('isolated group created with no realized P&L');
  const isolated = [
    ['realized P&L NULL to a value', `UPDATE account_journal_fills SET realized_pnl = 5 WHERE trade_id = 'iso-2'`],
    ['realized P&L value to value', `UPDATE account_journal_fills SET realized_pnl = 7 WHERE trade_id = 'iso-2'`],
    ['realized P&L back to NULL', `UPDATE account_journal_fills SET realized_pnl = NULL WHERE trade_id = 'iso-2'`],
    ['order count only', `UPDATE account_journal_fills SET order_id = 'iso-b' WHERE trade_id = 'iso-2'`],
    ['last fill time only', `UPDATE account_journal_fills SET event_time = '2026-09-25T12:00:00.000Z' WHERE trade_id = 'iso-2'`],
    ['first fill time only', `UPDATE account_journal_fills SET event_time = '2026-09-25T09:00:00.000Z' WHERE trade_id = 'iso-1'`],
    ['sell quote quantity only', `UPDATE account_journal_fills SET quote_quantity = 25 WHERE trade_id = 'iso-2'`],
    ['buy quote quantity only', `UPDATE account_journal_fills SET quote_quantity = 12 WHERE trade_id = 'iso-1'`],
    ['buy quantity only', `UPDATE account_journal_fills SET quantity = 1.5 WHERE trade_id = 'iso-1'`],
    ['sell quantity only', `UPDATE account_journal_fills SET quantity = 2.5 WHERE trade_id = 'iso-2'`],
    ['side flip', `UPDATE account_journal_fills SET side = 'SELL' WHERE trade_id = 'iso-1'`],
    ['fee asset moves while its day group survives', `UPDATE account_journal_fills SET commission_asset = 'USDT' WHERE trade_id = 'iso-2'`],
    ['fee amount only', `UPDATE account_journal_fills SET commission = 0.3 WHERE trade_id = 'iso-2'`]
  ];
  for (const [label, sql] of isolated) {
    mutate(sql);
    await step(label);
  }

  // Nothing changed: the refresh must write nothing and keep every stamp.
  const before = stamps(subject);
  const changes = totalChanges(subject);
  await refresh(subject, '2026-10-01T00:00:00.000Z');
  assert.equal(totalChanges(subject) - changes, 0, 'unchanged fills write zero rows');
  assert.deepEqual(stamps(subject), before, 'refreshed_at kept when figures did not change');

  // One fill changed: exactly its stats group and fee group are rewritten.
  const target = subject.prepare(`SELECT market, symbol, origin, substr(event_time, 1, 10) AS day, commission_asset
    FROM account_journal_fills WHERE trade_id = 't60'`).get();
  mutate(`UPDATE account_journal_fills SET quantity = quantity + 1, commission = COALESCE(commission, 0) + 0.01,
           commission_asset = COALESCE(commission_asset, 'USDT') WHERE trade_id = 't60'`);
  const changedAt = '2026-10-02T00:00:00.000Z';
  rebuild(oracle, changedAt);
  await refresh(subject, changedAt);
  assert.deepEqual(figures(subject), figures(oracle), 'single-fill change');
  const restamped = [...stamps(subject)].filter(([, at]) => at === changedAt).map(([key]) => key).sort();
  assert.deepEqual(restamped, [
    `fees|${target.day}|${target.market}|${target.origin}|${target.symbol}|${target.commission_asset || 'USDT'}`,
    `stats|${target.day}|${target.market}|${target.origin}|${target.symbol}`
  ].sort());

  mutate('DELETE FROM account_journal_fills');
  await step('no fills at all');
  assert.deepEqual(figures(subject), { stats: [], fees: [] });
});

test('a failed summary refresh leaves the previous summary intact', async () => {
  const database = journalDatabase();
  seedFills(database);
  await refresh(database, '2026-09-30T00:00:00.000Z');
  const before = figures(database);
  database.prepare(`UPDATE account_journal_fills SET commission = commission + 1 WHERE trade_id = 't1'`).run();
  // A CHECK violation on the last statement must roll back the whole batch.
  database.exec(`CREATE TRIGGER fail_stats BEFORE INSERT ON account_journal_daily_stats
    BEGIN SELECT RAISE(ABORT, 'forced'); END`);
  database.prepare(`INSERT INTO account_journal_fills (market, symbol, trade_id, order_id, event_time, side, price,
    quantity, origin, classification_method, ingested_at)
    VALUES ('spot', 'ZZZUSDT', 'fail-1', 'fail-o', '2026-09-28T00:00:00.000Z', 'BUY', 1, 1, 'manual', 'test', 'x')`).run();
  await assert.rejects(refresh(database, '2026-10-01T00:00:00.000Z'));
  assert.deepEqual(figures(database), before);
});
