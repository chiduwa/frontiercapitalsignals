// Plain-Node test suite. Pure rule only — no broker, no network.
import { evaluate, resolve, dailySigma, classify, DEFAULTS } from './src/reversal.mjs';

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`); }
};

// Synthetic history: a long flat stretch, a decline into a low, then a rally.
// Flat-with-jitter so sigma is well defined but small.
const mk = (n, fn) => Array.from({ length: n }, (_, i) => {
  const c = fn(i);
  return { date: `d${i}`, open: c, high: c * 1.01, low: c * 0.99, close: c };
});
const jitter = (i) => 100 + (i % 2 ? 0.6 : -0.6);

console.log('== dailySigma: measured, and only from prior bars ==');
const flat = mk(200, jitter).map((b) => b.close);
check('a jittery series has positive sigma', dailySigma(flat, 150) > 0);
check('a perfectly constant series has zero dispersion', dailySigma(mk(200, () => 100).map((b) => b.close), 150) === 0);
check('too little history yields null rather than a fabricated number', dailySigma([100, 101], 1) === null);

console.log('\n== evaluate: all three clauses must hold ==');
// 160 flat bars, then a drop to a low at index 170, then a recovery.
const bars = mk(200, (i) => (i < 160 ? jitter(i) : i <= 170 ? 100 - (i - 159) * 2 : 78 + (i - 170) * 3));
const good = evaluate(bars, 178);
check('a fresh low plus a confirmed turn qualifies', good.qualifies, JSON.stringify(good.reason));
check('the verdict carries the numbers behind it', good.metrics && good.metrics.lowAge <= DEFAULTS.maxLowAge);
check('the stop sits below entry and the target above', good.stop < good.entry && good.target > good.entry);
// The whole point of sigma-scaling: exits must be outside ordinary movement.
check('exits are scaled to the asset\'s own sigma, not a fixed percent', (() => {
  const upMove = good.target / good.entry - 1, downMove = 1 - good.stop / good.entry;
  return Math.abs(upMove - DEFAULTS.targetSigmas * good.sigma) < 1e-9
      && Math.abs(downMove - DEFAULTS.stopSigmas * good.sigma) < 1e-9;
})());

// Clause 1: the low must be current.
const stale = mk(320, (i) => (i < 100 ? 100 - i * 0.5 : 50 + (i - 100) * 0.5));
const staleV = evaluate(stale, 319);
check('a low from months ago is refused — that is momentum, not a reversal',
  !staleV.qualifies && staleV.reason.includes('sessions old'), staleV.reason);

// Clause 2: price must have turned by more than this asset's own noise. A
// bounce that closes UP but by less than 1.5 sigma is still knife-catching.
const weakBounce = mk(200, (i) => (i < 160 ? jitter(i) : i <= 170 ? 100 - (i - 159) * 2 : 78 + (i - 170) * 0.05));
const atLow = evaluate(weakBounce, 172);
check('a bounce smaller than the asset\'s own noise is refused — still catching the knife',
  !atLow.qualifies && atLow.reason.includes('off the low'), atLow.reason);
check('the same series DOES qualify once the bounce clears the bar', (() => {
  const strong = mk(200, (i) => (i < 160 ? jitter(i) : i <= 170 ? 100 - (i - 159) * 2 : 78 + (i - 170) * 3));
  return evaluate(strong, 173).qualifies;
})(), 'confirms the refusal above is about SIZE of the turn, not the shape of the series');

// Clause 3: the turn must still be intact today.
const downDay = bars.map((b, i) => (i === 178 ? { ...b, close: bars[177].close * 0.97 } : b));
check('a down close on the decision day is refused',
  !evaluate(downDay, 178).qualifies);

check('insufficient history refuses rather than guessing', !evaluate(bars, 10).qualifies);
check('a dispersion-free series cannot scale a threshold and is refused',
  !evaluate(mk(200, () => 100), 190).qualifies);

console.log('\n== resolve: ties go against us ==');
const pos = { entry: 100, target: 115, stop: 92, maxHoldDays: 20 };
const path = (spec) => spec.map((x, i) => ({ date: `x${i}`, open: x[0], high: x[1], low: x[2], close: x[3] }));
check('a target hit resolves at the target',
  resolve(pos, path([[100,116,99,115]]), 0).reason === 'target');
check('a stop hit resolves at the stop',
  resolve(pos, path([[100,101,91,92]]), 0).reason === 'stop');
// Daily bars cannot order a stop against a target inside the same session.
check('a bar spanning BOTH resolves as the stop, never the target',
  resolve(pos, path([[100,120,90,110]]), 0).reason === 'stop',
  'this single choice is what separated an honest backtest from a +122% artefact');
check('an untouched position runs to the time exit', (() => {
  const flatPath = path(Array.from({ length: 21 }, () => [100, 101, 99, 100]));
  const r = resolve(pos, flatPath, 0);
  return r.reason === 'time';
})());
check('a position with history still running is left open, not force-closed',
  resolve(pos, path([[100,101,99,100]]), 0) === null);

console.log('\n== classify: a bottom means different things by structure ==');
check('an inverse product is labelled inverse', classify('PLTZ') === 'inverse' && classify('sqqq') === 'inverse');
check('a leveraged long is labelled long', classify('TQQQ') === 'long' && classify('NVDL') === 'long');

console.log(failures === 0 ? '\nROBINHOOD RULE OK\n' : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
