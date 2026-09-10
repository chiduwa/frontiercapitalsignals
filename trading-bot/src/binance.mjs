// Signed Binance USDS-M Futures REST client. Minimal by design — only the
// endpoints this bot actually needs, no SDK dependency (matches the rest
// of this project's style of plain fetch + manual signing, see
// signals-worker/scripts/d1-client.mjs).
//
// IMPORTANT, confirmed live via Binance's own current docs (2026-08):
// as of 2025-12-09, Binance migrated conditional orders (STOP_MARKET /
// TAKE_PROFIT_MARKET) to a separate Algo Order API — the old
// POST /fapi/v1/order now REJECTS those types with error -4120. Plain
// Normal MARKET/LIMIT orders are unaffected and still go through
// /fapi/v1/order; stop-loss/take-profit protection orders go through the new
// POST /fapi/v1/algoOrder instead. Getting this wrong would mean a
// protective stop silently fails to place on a leveraged position, so
// this was verified against Binance's current documentation before
// writing this file, not assumed from training data.
import { createHash, createHmac } from 'node:crypto';
import { config } from './config.mjs';
import { parseBinanceJson } from '../../shared/binance-json.mjs';

let exchangeInfoCache = null;
const BINANCE_REQUEST_TIMEOUT_MS = 20000;

