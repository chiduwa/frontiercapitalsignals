import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadConfig, WINDOWS } from './config.mjs';
import {
  createBinanceClient, incrementIdentifier, normalizeAlgoState,
  normalizeFuturesPosition, normalizeOrder, normalizeTrade, timeWindows
} from './binance.mjs';
import {
  attachProvenance, beginRun, finishRun, getCheckpoint, journalSummary,
  knownSymbols, loadAlgoExecutionOrders, loadClassificationEvidence,
  loadPendingAlgoStates, markAlgoPolled, persistAlgoStates,
  persistCurrentFuturesPositions, persistJournalPage, persistOrders,
  reclassifyJournalFills, refreshAnalytics
} from './store.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DAY_MS = 86_400_000;
const FUTURES_RETENTION_MS = 90 * DAY_MS;
const FUTURES_RETENTION_GUARD_MS = 60_000;

// A request built at exactly now-90d is already outside Binance's rolling
// window by the time it arrives. Re-clamp at each request, not just once at
// run start, because a full first import spans many symbols.
export function futuresRetentionStart(requestedStartMs, requestNowMs = Date.now()) {
  return Math.max(
    requestedStartMs,
    requestNowMs - FUTURES_RETENTION_MS + FUTURES_RETENTION_GUARD_MS
  );
}

function maxTradeId(rows) {
  if (!rows.length) return null;
  return rows.reduce((max, row) => BigInt(row.tradeId) > BigInt(max) ? row.tradeId : max, rows[0].tradeId);
}

function log(event, fields = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));
}

async function enrichMissingOrders(client, market, symbol, fills, orders, nowIso, concurrency = 3) {
  const byId = new Map(orders.map((order) => [String(order.orderId), order]));
  const missing = [...new Set(fills.map((fill) => String(fill.orderId)).filter((id) => !byId.has(id)))];
  let cursor = 0;
  async function worker() {
    while (cursor < missing.length) {
      const orderId = missing[cursor++];
      const path = market === 'spot' ? '/api/v3/order' : '/fapi/v1/order';
      try {
        const raw = await client.signedGet(path, { symbol, orderId });
        const order = normalizeOrder(market, raw, nowIso);
        if (order) byId.set(orderId, order);
      } catch (error) {
        log('order_enrichment_failed', { market, symbol, orderId, error: error.message });
      }
      await sleep(75);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, missing.length) }, worker));
  return [...byId.values()];
}

// Binance's standard and algo futures order histories are capped at 1000 rows
// and expose no reliable cross-window cursor. Recursively narrow only a
// saturated time window; never call a capped page complete. The shared budget
// bounds API use, and `through` lets the next timer resume without skipping an
// unread suffix.
export async function scanFuturesOrderWindow(fetchPage, start, end, budget, limit = 1000) {
  if (budget.remaining <= 0) return { rows: [], complete: false, through: start - 1, saturated: false };
  budget.remaining--;
  const page = await fetchPage(start, end);
  const rows = Array.isArray(page) ? page : [];
  if (rows.length < limit) return { rows, complete: true, through: end, saturated: false };
  if (start >= end) return { rows: [], complete: false, through: start - 1, saturated: true };

  const midpoint = start + Math.floor((end - start) / 2);
  const left = await scanFuturesOrderWindow(fetchPage, start, midpoint, budget, limit);
  if (!left.complete) return left;
  const right = await scanFuturesOrderWindow(fetchPage, midpoint + 1, end, budget, limit);
  return {
    rows: left.rows.concat(right.rows),
    complete: right.complete,
    through: right.complete ? end : Math.max(left.through, right.through),
    saturated: true
  };
}

export function mergeFuturesOrderProvenance(orders, algoExecutionOrders) {
  const merged = new Map((orders || []).map((order) => [`${order.symbol}|${order.orderId}`, order]));
  for (const algoOrder of algoExecutionOrders || []) {
    const key = `${algoOrder.symbol}|${algoOrder.orderId}`;
    const executionOrder = merged.get(key);
    if (!executionOrder) {
      merged.set(key, algoOrder);
      continue;
    }
    // Preserve the standard execution order's facts, but use the parent
    // conditional order's caller-chosen clientAlgoId for provenance.
    merged.set(key, {
      ...algoOrder,
      ...executionOrder,
      clientOrderId: algoOrder.clientOrderId || executionOrder.clientOrderId
    });
  }
  return [...merged.values()];
}

