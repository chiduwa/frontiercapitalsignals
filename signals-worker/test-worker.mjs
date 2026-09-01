// Integration test for the assembled Worker + engine. No real network.
//
// Architecture: the Worker reads the KV cache at request time (fits Workers
// Free plan's 50-subrequest/10ms-CPU caps). Its cron may dispatch the
// external build only when that cache is stale; the engine itself
// (buildPayload, ~130 outbound fetches + indicator math) runs in
// scripts/build-signals.mjs via GitHub Actions and is imported here directly
// to verify it still produces a sane payload.
//
// Run: node test-worker.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { computeSwingTimeTallies, barsRowsToReturnsBySymbol, matchProtocolsToUniverse, findPivots, walkSrLevels, isYahooCryptoDataTrustworthy, fundingSnapshotToRows } from './scripts/archive.mjs';
import { selectIntradayWatchlist, CRYPTO_WATCHLIST_SIZE } from './scripts/intraday.mjs';
import { parseBinanceKlines } from './scripts/archive.mjs';
import { selectMaturityPrice } from './scripts/reliability.mjs';
import { forEachConcurrent } from './scripts/d1-client.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name} ${detail}`); }
};

console.log('\n== forEachConcurrent: bounded D1 bulk-write queue ==');
const processedBatches = [];
let concurrentBatches = 0;
let peakConcurrentBatches = 0;
await forEachConcurrent([1, 2, 3, 4, 5], 2, async (batch) => {
  concurrentBatches++;
  peakConcurrentBatches = Math.max(peakConcurrentBatches, concurrentBatches);
  await new Promise((resolve) => setTimeout(resolve, 2));
  processedBatches.push(batch);
  concurrentBatches--;
});
check('processes every independent batch exactly once', processedBatches.length === 5 && new Set(processedBatches).size === 5, JSON.stringify(processedBatches));
check('never exceeds the configured bulk-write concurrency', peakConcurrentBatches <= 2, `peak=${peakConcurrentBatches}`);
await forEachConcurrent([], 4, async () => { throw new Error('empty queue must not invoke a worker'); });
check('empty bulk-write queue resolves without invoking a worker', true);

// ---- deterministic fake upstreams -----------------------------------------
const spark = Array.from({ length: 168 }, (_, i) => 100 + i * 0.05 + Math.sin(i / 6));
const dailyTs = Array.from({ length: 260 }, (_, i) => 1600000000 + i * 86400);
const dailyClose = Array.from({ length: 260 }, (_, i) => 100 + i * 0.2 + 3 * Math.sin(i / 9));
// getCryptoDailyHistory fixture: 210 daily bars, distinct curve from the
// stock one above. 'solana' deliberately has no stub below (falls through
// to the 404 catch-all) to exercise the sparkline-fallback path.
const cryptoDailyClose = Array.from({ length: 210 }, (_, i) => 50 + i * 0.15 + 2 * Math.sin(i / 11));
const cryptoDailyVol = cryptoDailyClose.map(() => 5e7);
const CRYPTO_DAILY_HISTORY_COINS = new Set(['bitcoin', 'ethereum', 'chainlink']);

function mkCoin(id, sym, name, price, mcap) {
  // Real feeds report current_price consistent with the sparkline tail; mirror
  // that so range math reflects production rather than a synthetic mismatch.
  price = spark[spark.length - 1];
  return {
    id, symbol: sym, name, current_price: price, market_cap: mcap,
    total_volume: mcap * 0.1, market_cap_rank: 1,
    price_change_percentage_1h_in_currency: 0.2,
    price_change_percentage_24h_in_currency: 2.0,
    price_change_percentage_24h: 2.0,
    price_change_percentage_7d_in_currency: 6.0,
    price_change_percentage_30d_in_currency: -12,
    sparkline_in_7d: { price: spark }
  };
}
const coins = [
  mkCoin('bitcoin', 'btc', 'Bitcoin', 63000, 1.2e12),
  mkCoin('ethereum', 'eth', 'Ethereum', 1800, 2.2e11),
  mkCoin('solana', 'sol', 'Solana', 75, 3.5e10),
  mkCoin('chainlink', 'link', 'Chainlink', 14, 9e9),
  mkCoin('tether', 'usdt', 'Tether', 1, 1e11), // must be filtered out
  // Below CRYPTO_MIN_MCAP/CRYPTO_MIN_VOLUME on purpose — a favorite must
  // still qualify (see FAVORITE_SYMBOLS' bypass in buildPayload), a
  // non-favorite at the same size must not.
  mkCoin('stellar', 'xlm', 'Stellar', 0.11, 10_000_000),
  mkCoin('some-microcap', 'micro', 'MicroCap', 0.01, 5_000_000)
];

function stubbedFetch(url) {
  const u = String(url);
  const ok = (body, isText) => Promise.resolve({
    ok: true, status: 200,
    json: async () => body,
    text: async () => (isText ? body : JSON.stringify(body)),
    headers: { get: () => null, getSetCookie: () => ['A=1; Path=/'] }
  });
  if (u.includes('/coins/markets')) return ok(coins);
  // /api/prices live-tick fixture. 'solana' deliberately omitted, mirroring
  // the daily-history fixture above, to exercise "id has no live quote ->
  // silently omitted, not an error" the same way a thin/renamed coin would.
  if (u.includes('/simple/price')) {
    return ok({
      bitcoin: { usd: 63500.5, usd_24h_change: 1.25 },
      ethereum: { usd: 1850.2, usd_24h_change: -0.6 },
      chainlink: { usd: 14.35, usd_24h_change: 2.4 }
    });
  }
  if (u.includes('/market_chart')) {
    const id = u.split('/coins/')[1].split('/market_chart')[0];
    if (!CRYPTO_DAILY_HISTORY_COINS.has(decodeURIComponent(id))) {
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}), text: async () => '' });
    }
    return ok({
      prices: cryptoDailyClose.map((c, i) => [1600000000000 + i * 86400000, c]),
      total_volumes: cryptoDailyVol.map((v, i) => [1600000000000 + i * 86400000, v])
    });
  }
  // Binance.US live-price split (/api/prices) — BTC/ETH resolve here
  // instead of CoinGecko's /simple/price below; chainlink is deliberately
  // left off this fixture so at least one displayed symbol still exercises
  // the CoinGecko path, same "one symbol proves the fallback still works"
  // discipline the solana omission uses for the hourly-build-price fallback.
  if (u.includes('/exchangeInfo')) {
    return ok({ symbols: [
      { symbol: 'BTCUSDT', status: 'TRADING', baseAsset: 'BTC', quoteAsset: 'USDT' },
      { symbol: 'ETHUSDT', status: 'TRADING', baseAsset: 'ETH', quoteAsset: 'USDT' },
      { symbol: 'LINKBUSD', status: 'TRADING', baseAsset: 'LINK', quoteAsset: 'BUSD' } // non-USDT quote, must NOT count
    ] });
  }
  if (u.includes('/ticker/24hr')) {
    return ok([
      { symbol: 'BTCUSDT', lastPrice: '64000.50', priceChangePercent: '3.2' },
      { symbol: 'ETHUSDT', lastPrice: '1900.10', priceChangePercent: '-1.1' }
    ]);
  }
  if (u.includes('/global')) return ok({ data: { total_market_cap: { usd: 2.3e12 }, market_cap_change_percentage_24h_usd: 1.5, market_cap_percentage: { btc: 52.1 } } });
  if (u.includes('alternative.me/fng')) return ok({ data: [{ value: '38', value_classification: 'Fear' }] });
  if (u.includes('search/trending')) return ok({ coins: [{ item: { symbol: 'SOL' } }] });
  // CoinGecko's aggregated derivatives listing (replaced Bybit's tickers
  // call after that endpoint started 403-ing from GitHub Actions — see
  // getFundingMap's docs). BTC deliberately listed on two markets with
  // different open_interest to exercise "keeps the highest-OI market" --
  // and different price/index pairs on those two, to also exercise "the
  // basis carried through is specifically the highest-OI market's own,
  // not some other market's leaking in."
  if (u.includes('/derivatives')) return ok([
    { contract_type: 'perpetual', index_id: 'BTC', symbol: 'BTCUSDT', funding_rate: 0.00005, open_interest: 5e9, market: 'Binance (Futures)', price: '64200', index: 64000 },
    { contract_type: 'perpetual', index_id: 'BTC', symbol: 'BTCUSDT', funding_rate: 0.00009, open_interest: 1e8, market: 'OKX (Futures)', price: '70000', index: 60000 },
    { contract_type: 'perpetual', index_id: 'SOL', symbol: 'SOLUSDT', funding_rate: -0.0001, open_interest: 8e8, market: 'Binance (Futures)', price: '150', index: 150 },
    { contract_type: 'perpetual', index_id: 'LINK', symbol: 'LINKUSDT', funding_rate: 0.0002, open_interest: 2e8, market: 'Binance (Futures)' },
    { contract_type: 'futures', index_id: 'BTC', symbol: 'BTCUSD_1226', funding_rate: 0.0003, open_interest: 9e9, market: 'CME (Futures)' }
  ]);
  if (u.includes('fc.yahoo.com')) return ok('', true);
  if (u.includes('getcrumb')) return ok('testcrumb', true);
  if (u.includes('quoteSummary')) {
    const sym = u.split('quoteSummary/')[1].split('?')[0];
    return ok({ quoteSummary: { result: [{ financialData: { targetMeanPrice: { raw: 200 }, targetHighPrice: { raw: 260 }, targetLowPrice: { raw: 150 }, numberOfAnalystOpinions: { raw: 30 }, recommendationMean: { raw: 2.1 }, recommendationKey: 'buy' }, defaultKeyStatistics: { forwardPE: { raw: 22 } } }] } });
  }
  if (u.includes('finance/chart/')) {
    return ok({ chart: { result: [{
      timestamp: dailyTs,
      meta: { regularMarketPrice: dailyClose[dailyClose.length - 1], previousClose: dailyClose[dailyClose.length - 2] },
      indicators: { quote: [{ close: dailyClose, volume: dailyClose.map(() => 1e6), high: dailyClose.map(c => c + 1), low: dailyClose.map(c => c - 1) }] } }] } });
  }
  return Promise.resolve({ ok: false, status: 404, json: async () => ({}), text: async () => '' });
}

// ---- mock KV ---------------------------------------------------------------
class MockKV {
  constructor() { this.store = new Map(); }
  async get(k) { return this.store.has(k) ? this.store.get(k) : null; }
  async put(k, v) { this.store.set(k, v); }
  async delete(k) { this.store.delete(k); }
}

// ---- mock D1 (Workers binding surface: prepare(sql).bind(...args).all()) --
// Table choice is inferred from the SQL text (same substring-matching
// style as stubbedFetch's URL matching above) since this mock only ever
// needs to serve the one route (/api/asset/:symbol) that reads D1 directly.
class MockD1 {
  constructor(seed) { this.seed = seed || { technique_reliability: [], range_reliability: [], asset_score_snapshots: [], notification_log: [] }; }
  prepare(sql) {
    const table = sql.includes('technique_reliability') ? 'technique_reliability'
      : sql.includes('range_reliability') ? 'range_reliability'
      : sql.includes('asset_score_snapshots') ? 'asset_score_snapshots'
      : sql.includes('notification_log') ? 'notification_log'
      : null;
    const rows = (table && this.seed[table]) || [];
    return {
      bind: (symbol) => ({ all: async () => ({ results: rows.filter((r) => r.symbol === symbol) }) }),
      // /api/feed's query has no bind params (a plain top-N SELECT) —
      // .all() callable directly on prepare()'s own return, distinct from
      // the .bind(symbol).all() chain every other D1-bound route here uses.
      all: async () => ({ results: rows })
    };
  }
}

// ---- load the worker module (also exports buildPayload + CACHE_KEY) -------
global.fetch = stubbedFetch;
const ctx = { waitUntil: (p) => { if (p && p.then) p.catch(() => {}); } };

const src = readFileSync(join(__dirname, 'worker.js'), 'utf8');
const mod = await import('data:text/javascript,' + encodeURIComponent(src));
const worker = mod.default;
check('worker exports fetch + stale-cache recovery cron', typeof worker.fetch === 'function' && typeof worker.scheduled === 'function');
check('buildPayload + CACHE_KEY exported for scripts/build-signals.mjs', typeof mod.buildPayload === 'function' && typeof mod.CACHE_KEY === 'string');

console.log('\n== stale-cache refresh dispatcher ==');
const originalFetch = global.fetch;
const dispatchCalls = [];
global.fetch = async (url, init) => {
  dispatchCalls.push({ url: String(url), init });
  return { ok: true, status: 204 };
};

const freshDispatchEnv = {
  FCS_CACHE: new MockKV(),
  GITHUB_ACTIONS_TOKEN: 'test-dispatch-token'
};
await freshDispatchEnv.FCS_CACHE.put(mod.CACHE_KEY, JSON.stringify({ generated_at: new Date().toISOString() }));
let scheduledWork;
worker.scheduled({}, freshDispatchEnv, { waitUntil: (promise) => { scheduledWork = promise; } });
const freshDispatchResult = await scheduledWork;
check('fresh cache does not dispatch the refresh workflow', freshDispatchResult === false && dispatchCalls.length === 0, JSON.stringify(dispatchCalls));

const staleDispatchEnv = {
  FCS_CACHE: new MockKV(),
  GITHUB_ACTIONS_TOKEN: 'test-dispatch-token'
};
await staleDispatchEnv.FCS_CACHE.put(mod.CACHE_KEY, JSON.stringify({
  generated_at: new Date(Date.now() - (mod.CACHE_SECONDS + 1) * 1000).toISOString()
}));
let staleScheduledWork;
worker.scheduled({}, staleDispatchEnv, { waitUntil: (promise) => { staleScheduledWork = promise; } });
const staleDispatchResult = await staleScheduledWork;
const dispatchRequest = dispatchCalls[0];
const dispatchBody = dispatchRequest && JSON.parse(dispatchRequest.init.body);
check('stale cache dispatches the existing refresh workflow once', staleDispatchResult === true && dispatchCalls.length === 1 && dispatchRequest.url.endsWith('/actions/workflows/signals-refresh.yml/dispatches'));
check('recovery dispatch preserves the freshness gate with force=false', dispatchBody && dispatchBody.ref === 'main' && dispatchBody.inputs.force === 'false');
check('recovery dispatch authenticates with the Worker secret', dispatchRequest && dispatchRequest.init.headers.Authorization === 'Bearer test-dispatch-token');
const duplicateDispatchResult = await mod.dispatchRefreshIfStale(staleDispatchEnv);
check('dispatcher lock prevents a duplicate dispatch while active', duplicateDispatchResult === false && dispatchCalls.length === 1);
const dispatchedStatusResponse = await worker.fetch(new Request('https://x.com/signals/api/refresh-status'), staleDispatchEnv, ctx);
const dispatchedStatus = await dispatchedStatusResponse.json();
check('refresh-status reports a successful guarded dispatch without exposing a token', dispatchedStatus.result === 'dispatched' && !JSON.stringify(dispatchedStatus).includes('test-dispatch-token'), JSON.stringify(dispatchedStatus));

const missingTokenEnv = { FCS_CACHE: new MockKV() };
await missingTokenEnv.FCS_CACHE.put(mod.CACHE_KEY, JSON.stringify({
  generated_at: new Date(Date.now() - (mod.CACHE_SECONDS + 1) * 1000).toISOString()
}));
let missingTokenError;
try {
  await mod.dispatchRefreshIfStale(missingTokenEnv);
} catch (error) {
  missingTokenError = error;
}
check('missing dispatch token fails with a clear configuration error', missingTokenError && missingTokenError.message.includes('GITHUB_ACTIONS_TOKEN Worker secret is required'));

const failedDispatchEnv = {
  FCS_CACHE: new MockKV(),
  GITHUB_ACTIONS_TOKEN: 'test-dispatch-token'
};
await failedDispatchEnv.FCS_CACHE.put(mod.CACHE_KEY, JSON.stringify({
  generated_at: new Date(Date.now() - (mod.CACHE_SECONDS + 1) * 1000).toISOString()
}));
global.fetch = async () => ({ ok: false, status: 503 });
let failedDispatchError;
try {
  await mod.dispatchRefreshIfStale(failedDispatchEnv);
} catch (error) {
  failedDispatchError = error;
}
check('failed GitHub dispatch surfaces its HTTP status', failedDispatchError && failedDispatchError.message.includes('HTTP 503'));
// Clearing the lock outright meant a persistently failing dispatch retried on
// every single request — which is what a 403 from an unscoped token actually
// did in production. A short cooldown stops the hammering while still letting
// a genuine recovery retry long before the 30-minute success lock would.
check('failed GitHub dispatch holds a cooldown rather than retrying on every request', await failedDispatchEnv.FCS_CACHE.get('signals:refresh-dispatch-lock') !== null);
let secondDispatchAttempted = false;
global.fetch = async () => { secondDispatchAttempted = true; return { ok: false, status: 503 }; };
check('a dispatch inside the cooldown window does not call GitHub again', await mod.dispatchRefreshIfStale(failedDispatchEnv) === false && secondDispatchAttempted === false);
global.fetch = async () => ({ ok: false, status: 503 });
const failedStatusResponse = await worker.fetch(new Request('https://x.com/signals/api/refresh-status'), failedDispatchEnv, ctx);
const failedStatus = await failedStatusResponse.json();
check('refresh-status reports failed dispatches with the safe HTTP error', failedStatus.result === 'failed' && failedStatus.error.includes('HTTP 503'), JSON.stringify(failedStatus));

const requestFallbackCalls = [];
global.fetch = async (url, init) => {
  requestFallbackCalls.push({ url: String(url), init });
  return { ok: true, status: 204 };
};
const staleRequestEnv = {
  FCS_CACHE: new MockKV(),
  GITHUB_ACTIONS_TOKEN: 'test-dispatch-token'
};
await staleRequestEnv.FCS_CACHE.put(mod.CACHE_KEY, JSON.stringify({
  generated_at: new Date(Date.now() - (mod.CACHE_SECONDS + 1) * 1000).toISOString()
}));
let staleRequestWork;
const staleResponse = await worker.fetch(
  new Request('https://x.com/signals/api/signals'),
  staleRequestEnv,
  { waitUntil: (promise) => { staleRequestWork = promise; } }
);
await staleRequestWork;
check('a stale signals API request returns immediately while queueing guarded recovery', staleResponse.headers.get('x-fcs-cache') === 'stale' && requestFallbackCalls.length === 1);
global.fetch = originalFetch;

console.log('\n== routing ==');
const emptyEnv = { FCS_CACHE: new MockKV() };
const redir = await worker.fetch(new Request('https://x.com/signals'), emptyEnv, ctx);
check('/signals -> 301', redir.status === 301, `got ${redir.status}`);
check('301 targets /signals/', (redir.headers.get('location') || '').endsWith('/signals/'));

const page = await worker.fetch(new Request('https://x.com/signals/'), emptyEnv, ctx);
const pageText = await page.text();
check('dashboard served', page.headers.get('content-type').includes('text/html') && pageText.includes('Frontier Capital'));

// Every embedded <script> block must actually parse — added 2026-08-22
// after a real, live incident: an apostrophe inside a single-quoted
// string (r.flipStability's title text) broke the WHOLE dashboard, silent
// at every other layer. PAGE_HTML is a JS template literal (worker.js),
// so a backslash-escaped `\'` in the SOURCE gets consumed by the OUTER
// template literal's own escape processing before the string ever reaches
// the browser -- what worker.js's source shows as `\'` renders as a bare,
// unescaped `'` in the actual page, which node --check confirmed silently
// (no build-time error, no runtime error report -- the whole inline
// script just fails to parse in the browser, so NOTHING on the page
// renders). `new Function(...)` throws SyntaxError immediately on a bad
// script without ever executing it, the same fast, side-effect-free check
// used to find and confirm the fix for the real incident.
const embeddedScripts = [...pageText.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((s) => s.trim());
check('at least one inline <script> block found to check', embeddedScripts.length > 0, `found ${embeddedScripts.length}`);
for (const [i, scriptSrc] of embeddedScripts.entries()) {
  let syntaxError = null;
  try { new Function(scriptSrc); } catch (e) { syntaxError = e.message; }
  check(`inline <script> block ${i} parses with no syntax error (a broken one takes down the ENTIRE dashboard, silently)`, syntaxError === null, syntaxError);
}
check('dashboard sends CSP + hardening headers', !!page.headers.get('content-security-policy') && page.headers.get('x-content-type-options') === 'nosniff' && page.headers.get('x-frame-options') === 'DENY');
check('CSP allows GTM/GA4 domains (script-src + connect-src)', page.headers.get('content-security-policy').includes('googletagmanager.com') && page.headers.get('content-security-policy').includes('google-analytics.com'));
check('GTM container + consent-mode snippet present in the page', pageText.includes('GTM-5Q7JC6JX') && pageText.includes('fcs_consent_v1') && pageText.includes("gtag('consent','default'"));
check('custom event pushes present (data-loaded, error, methodology-open)', pageText.includes('signals_data_loaded') && pageText.includes('signals_feed_error') && pageText.includes('signals_methodology_open'));
check('clickable-row + sortable-header tracking present', pageText.includes('signals_asset_click') && pageText.includes('signals_sort_change') && pageText.includes('sym-link') && pageText.includes('sortable'));
check('horizon chip markup + methodology copy present', pageText.includes('class="horizon') && pageText.includes('hz-hist') && pageText.includes('hz-meth') && pageText.includes('Leading vs. lagging'));
check('track-record section + methodology copy present', pageText.includes('id="trackRecord"') && pageText.includes('95%+') && pageText.includes('Prediction-score track record'));
check('live-price markup + polling code present', pageText.includes('live-price-cell') && pageText.includes('live-chg-cell') && pageText.includes("api/prices") && pageText.includes('updateLivePrices'));
check('favorites board says just "FAVORITES", not a possessive "YOUR FAVORITES"', pageText.includes('>FAVORITES</b>') && !pageText.includes('YOUR FAVORITES'), pageText.includes('YOUR FAVORITES'));
check('per-row direction arrow + consolidating-badge markup present', pageText.includes('dir-arrow') && pageText.includes('class="coil') && pageText.includes('Consolidating'));
check('quality + rotation badge markup present', pageText.includes('class="quality') && pageText.includes('class="rotation') && pageText.includes('Rotating in'));
check('flip-caution badge markup present', pageText.includes('class="flip-note') && pageText.includes('Flipped') && pageText.includes('extra caution'));
check('long-term-potential badge markup + prominent not-financial-advice disclaimer present', pageText.includes('class="ltp-note') && pageText.includes('Long-term potential') && pageText.includes('Not a recommendation, not guaranteed, not financial advice'));
check('a link back to the FCS homepage is present', pageText.includes('class="home-link"') && pageText.includes('href="https://frontiercapitalsignals.com/"'));

console.log('\n== getFundingMap: CoinGecko derivatives, highest-OI perpetual market wins ==');
const fundingMap = await mod.getFundingMap();
check('BTC picks the higher-OI perpetual market (Binance, 5e9) over the lower-OI one (OKX, 1e8)', fundingMap.BTC.fundingRate === 0.00005 && fundingMap.BTC.openInterest === 5e9, JSON.stringify(fundingMap.BTC));
check('a futures (non-perpetual) contract with even higher OI is correctly excluded', fundingMap.BTC.market === 'Binance (Futures)', fundingMap.BTC.market);
check('SOL and LINK (single-market fixtures) both present', fundingMap.SOL.fundingRate === -0.0001 && fundingMap.LINK.fundingRate === 0.0002);
check('BTC\'s basisPct comes from the SAME highest-OI market\'s own price/index (64200/64000), not the lower-OI OKX market\'s (70000/60000)', Math.abs(fundingMap.BTC.basisPct - ((64200 / 64000 - 1) * 100)) < 1e-9, fundingMap.BTC.basisPct);
check('SOL: perp trading exactly at its index -> zero basis', fundingMap.SOL.basisPct === 0);
check('LINK: no price/index in this market\'s fixture -> basisPct is null, not a crash or a fabricated zero', fundingMap.LINK.basisPct === null);

console.log('\n== getFundingMap: retries on 429, gives up on persistent 429 (found live, 2026-08-21/22 -- a single un-retried 429 was silently wiping out the whole day\'s funding/OI/basis snapshot) ==');
let fundingCall429Count = 0;
global.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/derivatives')) {
    fundingCall429Count++;
    if (fundingCall429Count > 1) {
      return { ok: true, status: 200, json: async () => ([{ contract_type: 'perpetual', index_id: 'BTC', symbol: 'BTCUSDT', funding_rate: 0.0001, open_interest: 1e9, market: 'Binance (Futures)' }]), headers: { get: () => null } };
    }
    return { ok: false, status: 429, json: async () => ({}), text: async () => 'rate limited', headers: { get: () => null } };
  }
  return stubbedFetch(url);
};
const fundingRecovered = await mod.getFundingMap();
check('recovers after one 429 (retried, second attempt succeeded)', fundingRecovered.BTC.fundingRate === 0.0001 && fundingCall429Count === 2, `calls=${fundingCall429Count}`);

fundingCall429Count = 0;
global.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/derivatives')) {
    fundingCall429Count++;
    return { ok: false, status: 429, json: async () => ({}), text: async () => 'rate limited', headers: { get: () => null } };
  }
  return stubbedFetch(url);
};
let fundingThrew = false;
try { await mod.getFundingMap(); } catch { fundingThrew = true; }
check('gives up after exhausting retries on persistent 429, does not hang or silently return empty', fundingThrew && fundingCall429Count === 3, `calls=${fundingCall429Count}`);
global.fetch = stubbedFetch;

console.log('\n== api: empty KV (before first Action run) ==');
const empty = await worker.fetch(new Request('https://x.com/signals/api/signals'), emptyEnv, ctx);
const emptyBody = await empty.json();
check('empty API still 200', empty.status === 200);
check('empty marked "empty"', empty.headers.get('x-fcs-cache') === 'empty', empty.headers.get('x-fcs-cache'));
check('empty payload carries an error message', typeof emptyBody.error === 'string');
check('empty response carries hardening headers too', empty.headers.get('x-content-type-options') === 'nosniff');

console.log('\n== getCryptoDailyHistory: retries on 429, gives up on persistent 429 ==');
let call429Count = 0;
global.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/market_chart')) {
    call429Count++;
    if (u.includes('recovers-after-one-429') && call429Count > 1) {
      return {
        ok: true, status: 200,
        json: async () => ({
          prices: cryptoDailyClose.map((c, i) => [1600000000000 + i * 86400000, c]),
          total_volumes: cryptoDailyVol.map((v, i) => [1600000000000 + i * 86400000, v])
        }),
        headers: { get: () => null }
      };
    }
    return { ok: false, status: 429, json: async () => ({}), text: async () => 'rate limited', headers: { get: () => null } };
  }
  return stubbedFetch(url);
};
const recovered = await mod.getCryptoDailyHistory('recovers-after-one-429');
check('recovers after one 429 (retried, second attempt succeeded)', recovered.closes.length > 60 && call429Count === 2, `calls=${call429Count}`);

call429Count = 0;
let threw = false;
try { await mod.getCryptoDailyHistory('always-429'); }
catch { threw = true; }
check('gives up after exhausting retries on persistent 429', threw && call429Count === 3, `calls=${call429Count}`);
global.fetch = stubbedFetch;

console.log('\n== buildCryptoMetrics: real daily bars vs sparkline fallback ==');
const btcCoin = coins.find(c => c.id === 'bitcoin');
const solCoin = coins.find(c => c.id === 'solana');
const btcDaily = { closes: cryptoDailyClose, volumes: cryptoDailyVol };
const withDaily = mod.buildCryptoMetrics(btcCoin, { daily: btcDaily });
const withoutDaily = mod.buildCryptoMetrics(solCoin, { daily: null });
check('daily bars give a real SMA20/50/200 stack', withDaily.sma20 != null && withDaily.sma50 != null && withDaily.sma200 != null);
check('daily bars give OBV (crypto had none before)', withDaily.obv != null);
check('sparkline fallback has no SMA stack (falls back to mean7d/slope MA branch)', withoutDaily.sma20 == null && withoutDaily.sma200 == null);
check('sparkline fallback has no OBV (7d sparkline carries no per-bar volume)', withoutDaily.obv == null);
check('sparkline fallback still produces a usable rsi/macd/bollinger', withoutDaily.rsi != null && withoutDaily.bb != null);
check('daily bars (210 days, above the backtest minimum) give a real, asset-calibrated vol lookback', withDaily.volLookbackDays != null && [10, 20, 30, 60, 90].includes(withDaily.volLookbackDays));
check('sparkline fallback has no calibrated lookback (no real daily history to backtest against)', withoutDaily.volLookbackDays == null);

console.log('\n== engine: buildPayload() called directly, as build-signals.mjs will ==');
const { payload: built, log } = await mod.buildPayload({ TREFIS_OVERRIDES: '{"AAPL": 999}' });
check('crypto boards populated', built.crypto.breakout.length > 0 && built.crypto.universe >= 3);
// 5, not 4: bitcoin/ethereum/solana/chainlink + stellar (a favorite,
// deliberately fixtured below CRYPTO_MIN_MCAP/CRYPTO_MIN_VOLUME to prove
// the bypass actually works) — tether (blocklisted) and some-microcap (an
// ordinary non-favorite coin at the same size as stellar) are both
// correctly excluded.
check('stablecoin filtered, favorite bypasses the mcap/volume floor, an equally-small non-favorite does not', built.crypto.universe === 5, `universe=${built.crypto.universe}`);
check('the favorite itself is present in favorites despite being far below the normal mcap/volume floor', built.crypto.favorites.some(f => f.symbol === 'XLM'), JSON.stringify(built.crypto.favorites.map(f => f.symbol)));
check('an equally-small NON-favorite is excluded from the universe entirely, not just from favorites', !built.crypto.breakout.concat(built.crypto.breakdown, built.crypto.favorites).some(r => r.symbol === 'MICRO'));
check('only the 7 named favorites ever appear in the favorites section', built.crypto.favorites.every(f => ['BTC', 'ETH', 'SOL', 'XLM', 'XRP', 'HYPE', 'HBAR'].includes(f.symbol)), JSON.stringify(built.crypto.favorites.map(f => f.symbol)));
check('stocks never carry a favorites section (FAVORITE_SYMBOLS is crypto-only)', Array.isArray(built.stocks.favorites) && built.stocks.favorites.length === 0);
check('every favorites row is shaped exactly like a board row (reuses entry(), not a second implementation)', built.crypto.favorites.every(f => typeof f.score === 'number' && (f.dir === 1 || f.dir === -1) && typeof f.price === 'number'));
check('every crypto board row carries a consolidating field, null or a real direction, never anything else', built.crypto.breakout.concat(built.crypto.breakdown, built.crypto.favorites).every(r => r.consolidating === null || r.consolidating === 1 || r.consolidating === -1), JSON.stringify(built.crypto.breakout.map(r => r.consolidating)));
check('every crypto board row carries a rotation field, null or a real streak object, never anything else', built.crypto.breakout.concat(built.crypto.breakdown, built.crypto.favorites).every(r => r.rotation === null || typeof r.rotation.peakRel === 'number'));
check('every crypto board row carries recentFlip/flipStability fields, safely null with no callFlipData passed (never a crash)', built.crypto.breakout.concat(built.crypto.breakdown, built.crypto.favorites).every(r => r.recentFlip === null && r.flipStability === null));
check('every crypto board row carries a longTermPotential field, safely null with no longTermBottomStatus passed (never a crash)', built.crypto.breakout.concat(built.crypto.breakdown, built.crypto.favorites).every(r => r.longTermPotential === null));
check('longTermPotential board key exists and is empty when no longTermBottomStatus was passed (not undefined -- the dashboard branches on .length)', Array.isArray(built.crypto.longTermPotential) && built.crypto.longTermPotential.length === 0);
check('stocks never carry a longTermPotential section (crypto-only, same reasoning as favorites)', Array.isArray(built.stocks.longTermPotential) && built.stocks.longTermPotential.length === 0);
check('stocks boards populated', built.stocks.breakout.length > 0);
// Ceiling is 18, not 16, now that fibonacci and timeofday exist (see
// TECHNIQUE_META) — 'attention' is crypto-trending-conditional so it's
// already excluded from the max in practice, same as before; timeofday
// specifically abstains (null) in this call since no todStats was passed,
// but the bound should describe what CAN apply, not happen to match
// whatever one fixture's seasonalAnalog result coincidentally lands on.
check('confluence agreement present', built.crypto.breakout[0].conf && built.crypto.breakout[0].conf.total >= 10 && built.crypto.breakout[0].conf.total <= 18);
check('rangePos stays in [0,1]', built.crypto.breakout.every(r => r.rangePos == null || (r.rangePos >= 0 && r.rangePos <= 1)));
check('valuation flowed in', built.stocks.breakout.concat(built.stocks.breakdown).some(r => r.val));
check('trefis override applied', built.health.trefis_overrides === 1);
check('funding fed to crypto', built.crypto.breakout.concat(built.crypto.breakdown).some(r => r.funding != null));
check('open interest fed to crypto', built.crypto.breakout.concat(built.crypto.breakdown).some(r => r.openInterest != null));
check('DXY/Gold/Oil macro benchmarks reach payload.overview', built.overview.dxy && built.overview.gold && built.overview.oil, JSON.stringify(built.overview));
check('UST2Y/UST10Y Treasury yield benchmarks reach payload.overview too', built.overview.ust2y && built.overview.ust10y, JSON.stringify(built.overview));
check('health counts sane', built.health.stocks_ok === built.health.stocks_total && built.health.valuation_ok > 0);
check('crypto_daily health reflects the daily-history fetch (3 of 5 succeed, solana and stellar have none stubbed)', built.health.crypto_daily_total === 5 && built.health.crypto_daily_ok === 3, `ok=${built.health.crypto_daily_ok} total=${built.health.crypto_daily_total}`);
check('votesLog/priceLog/rangeLog/allSymbols not leaked into the public payload', built.crypto.votesLog === undefined && built.crypto.priceLog === undefined && built.crypto.rangeLog === undefined && built.crypto.allSymbols === undefined && built.stocks.votesLog === undefined && built.stocks.rangeLog === undefined && built.stocks.allSymbols === undefined);
check('internal signal candidates are logged for alerting but not leaked into the public payload', Array.isArray(log.signals) && log.signals.every(s => (s.dir === 1 || s.dir === -1) && typeof s.score === 'number') && built.signals === undefined);
check('log has directional votes for both asset classes', log.votes.some(v => v.asset_class === 'crypto') && log.votes.some(v => v.asset_class === 'stock'));
check('log votes are directional only (no 0/null dir)', log.votes.every(v => v.dir === 1 || v.dir === -1));
check('log has a price row per universe asset, both classes', log.prices.length === built.crypto.universe + built.stocks.universe);
check('log has one composite vote per directionally-called asset, both classes', log.votes.some(v => v.technique_id === 'composite' && v.asset_class === 'crypto') && log.votes.some(v => v.technique_id === 'composite' && v.asset_class === 'stock'));
check('composite votes carry their own 0-100 score, for the calibration curve', log.votes.filter(v => v.technique_id === 'composite').every(v => typeof v.score === 'number' && v.score >= 0 && v.score <= 100));
check('real (non-composite) technique votes do not carry a score — only composite rows do', log.votes.filter(v => v.technique_id !== 'composite').every(v => v.score === undefined));
check('log has range predictions at both the 1d (24h) and 7d (168h) horizons', log.ranges.some(r => r.horizon_hours === 24) && log.ranges.some(r => r.horizon_hours === 168));
check('every logged range prediction is a real band (low < high)', log.ranges.length > 0 && log.ranges.every(r => r.low < r.high));
check('highAccuracy present as an array even with no reliability data fed in (none qualify yet)', Array.isArray(built.highAccuracy) && built.highAccuracy.length === 0);
check('crypto entries carry a CoinGecko id (for the dashboard\'s outbound link)', built.crypto.breakout.concat(built.crypto.breakdown).every(r => typeof r.id === 'string' && r.id.length > 0));
check('stock entries have no id field (not applicable, uses symbol for the Yahoo link instead)', built.stocks.breakout.every(r => r.id === undefined));
check('every ranked row carries a horizon estimate end-to-end through buildPayload', built.crypto.breakout.concat(built.crypto.breakdown, built.stocks.breakout, built.stocks.breakdown).every(r => r.horizon && typeof r.horizon.label === 'string' && (r.horizon.basis === 'methodology' || r.horizon.basis === 'historical')));

