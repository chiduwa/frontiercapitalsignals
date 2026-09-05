// Guardrail tests for the cross-venue / perp-vs-spot lead-lag research lane.
//
// The maths in microstructure.mjs is not the risky part — a correlation is a
// correlation. The risky part is that this module SEARCHES, over hundreds of
// cells, for a small effect in noisy data, which is the setup that reliably
// manufactures convincing false positives. So most of what follows tests the
// refusals: that stale prices cannot fake a lag, that a lucky window cannot
// become a finding, that a sign flip between halves is rejected, and that an
// effect too small to pay its own fees is called untradeable however
// significant it is.
import {
  normalInvCdf, bonferroniZ, meanZTest, alignTradedReturns, lagProfile,
  directionalEdgeBps, basisProfile, evaluateCell, tradeDecisionForEdge,
  nextStatus, cellKey, windowOverlaps, tradedFraction, dbNumber,
  MAX_LAG_SECONDS, MIN_CELL_PAIRS, DEFAULT_FUTURES_ROUND_TRIP_COST_PCT
} from './scripts/microstructure.mjs';
import { RELIABILITY_SIGNIFICANCE_Z } from './worker.js';

let failures = 0;
function check(label, cond, detail) {
  if (cond) { console.log(`  PASS  ${label}`); return; }
  failures++;
  console.log(`  FAIL  ${label}${detail === undefined ? '' : `  [${detail}]`}`);
}
const near = (a, b, tol) => a != null && Math.abs(a - b) <= tol;

// Deterministic PRNG so a "noise is rejected" test cannot pass or fail by luck
// of the run — the whole point is that noise behaves like noise every time.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const gauss = (rnd) => {
  const u = Math.max(rnd(), 1e-12), v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

// Builds a leader/follower bar pair where the follower genuinely repeats the
// leader's move `leadSeconds` later, with `noise` of its own.
function plantedLead(seconds, leadSeconds, beta, noise, seed, tradedProb = 1) {
  const rnd = mulberry32(seed);
  const leaderRets = Array.from({ length: seconds }, () => gauss(rnd) * 0.0002);
  const leader = new Map(), follower = new Map();
  let lp = 100, fp = 100;
  for (let i = 0; i < seconds; i++) {
    lp *= 1 + leaderRets[i];
    const driven = i - leadSeconds >= 0 ? beta * leaderRets[i - leadSeconds] : 0;
    fp *= 1 + driven + gauss(rnd) * noise;
    leader.set(1000 + i, { close: lp, vol: rnd() < tradedProb ? 1 : 0 });
    follower.set(1000 + i, { close: fp, vol: rnd() < tradedProb ? 1 : 0 });
  }
  return { leader, follower };
}

console.log('\n== normalInvCdf: the Bonferroni bar depends on family size, so it must be computed, not tabulated ==');
check('the 97.5th percentile is 1.960', near(normalInvCdf(0.975), 1.959964, 1e-4), normalInvCdf(0.975));
check('the 99.5th percentile is 2.576, matching RELIABILITY_SIGNIFICANCE_Z', near(normalInvCdf(0.995), 2.575829, 1e-4), normalInvCdf(0.995));
check('the far tail (1 - 5e-7) is 4.892', near(normalInvCdf(1 - 5e-7), 4.8916, 1e-3), normalInvCdf(1 - 5e-7));
check('the median is 0', near(normalInvCdf(0.5), 0, 1e-9));
check('it is symmetric about the median', near(normalInvCdf(0.9) + normalInvCdf(0.1), 0, 1e-6));
check('an out-of-range probability returns null rather than a number', normalInvCdf(0) === null && normalInvCdf(1) === null && normalInvCdf(1.5) === null);

console.log('\n== bonferroniZ: the correction actually widens as the search widens ==');
check('a one-test family sits at the project-wide bar', near(bonferroniZ(1), RELIABILITY_SIGNIFICANCE_Z, 1e-6), bonferroniZ(1));
check('a 210-cell family demands a materially higher bar', bonferroniZ(210) > 4 && bonferroniZ(210) < 4.5, bonferroniZ(210));
check('the bar rises monotonically with family size', bonferroniZ(500) > bonferroniZ(210) && bonferroniZ(210) > bonferroniZ(20));
check('it is never weaker than the project-wide bar, whatever is passed', bonferroniZ(0) >= RELIABILITY_SIGNIFICANCE_Z && bonferroniZ(-5) >= RELIABILITY_SIGNIFICANCE_Z);