async function fetchFuturesOrders(config, client, nowMs, nowIso) {
  const checkpoint = await getCheckpoint(config, 'futures', '*', 'orders');
  const officialFloor = futuresRetentionStart(0, nowMs);
  const start = checkpoint?.cursorTimeMs != null
    ? Math.max(officialFloor, checkpoint.cursorTimeMs - config.timeOverlapMs)
    : Math.max(officialFloor, config.backfillStartMs);
  const all = [];
  let cursor = checkpoint?.cursorTimeMs ?? (start - 1);
  const budget = { remaining: config.maxOrderPages };
  for (const window of timeWindows(start, nowMs, WINDOWS.futures)) {
    const result = await scanFuturesOrderWindow(
      (windowStart, windowEnd) => client.signedGet('/fapi/v1/allOrders', {
        startTime: futuresRetentionStart(windowStart),
        endTime: windowEnd,
        limit: config.orderPageLimit
      }),
      window.start, window.end, budget, config.orderPageLimit
    );
    all.push(...result.rows.map((row) => normalizeOrder('futures', row, nowIso)).filter(Boolean));
    cursor = Math.max(cursor, result.through);
    if (!result.complete) {
      log('futures_order_backfill_pending', {
        throughTime: cursor >= start ? new Date(cursor).toISOString() : null,
        requestsUsed: config.maxOrderPages - budget.remaining,
        note: 'a saturated or request-budget-limited suffix was left uncheckpointed for the next timer'
      });
      break;
    }
    await sleep(125);
  }
  const deduped = [...new Map(all.map((order) => [`${order.symbol}|${order.orderId}`, order])).values()];
  await persistOrders(config, 'futures', deduped, cursor, nowIso);
  return deduped;
}

export async function fetchFuturesAlgoOrders(config, client, symbol, nowMs, nowIso) {
  const checkpoint = await getCheckpoint(config, 'futures', symbol, 'orders');
  const officialFloor = futuresRetentionStart(0, nowMs);
  const start = checkpoint?.cursorTimeMs != null
    ? Math.max(officialFloor, checkpoint.cursorTimeMs - config.timeOverlapMs)
    : Math.max(officialFloor, config.backfillStartMs);
  const allStates = [];
  let cursor = checkpoint?.cursorTimeMs ?? (start - 1);
  const budget = { remaining: config.maxOrderPages };
  for (const window of timeWindows(start, nowMs, WINDOWS.futures)) {
    const result = await scanFuturesOrderWindow(
      (windowStart, windowEnd) => client.signedGet('/fapi/v1/allAlgoOrders', {
        symbol,
        startTime: futuresRetentionStart(windowStart),
        endTime: windowEnd,
        limit: config.orderPageLimit
      }),
      window.start, window.end, budget, config.orderPageLimit
    );
    allStates.push(...result.rows
      .map((row) => normalizeAlgoState(row, nowIso))
      .filter(Boolean));
    cursor = Math.max(cursor, result.through);
    if (!result.complete) {
      log('futures_algo_order_backfill_pending', {
        symbol,
        throughTime: cursor >= start ? new Date(cursor).toISOString() : null,
        requestsUsed: config.maxOrderPages - budget.remaining,
        note: 'a saturated or request-budget-limited suffix was left uncheckpointed for the next timer'
      });
      break;
    }
    await sleep(125);
  }
  const states = [...new Map(allStates.map((state) => [`${state.symbol}|${state.algoId}`, state])).values()];
  await persistAlgoStates(config, states);

  // A time-window history response cannot safely be assumed to rediscover an
  // older parent when actualOrderId appears days later, so poll each retained
  // non-terminal parent by its exact immutable identity.
  const pending = await loadPendingAlgoStates(
    config, symbol, config.maxAlgoPollsPerSymbol
  );
  const refreshed = [];
  let polls = 0;
  for (const state of pending) {
    const params = state.clientAlgoId
      ? { clientAlgoId: state.clientAlgoId }
      : { algoId: state.algoId };
    try {
      polls++;
      const raw = await client.signedGet('/fapi/v1/algoOrder', params);
      const current = normalizeAlgoState(raw, nowIso);
      if (!current || current.symbol !== state.symbol || current.algoId !== state.algoId) {
        throw new Error(`Binance returned mismatched algo identity for ${symbol}:${state.algoId}`);
      }
      refreshed.push(current);
    } catch (error) {
      if (![ -2013, -2011 ].includes(Number(error.binanceCode))) throw error;
      // Filled conditional orders remain queryable for 90 days. A not-found
      // parent older than Binance's documented three-day unfilled retention
      // can therefore be retired without hiding a fill-bearing order.
      const olderThanUnfilledRetention = Number.isFinite(state.createTimeMs)
        && state.createTimeMs <= nowMs - 3 * 86_400_000;
      await markAlgoPolled(
        config, state.symbol, state.algoId, nowIso, olderThanUnfilledRetention
      );
      log('futures_algo_exact_query_unavailable', {
        symbol: state.symbol,
        algoId: state.algoId,
        pollingClosed: olderThanUnfilledRetention,
        binanceCode: Number(error.binanceCode)
      });
    }
    await sleep(75);
  }
  await persistAlgoStates(config, refreshed, nowIso);

  const executionOrders = await loadAlgoExecutionOrders(config, symbol, nowIso);
  await persistJournalPage(config, {
    market: 'futures', symbol, orders: executionOrders, stream: 'orders',
    cursorTimeMs: cursor, updatedAt: nowIso
  });
  return {
    orders: executionOrders,
    pages: config.maxOrderPages - budget.remaining + polls
  };
}

