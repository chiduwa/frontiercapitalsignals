// Integration test for the assembled Worker + engine. No real network.
//
// Architecture: the Worker only ever reads the KV cache at request time
// (fits Workers Free plan's 50-subrequest/10ms-CPU caps); the engine
// (buildPayload, ~130 outbound fetches + indicator math) runs externally,
// in scripts/build-signals.mjs via a scheduled GitHub Action, and is
// imported here directly to verify it still produces a sane payload.
//
// Run: node test-worker.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { computeSwingTimeTallies, barsRowsToReturnsBySymbol, matchProtocolsToUniverse, findPivots, walkSrLevels, isYahooCryptoDataTrustworthy } from './scripts/archive.mjs';
import { selectIntradayWatchlist, CRYPTO_WATCHLIST_SIZE } from './scripts/intraday.mjs';
import { parseBinanceKlines } from './scripts/archive.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.error(`  FAIL  ${name} ${detail}`); }
};

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
  // different open_interest to exercise "keeps the highest-OI market."
  if (u.includes('/derivatives')) return ok([
    { contract_type: 'perpetual', index_id: 'BTC', symbol: 'BTCUSDT', funding_rate: 0.00005, open_interest: 5e9, market: 'Binance (Futures)' },
    { contract_type: 'perpetual', index_id: 'BTC', symbol: 'BTCUSDT', funding_rate: 0.00009, open_interest: 1e8, market: 'OKX (Futures)' },
    { contract_type: 'perpetual', index_id: 'SOL', symbol: 'SOLUSDT', funding_rate: -0.0001, open_interest: 8e8, market: 'Binance (Futures)' },
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
}

// ---- mock D1 (Workers binding surface: prepare(sql).bind(...args).all()) --
// Table choice is inferred from the SQL text (same substring-matching
// style as stubbedFetch's URL matching above) since this mock only ever
// needs to serve the one route (/api/asset/:symbol) that reads D1 directly.
class MockD1 {
  constructor(seed) { this.seed = seed || { technique_reliability: [], range_reliability: [], asset_score_snapshots: [] }; }
  prepare(sql) {
    const table = sql.includes('technique_reliability') ? 'technique_reliability'
      : sql.includes('range_reliability') ? 'range_reliability'
      : sql.includes('asset_score_snapshots') ? 'asset_score_snapshots'
      : null;
    const rows = (table && this.seed[table]) || [];
    return { bind: (symbol) => ({ all: async () => ({ results: rows.filter((r) => r.symbol === symbol) }) }) };
  }
}

// ---- load the worker module (also exports buildPayload + CACHE_KEY) -------
global.fetch = stubbedFetch;
const ctx = { waitUntil: (p) => { if (p && p.then) p.catch(() => {}); } };

const src = readFileSync(join(__dirname, 'worker.js'), 'utf8');
const mod = await import('data:text/javascript,' + encodeURIComponent(src));
const worker = mod.default;
check('worker exports fetch only (no in-Worker cron)', typeof worker.fetch === 'function' && worker.scheduled === undefined);
check('buildPayload + CACHE_KEY exported for scripts/build-signals.mjs', typeof mod.buildPayload === 'function' && typeof mod.CACHE_KEY === 'string');

console.log('\n== routing ==');
const emptyEnv = { FCS_CACHE: new MockKV() };
const redir = await worker.fetch(new Request('https://x.com/signals'), emptyEnv, ctx);
check('/signals -> 301', redir.status === 301, `got ${redir.status}`);
check('301 targets /signals/', (redir.headers.get('location') || '').endsWith('/signals/'));

const page = await worker.fetch(new Request('https://x.com/signals/'), emptyEnv, ctx);
const pageText = await page.text();
check('dashboard served', page.headers.get('content-type').includes('text/html') && pageText.includes('Frontier Capital'));
check('dashboard sends CSP + hardening headers', !!page.headers.get('content-security-policy') && page.headers.get('x-content-type-options') === 'nosniff' && page.headers.get('x-frame-options') === 'DENY');
check('CSP allows GTM/GA4 domains (script-src + connect-src)', page.headers.get('content-security-policy').includes('googletagmanager.com') && page.headers.get('content-security-policy').includes('google-analytics.com'));
check('GTM container + consent-mode snippet present in the page', pageText.includes('GTM-5Q7JC6JX') && pageText.includes('fcs_consent_v1') && pageText.includes("gtag('consent','default'"));
check('custom event pushes present (data-loaded, error, methodology-open)', pageText.includes('signals_data_loaded') && pageText.includes('signals_feed_error') && pageText.includes('signals_methodology_open'));
check('clickable-row + sortable-header tracking present', pageText.includes('signals_asset_click') && pageText.includes('signals_sort_change') && pageText.includes('sym-link') && pageText.includes('sortable'));
check('horizon chip markup + methodology copy present', pageText.includes('class="horizon') && pageText.includes('hz-hist') && pageText.includes('hz-meth') && pageText.includes('Leading vs. lagging'));
check('track-record section + methodology copy present', pageText.includes('id="trackRecord"') && pageText.includes('95%+') && pageText.includes('Prediction-score track record'));
check('live-price markup + polling code present', pageText.includes('live-price-cell') && pageText.includes('live-chg-cell') && pageText.includes("api/prices") && pageText.includes('updateLivePrices'));

console.log('\n== getFundingMap: CoinGecko derivatives, highest-OI perpetual market wins ==');
const fundingMap = await mod.getFundingMap();
check('BTC picks the higher-OI perpetual market (Binance, 5e9) over the lower-OI one (OKX, 1e8)', fundingMap.BTC.fundingRate === 0.00005 && fundingMap.BTC.openInterest === 5e9, JSON.stringify(fundingMap.BTC));
check('a futures (non-perpetual) contract with even higher OI is correctly excluded', fundingMap.BTC.market === 'Binance (Futures)', fundingMap.BTC.market);
check('SOL and LINK (single-market fixtures) both present', fundingMap.SOL.fundingRate === -0.0001 && fundingMap.LINK.fundingRate === 0.0002);

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
check('only the 4 named favorites ever appear in the favorites section', built.crypto.favorites.every(f => ['XLM', 'XRP', 'HYPE', 'HBAR'].includes(f.symbol)), JSON.stringify(built.crypto.favorites.map(f => f.symbol)));
check('stocks never carry a favorites section (FAVORITE_SYMBOLS is crypto-only)', Array.isArray(built.stocks.favorites) && built.stocks.favorites.length === 0);
check('every favorites row is shaped exactly like a board row (reuses entry(), not a second implementation)', built.crypto.favorites.every(f => typeof f.score === 'number' && (f.dir === 1 || f.dir === -1) && typeof f.price === 'number'));
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

console.log('\n== engine: a qualifying highAccuracy entry carries price + its own predicted range ==');
const qualifyingReliability = { 'BTC|composite': { correct: 25, total: 25, accuracy: 1 } };
const { payload: builtQualifying } = await mod.buildPayload({ TREFIS_OVERRIDES: '{"AAPL": 999}' }, qualifyingReliability, undefined, undefined, {});
const btcEntry = builtQualifying.highAccuracy.find(r => r.symbol === 'BTC');
check('BTC clears the 95%+ bar given a synthetic 25/25 composite record', !!btcEntry, JSON.stringify(builtQualifying.highAccuracy));
check('the qualifying entry carries a real current price, not just a bare score', btcEntry && typeof btcEntry.price === 'number' && btcEntry.price > 0);
check('the qualifying entry carries its own predicted range (low < high) and a coin id to link out', btcEntry && btcEntry.range && btcEntry.range.low < btcEntry.range.high && typeof btcEntry.id === 'string');
check('the qualifying entry carries a horizon label for that range\'s own period', btcEntry && btcEntry.horizon && typeof btcEntry.horizon.label === 'string');

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

console.log('\n== assetPredictionScore: pooled track record across composite/pivot/range, out of 100 ==');
check('below MIN_RELIABILITY_SAMPLES pooled outcomes: null, not a noisy guess', mod.assetPredictionScore('THIN', { 'THIN|composite': { correct: 5, total: 10 } }, {}) === null);
check('exactly one under the threshold (19 total): still null', mod.assetPredictionScore('W', { 'W|composite': { correct: 10, total: 19 } }, {}) === null);
const pooled = mod.assetPredictionScore('X', {
  'X|composite': { correct: 9, total: 10 },
  'X|reversal': { correct: 4, total: 5 },
  'X|dwell': { correct: 3, total: 5 }
}, { X: { hits: 8, total: 10 } });
check('pools composite + reversal + dwell + range hits/totals correctly (24/30 = 80)', pooled && pooled.score === 80 && pooled.samples === 30, JSON.stringify(pooled));
const rangeOnly = mod.assetPredictionScore('Y', {}, { Y: { hits: 19, total: 20 } });
check('a symbol with only range data (no matured composite/reversal/dwell yet) still scores off what exists (19/20 = 95, right at the threshold, not yet "above 95")', rangeOnly && rangeOnly.score === 95 && rangeOnly.samples === 20, JSON.stringify(rangeOnly));
const perfect = mod.assetPredictionScore('Z', { 'Z|composite': { correct: 25, total: 25 } }, {});
check('a perfect matured record scores 100, not a lower "cautious" number', perfect && perfect.score === 100 && perfect.samples === 25, JSON.stringify(perfect));
check('assetPredictionScore itself does not apply the >95 leaderboard cutoff (that is buildPayload\'s job) — 95 is a valid returned score', rangeOnly.score === 95);

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

console.log(failures === 0 ? '\nWORKER INTEGRATION OK\n' : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