async function signedRequest(method, path, params = {}) {
  const query = new URLSearchParams({ ...params, timestamp: Date.now(), recvWindow: 10000 });
  const signature = createHmac('sha256', config.binanceApiSecret).update(query.toString()).digest('hex');
  query.set('signature', signature);
  const url = `${config.binanceBase}${path}?${query.toString()}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BINANCE_REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method, headers: { 'X-MBX-APIKEY': config.binanceApiKey }, signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
  const body = await res.text().then(parseBinanceJson).catch(() => null);
  if (!res.ok) {
    const error = new Error(`Binance ${method} ${path} failed: HTTP ${res.status} ${JSON.stringify(body)}`);
    error.httpStatus = res.status;
    error.binanceCode = body?.code ?? null;
    error.binanceBody = body;
    throw error;
  }
  return body;
}

// Binance accepts at most 36 characters from a restricted ASCII alphabet.
// Hashing an immutable intent makes retries address the same exchange order
// without putting prices, account data, or secrets into logs/order history.
export function makeClientOrderId(kind, ...intentParts) {
  const tag = String(kind).toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 5) || 'order';
  const digest = createHash('sha256').update(intentParts.map((v) => String(v ?? '')).join('\u001f')).digest('hex').slice(0, 24);
  return `fcsf-${tag}-${digest}`;
}

export const isLegacyAssistedProtectionId = (value) =>
  typeof value === 'string' && value.startsWith('fcsa-');
export const isFuturesBotOrderId = (value) =>
  typeof value === 'string' && value.startsWith('fcsf-');

async function publicRequest(path, params = {}) {
  const query = new URLSearchParams(params);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BINANCE_REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${config.binanceBase}${path}?${query.toString()}`, {
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
  const body = await res.text().then(parseBinanceJson).catch(() => null);
  if (!res.ok) throw new Error(`Binance GET ${path} failed: HTTP ${res.status} ${JSON.stringify(body)}`);
  return body;
}

// Symbol precision (LOT_SIZE step size, PRICE_FILTER tick size) — orders
// get rejected if quantity/price aren't rounded to these exactly. Cached
// for the process lifetime; exchange filters don't change intra-session.
export async function getExchangeInfo() {
  if (exchangeInfoCache) return exchangeInfoCache;
  const info = await publicRequest('/fapi/v1/exchangeInfo');
  const bySymbol = {};
  for (const s of info.symbols) {
    const lot = s.filters.find((f) => f.filterType === 'LOT_SIZE');
    const price = s.filters.find((f) => f.filterType === 'PRICE_FILTER');
    bySymbol[s.symbol] = {
      status: s.status,
      contractType: s.contractType,
      baseAsset: s.baseAsset,
      quoteAsset: s.quoteAsset,
      marginAsset: s.marginAsset,
      underlyingType: s.underlyingType ?? null,
      underlyingSubType: Array.isArray(s.underlyingSubType) ? s.underlyingSubType : [],
      permissionSets: Array.isArray(s.permissionSets) ? s.permissionSets : [],
      orderTypes: Array.isArray(s.orderTypes) ? s.orderTypes : [],
      timeInForce: Array.isArray(s.timeInForce) ? s.timeInForce : [],
      quantityStep: Number(lot?.stepSize || 1),
      quantityPrecision: s.quantityPrecision,
      pricePrecision: s.pricePrecision,
      priceStep: Number(price?.tickSize || 0.01)
    };
  }
  exchangeInfoCache = bySymbol;
  return bySymbol;
}

// A ticker suffix is not proof that the exchange contract represents the
// same instrument as the model row. In particular, Binance's equity and
// commodity futures are TRADIFI_PERPETUAL contracts rather than ordinary
// crypto PERPETUAL contracts. Require the exact class metadata as well as the
// bare model symbol before an execution candidate can reach sizing.
export function marketEligibleForAssetClass(market, assetClass, signalSymbol) {
  if (!market || !signalSymbol) return false;
  const orderTypes = Array.isArray(market.orderTypes) ? market.orderTypes : [];
  const timeInForce = Array.isArray(market.timeInForce) ? market.timeInForce : [];
  const underlyingSubType = Array.isArray(market.underlyingSubType)
    ? market.underlyingSubType : [];
  const permissionSets = Array.isArray(market.permissionSets) ? market.permissionSets : [];
  const common = market.status === 'TRADING'
    && market.baseAsset === String(signalSymbol).toUpperCase()
    && market.quoteAsset === 'USDT'
    && market.marginAsset === 'USDT'
    && orderTypes.includes('LIMIT')
    && timeInForce.includes('GTD');
  if (!common) return false;
  if (assetClass === 'crypto') {
    return market.contractType === 'PERPETUAL' && market.underlyingType === 'COIN';
  }
  const tradFiTagged = underlyingSubType.includes('TradFi')
    || permissionSets.includes('TRADFI');
  if (assetClass === 'stock') {
    return market.contractType === 'TRADIFI_PERPETUAL'
      && market.underlyingType === 'EQUITY' && tradFiTagged;
  }
  if (assetClass === 'commodity') {
    return market.contractType === 'TRADIFI_PERPETUAL'
      && market.underlyingType === 'COMMODITY' && tradFiTagged;
  }
  return false;
}

function roundToStep(value, step, precision) {
  const rounded = Math.floor(value / step) * step;
  return Number(rounded.toFixed(precision));
}

export async function roundQuantity(symbol, quantity) {
  const info = (await getExchangeInfo())[symbol];
  if (!info) throw new Error(`no exchange info for ${symbol}`);
  return roundToStep(quantity, info.quantityStep, info.quantityPrecision);
}

export async function roundPrice(symbol, price) {
  const info = (await getExchangeInfo())[symbol];
  if (!info) throw new Error(`no exchange info for ${symbol}`);
  return roundToStep(price, info.priceStep, info.pricePrecision);
}

// A SELL resting above the signal must round upward or it silently moves
// closer than the measured offset. BUY rounds downward for the symmetric
// reason. Protective triggers keep their existing conservative floor helper.
export function roundLimitToStep(price, side, priceStep, pricePrecision) {
  const raw = Number(price);
  const step = Number(priceStep);
  if (!Number.isFinite(raw) || !(raw > 0) || !Number.isFinite(step) || !(step > 0)
      || !Number.isInteger(pricePrecision) || pricePrecision < 0
      || !['BUY', 'SELL'].includes(side)) return NaN;
  const units = side === 'SELL'
    ? Math.ceil((raw / step) - 1e-12)
    : Math.floor((raw / step) + 1e-12);
  return Number((units * step).toFixed(pricePrecision));
}

export async function roundLimitPrice(symbol, price, side) {
  const info = (await getExchangeInfo())[symbol];
  if (!info) throw new Error(`no exchange info for ${symbol}`);
  return roundLimitToStep(price, side, info.priceStep, info.pricePrecision);
}

// v3 is Binance's current recommended account/balance endpoint (v2 still
// works but is the older version) — confirmed against current docs.
export async function getAccount() {
  return signedRequest('GET', '/fapi/v3/account');
}

export async function getPositionRisk(symbol) {
  return signedRequest('GET', '/fapi/v3/positionRisk', symbol ? { symbol } : {});
}

export async function getPositionAmount(symbol) {
  const rows = await getPositionRisk(symbol);
  const active = (Array.isArray(rows) ? rows : [rows]).filter((r) => Math.abs(Number(r?.positionAmt)) > 0);
  const oneWay = active.find((r) => !r.positionSide || r.positionSide === 'BOTH');
  if (oneWay) return Number(oneWay.positionAmt);
  if (active.length <= 1) return Number(active[0]?.positionAmt || 0);
  throw new Error(`multiple hedge-mode positions found for ${symbol}; the bot requires one-way mode`);
}

// Entry price and leverage per symbol.
//
// These are NOT in /fapi/v3/account's `positions` entries — confirmed live
// 2026-09-05, whose keys are only symbol, positionSide, positionAmt,
// unrealizedProfit, isolatedMargin, notional, isolatedWallet, initialMargin,
// maintMargin, updateTime. Reading entryPrice from there yields NaN, which
// propagated into a stop-loss trigger price of NaN and would have left a live
// leveraged position unprotected. positionRisk is the endpoint that carries
// them.
export async function getPositionRiskMap() {
  const rows = await getPositionRisk();
  const out = {};
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || !r.symbol) continue;
    out[r.symbol] = {
      entryPrice: Number(r.entryPrice),
      leverage: Number(r.leverage),
      markPrice: Number(r.markPrice),
      liquidationPrice: Number(r.liquidationPrice)
    };
  }
  return out;
}