console.log('\n== engine: qualifying highAccuracy entries preserve asset class, price, and range ==');
const qualifyingReliability = {
  'BTC|composite': { correct: 25, total: 25, accuracy: 1 },
  'AAPL|composite': { correct: 25, total: 25, accuracy: 1 }
};
const { payload: builtQualifying } = await mod.buildPayload({ TREFIS_OVERRIDES: '{"AAPL": 999}' }, qualifyingReliability, undefined, undefined, {});
const btcEntry = builtQualifying.highAccuracy.find(r => r.symbol === 'BTC');
const aaplEntry = builtQualifying.highAccuracy.find(r => r.symbol === 'AAPL');
check('BTC clears the 95%+ bar given a synthetic 25/25 composite record', !!btcEntry, JSON.stringify(builtQualifying.highAccuracy));
check('the qualifying entry carries a real current price, not just a bare score', btcEntry && typeof btcEntry.price === 'number' && btcEntry.price > 0);
check('the qualifying entry carries its own predicted range (low < high) and a coin id to link out', btcEntry && btcEntry.range && btcEntry.range.low < btcEntry.range.high && typeof btcEntry.id === 'string');
check('the qualifying entry carries a horizon label for that range\'s own period', btcEntry && btcEntry.horizon && typeof btcEntry.horizon.label === 'string');
check('qualifying crypto and equity rows retain their asset class so the dashboard labels and links stay correct', btcEntry && btcEntry.asset_class === 'crypto' && aaplEntry && aaplEntry.asset_class === 'stock', JSON.stringify({ btc: btcEntry && btcEntry.asset_class, aapl: aaplEntry && aaplEntry.asset_class }));

console.log('\n== reliability weighting: confluence() with a synthetic reliability map ==');
const btcMetrics = mod.buildCryptoMetrics(btcCoin, { daily: btcDaily });
const baseline = mod.confluence(btcMetrics, 'crypto');
const boosted = mod.confluence(btcMetrics, 'crypto', { [`${btcMetrics.symbol}|rsi`]: { accuracy: 1.0, correct: 50, total: 50 } });
const nerfed = mod.confluence(btcMetrics, 'crypto', { [`${btcMetrics.symbol}|rsi`]: { accuracy: 0.0, correct: 0, total: 50 } });
const belowThreshold = mod.confluence(btcMetrics, 'crypto', { [`${btcMetrics.symbol}|rsi`]: { accuracy: 1.0, correct: 3, total: 3 } });
check('reliability multiplier changes the score vs baseline (enough samples)', boosted.long !== baseline.long || boosted.short !== baseline.short || nerfed.long !== baseline.long || nerfed.short !== baseline.short);
check('below MIN_RELIABILITY_SAMPLES, weighting stays at baseline (no overfit to small samples)', belowThreshold.long === baseline.long && belowThreshold.short === baseline.short);
check('reliabilityMultiplier clamps to [0.5, 1.5]', mod.reliabilityMultiplier({ 'X|y': { accuracy: 5, correct: 50, total: 50 } }, 'X', 'y') === 1.5 && mod.reliabilityMultiplier({ 'X|y': { accuracy: -5, correct: 0, total: 50 } }, 'X', 'y') === 0.5);
check('reliabilityMultiplier is neutral (1) with no reliability data', mod.reliabilityMultiplier(undefined, 'X', 'y') === 1 && mod.reliabilityMultiplier({}, 'X', 'y') === 1);

console.log('\n== isReliabilitySignificant: guards against trusting noise at small sample sizes ==');
check('14/20 (70%): NOT significant — this is exactly the kind of small-sample noise the guardrail targets', mod.isReliabilitySignificant(14, 20) === false);
check('15/20 (75%): still not significant', mod.isReliabilitySignificant(15, 20) === false);
check('16/20 (80%): significant — the bar a small sample actually needs to clear', mod.isReliabilitySignificant(16, 20) === true);
check('62/100 (62%): not significant at a larger sample too, same z-test', mod.isReliabilitySignificant(62, 100) === false);
check('63/100 (63%): significant — larger samples need a less extreme rate to clear the same bar', mod.isReliabilitySignificant(63, 100) === true);
check('exactly 50/50 (10/20): never significant, that is the null hypothesis itself', mod.isReliabilitySignificant(10, 20) === false);
check('two-sided: a rate significantly BELOW 50% also counts (4/20 = 20%)', mod.isReliabilitySignificant(4, 20) === true);
check('zero samples: false, not a division-by-zero crash', mod.isReliabilitySignificant(0, 0) === false);

console.log('\n== reliabilityMultiplier: enough samples is not enough on its own, still needs significance ==');
const notSignificantRec = { 'X|y': { accuracy: 0.7, correct: 14, total: 20 } }; // clears MIN_RELIABILITY_SAMPLES, fails isReliabilitySignificant
const significantRec = { 'X|y': { accuracy: 0.8, correct: 16, total: 20 } };
check('14/20 clears the sample-count floor but not significance: multiplier stays neutral (1), not boosted to 1.2', mod.reliabilityMultiplier(notSignificantRec, 'X', 'y') === 1, mod.reliabilityMultiplier(notSignificantRec, 'X', 'y'));
check('16/20 clears both bars: multiplier actually reflects the measured accuracy', mod.reliabilityMultiplier(significantRec, 'X', 'y') === mod.clamp(0.5 + 0.8, 0.5, 1.5), mod.reliabilityMultiplier(significantRec, 'X', 'y'));
const classPrior = { byAssetClass: { crypto: { y: { accuracy: 0.6, total: 100 } } }, overall: {} };
check('asset-class prior shrinks a significant asset-specific record toward the broader technique baseline instead of fully trusting the raw rate', mod.reliabilityMultiplierForAssetClass(significantRec, 'X', 'y', undefined, undefined, 'crypto', classPrior) < mod.reliabilityMultiplier(significantRec, 'X', 'y'));

console.log('\n== regimeOf: trend/chop classification off swing structure ==');
check('structure 1 (higher-highs/higher-lows): trending', mod.regimeOf(1) === 'trending');
check('structure -1 (lower-highs/lower-lows): trending (either direction counts)', mod.regimeOf(-1) === 'trending');
check('structure 0 (neither): choppy', mod.regimeOf(0) === 'choppy');
check('null (not enough history to compute structure): null, not fabricated into a bucket', mod.regimeOf(null) === null);

console.log('\n== reliabilityMultiplier: regime-specific track record preferred over blended once it clears the same bar ==');
const blendedOnly = { 'X|y': { accuracy: 0.6, correct: 12, total: 20 } }; // clears MIN_RELIABILITY_SAMPLES but not significance on its own
const byRegimeStrong = { trending: { 'X|y': { accuracy: 0.85, correct: 17, total: 20 } }, choppy: {} };
const byRegimeThin = { trending: { 'X|y': { accuracy: 0.9, correct: 9, total: 10 } }, choppy: {} }; // regime-specific but below MIN_RELIABILITY_SAMPLES
check('no regime passed at all: behaves exactly like the pre-Phase-6 call (blended only)', mod.reliabilityMultiplier(blendedOnly, 'X', 'y') === 1);
check('regime passed but no byRegime data: falls back to blended', mod.reliabilityMultiplier(blendedOnly, 'X', 'y', undefined, 'trending') === 1);
check('significant regime-specific record: overrides blended with the regime-specific accuracy', mod.reliabilityMultiplier(blendedOnly, 'X', 'y', byRegimeStrong, 'trending') === mod.clamp(0.5 + 0.85, 0.5, 1.5));
check('regime-specific sample too thin (below MIN_RELIABILITY_SAMPLES): falls back to blended rather than trusting it anyway', mod.reliabilityMultiplier(blendedOnly, 'X', 'y', byRegimeThin, 'trending') === 1);
check('asset currently choppy but only trending data exists for it: falls back to blended, not cross-regime data', mod.reliabilityMultiplier(blendedOnly, 'X', 'y', byRegimeStrong, 'choppy') === 1);

console.log('\n== scoreBucket: decile bucketing for the calibration curve ==');
check('0 -> bucket 0', mod.scoreBucket(0) === 0);
check('9 -> bucket 0 (still in [0,10))', mod.scoreBucket(9) === 0);
check('10 -> bucket 1 (first value in [10,20))', mod.scoreBucket(10) === 1);
check('85 -> bucket 8', mod.scoreBucket(85) === 8);
check('90 -> bucket 9', mod.scoreBucket(90) === 9);
check('99 -> bucket 9', mod.scoreBucket(99) === 9);
check('100 -> bucket 9, not 10 (clamped, not just floored)', mod.scoreBucket(100) === 9);
check('negative input clamps to bucket 0 rather than going negative (defensive, should not happen given confluence already clamps)', mod.scoreBucket(-5) === 0);

console.log('\n== selectMaturityPrice: learning only scores the exact forecast horizon ==');
const maturityTarget = '2026-01-02T00:00:00.000Z';
const maturityMatch = selectMaturityPrice([
  { run_at: '2026-01-01T23:55:00.000Z', price: 80 },
  { run_at: '2026-01-02T01:10:00.000Z', price: 130 },
  { run_at: '2026-01-02T00:20:00.000Z', price: 110 },
  { run_at: '2026-01-02T00:45:00.000Z', price: 120 }
], maturityTarget);
check('ignores an observation before the target and chooses the first valid post-target observation, not a later price', maturityMatch && maturityMatch.price === 110 && maturityMatch.run_at === '2026-01-02T00:20:00.000Z', JSON.stringify(maturityMatch));
check('rejects a price beyond the bounded target-time lag instead of treating it as a delayed 24h/168h outcome', selectMaturityPrice([{ run_at: '2026-01-02T01:31:00.000Z', price: 110 }], maturityTarget) === null);
check('malformed observations cannot fabricate a maturity match', selectMaturityPrice([{ run_at: 'bad timestamp', price: 110 }, { run_at: maturityTarget, price: 'not-a-number' }], maturityTarget) === null);

console.log('\n== rsiSeries / rsiRecentRange ==');
check('rsiSeries final value matches the scalar rsi()', mod.rsiSeries(dailyClose)[mod.rsiSeries(dailyClose).length - 1] === mod.rsi(dailyClose));
const decline = Array.from({ length: 20 }, (_, i) => 100 - i);
const dipThenRecover = [...decline, ...Array.from({ length: 10 }, (_, i) => decline[decline.length - 1] + (i + 1) * 2)]; // declines to 81, then recovers
const dipRange = mod.rsiRecentRange(dipThenRecover, 15);
check('rsiRecentRange finds a real min/max spanning the trough and the recovery, not just the tail', dipRange.min === 0 && dipRange.max > 60, `min=${dipRange.min} max=${dipRange.max}`);

console.log('\n== reversal technique: only fires with an actual trough/peak + independent confirmation ==');
const findTech = (T, id) => T.find(t => t.id === id);
const baseMetric = (overrides) => ({ symbol: 'TESTASSET', chg24h: 1, chg7d: 2, ...overrides });

const bottomNoConfirm = baseMetric({ rsi: 35, rsiPrev: 28, rsiRecentMin: 25, rsiRecentMax: 60 }); // troughed+turning, but no stoch/bb/structure/divergence/obv confirmation
const bottomWithConfirm = baseMetric({ rsi: 35, rsiPrev: 28, rsiRecentMin: 25, rsiRecentMax: 60, structure: 1 });
const stillFalling = baseMetric({ rsi: 32, rsiPrev: 34, rsiRecentMin: 20, rsiRecentMax: 60, structure: 1 }); // recovered enough off the min (32 > 20+5) but rsi < rsiPrev: still falling, hasn't turned yet
const topWithConfirm = baseMetric({ rsi: 60, rsiPrev: 66, rsiRecentMin: 40, rsiRecentMax: 75, structure: -1 });

const rNoConfirm = findTech(mod.evaluateTechniques(bottomNoConfirm, 'crypto'), 'reversal');
const rWithConfirm = findTech(mod.evaluateTechniques(bottomWithConfirm, 'crypto'), 'reversal');
const rStillFalling = findTech(mod.evaluateTechniques(stillFalling, 'crypto'), 'reversal');
const rTop = findTech(mod.evaluateTechniques(topWithConfirm, 'crypto'), 'reversal');

check('RSI troughed+turning but NO independent confirmation: stays neutral, not a bullish call', rNoConfirm.dir === 0, `dir=${rNoConfirm.dir}`);
check('RSI troughed+turning WITH structure confirmation: fires bullish', rWithConfirm.dir === 1, `dir=${rWithConfirm.dir}`);
check('RSI merely low but still falling (not turned yet): does not fire, even with a confirmation present', rStillFalling.dir !== 1, `dir=${rStillFalling.dir}`);
check('mirror case: RSI peaked+turning down WITH confirmation fires bearish', rTop.dir === -1, `dir=${rTop.dir}`);

const rNoSentiment = findTech(mod.evaluateTechniques(bottomWithConfirm, 'crypto', undefined, { marketContext: {} }), 'reversal');
const rExtremeFear = findTech(mod.evaluateTechniques(bottomWithConfirm, 'crypto', undefined, { marketContext: { fearGreed: 15 } }), 'reversal');
const rExtremeGreedIrrelevantToBottom = findTech(mod.evaluateTechniques(bottomWithConfirm, 'crypto', undefined, { marketContext: { fearGreed: 90 } }), 'reversal');
check('crypto: extreme fear boosts weight on a bottom call', rExtremeFear.w > rNoSentiment.w, `boosted=${rExtremeFear.w} base=${rNoSentiment.w}`);
check('crypto: extreme greed (misaligned) leaves weight at base for a bottom call', rExtremeGreedIrrelevantToBottom.w === rNoSentiment.w);

const stockBottom = baseMetric({ rsi: 35, rsiPrev: 28, rsiRecentMin: 25, rsiRecentMax: 60, structure: 1 });
const rStockNoVix = findTech(mod.evaluateTechniques(stockBottom, 'stock', undefined, { marketContext: {} }), 'reversal');
const rStockHighVix = findTech(mod.evaluateTechniques(stockBottom, 'stock', undefined, { marketContext: { vixRangePos: 0.85 } }), 'reversal');
check('stock: elevated VIX boosts weight on a bottom call', rStockHighVix.w > rStockNoVix.w, `boosted=${rStockHighVix.w} base=${rStockNoVix.w}`);

console.log('\n== combo reinforcement: proven agreeing pairs get only a modest extra lift ==');
const comboMetric = baseMetric({ symbol: 'PAIR', chgShort: 2, chg24h: 3, chg7d: 5, rsi: 50, rsiPrev: 45 });
const comboBaseline = mod.evaluateTechniques(comboMetric, 'crypto');
const comboBoosted = mod.evaluateTechniques(comboMetric, 'crypto', undefined, {
  comboReliability: { 'PAIR|momentum|rsi': { correct: 18, total: 20, accuracy: 0.9 } }
});
check('a proven same-direction pair slightly boosts the participating techniques, not the whole model indiscriminately', findTech(comboBoosted, 'momentum').w > findTech(comboBaseline, 'momentum').w && findTech(comboBoosted, 'rsi').w > findTech(comboBaseline, 'rsi').w);
check('the pair boost stays modest (capped well below a full extra technique)', findTech(comboBoosted, 'momentum').w < findTech(comboBaseline, 'momentum').w * 1.2, `${findTech(comboBaseline, 'momentum').w} -> ${findTech(comboBoosted, 'momentum').w}`);

console.log('\n== expected timeframe: leading/lagging classification + horizon estimation ==');
const allTechniqueIds = new Set([
  ...mod.evaluateTechniques(baseMetric({ trending: true }), 'crypto').map(t => t.id),
  ...mod.evaluateTechniques(baseMetric({}), 'stock').map(t => t.id)
]);
const missingMeta = [...allTechniqueIds].filter(id => !mod.TECHNIQUE_META[id] || typeof mod.TECHNIQUE_META[id].leading !== 'boolean' || typeof mod.TECHNIQUE_META[id].horizonDays !== 'number');
check('every technique evaluateTechniques() can emit has a complete TECHNIQUE_META entry', missingMeta.length === 0, `missing=${JSON.stringify(missingMeta)}`);

check('horizonLabel buckets: 1 day / few days / a week / weeks', mod.horizonLabel(1) === '~1 day' && mod.horizonLabel(2.5) === '1-3 days' && mod.horizonLabel(5) === '3-6 days' && mod.horizonLabel(8) === '~1 week' && mod.horizonLabel(15) === '1-3 weeks' && mod.horizonLabel(25) === '3+ weeks');

const noHorizonData = mod.confluence(bottomWithConfirm, 'crypto');
check('no reliability-by-horizon data: falls back to a methodology-based estimate', noHorizonData.longHorizon && noHorizonData.longHorizon.basis === 'methodology', JSON.stringify(noHorizonData.longHorizon));

const symbol = bottomWithConfirm.symbol;
const activeBullIds = mod.evaluateTechniques(bottomWithConfirm, 'crypto').filter(t => t.dir === 1).map(t => t.id);
const strongAt24h = {
  24: Object.fromEntries(activeBullIds.map(id => [`${symbol}|${id}`, { correct: 25, total: 25 }])),
  168: {}
};
const historicalShort = mod.confluence(bottomWithConfirm, 'crypto', undefined, { reliabilityByHorizon: strongAt24h });
check('this asset\'s own 24h accuracy is strong and 168h has no data: picks the historical 1-day window', historicalShort.longHorizon.basis === 'historical' && historicalShort.longHorizon.label === mod.horizonLabel(1), JSON.stringify(historicalShort.longHorizon));

const strongAt168h = {
  24: {},
  168: Object.fromEntries(activeBullIds.map(id => [`${symbol}|${id}`, { correct: 25, total: 25 }]))
};
const historicalLong = mod.confluence(bottomWithConfirm, 'crypto', undefined, { reliabilityByHorizon: strongAt168h });
check('this asset\'s own 7d accuracy is strong and 24h has no data: picks the historical ~1-week window', historicalLong.longHorizon.basis === 'historical' && historicalLong.longHorizon.label === mod.horizonLabel(7), JSON.stringify(historicalLong.longHorizon));

const belowSampleThreshold = {
  24: Object.fromEntries(activeBullIds.map(id => [`${symbol}|${id}`, { correct: 4, total: 5 }])),
  168: {}
};
const historicalTooFewSamples = mod.confluence(bottomWithConfirm, 'crypto', undefined, { reliabilityByHorizon: belowSampleThreshold });
check('below MIN_RELIABILITY_SAMPLES at both horizons: still falls back to methodology, not overfit', historicalTooFewSamples.longHorizon.basis === 'methodology', JSON.stringify(historicalTooFewSamples.longHorizon));

// Regression test for a real bug found live: several techniques voting on
// the same asset in the same hour are correlated (marked right/wrong
// together, off the same underlying price move) — summing their
// individually-thin counts must NOT be allowed to masquerade as one
// confident sample. Reproduces the exact shape seen in production (3
// active techniques at 13 matured outcomes each, well under the 20
// threshold individually, summing past it).
check('at least 2 active techniques exist to make this regression test meaningful', activeBullIds.length >= 2, `activeBullIds=${JSON.stringify(activeBullIds)}`);
const correlatedThinSamples = {
  24: Object.fromEntries(activeBullIds.map(id => [`${symbol}|${id}`, { correct: 5, total: 13 }])), // 13 < 20 each, but sums past 20 with 2+ techniques
  168: {}
};
const notFooledByCorrelatedSamples = mod.confluence(bottomWithConfirm, 'crypto', undefined, { reliabilityByHorizon: correlatedThinSamples });
check('several techniques each below threshold: does not sum to false confidence, stays methodology', notFooledByCorrelatedSamples.longHorizon.basis === 'methodology', JSON.stringify(notFooledByCorrelatedSamples.longHorizon));

check('horizonEstimate returns null when nothing voted that direction', mod.horizonEstimate([{ id: 'rsi', w: 1, dir: 1 }], -1, 'X', undefined) === null);

console.log('\n== realizedVolPct: real volatility from real price history ==');
check('too short a series: returns null rather than a noisy number', mod.realizedVolPct([100, 101, 99]) === null);
const flatline = Array.from({ length: 40 }, () => 100);
check('a flat (zero-volatility) series returns ~0, not null or NaN', mod.realizedVolPct(flatline) === 0);
const stepSeries = Array.from({ length: 40 }, (_, i) => i % 2 === 0 ? 100 : 102); // alternates +2%/-1.96%, a known, checkable volatility
const stepVol = mod.realizedVolPct(stepSeries);
check('an alternating series returns a real, sane volatility (not null, roughly a couple percent)', stepVol != null && stepVol > 1 && stepVol < 3, `vol=${stepVol}`);

console.log('\n== bestVolLookback: which trailing window best calibrates this asset\'s own volatility ==');
// Seeded PRNG (mulberry32) + Box-Muller, so these fixtures are reproducible
// without relying on Math.random — same discipline as every other
// synthetic-but-checkable fixture in this file, just needing a real
// distribution (not a deterministic alternating series) since calibration
// is a distributional question a deterministic step series can't test.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gaussian(rand) {
  const u1 = Math.max(rand(), 1e-9), u2 = rand();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
function buildVolSeries(oldDays, newDays, oldVolPct, newVolPct, seed) {
  const rand = mulberry32(seed);
  const closes = [100];
  for (let i = 0; i < oldDays; i++) closes.push(closes[closes.length - 1] * (1 + gaussian(rand) * oldVolPct / 100));
  for (let i = 0; i < newDays; i++) closes.push(closes[closes.length - 1] * (1 + gaussian(rand) * newVolPct / 100));
  return closes;
}

check('too short a history: null, the fixed default lookback stays in effect', mod.bestVolLookback(Array.from({ length: 101 }, () => 100)) === null);
check('right at the sample-count boundary (138 days): still null', mod.bestVolLookback(buildVolSeries(0, 137, 1.0, 1.0, 1)) === null);
check('one day past the boundary (139 days): a real result, not null', mod.bestVolLookback(buildVolSeries(0, 138, 1.0, 1.0, 1)) !== null);
check('null closes: null, not a crash', mod.bestVolLookback(null) === null);

// A real, reproducible regime-shift fixture: 30 quiet days (0.2% daily
// vol) then 150 days at a much higher 5% — verified empirically before
// being written here (see the session notes on why mean-squared-
// standardized-residual replaced plain coverage: coverage-vs-68% was
// dominated by sampling noise at this sample size; MSSR-vs-1.0 wasn't).
const shifted = buildVolSeries(30, 150, 0.2, 5.0, 1);
const shiftedResult = mod.bestVolLookback(shifted);
check('a real regime-shift series picks one of the actual candidate lookbacks', shiftedResult && [10, 20, 30, 60, 90].includes(shiftedResult.lookback), JSON.stringify(shiftedResult));
check('the winning lookback calibrates close to the ideal (meanSqResidual near 1.0)', shiftedResult && Math.abs(shiftedResult.meanSqResidual - 1) < 0.3, JSON.stringify(shiftedResult));
check('enough samples backed the winning pick', shiftedResult && shiftedResult.samples >= 40, JSON.stringify(shiftedResult));
check('reproducible: identical input gives identical output', JSON.stringify(mod.bestVolLookback(buildVolSeries(30, 150, 0.2, 5.0, 1))) === JSON.stringify(shiftedResult));
check('this specific, checked-in-advance fixture picks the shortest candidate (fastest to adapt after the shift)', shiftedResult.lookback === 10, JSON.stringify(shiftedResult));

console.log('\n== topIndicator: which specific indicator this asset leans on ==');
check('no reliability data: null, not a guess', mod.topIndicator(undefined, 'BTC') === null);
const multiTechReliability = {
  'BTC|rsi': { accuracy: 0.55, total: 30 },
  'BTC|divergence': { accuracy: 0.71, total: 25 },
  'BTC|macd': { accuracy: 0.9, total: 5 } // high accuracy but below MIN_RELIABILITY_SAMPLES — must not win
};
const best = mod.topIndicator(multiTechReliability, 'BTC');
check('picks the highest-accuracy technique among those with enough of their own samples', best && best.id === 'divergence', JSON.stringify(best));
check('a technique above the threshold-accuracy but below sample threshold is correctly excluded', best.id !== 'macd');

console.log('\n== predictedRange: a band from real volatility, never a point figure ==');
check('missing price/horizon/direction: returns null', mod.predictedRange(null, 3, 60, 1, undefined, 'X', 2) === null && mod.predictedRange(100, null, 60, 1, undefined, 'X', 2) === null && mod.predictedRange(100, 3, 60, 0, undefined, 'X', 2) === null);
check('no volatility data available at all (no learned stats, no fallback): returns null rather than fabricating a range', mod.predictedRange(100, 3, 60, 1, undefined, 'X', null) === null);

const weakScoreRange = mod.predictedRange(100, 3, 50, 1, undefined, 'BTC', 2);
check('score at/below 50 (no real conviction): band is symmetric around price, no directional assumption', weakScoreRange && Math.abs((100 - weakScoreRange.low) - (weakScoreRange.high - 100)) < 1e-9, JSON.stringify(weakScoreRange));

const strongScoreRangeUp = mod.predictedRange(100, 3, 95, 1, undefined, 'BTC', 2);
check('strong bullish score: band center shifts up, but low stays below price and high stays above (still a band, not a point)', strongScoreRangeUp.low < 100 && strongScoreRangeUp.high > 100 && (strongScoreRangeUp.high - 100) > (100 - strongScoreRangeUp.low), JSON.stringify(strongScoreRangeUp));

const strongScoreRangeDown = mod.predictedRange(100, 3, 95, -1, undefined, 'BTC', 2);
check('mirror case, strong bearish score: band center shifts down', strongScoreRangeDown.low < 100 && strongScoreRangeDown.high > 100 && (100 - strongScoreRangeDown.low) > (strongScoreRangeDown.high - 100), JSON.stringify(strongScoreRangeDown));

const methodologyRange = mod.predictedRange(100, 3, 60, 1, undefined, 'BTC', 2);
check('no learned move stats: falls back to methodology (volatility-derived) basis', methodologyRange.basis === 'methodology');

const learnedMoveStats = { 'BTC|24': { meanPct: 1, stdevPct: 5, n: 30 } };
const historicalRange = mod.predictedRange(100, 3, 60, 1, learnedMoveStats, 'BTC', 2);
check('enough of this asset\'s own realized-move history: uses the learned (historical) stdev instead of the generic fallback', historicalRange.basis === 'historical' && Math.abs((historicalRange.high - historicalRange.low) - 2 * 5) < 1e-6, JSON.stringify(historicalRange));

const thinMoveStats = { 'BTC|24': { meanPct: 1, stdevPct: 5, n: 4 } }; // below MIN_RELIABILITY_SAMPLES
const stillMethodology = mod.predictedRange(100, 3, 60, 1, thinMoveStats, 'BTC', 2);
check('learned move stats below sample threshold: still falls back to methodology, not overfit', stillMethodology.basis === 'methodology', JSON.stringify(stillMethodology));

console.log('\n== range + topIndicator flow through buildPayload end-to-end ==');
check('every ranked row carries a range field (object or null, never a crash)', built.crypto.breakout.concat(built.crypto.breakdown, built.stocks.breakout, built.stocks.breakdown).every(r => 'range' in r));
check('every ranked row carries a topIndicator field (object or null)', built.crypto.breakout.concat(built.crypto.breakdown, built.stocks.breakout, built.stocks.breakdown).every(r => 'topIndicator' in r));

console.log('\n== dwellAtExtreme: how long, not just whether, an asset sits at an extreme ==');
check('too short a series: returns null', mod.dwellAtExtreme([1, 2, 3]) === null);
const declineToLow = Array.from({ length: 30 }, (_, i) => 100 - i); // 100 down to 71
const dwellAtLow = [...declineToLow, ...Array.from({ length: 8 }, () => 71.5)];
const lowResult = mod.dwellAtExtreme(dwellAtLow, 252, 5);
check('sitting near the low for a stretch: dir=-1 with a real day count (includes the decline\'s own tail inside the band, not just the flat part)', lowResult.dir === -1 && lowResult.days > 8, JSON.stringify(lowResult));
const midRange = [...declineToLow, ...Array.from({ length: 8 }, (_, i) => 85 + i * 0.1)]; // recovers away from the low, stays mid-range
check('back in the middle of the range: dir=0, no dwell claimed', mod.dwellAtExtreme(midRange, 252, 5).dir === 0);
const declineToHigh = declineToLow.slice().reverse(); // 71 up to 100
const dwellAtHigh = [...declineToHigh, ...Array.from({ length: 6 }, () => 99.5)];
check('mirror case, sitting near the high: dir=1', mod.dwellAtExtreme(dwellAtHigh, 252, 5).dir === 1);

console.log('\n== correlationWithBenchmark: real correlation, not a guess ==');
check('insufficient data: returns null', mod.correlationWithBenchmark([1, 2], [1, 2], 30) === null);
const wave = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i / 3) * 5 + i * 0.3);
check('a series correlated with itself: ~1.0', Math.abs(mod.correlationWithBenchmark(wave, wave, 30) - 1) < 1e-6);
const inverseWave = wave.map(v => 200 - v);
check('an inverted series: strongly negative correlation', mod.correlationWithBenchmark(wave, inverseWave, 30) < -0.9);

console.log('\n== barsRowsToReturnsBySymbol: skips implausible single-day returns as data artifacts ==');
const brRowsClean = [
  { symbol: 'AAA', date: '2026-01-01', close: 100 },
  { symbol: 'AAA', date: '2026-01-02', close: 105 },
  { symbol: 'AAA', date: '2026-01-03', close: 103 }
];
const brReturnsClean = barsRowsToReturnsBySymbol(brRowsClean);
check('a normal day-to-day move is kept', Object.keys(brReturnsClean.AAA).length === 2, JSON.stringify(brReturnsClean));

// Mirrors the real UNI-USD pattern found live in production: a stuck
// near-zero price for a stretch, then a jump to a real-ish price — the
// implied "return" (+1,573,986% in the real case) is a Yahoo data
// artifact, not a real move, and should be dropped rather than distort
// anything compounded from it (sector composites) or correlated against
// it (computeLeadLag).
const brRowsGlitch = [
  { symbol: 'UNI', date: '2022-10-19', close: 0.000038 },
  { symbol: 'UNI', date: '2022-10-20', close: 0.000038 },
  { symbol: 'UNI', date: '2022-10-21', close: 0.598 },   // implied +1,573,886% — a glitch, not a move
  { symbol: 'UNI', date: '2022-10-22', close: 0.396 }    // a normal, plausible day from here on
];
const brReturnsGlitch = barsRowsToReturnsBySymbol(brRowsGlitch);
check('the implausible glitch day is dropped entirely (missing, not a fabricated capped value)', !('2022-10-21' in brReturnsGlitch.UNI), JSON.stringify(brReturnsGlitch));
check('the normal days on either side of the glitch are unaffected', ('2022-10-20' in brReturnsGlitch.UNI) && ('2022-10-22' in brReturnsGlitch.UNI), JSON.stringify(brReturnsGlitch));

const brRowsExactlyAtBar = [
  { symbol: 'BBB', date: '2026-01-01', close: 100 },
  { symbol: 'BBB', date: '2026-01-02', close: 2100 } // exactly +2000%, at the bar, not over it
];
check('a return exactly at the threshold is kept (strictly-greater-than, not off-by-one)', '2026-01-02' in barsRowsToReturnsBySymbol(brRowsExactlyAtBar).BBB);

const brRowsJustOverBar = [
  { symbol: 'CCC', date: '2026-01-01', close: 100 },
  { symbol: 'CCC', date: '2026-01-02', close: 2100.01 } // just over +2000%
];
check('a return just over the threshold is dropped', !('2026-01-02' in barsRowsToReturnsBySymbol(brRowsJustOverBar).CCC));

// Percentage returns are inherently asymmetric: floored at -100% (a price
// can't go negative) but unbounded above — so this filter is necessarily
// upside-focused. A crash INTO a fake-near-zero regime shows up as a
// bounded ~-100% return (undesirable noise in a composite mean, but not
// the unbounded compounding blow-up the upside case causes), while the
// jump back OUT of one is what actually needs catching, and is.
const brRowsNearTotalCrash = [
  { symbol: 'DDD', date: '2026-01-01', close: 100 },
  { symbol: 'DDD', date: '2026-01-02', close: 0.01 } // -99.99%, a real (if extreme) crash, still well short of the -100% floor
];
check('a near-total crash is still nowhere near the implausibility bar (returns are floored at -100%, never past it)', '2026-01-02' in barsRowsToReturnsBySymbol(brRowsNearTotalCrash).DDD);

console.log('\n== laggedCorrelation + nDayReturnFromBars: the cross-asset lead/lag primitives ==');
check('pearsonCorr: too few overlapping points returns null', mod.pearsonCorr([1, 2, 3], [1, 2, 3]) === null);
// Build a synthetic leader whose return at date D perfectly predicts a
// follower's return two days later (date D+2) — a real, unambiguous lag-2
// relationship, not noise, to confirm laggedCorrelation actually finds the
// right lag rather than just running without erroring.
const llDates = Array.from({ length: 200 }, (_, i) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10));
const leaderReturnsFixture = {}, followerReturnsFixture = {};
for (let i = 0; i < llDates.length; i++) {
  const r = Math.sin(i / 5) * 3 + (i % 7 === 0 ? 2 : -0.5); // some real, non-degenerate pattern
  leaderReturnsFixture[llDates[i]] = r;
  if (i + 2 < llDates.length) followerReturnsFixture[llDates[i + 2]] = r; // follower echoes the leader, 2 days later
}
const lagResultRight = mod.laggedCorrelation(leaderReturnsFixture, followerReturnsFixture, 2);
const lagResultWrong = mod.laggedCorrelation(leaderReturnsFixture, followerReturnsFixture, 5);
check('finds a near-perfect correlation at the true lag (2 days)', lagResultRight && lagResultRight.corr > 0.99, JSON.stringify(lagResultRight));
check('a wrong lag on the same data does not show the same strength', lagResultWrong && Math.abs(lagResultWrong.corr) < Math.abs(lagResultRight.corr));
check('no date overlap at all: returns null', mod.laggedCorrelation({ '2026-01-01': 1 }, { '2099-01-01': 1 }, 1) === null);

