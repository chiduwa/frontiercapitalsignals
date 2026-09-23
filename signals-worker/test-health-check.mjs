// Tests the health checker itself.
//
// A monitor nobody has tried to fool is not a monitor. Each case below is a
// real failure this project has actually had, replayed as a payload, with the
// checker asked whether it notices. The registry-staleness case is the
// 2026-09-11..15 Discovery outage reproduced exactly: a payload that is healthy
// in every other respect while the learning loop has been dead for five days.
import assert from 'node:assert/strict';
import { checkPayload, checkPageResponse, THRESHOLDS, shouldNotify, fingerprintOf, checkDeployFreshness,
  looksUndecoded, probeFetch, reclaimFetchDispatcher } from './scripts/health-check.mjs';

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

// Reproduce the Oracle token failure despite an otherwise fresh dashboard.
const symbols=['BTC','ETH','SOL','XLM','XRP','HYPE','HBAR','ARB'];
const freshOi={asOf:ago(20*60000),assets:Object.fromEntries(symbols.map(s=>[s,{lastOiAt:ago(21*60000)}]))};
assert.deepEqual(failing(healthy({marketExplanations:freshOi})),[]);
const staleOi={...freshOi,assets:{...freshOi.assets,BTC:{lastOiAt:ago(5*24*H)}}};
assert.ok(failing(healthy({marketExplanations:staleOi})).includes('oi-collector-BTC'));
assert.equal(failing(healthy({marketExplanations:{assets:{}}})).filter(s=>s.startsWith('oi-collector-')).length,8);
assert.ok(notOk(healthy({sessionResearch:{status:'unavailable'}})).includes('research-fresh-stable-basket'));
console.log('COLLECTOR / RESEARCH HEALTH OK');


// ---- THE HIJACKED-DISPATCHER INCIDENT (2026-09-22) --------------------------
//
// Runs #319-#322 failed with exactly this set:
//   fail: deploy-sitemap, page-content-type, page-disclaimer, payload-fetch,
//         prices-endpoint   warn: page-canonical, page-security-headers
// Five failures, every one of them false. The site was serving correctly to
// every other client the whole time. What had changed was undici 8.11.0,
// published at 06:57 UTC that morning and pulled in fresh by `npm install` as
// a transitive dependency of jsdom: importing jsdom registers ITS undici as the
// process-wide dispatcher on a global symbol that Node's own fetch also reads,
// so every response arrived with no headers and no content-decoding.
//
// These assertions are the tripwire. They run in CI BEFORE the live probe, so
// the next dependency that does this fails a test with a named cause instead of
// paging at 07:20 with six wrong answers.
const UNDICI_GLOBAL_DISPATCHER = Symbol.for('undici.globalDispatcher.1');

// Importing the module above imports jsdom. By the time we get here the module
// must already have taken the dispatcher back.
const holder = globalThis[UNDICI_GLOBAL_DISPATCHER];
assert.ok(!holder || holder.constructor?.name === 'Agent',
  `importing health-check.mjs must leave Node's own fetch dispatcher in place, `
  + `but found ${holder?.constructor?.name} — global fetch is hijacked and every live check will lie`);

// And the reclaim itself must actually bite when something takes it again.
class Dispatcher1Wrapper { }                       // what undici 8.11.0 installs
globalThis[UNDICI_GLOBAL_DISPATCHER] = new Dispatcher1Wrapper();
assert.equal(reclaimFetchDispatcher(), true, 'a foreign dispatcher must be detected and cleared');
assert.equal(globalThis[UNDICI_GLOBAL_DISPATCHER], undefined,
  'clearing it is what makes Node re-install its own Agent on the next fetch');
assert.equal(reclaimFetchDispatcher(), false, 'with nothing to reclaim it must report no change');

