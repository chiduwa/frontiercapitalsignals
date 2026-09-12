// Tests for the live flush executor's gates. These decide whether real money
// moves, so they are tested independently of the credentialed order path.
import { loadGates, isTradeableSetup, quantityFor } from './src/flush-gates.mjs';
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
check('a 15% stop at max leverage is not a liquidation', MAX_LEVERAGE * 0.15 < 1,
  `${MAX_LEVERAGE} x 15% = ${(MAX_LEVERAGE * 0.15 * 100).toFixed(0)}% of margin`);
check('a negative notional is refused', loadGates({ FLUSH_EXEC_NOTIONAL_USD: '-100' }).notional === null);
check('a zero notional is refused', loadGates({ FLUSH_EXEC_NOTIONAL_USD: '0' }).notional === null);
check('garbage notional is refused', loadGates({ FLUSH_EXEC_NOTIONAL_USD: 'lots' }).notional === null);
check('concurrency defaults to one position', bare.maxConcurrent === 1);
check('fractional concurrency floors, never rounds up', loadGates({ FLUSH_EXEC_MAX_CONCURRENT: '2.9' }).maxConcurrent === 2);

console.log('\n== only the chosen setup trades ==');
check('spike + OI fell is tradeable', isTradeableSetup({ direction: 'up', classification: 'liquidation' }).ok);
check('spike + OI rose is refused', !isTradeableSetup({ direction: 'up', classification: 'new-position' }).ok);
check('spike + ambiguous is refused', !isTradeableSetup({ direction: 'up', classification: 'ambiguous' }).ok);
check('dip + OI fell is refused — excluded in CODE, not config',
  !isTradeableSetup({ direction: 'down', classification: 'liquidation' }).ok);
check('dip + OI rose is refused', !isTradeableSetup({ direction: 'down', classification: 'new-position' }).ok);
check('a null event is refused', !isTradeableSetup(null).ok);
check('the refusal explains itself', /payoff grounds/.test(isTradeableSetup({ direction: 'down', classification: 'liquidation' }).reason));

console.log('\n== sizing rounds down, never up ==');
check('exact division is exact', quantityFor(500, 2.5, null) === 200);
check('a step size rounds DOWN', quantityFor(500, 2.5, 3) === 198, String(quantityFor(500, 2.5, 3)));
check('below one step yields nothing rather than a minimum', quantityFor(1, 100, 1) === null);
check('a zero price yields nothing', quantityFor(500, 0, 1) === null);
check('a zero notional yields nothing', quantityFor(0, 100, 1) === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
