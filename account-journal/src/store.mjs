import { d1, d1Batch, chunk } from '../../signals-worker/scripts/d1-client.mjs';
import { classifyOrder } from './classify.mjs';

function cf(config) { return config.cloudflare; }

function isoFromStoredMs(value) {
  if (value == null) return null;
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 0) return null;
  try { return new Date(ms).toISOString(); }
  catch { return null; }
}

export async function knownSymbols(config, market) {
  const botTable = market === 'spot'
    ? "SELECT symbol FROM spot_bot_fills WHERE mode = 'live'"
    : 'SELECT symbol FROM trading_bot_open_orders';
  const algoTable = market === 'futures'
    ? 'UNION SELECT symbol FROM account_journal_futures_algos'
    : '';
  const rows = await d1(cf(config), `
    SELECT DISTINCT symbol FROM (
      SELECT symbol FROM account_journal_orders WHERE market = ?
      UNION SELECT symbol FROM account_journal_fills WHERE market = ?
      UNION ${botTable}
      ${algoTable}
    ) ORDER BY symbol`, [market, market]);
  return rows.map((row) => String(row.symbol || '').toUpperCase()).filter(Boolean);
}

export async function getCheckpoint(config, market, symbol, stream) {
  const [row] = await d1(cf(config), `
    SELECT last_trade_id, cursor_time_ms, updated_at
      FROM account_journal_checkpoints
     WHERE market = ? AND symbol = ? AND stream = ?`, [market, symbol, stream]);
  return row ? {
    lastTradeId: row.last_trade_id == null ? null : String(row.last_trade_id),
    cursorTimeMs: row.cursor_time_ms == null ? null : Number(row.cursor_time_ms),
    updatedAt: row.updated_at
  } : null;
}

function algoStateStatement(state, polledAt = null) {
  return {
    sql: `INSERT INTO account_journal_futures_algos
      (symbol, algo_id, client_algo_id, actual_order_id, side, order_type,
       actual_type, algo_status, create_time_ms, update_time_ms, trigger_time_ms,
       last_polled_at, polling_closed_at, ingested_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
      ON CONFLICT(symbol, algo_id) DO UPDATE SET
        client_algo_id = COALESCE(excluded.client_algo_id, account_journal_futures_algos.client_algo_id),
        actual_order_id = COALESCE(excluded.actual_order_id, account_journal_futures_algos.actual_order_id),
        side = COALESCE(excluded.side, account_journal_futures_algos.side),
        order_type = COALESCE(excluded.order_type, account_journal_futures_algos.order_type),
        actual_type = COALESCE(excluded.actual_type, account_journal_futures_algos.actual_type),
        algo_status = COALESCE(excluded.algo_status, account_journal_futures_algos.algo_status),
        create_time_ms = COALESCE(excluded.create_time_ms, account_journal_futures_algos.create_time_ms),
        update_time_ms = COALESCE(excluded.update_time_ms, account_journal_futures_algos.update_time_ms),
        trigger_time_ms = COALESCE(excluded.trigger_time_ms, account_journal_futures_algos.trigger_time_ms),
        last_polled_at = CASE
          WHEN excluded.last_polled_at IS NOT NULL THEN excluded.last_polled_at
          WHEN COALESCE(excluded.update_time_ms, -1) > COALESCE(account_journal_futures_algos.update_time_ms, -1)
            THEN NULL
          ELSE account_journal_futures_algos.last_polled_at
        END,
        polling_closed_at = CASE
          WHEN UPPER(COALESCE(excluded.algo_status, '')) IN ('NEW', 'TRIGGERING', 'TRIGGERED')
            THEN NULL
          ELSE account_journal_futures_algos.polling_closed_at
        END,
        ingested_at = excluded.ingested_at`,
    params: [state.symbol, state.algoId, state.clientAlgoId,
      state.actualOrderId, state.side, state.orderType, state.actualType, state.algoStatus,
      state.createTimeMs, state.updateTimeMs, state.triggerTimeMs,
      polledAt, state.ingestedAt]
  };
}

export async function persistAlgoStates(config, states, polledAt = null) {
  for (const batch of chunk((states || []).map((state) => algoStateStatement(state, polledAt)), 40)) {
    await d1Batch(cf(config), batch);
  }
}

