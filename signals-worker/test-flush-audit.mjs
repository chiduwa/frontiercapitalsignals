// Tests for scripts/flush-audit.mjs.
//
// The fixture is ten real flush_event rows for BTW on 2026-09-13, each joined
// to this project's own oi_tick table for the contracts, notional and mark
// price five minutes apart. Nothing here is constructed. The fourth-from-last
// row, BTW|1789293504013, is the detection the live flush executor acted on:
// it placed a real Binance SELL that failed only on quantity precision.
import { compareMeasures, OI_DECISIVE_CONTRACTS_PCT } from './scripts/flush-audit.mjs';
import { classifyMove } from './scripts/oi-sampler.mjs';

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? '  ' + extra : ''}`); }
}

const ROWS = [
  { id: 'BTW|1789293143291', symbol: 'BTW', direction: 'up', ref_price: 0.58098,
    c0: 162223976, c1: 162320505, u0: 95084892.24, u1: 97689349.52, p0: 0.58613341, p1: 0.60183 },
  { id: 'BTW|1789293181834', symbol: 'BTW', direction: 'up', ref_price: 0.58098,
    c0: 162222180, c1: 162268666, u0: 96588708.19, u1: 96558758.33, p0: 0.59541, p1: 0.59505486 },
  { id: 'BTW|1789293202060', symbol: 'BTW', direction: 'up', ref_price: 0.58098,
    c0: 162231120, c1: 162210487, u0: 96431800.04, u1: 94241048.74, p0: 0.59441, p1: 0.58098 },
  { id: 'BTW|1789293221551', symbol: 'BTW', direction: 'up', ref_price: 0.5820706,
    c0: 162240697, c1: 162222943, u0: 96379746.37, u1: 94425205.77, p0: 0.59405407, p1: 0.5820706 },
  { id: 'BTW|1789293463831', symbol: 'BTW', direction: 'up', ref_price: 0.58304213,
    c0: 162342857, c1: 162297499, u0: 98694700.25, u1: 97992404.30, p0: 0.6079399, p1: 0.60378259 },
  { id: 'BTW|1789293484290', symbol: 'BTW', direction: 'up', ref_price: 0.58304213,
    c0: 162268666, c1: 162306091, u0: 96558758.33, u1: 97913118.17, p0: 0.59505486, p1: 0.60326213 },
  { id: 'BTW|1789293504013', symbol: 'BTW', direction: 'up', ref_price: 0.58304213,
    c0: 162210487, c1: 162312456, u0: 94241048.74, u1: 98394955.13, p0: 0.58098, p1: 0.60620705 },
  { id: 'BTW|1789293523748', symbol: 'BTW', direction: 'up', ref_price: 0.58304213,
    c0: 162222943, c1: 162290248, u0: 94425205.77, u1: 94622051.87, p0: 0.5820706, p1: 0.58304213 },
  { id: 'BTW|1789294779048', symbol: 'BTW', direction: 'up', ref_price: 0.50475,
    c0: 161815372, c1: 161665539, u0: 90708339.84, u1: 84437953.05, p0: 0.56056689, p1: 0.52230026 },
  { id: 'BTW|1789294794329', symbol: 'BTW', direction: 'up', ref_price: 0.50475,
    c0: 161815372, c1: 161648662, u0: 90708339.84, u1: 83790583.95, p0: 0.56056689, p1: 0.51835 }
];

console.log('-- the two measurements, on real rows --');
const s = compareMeasures(ROWS);
check('every row is comparable', s.n === 10, `got ${s.n}`);
check('notional open interest is a restatement of price', s.corrNotionalPrice > 0.99,
  `r = ${s.corrNotionalPrice.toFixed(4)}`);
// Correlation is not the discriminator on a fixture this size. All ten rows
// come from one violent BTW episode, where contracts genuinely did fall as
// price fell, so contracts correlate highly here too (r = 0.93). Over all 274
// live rows the figures are 0.998 for notional against 0.354 for contracts;
// see docs/PREDICTION_WEIGHTS_EVIDENCE.md. What separates them on ANY sample,
// including this one, is scale: notional moves one-for-one with price and
// contracts do not.
const meanAbsPrice = ROWS.reduce((a, r) => a + Math.abs((r.p1 / r.p0 - 1) * 100), 0) / ROWS.length;
check('notional moves one-for-one with price', Math.abs(s.meanAbsNotional / meanAbsPrice - 1) < 0.1,
  `${(s.meanAbsNotional / meanAbsPrice).toFixed(3)}x`);
check('contracts move on a different scale entirely', s.meanAbsContracts / meanAbsPrice < 0.05,
  `${(s.meanAbsContracts / meanAbsPrice).toFixed(4)}x`);
check('notional tracks the sign of price on every row', s.notionalTracksPriceSign === 1);
check('notional moves an order of magnitude more than contracts',
  s.meanAbsNotional / s.meanAbsContracts > 10,
  `${s.meanAbsNotional.toFixed(3)}% vs ${s.meanAbsContracts.toFixed(3)}%`);

console.log('\n-- rows collapse to episodes --');
check('ten rows are four episodes', s.episodes === 4, `got ${s.episodes}`);

console.log('\n-- the detection the executor acted on --');
const acted = ROWS.find((r) => r.id === 'BTW|1789293504013');
const contracts = (acted.c1 / acted.c0 - 1) * 100;
const notional = (acted.u1 / acted.u0 - 1) * 100;
const price = (acted.p1 / acted.p0 - 1) * 100;
check('notional said open interest surged', notional > 4, `${notional.toFixed(2)}%`);
check('price had surged by very nearly the same amount', Math.abs(notional - price) < 0.2,
  `notional ${notional.toFixed(2)}% vs price ${price.toFixed(2)}%`);
check('contracts barely moved', Math.abs(contracts) < 0.1, `${contracts.toFixed(3)}%`);
check('measured in contracts the move is not decisive either way',
  classifyMove(contracts) === 'ambiguous', classifyMove(contracts));
check('the notional reading would have been decisive',
  classifyMove(notional) === 'new-position', classifyMove(notional));
check('the cut is the contracts-era one', OI_DECISIVE_CONTRACTS_PCT === 0.25);

console.log(`\nnotional ${notional.toFixed(2)}%, price ${price.toFixed(2)}%, contracts ${contracts.toFixed(3)}% over the same five minutes`);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