const recentBars = [
  { date: '2026-01-01', close: 100 }, { date: '2026-01-02', close: 102 },
  { date: '2026-01-03', close: 101 }, { date: '2026-01-04', close: 105 }
];
check('nDayReturnFromBars: 3-day return computed correctly', Math.abs(mod.nDayReturnFromBars(recentBars, 3) - 5) < 1e-9, mod.nDayReturnFromBars(recentBars, 3));
check('nDayReturnFromBars: not enough bars for the requested lag returns null', mod.nDayReturnFromBars(recentBars, 10) === null);

console.log('\n== leadlag technique: only votes when a proven leader actually moved ==');
const llSignalsFixture = { TESTASSET: [{ leaderSymbol: 'BTC', lagDays: 3, corr: 0.7, samples: 200 }, { leaderSymbol: 'ETH', lagDays: 2, corr: -0.9, samples: 200 }] };
const llReturnsBtcUp = { BTC: [{ date: '2026-01-01', close: 100 }, { date: '2026-01-02', close: 100 }, { date: '2026-01-03', close: 100 }, { date: '2026-01-04', close: 110 }] }; // BTC +10% over 3d
const llTechFires = findTech(mod.evaluateTechniques(baseMetric({}), 'crypto', undefined, { leadLagSignals: llSignalsFixture, leaderReturns: llReturnsBtcUp }), 'leadlag');
check('registered leader moved meaningfully: fires in the implied direction (positive corr, leader up -> bullish)', llTechFires.dir === 1, JSON.stringify(llTechFires));

const llReturnsFlat = { BTC: [{ date: '2026-01-01', close: 100 }, { date: '2026-01-02', close: 100 }, { date: '2026-01-03', close: 100 }, { date: '2026-01-04', close: 100.2 }] }; // flat
const llTechFlat = findTech(mod.evaluateTechniques(baseMetric({}), 'crypto', undefined, { leadLagSignals: llSignalsFixture, leaderReturns: llReturnsFlat }), 'leadlag');
check('registered leader but it did not move meaningfully: neutral, not fabricated', llTechFlat.dir === 0, JSON.stringify(llTechFlat));

const llTechNoSignals = findTech(mod.evaluateTechniques(baseMetric({}), 'crypto', undefined, {}), 'leadlag');
check('no lead/lag signals loaded at all: abstains (null)', llTechNoSignals.dir === null);

const llSignalsStronger = { TESTASSET: [{ leaderSymbol: 'BTC', lagDays: 3, corr: 0.3, samples: 200 }, { leaderSymbol: 'ETH', lagDays: 3, corr: -0.9, samples: 200 }] };
const fourBarsUp = [{ date: '2026-01-01', close: 100 }, { date: '2026-01-02', close: 100 }, { date: '2026-01-03', close: 100 }, { date: '2026-01-04', close: 110 }]; // +10% over the 3-day lag
const llReturnsBoth = {
  BTC: fourBarsUp, // +10%, weak corr leader (0.3)
  ETH: fourBarsUp  // +10%, strong corr leader (-0.9)
};
const llTechPicksStrongest = findTech(mod.evaluateTechniques(baseMetric({}), 'crypto', undefined, { leadLagSignals: llSignalsStronger, leaderReturns: llReturnsBoth }), 'leadlag');
check('with two qualifying leaders, follows the stronger-correlation one (ETH, negative corr -> bearish) not just the first', llTechPicksStrongest.dir === -1, JSON.stringify(llTechPicksStrongest));

const llSignalsSector = { TESTASSET: [{ leaderSymbol: 'SECTOR:DeFi', lagDays: 2, corr: 0.8, samples: 200 }] };
const llReturnsSector = { 'SECTOR:DeFi': fourBarsUp };
const llTechSectorLeader = findTech(mod.evaluateTechniques(baseMetric({}), 'crypto', undefined, { leadLagSignals: llSignalsSector, leaderReturns: llReturnsSector }), 'leadlag');
check('a SECTOR:<name> pseudo-symbol works as a registered leader with zero special-casing', llTechSectorLeader.dir === 1, JSON.stringify(llTechSectorLeader));
check('the displayed note prettifies the SECTOR: prefix rather than showing the raw pseudo-symbol', llTechSectorLeader.note.startsWith('the DeFi sector moved'), llTechSectorLeader.note);

console.log('\n== mapCategoriesToSectors: curated CoinGecko-category -> broad sector bucket ==');
check('no categories at all: empty array, not an error', JSON.stringify(mod.mapCategoriesToSectors(null)) === '[]');
check('empty categories array: empty array', JSON.stringify(mod.mapCategoriesToSectors([])) === '[]');
check('a pure L1 (Ethereum-like): maps to L1 only', JSON.stringify(mod.mapCategoriesToSectors(['Smart Contract Platform', 'Layer 1 (L1)', 'Ethereum Ecosystem'])) === '["L1"]');
check('an L2 (Arbitrum-like) with Governance too: maps to both, in bucket-declaration order', JSON.stringify(mod.mapCategoriesToSectors(['Smart Contract Platform', 'Layer 2 (L2)', 'Governance'])) === '["L1","L2","Governance"]');
check('a DeFi+Governance token (Uniswap-like): real multi-membership, not a bug', JSON.stringify(mod.mapCategoriesToSectors(['Decentralized Exchange (DEX)', 'Decentralized Finance (DeFi)', 'Governance'])) === '["DeFi","Governance"]');
check('irrelevant ecosystem/portfolio noise with no whitelisted tag: empty array', JSON.stringify(mod.mapCategoriesToSectors(['FTX Holdings', 'Made in USA', 'Coinbase 50 Index'])) === '[]');
check('a meme coin (Dogecoin-like): Meme, plus L1 since it also carries Smart Contract Platform', JSON.stringify(mod.mapCategoriesToSectors(['Smart Contract Platform', 'Meme', 'Dog-Themed'])) === '["L1","Meme"]');

console.log('\n== computeSectorCompositeSeries: simple-mean daily return, compounded into a start-at-100 index ==');
const sectorReturnsBySymbol = {
  AAA: { '2026-01-01': 10, '2026-01-02': -5 },  // +10%, then -5%
  BBB: { '2026-01-01': 2, '2026-01-02': 1 },    // +2%, then +1%
  CCC: { '2026-01-01': 0, '2026-01-02': 4 }     // 0%, then +4%
};
const compositeThree = mod.computeSectorCompositeSeries(sectorReturnsBySymbol, { TestSector: ['AAA', 'BBB', 'CCC'] });
const day1MeanRet = (10 + 2 + 0) / 3; // 4
const day2MeanRet = (-5 + 1 + 4) / 3; // 0
check('day 1 close compounds the simple mean of all three members\' returns off a base of 100', Math.abs(compositeThree.TestSector[0].close - 100 * (1 + day1MeanRet / 100)) < 1e-9, JSON.stringify(compositeThree.TestSector));
check('day 2 close compounds onto day 1\'s close, not back to 100', Math.abs(compositeThree.TestSector[1].close - 100 * (1 + day1MeanRet / 100) * (1 + day2MeanRet / 100)) < 1e-9, JSON.stringify(compositeThree.TestSector));

const compositeTwoMembers = mod.computeSectorCompositeSeries(sectorReturnsBySymbol, { TooSmall: ['AAA', 'BBB'] });
check('below the minimum-constituent bar (default 3): sector omitted entirely, not computed from 2', compositeTwoMembers.TooSmall === undefined, JSON.stringify(compositeTwoMembers));

const compositeCustomMin = mod.computeSectorCompositeSeries(sectorReturnsBySymbol, { TooSmall: ['AAA', 'BBB'] }, 2);
check('a lower explicit minConstituents allows a 2-member composite', Array.isArray(compositeCustomMin.TooSmall) && compositeCustomMin.TooSmall.length === 2, JSON.stringify(compositeCustomMin));

const sectorReturnsPartial = {
  AAA: { '2026-01-01': 10, '2026-01-02': -5 },
  BBB: { '2026-01-01': 2 },                      // no 2026-01-02 data for BBB
  CCC: { '2026-01-01': 0, '2026-01-02': 4 }
};
const compositePartial = mod.computeSectorCompositeSeries(sectorReturnsPartial, { PartialSector: ['AAA', 'BBB', 'CCC'] });
const day2MeanPartial = (-5 + 4) / 2; // only AAA + CCC have a 2026-01-02 return
check('a date where only some members have data still gets a composite point, averaged over whoever reported', Math.abs(compositePartial.PartialSector[1].close - 100 * (1 + day1MeanRet / 100) * (1 + day2MeanPartial / 100)) < 1e-9, JSON.stringify(compositePartial.PartialSector));

check('a symbol with no return data at all (never in returnsBySymbol) is simply not counted toward the constituent minimum', mod.computeSectorCompositeSeries(sectorReturnsBySymbol, { GhostSector: ['AAA', 'BBB', 'ZZZ'] }).GhostSector === undefined, 'ZZZ has no entry in returnsBySymbol, so only 2 real members qualify');

console.log('\n== computeSectorCompositeSeries with a seed: daily recompute appends, it does not redo full history ==');
const seedAtDay1 = { TestSector: { date: '2026-01-01', close: 104 } }; // matches day 1's real close from the unseeded run above
const compositeSeeded = mod.computeSectorCompositeSeries(sectorReturnsBySymbol, { TestSector: ['AAA', 'BBB', 'CCC'] }, 3, seedAtDay1);
check('with a seed at day 1, only day 2 (strictly after the seed date) is returned, not day 1 again', compositeSeeded.TestSector.length === 1 && compositeSeeded.TestSector[0].date === '2026-01-02', JSON.stringify(compositeSeeded.TestSector));
check('the appended day continues compounding from the seed close, not from 100', Math.abs(compositeSeeded.TestSector[0].close - 104 * (1 + day2MeanRet / 100)) < 1e-9, JSON.stringify(compositeSeeded.TestSector));

const seedAtLatestDate = { TestSector: { date: '2026-01-02', close: 104 } };
const compositeFullyCaughtUp = mod.computeSectorCompositeSeries(sectorReturnsBySymbol, { TestSector: ['AAA', 'BBB', 'CCC'] }, 3, seedAtLatestDate);
check('a sector already caught up through the latest available date: empty series, not an error', JSON.stringify(compositeFullyCaughtUp.TestSector) === '[]', JSON.stringify(compositeFullyCaughtUp));

console.log('\n== computeSpreadSeries: direct level subtraction (e.g. UST10Y - UST2Y), no compounding ==');
const spreadClosesA = { '2026-01-01': 4.66, '2026-01-02': 4.70, '2026-01-03': 4.68 };
const spreadClosesB = { '2026-01-01': 4.17, '2026-01-02': 4.20 }; // no 2026-01-03 yet
const enoughOverlapA = Object.fromEntries(Array.from({ length: 35 }, (_, i) => [`2026-02-${String(i + 1).padStart(2, '0')}`, 5]));
const enoughOverlapB = Object.fromEntries(Array.from({ length: 35 }, (_, i) => [`2026-02-${String(i + 1).padStart(2, '0')}`, 4]));
check('below the default minPoints (30): empty, not a noisy 2-3-point "spread"', JSON.stringify(mod.computeSpreadSeries(spreadClosesA, spreadClosesB)) === '[]', JSON.stringify(mod.computeSpreadSeries(spreadClosesA, spreadClosesB)));
const spreadEnough = mod.computeSpreadSeries(enoughOverlapA, enoughOverlapB, 30);
check('once minPoints is cleared, computes a real point per overlapping date', spreadEnough.length === 35 && spreadEnough.every((p) => Math.abs(p.close - 1) < 1e-9), JSON.stringify(spreadEnough.slice(0, 3)));
check('a lower explicit minPoints allows a thin overlap through', mod.computeSpreadSeries(spreadClosesA, spreadClosesB, 2).length === 2);
check('dates present in only one series are excluded, not treated as a zero', mod.computeSpreadSeries(spreadClosesA, spreadClosesB, 2).every((p) => p.date !== '2026-01-03'));
check('the spread is A - B (UST10Y - UST2Y convention: positive = normal curve, negative = inverted)', mod.computeSpreadSeries(spreadClosesA, spreadClosesB, 2)[0].close === spreadClosesA['2026-01-01'] - spreadClosesB['2026-01-01']);
check('sorted by date ascending', JSON.stringify(mod.computeSpreadSeries(spreadClosesA, spreadClosesB, 2).map((p) => p.date)) === JSON.stringify(['2026-01-01', '2026-01-02']));

console.log('\n== matchProtocolsToUniverse: conservative gecko_id-only matching (never fuzzy) ==');
const tvlUniverse = [
  { id: 'aave', symbol: 'AAVE', name: 'Aave' },
  { id: 'uniswap', symbol: 'UNI', name: 'Uniswap' }
];
const tvlProtocols = [
  { slug: 'aave-v3', geckoId: 'aave', name: 'Aave V3' },
  { slug: 'some-other-protocol', geckoId: 'not-in-our-universe', name: 'Some Other Protocol' },
  { slug: 'no-gecko-id-protocol', geckoId: null, name: 'CEX With No Token' }
];
const tvlMatched = matchProtocolsToUniverse(tvlProtocols, tvlUniverse);
check('a real gecko_id match resolves to OUR symbol, not DeFiLlama\'s own name/slug', tvlMatched.length === 1 && tvlMatched[0].symbol === 'AAVE' && tvlMatched[0].slug === 'aave-v3', JSON.stringify(tvlMatched));
check('a gecko_id not in our tracked universe is dropped entirely, not left with a null symbol', tvlMatched.every((p) => p.geckoId !== 'not-in-our-universe'));
check('a protocol with no gecko_id at all (common for CEXs) is dropped, never fuzzy-matched by name', tvlMatched.every((p) => p.geckoId !== null));
check('an empty protocol list: empty result, not an error', matchProtocolsToUniverse([], tvlUniverse).length === 0);

console.log('\n== tvltrend technique: TVL momentum paired with price direction, never fires alone ==');
const tvlBarsUp = [{ date: '2026-01-01', close: 100 }, { date: '2026-01-02', close: 100 }, { date: '2026-01-03', close: 100 }, { date: '2026-01-04', close: 100 }, { date: '2026-01-05', close: 100 }, { date: '2026-01-06', close: 100 }, { date: '2026-01-07', close: 100 }, { date: '2026-01-08', close: 120 }]; // +20% over 7d
const tvlBarsDown = [{ date: '2026-01-01', close: 100 }, { date: '2026-01-02', close: 100 }, { date: '2026-01-03', close: 100 }, { date: '2026-01-04', close: 100 }, { date: '2026-01-05', close: 100 }, { date: '2026-01-06', close: 100 }, { date: '2026-01-07', close: 100 }, { date: '2026-01-08', close: 80 }]; // -20% over 7d
const tvlBarsFlat = [{ date: '2026-01-01', close: 100 }, { date: '2026-01-02', close: 100 }, { date: '2026-01-03', close: 100 }, { date: '2026-01-04', close: 100 }, { date: '2026-01-05', close: 100 }, { date: '2026-01-06', close: 100 }, { date: '2026-01-07', close: 100 }, { date: '2026-01-08', close: 105 }]; // +5%, below the 15% bar

const tvlTechConfirmed = findTech(mod.evaluateTechniques(baseMetric({ symbol: 'AAVE', chg7d: 10 }), 'crypto', undefined, { tvlSeries: { AAVE: tvlBarsUp } }), 'tvltrend');
check('TVL up 20% over 7d + price already up: fires bullish', tvlTechConfirmed.dir === 1, JSON.stringify(tvlTechConfirmed));

const tvlTechNoConfirm = findTech(mod.evaluateTechniques(baseMetric({ symbol: 'AAVE', chg7d: -5 }), 'crypto', undefined, { tvlSeries: { AAVE: tvlBarsUp } }), 'tvltrend');
check('TVL up 20% but price is actually down: does not fire (TVL alone does not prove causation)', tvlTechNoConfirm.dir === 0, JSON.stringify(tvlTechNoConfirm));

const tvlTechBearish = findTech(mod.evaluateTechniques(baseMetric({ symbol: 'AAVE', chg7d: -10 }), 'crypto', undefined, { tvlSeries: { AAVE: tvlBarsDown } }), 'tvltrend');
check('TVL down 20% + price already down: fires bearish', tvlTechBearish.dir === -1, JSON.stringify(tvlTechBearish));

const tvlTechBelowBar = findTech(mod.evaluateTechniques(baseMetric({ symbol: 'AAVE', chg7d: 10 }), 'crypto', undefined, { tvlSeries: { AAVE: tvlBarsFlat } }), 'tvltrend');
check('TVL move below the 15% bar: neutral, not fabricated into a direction', tvlTechBelowBar.dir === 0, JSON.stringify(tvlTechBelowBar));

const tvlTechNoMatch = findTech(mod.evaluateTechniques(baseMetric({ symbol: 'SOMEOTHERCOIN' }), 'crypto', undefined, { tvlSeries: { AAVE: tvlBarsUp } }), 'tvltrend');
check('this asset has no matched TVL series at all: abstains (null)', tvlTechNoMatch.dir === null, JSON.stringify(tvlTechNoMatch));

const tvlTechNoData = findTech(mod.evaluateTechniques(baseMetric({ symbol: 'AAVE' }), 'crypto'), 'tvltrend');
check('no tvlSeries loaded at all: abstains (null)', tvlTechNoData.dir === null, JSON.stringify(tvlTechNoData));

const tvlTechStockGated = findTech(mod.evaluateTechniques(baseMetric({ symbol: 'AAVE', chg7d: 10 }), 'stock', undefined, { tvlSeries: { AAVE: tvlBarsUp } }), 'tvltrend');
check('crypto-only: stocks never fire this technique even with matching TVL data', tvlTechStockGated.dir === null, JSON.stringify(tvlTechStockGated));

console.log('\n== isYahooCryptoDataTrustworthy: catches wrong-ticker collisions (the HYPE/SUI/UNI bug) ==');
const NOW = new Date('2026-08-21T00:00:00Z').getTime();
const freshRealisticBars = [{ date: '2026-08-19', close: 73 }, { date: '2026-08-20', close: 74.5 }];
check('fresh data, close to the reference price: trusted', isYahooCryptoDataTrustworthy(freshRealisticBars, 74.14, NOW) === true);

const wrongTickerBars = [{ date: '2024-08-27', close: 0.000005 }]; // the actual HYPE-USD garbage found live
check('wildly wrong magnitude AND stale (the real HYPE bug): rejected', isYahooCryptoDataTrustworthy(wrongTickerBars, 74.14, NOW) === false);

const freshButWrongMagnitude = [{ date: '2026-08-21', close: 0.0006290287710726261 }]; // the real ARB bug found live -- fresh date, still wrong
check('fresh date but off by two orders of magnitude (the real ARB/JUP/M/WLFI bug): rejected even though not stale', isYahooCryptoDataTrustworthy(freshButWrongMagnitude, 0.096339, NOW) === false);

const staleButRightMagnitude = [{ date: '2022-12-11', close: 0.000006 }]; // the real PEPE case -- right ballpark, just old
check('right order of magnitude but stale (the real PEPE case): rejected on staleness alone, so a fresh re-fetch gets forced', isYahooCryptoDataTrustworthy(staleButRightMagnitude, 0.00000361, NOW) === false);

check('no reference price available (stocks/benchmarks never set one): trusted, this guard only applies where refPrice exists', isYahooCryptoDataTrustworthy(freshRealisticBars, null, NOW) === true);
check('empty bars: rejected outright, nothing to trust', isYahooCryptoDataTrustworthy([], 74.14, NOW) === false);
check('a zero/negative close on the latest bar: rejected', isYahooCryptoDataTrustworthy([{ date: '2026-08-20', close: 0 }], 74.14, NOW) === false);

console.log('\n== findPivots / walkSrLevels: swing-pivot detection, clustering, and no-lookahead break simulation ==');
// A clean double-touch of support at ~100 (idx 5 and idx 15, both real
// local lows — confirmed via bars on both sides, not just a rolling
// window), then a genuine break below it at idx 25 with real future bars
// to measure the realized 24h/168h move against.
const srBars = [
  { close: 130 }, { close: 125 }, { close: 120 }, { close: 115 }, { close: 110 }, { close: 100 },
  { close: 108 }, { close: 112 }, { close: 116 }, { close: 120 }, { close: 124 }, { close: 118 },
  { close: 114 }, { close: 110 }, { close: 105 }, { close: 100.5 }, { close: 106 }, { close: 110 },
  { close: 114 }, { close: 118 }, { close: 122 }, { close: 118 }, { close: 114 }, { close: 110 },
  { close: 105 }, { close: 90 }, { close: 88 }, { close: 87 }, { close: 86 }, { close: 85 },
  { close: 84 }, { close: 83 }, { close: 82 }, { close: 81 }, { close: 80 }, { close: 79 },
  { close: 78 }, { close: 77 }, { close: 76 }, { close: 75 }
].map((b, i) => ({ ...b, date: `2026-01-${String(i + 1).padStart(2, '0')}`, high: b.close, low: b.close }));

const srPivots = findPivots(srBars);
const supportPivots = srPivots.filter((p) => p.type === 'support' && Math.abs(p.price - 100) < 1);
check('finds both support touches at ~100 as real pivots (confirmed by bars on both sides)', supportPivots.length === 2, JSON.stringify(supportPivots));

const srBarsNoBreak = srBars.slice(0, 25); // stops before the break — the level should still be "open"
const { levels: srLevelsNoBreak } = walkSrLevels('TESTASSET', 'crypto', srBarsNoBreak);
check('the twice-touched ~100 support clusters into exactly one key level, not two', srLevelsNoBreak.filter((l) => l.levelType === 'support').length === 1, JSON.stringify(srLevelsNoBreak));
const srSupportLevel = srLevelsNoBreak.find((l) => l.levelType === 'support');
check('touches counted correctly (2, from the two real pivots, not 1 or 4)', srSupportLevel && srSupportLevel.touches === 2, JSON.stringify(srSupportLevel));
check('a level with only a single pivot (the ~124 high) never reaches "key" (needs 2+ touches)', !srLevelsNoBreak.some((l) => l.levelType === 'resistance'), JSON.stringify(srLevelsNoBreak));

const { levels: srLevelsAfterBreak, breaks: srWalkBreaks } = walkSrLevels('TESTASSET', 'crypto', srBars);
check('the level retires (drops out of the returned key-levels list) once it has actually broken', !srLevelsAfterBreak.some((l) => l.levelType === 'support'), JSON.stringify(srLevelsAfterBreak));
check('the break event itself was recorded at both calibration horizons', srWalkBreaks.some((b) => b.bucketKey === 'TESTASSET' && b.horizonHours === 24) && srWalkBreaks.some((b) => b.bucketKey === 'TESTASSET' && b.horizonHours === 168), JSON.stringify(srWalkBreaks));
const srBreak24 = srWalkBreaks.find((b) => b.bucketKey === 'TESTASSET' && b.horizonHours === 24);
check('24h break magnitude matches the real forward move (90 -> 88)', Math.abs(srBreak24.pct - ((88 / 90 - 1) * 100)) < 0.01, JSON.stringify(srBreak24));
const srBreak168 = srWalkBreaks.find((b) => b.bucketKey === 'TESTASSET' && b.horizonHours === 168);
check('168h break magnitude matches the real 7-bar-later move (90 -> 82)', Math.abs(srBreak168.pct - ((82 / 90 - 1) * 100)) < 0.01, JSON.stringify(srBreak168));
check('every break event is logged under both the per-symbol AND pooled asset_class|level_type bucket', srWalkBreaks.some((b) => b.bucketKey === 'crypto|support'), JSON.stringify(srWalkBreaks));

check('a too-short series finds no pivots at all, not a crash', findPivots([{ date: 'x', close: 100, high: 100, low: 100 }]).length === 0);
const srEmpty = walkSrLevels('X', 'crypto', []);
check('walkSrLevels on an empty array: no levels, no breaks, not a crash', srEmpty.levels.length === 0 && srEmpty.breaks.length === 0);

console.log('\n== srbreak technique: fires on a real close through a key (touched >=2) level, sized by calibration ==');
const srLevelsFixture = { TESTASSET: [
  { level: 100, levelType: 'support', touches: 3 },
  { level: 120, levelType: 'resistance', touches: 2 }
] };

const srBreakDown = findTech(mod.evaluateTechniques(baseMetric({ price: 98 }), 'crypto', undefined, { srLevels: srLevelsFixture }), 'srbreak');
check('close decisively below a key support level: fires bearish', srBreakDown.dir === -1, JSON.stringify(srBreakDown));
check('note names the broken level', srBreakDown.note.includes('support') && srBreakDown.note.includes('100'), srBreakDown.note);

const srBreakUp = findTech(mod.evaluateTechniques(baseMetric({ price: 122 }), 'crypto', undefined, { srLevels: srLevelsFixture }), 'srbreak');
check('close decisively above a key resistance level: fires bullish', srBreakUp.dir === 1, JSON.stringify(srBreakUp));

const srNoBreak = findTech(mod.evaluateTechniques(baseMetric({ price: 110 }), 'crypto', undefined, { srLevels: srLevelsFixture }), 'srbreak');
check('price sitting between tracked levels: neutral, not fabricated into a direction', srNoBreak.dir === 0, JSON.stringify(srNoBreak));

const srWickThrough = findTech(mod.evaluateTechniques(baseMetric({ price: 99.7 }), 'crypto', undefined, { srLevels: srLevelsFixture }), 'srbreak');
check('a close only just past the level, inside the buffer: not counted as a real break', srWickThrough.dir === 0, JSON.stringify(srWickThrough));

const srNoLevels = findTech(mod.evaluateTechniques(baseMetric({ symbol: 'SOMEOTHERCOIN', price: 98 }), 'crypto', undefined, { srLevels: srLevelsFixture }), 'srbreak');
check('this asset has no tracked levels at all: abstains (null)', srNoLevels.dir === null, JSON.stringify(srNoLevels));

const srNoCtx = findTech(mod.evaluateTechniques(baseMetric({ price: 98 }), 'crypto'), 'srbreak');
check('no srLevels loaded at all: abstains (null)', srNoCtx.dir === null, JSON.stringify(srNoCtx));

const srBreakStatsFixture = { 'TESTASSET|24': { meanPct: -3.1, stdevPct: 1.2, n: 18 }, 'crypto|support|24': { meanPct: -1.5, stdevPct: 0.9, n: 40 } };
const srWithSymbolCalib = findTech(mod.evaluateTechniques(baseMetric({ price: 98 }), 'crypto', undefined, { srLevels: srLevelsFixture, srBreakStats: srBreakStatsFixture }), 'srbreak');
check('per-symbol break calibration exists: note carries this asset\'s own historical move and sample count', srWithSymbolCalib.note.includes('-3.1%') && srWithSymbolCalib.note.includes('18 prior breaks'), srWithSymbolCalib.note);

const pooledOnlyStats = { 'crypto|support|24': { meanPct: -1.5, stdevPct: 0.9, n: 40 } };
const srWithPooledCalib = findTech(mod.evaluateTechniques(baseMetric({ price: 98 }), 'crypto', undefined, { srLevels: srLevelsFixture, srBreakStats: pooledOnlyStats }), 'srbreak');
check('no per-symbol calibration yet: falls back to the pooled asset_class|level_type figure', srWithPooledCalib.note.includes('-1.5%') && srWithPooledCalib.note.includes('40 prior breaks'), srWithPooledCalib.note);

const srNoCalibAtAll = findTech(mod.evaluateTechniques(baseMetric({ price: 98 }), 'crypto', undefined, { srLevels: srLevelsFixture }), 'srbreak');
check('no calibration data at all yet: still fires with a plain touches-based note, not blocked on it', srNoCalibAtAll.dir === -1 && srNoCalibAtAll.note.includes('prior touches'), srNoCalibAtAll.note);

console.log('\n== accum technique: fires on a coiled range with an OBV lean, before price itself confirms ==');
const coiledBullish = baseMetric({ chg7d: 1, obv: 0.8, bb: { squeezed: true, expanding: false }, volReg: 0.9 });
const accumBullish = findTech(mod.evaluateTechniques(coiledBullish, 'crypto'), 'accum');
check('Bollinger squeeze + rising OBV + flat price: fires bullish (leading, no price confirmation needed)', accumBullish.dir === 1, JSON.stringify(accumBullish));

const coiledBearish = baseMetric({ chg7d: -1, obv: -0.9, bb: { squeezed: true, expanding: false }, volReg: 0.9 });
const accumBearish = findTech(mod.evaluateTechniques(coiledBearish, 'crypto'), 'accum');
check('Bollinger squeeze + falling OBV + flat price: fires bearish', accumBearish.dir === -1, JSON.stringify(accumBearish));

const notCoiled = baseMetric({ chg7d: 1, obv: 0.8, bb: { squeezed: false, expanding: true }, volReg: 1.2 });
const accumNotCoiled = findTech(mod.evaluateTechniques(notCoiled, 'crypto'), 'accum');
check('bands already expanding (not coiled): neutral, this is the release, not the base', accumNotCoiled.dir === 0, JSON.stringify(accumNotCoiled));

const coiledButTrending = baseMetric({ chg7d: 8, obv: 0.8, bb: { squeezed: true, expanding: false } });
const accumTrending = findTech(mod.evaluateTechniques(coiledButTrending, 'crypto'), 'accum');
check('bands squeezed but price already moved 8% over 7d: neutral, not a real base', accumTrending.dir === 0, JSON.stringify(accumTrending));

const volRegOnlyCoil = baseMetric({ chg7d: 0.5, obv: 0.7, volReg: 0.5 });
const accumViaVolReg = findTech(mod.evaluateTechniques(volRegOnlyCoil, 'crypto'), 'accum');
check('no Bollinger data, but realized vol well under baseline: the volReg path alone is enough to count as coiled', accumViaVolReg.dir === 1, JSON.stringify(accumViaVolReg));

const noObv = baseMetric({ chg7d: 1, bb: { squeezed: true, expanding: false } });
const accumNoObv = findTech(mod.evaluateTechniques(noObv, 'crypto'), 'accum');
check('no OBV data at all: abstains (null), nothing to read a lean from', accumNoObv.dir === null, JSON.stringify(accumNoObv));

console.log('\n== mktoutlier technique: this asset\'s own move vs. the broad crypto market\'s ==');
const marketFlat = { chg24h: 0.5, chg7d: 2, asOf: '2026-08-20' };

const outlierBullGap = findTech(mod.evaluateTechniques(baseMetric({ chg7d: 20 }), 'crypto', undefined, { marketReturn: marketFlat }), 'mktoutlier');
check('asset up 20% while market up only 2% (an 18-point gap): fires bullish', outlierBullGap.dir === 1, JSON.stringify(outlierBullGap));
check('note names both this asset\'s and the market\'s own figures', outlierBullGap.note.includes('20%') && outlierBullGap.note.includes('2%'), outlierBullGap.note);

const outlierBearGap = findTech(mod.evaluateTechniques(baseMetric({ chg7d: -16 }), 'crypto', undefined, { marketReturn: marketFlat }), 'mktoutlier');
check('asset down 16% while market up 2% (an 18-point gap): fires bearish', outlierBearGap.dir === -1, JSON.stringify(outlierBearGap));

const outlierOppositeSign = findTech(mod.evaluateTechniques(baseMetric({ chg7d: 4 }), 'crypto', undefined, { marketReturn: { chg24h: -1, chg7d: -5, asOf: '2026-08-20' } }), 'mktoutlier');
check('asset up 4% while the market is DOWN 5% (opposite signs, gap only 9 -- below the 12-point bar alone): still fires bullish via the opposite-sign path', outlierOppositeSign.dir === 1, JSON.stringify(outlierOppositeSign));

const notAnOutlier = findTech(mod.evaluateTechniques(baseMetric({ chg7d: 3 }), 'crypto', undefined, { marketReturn: marketFlat }), 'mktoutlier');
check('asset up 3%, market up 2%: just riding the same wave, not an outlier -- neutral', notAnOutlier.dir === 0, JSON.stringify(notAnOutlier));

const outlierNoMarketData = findTech(mod.evaluateTechniques(baseMetric({ chg7d: 20 }), 'crypto'), 'mktoutlier');
check('no marketReturn loaded at all: abstains (null)', outlierNoMarketData.dir === null, JSON.stringify(outlierNoMarketData));

const outlierMarketReturnNull = findTech(mod.evaluateTechniques(baseMetric({ chg7d: 20 }), 'crypto', undefined, { marketReturn: null }), 'mktoutlier');
check('marketReturn explicitly null (not enough history yet, see loadMarketReturn): abstains (null)', outlierMarketReturnNull.dir === null, JSON.stringify(outlierMarketReturnNull));

const outlierStockGated = findTech(mod.evaluateTechniques(baseMetric({ chg7d: 20 }), 'stock', undefined, { marketReturn: marketFlat }), 'mktoutlier');
check('crypto-only: stocks never fire this technique even with marketReturn present', outlierStockGated.dir === null, JSON.stringify(outlierStockGated));

console.log('\n== detectMoveEpisodes: real breakout/breakdown episodes, not one per day the trigger stays crossed ==');
const emStart = new Date('2026-01-01T00:00:00Z').getTime();
const emClose = (i) => {
  if (i < 20) return 100;                          // flat pad, pre-episode
  if (i <= 32) return 100 + (i - 19) * (50 / 13);   // rises 100 -> 150 over days 20-32 (trigger + continuation to its real peak)
  return 150 - (i - 32) * 2;                        // declines after the peak
};
const emBars = Array.from({ length: 60 }, (_, i) => ({ date: new Date(emStart + i * 86400000).toISOString().slice(0, 10), close: emClose(i) }));
const episodes = mod.detectMoveEpisodes(emBars, 20, 7, 21, 30);
check('finds exactly one episode, not one per day the 7-day return stays above threshold', episodes.length === 1, JSON.stringify(episodes));
check('correctly identifies it as bullish', episodes[0].dir === 1, JSON.stringify(episodes[0]));
check('the full move to the real peak (50%) is much bigger than the bare 7-day trigger, and the trigger itself cleared the threshold', episodes[0].fullMovePct > episodes[0].triggerPct && episodes[0].fullMovePct > 40 && episodes[0].triggerPct >= 20, JSON.stringify(episodes[0]));
check('daysToExtreme is positive and lands at the real peak (day 32)', episodes[0].daysToExtreme > 0 && episodes[0].extremeDate === emBars[32].date, JSON.stringify(episodes[0]));

