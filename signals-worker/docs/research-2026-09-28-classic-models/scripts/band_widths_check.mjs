// The shipped band code (worker.js bandCalibrationSample / applyBandCalibration)
// on the archive's real closes: each class's coverage factor for the 90-day
// volatility band and its multipliers for the historical band.
// OVF_DATA=<dir with hier-panel.json> node band_widths_check.mjs
import { readFileSync } from 'node:fs';
const w = await import(new URL('../../../worker.js', import.meta.url));
const panel = JSON.parse(readFileSync(`${process.env.OVF_DATA || '.'}/hier-panel.json`, 'utf8'));
for (const cls of ['crypto', 'stock']) {
  const metrics = [];
  for (const a of panel.assets) {
    const isStock = ['stock', 'benchmark'].includes(a.assetClass);
    if ((cls === 'stock') !== isStock) continue;
    const closes = a.bars.map((b) => b.close).filter((c) => c > 0);
    const r = closes.slice(1).map((c, i) => c / closes[i] - 1);
    // the research's data-quality screen: stuck, quantized or glitching series out
    if (closes.length < 400 || r.filter((x) => x === 0).length / r.length > 0.05 || Math.max(...r.map(Math.abs)) > 3) continue;
    metrics.push({ bandVol90: w.realizedVolPct(closes, 90), bandCal: w.bandCalibrationSample(closes) });
  }
  const s = w.applyBandCalibration(metrics);
  console.log(`${cls}: ${metrics.length} assets; volatility band x${s.factor.toFixed(3)} (was x${Math.sqrt(s.varianceFactor).toFixed(3)} by variance) from ${s.samples} moves; ` +
    `historical band = mean |move| x ${s.historical.multiplier[24].toFixed(3)} at 1 day (${s.historical.samples[24]} moves), x ${s.historical.multiplier[168].toFixed(3)} at 7 days (${s.historical.samples[168]})`);
}