async function fetchFuturesTrades(config, client, symbol, nowMs, nowIso, discoveredOrders) {
  const checkpoint = await getCheckpoint(config, 'futures', symbol, 'trades');
  const rawRows = [];
  let pages = 0;
  if (checkpoint?.lastTradeId) {
    let fromId = incrementIdentifier(checkpoint.lastTradeId);
    while (pages < config.maxPagesPerSymbol) {
      const page = await client.signedGet('/fapi/v1/userTrades', { symbol, fromId, limit: config.tradePageLimit });
      rawRows.push(...page); pages++;
      if (page.length < config.tradePageLimit) break;
      fromId = incrementIdentifier(page[page.length - 1].id);
      await sleep(125);
    }
  } else {
    const officialFloor = futuresRetentionStart(0, nowMs);
    const start = checkpoint?.cursorTimeMs != null
      ? Math.max(officialFloor, checkpoint.cursorTimeMs - config.timeOverlapMs)
      : Math.max(officialFloor, config.backfillStartMs);
    let caughtUpById = false;
    for (const window of timeWindows(start, nowMs, WINDOWS.futures)) {
      if (pages >= config.maxPagesPerSymbol) break;
      const page = await client.signedGet('/fapi/v1/userTrades', {
        symbol,
        startTime: futuresRetentionStart(window.start),
        endTime: window.end,
        limit: config.tradePageLimit
      });
      rawRows.push(...page); pages++;
      if (page.length === config.tradePageLimit) {
        let fromId = incrementIdentifier(page[page.length - 1].id);
        while (pages < config.maxPagesPerSymbol) {
          const next = await client.signedGet('/fapi/v1/userTrades', { symbol, fromId, limit: config.tradePageLimit });
          rawRows.push(...next); pages++;
          if (next.length < config.tradePageLimit) break;
          fromId = incrementIdentifier(next[next.length - 1].id);
        }
        caughtUpById = true;
      }
      if (caughtUpById) break;
      await sleep(125);
    }
  }
  const fills = [...new Map(rawRows
    .map((row) => normalizeTrade('futures', row, nowIso)).filter(Boolean)
    .map((fill) => [fill.tradeId, fill])).values()];
  let orders = discoveredOrders.filter((order) => order.symbol === symbol);
  orders = await enrichMissingOrders(client, 'futures', symbol, fills, orders, nowIso);
  const evidence = await loadClassificationEvidence(config, 'futures', symbol);
  const classified = attachProvenance(fills, orders, evidence, config);
  await persistJournalPage(config, {
    market: 'futures', symbol, orders, fills: classified,
    lastTradeId: maxTradeId(classified) || checkpoint?.lastTradeId || null,
    cursorTimeMs: nowMs, updatedAt: nowIso
  });
  return { fills: classified.length, pages };
}