const emFlat = Array.from({ length: 40 }, (_, i) => ({ date: new Date(emStart + i * 86400000).toISOString().slice(0, 10), close: 100 + Math.sin(i / 5) * 2 }));
check('a genuinely flat/noisy series with no real breakout: finds nothing', mod.detectMoveEpisodes(emFlat, 20, 7, 21, 30).length === 0);

const emBearish = emBars.map((b) => ({ date: b.date, close: 250 - b.close })); // mirror image -> a breakdown instead of a breakout
const bearEpisodes = mod.detectMoveEpisodes(emBearish, 20, 7, 21, 30);
check('the mirrored series is correctly detected as bearish', bearEpisodes.length === 1 && bearEpisodes[0].dir === -1, JSON.stringify(bearEpisodes));

check('too little history: no crash, no episodes', mod.detectMoveEpisodes([{ date: '2026-01-01', close: 100 }], 20, 7, 21, 30).length === 0);

console.log('\n== detectExhaustionReversals: dip/spike preceded by an extended opposite run, outlier (reclaimed) vs pivot (held) (2026-08-22, grounded in the real BTC/ETH/SOL/XRP/XLM/HBAR intraday reversal off fresh highs after the 08-20/21 rally) ==');
// The prior rise/bounce legs are deliberately gradual (well under the 20%-
// in-7-days trigger on their own) so detectMoveEpisodes flags ONLY the
// sudden dip itself as an episode — a first version of this fixture used a
// rise steep enough to trigger its OWN episode, whose cooldown window then
// swallowed the dip entirely (detectMoveEpisodes never got a chance to see
// it as a fresh trigger). The rise is still large cumulatively (+18.6% over
// the 10-day priorRunLookbackDays window) — real, just not itself abrupt.
const erReclaimedClose = (i) => {
  if (i < 20) return 100;                              // flat pad
  if (i <= 44) return 100 + (i - 20) * 2.4;             // extended prior rise: 100 -> 157.6 over 25 days, max 7-day window ~16.8% (never self-triggers)
  if (i <= 51) return 157.6 - (i - 44) * 8;             // sudden dip: 157.6 -> 101.6 over 7 days (-35.5%, clears the 20% trigger)
  return 101.6 + (i - 51) * 2.2;                        // bounces back, reclaims the pre-dip ~152.8 level around day 74-75; max 7-day window ~15.4% (never self-triggers)
};
const erReclaimedBars = Array.from({ length: 110 }, (_, i) => ({ date: new Date(emStart + i * 86400000).toISOString().slice(0, 10), close: erReclaimedClose(i) }));
const erReclaimedEpisodes = mod.detectMoveEpisodes(erReclaimedBars, 20, 7, 21, 30);
const erReclaimed = mod.detectExhaustionReversals(erReclaimedBars, erReclaimedEpisodes, 10, 12, 30);
check('finds exactly the dip episode (the gradual rise/bounce never independently trigger their own episode)', erReclaimedEpisodes.length === 1 && erReclaimed.length === 1, `episodes=${erReclaimedEpisodes.length} exhaustion=${JSON.stringify(erReclaimed)}`);
check('correctly identifies it as a bearish (dip) exhaustion episode with a real double-digit prior run', erReclaimed[0] && erReclaimed[0].dir === -1 && erReclaimed[0].priorRunPct > 15 && erReclaimed[0].priorRunPct < 25, JSON.stringify(erReclaimed));
check('outcome is "reclaimed" — price later exceeded the pre-dip peak, so this was an outlier/blip, not a pivot', erReclaimed[0] && erReclaimed[0].outcome === 'reclaimed' && erReclaimed[0].daysToReclaim > 0, JSON.stringify(erReclaimed));

const erHeldClose = (i) => {
  if (i < 20) return 100;
  if (i <= 44) return 100 + (i - 20) * 2.4;             // same extended prior rise
  if (i <= 51) return 157.6 - (i - 44) * 8;             // same sudden dip
  return 101.6;                                          // flat forever — never recovers toward the pre-dip peak
};
const erHeldBars = Array.from({ length: 110 }, (_, i) => ({ date: new Date(emStart + i * 86400000).toISOString().slice(0, 10), close: erHeldClose(i) }));
const erHeldEpisodes = mod.detectMoveEpisodes(erHeldBars, 20, 7, 21, 30);
const erHeld = mod.detectExhaustionReversals(erHeldBars, erHeldEpisodes, 10, 12, 30);
check('outcome is "held" — price never reclaimed the pre-dip peak within the window, so this was a genuine pivot', erHeld.length === 1 && erHeld[0].outcome === 'held' && erHeld[0].daysToReclaim === null, JSON.stringify(erHeld));

const erNoRunClose = (i) => {
  if (i < 30) return 100;                              // flat — no prior run at all
  if (i <= 37) return 100 - (i - 30) * (30 / 7);       // sharp dip in isolation, no extended rise behind it
  return 70;
};
const erNoRunBars = Array.from({ length: 70 }, (_, i) => ({ date: new Date(emStart + i * 86400000).toISOString().slice(0, 10), close: erNoRunClose(i) }));
const erNoRunEpisodes = mod.detectMoveEpisodes(erNoRunBars, 20, 7, 21, 30);
const erNoRun = mod.detectExhaustionReversals(erNoRunBars, erNoRunEpisodes, 10, 12, 30);
check('a real dip with no extended prior run behind it does not qualify as an exhaustion reversal (plain detectMoveEpisodes still finds the raw episode)', erNoRunEpisodes.length === 1 && erNoRun.length === 0, `episodes=${erNoRunEpisodes.length} exhaustion=${erNoRun.length}`);

const erSpikeClose = (i) => 300 - erReclaimedClose(i); // mirror image: extended decline -> sudden spike -> fades back (bounces back down) — the symmetric capitulation-bounce case
const erSpikeBars = Array.from({ length: 110 }, (_, i) => ({ date: new Date(emStart + i * 86400000).toISOString().slice(0, 10), close: erSpikeClose(i) }));
const erSpikeEpisodes = mod.detectMoveEpisodes(erSpikeBars, 20, 7, 21, 30);
const erSpike = mod.detectExhaustionReversals(erSpikeBars, erSpikeEpisodes, 10, 12, 30);
check('symmetric bear-side case: a spike preceded by an extended decline (capitulation bounce) is correctly detected, dir=1, priorRunPct clearly negative', erSpike.length === 1 && erSpike[0].dir === 1 && erSpike[0].priorRunPct < -12, JSON.stringify(erSpike));

const erShortBars = Array.from({ length: 8 }, (_, i) => ({ date: `2026-01-0${i + 1}`, close: 100 + i }));
const erShortEpisodes = [{ startIdx: 3, startDate: erShortBars[3].date, detectedIdx: 5, detectedDate: erShortBars[5].date, dir: -1, triggerPct: -25, fullMovePct: -25, daysToExtreme: 0, extremeDate: erShortBars[5].date }];
check('too little history before the episode to check a prior run (priorIdx would go negative): no crash, filtered out', mod.detectExhaustionReversals(erShortBars, erShortEpisodes, 10, 12, 30).length === 0);

console.log('\n== detectBottomThenMoonshot: a genuine, isolated trough that eventually multiplies by >=10x (2026-08-24, grounded in ZEC\'s real archived history -- $18.29 low on 2024-07-05, $786.42 on 2026-08-23, a confirmed 43x, still accelerating) ==');
const bmStart = new Date('2026-01-01T00:00:00Z').getTime();
const bmDate = (i) => new Date(bmStart + i * 86400000).toISOString().slice(0, 10);

const bmSimpleClose = (i) => {
  if (i < 10) return 100;                    // flat pad
  if (i <= 20) return 100 - (i - 10) * 8;     // decline to a trough: 100 -> 20 at i=20
  return 20 + (i - 20) * 5;                   // rally: crosses 10x (200) at i=56, keeps climbing after
};
const bmSimpleBars = Array.from({ length: 160 }, (_, i) => ({ date: bmDate(i), close: bmSimpleClose(i) }));
const bmSimple = mod.detectBottomThenMoonshot(bmSimpleBars, 10, 10, 100, 20);
check('finds the one genuine trough-then-10x episode', bmSimple.length === 1, JSON.stringify(bmSimple));
check('trough lands exactly at the real local minimum (day 20, close 20)', bmSimple[0] && bmSimple[0].troughDate === bmDate(20) && bmSimple[0].troughClose === 20, JSON.stringify(bmSimple));
check('daysToMultiple and peakMultiple are computed correctly off the real trough', bmSimple[0] && bmSimple[0].daysToMultiple === 36 && bmSimple[0].peakMultiple >= 10, JSON.stringify(bmSimple));

// Double-bottom case mirroring ZEC's own real shape: an early, shallower
// isolated local min (day 20) that looks like a trough at the time, but
// price later makes a NEW, deeper low (day 40) before ever reaching the
// target multiple from the first one -- the real launch point is the
// SECOND, deeper trough, not the first. This is exactly the bug this
// function's own history caught and fixed against ZEC's real data (an
// early version anchored on the shallower Nov-2022-shaped point and
// missed the deeper, real-launch July-2024-shaped point entirely).
const bmDoubleClose = (i) => {
  if (i < 10) return 100;                      // flat pad
  if (i <= 20) return 100 - (i - 10) * 6;       // decline to shallow trough A: 100 -> 40 at i=20
  if (i <= 30) return 40 + (i - 20) * 3;        // partial bounce, nowhere near 10x: 40 -> 70
  if (i <= 40) return 70 - (i - 30) * 5.5;      // decline again to a DEEPER trough B: 70 -> 15 at i=40
  return 15 + (i - 40) * 10;                    // real rally from B: crosses 10x (150) at i=54
};
const bmDoubleBars = Array.from({ length: 160 }, (_, i) => ({ date: bmDate(i), close: bmDoubleClose(i) }));
const bmDouble = mod.detectBottomThenMoonshot(bmDoubleBars, 10, 10, 100, 20);
check('double-bottom case: finds exactly one episode, not one per candidate trough', bmDouble.length === 1, JSON.stringify(bmDouble));
check('anchors on the DEEPER, real-launch trough (day 40, close 15), not the earlier shallower one (day 20, close 40)', bmDouble[0] && bmDouble[0].troughDate === bmDate(40) && bmDouble[0].troughClose === 15, JSON.stringify(bmDouble));

const bmNoMultiple = (i) => {
  if (i < 10) return 100;
  if (i <= 20) return 100 - (i - 10) * 7;   // decline to 30
  return Math.min(90, 30 + (i - 20) * 2);   // only ever reaches 3x, capped well under 10x
};
const bmNoMultipleBars = Array.from({ length: 120 }, (_, i) => ({ date: bmDate(i), close: bmNoMultiple(i) }));
check('a real trough that never reaches the target multiple: correctly finds nothing (not a lesser multiple counted as a false positive)', mod.detectBottomThenMoonshot(bmNoMultipleBars, 10, 10, 100, 20).length === 0);

check('too little history: no crash, nothing found', mod.detectBottomThenMoonshot([{ date: '2026-01-01', close: 100 }], 10, 10, 100, 20).length === 0);
check('empty history: no crash', mod.detectBottomThenMoonshot([], 10, 10, 100, 20).length === 0);

console.log('\n== detectPossibleLongTermBottom: the LIVE, forward-looking counterpart to detectBottomThenMoonshot -- "is this asset CURRENTLY near a fresh multi-month/year low" (2026-08-24, for the long-term-potential category; deliberately makes no claim about which candidates will actually succeed) ==');
const ltpDate = (i) => new Date(bmStart + i * 86400000).toISOString().slice(0, 10);

const ltpQualifyingClose = (i) => {
  if (i <= 59) return 100 - i * (80 / 59);       // decline 100 -> 20 over days 0-59 (the low)
  return 20 + ((i - 60) % 5);                     // stays near the low (20-24) for the rest, well within 20%
};
const ltpQualifyingBars = Array.from({ length: 100 }, (_, i) => ({ date: ltpDate(i), close: ltpQualifyingClose(i) }));
const ltpQualifying = mod.detectPossibleLongTermBottom(ltpQualifyingBars, 100, 10, 20);
check('a fresh low that has held for a while, still near it: qualifies', ltpQualifying !== null && ltpQualifying.lowClose === 20 && ltpQualifying.daysSinceLow === 40, JSON.stringify(ltpQualifying));
check('pctAboveLow correctly reflects the current close vs. the real low', ltpQualifying !== null && ltpQualifying.pctAboveLow >= 0 && ltpQualifying.pctAboveLow <= 20, JSON.stringify(ltpQualifying));

const ltpTooRecentClose = (i) => {
  if (i <= 95) return 100 - i * (80 / 95);        // still declining right up to near the end
  return 20 + (i - 95);                            // barely off the low, only a few days old
};
const ltpTooRecentBars = Array.from({ length: 100 }, (_, i) => ({ date: ltpDate(i), close: ltpTooRecentClose(i) }));
check('the low was hit too recently (still might be in free-fall, not stabilized): does not yet qualify', mod.detectPossibleLongTermBottom(ltpTooRecentBars, 100, 10, 20) === null);

const ltpRalliedAwayClose = (i) => {
  if (i <= 59) return 100 - i * (80 / 59);        // same decline to a real low at day 59
  return 20 + (i - 60) * 1.2;                       // then rallies hard away from it
};
const ltpRalliedAwayBars = Array.from({ length: 100 }, (_, i) => ({ date: ltpDate(i), close: ltpRalliedAwayClose(i) }));
check('price has already rallied well away from the low: no longer qualifies (this is the ZEC case, live-verified 2026-08-24 -- 43x off its own real low, correctly returns null)', mod.detectPossibleLongTermBottom(ltpRalliedAwayBars, 100, 10, 20) === null);

check('not enough history yet to judge a full lookback window: no crash, null', mod.detectPossibleLongTermBottom(ltpQualifyingBars.slice(0, 50), 100, 10, 20) === null);
check('empty history: no crash, null', mod.detectPossibleLongTermBottom([], 100, 10, 20) === null);

console.log('\n== CRYPTO_BLOCKLIST: stablecoins/wrapped assets excluded from the tracked universe ==');
// Found live 2026-08-24 verifying the long-term-potential category:
// BFUSD/GHO/USD1 all traded in a tight $0.96-$1.01 band across their
// full archived history (confirmed via direct query) but were missing
// from this list, showing up as false "long-term potential" candidates
// by virtue of never moving much at all. A real gap, not a hypothetical.
check('the three stablecoins found live 2026-08-24 are blocked', mod.CRYPTO_BLOCKLIST.has('bfusd') && mod.CRYPTO_BLOCKLIST.has('gho') && mod.CRYPTO_BLOCKLIST.has('usd1'));
check('pre-existing blocklist entries are still intact (not accidentally replaced)', mod.CRYPTO_BLOCKLIST.has('usdt') && mod.CRYPTO_BLOCKLIST.has('wbtc') && mod.CRYPTO_BLOCKLIST.size >= 50, mod.CRYPTO_BLOCKLIST.size);

console.log('\n== levelChangeBefore: N-trading-day level change ending at/before a target date, gap-tolerant ==');
const yieldBars = [
  { date: '2026-01-02', close: 4.5 }, { date: '2026-01-05', close: 4.45 }, // weekday-only series -- 01-03/04 are a weekend, correctly absent
  { date: '2026-01-06', close: 4.4 }, { date: '2026-01-07', close: 4.35 }, { date: '2026-01-08', close: 4.3 },
  { date: '2026-01-09', close: 4.2 }, { date: '2026-01-12', close: 4.1 }
];
check('3-index-position change ending at the exact target date', Math.abs(mod.levelChangeBefore(yieldBars, '2026-01-08', 3) - (4.3 - 4.45)) < 1e-9, mod.levelChangeBefore(yieldBars, '2026-01-08', 3));
check('a target date that falls on a gap (weekend) uses the latest PRIOR bar, never a future one', Math.abs(mod.levelChangeBefore(yieldBars, '2026-01-10', 2) - (4.2 - 4.35)) < 1e-9, mod.levelChangeBefore(yieldBars, '2026-01-10', 2));
check('not enough trailing bars for the requested lookback: null, not a guess', mod.levelChangeBefore(yieldBars, '2026-01-05', 5) === null);
check('target date before any archived bar: null', mod.levelChangeBefore(yieldBars, '2025-01-01', 1) === null);
check('empty series: null, not a crash', mod.levelChangeBefore([], '2026-01-08', 3) === null);
check('returns a raw point difference, not a percentage', mod.levelChangeBefore(yieldBars, '2026-01-12', 1) < 0 && Math.abs(mod.levelChangeBefore(yieldBars, '2026-01-12', 1)) < 1, mod.levelChangeBefore(yieldBars, '2026-01-12', 1));

console.log('\n== yieldcurve technique: the one validated consolidation-research finding (2s10s spread narrowing precedes crypto weakness) ==');
const yieldcurveFires = findTech(mod.evaluateTechniques(baseMetric({}), 'crypto', undefined, { yieldSpreadChange: { chg5d: -0.03, asOf: '2026-08-20' } }), 'yieldcurve');
check('spread moved -0.03pts over 5d (past the -0.015 bar): fires bearish', yieldcurveFires.dir === -1, JSON.stringify(yieldcurveFires));
check('note carries the actual spread move', yieldcurveFires.note.includes('-0.03'), yieldcurveFires.note);

const yieldcurveSmallMove = findTech(mod.evaluateTechniques(baseMetric({}), 'crypto', undefined, { yieldSpreadChange: { chg5d: -0.005, asOf: '2026-08-20' } }), 'yieldcurve');
check('a small move within ordinary noise (-0.005, close to the -0.003 normal-day mean): neutral, not fired', yieldcurveSmallMove.dir === 0, JSON.stringify(yieldcurveSmallMove));

const yieldcurveRising = findTech(mod.evaluateTechniques(baseMetric({}), 'crypto', undefined, { yieldSpreadChange: { chg5d: 0.05, asOf: '2026-08-20' } }), 'yieldcurve');
check('deliberately asymmetric: a spread WIDENING does not fire bullish (that mirror hypothesis did not validate)', yieldcurveRising.dir === 0, JSON.stringify(yieldcurveRising));

const yieldcurveNoData = findTech(mod.evaluateTechniques(baseMetric({}), 'crypto'), 'yieldcurve');
check('no yieldSpreadChange loaded at all: abstains (null)', yieldcurveNoData.dir === null, JSON.stringify(yieldcurveNoData));

const yieldcurveStockGated = findTech(mod.evaluateTechniques(baseMetric({}), 'stock', undefined, { yieldSpreadChange: { chg5d: -0.03, asOf: '2026-08-20' } }), 'yieldcurve');
check('crypto-only: stocks never fire this technique (the validated finding was crypto-specific)', yieldcurveStockGated.dir === null, JSON.stringify(yieldcurveStockGated));

console.log('\n== perpBasisPct: perp-vs-spot basis, computed independently of CoinGecko\'s own undocumented "basis" field ==');
check('perp trading above spot index: positive basis', mod.perpBasisPct(77006.7, 76902.25) > 0 && mod.perpBasisPct(77006.7, 76902.25) < 1, mod.perpBasisPct(77006.7, 76902.25));
check('perp trading below spot index: negative basis', mod.perpBasisPct(100, 105) < 0, mod.perpBasisPct(100, 105));
check('perp exactly at index: zero basis', mod.perpBasisPct(100, 100) === 0);
check('missing price or index: null, not a crash or a fabricated zero', mod.perpBasisPct(null, 100) === null && mod.perpBasisPct(100, null) === null && mod.perpBasisPct(100, 0) === null);

console.log('\n== fundingSnapshotToRows: carries basisPct through alongside funding/OI ==');
const fundingSnapWithBasis = fundingSnapshotToRows({ BTC: { fundingRate: 0.0001, openInterest: 5e9, basisPct: 0.14 }, ONLYBASIS: { fundingRate: null, openInterest: null, basisPct: -0.5 } }, '2026-08-21');
check('a symbol with funding+OI+basis carries all three through', fundingSnapWithBasis.find(r => r.symbol === 'BTC').basisPct === 0.14, JSON.stringify(fundingSnapWithBasis));
check('a symbol with ONLY basis (no funding/OI) still produces a row, not silently dropped', fundingSnapWithBasis.some(r => r.symbol === 'ONLYBASIS' && r.basisPct === -0.5), JSON.stringify(fundingSnapWithBasis));

console.log('\n== detectOutperformanceRotation: sustained multi-month outperformance vs a benchmark (the Solana-then/Hyperliquid-now pattern) ==');
const rotStart = new Date('2020-01-01T00:00:00Z').getTime();
const rotDate = (i) => new Date(rotStart + i * 86400000).toISOString().slice(0, 10);
const benchFlat = Array.from({ length: 500 }, (_, i) => ({ date: rotDate(i), close: 100 })); // a perfectly flat benchmark -- any real asset growth is, by construction, outperformance
const rotatingAsset = Array.from({ length: 500 }, (_, i) => {
  if (i < 200) return { date: rotDate(i), close: 100 };            // tracks the benchmark, no rotation yet
  if (i < 350) return { date: rotDate(i), close: 100 * Math.pow(1.03, i - 200) }; // Solana-like roaring growth phase
  return { date: rotDate(i), close: rotatingAssetPeak() };          // flattens out again at its new (much higher) level
  function rotatingAssetPeak() { return 100 * Math.pow(1.03, 149); }
});

const rotations = mod.detectOutperformanceRotation(rotatingAsset, benchFlat);
check('finds at least one real rotation streak during the roaring-growth phase', rotations.length >= 1, JSON.stringify(rotations));
check('the streak clears the minimum consecutive-checkpoint bar (3)', rotations.every((r) => r.checkpoints >= 3), JSON.stringify(rotations));
check('peak relative strength is enormous (this is Solana-2020-21-scale growth, not a marginal edge)', rotations[0].peakRel > 500, JSON.stringify(rotations[0]));
check('the detected streak starts within the actual growth phase (day 200+), not the flat pre-rotation period', rotations[0].startDate >= rotDate(200), rotations[0].startDate);

const noRotation = mod.detectOutperformanceRotation(benchFlat, benchFlat);
check('an asset that never outperforms its own benchmark: no rotation found', noRotation.length === 0);

const thinHistory = mod.detectOutperformanceRotation(benchFlat.slice(0, 50), benchFlat.slice(0, 50), 90);
check('not enough history to even form one windowDays-long window: no crash, no rotation', thinHistory.length === 0);

console.log('\n== computeQualityScores: cross-sectional utility/community percentile, never an absolute number ==');
// 12 symbols so every metric clears the "at least 10 peers" bar -- ETH-like
// at the top of every metric, HYPE-like with real watchlist interest but
// zero GitHub data (the real case confirmed live), the rest a plain ramp.
const qualityFixture = { ETH: { githubCommits4w: 41, githubPrContributors: 906, communityReach: 500000, watchlistUsers: 1978834 } };
for (let i = 0; i < 11; i++) qualityFixture[`ALT${i}`] = { githubCommits4w: i, githubPrContributors: i, communityReach: i * 1000, watchlistUsers: i * 10000 };
qualityFixture.HYPE = { githubCommits4w: null, githubPrContributors: null, communityReach: 26598, watchlistUsers: 190367 };
qualityFixture.NODATA = { githubCommits4w: null, githubPrContributors: null, communityReach: null, watchlistUsers: null };

const qualityScores = mod.computeQualityScores(qualityFixture);
check('the strongest-on-every-metric symbol scores at or near the top', qualityScores.ETH.score >= 90, JSON.stringify(qualityScores.ETH));
check('its basis reflects all 4 metrics contributing', qualityScores.ETH.basis === 4, JSON.stringify(qualityScores.ETH));
check('a symbol with real community/interest data but zero GitHub activity (the real HYPE case) still gets a score, just from fewer metrics', qualityScores.HYPE && qualityScores.HYPE.basis === 2, JSON.stringify(qualityScores.HYPE));
check('a symbol with no data at all for any metric: not scored, not fabricated as 0', !('NODATA' in qualityScores));
check('the weakest-on-every-metric symbol scores at or near the bottom', qualityScores.ALT0.score <= 20, JSON.stringify(qualityScores.ALT0));
check('scores are relative rank, not an absolute count -- ETH\'s 41 commits beats everyone despite being a small raw number', qualityScores.ETH.score > qualityScores.ALT10.score, `ETH=${qualityScores.ETH.score} ALT10=${qualityScores.ALT10.score}`);

const thinPeerGroup = { A: { githubCommits4w: 5, githubPrContributors: null, communityReach: null, watchlistUsers: null }, B: { githubCommits4w: 10, githubPrContributors: null, communityReach: null, watchlistUsers: null } };
check('fewer than 10 peers with a metric: that metric is excluded from ranking entirely, not ranked on a tiny unreliable sample', !('A' in mod.computeQualityScores(thinPeerGroup)));

console.log('\n== seasonalAnalog: does this asset\'s own history contain a real analog? ==');
check('too short a series: returns null, not a guess', mod.seasonalAnalog(Array.from({ length: 100 }, () => 100), 365) === null);
function patternWindow(offset) { return Array.from({ length: 90 }, (_, i) => 100 + Math.sin((i + offset) / 10) * 8 + i * 0.1); }
const cycleLength = 365;
const totalLen = cycleLength * 2 + 90 + 10;
const seasonalCloses = new Array(totalLen).fill(100);
const pattern = patternWindow(0);
const place = (startIdx) => { for (let i = 0; i < 90; i++) seasonalCloses[startIdx + i] = pattern[i]; };
place(totalLen - 90); // current window
place(totalLen - 90 - cycleLength); // 1 year ago: the analog
const analogEnd = totalLen - 90 - cycleLength + 90;
for (let i = 0; i < 10; i++) seasonalCloses[analogEnd + i] = pattern[89] * (1 + 0.08 * (i + 1) / 10); // clear +8%-ish forward move after the analog
const seasonalResult = mod.seasonalAnalog(seasonalCloses, cycleLength, 90, 7, 6);
check('finds a real analog year and reports what happened next, bullish case', seasonalResult && seasonalResult.cycle === 1 && seasonalResult.dir === 1 && seasonalResult.corr > 0.9, JSON.stringify(seasonalResult));
const noAnalogCloses = Array.from({ length: totalLen }, () => 100 + Math.random() * 20 - 10);
const noAnalog = mod.seasonalAnalog(noAnalogCloses, cycleLength, 90, 7, 6);
check('pure noise, no real resemblance to any prior period: returns null rather than fitting noise', noAnalog === null, JSON.stringify(noAnalog));

console.log('\n== fibonacciLevels: retracement of the real recent swing, not a guess ==');
check('too short a series: returns null', mod.fibonacciLevels(Array.from({ length: 10 }, () => 100), 90) === null);
check('flat series (hi===lo): returns null', mod.fibonacciLevels(Array.from({ length: 90 }, () => 100), 90) === null);
const upLeg = Array.from({ length: 90 }, (_, i) => 100 + i); // low at idx0, high at idx89
const upFib = mod.fibonacciLevels(upLeg, 90);
check('clean up-leg: low came first, high is most recent -> legUp true', upFib && upFib.legUp === true, JSON.stringify(upFib));
check('up-leg 50% level sits at the true midpoint', upFib && Math.abs(upFib.l500 - (upFib.hi + upFib.lo) / 2) < 1e-9);
check('up-leg levels ordered high > 38.2% > 50% > 61.8% > low (38.2% is the shallow retracement, closer to the high)', upFib.hi > upFib.l382 && upFib.l382 > upFib.l500 && upFib.l500 > upFib.l618 && upFib.l618 > upFib.lo);
const downLeg = Array.from({ length: 90 }, (_, i) => 189 - i); // high at idx0, low is most recent
const downFib = mod.fibonacciLevels(downLeg, 90);
check('clean down-leg: high came first, low is most recent -> legUp false', downFib && downFib.legUp === false, JSON.stringify(downFib));

console.log('\n== dwell + seasonal techniques: fire only with real signal, learn like every other technique ==');
const dwellLowMetric = baseMetric({ rsi: 50, rsiPrev: 50, dwell: { dir: -1, days: 12 }, corr: 0.8 }); // dwelling low, but still correlated with the market
const dwellLowDecoupled = baseMetric({ rsi: 50, rsiPrev: 50, dwell: { dir: -1, days: 12 }, corr: 0.1 }); // same dwell, decoupled
const dwellTooShort = baseMetric({ rsi: 50, rsiPrev: 50, dwell: { dir: -1, days: 2 }, corr: 0.1 }); // below MIN_DWELL_DAYS
const dTechCorrelated = findTech(mod.evaluateTechniques(dwellLowMetric, 'crypto'), 'dwell');
const dTechDecoupled = findTech(mod.evaluateTechniques(dwellLowDecoupled, 'crypto'), 'dwell');
const dTechTooShort = findTech(mod.evaluateTechniques(dwellTooShort, 'crypto'), 'dwell');
check('dwelling near a low votes bullish (reversal read)', dTechCorrelated.dir === 1, `dir=${dTechCorrelated.dir}`);
check('decoupling from the market raises the weight over the same dwell while still correlated', dTechDecoupled.w > dTechCorrelated.w, `decoupled=${dTechDecoupled.w} correlated=${dTechCorrelated.w}`);
check('below MIN_DWELL_DAYS: does not fire a directional call', dTechTooShort.dir === 0, `dir=${dTechTooShort.dir}`);
check('no dwell data at all: abstains (null), not a guess', findTech(mod.evaluateTechniques(baseMetric({}), 'crypto'), 'dwell').dir === null);

const seasonalBullMetric = baseMetric({ seasonal: { cycle: 2, corr: 0.75, forwardReturnPct: 6, dir: 1 } });
const seasonalBearMetric = baseMetric({ seasonal: { cycle: 1, corr: 0.6, forwardReturnPct: -4, dir: -1 } });
check('a bullish seasonal analog votes bullish', findTech(mod.evaluateTechniques(seasonalBullMetric, 'crypto'), 'seasonal').dir === 1);
check('a bearish seasonal analog votes bearish', findTech(mod.evaluateTechniques(seasonalBearMetric, 'crypto'), 'seasonal').dir === -1);
check('no seasonal analog found: abstains (null), the common case for younger assets', findTech(mod.evaluateTechniques(baseMetric({}), 'crypto'), 'seasonal').dir === null);

console.log('\n== fibonacci technique: never fires on proximity to a level alone ==');
const fibUp = { hi: 200, lo: 100, legUp: true, l382: 200 - 0.382 * 100, l500: 150, l618: 200 - 0.618 * 100 };
const fibAtFiftyConfirmed = baseMetric({ price: 150, fib: fibUp, structure: 1 });
const fibAtFiftyUnconfirmed = baseMetric({ price: 150, fib: fibUp, structure: 0 });
const fibFarFromLevel = baseMetric({ price: 180, fib: fibUp, structure: 1 });
const fTechConfirmed = findTech(mod.evaluateTechniques(fibAtFiftyConfirmed, 'crypto'), 'fibonacci');
const fTechUnconfirmed = findTech(mod.evaluateTechniques(fibAtFiftyUnconfirmed, 'crypto'), 'fibonacci');
const fTechFar = findTech(mod.evaluateTechniques(fibFarFromLevel, 'crypto'), 'fibonacci');
const fTechNoData = findTech(mod.evaluateTechniques(baseMetric({ price: 150 }), 'crypto'), 'fibonacci');
check('holding the 50% retracement of an up-leg, confirmed by structure: bullish', fTechConfirmed.dir === 1, JSON.stringify(fTechConfirmed));
check('same level, no independent confirmation: does not fire', fTechUnconfirmed.dir === 0, JSON.stringify(fTechUnconfirmed));
check('nowhere near a level: neutral, not a guess', fTechFar.dir === 0, JSON.stringify(fTechFar));
check('no fib data at all: abstains (null), not a guess', fTechNoData.dir === null, JSON.stringify(fTechNoData));

console.log('\n== etHour: DST-aware NY-local hour, not a fixed UTC offset ==');
check('January (EST, UTC-5): 05:00 UTC is midnight ET', mod.etHour(new Date('2026-01-15T05:00:00.000Z')) === 0);
check('July (EDT, UTC-4): 04:00 UTC is midnight ET', mod.etHour(new Date('2026-07-15T04:00:00.000Z')) === 0);
check('July (EDT): 13:45 UTC falls in the 9am ET hour (NYSE open)', mod.etHour(new Date('2026-07-15T13:45:00.000Z')) === 9);

console.log('\n== hourInZone: the general primitive etHour now wraps ==');
check('etHour(x) === hourInZone(x, America/New_York)', mod.etHour(new Date('2026-07-15T13:45:00.000Z')) === mod.hourInZone(new Date('2026-07-15T13:45:00.000Z'), 'America/New_York'));
check('Tokyo has no DST: always UTC+9 regardless of season', mod.hourInZone(new Date('2026-01-15T05:00:00.000Z'), 'Asia/Tokyo') === 14 && mod.hourInZone(new Date('2026-07-15T05:00:00.000Z'), 'Asia/Tokyo') === 14);
check('London is on GMT (UTC+0) in January, BST (UTC+1) in July', mod.hourInZone(new Date('2026-01-15T05:00:00.000Z'), 'Europe/London') === 5 && mod.hourInZone(new Date('2026-07-15T05:00:00.000Z'), 'Europe/London') === 6);

console.log('\n== slotsForTimestamp: the five clock dimensions a timestamp belongs to ==');
const todSlots = mod.slotsForTimestamp('2026-01-15T05:00:00.000Z');
check('exactly 5 slots: UTC/ET/London/Tokyo hour + UTC day-of-week', todSlots.length === 5, JSON.stringify(todSlots));
check('UTC hour slot format', todSlots.includes('hour_utc_05'), JSON.stringify(todSlots));
check('ET hour slot format (midnight ET, matches the etHour check above)', todSlots.includes('hour_et_00'), JSON.stringify(todSlots));
check('London session slot present (GMT in January, so matches UTC)', todSlots.includes('hour_ldn_05'), JSON.stringify(todSlots));
check('Tokyo session slot present (UTC+9, no DST)', todSlots.includes('hour_tyo_14'), JSON.stringify(todSlots));
check('day-of-week slot present', todSlots.some(s => s.startsWith('dow_utc_')), JSON.stringify(todSlots));

console.log('\n== computeSwingTimeTallies: which hour holds the day\'s actual high/low, not just direction ==');
function mkDay(dateStr, values) {
  return values.map((close, h) => ({ ts: `${dateStr}T${String(h).padStart(2, '0')}:00:00.000Z`, close }));
}
const swingDay1 = mkDay('2026-01-15', Array.from({ length: 24 }, (_, h) => (h === 14 ? 200 : h === 3 ? 50 : 100)));
const swing1 = computeSwingTimeTallies(swingDay1);
check('one full day tallies to totalDays=1', swing1.totalDays === 1, swing1.totalDays);
check('the max-hour (14) slot gets a high tally', swing1.tallies['hour_utc_14'] && swing1.tallies['hour_utc_14'].high === 1, JSON.stringify(swing1.tallies['hour_utc_14']));
check('the min-hour (3) slot gets a low tally', swing1.tallies['hour_utc_03'] && swing1.tallies['hour_utc_03'].low === 1, JSON.stringify(swing1.tallies['hour_utc_03']));
check('the max-hour slot does not also get a low tally', !swing1.tallies['hour_utc_14'].low);

