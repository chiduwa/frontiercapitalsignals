// Public Binance GET requests only. No private account/execution imports.
import { createHash } from 'node:crypto';
export const HISTORY_METHOD = 'post-signal-mark-reference-v1';
export const INTERVAL_MS = 300_000;
export const HORIZONS = Object.freeze([1, 6, 24]);
export const DISCOVERY_CUTOFF = Date.parse('2026-12-11T00:00:00Z');
export const COST_SCENARIOS = Object.freeze([
  { id: 'assumed-base', feeRate: 0.0005, slippagePct: 0.02 },
  { id: 'assumed-stress', feeRate: 0.001, slippagePct: 0.05 }
]);
export const REGISTERED_POLICIES = Object.freeze([5, 10, 15, 20].flatMap(leverage =>
  [10, 20, 30].flatMap(stopRoiPct => [0.5, 0.75].map(firstFraction => ({
    id: `L${leverage}-S${stopRoiPct}-F${firstFraction * 100}`, leverage, stopRoiPct,
    firstFraction, firstTargetRoiPct: 60, finalTargetRoiPct: 120
  })))));
const numeric = v => v == null || v === '' || typeof v === 'boolean' ? NaN : Number(v);
export const referenceEventId = (intentId, hours) => createHash('sha256')
  .update(`${HISTORY_METHOD}|${intentId}|${hours}`).digest('hex');

export function referenceWindow(intent, horizonHours, nowMs) {
  const created = Date.parse(intent?.created_at);
  const observed = Date.parse(intent?.signal_price_at);
  if (!intent?.client_order_id || !/^[A-Z0-9_]{2,35}USDT$/.test(intent.symbol || '')
      || !['BUY', 'SELL'].includes(intent.side)
      || !['crypto', 'stock', 'commodity'].includes(intent.asset_class)
      || !HORIZONS.includes(horizonHours) || !Number.isFinite(created)
      || !Number.isFinite(observed) || observed > created + 60_000
      || created - observed > 30 * 60_000 || !Number.isFinite(nowMs)) return null;
  // This is a delayed hypothetical MARKET reference, NOT the original
  // offset LIMIT or an inferred fill. First complete bar after recorded intent.
  const entryAt = (Math.floor(created / INTERVAL_MS) + 1) * INTERVAL_MS;
  const endAt = entryAt + horizonHours * 3_600_000;
  return { entryAt, endAt, horizonHours, mature: endAt + 60_000 <= nowMs,
    id: referenceEventId(intent.client_order_id, horizonHours) };
}

export function parseMarkBars(rows, start, end, intervalMs = INTERVAL_MS) {
  if (!Array.isArray(rows) || rows.length !== (end - start) / intervalMs) throw new Error('incomplete-mark-history');
  return rows.map((r, i) => {
    if (!Array.isArray(r)) throw new Error('malformed-mark-history');
    const [at, open, high, low, close] = r.slice(0, 5).map(numeric);
    if (at !== start + i * intervalMs || numeric(r[6]) !== at + intervalMs - 1
        || ![open, high, low, close].every(x => Number.isFinite(x) && x > 0)
        || high < Math.max(open, close) || low > Math.min(open, close)) throw new Error('malformed-mark-history');
    return { at, open, high, low, close };
  });
}

export function parseFunding(rows, symbol, start, end) {
  if (!Array.isArray(rows) || rows.length >= 1000) throw new Error('incomplete-funding-history');
  return rows.map((r, i) => {
    const at = numeric(r.fundingTime), rate = numeric(r.fundingRate), markPrice = numeric(r.markPrice);
    if (r.symbol !== symbol || !Number.isFinite(at) || at < start || at > end
        || !Number.isFinite(rate) || Math.abs(rate) > 0.1 || !(markPrice > 0 && Number.isFinite(markPrice))
        || (i && at <= numeric(rows[i - 1].fundingTime))) throw new Error('malformed-funding-history');
    return { at, rate, markPrice };
  });
}