async function spotUniverse(config, client) {
  const [account, exchange, known] = await Promise.all([
    client.signedGet('/api/v3/account', { omitZeroBalances: true }),
    client.publicGet('/api/v3/exchangeInfo'),
    knownSymbols(config, 'spot')
  ]);
  const tradable = new Set((exchange?.symbols || [])
    .filter((row) => row.status === 'TRADING' && row.quoteAsset === config.spot.quoteAsset)
    .map((row) => row.symbol));
  const fromBalances = (account?.balances || [])
    .filter((row) => Number(row.free) + Number(row.locked) > 0 && row.asset !== config.spot.quoteAsset)
    .map((row) => `${row.asset}${config.spot.quoteAsset}`);
  return [...new Set([...config.spot.configuredSymbols, ...known, ...fromBalances])]
    .filter((symbol) => tradable.has(symbol)).sort();
}

async function fetchSpotTrades(config, client, symbol, nowMs, nowIso) {
  const checkpoint = await getCheckpoint(config, 'spot', symbol, 'trades');
  const rawRows = [];
  let pages = 0;
  if (checkpoint?.lastTradeId) {
    let fromId = incrementIdentifier(checkpoint.lastTradeId);
    while (pages < config.maxPagesPerSymbol) {
      const page = await client.signedGet('/api/v3/myTrades', { symbol, fromId, limit: config.tradePageLimit });
      rawRows.push(...page); pages++;
      if (page.length < config.tradePageLimit) break;
      fromId = incrementIdentifier(page[page.length - 1].id);
      await sleep(125);
    }
  } else if (checkpoint?.cursorTimeMs != null) {
    const startTime = Math.max(checkpoint.cursorTimeMs - config.timeOverlapMs, nowMs - WINDOWS.spot + 1);
    const page = await client.signedGet('/api/v3/myTrades', { symbol, startTime, endTime: nowMs, limit: config.tradePageLimit });
    rawRows.push(...page); pages++;
  } else {
    // Binance exposes no account-wide spot trade list. One recent-history
    // request per known/configured symbol retrieves up to the documented
    // 1000-row limit without issuing 90 daily requests per symbol.
    const page = await client.signedGet('/api/v3/myTrades', { symbol, limit: config.tradePageLimit });
    rawRows.push(...page); pages++;
    if (page.length === config.tradePageLimit) {
      log('spot_history_at_limit', {
        symbol,
        note: 'the newest 1000 fills were retrieved; add an exported Binance statement for older history rather than guessing it is complete'
      });
    }
  }
  const fills = [...new Map(rawRows
    .map((row) => normalizeTrade('spot', row, nowIso)).filter(Boolean)
    .map((fill) => [fill.tradeId, fill])).values()];

  let orders = [];
  if (fills.length) {
    const minimumOrder = fills.reduce((min, fill) => BigInt(fill.orderId) < BigInt(min) ? fill.orderId : min, fills[0].orderId);
    const rawOrders = await client.signedGet('/api/v3/allOrders', { symbol, orderId: minimumOrder, limit: config.orderPageLimit });
    orders = rawOrders.map((row) => normalizeOrder('spot', row, nowIso)).filter(Boolean);
    orders = await enrichMissingOrders(client, 'spot', symbol, fills, orders, nowIso);
  }
  const evidence = await loadClassificationEvidence(config, 'spot', symbol);
  const classified = attachProvenance(fills, orders, evidence, config);
  await persistJournalPage(config, {
    market: 'spot', symbol, orders, fills: classified,
    lastTradeId: maxTradeId(classified) || checkpoint?.lastTradeId || null,
    cursorTimeMs: nowMs, updatedAt: nowIso
  });
  return { fills: classified.length, pages };
}

