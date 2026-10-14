// TRX on 2026-10-14 through the production decoupling rule, hour by hour (docs/PULLAWAYS.md).
// Fetches ~62 days of hourly bars for the 40-coin universe with the production fetcher.
import { fetchDeepBars } from '../../scripts/decoupling-watch-io.mjs';
import { DECOUPLING_UNIVERSE, hourlyPanel, withMarket, coinState, setupSide, DW } from '../../scripts/decoupling-watch.mjs';
import { writeFileSync } from 'node:fs';
const bars = {};
await Promise.all(DECOUPLING_UNIVERSE.map(async (s) => { bars[s] = await fetchDeepBars(s); }));
writeFileSync(new URL('../../reports/scenarios/2026-10-14-pullaways/trx-deep-bars.json', import.meta.url), JSON.stringify(bars));
const p = withMarket(hourlyPanel(bars, { nowMs: Date.now() }));
const cache = new Map();
console.log('hour(UTC close-1h open)  vol8h  mktVol  relVol  excess8h%  z     mkt8h%  beta  side');
for (let i = p.n - 30; i < p.n; i++) {
  const st = coinState(p, 'TRX', i, cache);
  if (!st) continue;
  console.log(st.at.slice(5, 16), st.volumeRatio.toFixed(2).padStart(6), st.marketVolumeRatio.toFixed(2).padStart(6), st.relVolume.toFixed(2).padStart(6),
    st.excessPct.toFixed(2).padStart(8), st.excessZ.toFixed(2).padStart(6), st.marketPct.toFixed(2).padStart(7), st.beta.toFixed(2).padStart(5), setupSide(st));
}
