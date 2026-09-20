// Existing production research estimators on an identical recent window.
// Weekly anchors can differ from the specialist study: counts are explicit.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { walkForwardPanel, HIERARCHICAL_VERSION } from './hierarchical-model.mjs';
import { walkForwardAsset, ADAPTIVE_VERSION } from './adaptive-model.mjs';
import { spearman } from './model-zoo.mjs';
import { ALWAYS_TRACKED, assessTrackedPanel } from './tracked-data-quality.mjs';
const mean=xs=>xs.length?xs.reduce((s,x)=>s+x,0)/xs.length:null;
export function compareNative(panel) {
  const asOf=panel.asOf, start=new Date(Date.parse(asOf)-180*86400000).toISOString().slice(0,10);
  const assets=panel.assets.filter(a=>a.assetClass==='crypto'&&ALWAYS_TRACKED.includes(a.symbol));
  const benchmark=assets.find(a=>a.symbol==='BTC')?.bars || [];
  const report={asOf,start,actionable:false,dataQuality:assessTrackedPanel(panel),
    versions:{hierarchical:HIERARCHICAL_VERSION,adaptive:ADAPTIVE_VERSION},assets:{},
    limits:['Weekly samples use each native estimator’s anchor grid; compare candidate pairs on common dates.',
      'Hierarchical partial pooling uses the seven tracked assets here, not the full production universe.',
      'Magnitude is absolute point-return forecast, not prediction-interval quality.']};
  for (const horizon of [1,7]) {
    const h=walkForwardPanel(assets,{asOf,horizon,benchmark,
      derivativesBySymbol:new Map(Object.entries(panel.derivatives||{})),
      supplyBySymbol:new Map(Object.entries(panel.supply||{}))});
    for (const asset of assets) {
      const a=walkForwardAsset(asset.bars,{asOf,horizon,benchmark,symbol:asset.symbol});
      const hr=h.outcomes.filter(r=>r.symbol===asset.symbol&&r.asOf>=start&&r.targetDate<asOf);
      const ar=a.outcomes.filter(r=>r.asOf>=start&&r.targetDate<asOf);
      const common=new Set(hr.map(r=>r.asOf).filter(d=>ar.some(r=>r.asOf===d)));
      function metrics(rows) {
        const y=rows.map(r=>r.actualPct),p=rows.map(r=>r.predictedPct);
        return {n:rows.length,directionAccuracy:mean(rows.map(r=>Number(r.directionCorrect))),
          signedMaePct:mean(rows.map(r=>r.absoluteErrorPct)),zeroMaePct:mean(y.map(Math.abs)),
          oosR2:rows.length?1-rows.reduce((s,r)=>s+(r.actualPct-r.predictedPct)**2,0)/y.reduce((s,v)=>s+v*v,0):null,
          magnitudeMaePct:mean(rows.map(r=>Math.abs(Math.abs(r.predictedPct)-Math.abs(r.actualPct)))),
          magnitudeSpearman:spearman(p.map(Math.abs),y.map(Math.abs)),
          intervalCoverage:mean(rows.filter(r=>r.covered!=null).map(r=>Number(r.covered))),
          netPct:mean(rows.map(r=>r.netReturnPct))};
      }
      (report.assets[asset.symbol] ||= {})[horizon]={hierarchical:metrics(hr),adaptive:metrics(ar),
        commonDates:{hierarchical:metrics(hr.filter(r=>common.has(r.asOf))),adaptive:metrics(ar.filter(r=>common.has(r.asOf)))}};
    }
  }
  return report;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const panel=JSON.parse(await readFile(process.argv[2],'utf8'));
  await writeFile(process.argv[3],JSON.stringify(compareNative(panel),null,2));
}
