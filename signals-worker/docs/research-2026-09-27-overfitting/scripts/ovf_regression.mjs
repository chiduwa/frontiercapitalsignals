// Overfitting audit, regression side: per asset, the full-sample fit
// (in-sample R², adjusted R², regressors used) next to every walk-forward
// forecast and its outcome, from production's own code.
import { readFile, writeFile } from 'node:fs/promises';
const R = await import(new URL('../../../scripts/hierarchical-research.mjs', import.meta.url));
const M = await import(new URL('../../../scripts/hierarchical-model.mjs', import.meta.url));
const SP = process.env.OVF_DATA || '.';
const panel = JSON.parse(await readFile(`${SP}/hier-panel.json`, 'utf8'));
const asOf = '2026-09-26';
const t0 = Date.now();
const inference = R.runInference(panel, { asOf, log: (m) => console.log(m) });
const isRows = [];
for (const [key, lane] of Object.entries(inference)) {
  for (const f of lane.fits) {
    isRows.push({ lane: key, symbol: f.symbol, n: f.observations, p: f.coefficients.length,
      r2: f.rSquared, adjR2: f.adjustedRSquared, jointP: f.jointPValue });
  }
}
await writeFile(`${SP}/is_fits.json`, JSON.stringify(isRows));
console.log(`inference done: ${isRows.length} fits, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
// Walk-forward, keeping every scored forecast.
const derivatives = new Map(Object.entries(panel.derivatives || {}));
const supply = new Map(Object.entries(panel.supply || {}));
const fundingBySymbol = new Map(Object.entries(panel.funding || {}));
const sentimentByDate = new Map(panel.sentiment || []);
const benchmarks = {
  crypto: panel.assets.find(a => a.symbol === 'BTC' && a.assetClass === 'crypto')?.bars || [],
  stock: panel.assets.find(a => a.symbol === 'SPY')?.bars || []
};
const modelClassOf = (c) => (['stock', 'benchmark'].includes(c) ? 'stock' : 'crypto');
const out = [];
for (const [cls, horizons] of [['crypto', [1, 7]], ['stock', [1, 5]]]) {
  const members = panel.assets.filter(a => modelClassOf(a.assetClass) === cls);
  for (const horizon of horizons) {
    const res = M.walkForwardPanel(members, { horizon, assetClass: cls, asOf, benchmark: benchmarks[cls],
      derivativesBySymbol: derivatives, supplyBySymbol: supply, fundingBySymbol, sentimentByDate, costBps: 20, refitEvery: 21 });
    for (const o of res.outcomes) out.push([`${cls}|${horizon}`, o.symbol, o.asOf, o.targetDate, o.predictedPct, o.actualPct]);
    console.log(`walk-forward ${cls} ${horizon}d: ${res.outcomes.length} scored, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
}
await writeFile(`${SP}/wf_outcomes.json`, JSON.stringify(out));
console.log('done');