const swingThinDay = mkDay('2026-01-16', Array.from({ length: 24 }, (_, h) => (h === 14 ? 200 : h === 3 ? 50 : 100))).slice(0, 8);
check('a day with fewer than 12 hourly bars is skipped, not trusted', computeSwingTimeTallies(swingThinDay).totalDays === 0);

const swingDay2 = mkDay('2026-01-17', Array.from({ length: 24 }, (_, h) => (h === 14 ? 300 : 100)));
const swing2 = computeSwingTimeTallies([...swingDay1, ...swingDay2]);
check('two days accumulate: totalDays=2', swing2.totalDays === 2, swing2.totalDays);
check('a recurring peak hour (14, both days) accumulates a count of 2', swing2.tallies['hour_utc_14'].high === 2, JSON.stringify(swing2.tallies['hour_utc_14']));

const swingEmpty = computeSwingTimeTallies([]);
check('empty input: zero days, no tallies', swingEmpty.totalDays === 0 && Object.keys(swingEmpty.tallies).length === 0);

console.log('\n== swingTimeSignal: does THIS asset\'s daily high/low tend to land in the current slot? ==');
const stNow = '2026-03-10T14:00:00.000Z';
const [stSlotA, stSlotB] = mod.slotsForTimestamp(stNow); // both hour-type slots -> baseline 1/24 for the ratio math below
check('no stats at all: abstains (null)', mod.swingTimeSignal(null, 'BTC', stNow) === null);
check('stats present but nothing for this symbol: abstains (null)', mod.swingTimeSignal({}, 'BTC', stNow) === null);

const stRealPattern = { [`BTC|${stSlotA}|low`]: { count: 30, totalDays: 100 } }; // 30% vs ~4.2% hour baseline -> ~7x
const stPicked = mod.swingTimeSignal(stRealPattern, 'BTC', stNow);
check('a real, well-sampled pattern is picked up', stPicked && stPicked.extremeType === 'low' && stPicked.slot === stSlotA, JSON.stringify(stPicked));

const stWeakRatio = { [`BTC|${stSlotA}|low`]: { count: 5, totalDays: 100 } }; // 5%, barely above the ~4.2% baseline
check('a probability barely above baseline (ratio < 2x): abstains (null)', mod.swingTimeSignal(stWeakRatio, 'BTC', stNow) === null);

const stTooFewDays = { [`BTC|${stSlotA}|low`]: { count: 10, totalDays: 20 } }; // strong 50% ratio, but only 20 days observed
check('a strong ratio but too few days observed (below 40): abstains (null)', mod.swingTimeSignal(stTooFewDays, 'BTC', stNow) === null);

const stMultiCandidate = {
  [`BTC|${stSlotA}|low`]: { count: 20, totalDays: 100 },  // ~4.8x baseline
  [`BTC|${stSlotB}|high`]: { count: 40, totalDays: 100 }  // ~9.6x baseline, stronger
};
const stMultiPicked = mod.swingTimeSignal(stMultiCandidate, 'BTC', stNow);
check('with multiple qualifying candidates, picks the strongest ratio', stMultiPicked && stMultiPicked.extremeType === 'high' && stMultiPicked.slot === stSlotB, JSON.stringify(stMultiPicked));

console.log('\n== swingtime technique: only fires when the timing pattern AND current price position both agree ==');
const stLowPattern = { [`BTC|${stSlotA}|low`]: { count: 30, totalDays: 100 } };
const stHighPattern = { [`BTC|${stSlotA}|high`]: { count: 30, totalDays: 100 } };
const stTechBullish = findTech(mod.evaluateTechniques(baseMetric({ symbol: 'BTC', rangePos: 0.05 }), 'crypto', undefined, { nowIso: stNow, swingTimeStats: stLowPattern }), 'swingtime');
const stTechNoConfirm = findTech(mod.evaluateTechniques(baseMetric({ symbol: 'BTC', rangePos: 0.5 }), 'crypto', undefined, { nowIso: stNow, swingTimeStats: stLowPattern }), 'swingtime');
const stTechBearish = findTech(mod.evaluateTechniques(baseMetric({ symbol: 'BTC', rangePos: 0.95 }), 'crypto', undefined, { nowIso: stNow, swingTimeStats: stHighPattern }), 'swingtime');
const stTechNoStats = findTech(mod.evaluateTechniques(baseMetric({ symbol: 'BTC', rangePos: 0.05 }), 'crypto'), 'swingtime');
check('proven low-timing slot + price actually near its low right now: fires bullish', stTechBullish.dir === 1, JSON.stringify(stTechBullish));
check('same proven pattern, but price is mid-range: does not fire (timing alone is not enough)', stTechNoConfirm.dir === 0, JSON.stringify(stTechNoConfirm));
check('proven high-timing slot + price actually near its high right now: fires bearish', stTechBearish.dir === -1, JSON.stringify(stTechBearish));
check('no swing-time stats loaded at all: abstains (null)', stTechNoStats.dir === null, JSON.stringify(stTechNoStats));

console.log('\n== selectWorstRecentEvent: recency + severity-relative-to-mcap, not an absolute dollar figure ==');
const esNow = new Date('2026-03-10T00:00:00.000Z').getTime();
check('no events at all: returns null', mod.selectWorstRecentEvent(null, esNow, 1e9) === null);
check('empty events array: returns null', mod.selectWorstRecentEvent([], esNow, 1e9) === null);

const esToday = [{ date: '2026-03-10', type: 'hack', severityUsd: 100e6, description: 'Test Hack' }];
const esPickedToday = mod.selectWorstRecentEvent(esToday, esNow, 1e9); // $100M hack on a $1B mcap asset
check('relSeverity computed correctly (100M/1B = 0.1)', esPickedToday && Math.abs(esPickedToday.relSeverity - 0.1) < 1e-9, JSON.stringify(esPickedToday));
check('a hack today: full recency weight (no time decay yet)', esPickedToday.recencyFactor === 1, esPickedToday.recencyFactor);

const esOld = [{ date: '2026-02-01', type: 'hack', severityUsd: 100e6, description: 'Old Hack' }]; // 37 days before esNow, well outside the 14-day window
check('an event outside the recency window is excluded', mod.selectWorstRecentEvent(esOld, esNow, 1e9) === null);

const esUnknownSeverity = [{ date: '2026-03-10', type: 'hack', severityUsd: null, description: 'Unconfirmed Hack' }];
const esPickedUnknown = mod.selectWorstRecentEvent(esUnknownSeverity, esNow, 1e9);
check('unknown dollar amount gets a modest default impact, not zero', esPickedUnknown && esPickedUnknown.relSeverity === 0.05, JSON.stringify(esPickedUnknown));

const esMultiple = [
  { date: '2026-03-09', type: 'hack', severityUsd: 10e6, description: 'Small Hack' },  // small, recent (1d ago)
  { date: '2026-03-03', type: 'hack', severityUsd: 500e6, description: 'Big Hack' }    // big, a week old
];
const esPickedWorst = mod.selectWorstRecentEvent(esMultiple, esNow, 1e9);
check('with multiple events, picks the worst (severity x recency), not just the most recent', esPickedWorst && esPickedWorst.description === 'Big Hack', JSON.stringify(esPickedWorst));

console.log('\n== eventshock technique: a matched recent hack votes bearish, crypto-only, never fabricated ==');
const esRecentEvents = { BTC: [{ date: '2026-03-10', type: 'hack', severityUsd: 200e6, description: 'Test Protocol Hack' }] };
const esTechFires = findTech(mod.evaluateTechniques(baseMetric({ symbol: 'BTC', mcap: 1e9 }), 'crypto', undefined, { nowIso: '2026-03-10T00:00:00.000Z', recentEvents: esRecentEvents }), 'eventshock');
check('a matched recent hack fires bearish', esTechFires.dir === -1, JSON.stringify(esTechFires));

const esTechNoEventForSymbol = findTech(mod.evaluateTechniques(baseMetric({ symbol: 'ETH', mcap: 1e9 }), 'crypto', undefined, { nowIso: '2026-03-10T00:00:00.000Z', recentEvents: esRecentEvents }), 'eventshock');
check('recentEvents loaded but nothing for this symbol: neutral, not fabricated', esTechNoEventForSymbol.dir === 0, JSON.stringify(esTechNoEventForSymbol));

const esTechNoData = findTech(mod.evaluateTechniques(baseMetric({ symbol: 'BTC', mcap: 1e9 }), 'crypto'), 'eventshock');
check('no recentEvents/nowIso at all: abstains (null)', esTechNoData.dir === null, JSON.stringify(esTechNoData));

const esTechStockGated = findTech(mod.evaluateTechniques(baseMetric({ symbol: 'BTC', mcap: 1e9 }), 'stock', undefined, { nowIso: '2026-03-10T00:00:00.000Z', recentEvents: esRecentEvents }), 'eventshock');
check('crypto-only: stocks never fire this technique even with matching event data', esTechStockGated.dir === null, JSON.stringify(esTechStockGated));

console.log('\n== timeOfDaySignal: only fires with real sample depth AND a real effect size ==');
const todNow = '2026-03-10T14:00:00.000Z';
const [slotA, slotB] = mod.slotsForTimestamp(todNow);
check('no todStats at all: abstains (null)', mod.timeOfDaySignal(null, 'BTC', todNow) === null);
check('todStats present but this symbol/slot never recorded: abstains (null)', mod.timeOfDaySignal({}, 'BTC', todNow) === null);

const todStrongBull = { [`BTC|${slotA}|1`]: { meanPct: 2.0, stdevPct: 1.0, n: 50 } }; // effect 2.0, well above the bar
check('real sample depth + strong positive effect: fires bullish', mod.timeOfDaySignal(todStrongBull, 'BTC', todNow)?.dir === 1, JSON.stringify(mod.timeOfDaySignal(todStrongBull, 'BTC', todNow)));

const todStrongBear = { [`BTC|${slotB}|4`]: { meanPct: -1.5, stdevPct: 0.5, n: 30 } }; // effect 3.0
check('strong negative effect: fires bearish', mod.timeOfDaySignal(todStrongBear, 'BTC', todNow)?.dir === -1);

const todTooThin = { [`BTC|${slotA}|1`]: { meanPct: 2.0, stdevPct: 1.0, n: 5 } }; // strong effect, but n is too low
check('below the sample-count bar despite a strong mean: abstains (null)', mod.timeOfDaySignal(todTooThin, 'BTC', todNow) === null);

const todNoisyMean = { [`BTC|${slotA}|1`]: { meanPct: 0.1, stdevPct: 2.0, n: 50 } }; // n is fine, effect (0.05) is noise
check('enough samples but the mean is indistinguishable from noise: abstains (null)', mod.timeOfDaySignal(todNoisyMean, 'BTC', todNow) === null);

const todMultiCandidate = {
  [`BTC|${slotA}|1`]: { meanPct: 1.0, stdevPct: 1.0, n: 40 },  // effect 1.0
  [`BTC|${slotB}|4`]: { meanPct: -3.0, stdevPct: 1.0, n: 40 }  // effect 3.0, stronger
};
const todPicked = mod.timeOfDaySignal(todMultiCandidate, 'BTC', todNow);
check('picks the strongest-effect candidate among several qualifying slots, not just the first', todPicked && todPicked.dir === -1 && todPicked.meanPct === -3, JSON.stringify(todPicked));

console.log('\n== timeofday technique: wired into evaluateTechniques like every other technique ==');
const todTechFires = findTech(mod.evaluateTechniques(baseMetric({ symbol: 'BTC' }), 'crypto', undefined, { todStats: todStrongBull, nowIso: todNow }), 'timeofday');
const todTechNoStats = findTech(mod.evaluateTechniques(baseMetric({ symbol: 'BTC' }), 'crypto', undefined, { nowIso: todNow }), 'timeofday');
check('fires through the full technique pipeline when todStats + nowIso are supplied', todTechFires.dir === 1, JSON.stringify(todTechFires));
check('abstains (null) when todStats/nowIso are not supplied at all', todTechNoStats.dir === null, JSON.stringify(todTechNoStats));

console.log('\n== computeTimeOfDayTallies: historical bootstrap for time_of_day_stats, zero new fetches ==');
const ctBeforeTs = '2026-01-01T00:00:00.000Z';
const ctAfterTs = '2026-01-01T01:00:00.000Z';
const ctSlotsBefore = mod.slotsForTimestamp(ctBeforeTs);
const ctBasicBars = [{ ts: ctBeforeTs, close: 100 }, { ts: ctAfterTs, close: 102 }];
const ctBasic = mod.computeTimeOfDayTallies(ctBasicBars, [1]);
check('tallies every slot the EARLIER bar belongs to', ctSlotsBefore.every(slot => ctBasic[`${slot}|1`] && ctBasic[`${slot}|1`].n === 1), JSON.stringify(ctBasic));
check('sumPct matches the real 2% move', Math.abs(ctBasic[`${ctSlotsBefore[0]}|1`].sumPct - 2) < 1e-9, ctBasic[`${ctSlotsBefore[0]}|1`]);
check('sumPctSq matches pct^2 (4)', Math.abs(ctBasic[`${ctSlotsBefore[0]}|1`].sumPctSq - 4) < 1e-9);
check('bucketed by the slot of the EARLIER bar (hour_utc_00), not the later one (hour_utc_01)', ctBasic['hour_utc_00|1'] != null && ctBasic['hour_utc_01|1'] == null, JSON.stringify(Object.keys(ctBasic)));

const ctGapBars = [{ ts: '2026-01-01T00:00:00.000Z', close: 100 }, { ts: '2026-01-01T03:00:00.000Z', close: 110 }]; // 3h later, well outside the 40min tolerance for h=1
const ctGap = mod.computeTimeOfDayTallies(ctGapBars, [1]);
check('no bar within tolerance of the h=1 target: no fabricated tally', Object.keys(ctGap).length === 0, JSON.stringify(ctGap));

const ctNearBars = [{ ts: '2026-01-01T00:00:00.000Z', close: 100 }, { ts: '2026-01-01T01:15:00.000Z', close: 105 }]; // 75min later, 15min past the h=1 target, within the 40min tolerance
const ctNear = mod.computeTimeOfDayTallies(ctNearBars, [1]);
check('a bar within the 40-min tolerance window still matches', ctNear['hour_utc_00|1'] && ctNear['hour_utc_00|1'].n === 1, JSON.stringify(ctNear));

const ctMultiBars = [{ ts: '2026-01-01T00:00:00.000Z', close: 100 }, { ts: '2026-01-01T01:00:00.000Z', close: 101 }, { ts: '2026-01-01T04:00:00.000Z', close: 104 }];
const ctMulti = mod.computeTimeOfDayTallies(ctMultiBars, [1, 4]);
check('multiple horizons tallied independently off the same before-bar', Math.abs(ctMulti['hour_utc_00|1'].sumPct - 1) < 1e-9 && Math.abs(ctMulti['hour_utc_00|4'].sumPct - 4) < 1e-9, JSON.stringify(ctMulti));

const ctUnsorted = [{ ts: '2026-01-01T01:00:00.000Z', close: 102 }, { ts: '2026-01-01T00:00:00.000Z', close: 100 }];
const ctUnsortedResult = mod.computeTimeOfDayTallies(ctUnsorted, [1]);
check('unsorted input order still computes correctly (sorts internally)', ctUnsortedResult['hour_utc_00|1'] && Math.abs(ctUnsortedResult['hour_utc_00|1'].sumPct - 2) < 1e-9, JSON.stringify(ctUnsortedResult));

const ctTwoDays = [
  { ts: '2026-01-01T00:00:00.000Z', close: 100 }, { ts: '2026-01-01T01:00:00.000Z', close: 102 }, // day 1: +2%
  { ts: '2026-01-02T00:00:00.000Z', close: 200 }, { ts: '2026-01-02T01:00:00.000Z', close: 194 }  // day 2: -3%
];
const ctTwoDaysResult = mod.computeTimeOfDayTallies(ctTwoDays, [1]);
check('accumulates n=2 across two days at the same hour-of-day slot', ctTwoDaysResult['hour_utc_00|1'].n === 2, JSON.stringify(ctTwoDaysResult['hour_utc_00|1']));
check('sumPct sums both days\' moves (2 + -3 = -1)', Math.abs(ctTwoDaysResult['hour_utc_00|1'].sumPct - (-1)) < 1e-6, ctTwoDaysResult['hour_utc_00|1'].sumPct);

check('empty input: empty tallies, not a crash', Object.keys(mod.computeTimeOfDayTallies([], [1])).length === 0);
check('a single bar with nothing to compare against: empty tallies', Object.keys(mod.computeTimeOfDayTallies([{ ts: ctBeforeTs, close: 100 }], [1])).length === 0);

console.log('\n== percentileRank: asset-relative reading, not an absolute one ==');
check('no history at all: returns null', mod.percentileRank(null, 5) === null);
check('empty history: returns null', mod.percentileRank([], 5) === null);
const sortedHistory = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
check('value below everything: 0th percentile', mod.percentileRank(sortedHistory, 0) === 0);
check('value above everything: 1.0 (100th percentile)', mod.percentileRank(sortedHistory, 11) === 1);
check('value matching the median position', mod.percentileRank(sortedHistory, 5) === 0.4, mod.percentileRank(sortedHistory, 5));

console.log('\n== positioning technique: prefers this asset\'s own funding percentile once enough history exists ==');
const fundingFixedFallback = baseMetric({ funding: 0.0009, fundingPercentile: null, chg7d: 25 }); // no history yet -> old fixed-threshold path
const fundingLowPercentileHighRaw = baseMetric({ funding: 0.0009, fundingPercentile: 0.3, chg7d: 25 }); // high in absolute terms, but unremarkable for THIS asset
const fundingHighPercentile = baseMetric({ funding: 0.0009, fundingPercentile: 0.95, chg7d: 25 });
const posFixed = findTech(mod.evaluateTechniques(fundingFixedFallback, 'crypto'), 'positioning');
const posLowPctile = findTech(mod.evaluateTechniques(fundingLowPercentileHighRaw, 'crypto'), 'positioning');
const posHighPctile = findTech(mod.evaluateTechniques(fundingHighPercentile, 'crypto'), 'positioning');
check('no percentile history yet: falls back to the fixed-threshold read (extreme positive funding)', posFixed.dir === -1, JSON.stringify(posFixed));
check('same raw funding value, but unremarkable for this asset\'s own history: does not fire crowded-longs', posLowPctile.dir === 0, JSON.stringify(posLowPctile));
check('genuinely extreme for this asset\'s own history: fires crowded-longs', posHighPctile.dir === -1, JSON.stringify(posHighPctile));

console.log('\n== openinterest technique: participation relative to this asset\'s own history, never fabricated on thin data ==');
const oiNoData = baseMetric({ funding: 0.0001, chg7d: 15 });
const oiThinOnBigMove = baseMetric({ funding: 0.0001, openInterest: 1e8, oiPercentile: 0.1, chg7d: 15 });
const oiElevatedOnRally = baseMetric({ funding: 0.0001, openInterest: 1e8, oiPercentile: 0.9, chg7d: 15 });
const oiElevatedOnSelloff = baseMetric({ funding: 0.0001, openInterest: 1e8, oiPercentile: 0.9, chg7d: -15 });
check('no OI data at all: abstains (null)', findTech(mod.evaluateTechniques(oiNoData, 'crypto'), 'openinterest').dir === null);
check('thin participation on a big move: left neutral, not fabricated into a direction', findTech(mod.evaluateTechniques(oiThinOnBigMove, 'crypto'), 'openinterest').dir === 0);
check('rally backed by elevated OI: bullish (real participation)', findTech(mod.evaluateTechniques(oiElevatedOnRally, 'crypto'), 'openinterest').dir === 1);
check('selloff with crowded OI: bearish (liquidation risk)', findTech(mod.evaluateTechniques(oiElevatedOnSelloff, 'crypto'), 'openinterest').dir === -1);

console.log('\n== impliedvol technique: DVOL/options IV percentile, contrarian, never fires without a price-extreme too ==');
const ivNoData = baseMetric({ rangePos: 0.5 });
const ivLowPercentileAtExtreme = baseMetric({ ivPercentile: 0.3, rangePos: 0.05 }); // low IV percentile, even though price IS at an extreme
const ivHighPercentileMidRange = baseMetric({ ivPercentile: 0.9, rangePos: 0.5 }); // elevated IV, but price not stretched either way
const ivHighPercentileNearLow = baseMetric({ ivPercentile: 0.9, rangePos: 0.1 });
const ivHighPercentileNearHigh = baseMetric({ ivPercentile: 0.9, rangePos: 0.9 });
check('no ivPercentile/rangePos data at all: abstains (null)', findTech(mod.evaluateTechniques(ivNoData, 'crypto'), 'impliedvol').dir === null);
check('price at an extreme but IV percentile unremarkable: neutral, not fabricated', findTech(mod.evaluateTechniques(ivLowPercentileAtExtreme, 'crypto'), 'impliedvol').dir === 0);
check('elevated IV but price mid-range: neutral (never fires on IV alone)', findTech(mod.evaluateTechniques(ivHighPercentileMidRange, 'crypto'), 'impliedvol').dir === 0);
check('elevated IV + price near a recent low: fires bullish (fear priced in, contrarian)', findTech(mod.evaluateTechniques(ivHighPercentileNearLow, 'crypto'), 'impliedvol').dir === 1);
check('elevated IV + price near a recent high: fires bearish (euphoria priced in, contrarian)', findTech(mod.evaluateTechniques(ivHighPercentileNearHigh, 'crypto'), 'impliedvol').dir === -1);
// Phase 4b: same field/technique now covers stocks too (Yahoo options-chain
// ATM IV lands in the same m.ivPercentile buildStockMetrics computes), so
// this is a data-gated technique, not a kind-gated one — a stock with
// matching IV data fires exactly like a crypto asset would.
check('stocks fire identically once they have matching IV data (data-gated, not crypto-only)', findTech(mod.evaluateTechniques(ivHighPercentileNearLow, 'stock'), 'impliedvol').dir === 1);
check('stock with no IV data yet (still bootstrapping iv_daily): abstains, same as crypto', findTech(mod.evaluateTechniques(ivNoData, 'stock'), 'impliedvol').dir === null);

console.log('\n== earningsrisk technique: neutral flag (not directional), fires only inside its own horizon window ==');
const earnNoData = baseMetric({});
const earnFarOut = baseMetric({ daysToEarnings: 20 });
const earnTomorrow = baseMetric({ daysToEarnings: 1 });
const earnToday = baseMetric({ daysToEarnings: 0.2 });
const earnAtWindowEdge = baseMetric({ daysToEarnings: 3 });
const earnJustPastWindow = baseMetric({ daysToEarnings: 3.5 });
const earnAlreadyPassed = baseMetric({ daysToEarnings: -2 }); // stale estimate, not yet rolled forward by Yahoo
check('no earnings-date data at all: abstains (null)', findTech(mod.evaluateTechniques(earnNoData, 'stock'), 'earningsrisk').dir === null);
check('earnings far outside the horizon window: abstains, not scored as a non-event', findTech(mod.evaluateTechniques(earnFarOut, 'stock'), 'earningsrisk').dir === null);
check('earnings tomorrow: fires neutral (0), flags elevated gap risk, never directional', findTech(mod.evaluateTechniques(earnTomorrow, 'stock'), 'earningsrisk').dir === 0);
check('earnings today: fires neutral (0)', findTech(mod.evaluateTechniques(earnToday, 'stock'), 'earningsrisk').dir === 0);
check('earnings right at the window edge: still fires neutral (inclusive boundary)', findTech(mod.evaluateTechniques(earnAtWindowEdge, 'stock'), 'earningsrisk').dir === 0);
check('earnings just past the window: abstains', findTech(mod.evaluateTechniques(earnJustPastWindow, 'stock'), 'earningsrisk').dir === null);
check('stale past-due estimate (negative days): abstains, not treated as imminent', findTech(mod.evaluateTechniques(earnAlreadyPassed, 'stock'), 'earningsrisk').dir === null);
check('crypto always abstains (no earnings calendar)', findTech(mod.evaluateTechniques(baseMetric({ daysToEarnings: 1 }), 'crypto'), 'earningsrisk').dir === null);
check('neutral vote dilutes conviction without asserting direction', findTech(mod.evaluateTechniques(earnTomorrow, 'stock'), 'earningsrisk').note.includes('gap risk'));

console.log('\n== evaluateTechniques wiring: ctx.reliabilityByRegime reaches reliabilityMultiplier through push(), keyed off m.structure ==');
const regimeMetric = baseMetric({ val: { upside: 20, recMean: 2, target: 120, source: 'street' }, structure: 1 }); // structure 1 -> regimeOf -> 'trending'
const withRegimeCtx = { reliabilityByRegime: { trending: { [`${regimeMetric.symbol}|valuation`]: { accuracy: 0.9, correct: 18, total: 20 } }, choppy: {} } };
const wNoRegime = findTech(mod.evaluateTechniques(regimeMetric, 'stock', {}, {}), 'valuation').w;
const wWithRegime = findTech(mod.evaluateTechniques(regimeMetric, 'stock', {}, withRegimeCtx), 'valuation').w;
check('a significant trending-regime record for this asset changes the technique weight vs. no regime data at all', wWithRegime !== wNoRegime, `${wNoRegime} vs ${wWithRegime}`);
check('the regime-boosted weight matches the expected multiplier exactly (1.1 base weight * clamp(0.5+0.9))', Math.abs(wWithRegime - 1.1 * mod.clamp(0.5 + 0.9, 0.5, 1.5)) < 1e-9, wWithRegime);

console.log('\n== sentiment technique: market-wide extremes take priority over per-asset noise ==');
const sentExtremeFear = baseMetric({});
const sentExtremeGreed = baseMetric({});
const sentPerAssetBullish = baseMetric({ sentimentScore: 0.5 });
const sentPerAssetBearish = baseMetric({ sentimentScore: -0.6 });
const sentWeakPerAsset = baseMetric({ sentimentScore: 0.1 });
const sentNothing = baseMetric({});
const sentFearOverridesBearishPerAsset = baseMetric({ sentimentScore: -0.5 }); // contradicts the market-wide read
check('crypto: market-wide extreme fear votes bullish (contrarian)', findTech(mod.evaluateTechniques(sentExtremeFear, 'crypto', undefined, { marketContext: { fearGreed: 15 } }), 'sentiment').dir === 1);
check('crypto: market-wide extreme greed votes bearish (contrarian)', findTech(mod.evaluateTechniques(sentExtremeGreed, 'crypto', undefined, { marketContext: { fearGreed: 88 } }), 'sentiment').dir === -1);
check('crypto: no market-wide extreme, strong bullish per-asset sentiment fires', findTech(mod.evaluateTechniques(sentPerAssetBullish, 'crypto', undefined, { marketContext: { fearGreed: 50 } }), 'sentiment').dir === 1);
check('crypto: no market-wide extreme, strong bearish per-asset sentiment fires', findTech(mod.evaluateTechniques(sentPerAssetBearish, 'crypto', undefined, { marketContext: { fearGreed: 50 } }), 'sentiment').dir === -1);
check('crypto: weak per-asset sentiment (below the 0.3 bar) stays neutral, not fabricated', findTech(mod.evaluateTechniques(sentWeakPerAsset, 'crypto', undefined, { marketContext: { fearGreed: 50 } }), 'sentiment').dir === 0);
check('crypto: neither market-wide nor per-asset data at all: abstains (null)', findTech(mod.evaluateTechniques(sentNothing, 'crypto', undefined, { marketContext: {} }), 'sentiment').dir === null);
check('crypto: a market-wide extreme wins even when per-asset sentiment disagrees', findTech(mod.evaluateTechniques(sentFearOverridesBearishPerAsset, 'crypto', undefined, { marketContext: { fearGreed: 15 } }), 'sentiment').dir === 1);

console.log('\n== sentiment technique (equities): VIX position, same contrarian read as elsewhere in this engine ==');
check('VIX near a recent extreme (spiking): bullish, fear already priced in', findTech(mod.evaluateTechniques(baseMetric({}), 'stock', undefined, { marketContext: { vixRangePos: 0.9 } }), 'sentiment').dir === 1);
check('VIX complacent near recent lows: bearish', findTech(mod.evaluateTechniques(baseMetric({}), 'stock', undefined, { marketContext: { vixRangePos: 0.05 } }), 'sentiment').dir === -1);
check('VIX mid-range: neutral', findTech(mod.evaluateTechniques(baseMetric({}), 'stock', undefined, { marketContext: { vixRangePos: 0.5 } }), 'sentiment').dir === 0);
check('no VIX data at all: abstains (null)', findTech(mod.evaluateTechniques(baseMetric({}), 'stock', undefined, { marketContext: {} }), 'sentiment').dir === null);

console.log('\n== compositeCall: one directional read per asset from the long/short pair ==');
check('a tie (long === short) has no falsifiable direction: null', mod.compositeCall({ long: 60, short: 60 }) === null);
check('long leading: dir 1, score is the long side', JSON.stringify(mod.compositeCall({ long: 70, short: 30 })) === JSON.stringify({ dir: 1, score: 70 }));
check('short leading: dir -1, score is the short side', JSON.stringify(mod.compositeCall({ long: 20, short: 55 })) === JSON.stringify({ dir: -1, score: 55 }));
check('no confluence result at all: null, not a crash', mod.compositeCall(null) === null);

console.log('\n== detectCallFlips: direction reversals in a symbol\'s own logged composite-call history (2026-08-22, the WLFI case -- called a bottom, then switched to breakdown risk a few hours later) ==');
const wlfiLikeRows = [
  { run_at: '2026-08-22T01:00:00Z', dir: 1, score: 62 },
  { run_at: '2026-08-22T02:00:00Z', dir: 1, score: 58 },
  { run_at: '2026-08-22T03:00:00Z', dir: 1, score: 55 },
  { run_at: '2026-08-22T06:00:00Z', dir: -1, score: 51 },
  { run_at: '2026-08-22T07:00:00Z', dir: -1, score: 49 }
];
const wlfiFlips = mod.detectCallFlips(wlfiLikeRows);
check('finds exactly the one real reversal, not the repeated same-direction rows around it', wlfiFlips.length === 1, JSON.stringify(wlfiFlips));
check('correctly identifies the direction change (bottomed/long -> breakdown-risk/short)', wlfiFlips[0].priorDir === 1 && wlfiFlips[0].newDir === -1, JSON.stringify(wlfiFlips));
check('carries the exact scores either side of the flip', wlfiFlips[0].priorScore === 55 && wlfiFlips[0].newScore === 51, JSON.stringify(wlfiFlips));
check('hoursBetween measures the real gap (03:00 -> 06:00 = 3h), not just "one row apart"', wlfiFlips[0].hoursBetween === 3, JSON.stringify(wlfiFlips));

check('no reversal at all: stable direction the whole time finds nothing', mod.detectCallFlips([
  { run_at: '2026-08-22T01:00:00Z', dir: 1, score: 60 },
  { run_at: '2026-08-22T02:00:00Z', dir: 1, score: 65 },
  { run_at: '2026-08-22T03:00:00Z', dir: 1, score: 70 }
]).length === 0);

const choppyFlips = mod.detectCallFlips([
  { run_at: '2026-08-22T01:00:00Z', dir: 1, score: 55 },
  { run_at: '2026-08-22T02:00:00Z', dir: -1, score: 52 },
  { run_at: '2026-08-22T03:00:00Z', dir: 1, score: 53 },
  { run_at: '2026-08-22T04:00:00Z', dir: -1, score: 54 }
]);
check('a genuinely whipsawing call finds every reversal, not just the first', choppyFlips.length === 3, JSON.stringify(choppyFlips));

const unsortedFlips = mod.detectCallFlips([
  { run_at: '2026-08-22T03:00:00Z', dir: -1, score: 51 },
  { run_at: '2026-08-22T01:00:00Z', dir: 1, score: 60 },
  { run_at: '2026-08-22T02:00:00Z', dir: 1, score: 58 }
]);
check('sorts chronologically internally regardless of input order', unsortedFlips.length === 1 && unsortedFlips[0].priorRunAt === '2026-08-22T02:00:00Z', JSON.stringify(unsortedFlips));

check('fewer than 2 rows: no crash, nothing to compare', mod.detectCallFlips([{ run_at: '2026-08-22T01:00:00Z', dir: 1, score: 60 }]).length === 0);
check('empty history: no crash', mod.detectCallFlips([]).length === 0);

console.log('\n== assetPredictionScore: DIRECTIONAL track record, measured against the no-skill baseline ==');
check('below MIN_RELIABILITY_SAMPLES directional outcomes: null, not a noisy guess', mod.assetPredictionScore('THIN', { 'THIN|composite': { correct: 5, total: 10 } }, {}) === null);
check('exactly one under the threshold (19 total): still null', mod.assetPredictionScore('W', { 'W|composite': { correct: 10, total: 19 } }, {}) === null);
const pooled = mod.assetPredictionScore('X', {
  'X|composite': { correct: 9, total: 10 },
  'X|reversal': { correct: 4, total: 5 },
  'X|dwell': { correct: 3, total: 5 }
}, { X: { hits: 8, total: 10 } });
// Range containment is no longer averaged in with the directional records: a
// band is BUILT to contain the price, so pooling it let containment carry the
// headline. 16/20 directional = 80, with containment reported separately.
check('pools the three DIRECTIONAL records only (16/20 = 80), never range containment', pooled && pooled.score === 80 && pooled.samples === 20, JSON.stringify(pooled));
check('reports range containment separately rather than blending it into the score', pooled && pooled.range && pooled.range.containment === 80 && pooled.range.samples === 10, JSON.stringify(pooled && pooled.range));
const rangeOnly = mod.assetPredictionScore('Y', {}, { Y: { hits: 19, total: 20 } });
check('a symbol with ONLY range containment has no directional track record: null, not a 95 that reads as prediction accuracy', rangeOnly === null, JSON.stringify(rangeOnly));
const perfect = mod.assetPredictionScore('Z', { 'Z|composite': { correct: 25, total: 25 } }, {});
check('a perfect matured record scores 100, not a lower "cautious" number', perfect && perfect.score === 100 && perfect.samples === 25, JSON.stringify(perfect));

// Baseline-relative skill: the same raw accuracy means different things in
// different classes, which is the whole point of measuring against a measured
// no-skill line rather than a flat 0.5.
const apsBaselines = { 'crypto|all': { n_up: 40, n_flat: 20, n_down: 40 }, 'stock|all': { n_up: 60, n_flat: 5, n_down: 35 } };
const cryptoSkill = mod.assetPredictionScore('C', { 'C|composite': { correct: 30, total: 50, votes_up: 50, votes_down: 0 } }, {}, 'crypto', apsBaselines);
check('crypto 60% against a 40% up-baseline is a real +20pt edge, and proven', cryptoSkill && cryptoSkill.baseline === 40 && Math.abs(cryptoSkill.edge - 20) < 0.05 && cryptoSkill.proven, JSON.stringify(cryptoSkill));
const stockSkill = mod.assetPredictionScore('S', { 'S|composite': { correct: 30, total: 50, votes_up: 50, votes_down: 0 } }, {}, 'stock', apsBaselines);
check('the SAME 60% against a 60% up-baseline is no edge at all, and not proven', stockSkill && stockSkill.baseline === 60 && Math.abs(stockSkill.edge) < 0.05 && !stockSkill.proven, JSON.stringify(stockSkill));
check('an unmeasured class falls back to 0.5 rather than inventing a baseline', mod.assetPredictionScore('U', { 'U|composite': { correct: 30, total: 50 } }, {}, 'crypto', {}).baseline === 50);

