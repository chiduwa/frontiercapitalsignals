// Tests for the live flush classifier (scripts/oi-sampler.mjs) and the
// event-shape logic it shares with the research module.
//
// The classifier encodes one empirical finding — OI direction during a violent
// move predicts whether it retraces — so these tests pin the finding's SIGN as
// much as the code. If someone ever inverts the mapping, this fails loudly.
//
// 2026-09-14: the unit of open interest changed from dollar value to CONTRACTS,
// because dollar value is contracts x mark price and therefore carries the
// price move inside it (r = 0.910 over 804k bars). The fixtures below now set
// both columns, and several set them in OPPOSITE directions on purpose: that is
// the case the old code got wrong in production.
import { classifyMove, detectMove, shouldAlert, buildAlert, EXPECTED_RECOVERY, MOVE_PCT_TRIGGER,
  OI_DECISIVE_CONTRACTS_PCT, ALERT_COOLDOWN_MIN, decomposeOi, formatOiVsPrice } from './scripts/oi-sampler.mjs';
import { findFlushes, dedupeEpisodes } from './scripts/flush-research.mjs';
import { planEntry, continuationCall, ENTRY_DEPTH_PCT, STOP_DEPTH_PCT } from './scripts/flush-entry.mjs';

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const now = Date.now();
// oiContracts defaults to tracking oiUsd so the pre-existing fixtures keep
// meaning what they meant; tests that need the two to disagree pass both.
const tick = (minsAgo, oiUsd, price, oiContracts = oiUsd) =>
  ({ ts: now - minsAgo * 60000, oi_usd: oiUsd, oi_contracts: oiContracts, mark_price: price });

console.log('\n== classification maps OI direction to the MEASURED outcome ==');
check('OI falling through a move is liquidation', classifyMove(-3) === 'liquidation');
check('OI rising through a move is new positioning', classifyMove(3) === 'new-position');
check('a small OI change decides nothing', classifyMove(0.2) === 'ambiguous');
check('the decisive cut is on the contracts scale, not the notional one',
  OI_DECISIVE_CONTRACTS_PCT < 1 && classifyMove(0.3) === 'new-position',
  `cut=${OI_DECISIVE_CONTRACTS_PCT}`);
check('missing OI decides nothing', classifyMove(null) === 'ambiguous' && classifyMove(NaN) === 'ambiguous');
// The sign of the finding, pinned. Liquidation recovers LESS, which is the
// opposite of the intuition the study was built to test.
check('liquidation expects a WEAKER retrace than new-position',
  EXPECTED_RECOVERY.liquidation < EXPECTED_RECOVERY['new-position'],
  `${EXPECTED_RECOVERY.liquidation} vs ${EXPECTED_RECOVERY['new-position']}`);
check('new-position expects a FULL retrace (>=100%)', EXPECTED_RECOVERY['new-position'] >= 1);
check('liquidation expects roughly half back', EXPECTED_RECOVERY.liquidation > 0.4 && EXPECTED_RECOVERY.liquidation < 0.6);

console.log('\n== direction comes from time order, not magnitude ==');
// The regression this exists for: comparing (low/high - 1) against
// (high/low - 1) makes the down branch unreachable, because the latter is
// always larger. A 100 -> 94 collapse was being reported as an UP move.
const drop = detectMove([tick(5, 1000e6, 100), tick(2.5, 980e6, 97), tick(0, 940e6, 94)]);
check('a 100 -> 94 collapse is a DOWN move', drop && drop.direction === 'down', JSON.stringify(drop));
check('its magnitude is negative', drop && drop.movePct < 0, String(drop && drop.movePct));
check('its reference is the pre-drop high', drop && drop.refPrice === 100);
const spike = detectMove([tick(5, 1000e6, 94), tick(2.5, 1030e6, 97), tick(0, 1060e6, 100)]);
check('a 94 -> 100 run is an UP move', spike && spike.direction === 'up', JSON.stringify(spike));
check('its reference is the pre-spike low', spike && spike.refPrice === 94);

console.log('\n== the four quadrants classify independently of direction ==');
check('drop + OI falling  -> liquidation', drop.classification === 'liquidation');
check('drop + OI rising   -> new-position',
  detectMove([tick(5, 1000e6, 100), tick(2.5, 1030e6, 96), tick(0, 1060e6, 94)]).classification === 'new-position');