export async function setLeverage(symbol, leverage) {
  return signedRequest('POST', '/fapi/v1/leverage', { symbol, leverage: Math.round(leverage) });
}

// Realized P&L, commission and funding for one symbol since a given time,
// straight from Binance's own income ledger. Deliberately not inferred from
// entry/exit prices: fees and funding are real costs, and an edge that only
// exists gross of them is not an edge.
const MAX_ACCOUNT_HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000 - 1;

export function boundedHistoryWindows(startMs, endMs, maxWindowMs = MAX_ACCOUNT_HISTORY_WINDOW_MS) {
  const start = Math.max(0, Math.floor(Number(startMs)));
  const end = Math.floor(Number(endMs));
  const width = Math.floor(Number(maxWindowMs));
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(width)
      || end < start || width < 1) return [];
  const windows = [];
  for (let cursor = start; cursor <= end;) {
    const windowEnd = Math.min(end, cursor + width);
    windows.push({ startTime: cursor, endTime: windowEnd });
    cursor = windowEnd + 1;
  }
  return windows;
}

export async function getIncomeSince(symbol, startMs, endMs = Date.now()) {
  const all = [];
  for (const window of boundedHistoryWindows(startMs, endMs)) {
    for (let page = 1; page <= 100; page++) {
      const rows = await signedRequest('GET', '/fapi/v1/income', {
        symbol, ...window, page, limit: 1000
      });
      const batch = Array.isArray(rows) ? rows : [];
      all.push(...batch);
      if (batch.length < 1000) break;
      if (page === 100) throw new Error(`income history pagination exceeded 100 pages for ${symbol}`);
    }
  }
  const unique = [...new Map(all.map((row) => [
    [row?.incomeType, row?.tranId, row?.tradeId, row?.time, row?.income, row?.symbol].join('\u001f'), row
  ])).values()];
  const totals = {
    realizedPnl: 0, commission: 0, fundingFee: 0, rows: 0,
    byAsset: {}
  };
  for (const r of unique) {
    const v = Number(r.income);
    if (!Number.isFinite(v)) continue;
    const asset = String(r.asset || 'UNKNOWN');
    if (!totals.byAsset[asset]) {
      totals.byAsset[asset] = { realizedPnl: 0, commission: 0, fundingFee: 0, rows: 0 };
    }
    const assetTotals = totals.byAsset[asset];
    totals.rows++;
    assetTotals.rows++;
    if (r.incomeType === 'REALIZED_PNL') {
      totals.realizedPnl += v;
      assetTotals.realizedPnl += v;
    } else if (r.incomeType === 'COMMISSION') {
      totals.commission += v;
      assetTotals.commission += v;
    } else if (r.incomeType === 'FUNDING_FEE') {
      totals.fundingFee += v;
      assetTotals.fundingFee += v;
    }
  }
  totals.netPnl = totals.realizedPnl + totals.commission + totals.fundingFee;
  return totals;
}

// Fills for one symbol since a time — used to recover the average exit price
// of a position the bot did not close itself (a stop, a target, or the
// operator closing by hand).
async function getUserTradesWindow(symbol, startTime, endTime, depth = 0) {
  const rows = await signedRequest('GET', '/fapi/v1/userTrades', {
    symbol, startTime, endTime, limit: 1000
  });
  const batch = Array.isArray(rows) ? rows : [];
  if (batch.length < 1000) return batch;
  if (depth >= 24 || endTime <= startTime) {
    throw new Error(`saturated account-trade history could not be proven complete for ${symbol}`);
  }
  const midpoint = Math.floor((startTime + endTime) / 2);
  // Sequential recursion deliberately bounds request pressure. A saturated
  // interval is already exceptional; turning every split into a parallel
  // fan-out can exceed Binance's request-weight limits exactly while outcome
  // capture is trying to preserve a real trade.
  const left = await getUserTradesWindow(symbol, startTime, midpoint, depth + 1);
  const right = await getUserTradesWindow(symbol, midpoint + 1, endTime, depth + 1);
  return [...left, ...right];
}

