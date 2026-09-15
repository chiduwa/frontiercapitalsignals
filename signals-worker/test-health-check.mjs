// Tests the health checker itself.
//
// A monitor nobody has tried to fool is not a monitor. Each case below is a
// real failure this project has actually had, replayed as a payload, with the
// checker asked whether it notices. The registry-staleness case is the
// 2026-09-11..15 Discovery outage reproduced exactly: a payload that is healthy
// in every other respect while the learning loop has been dead for five days.
import assert from 'node:assert/strict';
import { checkPayload, checkPageResponse, THRESHOLDS } from './scripts/health-check.mjs';

const NOW = Date.parse('2026-09-15T12:00:00Z');
const ago = (ms) => new Date(NOW - ms).toISOString();
const H = 3_600_000;

function healthy(overrides = {}) {
  return {
    generated_at: ago(20 * 60_000),
    prices_generated_at: ago(30_000),
    health: { coingecko: true, stocks_ok: 280, stocks_total: 290 },
    classSkill: {
      crypto: { proven: false, accuracy: 0.42, baseline: 0.4213 },
      stock: { proven: false, accuracy: 0.38, baseline: 0.3828 }
    },
    crypto: { universe: 211, breakout: [{ symbol: 'BTC', dir: 0 }, { symbol: 'SOL', dir: 0 }], breakdown: [{ symbol: 'DOGE', dir: 0 }], favorites: [], longTermPotential: [] },
    stocks: { universe: 290, breakout: [{ symbol: 'NVDA', dir: 0 }], breakdown: [{ symbol: 'INTC', dir: 0 }], favorites: [], longTermPotential: [] },
    quantResearch: { rows: [{ hypothesis: 'x', updatedAt: ago(6 * H) }] },
    ...overrides
  };
}

const failing = (payload) => checkPayload(payload, NOW).filter((c) => !c.ok && c.level === 'fail').map((c) => c.id);
const notOk = (payload) => checkPayload(payload, NOW).filter((c) => !c.ok).map((c) => c.id);

// ---- the baseline must be silent, or every other assertion is meaningless ---
assert.deepEqual(notOk(healthy()), [], 'a healthy payload must raise nothing at all');

// ---- THE DISCOVERY OUTAGE ---------------------------------------------------
// Everything green except a registry that has not moved in five days. This is
// precisely what the live payload looked like from 2026-09-11 to 2026-09-15,
// and precisely what nothing was watching for.
const frozenRegistry = healthy({ quantResearch: { rows: [{ hypothesis: 'x', updatedAt: ago(5 * 24 * H) }] } });
assert.ok(failing(frozenRegistry).includes('research-registry-fresh'),
  'a registry frozen for five days must FAIL — this is the outage that ran unnoticed');
const slippingRegistry = healthy({ quantResearch: { rows: [{ hypothesis: 'x', updatedAt: ago(40 * H) }] } });
assert.ok(notOk(slippingRegistry).includes('research-registry-fresh'),
  'a registry that missed one daily run must already warn, on day two rather than day five');
assert.ok(!failing(slippingRegistry).includes('research-registry-fresh'),
  'but one missed run is a warning, not a page — the alert has to stay worth reading');

// ---- the archive read failing silently --------------------------------------
// The D1 size ceiling inside daily-refresh's try/catch shows up here as
// collapsed coverage, not as an error.
assert.ok(failing(healthy({ crypto: { ...healthy().crypto, universe: 40 } })).includes('crypto-universe'),
  'a collapsed crypto universe must fail');
assert.ok(failing(healthy({ stocks: { ...healthy().stocks, universe: 12 } })).includes('stock-universe'),
  'a collapsed equity universe must fail');
assert.ok(notOk(healthy({ crypto: { ...healthy().crypto, universe: 140 } })).includes('crypto-universe'),
  'a universe below the pre-widening size must at least warn');
assert.ok(failing(healthy({
  crypto: { universe: 211, breakout: [], breakdown: [], favorites: [], longTermPotential: [] },
  stocks: { universe: 290, breakout: [], breakdown: [], favorites: [], longTermPotential: [] }
})).includes('boards-populated'), 'every board empty must fail');

// ---- the refresh chain stalling ---------------------------------------------
assert.ok(failing(healthy({ generated_at: ago(4 * H) })).includes('model-freshness'),
  'a 4h-old model build means the dispatch chain is broken and must fail');
assert.ok(notOk(healthy({ generated_at: ago(2 * H) })).includes('model-freshness'),
  'a 2h-old model build must warn');
assert.deepEqual(notOk(healthy({ generated_at: ago(60 * 60_000) })), [],
  'an hour-old build is normal for an hourly rebuild and must stay silent');