console.log('\n== meanZTest: windows are the independent unit, not the 1s returns inside them ==');
const mz = meanZTest([0.1, 0.12, 0.09, 0.11, 0.10]);
check('a consistent positive effect produces a large z', mz.z > 5 && near(mz.mean, 0.104, 1e-3), JSON.stringify(mz));
check('a symmetric sample around zero produces a z near zero', Math.abs(meanZTest([-0.1, 0.1, -0.1, 0.1]).z) < 1e-9);
check('a single observation cannot be tested at all', meanZTest([0.5]).z === null);
check('an all-identical sample has no spread to test against, not an infinite z', meanZTest([0.2, 0.2, 0.2]).z === null);
check('non-numeric entries are dropped rather than poisoning the mean', meanZTest([0.1, null, 0.1, undefined, NaN, 0.1]).n === 3);

console.log('\n== alignTradedReturns: hazard 1, stale prices must not be able to fake a lag ==');
const bars = (spec) => new Map(spec.map(([s, close, vol]) => [s, { close, vol }]));
const L = bars([[1, 100, 5], [2, 101, 5], [3, 102, 5], [4, 103, 5]]);
const F = bars([[1, 50, 5], [2, 50.5, 0], [3, 51, 5], [4, 51.5, 5]]);
const aligned = alignTradedReturns(L, F);
check('a second where the follower did not trade is dropped, not carried forward', aligned.every((r) => r.sec !== 2), JSON.stringify(aligned.map((r) => r.sec)));
check('seconds where both sides traded are kept', aligned.some((r) => r.sec === 3) && aligned.some((r) => r.sec === 4));
const gapped = alignTradedReturns(bars([[1, 100, 5], [9, 101, 5]]), bars([[1, 50, 5], [9, 50.5, 5]]));
check('a non-contiguous second yields no return (a 8-second gap is not a 1-second move)', gapped.length === 0);
check('a series with no overlap at all yields nothing rather than throwing', alignTradedReturns(bars([[1, 1, 1]]), bars([[99, 1, 1]])).length === 0);
check('tradedFraction reports the share of seconds carrying a trade', near(tradedFraction(F), 0.75, 1e-9), tradedFraction(F));
check('tradedFraction of an empty series is 0, not NaN', tradedFraction(new Map()) === 0);

console.log('\n== lagProfile: finds a planted lead, and reports the clock-alignment diagnostic ==');
const planted = plantedLead(600, 2, 1.0, 0.00002, 42);
const prof = lagProfile(alignTradedReturns(planted.leader, planted.follower));
const best = prof.cells.reduce((m, c) => (Math.abs(c.corr) > Math.abs(m.corr) ? c : m), prof.cells[0]);
check('a genuine 2-second lead is recovered at exactly k=+2', best.lag === 2, `best lag ${best.lag}, corr ${best.corr.toFixed(3)}`);
check('and it is recovered strongly, not marginally', best.corr > 0.8, best.corr.toFixed(3));
check('a planted lead correctly does NOT peak at zero, so the diagnostic is not vacuously true', prof.peakAtZero === false);
const synced = plantedLead(600, 0, 1.0, 0.00002, 7);
const syncedProf = lagProfile(alignTradedReturns(synced.leader, synced.follower));
check('two synchronised venues peak at lag 0, which is what a clean clock looks like', syncedProf.peakAtZero === true);
check('lag0Corr is reported for the synchronised pair', syncedProf.lag0Corr > 0.8, syncedProf.lag0Corr);
check('the profile covers the full declared lag range', prof.cells.length === MAX_LAG_SECONDS * 2 + 1, prof.cells.length);
// Correlation noise scales as 1/sqrt(n), so a thin cell produces the biggest
// numbers in the archive if nothing stops it — the live dry run turned up
// corr 0.842 off twelve pairs. That is why the per-cell floor exists.
const sparse = plantedLead(300, 0, 0, 0.0002, 5, 0.25); // ~25% of seconds traded
const sparseProf = lagProfile(alignTradedReturns(sparse.leader, sparse.follower));
check('cells with too few pairs behind them are not recorded at all',
  sparseProf.cells.filter((c) => c.lag !== 0).every((c) => c.n >= MIN_CELL_PAIRS),
  JSON.stringify(sparseProf.cells.map((c) => `${c.lag}:${c.n}`)));
check('the lag-0 diagnostic survives a thin window, so thinness cannot fake an off-zero peak',
  sparseProf.cells.some((c) => c.lag === 0));
const pureNoise = lagProfile(alignTradedReturns(...Object.values(plantedLead(600, 0, 0, 0.0002, 11))));
check('unrelated series produce no strong correlation at any lag', Math.max(...pureNoise.cells.map((c) => Math.abs(c.corr))) < 0.3,
  Math.max(...pureNoise.cells.map((c) => Math.abs(c.corr))).toFixed(3));