console.log('\n== noSkillBaseline / skillOverBaseline: the three-way-outcome correction ==');
check('no measured distribution: falls back to a fair coin, preserving cold-start behavior', mod.noSkillBaseline(null, 10, 10) === 0.5);
check('too few observations to trust: still falls back to 0.5', mod.noSkillBaseline({ n_up: 5, n_flat: 5, n_down: 5 }, 10, 0) === 0.5);
const bDist = { n_up: 344, n_flat: 272, n_down: 384 };
check('an always-up technique is judged against P(up), not 0.5', Math.abs(mod.noSkillBaseline(bDist, 100, 0) - 0.344) < 0.001);
check('an always-down technique is judged against P(down)', Math.abs(mod.noSkillBaseline(bDist, 0, 100) - 0.384) < 0.001);
check('an evenly-split technique gets the blend of both', Math.abs(mod.noSkillBaseline(bDist, 50, 50) - 0.364) < 0.001);
check('no recorded mix: judged against the best constant call, the hardest honest bar', Math.abs(mod.noSkillBaseline(bDist, 0, 0) - 0.384) < 0.001);
check('44% accuracy where guessing scores 38.4% is a POSITIVE edge, not "below average"', mod.skillOverBaseline(44, 100, 0.384).edge > 0);
check('52% accuracy where guessing scores 52.1% is NOT an edge', mod.skillOverBaseline(52, 100, 0.521).edge < 0);
check('a thin lucky streak has a weaker lower bound than a deep one at the same rate', mod.skillOverBaseline(6, 8, 0.4).lowerEdge < mod.skillOverBaseline(20, 25, 0.4).lowerEdge);

console.log('\n== reliabilityWeight: reduces exactly to the old formula at a 0.5 baseline ==');
check('accuracy 0.5 at the old baseline is still a neutral 1.0 weight', mod.reliabilityWeight(0.5, 50) === 1);
check('small-record half-scale response is unchanged (0.8 -> 1.3)', Math.abs(mod.reliabilityWeight(0.8, 50) - 1.3) < 1e-9);
check('deep-record response is unchanged (0.8, n=100 -> 1.5 clamped)', Math.abs(mod.reliabilityWeight(0.8, 100) - 1.5) < 1e-9);
check('at a measured 0.384 baseline, 0.384 accuracy is the new neutral point', Math.abs(mod.reliabilityWeight(0.384, 50, 0.384) - 1) < 1e-9);
check('a 44% technique is rewarded above neutral where it used to be penalised', mod.reliabilityWeight(0.44, 50, 0.384) > 1 && mod.reliabilityWeight(0.44, 50) < 1);

console.log('\n== anti-signal silencing: reliably-wrong techniques stop voting ==');
// srbreak, live: 20.5% accurate over 346 outcomes against a ~36% baseline.
check('a deep record well below its baseline is silenced, not merely halved', mod.reliabilityWeight(0.205, 346, 0.36) === 0);
check('the old floor would have kept it voting at half weight', mod.reliabilityWeight(0.205, 346, 0.36) < 0.5);
// Thin records must never be silenced — that is noise, not evidence.
check('the same accuracy on a THIN record is down-weighted but never silenced — that is noise, not evidence', (() => { const w = mod.reliabilityWeight(0.205, 40, 0.36); return w > 0 && w < 1; })(), String(mod.reliabilityWeight(0.205, 40, 0.36)));
check('slightly below baseline is down-weighted but still heard', mod.reliabilityWeight(0.33, 300, 0.36) > 0 && mod.reliabilityWeight(0.33, 300, 0.36) < 1);
check('at baseline stays neutral', Math.abs(mod.reliabilityWeight(0.36, 300, 0.36) - 1) < 1e-9);
check('above baseline is still rewarded', mod.reliabilityWeight(0.50, 300, 0.36) > 1);
// Silencing is data-driven and reverses itself if the record recovers.
check('a recovered record is no longer silenced', mod.reliabilityWeight(0.45, 346, 0.36) > 0);
check('behaviour at the old 0.5 baseline is unchanged for healthy records', Math.abs(mod.reliabilityWeight(0.8, 100) - 1.5) < 1e-9 && mod.reliabilityWeight(0.5, 50) === 1);

console.log('\n== discovery: family-corrected significance bar ==');
const disc = await import('./scripts/discovery.mjs');
check('inverse normal is accurate at the standard two-tailed 5% point', Math.abs(disc.normalQuantile(0.975) - 1.959964) < 1e-4, String(disc.normalQuantile(0.975)));
check('and at the 1% point this engine already uses elsewhere', Math.abs(disc.normalQuantile(0.995) - 2.575829) < 1e-4);
check('a single hypothesis gets the uncorrected 1% bar', Math.abs(disc.familyZBar(1) - 2.575829) < 1e-3);
// The correction is the whole defence against scanning 60 symbols.
check('60 hypotheses raise the bar from 2.58 to ~3.77', Math.abs(disc.familyZBar(60) - 3.7648) < 1e-3, String(disc.familyZBar(60)));
check('and 420 (60 symbols x 7 weekdays) raise it further still', disc.familyZBar(420) > disc.familyZBar(60));
check('the bar grows with family size, never shrinks', disc.familyZBar(500) > disc.familyZBar(100) && disc.familyZBar(100) > disc.familyZBar(10));

console.log('\n== overnight vs intraday decomposition ==');
// Two sessions: close 100 -> open 102 (overnight +2%), open 102 -> close 101.
const bars = [
  { date: '2026-01-01', open: 99, close: 100 },
  { date: '2026-01-02', open: 102, close: 101 },
  { date: '2026-01-03', open: 103, close: 104 }
];
const split = disc.overnightVsIntradaySamples(bars);
check('overnight is measured previous close -> open', Math.abs(split.overnight[0].value - 2) < 1e-9, JSON.stringify(split.overnight[0]));
check('intraday is measured open -> close', Math.abs(split.intraday[0].value - (101/102-1)*100) < 1e-9);
check('the first bar has no previous close and is skipped', split.overnight.length === 2);
check('a bar with no open is skipped rather than assumed', disc.overnightVsIntradaySamples([{ date: 'a', close: 100 }, { date: 'b', open: null, close: 101 }]).overnight.length === 0);
// Splits and bad ticks look like enormous overnight gaps.
check('an implausible >50% gap is dropped as a split or bad bar', disc.overnightVsIntradaySamples([{ date: 'a', close: 100 }, { date: 'b', open: 300, close: 301 }]).overnight.length === 0);

console.log('\n== day-of-week split ==');
const dowBars = Array.from({ length: 30 }, (_, i) => {
  const d = new Date(Date.UTC(2026, 0, 5 + i));
  return { date: d.toISOString().slice(0, 10), close: 100 + i };
});
const mon = disc.dayOfWeekSamples(dowBars, 1);
check('Monday returns are separated from every other weekday', mon.on.length > 0 && mon.off.length > 0);
check('and the two sides are disjoint and complete', mon.on.length + mon.off.length === 29);

console.log('\n== turn-of-month, conditioned on how the month actually went ==');
// A month that rises through its first 20 sessions then falls in the last 3.
const tomBars = [];
for (let d = 1; d <= 23; d++) {
  tomBars.push({ date: `2026-01-${String(d).padStart(2,'0')}`, close: d <= 20 ? 100 + d : 120 - (d - 20) * 3 });
}
// Two months: January rises through its head, February falls through its.
const tomTwo = [...tomBars];
for (let d = 1; d <= 23; d++) {
  tomTwo.push({ date: `2026-02-${String(d).padStart(2,'0')}`, close: d <= 20 ? 120 - d : 100 + (d - 20) * 3 });
}
const tomBull = disc.turnOfMonthSamples(tomTwo, 3, true);
check('the bullish month contributes its closing window to sample A', tomBull.a.length === 3);
check('and the bearish month contributes ITS closing window to sample B', tomBull.b.length === 3);
// The bug this replaced: comparing the closing window against the same
// month's head, which was selected on, guarantees a result.
check('both samples are closing-window returns, never a selected head', tomBull.a.every((p) => Number(p.date.slice(8)) > 20) && tomBull.b.every((p) => Number(p.date.slice(8)) > 20), JSON.stringify({a:tomBull.a.map(p=>p.date),b:tomBull.b.map(p=>p.date)}));
check('asking for bearish swaps which month lands in which sample', (() => { const r = disc.turnOfMonthSamples(tomTwo, 3, false); return r.a.length === 3 && r.a.every((p) => p.date.startsWith('2026-02')); })());
check('a stub month too short to have a real head is skipped entirely', disc.turnOfMonthSamples([{date:'2026-03-01',close:100},{date:'2026-03-02',close:101}], 3, true).a.length === 0);

console.log('\n== monthly returns and run-reversal ==');
const mkMonths = (vals) => {
  const bars = [];
  vals.forEach((v, i) => {
    const m = String(i + 1).padStart(2, '0');
    for (let d = 1; d <= 20; d++) bars.push({ date: `2026-${m}-${String(d).padStart(2,'0')}`, close: 100 * (1 + (v / 100) * (d - 1) / 19) });
  });
  return bars;
};
const mr = disc.monthlyReturns(mkMonths([10, -5, 8]));
check('one monthly return per month, first close to last', mr.length === 3);
check('signs match the constructed months', Math.sign(mr[0].value) === 1 && Math.sign(mr[1].value) === -1);
check('a month with too few sessions is dropped rather than annualised from noise', disc.monthlyReturns([{date:'2026-01-01',close:100},{date:'2026-01-02',close:101}]).length === 0);

const series = [-3,-2,5,-4,-1,7,1,2,-2,-3,9,-1,-2,6].map((v,i)=>({ month:`2026-${String(i+1).padStart(2,'0')}`, value:v }));
const afterTwoDown = disc.runReversalFromSeries(series, 2, true);
check('months following two consecutive down months are isolated', afterTwoDown.a.length > 0 && afterTwoDown.b.length > 0);
check('every "after" month genuinely follows two down months', afterTwoDown.a.every((p) => {
  const i = series.findIndex((m) => m.month === p.date);
  return i >= 2 && series[i-1].value < 0 && series[i-2].value < 0;
}));
check('the two sides partition the series with nothing counted twice', afterTwoDown.a.length + afterTwoDown.b.length === series.length);

console.log('\n== class composite: the month is the unit, not the symbol-month ==');
// Three near-identical coins. Pooling them would claim 3x the evidence for
// what is really one observation per month — the correlation trap.
const three = {
  A: { assetClass: 'crypto', bars: mkMonths([10, -5, 8]) },
  B: { assetClass: 'crypto', bars: mkMonths([11, -4, 9]) },
  C: { assetClass: 'crypto', bars: mkMonths([9, -6, 7]) }
};
const comp = disc.classMonthlySeries(three, 'crypto');
check('three correlated coins collapse to one series of months, not three', comp.length === 3, JSON.stringify(comp.map(c=>c.month)));
check('the composite averages within each month', Math.abs(comp[0].value - (disc.monthlyReturns(three.A.bars)[0].value + disc.monthlyReturns(three.B.bars)[0].value + disc.monthlyReturns(three.C.bars)[0].value)/3) < 1e-9);
check('a different asset class is excluded', disc.classMonthlySeries(three, 'stock').length === 0);
check('a month with too few contributing symbols is dropped', disc.classMonthlySeries({ A: three.A }, 'crypto').length === 0);

console.log('\n== out-of-sample lifecycle: the guard that makes per-symbol mining safe ==');
const entry = { discovery_effect: 0.5, status: 'provisional' };
const many = (v, n) => Array.from({ length: n }, (_, i) => ({ date: 'd' + i, value: v + (i % 3) * 0.01 }));
check('too little new data yields no verdict at all, never a guess', disc.evaluateOutOfSample(entry, { a: many(1, 5), b: many(0, 5) }).verdict === 'insufficient');
const held = disc.evaluateOutOfSample(entry, { a: many(1, 80), b: many(0, 80) });
check('a pattern still pointing the same way out-of-sample is held', held.verdict === 'held', JSON.stringify(held));
const flipped = disc.evaluateOutOfSample(entry, { a: many(0, 80), b: many(1, 80) });
check('one now pointing the OTHER way is contradicted', flipped.verdict === 'contradicted', JSON.stringify(flipped));
check('provisional is promoted only by out-of-sample evidence', disc.nextStatus('provisional', 'held') === 'confirmed');
check('inconclusive leaves status untouched rather than promoting on silence', disc.nextStatus('provisional', 'inconclusive') === 'provisional');
check('insufficient data never promotes', disc.nextStatus('provisional', 'insufficient') === 'provisional');
// The dangerous case: something already trusted that quietly stops working.
check('even a CONFIRMED finding is demoted when contradicted', disc.nextStatus('confirmed', 'contradicted') === 'decayed');

console.log('\n== live triggers: only confirmed setups, only when actually live ==');
const confirmedRun = {
  hypothesis: 'run-reversal|crypto|2|down', family: 'run-reversal', status: 'confirmed',
  asset_class: 'crypto', symbol: null, discovery_effect: 4.2, discovery_z: 3.1, discovery_n: 14,
  discovered_at: '2026-01-01T00:00:00Z', oos_n: 30
};
const downThenDown = (vals) => {
  const bars = [];
  vals.forEach((v, i) => {
    const m = String(i + 1).padStart(2, '0');
    for (let d = 1; d <= 20; d++) bars.push({ date: `2026-${m}-${String(d).padStart(2,'0')}`, close: 100 * (1 + (v / 100) * (d - 1) / 19) });
  });
  return { assetClass: 'crypto', bars };
};
// Last two closed months both negative -> setup is live.
const liveBooks = { A: downThenDown([5, -4, -3]), B: downThenDown([6, -5, -2]), C: downThenDown([4, -3, -4]) };
const fired = disc.evaluateLiveTriggers([confirmedRun], liveBooks, '2026-04-02T06:00:00Z');
check('two consecutive down months fires the reversal setup', fired.length === 1 && fired[0].kind === 'run-reversal', JSON.stringify(fired.map(f=>f.kind)));
check('the alert names the actual months, not just the rule', /2026-02/.test(fired[0].detail) && /2026-03/.test(fired[0].detail), fired[0].detail);
// Last month positive -> run broken, must not fire.
const notLive = { A: downThenDown([5, -4, 3]), B: downThenDown([6, -5, 2]), C: downThenDown([4, -3, 4]) };
check('a broken run does not fire', disc.evaluateLiveTriggers([confirmedRun], notLive, '2026-04-02T06:00:00Z').length === 0);
// The core discipline: provisional findings never alert.
check('a PROVISIONAL finding never fires a live trigger', disc.evaluateLiveTriggers([{ ...confirmedRun, status: 'provisional' }], liveBooks, '2026-04-02T06:00:00Z').length === 0);
check('a DECAYED finding never fires either', disc.evaluateLiveTriggers([{ ...confirmedRun, status: 'decayed' }], liveBooks, '2026-04-02T06:00:00Z').length === 0);

const confirmedDow = {
  hypothesis: 'day-of-week|AAPL|4', family: 'day-of-week', status: 'confirmed',
  asset_class: 'stock', symbol: 'AAPL', discovery_effect: -0.31, discovery_z: 3.9, discovery_n: 400,
  discovered_at: '2026-01-01T00:00:00Z', oos_n: 40
};
// 2026-09-03 is a Thursday.
const thu = disc.evaluateLiveTriggers([confirmedDow], {}, '2026-09-03T06:00:00Z');
check('a confirmed Thursday effect fires on a Thursday', thu.length === 1 && /Thursday/.test(thu[0].detail), JSON.stringify(thu));
check('and says which way it has historically gone', /-0.31/.test(thu[0].expectation), thu[0].expectation);
check('it does not fire on other weekdays', disc.evaluateLiveTriggers([confirmedDow], {}, '2026-09-04T06:00:00Z').length === 0);

console.log('\n== best trading hours: DST-aware slots and session labels ==');
check('a plain slot reads as its own timezone', mod.slotLabel('hour_utc_09') === '09:00 UTC');
// The whole point of exchange-local slots: name the boundary, not the offset.
check('the US close is named, not left as a bare hour', mod.slotLabel('hour_et_16') === 'NYSE close (16:00 ET)');
check('midnight ET and midnight UTC are both named', mod.slotLabel('hour_et_00') === 'midnight ET (00:00 ET)' && mod.slotLabel('hour_utc_00') === 'midnight UTC (00:00 UTC)');
check('London and Tokyo sessions are named too', mod.slotLabel('hour_ldn_08') === 'LSE open (08:00 London)' && mod.slotLabel('hour_tyo_09') === 'TSE open (09:00 Tokyo)');
check('an unnamed hour still labels cleanly', mod.slotLabel('hour_tyo_03') === '03:00 Tokyo');
check('the currently-running slot reads as 0 minutes away', mod.minutesUntilSlot('hour_utc_20', '2026-08-30T20:14:00Z') === 0);
check('later today counts down correctly', mod.minutesUntilSlot('hour_utc_20', '2026-08-30T19:40:00Z') === 20);
check('a slot already past wraps to tomorrow, never negative', mod.minutesUntilSlot('hour_utc_09', '2026-08-30T20:40:00Z') === 740);
// 16:00 ET is 20:00 UTC in summer and 21:00 UTC in winter. Resolving the
// countdown in the slot's OWN zone is what stops that being an hour wrong.
check('an ET slot resolves against New York time in summer (EDT)', mod.minutesUntilSlot('hour_et_16', '2026-07-15T19:30:00Z') === 30, String(mod.minutesUntilSlot('hour_et_16', '2026-07-15T19:30:00Z')));
check('and against New York time in winter (EST), an hour later in UTC', mod.minutesUntilSlot('hour_et_16', '2026-01-15T20:30:00Z') === 30, String(mod.minutesUntilSlot('hour_et_16', '2026-01-15T20:30:00Z')));
check('a malformed slot returns null rather than a wrong number', mod.minutesUntilSlot('dow_utc_4', '2026-08-30T20:00:00Z') === null);

// Modelled on the real measurement: BTC's strongest hour is 20:00 UTC at
// +0.045%/hr, which is REAL but smaller than a round trip.
const edgePayload = {
  todEdge: { BTC: {
    buyHour: { slot: 'hour_utc_20', n: 2532, meanPct: 0.0454, t: 3.41, winRate: 53.5, h1: 0.06, h2: 0.031 },
    sellHour: { slot: 'hour_utc_22', n: 2533, meanPct: -0.0289, t: -3.4, winRate: 47.0, h1: -0.031, h2: -0.027 }
  } },
  highAccuracy: [], crypto: { breakout: [{ symbol: 'BTC', price: 100 }] }, stocks: {}
};
const withHours = mod.attachBestHours(edgePayload, '2026-08-30T19:55:00Z');
check('attaches a best-hours read for a covered asset', !!withHours.bestHours['crypto|BTC']);
const btcH = withHours.bestHours['crypto|BTC'];
check('labels the up hour and counts down to it', btcH.buy.label === '20:00 UTC' && btcH.buy.minutesUntil === 5, JSON.stringify({l:btcH.buy.label,m:btcH.buy.minutesUntil}));
check('carries the down hour too', btcH.sell.label === '22:00 UTC');
// The honesty flag: a real edge that still loses to fees must say so.
check('a 0.045%/hr edge is correctly flagged as NOT beating a ~0.12% round trip', btcH.buy.beatsCosts === false);
check('and the assumed cost travels with it so the claim is checkable', btcH.assumedRoundTripCostPct > 0);
check('a genuinely large edge would clear the cost bar', mod.attachBestHours({ ...edgePayload, todEdge: { BTC: { buyHour: { slot: 'hour_utc_20', n: 2532, meanPct: 0.9, t: 5, winRate: 60 }, sellHour: null } } }, '2026-08-30T19:55:00Z').bestHours['crypto|BTC'].buy.beatsCosts === true);
check('no measured edge at all: payload is returned untouched', mod.attachBestHours({ crypto: {}, stocks: {} }, '2026-08-30T19:55:00Z').bestHours === undefined);

console.log('\n== best-hour alerts fire BEFORE the window, once per day ==');
const dueNow = mod.dueBestHourAlerts(withHours.bestHours, '2026-08-30T19:55:00Z', {});
check('an hour opening in 5 minutes is due', dueNow.length === 1 && dueNow[0].kind === 'buy', JSON.stringify(dueNow.map(d=>d.kind)));
check('an alert already sent today is not repeated', mod.dueBestHourAlerts(withHours.bestHours, '2026-08-30T19:55:00Z', { [dueNow[0].stateKey]: 1 }).length === 0);
check('the same window on a NEW day is due again', mod.dueBestHourAlerts(mod.attachBestHours(edgePayload, '2026-08-31T19:55:00Z').bestHours, '2026-08-31T19:55:00Z', { [dueNow[0].stateKey]: 1 }).length === 1);
check('too far ahead is not yet due', mod.dueBestHourAlerts(mod.attachBestHours(edgePayload, '2026-08-30T19:20:00Z').bestHours, '2026-08-30T19:20:00Z', {}).length === 0);
// Once the window is already running the alert is useless, so it must not fire.
check('an hour already in progress does NOT alert — too late to act on', mod.dueBestHourAlerts(mod.attachBestHours(edgePayload, '2026-08-30T20:10:00Z').bestHours, '2026-08-30T20:10:00Z', {}).length === 0);

console.log('\n== dailyRangeStatsFromRows: the median daily high-low yardstick ==');
const arch = await import('./scripts/archive.mjs');
const mkBars = (symbol, ranges) => ranges.map((r, i) => ({
  symbol, asset_class: 'crypto', date: '2026-0' + (1 + Math.floor(i / 28)) + '-' + String((i % 28) + 1).padStart(2, '0'),
  close: 100, high: 100 + r / 2, low: 100 - r / 2
}));
const steady = arch.dailyRangeStatsFromRows(mkBars('AAA', Array(40).fill(4)));
check('a steady 4%-range asset measures a 4% median', Math.abs(steady.AAA.medianRangePct - 4) < 1e-9, JSON.stringify(steady.AAA));
check('samples counts the usable bars', steady.AAA.samples === 40);
// One corrupt bar must not move the answer -- this archive has a documented
// stuck-price-then-jump defect, which is exactly why median beats mean here.
const withGlitch = arch.dailyRangeStatsFromRows(mkBars('BBB', [...Array(39).fill(4), 250]));
check('a single 250% glitch bar leaves the median at 4% (a mean would not survive it)', Math.abs(withGlitch.BBB.medianRangePct - 4) < 1e-9, JSON.stringify(withGlitch.BBB));
const implausible = arch.dailyRangeStatsFromRows(mkBars('CCC', [...Array(39).fill(4), 900]));
check('a range over the plausibility cap is dropped as missing, never clamped into the data', implausible.CCC.samples === 39);
check('p80 sits at or above the median by construction', steady.AAA.p80RangePct >= steady.AAA.medianRangePct);
const spiky = arch.dailyRangeStatsFromRows(mkBars('DDD', [...Array(32).fill(2), ...Array(8).fill(20)]));
check('an asset that usually grinds but occasionally explodes has p80 well above its median', spiky.DDD.p80RangePct > spiky.DDD.medianRangePct * 2, JSON.stringify(spiky.DDD));
check('too few usable bars: no row at all rather than a noisy guess', !arch.dailyRangeStatsFromRows(mkBars('EEE', Array(10).fill(4))).EEE);
// The HYPE case, live: CoinGecko's fallback path returns close only.
const noHL = arch.dailyRangeStatsFromRows(Array.from({ length: 40 }, (_, i) => ({ symbol: 'HYPE', asset_class: 'crypto', date: '2026-01-' + String(i + 1).padStart(2, '0'), close: 100, high: null, low: null })));
check('bars carrying no high/low produce no row, never a zero-width "never moves" range', !noHL.HYPE);
// Both cases below turned up on the first live run and would have broken things.
// A stablecoin holding its peg has no tradeable range.
const peg = arch.dailyRangeStatsFromRows(mkBars('USDX', Array(40).fill(0.08)));
check('a stablecoin-like 0.08% range is excluded, not published as a yardstick', !peg.USDX);
// Sub-cent tokens: median rounds to 0 through float precision while p80 is
// large. PEPE/SHIB/HTX/SKY were all live in exactly this state.
const subcent = arch.dailyRangeStatsFromRows(mkBars('PEPE', [...Array(32).fill(0), ...Array(8).fill(15)]));
check('a sub-cent token whose median rounds to 0 is excluded even though its p80 is 15%', !subcent.PEPE, JSON.stringify(subcent.PEPE));
check('an asset just above the floor is still published', arch.dailyRangeStatsFromRows(mkBars('FFF', Array(40).fill(0.3))).FFF !== undefined);

console.log('\n== updateSessionExtremes: session high/low tracked off the Worker cron ==');
const K = 'crypto|BTC';
let sess = mod.updateSessionExtremes(null, { crypto: { BTC: { price: 100 } }, stocks: {} }, '2026-08-30T00:05:00Z');
check('first tick of a session seeds open, high and low together', sess.bySymbol[K].open === 100 && sess.bySymbol[K].high === 100 && sess.bySymbol[K].low === 100);
sess = mod.updateSessionExtremes(sess, { crypto: { BTC: { price: 108 } } }, '2026-08-30T04:00:00Z');
sess = mod.updateSessionExtremes(sess, { crypto: { BTC: { price: 96 } } }, '2026-08-30T08:00:00Z');
check('high and low both extend as the session runs', sess.bySymbol[K].high === 108 && sess.bySymbol[K].low === 96);
check('open is pinned to the first tick, not the latest', sess.bySymbol[K].open === 100);
const rolled = mod.updateSessionExtremes(sess, { crypto: { BTC: { price: 96 } } }, '2026-08-31T00:02:00Z');
check('a new UTC date rolls the session rather than carrying yesterday forward', rolled.date === '2026-08-31' && rolled.bySymbol[K].open === 96 && rolled.bySymbol[K].high === 96);
check('a non-numeric tick is ignored rather than poisoning the extremes', mod.updateSessionExtremes(sess, { crypto: { BTC: { price: null } } }, '2026-08-30T09:00:00Z').bySymbol[K].high === 108);
// The live price fetch routinely misses symbols (rate limits, thin ids, Yahoo
// hiccups). A tick that omits a symbol must not reset the day's extremes.
const partial = mod.updateSessionExtremes(sess, { crypto: { ETH: { price: 50 } } }, '2026-08-30T10:00:00Z');
check('a symbol missing from this tick keeps its accumulated session extremes', partial.bySymbol[K] && partial.bySymbol[K].high === 108 && partial.bySymbol[K].low === 96, JSON.stringify(partial.bySymbol[K]));
check('and a newly-seen symbol still gets seeded', partial.bySymbol['crypto|ETH'].open === 50);

// The DASH case, live: Dash the crypto (~$41) and DoorDash the equity (~$237)
// arrive in the SAME tick under the same ticker. Keying by bare symbol merged
// them into one asset whose session ran $237 -> $41, produced a -82% "move",
// and fired a candidate LONG on an equity that had barely moved.
const collide = mod.updateSessionExtremes(null, { crypto: { DASH: { price: 41.68 } }, stocks: { DASH: { price: 236.74 } } }, '2026-08-30T00:05:00Z');
check('a ticker shared across asset classes is tracked as two separate assets', collide.bySymbol['crypto|DASH'].open === 41.68 && collide.bySymbol['stock|DASH'].open === 236.74, JSON.stringify(collide.bySymbol));
check('and neither one absorbs the other price as a session extreme', collide.bySymbol['crypto|DASH'].high === 41.68 && collide.bySymbol['stock|DASH'].low === 236.74);

console.log('\n== dayRangeSignal: has it moved enough today to fade? ==');
const stats = { BTC: { medianPct: 4, p80Pct: 6, samples: 90 } };
const quiet = mod.dayRangeSignal('BTC', 100.5, { open: 100, high: 101, low: 99.8 }, stats, {});
check('a normal-sized move is not an entry', quiet.entry === null && quiet.state !== 'extended-up');
check('median range is reported in price terms at the current price, for sizing', Math.abs(quiet.medianAbs - 100.5 * 0.04) < 1e-9);
// +7% with a 6% p80 bar, sitting at the top of the day's range.
const stretched = mod.dayRangeSignal('BTC', 107, { open: 100, high: 107, low: 99 }, stats, { rsi: 78, volRatio: 2.1 });
check('a move past p80 while pinned near the day high reads as extended-up', stretched.state === 'extended-up');
check('and yields a candidate SHORT', stretched.entry && stretched.entry.side === 'short', JSON.stringify(stretched.entry));
check('carrying its confirmations, not just a bare call', stretched.entry.reasons.length >= 2);
check('never marked proven — it has no scored track record', stretched.entry.proven === false);
check('reports the move as a multiple of a normal day', Math.abs(stretched.moveInMedians - 1.75) < 1e-9);
// Same stretch, but the price has already come back off the high.
const faded = mod.dayRangeSignal('BTC', 103, { open: 100, high: 107, low: 99 }, stats, { rsi: 78, volRatio: 2.1 });
check('extended but no longer near the extreme: no entry (the fade already happened)', faded.entry === null);
const down = mod.dayRangeSignal('BTC', 93, { open: 100, high: 101, low: 93 }, stats, { rsi: 22, volRatio: 1.8 });
check('the symmetric down case yields a candidate LONG', down.state === 'extended-down' && down.entry.side === 'long', JSON.stringify(down.entry));
// Confirmation discipline: stretched alone is not enough.
const noConfirm = mod.dayRangeSignal('BTC', 107, { open: 100, high: 107, low: 99 }, stats, { rsi: 55, volRatio: 0.9 });
check('stretched with nothing confirming it does NOT fire — same never-fire-alone rule as every other technique', noConfirm.state === 'extended-up' && noConfirm.entry === null);
check('an asset with no measured range abstains entirely', mod.dayRangeSignal('ZZZ', 100, { open: 100, high: 101, low: 99 }, stats, {}) === null);
check('too few samples abstains', mod.dayRangeSignal('X', 100, { open: 100, high: 101, low: 99 }, { X: { medianPct: 4, p80Pct: 6, samples: 5 } }, {}) === null);
// Second line of defence. With a zero median, `bar` used to fall back to 0 and
// EVERY positive move read as extended-up — a false-alert generator. HTX, SKY
// and UST2Y were all live in that state.
check('a zero median range abstains rather than making every move look extended', mod.dayRangeSignal('HTX', 101, { open: 100, high: 101, low: 100 }, { HTX: { medianPct: 0, p80Pct: 0, samples: 90 } }, { rsi: 75 }) === null);
check('a zero median with a large p80 (the sub-cent precision case) also abstains', mod.dayRangeSignal('PEPE', 101, { open: 100, high: 101, low: 100 }, { PEPE: { medianPct: 0, p80Pct: 16.7, samples: 90 } }, { rsi: 75 }) === null);
check('a peg-tight median abstains', mod.dayRangeSignal('GHO', 100.5, { open: 100, high: 100.5, low: 100 }, { GHO: { medianPct: 0.09, p80Pct: 0.26, samples: 90 } }, { rsi: 75 }) === null);
// The exact live failure: a -82% "move" (19.98x a normal day) offered a
// candidate LONG. A move this size is either bad data or a real dislocation,
// and neither is something to mean-revert into.
const dislocated = mod.dayRangeSignal('DASH', 41.68, { open: 236.74, high: 236.74, low: 41.68 }, { DASH: { medianPct: 4.12, p80Pct: 5.31, samples: 90 } }, { volRatio: 1.9 });
check('a move far beyond any plausible session is marked dislocated', dislocated.state === 'dislocated', JSON.stringify({ state: dislocated.state, moveInMedians: dislocated.moveInMedians }));
check('and offers NO entry — you do not fade a dislocation', dislocated.entry === null);
check('while still reporting the numbers so the anomaly is visible, not hidden', Math.abs(dislocated.moveInMedians) > 8);
const bigButReal = mod.dayRangeSignal('BTC', 93, { open: 100, high: 101, low: 93 }, { BTC: { medianPct: 4, p80Pct: 6, samples: 90 } }, { rsi: 22 });
check('a large-but-plausible move still trades normally', bigButReal.state === 'extended-down' && bigButReal.entry.side === 'long');
check('no session data yet abstains', mod.dayRangeSignal('BTC', 100, null, stats, {}) === null);

console.log('\n== dayTradingUniverse / indexBoardRows ==');
// highAccuracy rows always carry asset_class in the real payload (see
// highAccuracyFor in buildPayload) — a row without one cannot be
// class-qualified and is deliberately skipped rather than guessed at.
const dtPayload = { highAccuracy: [{ symbol: 'AAVE', asset_class: 'crypto' }, { symbol: 'NVDA', asset_class: 'stock' }], crypto: { breakout: [{ symbol: 'BTC', rsi: 70 }] }, stocks: { breakout: [{ symbol: 'AAPL', rsi: 40 }] } };
const uni = mod.dayTradingUniverse(dtPayload);
check('covers the always-tracked favorites, class-qualified', uni.has('crypto|BTC') && uni.has('crypto|HYPE'));
check('plus anything with a proven track record, under its own class', uni.has('crypto|AAVE'));
check('an equity with a proven record lands under the stock class', uni.has('stock|NVDA') && !uni.has('crypto|NVDA'));
check('and nothing else', !uni.has('crypto|DOGE'));
check('a track-record row with no asset_class is skipped, not guessed into a class', !mod.dayTradingUniverse({ highAccuracy: [{ symbol: 'ZZZ' }] }).has('crypto|ZZZ'));
const idx = mod.indexBoardRows(dtPayload);
check('board rows are indexed per asset class, so a shared ticker cannot cross wires', idx['crypto|BTC'].rsi === 70 && idx['stock|AAPL'].rsi === 40);
const collideIdx = mod.indexBoardRows({ crypto: { breakout: [{ symbol: 'DASH', rsi: 20 }] }, stocks: { breakout: [{ symbol: 'DASH', rsi: 80 }] } });
check('DASH resolves to two distinct rows, not first-writer-wins', collideIdx['crypto|DASH'].rsi === 20 && collideIdx['stock|DASH'].rsi === 80);