check('spike + OI rising  -> new-position', spike.classification === 'new-position');
check('spike + OI falling -> liquidation',
  detectMove([tick(5, 1000e6, 94), tick(2.5, 980e6, 97), tick(0, 940e6, 100)]).classification === 'liquidation');

console.log('\n== abstaining ==');
check('a quiet tape produces no event',
  detectMove([tick(2, 1e9, 100), tick(1, 1e9, 100.2), tick(0, 1e9, 100.1)]) === null);
check('a move below the trigger produces no event',
  detectMove([tick(5, 1e9, 100), tick(0, 1e9, 100 - (MOVE_PCT_TRIGGER / 2))]) === null);
check('too few ticks produce no event', detectMove([tick(1, 1e9, 100)]) === null);
check('no ticks at all produce no event', detectMove([]) === null && detectMove(null) === null);
check('a move with no OI history is ambiguous, not guessed',
  detectMove([tick(5, 0, 100), tick(2.5, 0, 97), tick(0, 0, 94)])?.classification === 'ambiguous');

console.log('\n== research module: up and down are symmetric ==');
const bars = [];
for (let i = 0; i < 120; i++) bars.push({ t: now + i * 60000, o: 100, h: 100, l: 100, c: 100, v: 10, trades: 5, takerBuyBase: 5 });
// carve a 10% dip at minute 40, recovering by minute 60
for (let i = 40; i < 45; i++) { bars[i].l = 90; bars[i].c = 90; }
for (let i = 45; i < 60; i++) { bars[i].h = 99; bars[i].c = 99; }
const downs = findFlushes(bars, null, { direction: 'down' });
check('a 10% dip is found as a down event', downs.length === 1 && downs[0].dropPct < -9, JSON.stringify(downs.map(d => d.dropPct)));
check('the down event records a recovery fraction', downs[0].recovered > 0.8 && downs[0].recovered <= 1.1, String(downs[0].recovered));
check('forward outcomes are captured for trend-vs-noise', 'fwd1h' in downs[0] && 'fwd12h' in downs[0]);
check('pre-event features are captured', 'preVol' in downs[0] && 'preOiTrend' in downs[0] && 'hourUtc' in downs[0]);
const ups = findFlushes(bars, null, { direction: 'up' });
check('scanning up alone DOES see the rebound (this is why dedupe is needed)', ups.length === 1);
const merged = dedupeEpisodes([...downs, ...ups]);
check('dedupe collapses the dip and its rebound into ONE episode', merged.length === 1,
  JSON.stringify(merged.map((m) => `${m.direction} ${m.dropPct.toFixed(1)}%`)));
check('dedupe keeps the larger leg', Math.abs(merged[0].dropPct) >= 10, String(merged[0].dropPct));
check('dedupe leaves genuinely separate episodes alone', dedupeEpisodes([
  { t: now, dropPct: -8, direction: 'down' },
  { t: now + 90 * 60000, dropPct: -9, direction: 'down' }
]).length === 2);

console.log('\n== entry planner: two trades, two refusals ==');
const mk = (direction, classification) => ({
  direction, classification, refPrice: 100,
  extremePrice: direction === 'down' ? 91.5 : 109,
  movePct: direction === 'down' ? -8.5 : 9,
  oiChangePct: classification === 'liquidation' ? -5 : 5, symbol: 'TEST'
});
const buy = planEntry(mk('down', 'liquidation'));
const sell = planEntry(mk('up', 'liquidation'));
check('dip + OI falling is a BUY', buy.ok && buy.side === 'BUY');
check('entry sits BELOW the reference', buy.entryPrice < buy.refPrice, String(buy.entryPrice));
check('entry is at the measured depth, not a round 5%', Math.abs(buy.depthPct - ENTRY_DEPTH_PCT) < 1e-9);
check('stop is below the entry', buy.stopPrice < buy.entryPrice);
check('target sits between entry and reference', buy.targetPrice > buy.entryPrice && buy.targetPrice < buy.refPrice);
// Against the entry-to-stop distance, not STOP_DEPTH_PCT. The latter is
// measured from the pre-move reference and the entry already sits part of the
// way there, so multiplying it by leverage overstates the margin cost — the
// same conflation that set the original cap too low.
check('the stop still triggers before liquidation at max leverage',
  (100 / buy.maxLeverage) > buy.riskPct,
  `${buy.maxLeverage}x liquidates at ${(100 / buy.maxLeverage).toFixed(1)}% vs a ${buy.riskPct.toFixed(2)}% stop`);
