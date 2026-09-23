// Export point-in-time daily research rows; no D1 writes or production calls.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { featureRow, sanitizeBars } from './panel-features.mjs';
import { ewmaVol, harComponents } from './model-zoo.mjs';
export const TRACKED = ['BTC','ETH','SOL','XLM','XRP','HYPE','HBAR','ARB'];
const DAY = 86400000;
const offset = (d,n) => new Date(Date.parse(d+'T00:00:00Z')+n*DAY).toISOString().slice(0,10);
const logRatio = (a,b) => a > 0 && b > 0 ? Math.log(a/b) : null;

export function researchRows(panel, { symbols = TRACKED } = {}) {
  const assets = panel.assets.filter(a => a.assetClass === 'crypto' && symbols.includes(a.symbol));
  const bars = new Map(assets.map(a => [a.symbol, sanitizeBars(a.bars, { asOf: panel.asOf })]));
  const byDate = new Map([...bars].map(([s,bs]) => [s,new Map(bs.map(b=>[b.date,b]))]));
  const result = { asOf: panel.asOf, symbols, rows: [], coverage: {} };
  for (const asset of assets) {
    const symbol = asset.symbol, bs = bars.get(symbol);
    const deriv = panel.derivatives?.[symbol] || [], funding = panel.funding?.[symbol] || [];
    const dmap = new Map(deriv.map(r=>[r.date,r]));
    const liq = new Map((panel.liquidity || []).filter(r=>r.symbol===symbol).map(r=>[r.date,r]));
    const fsource = [...new Set(funding.map(r=>r.source))];
    const dates = bs.map(b=>b.date);
    const delay = rows => rows.map(r=>({...r,date:offset(r.date,1)}));
    const delayedDeriv=delay(deriv), delayedSupply=delay(panel.supply?.[symbol]||[]);
    const benchmarkByDate=new Map([...byDate.get('BTC')||[]].map(([d,b])=>[d,b.close]));
    result.coverage[symbol] = { bars: bs.length, first: dates[0], last: dates.at(-1),
      ageDays: (Date.parse(panel.asOf)-Date.parse(dates.at(-1)))/DAY,
      priceSources: [...new Set(bs.map(b=>b.source))], quarantined: asset.quarantined,
      missingPriceDays: dates.slice(1).reduce((n,d,i)=>n+Math.max(0,(Date.parse(d)-Date.parse(dates[i]))/DAY-1),0),
      volumeMissing: bs.filter(b=>!(b.volume>0)).length,
      derivatives: deriv.length, derivativesLast: deriv.at(-1)?.date,
      funding: funding.length, fundingSources: fsource, fundingFirst: funding[0]?.date,
      settlementHistory: funding.filter(r=>r.source==='binance-fapi-direct').length,
      liquidity: liq.size, supply: (panel.supply?.[symbol]||[]).length,
      warnings: ['Date-only archives lack original availability timestamps; optional lanes delayed one UTC day.',
        ...(fsource.some(s=>s!=='binance-fapi-direct') ? ['Legacy funding provenance can be overwritten; this ablation is diagnostic until canonical settlement backfill.'] : [])] };
    for (let i=60;i<bs.length;i++) {
      const b=bs[i], date=b.date, previous=offset(date,-1);
      // Portal files and vendor snapshots do not prove same-close availability.
      // Shift optional lanes a full day before feeding the existing feature code.
      const f=featureRow(bs,i,{assetClass:'crypto',benchmarkByDate,
        derivatives:delayedDeriv, supply:delayedSupply});
      if (!f) continue;
      const values={...f.raw};
      const returns=bs.slice(i-59,i+1).map((x,j)=>Math.log(x.close/bs[i-60+j].close));
      const har=harComponents(returns);
      values.harDaily=har.d;values.harWeek=har.w;values.harMonth=har.m;
      values.ewmaVol=ewmaVol(returns);values.dailyVol=f.dailyVol;
      values.intradayRange=b.high>0 && b.low>0 && b.high>=b.low ? Math.log(b.high/b.low) : null;
      const d=dmap.get(previous), d1=dmap.get(offset(previous,-1));
      // Quantity distinguishes actual contracts from USD OI's mechanical price effect.
      values.oiQuantityChange1=logRatio(d?.oi_qty_close,d1?.oi_qty_close);
      values.topTraderPosition=d?.toptrader_position_ls>0 ? Math.log(d.toptrader_position_ls):null;
      values.bookImbalance=liq.get(previous)?.book_imbalance_1pct ?? null;
      values.logDepth=liq.get(previous)?.depth_1pct_usd>0 ? Math.log(liq.get(previous).depth_1pct_usd):null;
      const fr=funding.find(r=>r.date===previous);
      const history=funding.filter(r=>r.date<=previous && r.source===fr?.source && Number.isFinite(r.funding_rate)).slice(-252);
      // Percentile is invariant to vendor rate units. No mixed-provider history.
      values.fundingRank=fr && history.length>=30 ? history.filter(r=>r.funding_rate<=fr.funding_rate).length/history.length-.5:null;
      for (const leader of symbols) {
        if (leader===symbol) continue;
        const bm=byDate.get(leader);
        for (const lag of [1,3]) {
          // Strict prior-day predictor, never the follower's future interval.
          const end=bm?.get(previous),start=bm?.get(offset(previous,-lag));
          values[`leader_${leader}_${lag}`]=logRatio(end?.close,start?.close);
        }
      }
      for (const horizon of [1,7]) {
        const end=bs[i+horizon];
        if (!end || end.date!==offset(date,horizon)) continue;
        const target=Math.expm1(Math.log(end.close/b.close))*100;
        result.rows.push({symbol,date,targetDate:end.date,horizon,target,values});
      }
    }
  }
  for (const symbol of symbols) {
    const recent=result.rows.filter(r=>r.symbol===symbol && r.horizon===1 && Date.parse(panel.asOf)-Date.parse(r.date)<=180*DAY);
    if (result.coverage[symbol]) result.coverage[symbol].recentFeatureCoverage=Object.fromEntries(
      [...new Set(recent.flatMap(r=>Object.keys(r.values)))].map(name=>[name,{measured:recent.filter(r=>Number.isFinite(r.values[name])).length,total:recent.length}]));
  }
  return result;
}
if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const panel=JSON.parse(await readFile(process.argv[2],'utf8'));
  await writeFile(process.argv[3],JSON.stringify(researchRows(panel)));
}