export async function runJournal(environment = process.env, nowMs = Date.now()) {
  const config = loadConfig(environment, nowMs);
  const nowIso = new Date(nowMs).toISOString();
  const runId = randomUUID();
  const marketsRequested = Number(!!config.futures) + Number(!!config.spot);
  const result = { symbolsRequested: 0, fillsSeen: 0, pagesRead: 0, errors: [] };
  await beginRun(config, runId, nowIso, marketsRequested);

  try {
    if (config.futures) {
      const client = createBinanceClient({ ...config.futures, requestTimeoutMs: config.requestTimeoutMs });
      let orders = [];
      try { orders = await fetchFuturesOrders(config, client, nowMs, nowIso); }
      catch (error) { result.errors.push(`futures order discovery: ${error.message}`); }
      let active = null;
      try { active = await client.signedGet('/fapi/v3/positionRisk'); }
      catch (error) { result.errors.push(`futures position discovery: ${error.message}`); }
      const exchange = await client.publicGet('/fapi/v1/exchangeInfo').catch((error) => {
        result.errors.push(`futures exchange-info discovery: ${error.message}`); return null;
      });
      const tradable = exchange ? new Set((exchange.symbols || [])
        .filter((row) => row.status === 'TRADING' && row.quoteAsset === 'USDT')
        .map((row) => row.symbol)) : null;
      const symbols = [...new Set([
        ...config.futures.configuredSymbols,
        ...await knownSymbols(config, 'futures'),
        ...orders.map((order) => order.symbol),
        ...(active || []).filter((row) => Math.abs(Number(row.positionAmt)) > 0).map((row) => row.symbol)
      ])].filter((symbol) => !tradable || tradable.has(symbol)).sort();
      result.symbolsRequested += symbols.length;
      for (const symbol of symbols) {
        let symbolOrders = orders.filter((order) => order.symbol === symbol);
        try {
          const algo = await fetchFuturesAlgoOrders(config, client, symbol, nowMs, nowIso);
          symbolOrders = mergeFuturesOrderProvenance(symbolOrders, algo.orders);
          result.pagesRead += algo.pages;
        } catch (error) {
          result.errors.push(`futures ${symbol} algo-order discovery: ${error.message}`);
        }
        try {
          const counts = await fetchFuturesTrades(config, client, symbol, nowMs, nowIso, symbolOrders);
          result.fillsSeen += counts.fills; result.pagesRead += counts.pages;
        } catch (error) { result.errors.push(`futures ${symbol}: ${error.message}`); }
      }
      if (active) {
        try {
          const current = active.map((row) => normalizeFuturesPosition(row, nowIso)).filter(Boolean);
          const classified = await persistCurrentFuturesPositions(config, current, nowIso);
          log('journal_current_positions', {
            count: classified.length,
            bot: classified.filter((position) => position.origin === 'bot').length,
            externalUnknown: classified.filter((position) => position.origin !== 'bot').length
          });
        } catch (error) {
          result.errors.push(`futures current-position snapshot: ${error.message}`);
        }
      }
    }

    if (config.spot) {
      const client = createBinanceClient({ ...config.spot, requestTimeoutMs: config.requestTimeoutMs });
      let symbols = [];
      try { symbols = await spotUniverse(config, client); }
      catch (error) { result.errors.push(`spot symbol discovery: ${error.message}`); }
      result.symbolsRequested += symbols.length;
      for (const symbol of symbols) {
        try {
          const counts = await fetchSpotTrades(config, client, symbol, nowMs, nowIso);
          result.fillsSeen += counts.fills; result.pagesRead += counts.pages;
        } catch (error) { result.errors.push(`spot ${symbol}: ${error.message}`); }
      }
    }

    const reclassified = await reclassifyJournalFills(config);
    log('journal_provenance_refreshed', reclassified);
    await refreshAnalytics(config, nowIso);
    const summary = await journalSummary(config, config.summaryDays);
    log('journal_summary', {
      runId, fillsSeen: result.fillsSeen, symbolsRequested: result.symbolsRequested,
      reviewQueue: summary.reviewCount,
      origins: summary.origins.map((row) => ({
        market: row.market, origin: row.origin, fills: row.fill_count,
        orders: row.order_count, futuresRealizedPnl: row.realized_pnl
      }))
    });
  } catch (error) {
    result.errors.push(`run: ${error.message}`);
  }

  const status = result.errors.length ? (result.fillsSeen ? 'partial' : 'failed') : 'ok';
  await finishRun(config, runId, { ...result, status, completedAt: new Date().toISOString() });
  if (result.errors.length) throw new Error(`journal ${status}: ${result.errors.join('; ')}`);
  return { runId, status, ...result };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  runJournal().catch((error) => {
    console.error(JSON.stringify({ at: new Date().toISOString(), event: 'journal_failed', error: error.message }));
    process.exitCode = 1;
  });
}
