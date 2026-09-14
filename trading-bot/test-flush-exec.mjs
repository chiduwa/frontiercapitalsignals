// Tests for the live flush executor's gates. These decide whether real money
// moves, so they are tested independently of the credentialed order path.
import { loadGates, isTradeableSetup, quantityFor, allowsUnproven } from './src/flush-gates.mjs';
import { MAX_LEVERAGE } from '../signals-worker/scripts/flush-entry.mjs';

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}${d ? ` — ${d}` : ''}`); } };

console.log('\n== everything defaults to a refusal ==');
const bare = loadGates({});
check('disabled unless explicitly enabled', bare.enabled === false);
check('no position size is assumed', bare.notional === null);
check('"1" does not enable it', loadGates({ FLUSH_EXEC_ENABLED: '1' }).enabled === false);
check('"yes" does not enable it', loadGates({ FLUSH_EXEC_ENABLED: 'yes' }).enabled === false);
check('only the literal "true" enables it', loadGates({ FLUSH_EXEC_ENABLED: 'true' }).enabled === true);
check('"TRUE" also works (case-insensitive)', loadGates({ FLUSH_EXEC_ENABLED: 'TRUE' }).enabled === true);

console.log('\n== size and leverage cannot be exceeded ==');
check('leverage is capped at MAX_LEVERAGE', loadGates({ FLUSH_EXEC_LEVERAGE: '20' }).leverage === MAX_LEVERAGE);
// The stop sits 6.48% from the ENTRY, not 15% — 15% is measured from the
// pre-spike reference and the entry is already 8% along. Leverage multiplies
// the entry-to-stop distance, and an earlier version of this test asserted
// against the wrong one.
const STOP_FROM_ENTRY_PCT = (1.15 / 1.08 - 1) * 100;
// The invariant that actually matters is the ORDERING: the stop must trigger
// before liquidation, with room for slippage on a fast fill. 1.75x is the
// documented floor; 8x sits at 1.9x. Below this the stop stops being
// protection and becomes decoration.
check('liquidation stays meaningfully further away than the stop',
  (100 / MAX_LEVERAGE) / STOP_FROM_ENTRY_PCT >= 1.75,
  `buffer ${((100 / MAX_LEVERAGE) / STOP_FROM_ENTRY_PCT).toFixed(2)}x at ${MAX_LEVERAGE}x`);
// Loss per stopped trade is a function of NOTIONAL, not leverage — pinned so
// nobody later reasons that raising leverage raised the risk per trade.
check('a stopped trade costs the same fraction of notional at any leverage',
  Math.abs(STOP_FROM_ENTRY_PCT - 6.48) < 0.05, `${STOP_FROM_ENTRY_PCT.toFixed(2)}% of notional`);
check('leverage never reaches the level where liquidation precedes the stop',
  MAX_LEVERAGE < 100 / STOP_FROM_ENTRY_PCT, `breaks at ${(100 / STOP_FROM_ENTRY_PCT).toFixed(1)}x`);
check('a negative notional is refused', loadGates({ FLUSH_EXEC_NOTIONAL_USD: '-100' }).notional === null);
check('a zero notional is refused', loadGates({ FLUSH_EXEC_NOTIONAL_USD: '0' }).notional === null);
check('garbage notional is refused', loadGates({ FLUSH_EXEC_NOTIONAL_USD: 'lots' }).notional === null);
check('concurrency defaults to one position', bare.maxConcurrent === 1);
check('fractional concurrency floors, never rounds up', loadGates({ FLUSH_EXEC_MAX_CONCURRENT: '2.9' }).maxConcurrent === 2);

console.log('\n== only the chosen setup trades ==');
// 2026-09-14: the setup is refused by default because the measurement behind it
// was withdrawn. ARMED is what the operator gets after opting in explicitly.
const ARMED = { FLUSH_EXEC_ALLOW_UNPROVEN: 'true' };
check('spike + OI fell is refused by default now',
  !isTradeableSetup({ direction: 'up', classification: 'liquidation' }, {}).ok);
check('the default refusal names the reason and the override',
  /unproven/.test(isTradeableSetup({ direction: 'up', classification: 'liquidation' }, {}).reason)
  && /FLUSH_EXEC_ALLOW_UNPROVEN/.test(isTradeableSetup({ direction: 'up', classification: 'liquidation' }, {}).reason));
check('only the literal "true" arms it',
  allowsUnproven({ FLUSH_EXEC_ALLOW_UNPROVEN: 'yes' }) === false
  && allowsUnproven({ FLUSH_EXEC_ALLOW_UNPROVEN: '1' }) === false
  && allowsUnproven({ FLUSH_EXEC_ALLOW_UNPROVEN: 'true' }) === true);
check('spike + OI fell is tradeable once armed', isTradeableSetup({ direction: 'up', classification: 'liquidation' }, ARMED).ok);
check('spike + OI rose is refused', !isTradeableSetup({ direction: 'up', classification: 'new-position' }, ARMED).ok);
check('spike + ambiguous is refused', !isTradeableSetup({ direction: 'up', classification: 'ambiguous' }, ARMED).ok);
check('dip + OI fell is refused — excluded in CODE, not config',
  !isTradeableSetup({ direction: 'down', classification: 'liquidation' }, ARMED).ok);
check('dip + OI rose is refused', !isTradeableSetup({ direction: 'down', classification: 'new-position' }, ARMED).ok);
check('a null event is refused', !isTradeableSetup(null, ARMED).ok);
check('the refusal explains itself', /payoff grounds/.test(isTradeableSetup({ direction: 'down', classification: 'liquidation' }, ARMED).reason));

console.log('\n== sizing rounds down, never up ==');
check('exact division is exact', quantityFor(500, 2.5, null) === 200);
check('a step size rounds DOWN', quantityFor(500, 2.5, 3) === 198, String(quantityFor(500, 2.5, 3)));
check('below one step yields nothing rather than a minimum', quantityFor(1, 100, 1) === null);
check('a zero price yields nothing', quantityFor(500, 0, 1) === null);
check('a zero notional yields nothing', quantityFor(0, 100, 1) === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