// The two sides do NOT have the same buffer, and the difference is real.
// The buy entry sits 8% below the reference with its stop at 15% below, so
// entry-to-stop is 7.61%; the sell entry is 8% above with its stop 15% above,
// giving 6.48%. At 8x that is 1.64x of room for the buy and 1.93x for the
// sell. The live executor trades ONLY the sell, which is the side that clears
// the 1.75x floor — so the floor is asserted there, and the buy side is held
// to ordering alone with the gap recorded rather than hidden.
// The buffer was DELIBERATELY REDUCED on 2026-09-12 when the stop was widened
// from 15% to 18% to hold losers longer. That is a real reduction in safety
// margin, not a tuning improvement, and these assertions record it rather than
// hide it: the sell buffer went 1.93x -> 1.35x and the buy side 1.64x -> 1.15x.
//
// The NON-NEGOTIABLE invariant is the ordering — the stop must still trigger
// before the exchange liquidates. Below 1.0 the stop is decoration and a loss
// becomes a full-margin liquidation instead of a controlled exit.
check('the traded (sell) stop still triggers before liquidation',
  (100 / sell.maxLeverage) > sell.riskPct,
  `liquidation ${(100 / sell.maxLeverage).toFixed(2)}% vs stop ${sell.riskPct.toFixed(2)}%`);
check('the traded (sell) side keeps the reduced-but-documented buffer',
  (100 / sell.maxLeverage) / sell.riskPct >= 1.25,
  `sell buffer ${((100 / sell.maxLeverage) / sell.riskPct).toFixed(2)}x (was 1.93x before the stop was widened)`);
check('the untraded (buy) side is thinner still, and is NOT what the executor trades',
  (100 / buy.maxLeverage) / buy.riskPct > 1.0,
  `buy buffer ${((100 / buy.maxLeverage) / buy.riskPct).toFixed(2)}x — sell-only executor, so theoretical`);
// The time exit is disabled at the operator's direction: positions are held to
// target, stop or manual close. null is the intended value, not a bug — but it
// must be an explicit null rather than an accidental undefined, so a missing
// field cannot pass for a deliberate choice.
check('the hold limit is explicitly disabled, not accidentally absent',
  buy.maxHoldMinutes === null, `got ${String(buy.maxHoldMinutes)}`);

check('spike + OI falling is a SELL', sell.ok && sell.side === 'SELL');
check('sell entry sits ABOVE the reference', sell.entryPrice > sell.refPrice);
check('sell stop is above the sell entry', sell.stopPrice > sell.entryPrice);

const refusedBuy = planEntry(mk('down', 'new-position'));
check('dip + OI RISING is refused for longs', refusedBuy.ok === false);
check('...and names the trend risk, not a generic reason', /new shorts/i.test(refusedBuy.reason));
check('...and flags the opposite side instead', refusedBuy.contraSignal === 'SELL');
const refusedSell = planEntry(mk('up', 'new-position'));
check('spike + OI RISING is refused for shorts', refusedSell.ok === false && refusedSell.contraSignal === 'BUY');

check('ambiguous OI abstains rather than guessing', planEntry(mk('down', 'ambiguous')).ok === false);
check('a missing move abstains', planEntry(null).ok === false);
check('a move with no reference price abstains',
  planEntry({ direction: 'down', classification: 'liquidation', refPrice: 0 }).ok === false);

console.log('\n== the continuation claim is withdrawn, not re-fitted ==');
check('liquidation moves still raise no continuation record',
  continuationCall(mk('down', 'liquidation')) === null && continuationCall(mk('up', 'liquidation')) === null);
check('it no longer asserts a 12h median',
  continuationCall(mk('up', 'new-position')).median12hPct === null);
check('it marks itself unproven',
  continuationCall(mk('up', 'new-position')).proven === false);