console.log('\n== buildScalpView: only what has actually been measured ==');
const scalpPayload = {
  generated_at: '2026-08-31T00:00:00Z',
  dailyRange: { BTC: { medianPct: 4, p80Pct: 6, samples: 90 } },
  todEdge: { BTC: { buyHour: { slot: 'hour_et_16', n: 2533, meanPct: 0.067, t: 5.32, winRate: 54.9 }, sellHour: null } },
  highAccuracy: [],
  crypto: { breakout: [{ symbol: 'BTC', price: 107, rsi: 78, volRatio: 2.1 }] },
  stocks: {}
};
const scalpLive = { crypto: { BTC: { price: 107 } }, stocks: {}, generated_at: '2026-08-31T00:04:00Z' };
const scalpSession = { date: '2026-08-31', bySymbol: { 'crypto|BTC': { open: 100, high: 107, low: 99 } } };
const view = mod.buildScalpView(scalpPayload, scalpLive, scalpSession, '2026-08-31T00:05:00Z');
check('produces a day-trading view', view && view.assets.length === 1, JSON.stringify(view && view.assets && view.assets.length));
const a = view.assets[0];
check('carries the live price, not the build price', a.price === 107);
check('carries the range-exhaustion read', a.range && a.range.state === 'extended-up');
check('and a candidate entry with its confirmations', a.range.entry && a.range.entry.side === 'short' && a.range.entry.reasons.length >= 2);
check('carries the proven hour window', a.hours && a.hours.buy && a.hours.buy.label === 'NYSE close (16:00 ET)');
// The point of the rewrite: no invented direction call.
check('states its basis rather than implying a forecast', /no unvalidated direction call/.test(view.basis));
check('reports how fresh the prices actually are', view.prices_generated_at === '2026-08-31T00:04:00Z');
// An asset with nothing measured must not appear at all.
const bare = mod.buildScalpView({ ...scalpPayload, dailyRange: null, todEdge: null }, scalpLive, scalpSession, '2026-08-31T00:05:00Z');
check('an asset with no measured range and no imminent window is omitted entirely', bare === null, JSON.stringify(bare));
// Ordering: actionable first.
const twoAssets = mod.buildScalpView(
  { ...scalpPayload,
    dailyRange: { BTC: { medianPct: 4, p80Pct: 6, samples: 90 }, ETH: { medianPct: 4, p80Pct: 6, samples: 90 } },
    crypto: { breakout: [{ symbol: 'BTC', price: 107, rsi: 78, volRatio: 2.1 }, { symbol: 'ETH', price: 100.5 }] } },
  { crypto: { BTC: { price: 107 }, ETH: { price: 100.5 } }, stocks: {}, generated_at: '2026-08-31T00:04:00Z' },
  { date: '2026-08-31', bySymbol: { 'crypto|BTC': { open: 100, high: 107, low: 99 }, 'crypto|ETH': { open: 100, high: 101, low: 100 } } },
  '2026-08-31T00:05:00Z');
check('an asset with a live entry candidate sorts above a quiet one', twoAssets.assets[0].symbol === 'BTC', JSON.stringify(twoAssets.assets.map(x=>x.symbol)));

console.log('\n== mergeLivePrices: fresh price layer over a slow model layer ==');
const basePayload = {
  generated_at: '2026-08-28T22:36:16Z',
  crypto: { breakout: [{ symbol: 'BTC', price: 100, chg24h: 1, score: 70, dir: 1, rangeBounds: { low: 50, high: 150 } }], universe: 1 },
  stocks: { breakout: [{ symbol: 'AAPL', price: 200, chg24h: 2, score: 60, dir: -1 }], universe: 1 }
};
const liveLayer = { crypto: { BTC: { price: 120, chg24h: 5 } }, stocks: {}, generated_at: '2026-08-29T02:30:00Z' };
const mergedPayload = mod.mergeLivePrices(basePayload, liveLayer);
check('replaces the price with the freshly ticked one', mergedPayload.crypto.breakout[0].price === 120);
check('replaces chg24h alongside it', mergedPayload.crypto.breakout[0].chg24h === 5);
check('recomputes rangePos honestly against the build’s own bounds', Math.abs(mergedPayload.crypto.breakout[0].rangePos - 0.7) < 1e-9);
check('never touches model-computed fields (score, dir)', mergedPayload.crypto.breakout[0].score === 70 && mergedPayload.crypto.breakout[0].dir === 1);
check('leaves rows with no live tick exactly as the build left them', mergedPayload.stocks.breakout[0].price === 200 && mergedPayload.stocks.breakout[0].chg24h === 2);
check('keeps the model layer’s own timestamp untouched', mergedPayload.generated_at === basePayload.generated_at);
check('reports when the displayed prices were actually refreshed', mergedPayload.prices_generated_at === '2026-08-29T02:30:00Z');
check('no live layer at all: returns the payload unchanged rather than degrading it', mod.mergeLivePrices(basePayload, null) === basePayload);
check('an empty live layer is also a no-op', mod.mergeLivePrices(basePayload, { generated_at: 'x' }) === basePayload);
check('preserves non-array sections like universe counts', mergedPayload.crypto.universe === 1);

console.log('\n== live price layer: KV lifetime is separate from the freshness window ==');
// These were one number, and it silently defeated the whole layer: the cron
// writes every 5 minutes but the value expired after 60 seconds, so for ~4
// minutes in 5 /api/signals had nothing to merge and served build prices.
check('a just-written layer is fresh enough to serve directly', mod.isLivePriceFresh({ generated_at: new Date().toISOString() }));
check('a 90-second-old layer is no longer fresh, so the request path refetches', !mod.isLivePriceFresh({ generated_at: new Date(Date.now() - 90 * 1000).toISOString() }));
check('but it still EXISTS to be merged — staleness is not the same as absence', mod.mergeLivePrices(basePayload, { crypto: { BTC: { price: 120 } }, generated_at: new Date(Date.now() - 90 * 1000).toISOString() }).crypto.breakout[0].price === 120);
check('a layer with no timestamp is never treated as fresh', !mod.isLivePriceFresh({ crypto: {} }));
check('a missing layer is not fresh', !mod.isLivePriceFresh(null));

console.log('\n== assetClassSkill / abstainBoards: publish a class only while it earns it ==');
const skillBaselines = { 'crypto|all': { n_up: 405, n_flat: 169, n_down: 425 }, 'stock|all': { n_up: 521, n_flat: 52, n_down: 427 } };
// Modelled on the live figures: crypto clears its baseline decisively, stocks
// sit below a constant call.
const cryptoCal = { 'crypto|1|24|8': { correct: 77, total: 97 }, 'crypto|1|168|7': { correct: 229, total: 382 } };
const cryptoVerdict = mod.assetClassSkill(cryptoCal, skillBaselines, 'crypto');
check('crypto is measured as having a real edge over its own baseline', cryptoVerdict && cryptoVerdict.edge > 0 && cryptoVerdict.proven, JSON.stringify(cryptoVerdict));
const stockCal = { 'stock|1|168|7': { correct: 99, total: 188 }, 'stock|-1|168|6': { correct: 52, total: 172 } };
const stockVerdict = mod.assetClassSkill(stockCal, skillBaselines, 'stock');
check('stocks are measured as NOT clearing their baseline', stockVerdict && stockVerdict.edge < 0 && !stockVerdict.proven, JSON.stringify(stockVerdict));
check('too little evidence to judge a class: null, not a verdict', mod.assetClassSkill({ 'crypto|1|24|8': { correct: 5, total: 10 } }, skillBaselines, 'crypto') === null);

const boards = { breakout: [{ symbol: 'A', dir: 1, score: 80, price: 10 }], breakdown: [{ symbol: 'B', dir: -1, score: 75 }], universe: 2 };
const kept = mod.abstainBoards(boards, cryptoVerdict);
check('a class with proven skill publishes its directional calls untouched', kept === boards && kept.breakout[0].dir === 1);
const abstained = mod.abstainBoards(boards, stockVerdict);
check('a class that failed its baseline has the direction stripped', abstained.breakout[0].dir === 0 && abstained.breakdown[0].dir === 0);
check('abstaining explains itself rather than silently blanking', abstained.breakout[0].abstained && abstained.breakout[0].abstained.reason === 'no-demonstrated-edge');
check('abstaining keeps every descriptive field intact', abstained.breakout[0].score === 80 && abstained.breakout[0].price === 10);
check('abstaining preserves non-array sections', abstained.universe === 2);
// The cold-start case: no verdict yet must NOT mean "suppress everything", or a
// fresh database would render an entirely blank dashboard.
check('no measured verdict yet: publishes as before rather than blanking the board', mod.abstainBoards(boards, null) === boards);

console.log('\n== currentSignalConfidence: conservative, horizon-matched current-call confidence ==');
check('no empirical support at all: returns null rather than inventing confidence from a raw score alone', mod.currentSignalConfidence({ symbol: 'X', asset_class: 'crypto', dir: 1, score: 90, agree: 7, total: 10, horizon: { days: 1, basis: 'methodology' }, range: { basis: 'methodology' } }, {}, null) === null);
const confBlended = mod.currentSignalConfidence(
  { symbol: 'X', asset_class: 'crypto', dir: 1, score: 84, agree: 7, total: 10, horizon: { days: 1, basis: 'historical' }, range: { basis: 'historical' } },
  {
    pooled: { 8: { correct: 72, total: 100, accuracy: 0.72 } },
    detailed: { 'crypto|1|24|8': { correct: 29, total: 30, accuracy: 29 / 30 } }
  },
  { correct: 45, total: 50 }
);
check('prefers the matching asset-class/direction/horizon calibration once it has enough samples', confBlended && confBlended.calibration && confBlended.calibration.source === 'asset-class-direction-horizon', JSON.stringify(confBlended));
check('uses a conservative lower estimate rather than the raw blended hit rate', confBlended && confBlended.estimatedWinRate < confBlended.rawEstimatedWinRate && confBlended.estimatedWinRate >= 0.68, JSON.stringify(confBlended));
check('strong matching empirical support plus historical basis: actionable', confBlended && confBlended.actionable === true, JSON.stringify(confBlended));
const confWeakAgreement = mod.currentSignalConfidence(
  { symbol: 'X', asset_class: 'crypto', dir: 1, score: 84, agree: 2, total: 10, horizon: { days: 1, basis: 'historical' }, range: { basis: 'historical' } },
  {
    pooled: { 8: { correct: 72, total: 100, accuracy: 0.72 } },
    detailed: { 'crypto|1|24|8': { correct: 29, total: 30, accuracy: 29 / 30 } }
  },
  { correct: 45, total: 50 }
);
check('weak current agreement blocks an alert even with decent history', confWeakAgreement && confWeakAgreement.actionable === false, JSON.stringify(confWeakAgreement));
const confCalibrationOnly = mod.currentSignalConfidence(
  { symbol: 'X', asset_class: 'stock', dir: -1, score: 91, agree: 7, total: 10, horizon: { days: 7, basis: 'methodology' }, range: { basis: 'methodology' } },
  { 9: { correct: 110, total: 120, accuracy: 110 / 120 } },
  null
);
check('very strong bucket calibration alone can still qualify a top-end score', confCalibrationOnly && confCalibrationOnly.actionable === true, JSON.stringify(confCalibrationOnly));
const confThinAssetRecord = mod.currentSignalConfidence(
  { symbol: 'X', asset_class: 'crypto', dir: 1, score: 84, agree: 7, total: 10, horizon: { days: 1, basis: 'historical' }, range: { basis: 'historical' } },
  {},
  { correct: 16, total: 20 }
);
check('a raw 80% record with only 20 outcomes does not clear the conservative alert bar', confThinAssetRecord && confThinAssetRecord.actionable === false && confThinAssetRecord.estimatedWinRate < 0.68, JSON.stringify(confThinAssetRecord));
check('lowerConfidenceBound is below the raw rate for finite evidence, not a fabricated certainty', mod.lowerConfidenceBound(45, 50) < 0.9 && mod.lowerConfidenceBound(45, 50) > 0.68, mod.lowerConfidenceBound(45, 50));

console.log('\n== api: KV populated by the "Action" (mirrors what build-signals.mjs writes) ==');
const warmEnv = { FCS_CACHE: new MockKV() };
await warmEnv.FCS_CACHE.put(mod.CACHE_KEY, JSON.stringify(built));
const warm = await worker.fetch(new Request('https://x.com/signals/api/signals'), warmEnv, ctx);
check('warm marked hit', warm.headers.get('x-fcs-cache') === 'hit', warm.headers.get('x-fcs-cache'));
const warmBody = await warm.json();
check('warm returns the stored payload', warmBody.generated_at === built.generated_at);

console.log('\n== api: stale KV (Action missed a cycle) still serves, just flagged ==');
const staleEnv = { FCS_CACHE: new MockKV() };
await staleEnv.FCS_CACHE.put(mod.CACHE_KEY, JSON.stringify({ ...built, generated_at: new Date(Date.now() - 3 * 3600 * 1000).toISOString() }));
const stale = await worker.fetch(new Request('https://x.com/signals/api/signals'), staleEnv, ctx);
check('serves stale cache, marked "stale"', stale.headers.get('x-fcs-cache') === 'stale', stale.headers.get('x-fcs-cache'));
check('stale response body still has real data', (await stale.json()).crypto.breakout.length > 0);

console.log('\n== api: /api/intraday — day-trading signal, separate KV key, no leverage/liquidation/sizing fields ==');
const intradayEmptyEnv = { FCS_CACHE: new MockKV() };
const intradayEmpty = await worker.fetch(new Request('https://x.com/signals/api/intraday'), intradayEmptyEnv, ctx);
check('no tick yet: still 200 with an error body, not a crash', intradayEmpty.status === 200 && typeof (await intradayEmpty.json()).error === 'string');

const intradayPayload = {
  generated_at: new Date().toISOString(),
  watchlist: [
    { symbol: 'BTC', assetClass: 'crypto', price: 65000, dir: 1, peaked: false, bottomed: false, horizonMinutes: 15, horizonLabel: '15m', basis: 'methodology', confidence: null }
  ],
  trackRecord: { crypto: { wins: 6, losses: 4, total: 10, winRate: 0.6, avgReturnPct: 3.2 } }
};
const intradayWarmEnv = { FCS_CACHE: new MockKV() };
await intradayWarmEnv.FCS_CACHE.put(mod.INTRADAY_CACHE_KEY, JSON.stringify(intradayPayload));
const intradayWarm = await worker.fetch(new Request('https://x.com/signals/api/intraday'), intradayWarmEnv, ctx);
check('warm marked hit', intradayWarm.headers.get('x-fcs-cache') === 'hit', intradayWarm.headers.get('x-fcs-cache'));
const intradayBody = await intradayWarm.json();
check('returns the stored watchlist', intradayBody.watchlist.length === 1 && intradayBody.watchlist[0].symbol === 'BTC');
const intradayBodyStr = JSON.stringify(intradayBody).toLowerCase();
check('no leverage field anywhere in the served payload', !intradayBodyStr.includes('leverage'));
check('no liquidation field anywhere in the served payload', !intradayBodyStr.includes('liquidat'));
check('no position-size/margin field anywhere in the served payload', !intradayBodyStr.includes('margin') && !intradayBodyStr.includes('positionsize') && !intradayBodyStr.includes('position_size'));

const intradayStaleEnv = { FCS_CACHE: new MockKV() };
await intradayStaleEnv.FCS_CACHE.put(mod.INTRADAY_CACHE_KEY, JSON.stringify({ ...intradayPayload, generated_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() }));
const intradayStale = await worker.fetch(new Request('https://x.com/signals/api/intraday'), intradayStaleEnv, ctx);
check('stale (past the 45min intraday freshness window) marked stale', intradayStale.headers.get('x-fcs-cache') === 'stale', intradayStale.headers.get('x-fcs-cache'));

console.log('\n== api: live prices (between-build ticks, real fetch, symbols only from KV) ==');
const pricesEmptyEnv = { FCS_CACHE: new MockKV() };
const pricesEmpty = await worker.fetch(new Request('https://x.com/signals/api/prices'), pricesEmptyEnv, ctx);
check('no build yet: still 200 with an error body, not a crash', pricesEmpty.status === 200 && typeof (await pricesEmpty.json()).error === 'string');

const pricesEnv = { FCS_CACHE: new MockKV() };
await pricesEnv.FCS_CACHE.put(mod.CACHE_KEY, JSON.stringify(built));
const pricesResp = await worker.fetch(new Request('https://x.com/signals/api/prices'), pricesEnv, ctx);
check('live prices route never browser/CDN-cached (always no-store)', pricesResp.headers.get('cache-control') === 'no-store', pricesResp.headers.get('cache-control'));
check('first call is a live-price cache miss (nothing cached yet)', pricesResp.headers.get('x-fcs-live-cache') === 'miss', pricesResp.headers.get('x-fcs-live-cache'));
const pricesBody = await pricesResp.json();
const displayedCryptoSymbols = new Set(built.crypto.breakout.concat(built.crypto.breakdown).map(r => r.symbol));
const displayedStockSymbols = new Set(built.stocks.breakout.concat(built.stocks.breakdown).map(r => r.symbol));
check('crypto live prices keyed by ticker symbol, not CoinGecko id', [...displayedCryptoSymbols].some(sym => pricesBody.crypto[sym] && typeof pricesBody.crypto[sym].price === 'number'));
const solRow = built.crypto.breakout.concat(built.crypto.breakdown).find(r => r.symbol === 'SOL');
check('a coin with no live quote (solana, not in the CoinGecko fixture) falls back to the hourly build\'s own price rather than a gap', !!solRow && pricesBody.crypto.SOL && pricesBody.crypto.SOL.price === solRow.price);
check('stock live prices keyed by symbol with numeric price + chg24h', [...displayedStockSymbols].every(sym => pricesBody.stocks[sym] && typeof pricesBody.stocks[sym].price === 'number' && typeof pricesBody.stocks[sym].chg24h === 'number'));

console.log('\n== api: live prices split across two providers (Binance.US + CoinGecko), see binanceUsTradablePairs ==');
check('build-time Binance.US discovery only counts actively-trading USDT pairs, not a BUSD-quoted one', built.binanceUsSymbols.includes('BTC') && built.binanceUsSymbols.includes('ETH') && !built.binanceUsSymbols.includes('LINK'), JSON.stringify(built.binanceUsSymbols));
check('health flags whether the Binance.US discovery call actually succeeded', built.health.binance_us === true);
if (pricesBody.crypto.BTC) check('BTC live price came from the Binance.US ticker fixture, not CoinGecko\'s', pricesBody.crypto.BTC.price === 64000.5, JSON.stringify(pricesBody.crypto.BTC));
if (pricesBody.crypto.LINK) check('LINK (no Binance.US pair in this fixture) still resolves via the CoinGecko fallback path', typeof pricesBody.crypto.LINK.price === 'number', JSON.stringify(pricesBody.crypto.LINK));

console.log('\n== api: live prices, second call within the window reuses the cache (CoinGecko/Yahoo rate-limit guard) ==');
const pricesResp2 = await worker.fetch(new Request('https://x.com/signals/api/prices'), pricesEnv, ctx);
check('second call within the TTL is a cache hit', pricesResp2.headers.get('x-fcs-live-cache') === 'hit', pricesResp2.headers.get('x-fcs-live-cache'));
const pricesBody2 = await pricesResp2.json();
check('cache hit serves the identical previously-fetched body (same generated_at)', pricesBody2.generated_at === pricesBody.generated_at);
check('response never leaks a raw CoinGecko id key', Object.keys(pricesBody.crypto).every(k => displayedCryptoSymbols.has(k)));

console.log('\n== techniqueBreakdown: every technique\'s own accuracy for one asset, not just the best ==');
const breakdownReliability = {
  'BTC|rsi': { correct: 18, accuracy: 0.9, total: 20 },
  'BTC|macd': { correct: 8, accuracy: 0.4, total: 20 },
  'BTC|momentum': { correct: 5, accuracy: 0.5, total: 10 } // below MIN_RELIABILITY_SAMPLES(20) -> excluded
};
const breakdownByHorizon = { 24: { 'BTC|rsi': { correct: 19, total: 20 } }, 168: { 'BTC|rsi': { correct: 12, total: 20 } } };
const breakdown = mod.techniqueBreakdown(breakdownReliability, breakdownByHorizon, 'BTC');
check('includes every technique with enough samples, not just the top one', breakdown.some(t => t.id === 'rsi') && breakdown.some(t => t.id === 'macd'), JSON.stringify(breakdown));
check('excludes a technique below MIN_RELIABILITY_SAMPLES', !breakdown.some(t => t.id === 'momentum'));
check('sorted by accuracy, best first', breakdown[0].id === 'rsi' && breakdown[0].accuracy === 0.9);
check('carries the measured per-horizon split (an empirically-measured leading/lagging read) when it exists', breakdown[0].byHorizon && breakdown[0].byHorizon[24].accuracy === 0.95 && breakdown[0].byHorizon[168].accuracy === 0.6, JSON.stringify(breakdown[0]));
check('a technique with no per-horizon data at MIN_RELIABILITY_SAMPLES omits byHorizon rather than fabricating it', breakdown.find(t => t.id === 'macd').byHorizon === undefined);
check('empty input: empty array, not an error', mod.techniqueBreakdown(null, null, 'BTC').length === 0);

console.log('\n== api: /api/asset/:symbol — per-asset drill-down, a deliberate narrow exception to "Worker only reads KV" ==');
// 35 snapshot rows, not 2: the drift calc compares the trailing 30 against
// the full history, so a fixture with 30 or fewer rows can never show any
// drift at all (both windows would be identical) — this needs to exceed
// 30 to actually exercise "recent window differs from all-time."
const snapshotRows = [];
for (let i = 0; i < 30; i++) snapshotRows.push({ symbol: 'BTC', snapshot_date: `2026-08-${String(30 - i).padStart(2, '0')}`, score: 96, samples: 40 }); // 30 recent days at 96
for (let i = 0; i < 5; i++) snapshotRows.push({ symbol: 'BTC', snapshot_date: `2026-06-${String(25 - i).padStart(2, '0')}`, score: 50, samples: 20 }); // 5 older days at 50, pulling the all-time average down
const expectedRecentAvg = 96;
const expectedAllTimeAvg = (30 * 96 + 5 * 50) / 35;
const expectedDrift = Math.round(expectedRecentAvg - expectedAllTimeAvg);
const assetSeed = {
  technique_reliability: [
    { symbol: 'BTC', technique_id: 'rsi', horizon_hours: 24, correct: 19, total: 20, accuracy: 0.95 },
    { symbol: 'BTC', technique_id: 'macd', horizon_hours: 168, correct: 8, total: 20, accuracy: 0.4 }
  ],
  range_reliability: [{ symbol: 'BTC', horizon_hours: 24, hits: 18, total: 20, accuracy: 0.9 }],
  asset_score_snapshots: snapshotRows
};
const d1Env = { FCS_CACHE: new MockKV(), FCS_DB: new MockD1(assetSeed) };
const assetResp = await worker.fetch(new Request('https://x.com/signals/api/asset/btc'), d1Env, ctx);
const assetBody = await assetResp.json();
check('200 with the requested symbol uppercased', assetResp.status === 200 && assetBody.symbol === 'BTC', JSON.stringify(assetBody));
check('carries every technique for this symbol, not just the best one', assetBody.techniques.length === 2, JSON.stringify(assetBody.techniques));
check('a known technique_id carries its TECHNIQUE_META leading/lagging classification', assetBody.techniques.find(t => t.id === 'rsi').leading === true);
check('range-prediction hit rate present', assetBody.range.length === 1 && assetBody.range[0].hits === 18);
check('score history present, most-recent-first', assetBody.scoreHistory.length === 35 && assetBody.scoreHistory[0].date === '2026-08-30');
check('drift computed correctly: recent-30 average vs. the full all-time average', assetBody.drift === expectedDrift, `got ${assetBody.drift}, expected ${expectedDrift}`);

const noD1Resp = await worker.fetch(new Request('https://x.com/signals/api/asset/BTC'), emptyEnv, ctx);
const noD1Body = await noD1Resp.json();
check('D1 not bound: graceful message, not a crash', noD1Resp.status === 200 && typeof noD1Body.error === 'string', JSON.stringify(noD1Body));

const unknownSymbolResp = await worker.fetch(new Request('https://x.com/signals/api/asset/NOPE'), d1Env, ctx);
const unknownSymbolBody = await unknownSymbolResp.json();
check('unknown symbol: empty arrays, not an error (no data yet, not a failure)', unknownSymbolBody.techniques.length === 0 && unknownSymbolBody.range.length === 0 && unknownSymbolBody.drift === null, JSON.stringify(unknownSymbolBody));

console.log('\n== api: /api/asset/:symbol is rate-limited per IP (marginal defense-in-depth only — see the code comment on why the real fix is a zone-level Cloudflare rule) ==');
const rlRequest = (ip) => new Request('https://x.com/signals/api/asset/BTC', { headers: { 'CF-Connecting-IP': ip } });
let lastRlResp;
for (let i = 0; i < 40; i++) lastRlResp = await worker.fetch(rlRequest('203.0.113.5'), d1Env, ctx);
check('the 40th request from one IP within the window still succeeds', lastRlResp.status === 200, lastRlResp.status);
const rl41st = await worker.fetch(rlRequest('203.0.113.5'), d1Env, ctx);
check('the 41st request from the same IP within the window is rate-limited (429)', rl41st.status === 429, rl41st.status);
check('rate-limit response includes Retry-After', rl41st.headers.get('retry-after') === '60');
const rlDifferentIp = await worker.fetch(rlRequest('203.0.113.9'), d1Env, ctx);
check('a different IP is not affected by another IP\'s rate limit', rlDifferentIp.status === 200, rlDifferentIp.status);

console.log('\n== api: /api/feed — RSS feed of every notification actually sent (2026-08-24, "a sort of rss feed on the side for the news and notifications") ==');
const feedSeed = {
  technique_reliability: [], range_reliability: [], asset_score_snapshots: [],
  notification_log: [
    { kind: 'hack', symbol: 'BTC', title: 'URGENT: BTC hacked', message: 'BTC: "Some & <Weird> Exchange" -- $1.2M, "exploit", 2026-08-23.', click_url: 'https://frontiercapitalsignals.com/signals/', sent_at: '2026-08-24T01:00:00.000Z' },
    { kind: 'reversal', symbol: 'ETH', title: 'ETH bottomed', message: 'ETH (crypto) flagged a bottomed reversal near 2400.', click_url: 'https://frontiercapitalsignals.com/signals/', sent_at: '2026-08-23T12:00:00.000Z' }
  ]
};
const feedEnv = { FCS_CACHE: new MockKV(), FCS_DB: new MockD1(feedSeed) };
const feedIp = '198.51.100.20'; // fresh IP, unrelated to the /api/asset/ rate-limit tests above (isRateLimited's tracking is shared/global across all routes, not per-route)
const feedResp = await worker.fetch(new Request('https://x.com/signals/api/feed', { headers: { 'CF-Connecting-IP': feedIp } }), feedEnv, ctx);
const feedBody = await feedResp.text();
check('served as RSS XML with the right content-type', feedResp.status === 200 && (feedResp.headers.get('content-type') || '').includes('application/rss+xml'), feedResp.headers.get('content-type'));
check('valid RSS 2.0 envelope (channel title/link/description present)', feedBody.includes('<rss version="2.0">') && feedBody.includes('<channel>') && feedBody.includes('<title>Frontier Capital Signals'), feedBody.slice(0, 200));
check('both seeded notifications appear as items, most recent first', feedBody.indexOf('BTC hacked') < feedBody.indexOf('ETH bottomed') && feedBody.indexOf('ETH bottomed') !== -1);
check('XML-escapes special characters in title/message (a raw & or < would produce invalid, unparseable XML)', feedBody.includes('Some &amp; &lt;Weird&gt; Exchange') && !feedBody.includes('Some & <Weird>'), feedBody.includes('Some & <Weird>'));
check('each item carries a stable, non-permalink guid and a real pubDate', feedBody.includes('<guid isPermaLink="false">fcs-hack-BTC-') && feedBody.includes('<pubDate>'));
check('feed link auto-discovery tag present in the dashboard page head', pageText.includes('rel="alternate"') && pageText.includes('type="application/rss+xml"') && pageText.includes('/signals/api/feed'));
check('visible feed link present on the dashboard', pageText.includes('rss-link') && pageText.includes('Alerts RSS feed'));

const feedNoD1Resp = await worker.fetch(new Request('https://x.com/signals/api/feed', { headers: { 'CF-Connecting-IP': '198.51.100.21' } }), emptyEnv, ctx);
check('D1 not bound: graceful 503, not a crash', feedNoD1Resp.status === 503);

const feedEmptyEnv = { FCS_CACHE: new MockKV(), FCS_DB: new MockD1({ technique_reliability: [], range_reliability: [], asset_score_snapshots: [], notification_log: [] }) };
const feedEmptyResp = await worker.fetch(new Request('https://x.com/signals/api/feed', { headers: { 'CF-Connecting-IP': '198.51.100.22' } }), feedEmptyEnv, ctx);
const feedEmptyBody = await feedEmptyResp.text();
check('no notifications sent yet: still a valid, well-formed empty feed, not an error', feedEmptyResp.status === 200 && feedEmptyBody.includes('<channel>') && feedEmptyBody.includes('</channel>'), feedEmptyBody.slice(0, 200));

console.log('\n== selectIntradayWatchlist: curated day-trading watchlist, liquidity-proxied by open interest ==');
const wlCrypto = [
  { symbol: 'BTC', id: 'bitcoin' },
  { symbol: 'ETH', id: 'ethereum' },
  { symbol: 'SOL', id: 'solana' },
  { symbol: 'NOFUNDING', id: 'no-funding-coin' } // qualifying crypto, but no matched perp market
];
const wlFunding = {
  BTC: { openInterest: 7000e6 },
  ETH: { openInterest: 4400e6 },
  SOL: { openInterest: 650e6 }
  // NOFUNDING deliberately absent — no real USDT perpetual for it
};
const wlStocks = ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA', 'AVGO', 'JPM', 'GS'];
const watchlist = selectIntradayWatchlist(wlCrypto, wlFunding, wlStocks);
const wlCryptoOut = watchlist.filter(w => w.assetClass === 'crypto');
const wlStockOut = watchlist.filter(w => w.assetClass === 'stock');
check('crypto without a matched funding-map entry (no real perp market) is excluded', !wlCryptoOut.find(w => w.symbol === 'NOFUNDING'));
check('crypto sorted by open interest, highest first', wlCryptoOut.map(w => w.symbol).join(',') === 'BTC,ETH,SOL');
check('crypto entries carry the CoinGecko id (needed for coingeckoSimplePrice, not just the symbol)', wlCryptoOut[0].id === 'bitcoin');
check('equities: fixed 10 — SPY/QQQ plus the first 8 of the given stock watchlist, JPM/GS excluded (past the cap)', wlStockOut.map(w => w.symbol).join(',') === 'SPY,QQQ,AAPL,MSFT,NVDA,GOOGL,AMZN,META,TSLA,AVGO');
check('crypto watchlist respects CRYPTO_WATCHLIST_SIZE even with fewer qualifying coins than the cap (no padding/fabrication)', wlCryptoOut.length === 3 && wlCryptoOut.length <= CRYPTO_WATCHLIST_SIZE);
const manyCrypto = Array.from({ length: 40 }, (_, i) => ({ symbol: 'C' + i, id: 'coin' + i }));
const manyFunding = Object.fromEntries(manyCrypto.map((c, i) => [c.symbol, { openInterest: 40 - i }]));
const cappedWatchlist = selectIntradayWatchlist(manyCrypto, manyFunding, []);
check('crypto watchlist caps at CRYPTO_WATCHLIST_SIZE when more than enough qualify', cappedWatchlist.filter(w => w.assetClass === 'crypto').length === CRYPTO_WATCHLIST_SIZE);
check('empty funding map: no crypto qualifies, equities still populate', selectIntradayWatchlist(wlCrypto, {}, wlStocks).filter(w => w.assetClass === 'crypto').length === 0);

console.log('\n== parseBinanceKlines: real response shape, no network ==');
// Real Binance klines shape (confirmed live against api.binance.us):
// [openTime, open, high, low, close, volume, closeTime, quoteAssetVolume,
// trades, takerBuyBaseVol, takerBuyQuoteVol, ignore] — price/volume fields
// as strings, times as epoch ms.
const rawKlineFixture = [
  [1700000000000, '50000.00', '50500.50', '49800.25', '50250.75', '123.456', 1700003599999, '6180000.00', 5000, '60.0', '3020000.0', '0'],
  [1700003600000, '50250.75', '50900.00', '50100.00', '50800.10', '98.765', 1700007199999, '4980000.00', 4200, '45.0', '2260000.0', '0']
];
const parsedKlines = parseBinanceKlines(rawKlineFixture);
check('parses every row', parsedKlines.length === 2);
check('ts is a real ISO string derived from openTime (ms)', parsedKlines[0].ts === new Date(1700000000000).toISOString(), parsedKlines[0].ts);
check('close/high/low/volume parsed as real numbers, not strings', parsedKlines[0].close === 50250.75 && parsedKlines[0].high === 50500.50 && parsedKlines[0].low === 49800.25 && parsedKlines[0].volume === 123.456);
check('second row parses independently and correctly', parsedKlines[1].close === 50800.10 && parsedKlines[1].ts === new Date(1700003600000).toISOString());
check('non-array input: empty array, not a crash', parseBinanceKlines(null).length === 0 && parseBinanceKlines(undefined).length === 0 && parseBinanceKlines({}).length === 0);
check('empty array input: empty output', parseBinanceKlines([]).length === 0);

console.log('\n== nearestTick: nearest-within-tolerance lookup for irregularly-spaced ticks ==');
const T0 = new Date('2026-08-16T12:00:00Z').getTime();
const irregularTicks = [
  { tick_at: new Date(T0 - 42 * 60000).toISOString(), price: 100 },
  { tick_at: new Date(T0 - 31 * 60000).toISOString(), price: 101 }, // nearest to the -30min target below
  { tick_at: new Date(T0 - 12 * 60000).toISOString(), price: 105 },
  { tick_at: new Date(T0 - 3 * 60000).toISOString(), price: 108 }
];
check('finds the nearest tick within tolerance, not just the first candidate', mod.nearestTick(irregularTicks, T0 - 30 * 60000, 10 * 60000).price === 101);
check('a target with nothing within tolerance returns null, not a distant fallback', mod.nearestTick(irregularTicks, T0 - 90 * 60000, 10 * 60000) === null);
check('empty tick array: null, not a crash', mod.nearestTick([], T0, 10 * 60000) === null);
check('exact match wins over a slightly-off one', mod.nearestTick(irregularTicks, T0 - 3 * 60000, 10 * 60000).price === 108);