export async function getUserTradesSince(symbol, startMs, endMs = Date.now()) {
  const all = [];
  for (const window of boundedHistoryWindows(startMs, endMs)) {
    all.push(...await getUserTradesWindow(symbol, window.startTime, window.endTime));
  }
  return [...new Map(all.map((row) => [String(row?.id), row])).values()];
}

// Exact fills for one order. This is preferable to inferring a fill time from
// the order's updateTime: after a partial fill is canceled, updateTime is the
// cancellation time rather than the first moment capital was at risk.
export async function getUserTradesForOrder(symbol, orderId) {
  if (!symbol || orderId == null || String(orderId) === '') {
    throw new Error('getUserTradesForOrder requires symbol and orderId');
  }
  return signedRequest('GET', '/fapi/v1/userTrades', {
    symbol, orderId: String(orderId), limit: 1000
  });
}

export async function getMarkPrice(symbol) {
  const r = await publicRequest('/fapi/v1/premiumIndex', { symbol });
  const price = r?.markPrice == null ? null : Number(r.markPrice);
  const fundingRate = r?.lastFundingRate == null ? null : Number(r.lastFundingRate);
  return {
    price: Number.isFinite(price) && price > 0 ? price : null,
    fundingRate: Number.isFinite(fundingRate) ? fundingRate : null
  };
}

// Plain market entry — NOT affected by the Dec 2025 conditional-order
// migration (only STOP_MARKET/TAKE_PROFIT_MARKET moved to algoOrder).
export async function placeMarketOrder(symbol, side, quantity, { clientOrderId, reduceOnly = false } = {}) {
  const params = { symbol, side, type: 'MARKET', quantity, newOrderRespType: 'RESULT' };
  if (clientOrderId) params.newClientOrderId = clientOrderId;
  if (reduceOnly) params.reduceOnly = 'true';
  return signedRequest('POST', '/fapi/v1/order', params);
}

// Resting entry. ACK is deliberate: RESULT with a GTD LIMIT may wait for the
// final status, which could be hours away and exceed the one-shot service's
// timeout. The deterministic client ID is queried/reconciled below.
export async function placeLimitOrder(symbol, side, quantity, price, {
  clientOrderId, goodTillDate
} = {}) {
  const params = {
    symbol, side, type: 'LIMIT', timeInForce: 'GTD', quantity, price,
    goodTillDate: Math.floor(Number(goodTillDate) / 1000) * 1000,
    newOrderRespType: 'ACK'
  };
  if (clientOrderId) params.newClientOrderId = clientOrderId;
  return signedRequest('POST', '/fapi/v1/order', params);
}

export async function findOrderByClientId(symbol, clientOrderId) {
  try {
    return await signedRequest('GET', '/fapi/v1/order', { symbol, origClientOrderId: clientOrderId });
  } catch (error) {
    if (Number(error.binanceCode) === -2013) return null;
    throw error;
  }
}

export const MAX_MARKET_ORDER_GENERATIONS = 16;

export function marketClientOrderId(baseClientOrderId, generation = 0) {
  if (!baseClientOrderId) return null;
  return generation === 0
    ? baseClientOrderId
    : makeClientOrderId('retry', baseClientOrderId, generation);
}

export function marketOrderMatches(order, { symbol, side, quantity, clientOrderId, reduceOnly }) {
  const type = order?.type || order?.origType;
  const actualQuantity = Number(order?.origQty);
  const expectedQuantity = Number(quantity);
  const quantityTolerance = Math.max(1e-12, Math.abs(expectedQuantity) * 1e-10);
  const exactReduceOnly = reduceOnly == null
    || (order?.reduceOnly === true || order?.reduceOnly === 'true') === !!reduceOnly;
  return order?.symbol === symbol && order?.side === side && type === 'MARKET'
    && (!clientOrderId || order?.clientOrderId === clientOrderId)
    && Number.isFinite(actualQuantity) && Number.isFinite(expectedQuantity)
    && Math.abs(actualQuantity - expectedQuantity) <= quantityTolerance
    && exactReduceOnly;
}