export function trailingRegime(rows, referenceAt) {
  const unknown = { regime: 'unknown', contextAt: referenceAt,
    regimeMethod: 'insufficient completed mark-price daily history' };
  if (!Array.isArray(rows)) return unknown;
  const closed = rows.filter(r => Array.isArray(r) && numeric(r[6]) < referenceAt).slice(-50);
  if (closed.length !== 50) return unknown;
  const start = numeric(closed[0][0]);
  const end = numeric(closed.at(-1)[6]) + 1;
  if (referenceAt - end > 86_400_000 || start % 86_400_000 !== 0) return unknown;
  let bars;
  try { bars = parseMarkBars(closed, start, end, 86_400_000); } catch { return unknown; }
  const average = bars.reduce((sum, b) => sum + b.close, 0) / 50;
  const ratio = bars.at(-1).close / average;
  return { regime: ratio > 1.02 ? 'bull' : ratio < 0.98 ? 'bear' : 'range',
    contextAt: end - 1, regimeMethod: 'completed mark close vs trailing SMA50, fixed +/-2% band',
    regimeMean: average, regimeClose: bars.at(-1).close };
}

export function exactResearchMarket(info, intent) {
  const m = info?.symbols?.find(m => m.symbol === intent.symbol);
  if (!m || m.status !== 'TRADING' || m.baseAsset !== intent.signal_symbol
      || m.quoteAsset !== 'USDT' || m.marginAsset !== 'USDT') return false;
  if (intent.asset_class === 'crypto') return m.contractType === 'PERPETUAL' && m.underlyingType === 'COIN';
  return m.contractType === 'TRADIFI_PERPETUAL'
    && m.underlyingType === (intent.asset_class === 'stock' ? 'EQUITY' : 'COMMODITY');
}

export function publicHistoryClient({ fetchImpl = fetch, maxRequests = 9 } = {}) {
  let requests = 0;
  return { get requests() { return requests; }, async get(path, params = {}) {
    if (!['/fapi/v1/exchangeInfo', '/fapi/v1/markPriceKlines', '/fapi/v1/fundingRate'].includes(path)) {
      throw new Error('research-endpoint-not-allowed');
    }
    if (requests >= maxRequests) throw new Error('public-request-budget-exhausted');
    requests++;
    const response = await fetchImpl(`https://fapi.binance.com${path}?${new URLSearchParams(params)}`, {
      method: 'GET', signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) throw new Error(`public-history-http-${response.status}`);
    return response.json();
  } };
}

export async function collectReferenceEvent(intent, hours, nowMs, client, exchangeInfo) {
  const w = referenceWindow(intent, hours, nowMs);
  if (!w) throw new Error('invalid-intent-reference');
  if (!w.mature) throw new Error('unmatured-reference-window');
  if (!exactResearchMarket(exchangeInfo, intent)) throw new Error('unverified-current-contract-identity');
  const rawBars = await client.get('/fapi/v1/markPriceKlines', {
    symbol: intent.symbol, interval: '5m', startTime: w.entryAt, endTime: w.endAt - 1, limit: 499
  });
  const bars = parseMarkBars(rawBars, w.entryAt, w.endAt);
  const rawFunding = await client.get('/fapi/v1/fundingRate', {
    symbol: intent.symbol, startTime: w.entryAt, endTime: w.endAt, limit: 1000
  });
  const funding = parseFunding(rawFunding, intent.symbol, w.entryAt, w.endAt);
  let daily = null;
  try { daily = await client.get('/fapi/v1/markPriceKlines', {
    symbol: intent.symbol, interval: '1d', endTime: w.entryAt - 1, limit: 60
  }); } catch { /* Missing regime data remains UNKNOWN; price/cost path is still recorded. */ }
  return { id: w.id, venue: 'binance-usdm', priceType: 'mark', symbol: intent.symbol,
    assetClass: intent.asset_class, side: intent.side, source: 'Binance public markPriceKlines and fundingRate',
    ...trailingRegime(daily, w.entryAt), entryAt: w.entryAt, endAt: w.endAt,
    entryPrice: bars[0].open, intervalMs: INTERVAL_MS, bars,
    costs: { feeRate: COST_SCENARIOS[0].feeRate, slippagePct: COST_SCENARIOS[0].slippagePct,
      fundingComplete: true, funding, source: 'observed funding; explicitly ASSUMED fee/slippage stress inputs' },
    researchContext: { method: HISTORY_METHOD, intentId: intent.client_order_id,
      source: intent.source, mode: intent.mode, horizonHours: hours,
      contextScope: 'historically reconstructed price regime, not a contemporaneously published model label',
      entryScope: 'next-complete-bar mark reference; NOT a limit fill or actual trade',
      signalPrice: numeric(intent.signal_price), originalLimitPrice: numeric(intent.limit_price),
      collectedAt: new Date(nowMs).toISOString(), currentContractIdentityOnly: true },
    liveEligible: false };
}