check('it no longer promises the move keeps going',
  !/keeps (rising|falling)/.test(continuationCall(mk('up', 'new-position')).expectation));
check('it says why the old claim is gone',
  /dollar value/i.test(continuationCall(mk('down', 'new-position')).caution));

console.log('\n== open interest is read in contracts, not dollar value ==');
// BTW, 2026-09-14 01:31:44 to 01:36:44 UTC, the real numbers. Price +4.2%,
// notional +4.07%, contracts -0.16%. The old code called this "new-position"
// and sent "BTW keeps rising" while BTW was 7% below its price an hour before.
const btw = detectMove([
  tick(5, 105581000, 0.65745, 160591513),
  tick(3, 106246000, 0.66238, 160399670),
  tick(0, 109875000, 0.68527, 160337695)
]);
check('the BTW window is detected as an up move', btw && btw.direction === 'up');
check('its notional OI reading is strongly positive', btw.oiNotionalChangePct > 3.5,
  String(btw.oiNotionalChangePct));
check('its contracts OI reading is NEGATIVE', btw.oiChangePct < 0, String(btw.oiChangePct));
check('so it is no longer called new positioning', btw.classification !== 'new-position',
  btw.classification);
check('and it raises no continuation record at all',
  continuationCall({ ...btw, symbol: 'BTW' }) === null);
check('the notional reading is kept for the archive', Number.isFinite(btw.oiNotionalChangePct));

console.log('\n== the OI change is anchored to the move, not to the sample window ==');
// Six ticks where the first two predate the move's reference low. Anchoring to
// the window's first tick would measure OI across a span the move did not
// cover.
const anchored = detectMove([
  tick(6, 100e6, 100, 100e6), tick(5, 120e6, 99, 120e6),
  tick(4, 100e6, 94, 100e6),                                  // the reference low
  tick(2, 101e6, 97, 101e6), tick(0, 102e6, 100, 102e6)
]);
check('the reference is the low the move started from', anchored.refPrice === 94);
check('refTs points at that low', anchored.refTs === now - 4 * 60000);
check('OI is measured from the reference, not the window start',
  Math.abs(anchored.oiChangePct - 2) < 0.001, String(anchored.oiChangePct));

console.log('\n== one move does not become hundreds of alerts ==');
const ep = (id, pct) => ({ episodeId: id, movePct: pct, direction: 'up' });
check('the first sighting alerts', shouldAlert(null, ep('up|1', 5), now).alert === true);
check('the same move seen again does not re-alert',
  shouldAlert({ episodeId: 'up|1', movePct: 5, alertedAtMs: now }, ep('up|1', 5.5), now + 20000).alert === false);
check('the same move extending materially does re-alert',
  shouldAlert({ episodeId: 'up|1', movePct: 5, alertedAtMs: now }, ep('up|1', 10), now + 20000).alert === true);
check('a different move inside the cooldown stays quiet',
  shouldAlert({ episodeId: 'up|1', movePct: 5, alertedAtMs: now }, ep('up|2', 5), now + 60000).alert === false);
check('a different move after the cooldown alerts',
  shouldAlert({ episodeId: 'up|1', movePct: 5, alertedAtMs: now }, ep('up|2', 5),
    now + (ALERT_COOLDOWN_MIN + 1) * 60000).alert === true);
check('episode identity is stable while the reference stands',
  detectMove([tick(5, 1e9, 94), tick(2.5, 1.03e9, 97), tick(0, 1.06e9, 100)]).episodeId
  === detectMove([tick(5, 1e9, 94), tick(2.5, 1.03e9, 97), tick(1, 1.05e9, 99), tick(0, 1.06e9, 100)]).episodeId);
// The actual production failure: 20 seconds later, one more tick, brand new id.
check('a sliding window does not mint a new episode every tick',
  new Set([
    detectMove([tick(5, 1e9, 94), tick(2.5, 1.03e9, 97), tick(0, 1.06e9, 100)]).episodeId,
    detectMove([tick(5.3, 1e9, 94.1), tick(5, 1e9, 94), tick(2.5, 1.03e9, 97), tick(0, 1.06e9, 100)]).episodeId
  ]).size === 1);