export function limitOrderMatches(order, {
  symbol, side, quantity, price, clientOrderId, goodTillDate
}) {
  const type = order?.type || order?.origType;
  const actualQuantity = Number(order?.origQty);
  const expectedQuantity = Number(quantity);
  const actualPrice = Number(order?.price);
  const expectedPrice = Number(price);
  const quantityTolerance = Math.max(1e-12, Math.abs(expectedQuantity) * 1e-10);
  const priceTolerance = Math.max(1e-12, Math.abs(expectedPrice) * 1e-10);
  const actualGtd = Number(order?.goodTillDate);
  const expectedGtd = Math.floor(Number(goodTillDate) / 1000) * 1000;
  return order?.symbol === symbol && order?.side === side && type === 'LIMIT'
    && order?.timeInForce === 'GTD'
    && order?.clientOrderId === clientOrderId
    && Number.isFinite(actualQuantity) && Number.isFinite(expectedQuantity)
    && Math.abs(actualQuantity - expectedQuantity) <= quantityTolerance
    && Number.isFinite(actualPrice) && Number.isFinite(expectedPrice)
    && Math.abs(actualPrice - expectedPrice) <= priceTolerance
    && Number.isFinite(actualGtd) && actualGtd === expectedGtd;
}

export function isTerminalMarketOrder(order) {
  return ['FILLED', 'CANCELED', 'EXPIRED', 'REJECTED', 'EXPIRED_IN_MATCH']
    .includes(String(order?.status || '').toUpperCase());
}

export const isTerminalEntryOrder = isTerminalMarketOrder;

// One immutable signal intent maps to one exchange order. Unlike a market
// retry, a terminal, unfilled resting order is not replaced under the same
// signal: doing so would turn a bounded wait into an indefinite one.
export async function placeLimitOrderReconciled(
  symbol, side, quantity, price, { clientOrderId, goodTillDate, onBeforeSubmit } = {}
) {
  if (!clientOrderId) return placeLimitOrder(symbol, side, quantity, price, { goodTillDate });
  const expected = { symbol, side, quantity, price, clientOrderId, goodTillDate };
  const prior = await findOrderByClientId(symbol, clientOrderId);
  if (prior) {
    if (!limitOrderMatches(prior, expected)) {
      const error = new Error(`limit order ${clientOrderId} exists but does not match the intended entry`);
      error.limitOrderIntentMismatch = true;
      throw error;
    }
    return { ...prior, reconciled: true };
  }
  // A caller veto means no request was sent and therefore has no ambiguous
  // exchange outcome. Keep it outside the submission reconciliation block.
  if (typeof onBeforeSubmit === 'function') await onBeforeSubmit({ expected });
  try {
    const placed = await placeLimitOrder(symbol, side, quantity, price, { clientOrderId, goodTillDate });
    // ACK responses should carry the immutable intent. If an exchange version
    // omits fields, query the order rather than accepting incomplete proof.
    const visible = limitOrderMatches(placed, expected)
      ? placed : await findOrderByClientId(symbol, clientOrderId);
    if (!visible) {
      const error = new Error(`Binance accepted a limit request but did not yet expose intent ${clientOrderId}`);
      error.outcomeUnknown = true;
      throw error;
    }
    if (!limitOrderMatches(visible, expected)) {
      const error = new Error(`Binance exposed a mismatched limit intent ${clientOrderId}`);
      error.limitOrderIntentMismatch = true;
      throw error;
    }
    return visible;
  } catch (submissionError) {
    if (submissionError.limitOrderIntentMismatch) throw submissionError;
    try {
      const recovered = await findOrderByClientId(symbol, clientOrderId);
      if (recovered) {
        if (!limitOrderMatches(recovered, expected)) {
          const error = new Error(`recovered limit order ${clientOrderId} does not match the intended entry`);
          error.limitOrderIntentMismatch = true;
          throw error;
        }
        return { ...recovered, reconciled: true };
      }
    } catch (reconciliationError) {
      if (reconciliationError.limitOrderIntentMismatch) throw reconciliationError;
      submissionError.reconciliationError = reconciliationError.message;
    }
    submissionError.outcomeUnknown = isExecutionOutcomeUnknown(submissionError);
    submissionError.clientOrderId = clientOrderId;
    submissionError.limitOrderIntent = expected;
    throw submissionError;
  }
}

export async function getOpenOrders(symbol) {
  const rows = await signedRequest('GET', '/fapi/v1/openOrders', symbol ? { symbol } : {});
  return Array.isArray(rows) ? rows : [];
}

export async function cancelOrder({ symbol, orderId, clientOrderId }) {
  if (!symbol || (orderId == null && !clientOrderId)) {
    throw new Error('cancelOrder requires symbol and orderId or clientOrderId');
  }
  return signedRequest('DELETE', '/fapi/v1/order', {
    symbol, ...(orderId != null ? { orderId } : { origClientOrderId: clientOrderId })
  });
}