export async function loadPendingAlgoStates(config, symbol, limit) {
  const rows = await d1(cf(config), `SELECT
      symbol, algo_id, client_algo_id, actual_order_id, side, order_type, actual_type,
      algo_status, create_time_ms, update_time_ms, trigger_time_ms,
      last_polled_at, ingested_at
    FROM account_journal_futures_algos
    WHERE symbol = ?
      AND actual_order_id IS NULL
      AND polling_closed_at IS NULL
      AND UPPER(COALESCE(algo_status, '')) NOT IN
        ('CANCELED', 'CANCELLED', 'EXPIRED', 'REJECTED', 'FINISHED')
    ORDER BY CASE WHEN last_polled_at IS NULL THEN 0 ELSE 1 END,
             last_polled_at, create_time_ms, algo_id
    LIMIT ?`, [symbol, limit]);
  return rows.map((row) => ({
    symbol: row.symbol,
    algoId: String(row.algo_id),
    clientAlgoId: row.client_algo_id || null,
    actualOrderId: row.actual_order_id == null ? null : String(row.actual_order_id),
    side: row.side || null,
    orderType: row.order_type || null,
    actualType: row.actual_type || null,
    algoStatus: row.algo_status || null,
    createTimeMs: row.create_time_ms == null ? null : Number(row.create_time_ms),
    updateTimeMs: row.update_time_ms == null ? null : Number(row.update_time_ms),
    triggerTimeMs: row.trigger_time_ms == null ? null : Number(row.trigger_time_ms),
    lastPolledAt: row.last_polled_at || null,
    ingestedAt: row.ingested_at
  }));
}

export async function markAlgoPolled(config, symbol, algoId, polledAt, close = false) {
  await d1(cf(config), `UPDATE account_journal_futures_algos
    SET last_polled_at = ?, polling_closed_at = CASE WHEN ? THEN ? ELSE polling_closed_at END
    WHERE symbol = ? AND algo_id = ?`,
  [polledAt, close ? 1 : 0, polledAt, symbol, algoId]);
}

export async function loadAlgoExecutionOrders(config, symbol, ingestedAt) {
  const rows = await d1(cf(config), `SELECT
      symbol, actual_order_id, client_algo_id, side, actual_type,
      trigger_time_ms, update_time_ms
    FROM account_journal_futures_algos
    WHERE symbol = ? AND actual_order_id IS NOT NULL`, [symbol]);
  return rows.map((row) => ({
    market: 'futures',
    symbol: row.symbol,
    orderId: String(row.actual_order_id),
    clientOrderId: row.client_algo_id || null,
    side: row.side || null,
    orderType: row.actual_type || null,
    status: null,
    orderTime: Number(row.trigger_time_ms) > 0
      ? isoFromStoredMs(row.trigger_time_ms) : null,
    updatedTime: isoFromStoredMs(row.update_time_ms),
    ingestedAt
  }));
}

export async function loadClassificationEvidence(config, market, symbol) {
  const overrides = await d1(cf(config), `
    SELECT order_id, origin, note FROM account_journal_origin_overrides
     WHERE market = ? AND symbol = ?`, [market, symbol]);
  const botRows = market === 'spot'
    ? await d1(cf(config), `SELECT DISTINCT order_id FROM spot_bot_fills
         WHERE mode = 'live' AND symbol = ? AND order_id IS NOT NULL AND order_id != ''`, [symbol])
    : [];
  return {
    overrides: new Map(overrides.map((row) => [String(row.order_id), row])),
    botOrderIds: new Set(botRows.map((row) => String(row.order_id)))
  };
}

function orderStatement(order) {
  return {
    sql: `INSERT INTO account_journal_orders
      (market, symbol, order_id, client_order_id, side, order_type, status,
       order_time, updated_time, ingested_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(market, symbol, order_id) DO UPDATE SET
        client_order_id = COALESCE(excluded.client_order_id, account_journal_orders.client_order_id),
        side = COALESCE(excluded.side, account_journal_orders.side),
        order_type = COALESCE(excluded.order_type, account_journal_orders.order_type),
        status = COALESCE(excluded.status, account_journal_orders.status),
        order_time = COALESCE(excluded.order_time, account_journal_orders.order_time),
        updated_time = COALESCE(excluded.updated_time, account_journal_orders.updated_time),
        ingested_at = excluded.ingested_at`,
    params: [order.market, order.symbol, order.orderId, order.clientOrderId,
      order.side, order.orderType, order.status, order.orderTime,
      order.updatedTime, order.ingestedAt]
  };
}

function fillStatement(fill) {
  return {
    sql: `INSERT INTO account_journal_fills
      (market, symbol, trade_id, order_id, client_order_id, event_time, side,
       position_side, price, quantity, quote_quantity, realized_pnl,
       commission, commission_asset, is_maker, origin,
       classification_method, classification_evidence, ingested_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(market, symbol, trade_id) DO UPDATE SET
        client_order_id = COALESCE(excluded.client_order_id, account_journal_fills.client_order_id),
        origin = excluded.origin,
        classification_method = excluded.classification_method,
        classification_evidence = excluded.classification_evidence`,
    params: [fill.market, fill.symbol, fill.tradeId, fill.orderId,
      fill.clientOrderId, fill.eventTime, fill.side, fill.positionSide,
      fill.price, fill.quantity, fill.quoteQuantity, fill.realizedPnl,
      fill.commission, fill.commissionAsset,
      fill.isMaker == null ? null : (fill.isMaker ? 1 : 0), fill.origin,
      fill.classificationMethod, fill.classificationEvidence, fill.ingestedAt]
  };
}

