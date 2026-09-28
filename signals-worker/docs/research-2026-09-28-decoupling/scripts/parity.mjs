// The production module's side of parity.py: the rule's inputs at sampled
// hours, printed as JSON. usage: node parity.mjs bars.json
import { readFileSync } from 'node:fs';
import { withMarket, hourlyPanel, coinState, setupSide, volumeRatioAt, medianVolumeRatio } from '../../../scripts/decoupling-watch.mjs';

const bars = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const universe = Object.keys(bars);
const last = Math.max(...Object.values(bars).map((b) => b[b.length - 1].openTime));
const p = withMarket(hourlyPanel(bars, { universe, nowMs: last + 3600000 }));
const cache = new Map();
const num = (x) => (Number.isFinite(x) ? x : null);
const rows = [];
for (const i of [800, 2000, 5000, 9000, 12345, 15000, 17000, 18100, p.n - 30]) {
  for (const s of ['HBAR', 'BTC', 'SOL', 'XLM', 'APT', 'PEPE', 'TON', 'ONDO']) {
    if (!p.r[s]) continue;
    const vr = volumeRatioAt(p, s, i), med = medianVolumeRatio(p, i, cache), st = coinState(p, s, i, cache);
    rows.push({ s, i, lvr: num(Math.log(vr)), lvrx: num(Math.log(vr / med)), z: st ? st.excessZ : null, thr: st ? st.threshold : null, side: setupSide(st) });
  }
}
console.log(JSON.stringify({ t0: p.t0, n: p.n, rows }));
