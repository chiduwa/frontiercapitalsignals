// Tests for scripts/exhaustion-gauge.mjs: the per-coin prints, the market-wide
// reading, and the alert text. The research these encode is in
// docs/research-2026-09-26/EXHAUSTION.md.
import assert from 'node:assert/strict';
import {
  tierOf, recentPrints, latestReading, marketGauge, describeGauge, exhaustionAlertBody,
  MAJOR_LIQUIDITY_30D, MAJOR_MARKET_CAP, EXHAUSTION_EVIDENCE, BREADTH_REFERENCE,
  binanceDenomination, matchMarketCaps, runPosition, tokenizedStockSymbols, KNOWN_TOKENIZED_STOCKS
} from './scripts/exhaustion-gauge.mjs';

let seed = 11;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5; };

// n hourly bars of noise; optional run into a climax on the last CLOSED bar,
// optional market-wide volume lift over the final day.
function series({ n = 1000, base = 100000, climax = false, lift = 1, drift = 0 } = {}) {
  const out = [];
  let px = 100;
  for (let i = 0; i < n; i++) {
    const open = px;
    let close = open * (1 + 0.004 * rnd() + drift * (i >= n - 74 ? 1 : 0));
    let qv = base * (1 + 0.4 * rnd()) * (i >= n - 25 ? lift : 1);
    if (climax && i >= n - 26 && i < n - 2) close = open * 1.005;
    if (climax && i === n - 2) { close = open * 1.03; qv = base * 10; }
    out.push({ openTime: new Date(Date.UTC(2026, 7, 1, i)).toISOString(), open, high: Math.max(open, close) * 1.001,
      low: Math.min(open, close) * 0.999, close, volume: qv / close, quoteVolume: qv, trades: 500 });
    px = close;
  }
  return out;
}

// ---- tiers ------------------------------------------------------------------
assert.equal(tierOf(MAJOR_LIQUIDITY_30D), 'major');
assert.equal(tierOf(100_000), 'mid');
assert.equal(tierOf(10_000), 'thin');
assert.equal(tierOf(null), null, 'unknown liquidity has no tier rather than a guessed one');
assert.equal(tierOf(26_000, 1e9), 'major', 'a $1B coin is major however thin its Binance book (QNT)');
assert.equal(tierOf(26_000, MAJOR_MARKET_CAP - 1), 'thin');
assert.equal(tierOf(26_000, null), 'thin', 'unknown market cap leaves the liquidity tier alone');

// ---- tokenized stocks are not crypto ------------------------------------------------
const tsx = tokenizedStockSymbols([{ symbol: 'newb', name: 'NewCo (bStocks Tokenized Stock)' }, { symbol: 'act', name: 'Act I: The AI Prophecy' }]);
assert.ok(tsx.has('TSLAB') && tsx.has('SPYB'), 'the known bStocks are always excluded');
assert.ok(tsx.has('NEWB'), 'a new listing CoinGecko names as a tokenized stock is picked up');
assert.ok(!tsx.has('ACT'), 'a coin is never excluded just for being in the response');
assert.ok(!['BTC', 'ETH', 'MOVR', 'QNT', 'BNB'].some((s) => KNOWN_TOKENIZED_STOCKS.has(s)));

// ---- market caps matched to Binance symbols --------------------------------------
assert.deepEqual(binanceDenomination('1000SATS'), { base: 'SATS', mult: 1e3 });
assert.deepEqual(binanceDenomination('1MBABYDOGE'), { base: 'BABYDOGE', mult: 1e6 });
assert.deepEqual(binanceDenomination('MOVR'), { base: 'MOVR', mult: 1 });
const cg = [
  { symbol: 'qnt', current_price: 100, market_cap: 1.2e9 },
  { symbol: 'sats', current_price: 2e-8, market_cap: 4e8 },
  { symbol: 'act', current_price: 50, market_cap: 9e8 },     // a different, larger coin with the same ticker
  { symbol: 'movr', current_price: 2.2, market_cap: 2e7 }
];
const caps = matchMarketCaps(cg, { QNT: 101, '1000SATS': 2.1e-5, ACT: 0.05, MOVR: 2.25, NEW: 1 });
assert.equal(caps.QNT, 1.2e9);
assert.equal(caps['1000SATS'], 4e8, 'a per-1000 listing is priced per 1000 tokens');
assert.equal(caps.ACT, undefined, 'a ticker shared with a coin at a different price is not taken for it');
assert.equal(caps.MOVR, 2e7);
assert.equal(caps.NEW, undefined, 'a coin outside the list stays unknown');
const fallback = matchMarketCaps([{ symbol: 'QNT', price_used: 50, market_cap: 6e8 }], { QNT: 100 }, { priceKey: 'price_used', tolerance: 0.8, rescale: true });
assert.equal(fallback.QNT, 1.2e9, 'the stored snapshot is carried to today\'s price');

// ---- recent prints -------------------------------------------------------------
const hot = series({ climax: true });
const prints = recentPrints('HOT', hot);
assert.equal(prints.length >= 1, true, 'a climax on the last closed bar is found');
assert.equal(prints[0].at, hot[hot.length - 2].openTime, 'newest print first, and never the forming bar');
assert.ok(prints[0].configs.includes('exhaustion_calibrated'), JSON.stringify(prints[0].configs));
assert.equal(prints[0].breadthHit, true);
assert.deepEqual(recentPrints('QUIET', series()), [], 'an ordinary coin prints nothing');
const deep = recentPrints('DEEP', series({ climax: true, base: 2e6 }));
assert.ok(deep.length && deep[0].breadthHit && !deep[0].configs.includes('exhaustion_calibrated'),
  'a deep book counts toward breadth but gets no per-coin sell warning: majors showed no effect');
