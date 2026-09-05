// Signed Binance USDS-M Futures REST client. Minimal by design — only the
// endpoints this bot actually needs, no SDK dependency (matches the rest
// of this project's style of plain fetch + manual signing, see
// signals-worker/scripts/d1-client.mjs).
//
// IMPORTANT, confirmed live via Binance's own current docs (2026-08):
// as of 2025-12-09, Binance migrated conditional orders (STOP_MARKET /
// TAKE_PROFIT_MARKET) to a separate Algo Order API — the old
// POST /fapi/v1/order now REJECTS those types with error -4120. Plain
// MARKET entry orders are unaffected and still go through /fapi/v1/order;
// stop-loss/take-profit protection orders go through the new
// POST /fapi/v1/algoOrder instead. Getting this wrong would mean a
// protective stop silently fails to place on a leveraged position, so
// this was verified against Binance's current documentation before
// writing this file, not assumed from training data.
import { createHmac } from 'node:crypto';
import { config } from './config.mjs';

let exchangeInfoCache = null;

async function signedRequest(method, path, params = {}) {
  const query = new URLSearchParams({ ...params, timestamp: Date.now(), recvWindow: 10000 });
  const signature = createHmac('sha256', config.binanceApiSecret).update(query.toString()).digest('hex');
  query.set('signature', signature);
  const url = `${config.binanceBase}${path}?${query.toString()}`;
  const res = await fetch(url, { method, headers: { 'X-MBX-APIKEY': config.binanceApiKey } });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Binance ${method} ${path} failed: HTTP ${res.status} ${JSON.stringify(body)}`);
  return body;
}

async function publicRequest(path, params = {}) {
  const query = new URLSearchParams(params);
  const res = await fetch(`${config.binanceBase}${path}?${query.toString()}`);
  const body = await res.json().catch(() => null);
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
      quantityStep: Number(lot?.stepSize || 1),
      quantityPrecision: s.quantityPrecision,
      pricePrecision: s.pricePrecision,
      priceStep: Number(price?.tickSize || 0.01)
    };
  }
  exchangeInfoCache = bySymbol;
  return bySymbol;
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

// v3 is Binance's current recommended account/balance endpoint (v2 still
// works but is the older version) — confirmed against current docs.
export async function getAccount() {
  return signedRequest('GET', '/fapi/v3/account');
}

export async function getPositionRisk(symbol) {
  return signedRequest('GET', '/fapi/v3/positionRisk', symbol ? { symbol } : {});
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
export async function getIncomeSince(symbol, startMs) {
  const rows = await signedRequest('GET', '/fapi/v1/income', {
    symbol, startTime: Math.max(0, Math.floor(startMs)), limit: 1000
  });
  const totals = { realizedPnl: 0, commission: 0, fundingFee: 0, rows: 0 };
  for (const r of Array.isArray(rows) ? rows : []) {
    const v = Number(r.income);
    if (!Number.isFinite(v)) continue;
    totals.rows++;
    if (r.incomeType === 'REALIZED_PNL') totals.realizedPnl += v;
    else if (r.incomeType === 'COMMISSION') totals.commission += v;
    else if (r.incomeType === 'FUNDING_FEE') totals.fundingFee += v;
  }
  totals.netPnl = totals.realizedPnl + totals.commission + totals.fundingFee;
  return totals;
}

// Fills for one symbol since a time — used to recover the average exit price
// of a position the bot did not close itself (a stop, a target, or the
// operator closing by hand).
export async function getUserTradesSince(symbol, startMs) {
  return signedRequest('GET', '/fapi/v1/userTrades', {
    symbol, startTime: Math.max(0, Math.floor(startMs)), limit: 1000
  });
}

export async function getMarkPrice(symbol) {
  const r = await publicRequest('/fapi/v1/premiumIndex', { symbol });
  return { price: Number(r.markPrice), fundingRate: Number(r.lastFundingRate) };
}

// Plain market entry — NOT affected by the Dec 2025 conditional-order
// migration (only STOP_MARKET/TAKE_PROFIT_MARKET moved to algoOrder).
export async function placeMarketOrder(symbol, side, quantity) {
  return signedRequest('POST', '/fapi/v1/order', { symbol, side, type: 'MARKET', quantity });
}

// Protective stop-loss / take-profit — MUST use the Algo Order API (see
// this file's top comment). closePosition=true means "close the whole
// position when triggered," so we don't need to track/re-round an exact
// quantity for the protective leg — it always exits everything.
// workingType=MARK_PRICE (not the default CONTRACT_PRICE) specifically to
// avoid a thin-orderbook wick on the last-traded price triggering a stop
// that the broader market never actually reached.
export async function placeProtectiveOrder(symbol, side, type, triggerPrice) {
  return signedRequest('POST', '/fapi/v1/algoOrder', {
    algoType: 'CONDITIONAL', symbol, side, type,
    triggerPrice, closePosition: 'true', workingType: 'MARK_PRICE'
  });
}

export async function cancelAllOpenOrders(symbol) {
  return signedRequest('DELETE', '/fapi/v1/allOpenOrders', { symbol });
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
