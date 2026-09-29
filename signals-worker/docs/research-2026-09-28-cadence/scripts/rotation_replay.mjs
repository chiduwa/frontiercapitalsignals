// The coin rotation as the live log runs it (scripts/coin-rotation.mjs), replayed
// on every day since 2021: the 100 most-traded Binance coins, a cohort per
// horizon per day, each scored k days later net of costs. Gives the live log
// its historical reference, per year and per period, on the same universe the
// live log uses (the cadence study used the research panel's coins instead).
//
// Input: Binance spot daily candles for every currently tradable USDT pair,
// { SYMBOL: [[open_ms, close, quote_volume], ...] } (fetch_daily_all.py).
// Survivorship: pairs delisted since 2021 are missing, as in the study.
//
// usage (from signals-worker/): node docs/research-2026-09-28-cadence/scripts/rotation_replay.mjs daily_all.json [out.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { ROT, rotationUniverse, formCohort, scoreCohort, rotationRecord, addDays, breakInWindow } from '../../../scripts/coin-rotation.mjs';

const raw = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const daily = {};
let lastDate = '0000';
for (const [s, rows] of Object.entries(raw)) {
  const close = new Map(), qv = new Map();
  for (const [t, c, v] of rows) {
    const d = new Date(t).toISOString().slice(0, 10);
    if (c > 0) { close.set(d, c); qv.set(d, v); if (d > lastDate) lastDate = d; }
  }
  daily[s] = { close, qv };
}
const first = addDays('2021-01-01', ROT.historyDays);
const scored = Object.fromEntries(ROT.horizons.map((k) => [k, []]));
let uniSizes = [];
for (let d = first; d <= lastDate; d = addDays(d, 1)) {
  const uni = rotationUniverse(daily, d);
  if (uni.length < ROT.minScored) continue;
  uniSizes.push(uni.length);
  for (const k of ROT.horizons) {
    const mat = addDays(d, k);
    if (mat > lastDate) continue;
    const c = formCohort(daily, uni, d, k);
    if (!c) continue;
    const s = scoreCohort(c, (sym) => daily[sym]?.close.get(mat) ?? null, { broken: (sym) => breakInWindow(daily[sym].close, d, mat) });
    if (s) scored[k].push({ formed_on: d, net_spread: s.netSpread, laggards_excess: s.laggardsExcess, spread: s.spread, universe_ret: s.universeRet });
  }
}
const pct = (x, dp = 2) => (x == null ? 'n/a' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(dp)}%`);
const out = { universe: { days: uniSizes.length, medianSize: uniSizes.sort((a, b) => a - b)[Math.floor(uniSizes.length / 2)] }, horizons: {} };
console.log(`${Object.keys(daily).length} pairs, formation days ${first} to ${lastDate}; universe of ${out.universe.medianSize} coins (median)`);
for (const k of ROT.horizons) {
  const rows = scored[k];
  const slice = (from, to) => rows.filter((r) => r.formed_on >= from && r.formed_on < to);
  const periods = { '2021-23': slice('2021', '2024'), '2024-26': slice('2024', '2027') };
  const years = Object.fromEntries(['2021', '2022', '2023', '2024', '2025', '2026'].map((y) => [y, slice(y, String(Number(y) + 1))]));
  out.horizons[k] = { periods: {}, years: {} };
  console.log(`\n${k}-day rotation (long laggards / short leaders, net of 0.2% a round; laggards vs market, long only, net of 0.2%)`);
  for (const [name, r] of [...Object.entries(periods), ...Object.entries(years)]) {
    const rec = rotationRecord(r, k);
    (name.includes('-') ? out.horizons[k].periods : out.horizons[k].years)[name] = rec;
    console.log(`  ${name.padEnd(8)} ${String(rec.cohorts).padStart(4)} rounds  net ${pct(rec.netPerCohort)} a round, ${pct(rec.netPerYear, 1)} a year, t ${rec.t == null ? 'n/a' : rec.t.toFixed(2)}`
      + `   laggards vs market ${pct(rec.laggardsPerCohort)} a round, ${pct(rec.laggardsPerYear, 1)} a year, t ${rec.laggardsT == null ? 'n/a' : rec.laggardsT.toFixed(2)}`);
  }
}
if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify(out, null, 1));