console.log('\n== the alert a reader actually receives ==');
// Same BTW window, plus an hour of the collapse that preceded it, so the alert
// has the context the old one-number version could not carry.
const btwTicks = [
  tick(65, 118e6, 0.73629, 160981400), tick(60, 118e6, 0.73775, 161092100),
  tick(45, 110e6, 0.68730, 160973300), tick(30, 107e6, 0.66895, 160758900),
  tick(5, 105.58e6, 0.65745, 160591513), tick(3, 106.2e6, 0.66238, 160399670),
  tick(0, 109.88e6, 0.68527, 160337695)
];
const alert = buildAlert('BTW', detectMove(btwTicks), btwTicks, now);
check('the title does not claim the asset is rising', !/keeps rising/i.test(alert.title), alert.title);
check('the title flags the reversal', /reversing/.test(alert.title), alert.title);
check('the body states the 1h anchor explicitly', /vs 1h ago/.test(alert.body));
check('the body shows the 1h change as negative', /vs 1h ago: -/.test(alert.body));
check('the body separates excursion from point-to-point',
  /excursion from an extreme/.test(alert.body));
check('the body says open interest is counted in contracts', /contracts/.test(alert.body));
check('the body makes no continuation claim', !/keeps (rising|falling)/.test(alert.body));
check('the alert copy carries no em dashes', !alert.body.includes('—') && !alert.title.includes('—'));
console.log('\n--- rendered ---\n' + alert.title + '\n' + alert.body + '\n');

console.log('\n-- open interest shown against the price move --');
// The real BTW numbers from oi_tick over the five minutes ending 10:03:24 UTC
// on 2026-09-13, the detection the live executor placed an order on:
// contracts 162,210,487 -> 162,312,456, dollars 94,241,048.74 -> 98,394,955.13,
// mark 0.58098 -> 0.60620705.
const REAL = { contractsPct: (162312456 / 162210487 - 1) * 100, pricePct: (0.60620705 / 0.58098 - 1) * 100 };
const dec = decomposeOi(REAL);
check('the decomposition reproduces the dollar figure Binance reported',
  Math.abs(dec.notionalPct - (98394955.13 / 94241048.74 - 1) * 100) < 0.01,
  `${dec.notionalPct.toFixed(3)}% vs 4.408%`);
check('almost all of the dollar move is the price move', dec.priceShare > 0.98,
  `${(dec.priceShare * 100).toFixed(1)}%`);
check('the cross term is carried, not dropped', Math.abs(dec.cross) > 0 && Math.abs(dec.cross) < 0.1,
  `${dec.cross.toFixed(5)}`);
check('contracts and dollars are not the same number', Math.abs(dec.notionalPct - dec.fromContracts) > 4);
check('a missing price leaves the decomposition undefined rather than guessed',
  decomposeOi({ contractsPct: 1, pricePct: null }) === null);
check('identity holds for a pure contracts change with price flat',
  Math.abs(decomposeOi({ contractsPct: 3, pricePct: 0 }).notionalPct - 3) < 1e-9);
check('identity holds for a pure price change with contracts flat',
  Math.abs(decomposeOi({ contractsPct: 0, pricePct: 5 }).notionalPct - 5) < 1e-9);

const words = formatOiVsPrice({ oiChangePct: REAL.contractsPct, priceChangePct: REAL.pricePct });
check('the copy reports contracts', /in contracts/.test(words));
check('the copy reports the price move over the same span', /same span/.test(words));
check('the copy still reports the dollar figure', /In dollars/.test(words));
check('the copy attributes the dollar figure to both parts',
  /price contributed/.test(words) && /positions contributed/.test(words));
check('the copy calls this one price rather than positioning', /price, not positioning/.test(words));
check('the comparison copy carries no em dashes', !words.includes('\u2014'));
const positioning = formatOiVsPrice({ oiChangePct: 2.5, priceChangePct: 0.1 });
check('a real positioning change is described as one', /a real \nchange|a real change/.test(positioning)
  || /real/.test(positioning));
check('unmeasurable price degrades to contracts only, saying so',
  /cannot be compared/.test(formatOiVsPrice({ oiChangePct: 1, priceChangePct: null })));
console.log('\n--- the comparison, rendered ---\n' + words + '\n');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