// It must not throw away a dispatcher that is already Node's own.
class Agent { }
const nodesOwn = new Agent();
globalThis[UNDICI_GLOBAL_DISPATCHER] = nodesOwn;
assert.equal(reclaimFetchDispatcher(), false, "Node's own Agent must be left alone");
assert.equal(globalThis[UNDICI_GLOBAL_DISPATCHER], nodesOwn, 'reclaiming must not disturb a healthy dispatcher');
globalThis[UNDICI_GLOBAL_DISPATCHER] = undefined;

// probeFetch re-asserts it on every request, so a later import cannot take it
// back between two checks in the same run.
globalThis[UNDICI_GLOBAL_DISPATCHER] = new Dispatcher1Wrapper();
let sent = null;
await probeFetch('https://example.invalid/x', { redirect: 'follow' }, async (_u, o) => { sent = o; return { ok: true, status: 200 }; });
assert.equal(globalThis[UNDICI_GLOBAL_DISPATCHER], undefined,
  'probeFetch must reclaim the dispatcher before it issues the request');
assert.equal(sent.headers['User-Agent'], 'fcs-health-check', 'the probe must stay identifiable in logs');
assert.equal(sent.redirect, 'follow', 'probeFetch must not swallow caller options');

// ---- one transport fault must report as ONE transport fault -----------------
// Real bytes: the live brotli stream of /signals/ begins 8b ff 0f 00 e4 cf 96 d6.
const undecodedBody = new TextDecoder().decode(
  new Uint8Array([0x8b, 0xff, 0x0f, 0x00, 0xe4, 0xcf, 0x96, 0xd6, 0x1b, 0x24, 0x0b, 0x00, 0xe4, 0xd2, 0x66, 0x15]));

assert.ok(looksUndecoded(undecodedBody), 'the real undecoded stream must be recognised');
assert.ok(!looksUndecoded(goodHtml), 'real HTML must never be mistaken for an undecoded body');
assert.ok(!looksUndecoded(JSON.stringify({ crypto: { BTC: { price: 1 } } })), 'real JSON must not trip the detector');
assert.ok(!looksUndecoded('<?xml version="1.0"?><urlset><url><loc>x</loc></url></urlset>'), 'real XML must not trip it');
assert.ok(!looksUndecoded(''), 'an empty body is a different failure and must not be reported as this one');
assert.ok(!looksUndecoded('<html><body>' + 'x'.repeat(4000) + '�</body></html>'),
  'a stray replacement character past the head must not be read as an undecoded body');

// The incident, replayed through the page checks exactly as it arrived:
// status 200, no headers at all, a body of raw compressed bytes.
const incident = checkPageResponse(200, null, {}, undecodedBody);
const incidentFail = incident.filter((c) => !c.ok && c.level === 'fail').map((c) => c.id);
assert.ok(incidentFail.includes('page-body-decoded'),
  'an undecoded body must be named as such — the check the incident had no way to produce');
for (const derived of ['page-disclaimer', 'page-canonical', 'page-scripts-parse', 'page-structured-data']) {
  assert.ok(!incident.some((c) => c.id === derived),
    `${derived} must not be reported when the body never decoded — asserting on unreadable bytes manufactured the false alarms`);
}
assert.ok(incidentFail.includes('page-content-type'), 'a genuinely absent content-type must still fail');
assert.ok(fingerprintOf(incident).split(',').filter((f) => f.startsWith('fail:')).length < 5,
  'the incident must no longer produce five separate failures');

// ---- and a healthy page must be entirely undisturbed ------------------------
const healthyPage = checkPageResponse(200, 'text/html; charset=utf-8', okHeaders, goodHtml);
assert.deepEqual(healthyPage.filter((c) => !c.ok), [], 'adding the transport check must not disturb a page that is fine');
assert.ok(healthyPage.some((c) => c.id === 'page-body-decoded' && c.ok),
  'the healthy page must actively PASS the transport check, not skip it');

console.log('TRANSPORT / DISPATCHER HEALTH OK');
