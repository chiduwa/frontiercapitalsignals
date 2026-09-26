// Tests for scripts/exhaustion-gauge.mjs: the per-coin prints, the market-wide
// reading, and the alert text. The research these encode is in
// docs/research-2026-09-26/EXHAUSTION.md.
import assert from 'node:assert/strict';
import {
  tierOf, recentPrints, latestReading, marketGauge, describeGauge, exhaustionAlertBody,
  MAJOR_LIQUIDITY_30D, EXHAUSTION_EVIDENCE, BREADTH_REFERENCE
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

console.log('EXHAUSTION GAUGE OK');