console.log('\n== directionalEdgeBps: the economic half, in units a fee can be subtracted from ==');
const edgeRows = alignTradedReturns(planted.leader, planted.follower);
const edge = directionalEdgeBps(edgeRows, 2);
check('a follower that repeats the leader\'s move scores a positive edge', edge.edgeBps > 0, JSON.stringify(edge));
check('the edge is reported in basis points, at a plausible 1-second magnitude', edge.edgeBps > 0.5 && edge.edgeBps < 100, edge.edgeBps);
const inverse = plantedLead(600, 2, -1.0, 0.00002, 42);
check('a follower that moves AGAINST the leader scores a negative edge, not an absolute one',
  directionalEdgeBps(alignTradedReturns(inverse.leader, inverse.follower), 2).edgeBps < 0);
check('too few rows to measure returns a null edge rather than a number from nothing', directionalEdgeBps(edgeRows.slice(0, 5), 2).edgeBps === null);
check('a lag with no forward partner returns a null edge', directionalEdgeBps(edgeRows, 99999).edgeBps === null);

console.log('\n== basisProfile: hazard, the perp-spot basis is ~99% constant offset ==');
const flatBasis = (() => {
  const rnd = mulberry32(3); const spot = new Map(), perp = new Map();
  let p = 100;
  for (let i = 0; i < 400; i++) { p *= 1 + gauss(rnd) * 0.0002; spot.set(1000 + i, { close: p, vol: 1 }); perp.set(1000 + i, { close: p * 0.99947, vol: 1 }); }
  return { spot, perp };
})();
const flatProf = basisProfile(flatBasis.spot, flatBasis.perp, [1, 5]);
check('an exactly constant basis has no variation to correlate and yields no cells', flatProf.cells.length === 0, JSON.stringify(flatProf));
const thin = basisProfile(new Map([[1, { close: 1, vol: 1 }]]), new Map([[1, { close: 1, vol: 1 }]]), [1]);
check('a window below the paired-seconds floor yields no cells', thin.cells.length === 0);

console.log('\n== evaluateCell: the gate that decides whether a search result becomes a finding ==');
const obsFrom = (corrs, opts = {}) => corrs.map((c, i) => ({
  observedAt: `2026-09-${String(5 + Math.floor(i / 24)).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}:00:00.000Z`,
  corr: c, edgeBps: opts.edgeBps ?? 5, peakAtZero: opts.peakAtZero ?? true
}));
// A real, stable effect: consistently positive across every window.
const strong = obsFrom(Array.from({ length: 40 }, (_, i) => 0.30 + (i % 5) * 0.01));
check('a large, stable, consistently-signed effect clears a 210-cell family bar', evaluateCell(strong, 210).verdict === 'candidate',
  JSON.stringify(evaluateCell(strong, 210).pooled));
// Pure noise across many windows — the case that must never become a finding.
const noiseRnd = mulberry32(99);
const noise = obsFrom(Array.from({ length: 40 }, () => gauss(noiseRnd) * 0.2));
check('forty windows of pure noise produce no candidate', evaluateCell(noise, 210).verdict === 'no-effect',
  JSON.stringify(evaluateCell(noise, 210).pooled));
// The ETH-at-N=10s shape: one impressive window among many unremarkable ones.
const oneLuckyWindow = obsFrom([0.59, 0.02, -0.03, 0.01, 0.04, -0.02, 0.00, 0.03, -0.01, 0.02, 0.01, -0.04]);
check('a single spectacular window among ordinary ones is not a finding', evaluateCell(oneLuckyWindow, 210).verdict !== 'candidate',
  JSON.stringify(evaluateCell(oneLuckyWindow, 210).pooled));
// Same effect size, but it reverses halfway: exactly what a regime artifact
// looks like, and it must fail the split-half even though pooled z is large.
const flips = obsFrom([...Array.from({ length: 20 }, () => 0.34), ...Array.from({ length: 20 }, () => -0.34)]);
check('an effect that reverses sign between halves is rejected as unstable', ['unstable', 'no-effect'].includes(evaluateCell(flips, 210).verdict),
  evaluateCell(flips, 210).verdict);
// Evidence deliberately built to sit between the two bars: a z of ~3.0 clears
// a single-test family (2.576) but not a 5000-cell one (~4.6). This is the
// case the correction exists for — the same numbers, differently deserved,
// depending on how much was searched to find them.
const marginal = (() => {
  const rnd = mulberry32(2026);
  const raw = Array.from({ length: 30 }, () => gauss(rnd));
  const m = raw.reduce((a, b) => a + b, 0) / raw.length;
  const s = Math.sqrt(raw.reduce((a, b) => a + (b - m) ** 2, 0) / (raw.length - 1));
  // Recentre to exactly z = 4.3 at this n, so the test is about the bars, not
  // about whatever the random draw happened to produce. 4.3 is chosen to sit in
  // the only gap that isolates the correction: high enough that each
  // chronological half still clears 2.576 on its own (a half carries ~z/sqrt2,
  // so anything under ~3.65 fails the stability guard instead and would prove
  // nothing about family size), and below the ~4.75 a 5000-cell family demands.
  const targetMean = 4.3 * (s / Math.sqrt(raw.length));
  return obsFrom(raw.map((v) => v - m + targetMean));
})();
check('the same evidence judged against a WIDER family stops being a candidate',
  evaluateCell(marginal, 1).verdict === 'candidate' && evaluateCell(marginal, 5000).verdict === 'no-effect',
  JSON.stringify({ z: evaluateCell(marginal, 1).pooled.z, narrowBar: evaluateCell(marginal, 1).zBar, wideBar: evaluateCell(marginal, 5000).zBar }));