export function attachProvenance(fills, orders, evidence, config) {
  const byId = new Map((orders || []).map((order) => [String(order.orderId), order]));
  return (fills || []).map((fill) => {
    const order = byId.get(String(fill.orderId));
    const clientOrderId = order?.clientOrderId || fill.clientOrderId || null;
    const classification = classifyOrder({ orderId: fill.orderId, clientOrderId }, evidence, config);
    return {
      ...fill, clientOrderId,
      origin: classification.origin,
      classificationMethod: classification.method,
      classificationEvidence: classification.evidence
    };
  });
}

// Re-evaluate a stored fill from current durable evidence. This is separate
// from ingestion because an algo-order mapping, a spot-bot ledger row, or an
// operator override can arrive after the fill was first seen.
export function reclassifyStoredFill(row, evidence, config) {
  const clientOrderId = row.algoClientOrderId
    || row.orderClientOrderId
    || row.clientOrderId
    || null;
  const classification = classifyOrder({
    orderId: row.orderId,
    clientOrderId
  }, evidence, config);
  const changed = (row.clientOrderId || null) !== clientOrderId
    || row.origin !== classification.origin
    || row.classificationMethod !== classification.method
    || (row.classificationEvidence || null) !== (classification.evidence || null);
  if (!changed) return null;
  return {
    market: row.market,
    symbol: row.symbol,
    tradeId: String(row.tradeId),
    clientOrderId,
    origin: classification.origin,
    classificationMethod: classification.method,
    classificationEvidence: classification.evidence || null
  };
}

export async function reclassifyJournalFills(config) {
  const evidenceByPair = new Map();
  let afterRowid = 0;
  let rowsChecked = 0;
  let rowsUpdated = 0;

  while (true) {
    const rows = await d1(cf(config), `SELECT
        f.rowid AS journal_rowid,
        f.market,
        f.symbol,
        f.trade_id AS trade_id,
        f.order_id AS order_id,
        f.client_order_id AS client_order_id,
        f.origin,
        f.classification_method AS classification_method,
        f.classification_evidence AS classification_evidence,
        o.client_order_id AS order_client_order_id,
        (SELECT a.client_algo_id
           FROM account_journal_futures_algos a
          WHERE f.market = 'futures'
            AND a.symbol = f.symbol
            AND a.actual_order_id = f.order_id
            AND a.client_algo_id IS NOT NULL
          ORDER BY a.update_time_ms DESC, a.algo_id DESC
          LIMIT 1) AS algo_client_order_id
      FROM account_journal_fills f
      LEFT JOIN account_journal_orders o
        ON o.market = f.market AND o.symbol = f.symbol AND o.order_id = f.order_id
      WHERE f.rowid > ?
      ORDER BY f.rowid
      LIMIT 1000`, [afterRowid]);
    if (!rows.length) break;

    const updates = [];
    for (const row of rows) {
      const market = String(row.market);
      const symbol = String(row.symbol);
      const pair = `${market}|${symbol}`;
      let evidence = evidenceByPair.get(pair);
      if (!evidence) {
        evidence = await loadClassificationEvidence(config, market, symbol);
        evidenceByPair.set(pair, evidence);
      }
      const update = reclassifyStoredFill({
        market,
        symbol,
        tradeId: row.trade_id,
        orderId: row.order_id,
        clientOrderId: row.client_order_id,
        orderClientOrderId: row.order_client_order_id,
        algoClientOrderId: row.algo_client_order_id,
        origin: row.origin,
        classificationMethod: row.classification_method,
        classificationEvidence: row.classification_evidence
      }, evidence, config);
      if (update) updates.push({
        sql: `UPDATE account_journal_fills
          SET client_order_id = ?, origin = ?, classification_method = ?,
              classification_evidence = ?
          WHERE market = ? AND symbol = ? AND trade_id = ?`,
        params: [update.clientOrderId, update.origin, update.classificationMethod,
          update.classificationEvidence, update.market, update.symbol, update.tradeId]
      });
    }

    for (const batch of chunk(updates, 40)) await d1Batch(cf(config), batch);
    rowsChecked += rows.length;
    rowsUpdated += updates.length;
    afterRowid = Number(rows[rows.length - 1].journal_rowid);
    if (rows.length < 1000) break;
  }

  return { rowsChecked, rowsUpdated };
}

