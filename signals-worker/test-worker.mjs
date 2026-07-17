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
  if (u.includes('bybit.com')) return ok({ result: { list: [
    { symbol: 'BTCUSDT', fundingRate: '0.00005' }, { symbol: 'SOLUSDT', fundingRate: '-0.0001' }, { symbol: 'LINKUSDT', fundingRate: '0.0002' }
  ] } });
  if (u.includes('fc.yahoo.com')) return ok('', true);
  if (u.includes('getcrumb')) return ok('testcrumb', true);
  if (u.includes('quoteSummary')) {
    const sym = u.split('quoteSummary/')[1].split('?')[0];
    return ok({ quoteSummary: { result: [{ financialData: { targetMeanPrice: { raw: 200 }, targetHighPrice: { raw: 260 }, targetLowPrice: { raw: 150 }, numberOfAnalystOpinions: { raw: 30 }, recommendationMean: { raw: 2.1 }, recommendationKey: 'buy' }, defaultKeyStatistics: { forwardPE: { raw: 22 } } }] } });
  }
  if (u.includes('finance/chart/')) {
    return ok({ chart: { result: [{
      timestamp: dailyTs,
      meta: { regularMarketPrice: dailyClose[dailyClose.length - 1] },
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

console.log('\n== engine: buildPayload() called directly, as build-signals.mjs will ==');
const { payload: built, log } = await mod.buildPayload({ TREFIS_OVERRIDES: '{"AAPL": 999}' });
check('crypto boards populated', built.crypto.breakout.length > 0 && built.crypto.universe >= 3);
check('stablecoin filtered from universe', built.crypto.universe === 4, `universe=${built.crypto.universe}`);
check('stocks boards populated', built.stocks.breakout.length > 0);
check('confluence agreement present', built.crypto.breakout[0].conf && built.crypto.breakout[0].conf.total >= 10 && built.crypto.breakout[0].conf.total <= 14);
check('rangePos stays in [0,1]', built.crypto.breakout.every(r => r.rangePos == null || (r.rangePos >= 0 && r.rangePos <= 1)));
check('valuation flowed in', built.stocks.breakout.concat(built.stocks.breakdown).some(r => r.val));
check('trefis override applied', built.health.trefis_overrides === 1);
check('funding fed to crypto', built.crypto.breakout.concat(built.crypto.breakdown).some(r => r.funding != null));
check('health counts sane', built.health.stocks_ok === built.health.stocks_total && built.health.valuation_ok > 0);
check('crypto_daily health reflects the daily-history fetch (3 of 4 succeed, solana has none stubbed)', built.health.crypto_daily_total === 4 && built.health.crypto_daily_ok === 3, `ok=${built.health.crypto_daily_ok} total=${built.health.crypto_daily_total}`);
check('votesLog/priceLog not leaked into the public payload', built.crypto.votesLog === undefined && built.crypto.priceLog === undefined && built.stocks.votesLog === undefined);
check('log has directional votes for both asset classes', log.votes.some(v => v.asset_class === 'crypto') && log.votes.some(v => v.asset_class === 'stock'));
check('log votes are directional only (no 0/null dir)', log.votes.every(v => v.dir === 1 || v.dir === -1));
check('log has a price row per universe asset, both classes', log.prices.length === built.crypto.universe + built.stocks.universe);
check('crypto entries carry a CoinGecko id (for the dashboard\'s outbound link)', built.crypto.breakout.concat(built.crypto.breakdown).every(r => typeof r.id === 'string' && r.id.length > 0));
check('stock entries have no id field (not applicable, uses symbol for the Yahoo link instead)', built.stocks.breakout.every(r => r.id === undefined));
check('every ranked row carries a horizon estimate end-to-end through buildPayload', built.crypto.breakout.concat(built.crypto.breakdown, built.stocks.breakout, built.stocks.breakdown).every(r => r.horizon && typeof r.horizon.label === 'string' && (r.horizon.basis === 'methodology' || r.horizon.basis === 'historical')));

console.log('\n== reliability weighting: confluence() with a synthetic reliability map ==');
const btcMetrics = mod.buildCryptoMetrics(btcCoin, { daily: btcDaily });
const baseline = mod.confluence(btcMetrics, 'crypto');
const boosted = mod.confluence(btcMetrics, 'crypto', { [`${btcMetrics.symbol}|rsi`]: { accuracy: 1.0, total: 50 } });
const nerfed = mod.confluence(btcMetrics, 'crypto', { [`${btcMetrics.symbol}|rsi`]: { accuracy: 0.0, total: 50 } });
const belowThreshold = mod.confluence(btcMetrics, 'crypto', { [`${btcMetrics.symbol}|rsi`]: { accuracy: 1.0, total: 3 } });
check('reliability multiplier changes the score vs baseline (enough samples)', boosted.long !== baseline.long || boosted.short !== baseline.short || nerfed.long !== baseline.long || nerfed.short !== baseline.short);
check('below MIN_RELIABILITY_SAMPLES, weighting stays at baseline (no overfit to small samples)', belowThreshold.long === baseline.long && belowThreshold.short === baseline.short);
check('reliabilityMultiplier clamps to [0.5, 1.5]', mod.reliabilityMultiplier({ 'X|y': { accuracy: 5, total: 50 } }, 'X', 'y') === 1.5 && mod.reliabilityMultiplier({ 'X|y': { accuracy: -5, total: 50 } }, 'X', 'y') === 0.5);
check('reliabilityMultiplier is neutral (1) with no reliability data', mod.reliabilityMultiplier(undefined, 'X', 'y') === 1 && mod.reliabilityMultiplier({}, 'X', 'y') === 1);

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

const rNoSentiment = findTech(mod.evaluateTechniques(bottomWithConfirm, 'crypto', undefined, {}), 'reversal');
const rExtremeFear = findTech(mod.evaluateTechniques(bottomWithConfirm, 'crypto', undefined, { fearGreed: 15 }), 'reversal');
const rExtremeGreedIrrelevantToBottom = findTech(mod.evaluateTechniques(bottomWithConfirm, 'crypto', undefined, { fearGreed: 90 }), 'reversal');
check('crypto: extreme fear boosts weight on a bottom call', rExtremeFear.w > rNoSentiment.w, `boosted=${rExtremeFear.w} base=${rNoSentiment.w}`);
check('crypto: extreme greed (misaligned) leaves weight at base for a bottom call', rExtremeGreedIrrelevantToBottom.w === rNoSentiment.w);

const stockBottom = baseMetric({ rsi: 35, rsiPrev: 28, rsiRecentMin: 25, rsiRecentMax: 60, structure: 1 });
const rStockNoVix = findTech(mod.evaluateTechniques(stockBottom, 'stock', undefined, {}), 'reversal');
const rStockHighVix = findTech(mod.evaluateTechniques(stockBottom, 'stock', undefined, { vixRangePos: 0.85 }), 'reversal');
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
const historicalShort = mod.confluence(bottomWithConfirm, 'crypto', undefined, undefined, strongAt24h);
check('this asset\'s own 24h accuracy is strong and 168h has no data: picks the historical 1-day window', historicalShort.longHorizon.basis === 'historical' && historicalShort.longHorizon.label === mod.horizonLabel(1), JSON.stringify(historicalShort.longHorizon));

const strongAt168h = {
  24: {},
  168: Object.fromEntries(activeBullIds.map(id => [`${symbol}|${id}`, { correct: 25, total: 25 }]))
};
const historicalLong = mod.confluence(bottomWithConfirm, 'crypto', undefined, undefined, strongAt168h);
check('this asset\'s own 7d accuracy is strong and 24h has no data: picks the historical ~1-week window', historicalLong.longHorizon.basis === 'historical' && historicalLong.longHorizon.label === mod.horizonLabel(7), JSON.stringify(historicalLong.longHorizon));

const belowSampleThreshold = {
  24: Object.fromEntries(activeBullIds.map(id => [`${symbol}|${id}`, { correct: 4, total: 5 }])),
  168: {}
};
const historicalTooFewSamples = mod.confluence(bottomWithConfirm, 'crypto', undefined, undefined, belowSampleThreshold);
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
const notFooledByCorrelatedSamples = mod.confluence(bottomWithConfirm, 'crypto', undefined, undefined, correlatedThinSamples);
check('several techniques each below threshold: does not sum to false confidence, stays methodology', notFooledByCorrelatedSamples.longHorizon.basis === 'methodology', JSON.stringify(notFooledByCorrelatedSamples.longHorizon));

check('horizonEstimate returns null when nothing voted that direction', mod.horizonEstimate([{ id: 'rsi', w: 1, dir: 1 }], -1, 'X', undefined) === null);

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

console.log(failures === 0 ? '\nWORKER INTEGRATION OK\n' : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