assert.ok(failing(healthy({ prices_generated_at: ago(45 * 60_000) })).includes('price-freshness'),
  'a 45-minute-old price tick must fail — the Worker cron refreshes it every 5 minutes');

// ---- THE GATE ----------------------------------------------------------------
// The one thing this site must never do.
const leakedDirection = healthy({
  crypto: { ...healthy().crypto, breakout: [{ symbol: 'BTC', dir: 1 }] }
});
assert.ok(failing(leakedDirection).includes('gate-crypto'),
  'a direction published by an unproven class must fail');
assert.ok(checkPayload(leakedDirection, NOW).find((c) => c.id === 'gate-crypto').detail.includes('BTC=1'),
  'and the alert must name the offending row, not just the count');
assert.ok(failing(healthy({ crypto: { ...healthy().crypto, breakout: [{ symbol: 'BTC', dir: 0, horizon: { label: '24h' } }] } })).includes('gate-crypto-horizon'),
  'a trade timeframe published without a proven class must fail');
assert.ok(failing(healthy({ crypto: { ...healthy().crypto, breakout: [{ symbol: 'BTC', dir: 0, range: { low: 1, high: 2 } }] } })).includes('gate-crypto-range'),
  'a projected range published without a proven class must fail');
// The mirror: once a class IS proven, the same rows are legitimate and must not
// be flagged, or the monitor would fire forever the day the model starts working.
const provenClass = healthy({
  classSkill: { crypto: { proven: true }, stock: { proven: false } },
  crypto: { ...healthy().crypto, breakout: [{ symbol: 'BTC', dir: 1, horizon: { label: '24h' }, range: { low: 1, high: 2 } }] }
});
assert.deepEqual(notOk(provenClass), [], 'a proven class publishing a direction is correct, not an incident');
// ...and the still-unproven class is judged independently in the same payload.
assert.ok(failing({ ...provenClass, stocks: { ...healthy().stocks, breakout: [{ symbol: 'NVDA', dir: -1 }] } }).includes('gate-stock'),
  'one class clearing its gate must not launder the other');

// ---- feeds -------------------------------------------------------------------
assert.ok(failing(healthy({ health: { coingecko: false, stocks_ok: 280, stocks_total: 290 } })).includes('coingecko-feed'),
  'CoinGecko being down must fail');
assert.ok(notOk(healthy({ health: { coingecko: true, stocks_ok: 100, stocks_total: 290 } })).includes('equity-feed'),
  'thin equity coverage must warn');

// ---- a payload that is simply absent ------------------------------------------
assert.deepEqual(failing(null), ['payload-shape'], 'no payload at all must fail, and fail once, not fifteen times');
assert.ok(failing(healthy({ generated_at: undefined })).includes('model-clock'), 'a missing build clock must fail');

// ---- the page response ---------------------------------------------------------
const okHeaders = { 'content-security-policy': "default-src 'self'", 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY' };
const goodHtml = '<html><head><link rel="canonical" href="x"><script type="application/ld+json">{"a":1}</script></head>'
  + '<body>not a recommendation<script>var a = 1;</script></body></html>';
const pageFail = (...args) => checkPageResponse(...args).filter((c) => !c.ok && c.level === 'fail').map((c) => c.id);
assert.deepEqual(checkPageResponse(200, 'text/html; charset=utf-8', okHeaders, goodHtml).filter((c) => !c.ok), [],
  'a healthy page response must raise nothing');
assert.ok(pageFail(503, 'text/html', okHeaders, null).includes('page-status'), 'a 503 must fail');
// THE 2026-08-22 INCIDENT: one bad apostrophe, whole dashboard dead, every other
// layer silent. The live page is the only place this is visible.
assert.ok(pageFail(200, 'text/html', okHeaders, goodHtml.replace('var a = 1;', "var a = 'it's broken';")).includes('page-scripts-parse'),
  'an inline script that does not parse must fail — it takes the entire dashboard down silently');
assert.ok(pageFail(200, 'text/html', okHeaders, goodHtml.replace('not a recommendation', '')).includes('page-disclaimer'),
  'losing the risk disclaimer must fail');

// ---- thresholds stay internally coherent ---------------------------------------
assert.ok(THRESHOLDS.modelAgeWarnHours < THRESHOLDS.modelAgeFailHours);
assert.ok(THRESHOLDS.priceAgeWarnMinutes < THRESHOLDS.priceAgeFailMinutes);
assert.ok(THRESHOLDS.cryptoUniverseFail < THRESHOLDS.cryptoUniverseWarn);
assert.ok(THRESHOLDS.stockUniverseFail < THRESHOLDS.stockUniverseWarn);
assert.ok(THRESHOLDS.registryAgeWarnHours < THRESHOLDS.registryAgeFailHours);

console.log('health-check tests passed');