const reading = latestReading('HOT', hot);
assert.ok(reading.volZ > 10 && reading.tier === 'mid' && reading.price === hot[hot.length - 1].close);

// ---- the market gauge ----------------------------------------------------------
const calm = {}, surging = {};
for (let c = 0; c < 40; c++) {
  calm[`C${c}`] = series();
  surging[`S${c}`] = series({ lift: 3, drift: 0.004 });
}
const gCalm = marketGauge(calm, {});
assert.equal(gCalm.scanned, 40);
assert.ok(Math.abs(gCalm.aggVolumeZ) < 3 && describeGauge(gCalm).state === 'normal', JSON.stringify(gCalm));
const gSurge = marketGauge(surging, {});
assert.ok(gSurge.aggVolumeZ > 1.5 && gSurge.marketRun72Z > 1.5, JSON.stringify(gSurge));
const d = describeGauge(gSurge);
assert.equal(d.state, 'surge-in-rally');
assert.match(d.detail, /more upside/, 'the measured continuation is what the reader is told');
const busy = marketGauge({ ...calm, HOT: hot }, { HOT: recentPrints('HOT', hot) });
assert.ok(busy.breadth > 0 && busy.prints24h === 1, JSON.stringify(busy));
assert.equal(describeGauge({ ...gCalm, breadth: BREADTH_REFERENCE.p90 + 0.01 }).state, 'crowded');
for (const g of [gCalm, gSurge, { ...gCalm, breadth: 0.2 }]) {
  const text = JSON.stringify(describeGauge(g));
  assert.doesNotMatch(text, /sell now|market top ahead/i, 'the market reading never calls a top: none was found');
  assert.doesNotMatch(text, /—/, 'no em dashes in user-facing copy');
}
assert.equal(describeGauge(null).state, 'unknown');

// ---- the alert text ------------------------------------------------------------
const hit = { symbol: 'HOT', features: { ...recentPrints('HOT', hot)[0], at: hot[hot.length - 2].openTime } };
const nowTs = Date.parse(hot[hot.length - 1].openTime) + 20 * 60_000;
const body = exhaustionAlertBody(hit, hot, 'proven at discovery', { nowTs, rulesFired: ['exhaustion_calibrated'] });
assert.match(body, /UTC hour closed \+3\.0% \(open to close\)/, 'the bar move states its own window');
assert.match(body, /vs 1h ago: /, 'a ladder of horizons, each with its anchor');
assert.match(body, /vs 1d ago: /);
assert.match(body, /standard deviations above its own 30-day norm/);
assert.match(body, /Not financial advice\.$/);
assert.doesNotMatch(body, /—/, 'no em dashes in user-facing copy');
assert.match(body, /On mid-size coins a print like this has been followed by trailing the market by 1\.9% over the next day/,
  'a per-coin print quotes the per-coin record for its own size');
const strong = exhaustionAlertBody(hit, hot, 'proven', { nowTs, rulesFired: ['exhaustion20', 'exhaustion_calibrated'] });
assert.match(strong, /Strong: both exhaustion rules fired/);
assert.ok(strong.includes(`${Math.round(EXHAUSTION_EVIDENCE.byCase['both|mid'].fellShare24 * 100)}% of 2,857 past cases`), strong);
const twenty = exhaustionAlertBody(hit, hot, 'proven', { nowTs, rulesFired: ['exhaustion20'] });
assert.match(twenty, /trailing the market by 2\.7%/, 'a 20x-only print quotes the 20x record');
const deepHit = { symbol: 'DEEP', features: { ...hit.features, liquidity30d: 5e6 } };
assert.match(exhaustionAlertBody(deepHit, hot, 'proven', { nowTs, rulesFired: ['exhaustion20'] }), /caution, not a sell signal/,
  'on the most liquid coins the alert says the evidence is not there');

// Where the print sits in the coin's run (2026-10-01).
assert.match(body, /This is the first exhaustion print on HOT in 72 hours\. First prints have faded least \(median -5\.0% against the market over a day\), and about 1 in 20 instead ran 20% or more past it\./);
const again = hot.map((b) => ({ ...b }));
const k = again.length - 12;
again[k] = { ...again[k], close: again[k].open * 1.03, high: again[k].open * 1.031, quoteVolume: 1e6 };
const againHit = { symbol: 'HOT', features: { ...recentPrints('HOT', again)[0] } };
assert.equal(recentPrints('HOT', again, { lookback: 73 }).filter((p) => p.configs.length).length, 2, 'the earlier climax is a print too');
const second = runPosition('HOT', again, againHit.features);
assert.match(second, /^This is exhaustion print 2 on HOT in 72 hours \(not every print is pushed\); the first was the \d\d:00 UTC hour on \d\d-\d\d at [\d.,]+, [+-][\d.]+% since\./, second);
assert.match(second, /faded more \(median -7\.5% against the market over a day\) but about 1 in 13 kept running 20% or more past it\./, second);
const bigHit = { symbol: 'QNT', features: { ...hit.features, liquidity30d: 26_000, marketCap: 1.05e9 } };
const bigBody = exhaustionAlertBody(bigHit, hot, 'proven', { nowTs, rulesFired: ['exhaustion20'] });
assert.match(bigBody, /large coin \(about \$1\.1B market cap\) even though it trades thinly on Binance/, bigBody);
assert.match(bigBody, /fell in 61% of 719 past cases\)\. Treat it as a caution, not a sell signal\./);
assert.doesNotMatch(bigBody, /exhaustion print/, 'a caution does not count the run as a sell sequence');
for (const t of [second, bigBody]) assert.doesNotMatch(t, /—/, 'no em dashes in user-facing copy');

console.log('EXHAUSTION GAUGE OK');
