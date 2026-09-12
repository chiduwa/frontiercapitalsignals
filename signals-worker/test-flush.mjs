// Tests for the live flush classifier (scripts/oi-sampler.mjs) and the
// event-shape logic it shares with the research module.
//
// The classifier encodes one empirical finding — OI direction during a violent
// move predicts whether it retraces — so these tests pin the finding's SIGN as
// much as the code. If someone ever inverts the mapping, this fails loudly.
import { classifyMove, detectMove, EXPECTED_RECOVERY, MOVE_PCT_TRIGGER } from './scripts/oi-sampler.mjs';
import { findFlushes, dedupeEpisodes } from './scripts/flush-research.mjs';
import { planEntry, continuationCall, ENTRY_DEPTH_PCT, STOP_DEPTH_PCT } from './scripts/flush-entry.mjs';

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const now = Date.now();
const tick = (minsAgo, oiUsd, price) => ({ ts: now - minsAgo * 60000, oi_usd: oiUsd, mark_price: price });

console.log('\n== classification maps OI direction to the MEASURED outcome ==');
check('OI falling through a move is liquidation', classifyMove(-3) === 'liquidation');
check('OI rising through a move is new positioning', classifyMove(3) === 'new-position');
check('a small OI change decides nothing', classifyMove(0.2) === 'ambiguous');
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
check('with a buffer, not merely by ordering',
  (100 / buy.maxLeverage) / buy.riskPct >= 1.75,
  `buffer ${((100 / buy.maxLeverage) / buy.riskPct).toFixed(2)}x`);
check('the plan carries a hold limit', buy.maxHoldMinutes > 0 && buy.maxHoldMinutes <= 120);

const sell = planEntry(mk('up', 'liquidation'));
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

console.log('\n== continuation alerts fire only on rising open interest ==');
check('dip + OI rising -> "keeps falling"', continuationCall(mk('down', 'new-position')).expectation === 'keeps falling');
check('spike + OI rising -> "keeps rising"', continuationCall(mk('up', 'new-position')).expectation === 'keeps rising');
check('liquidation moves raise NO continuation alert',
  continuationCall(mk('down', 'liquidation')) === null && continuationCall(mk('up', 'liquidation')) === null);
check('the alert carries the measured 12h number',
  continuationCall(mk('up', 'new-position')).median12hPct === 10.82);
check('the falling alert warns that the bounce is bait',
  /bait/i.test(continuationCall(mk('down', 'new-position')).caution));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
