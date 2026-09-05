// Signed Binance SPOT REST client. Minimal by design — only the endpoints
// this bot needs, no SDK, matching the style of trading-bot/src/binance.mjs
// and signals-worker/scripts/d1-client.mjs.
//
// Note this is a DIFFERENT API surface from the futures bot: spot lives at
// api.binance.com/api/v3/*, futures at fapi.binance.com/fapi/*. Separate
// host, separate key, separate permissions.
import { createHmac } from 'node:crypto';
import { config } from './config.mjs';

let exchangeInfoCache = null;

async function signedRequest(method, path, params = {}) {
  const query = new URLSearchParams({ ...params, timestamp: Date.now(), recvWindow: 10000 });
  const signature = createHmac('sha256', config.apiSecret).update(query.toString()).digest('hex');
  query.set('signature', signature);
  const res = await fetch(`${config.base}${path}?${query.toString()}`, {
    method, headers: { 'X-MBX-APIKEY': config.apiKey }
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Binance spot ${method} ${path} failed: HTTP ${res.status} ${JSON.stringify(body)}`);
  return body;
}

async function publicRequest(path, params = {}) {
  const res = await fetch(`${config.base}${path}?${new URLSearchParams(params).toString()}`);
  const body = await res.json().catch(() => null);
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
export async function marketBuyQuote(symbol, quoteQty) {
  return signedRequest('POST', '/api/v3/order', {
    symbol, side: 'BUY', type: 'MARKET', quoteOrderQty: quoteQty.toFixed(2)
  });
}

export async function marketBuyQuantity(symbol, quantity) {
  return signedRequest('POST', '/api/v3/order', {
    symbol, side: 'BUY', type: 'MARKET', quantity
  });
}