// Binance documents these message-bus/backend failures as having unknown
// execution status even when they arrive in an HTTP 4xx response. Treating
// every 4xx as a definite rejection can therefore submit a duplicate order.
export function isExecutionOutcomeUnknown(error) {
  const code = Number(error?.binanceCode);
  return !error?.httpStatus || Number(error.httpStatus) >= 500
    || [-1000, -1001, -1006, -1007].includes(code);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function settleVisibleMarketOrder(order, expected) {
  let current = order;
  let settlementError = null;
  for (let attempt = 0; attempt < 6 && !isTerminalMarketOrder(current); attempt++) {
    await wait(250 * (attempt + 1));
    try {
      const refreshed = await findOrderByClientId(expected.symbol, expected.clientOrderId);
      if (refreshed) {
        if (!marketOrderMatches(refreshed, expected)) {
          const error = new Error(`market order ${expected.clientOrderId} changed incompatibly while settling`);
          error.marketOrderIntentMismatch = true;
          throw error;
        }
        current = refreshed;
      }
    } catch (error) {
      if (error.marketOrderIntentMismatch) throw error;
      settlementError = error.message;
      break;
    }
  }
  return {
    ...current,
    clientOrderId: current?.clientOrderId || expected.clientOrderId,
    pending: !isTerminalMarketOrder(current),
    ...(settlementError ? { settlementError } : {})
  };
}

// A timeout or transport failure does not prove Binance rejected an order.
// Resolve the deterministic ID before returning an error so callers never
// blindly issue a second market order for the same intent.
export async function placeMarketOrderReconciled(symbol, side, quantity, options = {}) {
  const baseClientOrderId = options.clientOrderId;
  if (!baseClientOrderId) return placeMarketOrder(symbol, side, quantity, options);

  for (let generation = 0; generation < MAX_MARKET_ORDER_GENERATIONS; generation++) {
    const clientOrderId = marketClientOrderId(baseClientOrderId, generation);
    const expected = { symbol, side, quantity, clientOrderId, reduceOnly: !!options.reduceOnly };
    const prior = await findOrderByClientId(symbol, clientOrderId);
    if (prior) {
      if (!marketOrderMatches(prior, expected)) {
        const error = new Error(`market order ${clientOrderId} exists but does not match the intended order`);
        error.marketOrderIntentMismatch = true;
        throw error;
      }
      const executedQty = Number(prior.executedQty);
      if (Number.isFinite(executedQty) && executedQty > 0) {
        return { ...(await settleVisibleMarketOrder(prior, expected)), reconciled: true };
      }
      // Only a terminal zero-fill is safe to replace. A NEW or partially
      // visible order has an unknown future outcome and must retain its ID.
      if (!isTerminalMarketOrder(prior)) {
        return { ...(await settleVisibleMarketOrder(prior, expected)), reconciled: true };
      }
      continue;
    }

    if (typeof options.onBeforeSubmit === 'function') {
      await options.onBeforeSubmit({ clientOrderId, expected, generation });
    }
    try {
      const placed = await placeMarketOrder(symbol, side, quantity, { ...options, clientOrderId });
      if (!marketOrderMatches(placed, expected)) {
        const error = new Error(`Binance returned a market order that does not match intent ${clientOrderId}`);
        error.marketOrderIntentMismatch = true;
        throw error;
      }
      return settleVisibleMarketOrder(placed, expected);
    } catch (submissionError) {
      if (submissionError.marketOrderIntentMismatch) throw submissionError;
      try {
        const recovered = await findOrderByClientId(symbol, clientOrderId);
        if (recovered) {
          if (!marketOrderMatches(recovered, expected)) {
            const error = new Error(`recovered market order ${clientOrderId} does not match the intended order`);
            error.marketOrderIntentMismatch = true;
            throw error;
          }
          return { ...(await settleVisibleMarketOrder(recovered, expected)), reconciled: true };
        }
      } catch (reconciliationError) {
        if (reconciliationError.marketOrderIntentMismatch) throw reconciliationError;
        submissionError.reconciliationError = reconciliationError.message;
      }
      submissionError.outcomeUnknown = isExecutionOutcomeUnknown(submissionError);
      submissionError.clientOrderId = clientOrderId;
      submissionError.marketOrderIntent = expected;
      throw submissionError;
    }
  }
  throw new Error(`exhausted ${MAX_MARKET_ORDER_GENERATIONS} deterministic market-order IDs for ${symbol}`);
}

export function executedMarketOrder(order, { symbol, side, clientOrderId } = {}) {
  const type = order?.type || order?.origType;
  const exactIntent = order?.symbol === symbol && order?.side === side
    && type === 'MARKET'
    && (!clientOrderId || order?.clientOrderId === clientOrderId);
  const executedQty = Number(order?.executedQty);
  return exactIntent && isTerminalMarketOrder(order)
    && Number.isFinite(executedQty) && executedQty > 0;
}

// Protective stop-loss / take-profit — MUST use the Algo Order API (see
// this file's top comment). Quantity + reduceOnly bounds each order to the
// bot-confirmed fill. This is safer than closePosition=true on a shared
// one-way account because a later manual addition cannot increase the amount
// this conditional order is allowed to close.
// workingType=MARK_PRICE (not the default CONTRACT_PRICE) specifically to
// avoid a thin-orderbook wick on the last-traded price triggering a stop
// that the broader market never actually reached.
export async function placeProtectiveOrder(symbol, side, type, triggerPrice, quantity, clientAlgoId) {
  const params = {
    algoType: 'CONDITIONAL', symbol, side, type,
    triggerPrice, quantity, reduceOnly: 'true', workingType: 'MARK_PRICE',
    newOrderRespType: 'RESULT'
  };
  if (clientAlgoId) params.clientAlgoId = clientAlgoId;
  return signedRequest('POST', '/fapi/v1/algoOrder', params);
}

// Confirmed live via Binance's current docs: algo (conditional) orders
// live in a separate query surface from plain orders post-migration —
// GET /fapi/v1/openOrders would NOT show a STOP_MARKET/TAKE_PROFIT_MARKET
// placed via /fapi/v1/algoOrder. Used to check whether a position already
// has protection before placing a duplicate.
export async function getOpenAlgoOrders(symbol) {
  const r = await signedRequest('GET', '/fapi/v1/openAlgoOrders', symbol ? { symbol } : {});
  return Array.isArray(r) ? r : r.orders || [];
}

export async function findAlgoOrderByClientId(clientAlgoId) {
  try {
    return await signedRequest('GET', '/fapi/v1/algoOrder', { clientAlgoId });
  } catch (error) {
    if (Number(error.binanceCode) === -2013 || Number(error.binanceCode) === -2011) return null;
    throw error;
  }
}

export function isActiveAlgoOrder(order) {
  // TRIGGERING/TRIGGERED mean the conditional order is being forwarded to,
  // or already lives in, the matching engine. Arming a replacement during
  // either state can produce two close orders for one position.
  return ['NEW', 'TRIGGERING', 'TRIGGERED']
    .includes(String(order?.algoStatus || '').toUpperCase());
}

export function algoOrderDisposition(order) {
  const status = String(order?.algoStatus || '').toUpperCase();
  if (['NEW', 'TRIGGERING', 'TRIGGERED'].includes(status)) return 'pending';
  if (['CANCELED', 'CANCELLED', 'EXPIRED', 'REJECTED'].includes(status)) return 'replaceable';
  if (status === 'FINISHED') return 'finished';
  return 'unknown';
}

// A conditional order's client ID remains queryable after the order becomes
// terminal. Reusing that ID makes reconciliation ambiguous, so replacements
// walk a deterministic generation chain. The chain is derivable from the
// original intent after a crash; it does not depend on local memory surviving.
export const MAX_PROTECTION_GENERATIONS = 32;

export function protectionClientOrderId(baseClientAlgoId, generation = 0) {
  if (!baseClientAlgoId) return null;
  return generation === 0
    ? baseClientAlgoId
    : makeClientOrderId('retry', baseClientAlgoId, generation);
}

export function protectionClientOrderIds(baseClientAlgoId, count = MAX_PROTECTION_GENERATIONS) {
  const n = Math.max(0, Math.min(MAX_PROTECTION_GENERATIONS, Math.floor(Number(count) || 0)));
  return Array.from({ length: n }, (_, generation) =>
    protectionClientOrderId(baseClientAlgoId, generation));
}

export function protectiveOrderMatches(order, {
  symbol, side, type, triggerPrice, quantity, clientAlgoId
}) {
  const actualTrigger = Number(order?.triggerPrice);
  const expectedTrigger = Number(triggerPrice);
  const actualQuantity = Number(order?.quantity ?? order?.origQty);
  const expectedQuantity = Number(quantity);
  const triggerTolerance = Number.isFinite(expectedTrigger)
    ? Math.max(1e-12, Math.abs(expectedTrigger) * 1e-10) : 0;
  const quantityTolerance = Number.isFinite(expectedQuantity)
    ? Math.max(1e-12, Math.abs(expectedQuantity) * 1e-10) : 0;
  return order?.symbol === symbol
    && order?.side === side
    && (order?.orderType || order?.type) === type
    && (order?.closePosition === false || order?.closePosition === 'false' || order?.closePosition == null)
    && (order?.reduceOnly === true || order?.reduceOnly === 'true')
    && order?.workingType === 'MARK_PRICE'
    && (!clientAlgoId || order?.clientAlgoId === clientAlgoId)
    && Number.isFinite(actualTrigger) && Number.isFinite(expectedTrigger)
    && Math.abs(actualTrigger - expectedTrigger) <= triggerTolerance
    && Number.isFinite(actualQuantity) && Number.isFinite(expectedQuantity)
    && Math.abs(actualQuantity - expectedQuantity) <= quantityTolerance;
}

function validateReconciledProtection(order, expected) {
  if (!protectiveOrderMatches(order, expected)) {
    const error = new Error(`algo order ${expected.clientAlgoId} exists but does not match the intended ${expected.type} protection`);
    error.algoOrderIntentMismatch = true;
    throw error;
  }
  const disposition = algoOrderDisposition(order);
  if (disposition === 'pending') return order;
  const error = new Error(`algo order ${expected.clientAlgoId} is ${disposition} (${order?.algoStatus || 'unknown status'})`);
  error.algoOrderDisposition = disposition;
  error.algoStatus = order?.algoStatus ?? null;
  throw error;
}

export async function placeProtectiveOrderReconciled(
  symbol, side, type, triggerPrice, quantity, clientAlgoId,
  { verifyFinishedReplacement, onBeforeSubmit } = {}
) {
  // Calls without an identity retain the direct behavior for backwards
  // compatibility. Production protection always supplies an identity.
  if (!clientAlgoId) {
    const expected = { symbol, side, type, triggerPrice, quantity, clientAlgoId };
    return validateReconciledProtection(
      await placeProtectiveOrder(symbol, side, type, triggerPrice, quantity, clientAlgoId), expected);
  }

  for (let generation = 0; generation < MAX_PROTECTION_GENERATIONS; generation++) {
    const currentClientAlgoId = protectionClientOrderId(clientAlgoId, generation);
    const expected = { symbol, side, type, triggerPrice, quantity, clientAlgoId: currentClientAlgoId };
    const prior = await findAlgoOrderByClientId(currentClientAlgoId);
    if (prior) {
      try {
        const validated = validateReconciledProtection(prior, expected);
        return { ...validated, clientAlgoId: validated.clientAlgoId || currentClientAlgoId, reconciled: true };
      } catch (error) {
        // Only a never-triggered terminal is intrinsically safe to replace.
        // FINISHED means Binance created/ran an actual order; replacement is
        // allowed only after the caller freshly proves the same bot-owned
        // position still exists. Unknown and in-flight states fail closed.
        if (error.algoOrderDisposition === 'replaceable') continue;
        if (error.algoOrderDisposition === 'finished' && verifyFinishedReplacement) {
          if (await verifyFinishedReplacement(prior)) continue;
        }
        throw error;
      }
    }

    if (typeof onBeforeSubmit === 'function') {
      await onBeforeSubmit({ clientAlgoId: currentClientAlgoId, expected, generation });
    }
    try {
      const placed = await placeProtectiveOrder(
        symbol, side, type, triggerPrice, quantity, currentClientAlgoId
      );
      const validated = validateReconciledProtection(placed, expected);
      return { ...validated, clientAlgoId: validated.clientAlgoId || currentClientAlgoId };
    } catch (submissionError) {
      if (submissionError.algoOrderDisposition || submissionError.algoOrderIntentMismatch) throw submissionError;
      try {
        const recovered = await findAlgoOrderByClientId(currentClientAlgoId);
        if (recovered) {
          const validated = validateReconciledProtection(recovered, expected);
          return { ...validated, clientAlgoId: validated.clientAlgoId || currentClientAlgoId, reconciled: true };
        }
      } catch (reconciliationError) {
        if (reconciliationError.algoOrderDisposition || reconciliationError.algoOrderIntentMismatch) throw reconciliationError;
        submissionError.reconciliationError = reconciliationError.message;
      }
      throw submissionError;
    }
  }

  throw new Error(`exhausted ${MAX_PROTECTION_GENERATIONS} deterministic protection IDs for ${symbol} ${type}`);
}

// Conditional TP/SL orders are not cancelled by /allOpenOrders. Cancel each
// tracked sibling by its exact exchange identity so unrelated orders on the
// symbol are left untouched.
export async function cancelAlgoOrder({ algoId, clientAlgoId }) {
  if (algoId == null && !clientAlgoId) throw new Error('cancelAlgoOrder requires algoId or clientAlgoId');
  return signedRequest('DELETE', '/fapi/v1/algoOrder', algoId != null ? { algoId } : { clientAlgoId });
}
