// Tests the health checker itself.
//
// A monitor nobody has tried to fool is not a monitor. Each case below is a
// real failure this project has actually had, replayed as a payload, with the
// checker asked whether it notices. The registry-staleness case is the
// 2026-09-11..15 Discovery outage reproduced exactly: a payload that is healthy
// in every other respect while the learning loop has been dead for five days.
import assert from 'node:assert/strict';
import { checkPayload, checkPageResponse, THRESHOLDS, shouldNotify, fingerprintOf, checkDeployFreshness } from './scripts/health-check.mjs';

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

// ---- alerting policy ---------------------------------------------------------
// The monitor paged 6 identical times in its first three hours over one real,
// correctly-detected problem. Alerting on persistence is how a monitor trains
// people to ignore it, so it now alerts on CHANGE. What must never happen is
// that a NEW problem gets swallowed by that dedup.
const fp = (ids) => ids.map((i) => `fail:${i}`).sort().join(',');

assert.equal(shouldNotify('', null), false, 'nothing failing must never alert');
assert.equal(shouldNotify('', { conclusion: 'failure', fingerprint: fp(['a']) }), false,
  'recovering to healthy must not fire the failure alert');
assert.equal(shouldNotify(fp(['a']), null), true, 'with no history to compare, report');
assert.equal(shouldNotify(fp(['a']), { conclusion: 'success', fingerprint: '' }), true,
  'the transition from healthy into broken must always alert');
// A warnings-only run ends GREEN but still carries a fingerprint. Keying dedup
// on the conclusion instead of the fingerprint would re-announce that same
// warning on every single run, forever.
assert.equal(shouldNotify('warn:x', { conclusion: 'success', fingerprint: 'warn:x' }), false,
  'an unchanged warning on a green run must not re-announce every run');
assert.equal(shouldNotify('fail:x', { conclusion: 'success', fingerprint: 'warn:x' }), true,
  'a warning escalating into a failure must alert even though both runs differ only in level');
assert.equal(shouldNotify(fp(['a']), { conclusion: 'failure', fingerprint: fp(['a']) }), false,
  'the SAME failure repeating must stay quiet');
assert.equal(shouldNotify(fp(['a', 'b']), { conclusion: 'failure', fingerprint: fp(['a']) }), true,
  'a NEW failure joining an existing one must alert — this is the case dedup must never swallow');
assert.equal(shouldNotify(fp(['b']), { conclusion: 'failure', fingerprint: fp(['a']) }), true,
  'a different failure replacing the old one must alert');
assert.equal(shouldNotify(fp(['a']), { conclusion: 'failure', fingerprint: fp(['a', 'b']) }), true,
  'a partial recovery changes the set, so it alerts rather than going quiet mid-incident');
assert.equal(shouldNotify(fp(['a']), { conclusion: 'failure', fingerprint: fp(['a']) }, { alwaysNotify: true }), true,
  'FCS_HEALTH_ALWAYS_NOTIFY overrides the dedup');

// The fingerprint must be order-independent, or check reordering would look
// like a new incident every run.
const shuffled = [
  { id: 'z', level: 'fail', ok: false }, { id: 'a', level: 'warn', ok: false },
  { id: 'm', level: 'fail', ok: true }
];
assert.equal(fingerprintOf(shuffled), fingerprintOf([...shuffled].reverse()),
  'fingerprint must not depend on check order');
assert.equal(fingerprintOf(shuffled), 'fail:z,warn:a'.split(',').sort().join(','),
  'fingerprint covers level and id, and excludes passing checks');
assert.equal(fingerprintOf([{ id: 'a', level: 'fail', ok: true }]), '',
  'an all-clear fingerprints as empty');
// A warning and a failure with the same id are different states.
assert.notEqual(fingerprintOf([{ id: 'x', level: 'fail', ok: false }]),
  fingerprintOf([{ id: 'x', level: 'warn', ok: false }]),
  'the same check escalating from warn to fail must count as a change');

// ---- THE CLOUDFLARE TOKEN OUTAGE (2026-09-14 .. 09-18) ---------------------
// Replayed exactly. For four days the deploy step failed on a dead
// CLOUDFLARE_API_TOKEN while the repo committed daily, /signals/ stayed current
// off the Worker cron, and every page returned 200. Nothing in this file
// noticed, because nothing compared the repo against production.
const DNOW = Date.parse('2026-09-18T20:00:00Z');
const dFailing = (live, repo, now = DNOW) =>
  checkDeployFreshness(live, repo, now).filter((c) => !c.ok && c.level === 'fail').map((c) => c.id);
const dNotOk = (live, repo, now = DNOW) =>
  checkDeployFreshness(live, repo, now).filter((c) => !c.ok).map((c) => c.id);

// Baseline: production carries what the repo carries, today.
assert.deepEqual(dNotOk('2026-09-18T00:00:00.000Z', '2026-09-18T00:00:00.000Z'), [],
  'a deployed, current site must raise nothing');

// The outage itself.
assert.ok(dFailing('2026-09-14T00:00:00.000Z', '2026-09-18T00:00:00.000Z').includes('deploy-reached-production'),
  'four days of undeployed commits must FAIL — this is the outage that ran unnoticed');

// The false positive that would have made this monitor untrustworthy: sitemap
// <lastmod> is date-only, so every morning between the commit and the deploy
// the repo is a quantised day ahead. That window must stay silent.
assert.deepEqual(
  dFailing('2026-09-17T00:00:00.000Z', '2026-09-18T00:00:00.000Z', Date.parse('2026-09-18T06:43:00Z')),
  [], 'the normal commit-then-deploy window must not fail');
// But the same lag must fail once it has clearly stopped being a window.
assert.ok(
  dFailing('2026-09-17T00:00:00.000Z', '2026-09-18T00:00:00.000Z', Date.parse('2026-09-18T18:00:00Z'))
    .includes('deploy-reached-production'),
  'content still undeployed 18h into its own day is a failure, not a window');

// Outside a checkout there is no repo date; that must degrade to the absolute
// age check rather than inventing a pass or a crash.
assert.deepEqual(dNotOk('2026-09-18T00:00:00.000Z', null), [],
  'a fresh site with no repo to compare against must stay silent');
assert.ok(dNotOk('2026-09-16T00:00:00.000Z', null).includes('deploy-freshness'),
  'without a repo date, staleness alone must still register');
assert.ok(dFailing('2026-09-14T00:00:00.000Z', null).includes('deploy-freshness'),
  `content older than ${THRESHOLDS.deployAgeFailHours}h must fail on age alone`);

// An unreadable sitemap is a failure, not a silent skip — the check going
// blind is the one outcome that would recreate the original blind spot.
assert.ok(dFailing(null, '2026-09-18T00:00:00.000Z').includes('deploy-sitemap'),
  'an unreadable sitemap must fail rather than pass quietly');

console.log('health-check tests passed');