console.log('\n== intradaySignal: 2-of-2 momentum confluence off price-only ticks, deadband + day-extreme aware ==');
const mkTicks = (pricesAgoMin) => pricesAgoMin.map(([minAgo, price]) => ({ tick_at: new Date(T0 - minAgo * 60000).toISOString(), price }));
const upTrend = mkTicks([[65, 100], [60, 100], [16, 100], [15, 100], [1, 103]]); // +3% over both windows, clears the 0.3% crypto deadband, agrees in sign
const sigUp = mod.intradaySignal(upTrend, new Date(T0).toISOString(), 'crypto');
check('sustained up move over both windows: fires bullish', sigUp.dir === 1, JSON.stringify(sigUp));
const downTrend = mkTicks([[65, 100], [60, 100], [16, 100], [15, 100], [1, 97]]);
const sigDown = mod.intradaySignal(downTrend, new Date(T0).toISOString(), 'crypto');
check('sustained down move over both windows: fires bearish', sigDown.dir === -1, JSON.stringify(sigDown));
const disagreeing = mkTicks([[65, 100], [60, 100], [16, 100], [15, 97], [1, 100]]); // down over 15min, flat over 60min: windows disagree
const sigDisagree = mod.intradaySignal(disagreeing, new Date(T0).toISOString(), 'crypto');
check('windows disagree in sign: neutral (0), not a fabricated direction', sigDisagree.dir === 0, JSON.stringify(sigDisagree));
const tinyMove = mkTicks([[65, 100], [60, 100], [16, 100], [15, 100.1], [1, 100.15]]); // real but under the crypto deadband
const sigTiny = mod.intradaySignal(tinyMove, new Date(T0).toISOString(), 'crypto');
check('move too small to clear the deadband: neutral (0), not noise treated as signal', sigTiny.dir === 0, JSON.stringify(sigTiny));
const missingWindow = mkTicks([[16, 100], [1, 103]]); // no tick near -60min at all
const sigMissing = mod.intradaySignal(missingWindow, new Date(T0).toISOString(), 'crypto');
check('missing a momentum window entirely: abstains (null), not a guess off partial data', sigMissing.dir === null && sigMissing.peaked === null && sigMissing.bottomed === null, JSON.stringify(sigMissing));
check('empty ticks array: abstains, not a crash', mod.intradaySignal([], new Date(T0).toISOString(), 'crypto').dir === null);
const sigEquityTiny = mod.intradaySignal(mkTicks([[65, 100], [60, 100], [16, 100], [15, 100.05], [1, 100.08]]), new Date(T0).toISOString(), 'stock');
check('equities use a tighter deadband than crypto (same-sized move that would fire for crypto does not for a stock)', sigEquityTiny.dir === 0, JSON.stringify(sigEquityTiny));

// Peaked/bottomed: current price sits within INTRADAY_EXTREME_PROXIMITY_PCT
// of the rolling day high/low AND the directional call agrees (bearish
// near the high = peaked, bullish near the low = bottomed). Each case
// includes a far-outside-the-momentum-windows anchor tick that sets the
// OPPOSITE day extreme unambiguously, so the proximity check can't pass
// by degenerate accident (e.g. the current tick happening to also be the
// dataset's min/max just because the array is short).
const peakedCase = [
  { tick_at: new Date(T0 - 300 * 60000).toISOString(), price: 85 }, // unambiguous day low, far outside both momentum windows
  ...mkTicks([[65, 100.5], [60, 100.5], [16, 100.3], [15, 100.2], [1, 99.8]]) // downtrend ending near the day high (100.5)
];
const sigPeaked = mod.intradaySignal(peakedCase, new Date(T0).toISOString(), 'crypto');
check('bearish call landing within the day-high proximity band: flags peaked', sigPeaked.dir === -1 && sigPeaked.peaked === true, JSON.stringify(sigPeaked));
check('a peaked call does not also claim bottomed', sigPeaked.bottomed === false, JSON.stringify(sigPeaked));
const bottomedCase = [
  { tick_at: new Date(T0 - 300 * 60000).toISOString(), price: 115 }, // unambiguous day high, far outside both momentum windows
  ...mkTicks([[65, 89.5], [60, 89.5], [16, 89.8], [15, 89.9], [1, 90.2]]) // uptrend ending near the day low (89.5)
];
const sigBottomed = mod.intradaySignal(bottomedCase, new Date(T0).toISOString(), 'crypto');
check('bullish call landing within the day-low proximity band: flags bottomed', sigBottomed.dir === 1 && sigBottomed.bottomed === true, JSON.stringify(sigBottomed));
check('a bottomed call does not also claim peaked', sigBottomed.peaked === false, JSON.stringify(sigBottomed));
check('a directional call far from either day extreme flags neither', sigUp.peaked === false && sigUp.bottomed === false, JSON.stringify(sigUp));

console.log('\n== replayIntradaySignal: backtests intradaySignal against history, bounded windows, no live pipeline changes ==');
const mkReplayTicks = (startIso, prices) => {
  const startMs = new Date(startIso).getTime();
  return prices.map((price, i) => ({ tick_at: new Date(startMs + i * 15 * 60000).toISOString(), price }));
};

const risingPrices = Array.from({ length: 200 }, (_, i) => 100 * Math.pow(1.005, i)); // +0.5%/15min tick, well clear of the 0.3% crypto deadband even one tick at a time
const risingTicks = mkReplayTicks('2026-01-01T00:00:00.000Z', risingPrices);
const risingResults = mod.replayIntradaySignal(risingTicks, 'crypto', [15, 30, 60]);
check('steadily rising series: fires plenty of scoreable bullish calls', risingResults[15].total > 50, JSON.stringify(risingResults[15]));
check('steadily rising series: high accuracy at 15min (correctly predicts continuation)', (risingResults[15].correct / risingResults[15].total) > 0.9, JSON.stringify(risingResults[15]));
check('steadily rising series: high accuracy at 60min too', (risingResults[60].correct / risingResults[60].total) > 0.9, JSON.stringify(risingResults[60]));

const flatPrices = Array.from({ length: 200 }, (_, i) => 100 + 0.05 * Math.sin(i)); // deterministic, tiny oscillation well under the 0.3% deadband
const flatTicks = mkReplayTicks('2026-01-01T00:00:00.000Z', flatPrices);
const flatResults = mod.replayIntradaySignal(flatTicks, 'crypto', [15, 30, 60]);
check('flat/noisy series under the deadband: mostly abstains, very few scoreable calls', flatResults[15].total < 10, JSON.stringify(flatResults[15]));

// Oscillating (period 6: 3 ticks up +0.6%, 3 ticks down -0.6%, repeating):
// the 60-min horizon (4 ticks ahead) is longer than half the cycle, so a
// call fired mid-trend is almost always scored against the OPPOSITE
// phase — a genuine, reliably-reproducible reversal-right-after-signal
// scenario (a single one-off reversal in an otherwise long trending
// series gets diluted by all the correctly-scored calls either side of
// it; a short, repeating cycle doesn't have that escape hatch). Proves
// the scoring genuinely penalizes a call that turned out wrong, not just
// counts how many calls fired.
const oscPrices = [100];
for (let cycle = 0; cycle < 40; cycle++) {
  for (let i = 0; i < 3; i++) oscPrices.push(oscPrices[oscPrices.length - 1] * 1.006);
  for (let i = 0; i < 3; i++) oscPrices.push(oscPrices[oscPrices.length - 1] * 0.994);
}
const oscTicks = mkReplayTicks('2026-01-01T00:00:00.000Z', oscPrices);
const oscResults = mod.replayIntradaySignal(oscTicks, 'crypto', [60]);
check('an oscillation shorter than the scoring horizon: fires plenty of scoreable calls', oscResults[60].total > 20, JSON.stringify(oscResults[60]));
check('a genuine reversal right after signal produces sharply worse accuracy than clean continuation (proves wrong calls are penalized, not just counted)', (oscResults[60].correct / oscResults[60].total) < 0.15, JSON.stringify(oscResults[60]));
check('a genuine reversal is bucketed as wrongOpposite, not wrongFlat — the whole point of the 3-way split (the market DID move, just not the way the signal called)', oscResults[60].wrongOpposite / oscResults[60].total > 0.8, JSON.stringify(oscResults[60]));
check('correct + wrongOpposite + wrongFlat always sums to total', oscResults[60].correct + oscResults[60].wrongOpposite + oscResults[60].wrongFlat === oscResults[60].total);
check('every scored call is recorded as an {date, outcome} observation for later pooling/half-split', oscResults[60].observations.length === oscResults[60].total && oscResults[60].observations.every(o => /^\d{4}-\d{2}-\d{2}$/.test(o.date) && ['correct', 'wrongOpposite', 'wrongFlat'].includes(o.outcome)), JSON.stringify(oscResults[60].observations.slice(0, 3)));

// A single sharp jump (well clear of both momentum windows, so a call
// genuinely fires) followed by a long flat plateau: the call is real, but
// the market never moves again — must land in wrongFlat, not wrongOpposite.
const stepPrices = [...Array(60).fill(100), 102, ...Array(60).fill(102)];
const stepTicks = mkReplayTicks('2026-01-01T00:00:00.000Z', stepPrices);
const stepResults = mod.replayIntradaySignal(stepTicks, 'crypto', [60]);
check('a genuine call scored against a subsequently flat market lands in wrongFlat, not wrongOpposite or correct', stepResults[60].total > 0 && stepResults[60].wrongFlat === stepResults[60].total, JSON.stringify(stepResults[60]));

check('steadily rising series: correct calls dominate wrongOpposite (continuation genuinely wins here)', risingResults[15].correct > risingResults[15].wrongOpposite, JSON.stringify(risingResults[15]));

check('empty ticks: every horizon returns {correct:0, total:0}, not a crash', Object.values(mod.replayIntradaySignal([], 'crypto', [15, 30, 60])).every(r => r.correct === 0 && r.total === 0));
check('a single tick: nothing to score', Object.values(mod.replayIntradaySignal([{ tick_at: '2026-01-01T00:00:00.000Z', price: 100 }], 'crypto', [15])).every(r => r.total === 0));

console.log('\n== twoSampleZTest: two-sample mean comparison, same normal-approximation philosophy as isReliabilitySignificant ==');
check('too few samples: z is null, not a fabricated number', mod.twoSampleZTest([1], [1, 2, 3]).z === null);
check('empty samples: z is null, not a crash', mod.twoSampleZTest([], []).z === null);
const identicalA = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const identicalB = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
check('identical distributions: z is essentially 0 (no real difference)', Math.abs(mod.twoSampleZTest(identicalA, identicalB).z) < 0.01, mod.twoSampleZTest(identicalA, identicalB).z);
const shiftedA = identicalA.map(v => v + 100); // huge, unambiguous mean shift, same variance
const zResult = mod.twoSampleZTest(shiftedA, identicalB);
check('a clear, large mean shift: z clears the significance bar', Math.abs(zResult.z) >= mod.RELIABILITY_SIGNIFICANCE_Z, zResult.z);
check('effectSize reflects the real mean difference (100)', Math.abs(zResult.effectSize - 100) < 0.01);

console.log('\n== volumeSurgeSeries: trailing baseline, never looks ahead ==');
const volBars = Array.from({ length: 30 }, (_, i) => ({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, volume: 1000 }));
volBars[25].volume = 3000; // a real surge on day 26
const surges = mod.volumeSurgeSeries(volBars, 20);
check('too little trailing history: the first `lookbackDays` entries are skipped', !surges.find(s => s.date === '2026-01-05'));
const surgeDay = surges.find(s => s.date === volBars[25].date);
check('a real volume surge computes the correct ratio vs the trailing baseline', surgeDay && Math.abs(surgeDay.surgeRatio - 3) < 0.01, JSON.stringify(surgeDay));
const normalDay = surges.find(s => s.date === volBars[21].date);
check('a normal day (no surge) has a ratio near 1', normalDay && Math.abs(normalDay.surgeRatio - 1) < 0.01, JSON.stringify(normalDay));

console.log('\n== forwardReturns: bar-index-based forward % return, multiple horizons ==');
const retBars = [
  { date: '2026-01-01', close: 100 },
  { date: '2026-01-02', close: 102 },
  { date: '2026-01-03', close: 105 },
  { date: '2026-01-04', close: 99 }
];
const fwd = mod.forwardReturns(retBars, [1, 3]);
check('1-day forward return computed correctly', Math.abs(fwd['2026-01-01'][1] - 2) < 0.01, JSON.stringify(fwd['2026-01-01']));
check('3-day forward return computed correctly', Math.abs(fwd['2026-01-01'][3] - (-1)) < 0.01, JSON.stringify(fwd['2026-01-01']));
check('a horizon with no future bar available is simply omitted, not fabricated', fwd['2026-01-03'] && fwd['2026-01-03'][3] === undefined, JSON.stringify(fwd['2026-01-03']));
check('a date with no horizon reachable at all is omitted from the output entirely', fwd['2026-01-04'] === undefined);

console.log('\n== chronologicalHalfSplit: even split at the midpoint, deduped ==');
const splitResult = mod.chronologicalHalfSplit(['2026-01-03', '2026-01-01', '2026-01-01', '2026-01-02', '2026-01-04']);
check('deduplicates repeated dates before splitting', splitResult.firstHalf.size + splitResult.secondHalf.size === 4, JSON.stringify([...splitResult.firstHalf, ...splitResult.secondHalf]));
check('splits chronologically, not by input order', splitResult.firstHalf.has('2026-01-01') && splitResult.secondHalf.has('2026-01-04'));

console.log('\n== correlation-research guardrail: the actual point of this phase — noise must not look significant, a real injected relationship must ==');
const addDays = (startIso, n) => new Date(new Date(startIso).getTime() + n * 86400000).toISOString().slice(0, 10);

// Noise: volume follows one deterministic pattern, forward returns follow
// a completely unrelated deterministic pattern — no real relationship.
const noiseDates = Array.from({ length: 300 }, (_, i) => addDays('2026-01-01', i));
const noiseBars = noiseDates.map((date, i) => ({ date, close: 100 + Math.sin(i / 3) * 2, volume: 1000 + (i % 7) * 200 }));
const noiseSurges = mod.volumeSurgeSeries(noiseBars, 20);
const noiseFwd = mod.forwardReturns(noiseBars, [1]);
const noiseSurgeSample = noiseSurges.filter(s => s.surgeRatio >= 2).map(s => noiseFwd[s.date]?.[1]).filter(v => v != null);
const noiseNormalSample = noiseSurges.filter(s => s.surgeRatio < 2).map(s => noiseFwd[s.date]?.[1]).filter(v => v != null);
const noiseTest = mod.twoSampleZTest(noiseSurgeSample, noiseNormalSample);
check('pure noise: does NOT trigger a significant result (the actual guardrail this phase exists to prove)', noiseTest.z === null || Math.abs(noiseTest.z) < mod.RELIABILITY_SIGNIFICANCE_Z, JSON.stringify(noiseTest));

// Signal: a real volume surge every 15 days, deliberately followed by a
// real +5% next-day return; tiny deterministic noise (+-0.1%) otherwise.
const signalDates = Array.from({ length: 300 }, (_, i) => addDays('2026-01-01', i));
const signalVolumes = signalDates.map((_, i) => (i % 15 === 0 && i >= 20) ? 3000 : 1000);
const signalCloses = [100];
for (let i = 1; i < 300; i++) {
  const wasSurgeYesterday = signalVolumes[i - 1] === 3000;
  const move = wasSurgeYesterday ? 1.05 : (1 + (i % 3 === 0 ? 0.001 : -0.001));
  signalCloses.push(signalCloses[i - 1] * move);
}
const signalBars = signalDates.map((date, i) => ({ date, close: signalCloses[i], volume: signalVolumes[i] }));
const signalSurges = mod.volumeSurgeSeries(signalBars, 20);
const signalFwd = mod.forwardReturns(signalBars, [1]);
const signalSurgeSample = signalSurges.filter(s => s.surgeRatio >= 2).map(s => signalFwd[s.date]?.[1]).filter(v => v != null);
const signalNormalSample = signalSurges.filter(s => s.surgeRatio < 2).map(s => signalFwd[s.date]?.[1]).filter(v => v != null);
const signalTest = mod.twoSampleZTest(signalSurgeSample, signalNormalSample);
check('a real, deliberately injected relationship DOES trigger significance', signalTest.z !== null && Math.abs(signalTest.z) >= mod.RELIABILITY_SIGNIFICANCE_Z, JSON.stringify(signalTest));

console.log('\n== sentimentExtremeForwardReturns: buckets forward returns by that day\'s Fear & Greed reading ==');
const sefrBars = [
  { date: '2026-01-01', close: 100 },
  { date: '2026-01-02', close: 110 }, // +10% from day1 (extreme-low sentiment day)
  { date: '2026-01-03', close: 99 },  // -10% from day2 (extreme-high sentiment day)
  { date: '2026-01-04', close: 103 }  // from day3 (normal sentiment day)
];
const sefrSentiment = { '2026-01-01': 15, '2026-01-02': 90, '2026-01-03': 50 };
const sefrResult = mod.sentimentExtremeForwardReturns(sefrBars, sefrSentiment, [1]);
check('extreme-low day (fg=15) bucketed with the correct forward return', sefrResult[1].low.length === 1 && Math.abs(sefrResult[1].low[0].value - 10) < 1e-9, JSON.stringify(sefrResult[1].low));
check('extreme-high day (fg=90) bucketed with the correct forward return', sefrResult[1].high.length === 1 && Math.abs(sefrResult[1].high[0].value - (-10)) < 1e-9, JSON.stringify(sefrResult[1].high));
check('normal-range day (fg=50) bucketed separately from the extremes', sefrResult[1].normal.length === 1 && sefrResult[1].normal[0].date === '2026-01-03', JSON.stringify(sefrResult[1].normal));
check('a date missing from sentimentByDate is skipped entirely, not fabricated into a bucket', sefrResult[1].low.length + sefrResult[1].high.length + sefrResult[1].normal.length === 3);

console.log('\n== timeOfDaySentimentSplit: the compound "00:00 EST"-style question — same clock slot, split by that day\'s sentiment ==');
const todsBars = [];
const todsSentiment = {};
for (let d = 0; d < 10; d++) {
  const date = addDays('2026-02-01', d);
  const fg = d % 2 === 0 ? 10 : 50; // alternating extreme-low / normal sentiment days
  todsSentiment[date] = fg;
  const base = 100 + d;
  const moveFactor = fg === 10 ? 1.02 + (d % 3) * 0.001 : 1.001 + (d % 3) * 0.0003; // deliberately bigger move on extreme days, tiny jitter so variance isn't exactly zero
  todsBars.push({ ts: `${date}T00:00:00.000Z`, close: base });
  todsBars.push({ ts: `${date}T01:00:00.000Z`, close: base * moveFactor });
  todsBars.push({ ts: `${date}T12:00:00.000Z`, close: base }); // off-slot bar — must be ignored entirely
}
const todsResult = mod.timeOfDaySentimentSplit(todsBars, todsSentiment, 'hour_utc_00', 1);
check('only bars in the target slot are scored, split 5 extreme / 5 normal', todsResult.extreme.length === 5 && todsResult.normal.length === 5, JSON.stringify(todsResult));
check('extreme-sentiment days show the larger injected move (~2%)', todsResult.extreme.every(p => p.value > 1.5), JSON.stringify(todsResult.extreme));
check('normal-sentiment days show the smaller injected move (~0.1%)', todsResult.normal.every(p => p.value < 0.5), JSON.stringify(todsResult.normal));
const todsSignalTest = mod.twoSampleZTest(todsResult.extreme.map(p => p.value), todsResult.normal.map(p => p.value));
check('a real injected sentiment-conditional time-of-day difference DOES trigger significance', todsSignalTest.z !== null && Math.abs(todsSignalTest.z) >= mod.RELIABILITY_SIGNIFICANCE_Z, JSON.stringify(todsSignalTest));

// Noise: same slot, but the move is an unrelated deterministic wiggle with
// no real connection to that day's sentiment bucket.
const todsNoiseBars = [];
const todsNoiseSentiment = {};
for (let d = 0; d < 60; d++) {
  const date = addDays('2026-03-01', d);
  const fg = d % 2 === 0 ? 10 : 50;
  todsNoiseSentiment[date] = fg;
  const move = 1 + Math.sin(d) * 0.005;
  todsNoiseBars.push({ ts: `${date}T00:00:00.000Z`, close: 100 });
  todsNoiseBars.push({ ts: `${date}T01:00:00.000Z`, close: 100 * move });
}
const todsNoiseResult = mod.timeOfDaySentimentSplit(todsNoiseBars, todsNoiseSentiment, 'hour_utc_00', 1);
const todsNoiseTest = mod.twoSampleZTest(todsNoiseResult.extreme.map(p => p.value), todsNoiseResult.normal.map(p => p.value));
check('no real sentiment-conditional difference: does NOT trigger a significant result', todsNoiseTest.z === null || Math.abs(todsNoiseTest.z) < mod.RELIABILITY_SIGNIFICANCE_Z, JSON.stringify(todsNoiseTest));

// ---- peg detection (2026-08-31) --------------------------------------------
// The bug this replaces: USDG, a $1 stablecoin, was ranked #3 on the
// breakdown board carrying a "⏳ Consolidating ↓" badge — a peg cannot
// consolidate, and the T27 accum technique fires on it unconditionally
// because a peg ALWAYS has squeezed bands and |chg7d| < 5%.
console.log('\n== peg detection: behaviour beats the ticker list ==');
const flatSeries = Array.from({ length: 168 }, (_, i) => 1 + Math.sin(i) * 0.00008);
const goldSeries = Array.from({ length: 168 }, (_, i) => 4500 * (1 + Math.sin(i / 9) * 0.02));
const movingSeries = Array.from({ length: 168 }, (_, i) => 0.09 * (1 + Math.sin(i / 5) * 0.09));
check('a flat $1 series is detected as a peg', mod.pegBehaviour(flatSeries).pegged);
check('gold-like low-vol but real movement is NOT a peg', !mod.pegBehaviour(goldSeries).pegged, JSON.stringify(mod.pegBehaviour(goldSeries)));
check('an ordinary volatile alt is NOT a peg', !mod.pegBehaviour(movingSeries).pegged);
check('too few points abstains rather than guessing', mod.pegBehaviour(flatSeries.slice(0, 10)).pegged === false && mod.pegBehaviour(flatSeries.slice(0, 10)).medianPct === null);

// USDG's actual identity: nothing about the strings "USDG" or "Global
// Dollar" says "peg", which is exactly why a ticker list alone let it
// through for months.
const usdg = { symbol: 'USDG', id: 'global-dollar', name: 'Global Dollar' };
check('USDG is caught (it is now on the known list)', mod.isStableValueAsset(usdg));
check('an UNKNOWN peg is still caught, by behaviour alone', mod.isNonDirectionalAsset({ symbol: 'NEWPEG', id: 'newpeg', name: 'Frontier Reserve Unit' }, flatSeries));
check('an unknown peg with no history is NOT guessed at', !mod.isNonDirectionalAsset({ symbol: 'NEWPEG', id: 'newpeg', name: 'Frontier Reserve Unit' }, []));

// The false positive found while calibrating: the token literally named
// "Stable" (id stable-2) is an ordinary directional asset, and a naive
// name ban would have silently deleted it from the boards.
check('a MOVING asset named "Stable" survives the name heuristic', !mod.isNonDirectionalAsset({ symbol: 'STABLE', id: 'stable-2', name: 'Stable' }, movingSeries));
check('a FLAT asset named "…Dollar" is excluded', mod.isNonDirectionalAsset({ symbol: 'ZZD', id: 'zz-dollar', name: 'Zephyr Dollar' }, flatSeries));
check('PAX Gold is not treated as a peg by name', !mod.looksLikePegByName({ symbol: 'PAXG', name: 'PAX Gold' }));

// pegAnchorDeviationPct must work off the asset's OWN anchor, not an
// assumed $1 — the excluded set includes tokenized T-bill funds trading
// near $11 and $106, which a hardcoded dollar would score as thousands of
// percent depegged.
const highAnchor = Array.from({ length: 168 }, () => 106.25);
check('a healthy peg reads ~0% deviation at a $1 anchor', mod.pegAnchorDeviationPct(Array.from({ length: 168 }, () => 1), 0.9998) < 0.05);
check('a healthy peg reads ~0% deviation at a $106 anchor too', mod.pegAnchorDeviationPct(highAnchor, 106.22) < 0.05, String(mod.pegAnchorDeviationPct(highAnchor, 106.22)));
check('a real depeg is reported at its true size', Math.abs(mod.pegAnchorDeviationPct(Array.from({ length: 168 }, () => 1), 0.94) - 6) < 0.2);
check('no series means no deviation claim', mod.pegAnchorDeviationPct([], 1) === null);

// The archive's long-term-bottom scan feeds DAILY closes into the same
// threshold the hourly sparkline uses. Verified against real 365-day
// history rather than assumed: pegs stay pinned as the bar length grows
// while real assets scale up, so the two populations separate further,
// not closer (see pegBehaviour's docs for the measured figures).
const dailyPeg = Array.from({ length: 365 }, (_, i) => 1 + Math.sin(i * 1.7) * 0.00012);
const dailyReal = Array.from({ length: 365 }, (_, i) => 100 * Math.exp(Math.sin(i * 0.7) * 0.06 + i * 0.001));
check('a peg is still detected on DAILY bars', mod.pegBehaviour(dailyPeg).pegged, JSON.stringify(mod.pegBehaviour(dailyPeg)));
check('a real asset on DAILY bars is not swept up', !mod.pegBehaviour(dailyReal).pegged, JSON.stringify(mod.pegBehaviour(dailyReal)));

// Regression for the bug widening the blocklist introduced in
// correlation-research.mjs: its depeg deviation assumed a $1 anchor,
// which was fine while the list held only dollar stablecoins but not once
// it also held T-bill funds trading near $11 and $106. Those would have
// read ~1019% and ~10522% depegged on every bar, dominating the daily
// maximum, pushing every date past the 0.25% stress threshold and
// emptying the normal-day bucket — killing the test silently rather than
// answering it wrongly.
console.log('\n== depeg deviation is anchor-relative, not dollar-relative ==');
const dollarPeg = Array.from({ length: 400 }, () => 1.0);
const tbillFund = Array.from({ length: 400 }, () => 106.25);
check('a healthy $1 peg still reads a tiny deviation', mod.pegAnchorDeviationPct(dollarPeg, 0.9994) < 0.25);
check('a real $1 depeg still reads its true size', Math.abs(mod.pegAnchorDeviationPct(dollarPeg, 0.94) - 6) < 0.01);
check('a $106 fund reads ~0%, not ~10522%', mod.pegAnchorDeviationPct(tbillFund, 106.22) < 0.25, String(mod.pegAnchorDeviationPct(tbillFund, 106.22)));

// ---- CoinGecko 429 retry (2026-09-01) -------------------------------------
// A single un-retried 429 took the Signals Daily job down on both
// 2026-08-31 and 2026-09-01: daily-refresh calls getCryptoMarkets first,
// so one rate-limited response aborted the run before any of the work
// behind it could start.
console.log('\n== getCryptoMarkets 429 retry ==');
{
  const realFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls++; return calls <= 2
    ? { ok: false, status: 429, json: async () => ({}) }
    : { ok: true, status: 200, json: async () => ({ recovered: true }) }; };
  const recovered = await mod.fetchJsonRetrying429('https://example.test/a', [5, 5, 5]);
  check('a transient 429 is retried and recovers', recovered && recovered.recovered === true && calls === 3, `calls=${calls}`);

  calls = 0;
  global.fetch = async () => { calls++; return { ok: false, status: 404, json: async () => ({}) }; };
  let threw = false;
  try { await mod.fetchJsonRetrying429('https://example.test/b', [5, 5, 5]); } catch { threw = true; }
  check('a 404 is NOT retried — it will not fix itself', threw && calls === 1, `calls=${calls}`);

  calls = 0;
  global.fetch = async () => { calls++; return { ok: false, status: 429, json: async () => ({}) }; };
  threw = false;
  try { await mod.fetchJsonRetrying429('https://example.test/c', [5, 5]); } catch { threw = true; }
  check('a persistent 429 gives up rather than looping forever', threw && calls === 3, `calls=${calls}`);
  global.fetch = realFetch;
}

// ---- retrospective (2026-08-31) --------------------------------------------
console.log('\n== retrospective: episode anchoring and miss classification ==');
// A retroQuiet run-in, then a volume retroSurge into a rising bar, then the move.
// The unanchored version of this search picked the FIRST 3x hour anywhere
// in the series, which fired on BTC and ETH just as readily as on ARB —
// hence findMoveEpisode running first.
const retroQuiet = Array.from({ length: 60 }, (_, i) => ({
  openTime: new Date(Date.UTC(2026, 7, 20, i)).toISOString(),
  open: 100, high: 100.4, low: 99.6, close: 100 + (i % 3) * 0.05, volume: 1000, quoteVolume: 100000, trades: 500
}));
const retroSurge = [];
for (let i = 0; i < 14; i++) {
  const base = 100 + i * 2.2;
  retroSurge.push({
    openTime: new Date(Date.UTC(2026, 7, 22, 12 + i)).toISOString(),
    open: base, high: base + 2.4, low: base - 0.4, close: base + 2.0,
    volume: 9000, quoteVolume: 900000, trades: 4200
  });
}
const retroBars = [...retroQuiet, ...retroSurge];
const retroEp = mod.findMoveEpisode(retroBars);
check('findMoveEpisode locates the real run', retroEp && retroEp.gainPct > 15, JSON.stringify(retroEp));
const retroDescribed = mod.describeMissedMove(retroBars);
check('the move is reported as detectable in advance', retroDescribed && retroDescribed.detected === true);
check('the tell lands at or before the peak', retroDescribed && new Date(retroDescribed.detectableAt) <= new Date(retroDescribed.peakAt));
check('a meaningful gain was still available from the tell', retroDescribed && retroDescribed.gainToPeakPct > 5, JSON.stringify(retroDescribed && retroDescribed.gainToPeakPct));
check('a flat, uneventful series produces no episode at all', mod.describeMissedMove(retroQuiet) === null);

// The PROM case: a -16% day whose bull trap the upside-only search would
// otherwise have reported as a confident long entry.
const retroDownside = mod.describeMissedMove(retroBars, { moveDir: -1 });
check('a downside move is NOT reported as a detectable long', retroDownside && retroDownside.detected === false && retroDownside.reason === 'downside-analysis-not-implemented');

check('out-of-universe is classified', mod.classifyMiss({ inUniverse: false, passedFloors: true, onBoard: false, moveDir: 1 }) === 'out-of-universe');
check('filtered-out is distinguished from never-fetched', mod.classifyMiss({ inUniverse: false, passedFloors: false, onBoard: false, moveDir: 1 }) === 'filtered-out');
check('scored-but-unranked is classified', mod.classifyMiss({ inUniverse: true, passedFloors: true, onBoard: false, moveDir: 1 }) === 'unranked');
check('a backwards call is classified wrong-side', mod.classifyMiss({ inUniverse: true, passedFloors: true, onBoard: true, boardSide: -1, moveDir: 1 }) === 'wrong-side');
check('a correct, timely call is classified caught', mod.classifyMiss({ inUniverse: true, passedFloors: true, onBoard: true, boardSide: 1, moveDir: 1, scoredAt: '2026-08-30T10:00:00Z', detectableAt: '2026-08-30T14:00:00Z' }) === 'caught');
check('a call made only after the tell is classified late', mod.classifyMiss({ inUniverse: true, passedFloors: true, onBoard: true, boardSide: 1, moveDir: 1, scoredAt: '2026-08-31T20:00:00Z', detectableAt: '2026-08-30T14:00:00Z' }) === 'late');
check('every cause emitted is in the declared vocabulary', mod.MISS_CAUSES.includes(mod.classifyMiss({ inUniverse: true, passedFloors: true, onBoard: false, moveDir: 1 })));

// ---- forward surge scanning (2026-09-01) -----------------------------------
// The measured finding these encode: mean forward return falls
// MONOTONICALLY as a volume spike grows, so a big spike is an exhaustion
// marker and not an entry. Only the exhaustion configuration survived both
// the significance bar and the chronological-half split; the two
// long-side candidates failed the split and must stay silent until their
// own live record earns them in.
console.log('\n== forward surge scanning ==');
const mkSurgeBars = (n, { spikeAt = null, spikeMult = 30, spikeBarPct = 8 } = {}) =>
  Array.from({ length: n }, (_, i) => {
    const isSpike = spikeAt != null && i === spikeAt;
    const open = 100;
    return {
      openTime: new Date(Date.UTC(2026, 8, 1, i)).toISOString(),
      open, high: open * 1.02, low: open * 0.99,
      close: isSpike ? open * (1 + spikeBarPct / 100) : open * 1.001,
      volume: 1000, quoteVolume: isSpike ? 100000 * spikeMult : 100000,
      trades: isSpike ? 500 * 6 : 500
    };
  });

const exhaustionCfg = mod.SURGE_CONFIGS.find((c) => c.id === 'exhaustion20');
check('exactly one configuration is proven at discovery', mod.SURGE_CONFIGS.filter((c) => c.proven).length === 1);
check('the proven one predicts DOWN, not up — it is a warning, not an entry', exhaustionCfg.dir === -1);
check('the long-side candidates are explicitly unproven', mod.SURGE_CONFIGS.filter((c) => c.dir === 1).every((c) => !c.proven));

// Cast on the last CLOSED bar, never the forming one.
const spikeBars = mkSurgeBars(80, { spikeAt: 78 });
const hits = mod.scanSurgeConfigs(spikeBars);
check('a 30x spike on a +8% bar fires the exhaustion configuration', hits.some((h) => h.config.id === 'exhaustion20'), JSON.stringify(hits.map(h => h.config.id)));
check('the forming final bar is not scanned', mod.scanSurgeConfigs(mkSurgeBars(80, { spikeAt: 79 })).every((h) => h.config.id !== 'exhaustion20'));

// A spike that has NOT yet run is not exhaustion — this is the filter that
// took alert volume from 20.6/day to 4.4/day and doubled the effect.
check('a 30x spike on a flat bar does NOT fire exhaustion', mod.scanSurgeConfigs(mkSurgeBars(80, { spikeAt: 78, spikeBarPct: 0.2 })).every((h) => h.config.id !== 'exhaustion20'));
check('an ordinary quiet series fires nothing', mod.scanSurgeConfigs(mkSurgeBars(80)).length === 0);

// Abstain rather than assume when the venue reports no trade counts.
const noTrades = mkSurgeBars(80, { spikeAt: 78 }).map((b) => ({ ...b, trades: null }));
check('a missing trade count abstains instead of passing the test', mod.scanSurgeConfigs(noTrades).every((h) => h.config.id !== 'exhaustion20'));

const f = mod.surgeFeatures(spikeBars, 78);
check('surgeFeatures reports the ratio against the trailing median', f && Math.abs(f.ratio - 30) < 0.01, JSON.stringify(f));
check('surgeFeatures reports liquidity as the median hourly quote volume', f && Math.abs(f.liquidity - 100000) < 1);

// Directional scoring: a -1 call is correct when price FALLS.
check('a down-call is correct when price falls', mod.scoreSurgeCast(-1, 100, 92).outcome === 'correct');
check('a down-call is wrong when price rises', mod.scoreSurgeCast(-1, 100, 108).outcome === 'wrong');
check('a flat market credits neither side', mod.scoreSurgeCast(-1, 100, 100.4).outcome === 'flat');
check('an up-call is correct when price rises', mod.scoreSurgeCast(1, 100, 108).outcome === 'correct');

console.log(failures === 0 ? '\nWORKER INTEGRATION OK\n' : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
