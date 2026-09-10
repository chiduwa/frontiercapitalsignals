import { createHmac } from 'node:crypto';
import { parseBinanceJson } from '../../shared/binance-json.mjs';

export { parseBinanceJson };

function requestParams(params) {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value != null && value !== '') out.set(key, String(value));
  }
  return out;
}

export function createBinanceClient({ key, secret, base, requestTimeoutMs = 20_000, fetchImpl = fetch }) {
  if (!key || !secret || !base) throw new Error('Binance client requires key, secret, and base URL');

  async function get(path, params = {}, signed = true) {
    const query = requestParams(params);
    if (signed) {
      query.set('recvWindow', '10000');
      query.set('timestamp', String(Date.now()));
      query.set('signature', createHmac('sha256', secret).update(query.toString()).digest('hex'));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    let response;
    try {
      response = await fetchImpl(`${base}${path}?${query.toString()}`, {
        headers: signed ? { 'X-MBX-APIKEY': key } : {},
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
    const body = await response.text()
      .then((text) => parseBinanceJson(text))
      .catch(() => null);
    if (!response.ok) {
      const error = new Error(`Binance GET ${path} failed: HTTP ${response.status} ${JSON.stringify(body)}`);
      error.httpStatus = response.status;
      error.binanceCode = body?.code ?? null;
      throw error;
    }
    return body;
  }

  return {
    signedGet: (path, params) => get(path, params, true),
    publicGet: (path, params) => get(path, params, false)
  };
}

export function incrementIdentifier(value) {
  try { return (BigInt(String(value)) + 1n).toString(); }
  catch { throw new Error(`invalid Binance identifier: ${JSON.stringify(value)}`); }
}

export function isoFromMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  try { return new Date(n).toISOString(); }
  catch { return null; }
}

function finiteNumber(value, { positive = false, nonnegative = false } = {}) {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (positive && !(n > 0)) return null;
  if (nonnegative && n < 0) return null;
  return n;
}

function positiveIdentifier(value) {
  const id = value == null ? '' : String(value).trim();
  try { return id && BigInt(id) > 0n ? id : null; }
  catch { return null; }
}

export function normalizeOrder(market, row, ingestedAt) {
  const symbol = String(row?.symbol || '').toUpperCase();
  const orderId = row?.orderId == null ? '' : String(row.orderId);
  if (!symbol || !orderId) return null;
  const orderTime = isoFromMs(row.time ?? row.transactTime ?? row.updateTime);
  const updatedTime = isoFromMs(row.updateTime ?? row.time ?? row.transactTime);
  return {
    market, symbol, orderId,
    clientOrderId: row.clientOrderId || row.origClientOrderId || null,
    side: row.side === 'BUY' || row.side === 'SELL' ? row.side : null,
    orderType: row.type || row.origType || null,
    status: row.status || null,
    orderTime,
    updatedTime,
    ingestedAt
  };
}

// Binance USDⓈ-M conditional orders are now submitted through the Algo
// Order API. Once triggered, `actualOrderId` is the order ID referenced by
// userTrades while `clientAlgoId` retains the caller-chosen provenance ID.
// Parent state is retained even before trigger so its exact identity can be
// polled without pretending its blank actualOrderId is an execution order.
export function normalizeAlgoState(row, ingestedAt) {
  const symbol = String(row?.symbol || '').toUpperCase();
  const algoId = positiveIdentifier(row?.algoId);
  if (!symbol || !algoId) return null;
  const actualOrderId = positiveIdentifier(row?.actualOrderId);
  const createTimeMs = finiteNumber(row?.createTime, { nonnegative: true });
  const updateTimeMs = finiteNumber(row?.updateTime, { nonnegative: true });
  const triggerTimeMs = finiteNumber(row?.triggerTime, { nonnegative: true });
  return {
    symbol,
    algoId,
    clientAlgoId: row?.clientAlgoId || null,
    actualOrderId,
    side: row?.side === 'BUY' || row?.side === 'SELL' ? row.side : null,
    orderType: row?.orderType || row?.type || null,
    actualType: row?.actualType || null,
    algoStatus: row?.algoStatus || null,
    createTimeMs,
    updateTimeMs,
    triggerTimeMs,
    ingestedAt
  };
}

export function normalizeAlgoExecutionOrder(row, ingestedAt) {
  const state = normalizeAlgoState(row, ingestedAt);
  // Only a real triggered execution ID can join userTrades. Never insert an
  // untriggered algo's blank/zero placeholder into the execution-order ledger.
  if (!state?.actualOrderId) return null;
  return {
    market: 'futures',
    symbol: state.symbol,
    orderId: state.actualOrderId,
    clientOrderId: state.clientAlgoId,
    side: state.side,
    // `actualType` is present on the exact query after trigger. Fall back to
    // the parent conditional type only when that execution fact is absent.
    orderType: row?.actualType || state.orderType,
    // algoStatus describes the parent algo, not the execution order.
    status: row?.actualOrderStatus || row?.status || null,
    orderTime: state.triggerTimeMs > 0 ? isoFromMs(state.triggerTimeMs) : null,
    updatedTime: isoFromMs(state.updateTimeMs),
    ingestedAt
  };
}

export function normalizeTrade(market, row, ingestedAt) {
  const symbol = String(row?.symbol || '').toUpperCase();
  const tradeId = row?.id == null ? '' : String(row.id);
  const orderId = row?.orderId == null ? '' : String(row.orderId);
  const eventTime = isoFromMs(row?.time);
  const price = finiteNumber(row?.price, { positive: true });
  const quantity = finiteNumber(row?.qty, { positive: true });
  if (!symbol || !tradeId || !orderId || !eventTime || price == null || quantity == null) return null;
  const side = market === 'spot' ? (row.isBuyer ? 'BUY' : 'SELL') : row.side;
  if (side !== 'BUY' && side !== 'SELL') return null;
  const quoteQuantity = finiteNumber(row.quoteQty, { nonnegative: true }) ?? price * quantity;
  return {
    market, symbol, tradeId, orderId, clientOrderId: null, eventTime, side,
    positionSide: market === 'futures' && ['BOTH', 'LONG', 'SHORT'].includes(row.positionSide)
      ? row.positionSide : null,
    price, quantity, quoteQuantity,
    realizedPnl: market === 'futures' ? finiteNumber(row.realizedPnl) : null,
    commission: finiteNumber(row.commission, { nonnegative: true }),
    commissionAsset: row.commissionAsset || null,
    isMaker: typeof row.maker === 'boolean' ? row.maker
      : typeof row.isMaker === 'boolean' ? row.isMaker : null,
    ingestedAt
  };
}

// A read-only snapshot of an actually open USDⓈ-M position. Provenance is
// attached separately from durable bot state; this normalizer records only
// exchange facts and never assumes that an unmatched position is manual.
export function normalizeFuturesPosition(row, observedAt) {
  const symbol = String(row?.symbol || '').toUpperCase();
  const positionAmt = finiteNumber(row?.positionAmt);
  const positionSide = ['BOTH', 'LONG', 'SHORT'].includes(row?.positionSide)
    ? row.positionSide : null;
  if (!symbol || positionAmt == null || positionAmt === 0 || !positionSide
      || !isoFromMs(Date.parse(observedAt))) {
    return null;
  }
  const side = positionAmt > 0 ? 'BUY' : 'SELL';
  return {
    symbol, positionSide, side, positionAmt,
    quantity: Math.abs(positionAmt),
    entryPrice: finiteNumber(row.entryPrice, { positive: true }),
    breakEvenPrice: finiteNumber(row.breakEvenPrice, { positive: true }),
    markPrice: finiteNumber(row.markPrice, { positive: true }),
    unrealizedPnl: finiteNumber(row.unRealizedProfit ?? row.unrealizedProfit),
    liquidationPrice: finiteNumber(row.liquidationPrice, { positive: true }),
    leverage: finiteNumber(row.leverage, { positive: true }),
    marginType: row.marginType == null ? null : String(row.marginType),
    isolatedMargin: finiteNumber(row.isolatedMargin, { nonnegative: true }),
    notional: finiteNumber(row.notional),
    observedAt
  };
}

export function timeWindows(startMs, endMs, widthMs) {
  if (![startMs, endMs, widthMs].every(Number.isFinite) || widthMs <= 0 || endMs < startMs) return [];
  const out = [];
  for (let start = startMs; start <= endMs; start += widthMs) {
    out.push({ start, end: Math.min(endMs, start + widthMs - 1) });
  }
  return out;
}