export async function persistJournalPage(config, {
  market, symbol, orders = [], fills = [], stream = 'trades',
  lastTradeId = null, cursorTimeMs = null, updatedAt
}) {
  const orderMap = new Map((orders || []).map((order) => [String(order.orderId), order]));
  for (const fill of fills) {
    if (!orderMap.has(String(fill.orderId))) {
      orderMap.set(String(fill.orderId), {
        market, symbol, orderId: String(fill.orderId), clientOrderId: fill.clientOrderId,
        side: fill.side, orderType: null, status: null,
        orderTime: fill.eventTime, updatedTime: fill.eventTime, ingestedAt: updatedAt
      });
    }
  }
  const statements = [...orderMap.values()].map(orderStatement).concat(fills.map(fillStatement));
  // Idempotent upserts make replay safe. The cursor advances only after every
  // chunk succeeded, so a crash can repeat work but cannot skip a fill.
  for (const batch of chunk(statements, 40)) await d1Batch(cf(config), batch);
  await d1(cf(config), `INSERT INTO account_journal_checkpoints
      (market, symbol, stream, last_trade_id, cursor_time_ms, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(market, symbol, stream) DO UPDATE SET
        last_trade_id = COALESCE(excluded.last_trade_id, account_journal_checkpoints.last_trade_id),
        cursor_time_ms = excluded.cursor_time_ms,
        updated_at = excluded.updated_at`,
    [market, symbol, stream, lastTradeId, cursorTimeMs, updatedAt]);
}

export async function persistOrders(config, market, orders, cursorTimeMs, updatedAt) {
  for (const batch of chunk((orders || []).map(orderStatement), 40)) await d1Batch(cf(config), batch);
  await d1(cf(config), `INSERT INTO account_journal_checkpoints
      (market, symbol, stream, last_trade_id, cursor_time_ms, updated_at)
      VALUES (?, '*', 'orders', NULL, ?, ?)
      ON CONFLICT(market, symbol, stream) DO UPDATE SET
        cursor_time_ms = excluded.cursor_time_ms, updated_at = excluded.updated_at`,
    [market, cursorTimeMs, updatedAt]);
}

export async function beginRun(config, runId, startedAt, marketsRequested) {
  await d1(cf(config), `INSERT INTO account_journal_runs
    (run_id, started_at, status, markets_requested) VALUES (?, ?, 'running', ?)`,
  [runId, startedAt, marketsRequested]);
}

export async function finishRun(config, runId, result) {
  await d1(cf(config), `UPDATE account_journal_runs SET
      completed_at = ?, status = ?, symbols_requested = ?, fills_seen = ?,
      pages_read = ?, error_count = ?, error_summary = ?
    WHERE run_id = ?`, [result.completedAt, result.status, result.symbolsRequested,
    result.fillsSeen, result.pagesRead, result.errors.length,
    result.errors.length ? result.errors.slice(0, 20).join('\n').slice(0, 8000) : null,
    runId]);
}

export async function refreshAnalytics(config, nowIso) {
  await d1Batch(cf(config), [
    { sql: 'DELETE FROM account_journal_daily_fees' },
    { sql: `INSERT INTO account_journal_daily_fees
      (day, market, origin, symbol, commission_asset, commission_amount, refreshed_at)
      SELECT substr(event_time, 1, 10), market, origin, symbol, commission_asset,
             SUM(commission), ?
        FROM account_journal_fills
       WHERE commission IS NOT NULL AND commission_asset IS NOT NULL
       GROUP BY substr(event_time, 1, 10), market, origin, symbol, commission_asset`, params: [nowIso] },
    { sql: 'DELETE FROM account_journal_daily_stats' },
    { sql: `INSERT INTO account_journal_daily_stats
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
       GROUP BY substr(event_time, 1, 10), market, origin, symbol`, params: [nowIso] }
  ]);
}

export async function journalSummary(config, days = 30) {
  const cutoff = new Date(Date.now() - Math.max(1, days) * 86_400_000).toISOString().slice(0, 10);
  const [origins, recent, daily, fees, review, runs] = await Promise.all([
    d1(cf(config), 'SELECT * FROM account_journal_origin_summary ORDER BY market, origin'),
    d1(cf(config), `SELECT * FROM account_journal_fills
      WHERE origin IN ('manual','unknown') ORDER BY event_time DESC LIMIT 20`),
    d1(cf(config), `SELECT * FROM account_journal_daily_stats
      WHERE day >= ? AND origin IN ('manual','unknown') ORDER BY day DESC, market, symbol`, [cutoff]),
    d1(cf(config), `SELECT * FROM account_journal_daily_fees
      WHERE day >= ? AND origin IN ('manual','unknown') ORDER BY day DESC, commission_asset`, [cutoff]),
    d1(cf(config), 'SELECT COUNT(*) AS n FROM account_journal_review_queue'),
    d1(cf(config), 'SELECT * FROM account_journal_runs ORDER BY started_at DESC LIMIT 5')
  ]);
  return { origins, recent, daily, fees, reviewCount: Number(review[0]?.n || 0), runs };
}
