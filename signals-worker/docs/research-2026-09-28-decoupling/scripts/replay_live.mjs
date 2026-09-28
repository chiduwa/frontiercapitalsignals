// What the live decoupling watch would have logged over a recent window, run
// by the production code on the live scanner's own bars: the rule, the
// 24-hour cooldown chain (as a watch that had been running for two days
// before the window starts), and each setup scored on its next 24 hours
// against every coin over the same hours. Setups still inside their 24 hours
// show their excess move so far.
//
// usage (from signals-worker/): node docs/research-2026-09-28-decoupling/scripts/replay_live.mjs 2026-09-21T00:00Z [end]
// The window must start at least ~65 days after the oldest bar fetched (2000 hours back).
import { DECOUPLING_UNIVERSE, DW, withMarket, hourlyPanel, coinState, setupSide, scoreDecoupling, dayBeta, hourStart } from '../../../scripts/decoupling-watch.mjs';
import { fetchDeepBars } from '../../../scripts/decoupling-watch-io.mjs';
import { binanceGlobalTradablePairs } from '../../../worker.js';

const HOUR = 3600000;
const from = hourStart(Date.parse(process.argv[2]));
const nowMs = process.argv[3] ? Date.parse(process.argv[3]) : Date.now();
const tradable = new Set(await binanceGlobalTradablePairs());
const universe = DECOUPLING_UNIVERSE.filter((s) => tradable.has(s));
const bars = {};
for (const s of universe) bars[s] = await fetchDeepBars(s);
const p = withMarket(hourlyPanel(bars, { universe, nowMs }));
const cache = new Map();
const iFrom = (from - p.t0) / HOUR, end = p.n - 1;
// The chain, as a watch running since two days before the window. Reading
// hour i on the full panel is the same as a run at its close: coinState only
// reads hours <= i (test-decoupling-watch.mjs pins it).
const taken = [];
for (const s of p.syms) {
  let last = -Infinity;
  for (let i = iFrom - DW.chainHours; i <= end; i++) {
    const st = coinState(p, s, i, cache), side = setupSide(st);
    if (!side || i - last < DW.cooldownHours) continue;
    last = i;
    if (i >= iFrom) taken.push({ ...st, side });
  }
}
taken.sort((a, b) => a.index - b.index || a.symbol.localeCompare(b.symbol));
let n = 0, hits = 0, base = 0;
const pct = (x) => `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`;
console.log(`${universe.length} coins, window ${new Date(from).toISOString().slice(0, 16)} to ${new Date(p.t0 + end * HOUR).toISOString().slice(0, 16)} (last closed hour)`);
for (const s of taken) {
  const sc = scoreDecoupling(bars, s.symbol, s.at, { universe, nowMs });
  let tail;
  if (sc) {
    n++; hits += sc.big; base += sc.baseRate;
    tail = `next 24h ${pct(sc.excessPct)} vs market, ${sc.big ? 'BIG' : 'not big'} (same-hours base ${(sc.baseRate * 100).toFixed(1)}%)`;
  } else {
    let x = 0;
    for (let j = s.index + 1; j <= end; j++) x += p.r[s.symbol][j] - dayBeta(p, s.symbol, j, cache) * p.mkt[s.symbol][j];
    tail = `so far (${end - s.index}h): ${pct(Math.expm1(x) * 100)} vs market`;
  }
  console.log(`seen ${new Date(Date.parse(s.at) + HOUR).toISOString().slice(0, 16).replace('T', ' ')} UTC  ${s.symbol.padEnd(5)} ${s.side > 0 ? 'pulling ahead ' : 'falling behind'}  8h ${pct(s.excessPct).padStart(6)} vs market`
    + ` (z ${s.excessZ.toFixed(1)}), volume ${s.volumeRatio.toFixed(1)}x (${s.relVolume.toFixed(1)}x typical coin), market ${pct(s.marketPct).padStart(6)} | ${tail}`);
}
console.log(`scored ${n}: ${hits} big (${n ? (hits / n * 100).toFixed(1) : 'n/a'}%) against a same-hours base of ${n ? (base / n * 100).toFixed(1) : 'n/a'}%`);
