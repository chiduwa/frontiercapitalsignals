// Plain-Node test suite, no framework — matches the other bots' style.
// Covers the pure selection/trigger/sizing maths only (no Binance, no D1).
process.env.BINANCE_SPOT_API_KEY = 'test';
process.env.BINANCE_SPOT_API_SECRET = 'test';
process.env.CLOUDFLARE_API_TOKEN = 'test';
process.env.CLOUDFLARE_ACCOUNT_ID = 'test';
process.env.FCS_D1_DATABASE_ID = 'test';

const { config } = await import('./src/config.mjs');
const { selectAssets, weeklyProfile, evaluateTrigger, tranchePool, trancheDue, periodsElapsed, allocate } = await import('./src/strategy.mjs');

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`); }
};

// Weekly candles with a controllable shape. Default: flat 100 closes with a
// 5% intra-week dip, so sigma and typical drawdown are both well defined.
const mkKlines = (n, fn) => Array.from({ length: n }, (_, i) => {
  const base = fn ? fn(i) : 100;
  return { openTime: i, open: base, high: base * 1.02, low: base * 0.95, close: base, closeTime: i };
});

console.log('== weeklyProfile: measured from completed candles only ==');
const wobbly = mkKlines(30, (i) => 100 * (1 + 0.03 * Math.sin(i)));
const prof = weeklyProfile(wobbly);
check('a long enough history produces a profile', prof.ok, JSON.stringify(prof).slice(0, 120));
check('weekly sigma is positive', prof.weeklySigma > 0);
check('typical drawdown is negative (open -> low)', prof.typicalDrawdown < 0, String(prof.typicalDrawdown));
check('typical drawdown matches the constructed 5% dip', Math.abs(prof.typicalDrawdown + 0.05) < 1e-9);
// The in-progress week must shape no statistic — otherwise a partial candle
// biases the very bar the trigger is judged against.
check('the in-progress week is excluded from the statistics', prof.weeks === wobbly.length - 1, String(prof.weeks));
check('the last completed close is the second-to-last candle',
  prof.lastCompletedClose === wobbly[wobbly.length - 2].close);
check('the current week open comes from the in-progress candle',
  prof.currentWeekOpen === wobbly[wobbly.length - 1].open);

console.log('\n== weeklyProfile: refuses to guess without evidence ==');
check('too little history is refused, with a reason',
  (() => { const p = weeklyProfile(mkKlines(5)); return !p.ok && p.reason.includes('needs'); })());
const varyMin = (n) => mkKlines(n, (i) => 100 + (i % 2 ? 2 : -2));
check(`exactly the minimum (${config.minWeeksHistory}) plus the live week is accepted`,
  weeklyProfile(varyMin(config.minWeeksHistory + 1)).ok);
check('one candle short is refused', !weeklyProfile(varyMin(config.minWeeksHistory)).ok);
// A perfectly flat series has no dispersion, so "a significant drop" has no
// meaning for it. Abstain rather than divide by a zero sigma.
check('a flat, dispersion-free history is refused rather than trusted',
  !weeklyProfile(mkKlines(30, () => 100).map((k) => ({ ...k, low: k.open }))).ok);
check('a non-array is refused', !weeklyProfile(null).ok);

console.log('\n== evaluateTrigger: buy only on this asset\'s own standard ==');
// Flat 100 closes, 5% weekly dips. sigma of returns is ~0, so use a series
// with real return dispersion for the drop test.
const varied = mkKlines(40, (i) => 100 + (i % 2 ? 6 : -6));
const vp = weeklyProfile(varied);
check('a profile with real return dispersion is usable', vp.ok && vp.weeklySigma > 0.01, String(vp.weeklySigma));

const farAbove = evaluateTrigger(vp.lastCompletedClose * 1.10, vp);
check('a price well above last close does not buy', !farAbove.buy);
check('the skip carries the numbers behind it', farAbove.reason.includes('needs'));

const bigDrop = evaluateTrigger(vp.lastCompletedClose * (1 - 3 * vp.weeklySigma), vp);
check('a drop past the sigma bar buys', bigDrop.buy && bigDrop.trigger === 'significant-drop', JSON.stringify(bigDrop));

// The other door: price reaching the level this asset routinely trades down
// to within a week. That is an observation, not a forecast.
const atTypicalLow = evaluateTrigger(vp.currentWeekOpen * (1 + vp.typicalDrawdown), vp);
check('reaching the typical weekly low buys', atTypicalLow.buy && atTypicalLow.trigger === 'weekly-low-reached', JSON.stringify(atTypicalLow));
const justAbove = evaluateTrigger(vp.currentWeekOpen * (1 + vp.typicalDrawdown) * 1.001, vp);
check('just above that level does not buy', !justAbove.buy);

check('no profile means no buy', !evaluateTrigger(100, { ok: false, reason: 'x' }).buy);
check('no price means no buy', !evaluateTrigger(0, vp).buy);
// Sigma scales the bar to the asset: the same percentage drop must NOT trigger
// on a placid asset and a volatile one alike.
const calm = weeklyProfile(mkKlines(40, (i) => 100 + (i % 2 ? 0.5 : -0.5)));
// Built directly so the two doors don't interfere: identical price, identical
// typical drawdown, only sigma differs. A fixed percentage bar would treat
// these two assets the same; a per-asset bar must not.
const mkProfile = (sigma) => ({
  ok: true, weeklySigma: sigma, typicalDrawdown: -0.05, medianWeeklyReturn: 0,
  lastCompletedClose: 100, currentWeekOpen: 100, weeks: 30
});
const drop3pct = 97; // 3% below last close; both projected lows sit at 95
check('a 3% drop clears a calm asset\'s own 1σ bar', (() => {
  const r = evaluateTrigger(drop3pct, mkProfile(0.01));
  return r.buy && r.trigger === 'significant-drop';
})());
check('the same 3% drop does NOT clear a volatile asset\'s 1σ bar', (() => {
  const r = evaluateTrigger(drop3pct, mkProfile(0.12));
  return !r.buy;
})(), 'for this asset 3% is ordinary noise, not a significant drop');
check('the volatile asset still buys once it reaches its own typical weekly low',
  evaluateTrigger(95, mkProfile(0.12)).trigger === 'weekly-low-reached');

console.log('\n== tranchePool: deferral derived from the clock, not an accumulator ==');
const t0 = tranchePool(1000, 1);
check('the base tranche is the configured fraction of free balance',
  Math.abs(t0.base - 1000 * config.tranchePct) < 1e-9, JSON.stringify(t0));
check('a due-now cycle carries nothing extra', t0.carryTranches === 0 && Math.abs(t0.pool - t0.base) < 1e-9);
check('one skipped period adds exactly one tranche',
  Math.abs(tranchePool(1000, 2).pool - t0.base * 2) < 1e-9);
check('carry is capped at maxCarryTranches',
  tranchePool(1000, 99).carryTranches === config.maxCarryTranches);
// The bug this design removes: the bot fires several times a day, so an
// accumulator would grow per FIRING while a tranche sat due, not per period.
check('repeated firings within one period cannot inflate the pool', (() => {
  const a = tranchePool(1000, 1).pool;
  const b = tranchePool(1000, 1).pool; // same elapsed time, later firing
  return a === b;
})(), 'the pool is a function of elapsed time only');
check('the pool never exceeds what is actually free', tranchePool(10, 99).pool <= 10 + 1e-9);
check('a reserve is withheld from the spendable balance',
  Math.abs(tranchePool(1000, 1, { reserveQuote: 500 }).base - 500 * config.tranchePct) < 1e-9);
check('an empty balance yields nothing to spend', tranchePool(0, 5).pool === 0);
check('a not-yet-due cycle carries nothing', tranchePool(1000, 0).carryTranches === 0);

console.log('\n== periodsElapsed / trancheDue: elapsed days, not a cron expression ==');
const now = Date.parse('2026-09-20T00:00:00Z');
check('a first run is due', trancheDue(null, now) && periodsElapsed(null, now) === 1);
check('an unparseable marker is treated as due', trancheDue('not-a-date', now));
check('one day after a tranche is not due', !trancheDue('2026-09-19T00:00:00Z', now));
check('a full period later is due', trancheDue('2026-09-13T00:00:00Z', now));
check('two full periods report two elapsed, so the pool doubles',
  periodsElapsed('2026-09-06T00:00:00Z', now) === 2);
check('a long gap is bounded by the carry cap, not backfilled indefinitely',
  tranchePool(1000, periodsElapsed('2026-01-01T00:00:00Z', now)).carryTranches === config.maxCarryTranches);

console.log('\n== selectAssets: descriptive measures only ==');
const tradable = {
  BTCUSDT: {}, ETHUSDT: {}, SOLUSDT: {}, ATOMUSDT: {}, PIUSDT: {}, NEXOUSDT: {}
  // KCSUSDT deliberately absent: on the signals board, not listed on Binance.
};
const mkRow = (symbol, mcapRank, quality, extra = {}) =>
  ({ symbol, name: symbol, mcapRank, quality: { score: quality }, price: 1, ...extra });
const payload = {
  crypto: {
    breakout: [mkRow('BTC', 1, 80), mkRow('ETH', 2, 75), mkRow('SOL', 6, 70)],
    breakdown: [mkRow('KCS', 72, 95)],
    favorites: [mkRow('NEXO', 82, 60)],
    longTermPotential: [mkRow('ATOM', 84, 78), mkRow('PI', 70, 65)]
  }
};
const picks = selectAssets(payload, tradable);
const bySym = Object.fromEntries(picks.map((p) => [p.signalSymbol, p]));
check('an asset with no Binance spot pair is excluded however good it looks',
  !bySym.KCS, 'KCS has the highest quality on the board but is not listed here');
check('large caps land in the core sleeve', bySym.BTC?.sleeve === 'core' && bySym.ETH?.sleeve === 'core');
check('small caps land in the satellite sleeve',
  bySym.ATOM?.sleeve === 'satellite' && bySym.PI?.sleeve === 'satellite' && bySym.NEXO?.sleeve === 'satellite');
check('being near a genuine multi-month low is carried through',
  bySym.ATOM?.nearMultiMonthLow === true && bySym.BTC?.nearMultiMonthLow === false);
check('the satellite sleeve is capped at its configured count',
  picks.filter((p) => p.sleeve === 'satellite').length <= config.satelliteCount);
check('core weights sum to the core sleeve weight', (() => {
  const sum = picks.filter((p) => p.sleeve === 'core').reduce((a, p) => a + p.weight, 0);
  return Math.abs(sum - config.coreWeight) < 1e-9;
})());
check('satellite weights sum to the remainder', (() => {
  const sum = picks.filter((p) => p.sleeve === 'satellite').reduce((a, p) => a + p.weight, 0);
  return Math.abs(sum - (1 - config.coreWeight)) < 1e-9;
})());
// The core screen coming up short must NOT inflate the unvalidated sleeve.
check('a thin core sleeve does not redistribute weight to satellites', (() => {
  const thin = selectAssets({ crypto: { breakout: [mkRow('BTC', 1, 80)], longTermPotential: [mkRow('ATOM', 84, 78)] } }, tradable);
  const sat = thin.filter((p) => p.sleeve === 'satellite').reduce((a, p) => a + p.weight, 0);
  return Math.abs(sat - (1 - config.coreWeight)) < 1e-9;
})(), 'unspent core weight stays in powder rather than buying more of the risky sleeve');
check('an asset with no published quality percentile is not ranked', (() => {
  const noq = selectAssets({ crypto: { breakout: [{ symbol: 'BTC', mcapRank: 1, price: 1 }] } }, tradable);
  return noq.length === 0;
})());
check('duplicates across boards are counted once',
  picks.filter((p) => p.signalSymbol === 'BTC').length === 1);
check('an empty universe selects nothing rather than defaulting', selectAssets({}, tradable).length === 0);
// The whole point: a withheld directional call must not leak into selection.
check('selection never reads dir, score or confidence', (() => {
  const withDir = JSON.parse(JSON.stringify(payload));
  for (const b of Object.values(withDir.crypto)) for (const r of b) { r.dir = -1; r.score = 0; r.confidence = null; r.abstained = { reason: 'insufficient-evidence' }; }
  const a = selectAssets(withDir, tradable).map((p) => p.signalSymbol).sort().join(',');
  const b = picks.map((p) => p.signalSymbol).sort().join(',');
  return a === b;
})(), 'withheld rows must select identically to authorized ones');

console.log('\n== allocate: a real order beats nine rejected ones ==');
const min5 = () => 5;
const mk = (sym, sleeve) => ({ symbol: sym, sleeve });
const nine = [
  mk('BTCUSDT','core'), mk('ETHUSDT','core'), mk('HBARUSDT','core'),
  mk('UNIUSDT','core'), mk('GRAMUSDT','core'), mk('ZECUSDT','core'),
  mk('ATOMUSDT','satellite'), mk('RENDERUSDT','satellite'), mk('NEXOUSDT','satellite')
];
// The live case: $13.17 across 9 assets is $1.46 each against a $5 floor.
// Splitting evenly would have every order rejected as dust.
const small = allocate(nine, 13.17, min5);
check('a small pool concentrates instead of producing dust', small.length === 2, JSON.stringify(small.map(a=>[a.symbol,a.quote.toFixed(2)])));
check('every funded share clears the minimum', small.every((a) => a.quote >= 5));
check('the whole pool is committed, nothing stranded',
  Math.abs(small.reduce((t,a)=>t+a.quote,0) - 13.17) < 1e-9);
check('concentration follows rank, core sleeve first',
  small.every((a) => a.sleeve === 'core'));
// As the balance grows, k rises on its own and it spreads back out.
check('a large pool funds every triggered asset', allocate(nine, 500, min5).length === 9);
check('a large pool splits evenly',
  Math.abs(allocate(nine, 450, min5)[0].quote - 50) < 1e-9);
check('a pool below even one minimum funds nothing rather than sending dust',
  allocate(nine, 3, min5).length === 0);
check('exactly one minimum funds exactly one asset', (() => {
  const r = allocate(nine, 5, min5);
  return r.length === 1 && r[0].quote === 5;
})());
// Pairs have different floors; each must clear its OWN.
check('a pair with a higher floor is not funded below it', (() => {
  const perPair = (s) => (s === 'BTCUSDT' ? 100 : 5);
  const r = allocate([mk('BTCUSDT','core'), mk('ETHUSDT','core')], 20, perPair);
  return r.length === 1 && r[0].symbol === 'ETHUSDT' && r[0].quote === 20;
})(), 'BTC needs 100, so fund ETH alone with the full pool');
check('satellites are funded once the pool is big enough for the core too',
  allocate(nine, 90, min5).some((a) => a.sleeve === 'satellite'));
check('no triggers means no allocation', allocate([], 100, min5).length === 0);
check('a zero pool allocates nothing', allocate(nine, 0, min5).length === 0);

console.log(failures === 0 ? '\nSPOT BOT OK\n' : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
