// Tests for scripts/price-change.mjs.
//
// The fixture is not invented. It is BTW's real mark price from oi_tick on
// 2026-09-13/14, decimated to hourly out to 24 hours and to ~3-minute steps
// over the final two hours, ending at 01:36:44 UTC -- the exact instant the
// live sampler sent "BTW keeps rising, +4.1%" while the asset was 7% below
// where it had traded an hour before. If a future change lets that headline
// come back, these tests fail.
import {
  pctChange, normaliseSeries, sampleAt, changeLadder, rangeContext,
  pathEfficiency, describeShape, summarise, formatSummary, formatHeadline, formatPct
} from './scripts/price-change.mjs';

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? '  ' + extra : ''}`); }
}
function near(a, b, tol = 0.05) { return Number.isFinite(a) && Math.abs(a - b) <= tol; }

// --- the fixture -----------------------------------------------------------
const BTW = [
  [1789261207750, 0.549568], [1789264457190, 0.553490], [1789268053703, 0.553651],
  [1789271646843, 0.553081], [1789275256705, 0.549712], [1789278843390, 0.550547],
  [1789282456621, 0.553192], [1789286046357, 0.555431], [1789289650037, 0.552302],
  [1789293241376, 0.594986], [1789296849646, 0.567587], [1789300459478, 0.685343],
  [1789304046454, 0.643234], [1789307655898, 0.666602], [1789311250229, 0.706902],
  [1789314843669, 0.673330], [1789318446137, 0.690714], [1789322042465, 0.699075],
  [1789325647359, 0.700487], [1789329262396, 0.711814], [1789332848193, 0.709480],
  [1789336440556, 0.728491], [1789340051766, 0.724536],
  [1789342394683, 0.736144], [1789342573154, 0.738969], [1789342751640, 0.735632],
  [1789342936695, 0.735074], [1789343118948, 0.735623], [1789343296035, 0.734921],
  [1789343475621, 0.737005], [1789343655376, 0.737894], [1789343821598, 0.734888],
  [1789344019710, 0.733824], [1789344182994, 0.732730], [1789344367093, 0.735453],
  [1789344544835, 0.735380], [1789344727955, 0.738745], [1789344905421, 0.739254],
  [1789345086579, 0.739703], [1789345271007, 0.735624], [1789345451233, 0.730173],
  [1789345635765, 0.731456], [1789345812785, 0.733967], [1789345995280, 0.728745],
  [1789346175405, 0.727620], [1789346361040, 0.730509], [1789346524184, 0.731945],
  [1789346723477, 0.730936], [1789346882343, 0.731706], [1789347061239, 0.719982],
  [1789347247322, 0.724926], [1789347432018, 0.728771], [1789347615099, 0.721536],
  [1789347797434, 0.697981], [1789347976501, 0.693689], [1789348154881, 0.698976],
  [1789348321422, 0.690767], [1789348502619, 0.683454], [1789348684347, 0.676507],
  [1789348861172, 0.672831], [1789349049211, 0.666563], [1789349226279, 0.664522],
  [1789349407082, 0.662414], [1789349599475, 0.669813], [1789349776787, 0.685000]
].map(([ts, price]) => ({ ts, price }));
const NOW = 1789349776787;   // 2026-09-14T01:36:16Z, the alert instant

console.log('\n-- primitives --');
check('pctChange is signed and scaled', near(pctChange(100, 110), 10));
check('pctChange refuses a zero base', pctChange(0, 5) === null);
check('pctChange refuses non-numbers', pctChange('a', 5) === null);
check('normaliseSeries sorts and drops junk',
  normaliseSeries([{ ts: 2, price: 1 }, null, { ts: 1, price: 2 }, { ts: 3, price: 0 }]).length === 2);
check('normaliseSeries accepts mark_price and run_at',
  normaliseSeries([{ run_at: '2026-01-01T00:00:00Z', mark_price: 5 }])[0].price === 5);
check('sampleAt reports how far it missed by',
  sampleAt(BTW, NOW - 3600000).driftMs < 120000);

console.log('\n-- the ladder states every anchor --');
const ladder = changeLadder(BTW, { nowTs: NOW, horizonsMin: [15, 60, 360, 1440] });
const by = Object.fromEntries(ladder.map((r) => [r.minutes, r]));
check('a rung carries the anchor price it used', by[60].anchorPrice > 0);
check('a rung carries the anchor timestamp it used', by[60].anchorTs < NOW);
check('15m rung is available from 3-minute data', by[15].available === true);
check('every horizon asked for comes back', ladder.length === 4);

console.log('\n-- the BTW failure itself --');
// The live alert said "+4.1%, keeps rising". Both of these are true at once,
// and reporting only the first is the bug.
check('short clock really is up (this is what the old alert saw)', by[15].pct > 0, `got ${formatPct(by[15].pct)}`);
check('one-hour clock is sharply down', by[60].pct < -5, `got ${formatPct(by[60].pct)}`);
const sum = summarise(BTW, { nowTs: NOW, rangeWindowMin: 360 });
check('summarise flags the horizons as disagreeing', sum.agreement === 'mixed');
check('direction is taken from the fastest clock, not the longest', sum.directionHorizonMin === 15);
const head = formatHeadline(sum, { symbol: 'BTW' });
check('headline refuses to claim a plain rise', !/and up across the board/.test(head), head);
check('headline says it is reversing', /reversing/.test(head), head);

console.log('\n-- range context is a different quantity from point-to-point --');
const rng = rangeContext(BTW, { nowTs: NOW, windowMin: 360 });
check('range knows its high and low', rng.high > rng.low);
check('price sits below the 6h high', rng.fromHighPct < 0, `got ${formatPct(rng.fromHighPct)}`);
check('price sits above the 6h low', rng.fromLowPct > 0, `got ${formatPct(rng.fromLowPct)}`);
check('position is between 0 and 1', rng.position >= 0 && rng.position <= 1);
check('excursion from the low and change vs 1h ago disagree in sign here',
  Math.sign(rng.fromLowPct) !== Math.sign(by[60].pct));

console.log('\n-- path shape separates a move from a round trip --');
const eff = pathEfficiency(BTW, { nowTs: NOW, windowMin: 360 });
check('travelled is at least the net distance', eff.travelledPct >= Math.abs(eff.netPct) - 1e-9);
check('ratio is a fraction', eff.ratio >= 0 && eff.ratio <= 1);
check('describeShape is monotone', describeShape(0.9) === 'one-way' && describeShape(0.01) === 'round trip');
check('a straight line reads one-way',
  describeShape(pathEfficiency([{ts:0,price:10},{ts:60000,price:11},{ts:120000,price:12}], { windowMin: 10 }).ratio) === 'one-way');
check('a there-and-back reads round trip',
  describeShape(pathEfficiency([{ts:0,price:10},{ts:60000,price:12},{ts:120000,price:10}], { windowMin: 10 }).ratio) === 'round trip');

console.log('\n-- honest degradation when the data cannot answer --');
const hourly = BTW.filter((p) => p.ts < 1789342000000);   // ~1 point/hour
const coarse = changeLadder(hourly, { nowTs: hourly[hourly.length - 1].ts, horizonsMin: [15, 60, 1440] });
const c15 = coarse.find((r) => r.minutes === 15);
check('a 15-minute rung is refused on hourly data rather than faked', c15.available === false);
check('the 60-minute rung still answers on hourly data',
  coarse.find((r) => r.minutes === 60).available === true);
check('an anchor that drifted is marked inexact or absent',
  coarse.every((r) => !r.available || r.exact || Number.isFinite(r.actualMinutes)));
check('an empty series returns nothing rather than zero', summarise([], { nowTs: NOW }) === null);
check('a one-point series returns nothing rather than zero',
  summarise([{ ts: NOW, price: 1 }], { nowTs: NOW }) === null);

console.log('\n-- the rendered alert --');
const body = formatSummary(sum, { symbol: 'BTW' });
check('body names every horizon it reports', /vs 15m ago/.test(body) && /vs 1h ago/.test(body));
check('body warns when the horizons disagree', /disagree/.test(body));
check('body carries the range line', /range:/.test(body));
check('body carries the path line', /Path over/.test(body));
check('user-facing copy has no em dashes', !body.includes('—') && !head.includes('—'));

console.log('\n--- rendered for eyeballing ---\n' + head + '\n' + body + '\n');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
