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
    // same data-quality screen as the research
    if (closes.length < 400 || r.filter((x) => x === 0).length / r.length > 0.05 || Math.max(...r.map(Math.abs)) > 3) continue;
    metrics.push({ bandVol90: w.realizedVolPct(closes, 90), bandCal: w.bandCalibrationSample(closes) });
  }
  const s = w.applyBandCalibration(metrics);
  console.log(cls, 'assets', metrics.length, 'factor', s.factor.toFixed(3), 'samples', s.samples, 'band widens by', ((Math.sqrt(s.factor) - 1) * 100).toFixed(1) + '%');
}