// Clock-suspect windows must be excluded, not quietly averaged in.
const skewed = obsFrom(Array.from({ length: 40 }, () => 0.4), { peakAtZero: false });
check('windows whose peak sits off zero are excluded as clock-suspect', evaluateCell(skewed, 210).windows === 0);
check('and they can be deliberately included when the caller says so', evaluateCell(skewed, 210, { requirePeakAtZero: false }).windows === 40);
check('a cell with too few windows is no-effect, never a candidate', evaluateCell(obsFrom([0.9]), 210).verdict === 'no-effect');
check('the candidate carries the median edge forward for the cost test', typeof evaluateCell(strong, 210).medianEdgeBps === 'number');

console.log('\n== tradeDecisionForEdge: significance is not profitability, and leverage does not change that ==');
const cost = DEFAULT_FUTURES_ROUND_TRIP_COST_PCT; // 0.10% = 10bps
check('a 2bps edge cannot pay a 10bps round trip, however significant it was', tradeDecisionForEdge(2, cost).decision === 'abstain',
  tradeDecisionForEdge(2, cost).reason);
check('a 25bps edge clears it', tradeDecisionForEdge(25, cost).decision === 'eligible', tradeDecisionForEdge(25, cost).reason);
check('an edge exactly equal to cost does not clear it', tradeDecisionForEdge(10, cost).decision === 'abstain');
check('a negative edge of large magnitude is still not a long-side green light', tradeDecisionForEdge(-25, cost).decision === 'eligible' && tradeDecisionForEdge(-25, cost).reason.includes('-25'));
check('a missing edge abstains rather than defaulting to eligible', tradeDecisionForEdge(null, cost).decision === 'abstain' && tradeDecisionForEdge(NaN, cost).decision === 'abstain');
check('the reason string always states both numbers, so the decision is auditable', /bps/.test(tradeDecisionForEdge(2, cost).reason));

console.log('\n== lifecycle + write-time guards ==');
check('provisional is promoted to confirmed only by a held out-of-sample check', nextStatus('held', 'provisional') === 'confirmed');
check('an insufficient out-of-sample check leaves it provisional', nextStatus('insufficient', 'provisional') === 'provisional');
check('a contradicted check decays it', nextStatus('contradicted', 'provisional') === 'decayed');
check('even a confirmed pattern decays when contradicted', nextStatus('contradicted', 'confirmed') === 'decayed');
check('a decayed pattern is not silently revived by one good check', nextStatus('held', 'decayed') === 'decayed');
check('an overlapping window is rejected as a non-independent observation',
  windowOverlaps('2026-09-05T20:05:00.000Z', '2026-09-05T20:03:00.000Z') === true);
check('a window starting exactly at the previous end still counts as overlapping', windowOverlaps('2026-09-05T20:05:00.000Z', '2026-09-05T20:05:00.000Z') === true);
check('a clean subsequent window is accepted', windowOverlaps('2026-09-05T20:05:00.000Z', '2026-09-05T20:06:00.000Z') === false);
check('the very first window has nothing to overlap', windowOverlaps(null, '2026-09-05T20:00:00.000Z') === false);
check('cell keys are stable and carry every dimension that makes a cell distinct',
  cellKey({ symbol: 'BTC', family: 'leadlag', leader: 'okx:perp', follower: 'okx:spot', lag: 2 }) === 'micro:leadlag:BTC:okx:perp>okx:spot:lag2');
check('a different lag is a different hypothesis',
  cellKey({ symbol: 'BTC', family: 'leadlag', leader: 'a', follower: 'b', lag: 2 }) !== cellKey({ symbol: 'BTC', family: 'leadlag', leader: 'a', follower: 'b', lag: 3 }));
check('dbNumber passes finite numbers and nulls everything else', dbNumber(1.5) === 1.5 && dbNumber(NaN) === null && dbNumber(Infinity) === null && dbNumber(null) === null);

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nMICROSTRUCTURE GUARDRAILS OK');
process.exit(failures ? 1 : 0);
