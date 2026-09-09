// Signed Binance SPOT REST client. Minimal by design — only the endpoints
// this bot needs, no SDK, matching the style of trading-bot/src/binance.mjs
// and signals-worker/scripts/d1-client.mjs.
//
// Note this is a DIFFERENT API surface from the futures bot: spot lives at
// api.binance.com/api/v3/*, futures at fapi.binance.com/fapi/*. Separate
// host, separate key, separate permissions.
import { createHash, createHmac } from 'node:crypto';
import { config } from './config.mjs';
import { parseBinanceJson } from '../../shared/binance-json.mjs';

let exchangeInfoCache = null;
const BINANCE_REQUEST_TIMEOUT_MS = 20000;

async function signedRequest(method, path, params = {}) {
  const query = new URLSearchParams({ ...params, timestamp: Date.now(), recvWindow: 10000 });
  const signature = createHmac('sha256', config.apiSecret).update(query.toString()).digest('hex');
  query.set('signature', signature);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BINANCE_REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${config.base}${path}?${query.toString()}`, {
      method, headers: { 'X-MBX-APIKEY': config.apiKey }, signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
  const body = await res.text().then(parseBinanceJson).catch(() => null);
  if (!res.ok) {
    const error = new Error(`Binance spot ${method} ${path} failed: HTTP ${res.status} ${JSON.stringify(body)}`);
    error.httpStatus = res.status;
    error.binanceCode = body?.code ?? null;
    error.binanceBody = body;
    throw error;
  }
  return body;
}

export const MAX_SPOT_ORDER_GENERATIONS = 16;

export function makeClientOrderId(intentEpoch, symbol, generation = 0) {
  const digest = createHash('sha256').update(`${intentEpoch}\u001f${symbol}\u001f${generation}`).digest('hex').slice(0, 26);
  return `fcss-${digest}`;
}

async function publicRequest(path, params = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BINANCE_REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${config.base}${path}?${new URLSearchParams(params).toString()}`, {
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
  const body = await res.text().then(parseBinanceJson).catch(() => null);
  if (!res.ok) throw new Error(`Binance spot GET ${path} failed: HTTP ${res.status} ${JSON.stringify(body)}`);
  return body;
}

// Symbol filters. Spot orders are rejected unless quantity respects LOT_SIZE
// and the order value clears MIN_NOTIONAL, so both are needed before sizing.
export async function getExchangeInfo() {
  if (exchangeInfoCache) return exchangeInfoCache;
  const info = await publicRequest('/api/v3/exchangeInfo');
  const bySymbol = {};
  for (const s of info.symbols || []) {
    if (s.status !== 'TRADING') continue;
    if (!(s.isSpotTradingAllowed ?? true)) continue;
    const lot = (s.filters || []).find((f) => f.filterType === 'LOT_SIZE');
    const notional = (s.filters || []).find((f) => f.filterType === 'NOTIONAL' || f.filterType === 'MIN_NOTIONAL');
    bySymbol[s.symbol] = {
      baseAsset: s.baseAsset,
      quoteAsset: s.quoteAsset,
      stepSize: lot ? Number(lot.stepSize) : null,
      minQty: lot ? Number(lot.minQty) : null,
      minNotional: notional ? Number(notional.minNotional ?? notional.notional ?? 0) : 0,
      // Binance permits quoteOrderQty market buys on most spot pairs, which
      // is exactly what a DCA tranche wants: spend N dollars, whatever the
      // price. Where it is unavailable the caller falls back to a quantity.
      quoteOrderQtyAllowed: s.quoteOrderQtyMarketAllowed !== false
    };
  }
  exchangeInfoCache = bySymbol;
  return bySymbol;
}

export async function roundQuantity(symbol, quantity) {
  const info = (await getExchangeInfo())[symbol];
  if (!info || !info.stepSize) throw new Error(`no spot exchange info for ${symbol}`);
  const steps = Math.floor(quantity / info.stepSize);
  const rounded = steps * info.stepSize;
  // Float artefacts here become rejected orders, so pin to the step's own
  // precision rather than trusting the multiplication.
  const decimals = (String(info.stepSize).split('.')[1] || '').replace(/0+$/, '').length;
  return Number(rounded.toFixed(decimals));
}

export async function getAccount() {
  return signedRequest('GET', '/api/v3/account');
}

// Free (not locked in open orders) balance of one asset.
export async function getFreeBalance(asset) {
  const account = await getAccount();
  const row = (account.balances || []).find((b) => b.asset === asset);
  return row ? Number(row.free) : 0;
}

export async function getPrice(symbol) {
  const r = await publicRequest('/api/v3/ticker/price', { symbol });
  return Number(r.price);
}

// Weekly candles, oldest first. The measured basis for both buy triggers:
// this asset's own weekly return distribution and its own typical drawdown
// from weekly open to weekly low.
export async function getWeeklyKlines(symbol, weeks) {
  const raw = await publicRequest('/api/v3/klines', { symbol, interval: '1w', limit: weeks });
  return (raw || []).map((k) => ({
    openTime: k[0], open: Number(k[1]), high: Number(k[2]),
    low: Number(k[3]), close: Number(k[4]), closeTime: k[6]
  }));
}

// Market buy for a fixed amount of quote currency — the natural expression of
// "spend this tranche", and it sidesteps having to round a quantity at all.
export async function marketBuyQuote(symbol, quoteQty, clientOrderId) {
  if (!clientOrderId) throw new Error('marketBuyQuote requires a deterministic clientOrderId');
  return signedRequest('POST', '/api/v3/order', {
    symbol, side: 'BUY', type: 'MARKET', quoteOrderQty: quoteQty.toFixed(2),
    newClientOrderId: clientOrderId, newOrderRespType: 'FULL'
  });
}

export async function marketBuyQuantity(symbol, quantity, clientOrderId) {
  if (!clientOrderId) throw new Error('marketBuyQuantity requires a deterministic clientOrderId');
  return signedRequest('POST', '/api/v3/order', {
    symbol, side: 'BUY', type: 'MARKET', quantity,
    newClientOrderId: clientOrderId, newOrderRespType: 'FULL'
  });
}

export async function findOrderByClientId(symbol, clientOrderId) {
  try {
    return await signedRequest('GET', '/api/v3/order', { symbol, origClientOrderId: clientOrderId });
  } catch (error) {
    if (Number(error.binanceCode) === -2013) return null;
    throw error;
  }
}

// A market-order timeout has an unknown execution status. Always query the
// deterministic client ID before retrying or reporting failure; a later bot
// cycle uses the same ID and therefore follows the same reconciliation path.
export function spotBuyIntentMatches(order, symbol, clientOrderId) {
  return order?.symbol === symbol && order?.side === 'BUY'
    && (order?.type || order?.origType) === 'MARKET'
    && order?.clientOrderId === clientOrderId;
}

export function terminalSpotOrder(order) {
  return ['FILLED', 'CANCELED', 'EXPIRED', 'REJECTED', 'EXPIRED_IN_MATCH']
    .includes(String(order?.status || '').toUpperCase());
}

// These documented server/message-bus errors have unknown execution status;
// their HTTP class alone is not conclusive.
export function isExecutionOutcomeUnknown(error) {
  const code = Number(error?.binanceCode);
  return !error?.httpStatus || Number(error.httpStatus) >= 500
    || [-1000, -1001, -1006, -1007].includes(code);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function settleVisibleSpotOrder(order, symbol, clientOrderId) {
  let current = order;
  let settlementError = null;
  for (let attempt = 0; attempt < 6 && !terminalSpotOrder(current); attempt++) {
    await wait(250 * (attempt + 1));
    try {
      const refreshed = await findOrderByClientId(symbol, clientOrderId);
      if (refreshed) {
        if (!spotBuyIntentMatches(refreshed, symbol, clientOrderId)) {
          const error = new Error(`spot order ${clientOrderId} changed incompatibly while settling`);
          error.spotOrderIntentMismatch = true;
          throw error;
        }
        current = refreshed;
      }
    } catch (error) {
      if (error.spotOrderIntentMismatch) throw error;
      settlementError = error.message;
      break;
    }
  }
  return {
    ...current,
    clientOrderId: current?.clientOrderId || clientOrderId,
    pending: !terminalSpotOrder(current),
    ...(settlementError ? { settlementError } : {})
  };
}

export async function marketBuyReconciled({ symbol, quoteQty, quantity, clientOrderId, intentEpoch }) {
  if (!clientOrderId || intentEpoch == null) throw new Error('marketBuyReconciled requires deterministic intentEpoch and clientOrderId');
  for (let generation = 0; generation < MAX_SPOT_ORDER_GENERATIONS; generation++) {
    const currentId = generation === 0 ? clientOrderId : makeClientOrderId(intentEpoch, symbol, generation);
    const prior = await findOrderByClientId(symbol, currentId);
    if (prior) {
      if (!spotBuyIntentMatches(prior, symbol, currentId)) {
        throw new Error(`spot order ${currentId} exists but does not match the intended market buy`);
      }
      if (Number(prior.executedQty) > 0 || !terminalSpotOrder(prior)) {
        return { ...(await settleVisibleSpotOrder(prior, symbol, currentId)), reconciled: true };
      }
      continue;
    }
    try {
      const placed = quoteQty != null
        ? await marketBuyQuote(symbol, quoteQty, currentId)
        : await marketBuyQuantity(symbol, quantity, currentId);
      if (!spotBuyIntentMatches(placed, symbol, currentId)) {
        throw new Error(`Binance returned a spot order that does not match intent ${currentId}`);
      }
      return settleVisibleSpotOrder(placed, symbol, currentId);
    } catch (submissionError) {
      try {
        const recovered = await findOrderByClientId(symbol, currentId);
        if (recovered) {
          if (!spotBuyIntentMatches(recovered, symbol, currentId)) {
            throw new Error(`recovered spot order ${currentId} does not match the intended market buy`);
          }
          return { ...(await settleVisibleSpotOrder(recovered, symbol, currentId)), reconciled: true };
        }
      } catch (reconciliationError) {
        submissionError.reconciliationError = reconciliationError.message;
      }
      // A signed HTTP 4xx response is a definite exchange rejection. A
      // transport abort/timeout or server-side failure is ambiguous and the
      // tranche must be quarantined rather than followed by sibling orders.
      submissionError.outcomeUnknown = isExecutionOutcomeUnknown(submissionError);
      throw submissionError;
    }
  }
  throw new Error(`exhausted ${MAX_SPOT_ORDER_GENERATIONS} deterministic spot-order IDs for ${symbol}`);
}
