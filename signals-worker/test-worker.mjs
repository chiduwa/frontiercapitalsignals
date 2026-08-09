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
import { computeSwingTimeTallies, barsRowsToReturnsBySymbol, matchProtocolsToUniverse } from './scripts/archive.mjs';

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
  mkCoin('tether', 'usdt', 'Tether', 1, 1e11) // must be filtered out
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
check('stablecoin filtered from universe', built.crypto.universe === 4, `universe=${built.crypto.universe}`);
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
check('crypto_daily health reflects the daily-history fetch (3 of 4 succeed, solana has none stubbed)', built.health.crypto_daily_total === 4 && built.health.crypto_daily_ok === 3, `ok=${built.health.crypto_daily_ok} total=${built.health.crypto_daily_total}`);
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

console.log('\n== impliedvol technique: Deribit DVOL percentile, contrarian, never fires without a price-extreme too ==');
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
check('crypto-only: stocks never fire this technique even with matching IV data', findTech(mod.evaluateTechniques(ivHighPercentileNearLow, 'stock'), 'impliedvol').dir === null);

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

console.log(failures === 0 ? '\nWORKER INTEGRATION OK\n' : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
