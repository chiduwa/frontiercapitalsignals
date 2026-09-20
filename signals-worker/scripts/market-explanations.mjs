// Evidence-bound explanations. Observations, interpretations and conditions are
// distinct; no causal liquidation claim from open interest, and no trade vote.
import {d1,chunk} from './d1-client.mjs';
import {alignDailyResearchBars} from './archive-policy.mjs';
import {loadCmcLiquidations} from './cmc-research.mjs';
export const INSIGHT_VERSION='market-explanation-v1';
export const CMC_TRACKED_IDS={BTC:1,ETH:1027,SOL:5426,XLM:512,XRP:52,HYPE:32196,HBAR:4642};
const SYMBOLS=Object.keys(CMC_TRACKED_IDS),DAY=86400000;
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const pct=(a,b)=>100*(b/a-1);
export function alignedOiWindow(ticks,nowMs,{windowMs=3600000,maxAgeMs=120000,toleranceMs=120000}={}){
 const rows=ticks.filter(r=>finite(r.ts)&&r.ts<=nowMs&&finite(r.oi_contracts)&&r.oi_contracts>0&&finite(r.mark_price)&&r.mark_price>0).sort((a,b)=>a.ts-b.ts);
 const end=rows.at(-1);if(!end||nowMs-end.ts>maxAgeMs)return null;
 const target=end.ts-windowMs,start=rows.filter(r=>r.ts<=target&&target-r.ts<=toleranceMs).at(-1);
 if(!start)return null;
 // Gaps inside the window invalidate a statement about continuously observed positioning.
 const span=rows.filter(r=>r.ts>=start.ts&&r.ts<=end.ts);
 if(span.some((r,i)=>i>0&&r.ts-span[i-1].ts>180000))return null;
 return {startAt:new Date(start.ts).toISOString(),endAt:new Date(end.ts).toISOString(),
   priceStart:start.mark_price,priceEnd:end.mark_price,priceChangePct:pct(start.mark_price,end.mark_price),
   contractsStart:start.oi_contracts,contractsEnd:end.oi_contracts,oiContractsChangePct:pct(start.oi_contracts,end.oi_contracts),
   source:'Binance USD-M mark price and OI contract quantity',samples:span.length};
}
export function historicalLevels(bars,nowMs){
 const day=new Date(nowMs).toISOString().slice(0,10);
 const rows=alignDailyResearchBars(bars).filter(r=>r.date<day&&finite(r.close)&&r.close>0).sort((a,b)=>a.date.localeCompare(b.date)).slice(-20);
 if(rows.length<20)return {status:'insufficient-history',levels:[]};
 const last=rows.at(-1),ageDays=(Date.parse(day)-Date.parse(last.date))/DAY;
 const fullOhlc=rows.every(r=>finite(r.high)&&finite(r.low)&&r.high>=r.close&&r.low<=r.close&&r.low>0);
 return {status:ageDays>3?'stale':'available',through:last.date,basis:fullOhlc?'20 completed UTC daily bars':'20 completed daily closing observations',
  levels:[{label:'Previous completed daily close',value:last.close},
    {label:fullOhlc?'20-day high':'20-day closing high',value:Math.max(...rows.map(r=>fullOhlc?r.high:r.close))},
    {label:fullOhlc?'20-day low':'20-day closing low',value:Math.min(...rows.map(r=>fullOhlc?r.low:r.close))}]};
}
export function explainAssetMove({symbol,ticks=[],bars=[],lastOiAt=null,liquidation=null,nowMs=Date.now()}){
 const window=alignedOiWindow(ticks,nowMs),levels=historicalLevels(bars,nowMs),facts=[],interpretation=[],watch=[];
 const result={symbol,version:INSIGHT_VERSION,asOf:new Date(nowMs).toISOString(),actionable:false,
   status:window?'observed':'insufficient-live-data',oiWindow:window,lastOiAt:lastOiAt?new Date(lastOiAt).toISOString():null,
   levels,facts,interpretation,watch,liquidations:null,causalClaim:false,continuationProbability:null};
 if(window){
  facts.push({text:`Mark price changed ${window.priceChangePct.toFixed(2)}% over the measured hour; open interest in contracts changed ${window.oiContractsChangePct.toFixed(2)}%.`,source:window.source,asOf:window.endAt});
  if(Math.abs(window.priceChangePct)>=1&&window.oiContractsChangePct<=-.25){
   interpretation.push(window.priceChangePct>0?'Price rose while contract OI fell: consistent with position closing, including possible short covering.':'Price fell while contract OI fell: consistent with position closing, including possible long deleveraging.');
   interpretation.push('Open interest cannot distinguish voluntary closes from forced liquidations. This pattern alone does not establish that momentum will fade.');
  }else if(Math.abs(window.priceChangePct)>=1&&window.oiContractsChangePct>=.25){
   interpretation.push('Contract OI expanded during the move. New leveraged exposure was present, but OI alone does not identify the initiating side or prove continuation.');
  }else interpretation.push('The measured price/OI combination does not support a strong positioning explanation.');
 }else{
  interpretation.push('Recent, continuous OI observations are unavailable. A short squeeze or liquidation-driven move cannot be confirmed from this feed.');
 }
 const expected=CMC_TRACKED_IDS[symbol];
 if(liquidation?.quality==='ok'&&liquidation.id===expected&&liquidation.symbol===symbol){
  result.liquidations=liquidation;
  facts.push({text:`Reported rolling-hour liquidations: $${Math.round(liquidation.shortUsd).toLocaleString('en-US')} shorts and $${Math.round(liquidation.longUsd).toLocaleString('en-US')} longs.`,source:'CoinMarketCap aggregated liquidation report',url:liquidation.source,asOf:liquidation.observedAt});
  const aligned=window&&Math.abs(Date.parse(window.endAt)-Date.parse(liquidation.observedAt))<=120000;
  if(aligned&&window.priceChangePct>0&&liquidation.shortUsd>liquidation.longUsd&&liquidation.shortUsd>0)
   interpretation.push('Short liquidations coincided with the measured rise. They are evidence of forced buying, not proof of the sole cause or of a coming reversal.');
  else if(aligned&&window.priceChangePct<0&&liquidation.longUsd>liquidation.shortUsd&&liquidation.longUsd>0)
   interpretation.push('Long liquidations coincided with the measured decline. They are evidence of forced selling, not a forecast that a rebound will follow.');
  else if(!aligned)interpretation.push('The liquidation window and live OI window are not closely aligned; no combined event attribution is made.');
 }else facts.push({text:'No fresh, verified liquidation totals are available for this asset. Missing reports are not zero liquidations.',source:'Collection status',asOf:new Date(nowMs).toISOString()});
 if(levels.status==='available'){
  const high=levels.levels[1],low=levels.levels[2];
  watch.push({condition:`A completed bar above the ${high.label.toLowerCase()}`,level:high.value,meaning:'A range break to monitor; look for sustained spot participation and a successful retest. No continuation probability is established.'});
  watch.push({condition:`A completed bar below the ${low.label.toLowerCase()}`,level:low.value,meaning:'A lower range break to monitor; distinguish persistent selling from a brief wick. No rebound probability is established.'});
 }
 watch.push({condition:'To judge whether the move persists',meaning:'Watch subsequent price acceptance, spot buying/selling imbalance, contract OI and fresh forced-liquidation reports together. These observations are not a trade signal.'});
 return result;
}
export async function buildMarketExplanations(env,{nowMs=Date.now(),query=d1,liquidationsLoader=loadCmcLiquidations}={}){
 const placeholders=SYMBOLS.map(()=>'?').join(','),date=new Date(nowMs).toISOString().slice(0,10);
 const [ticks,bars,last,liqResult]=await Promise.all([
  query(env,`SELECT symbol,ts,oi_contracts,mark_price FROM oi_tick WHERE symbol IN (${placeholders}) AND ts>=? AND ts<=? ORDER BY symbol,ts`,[...SYMBOLS,nowMs-7200000,nowMs]),
  query(env,`SELECT symbol,date,close,high,low,source FROM asset_daily_bars WHERE asset_class='crypto' AND symbol IN (${placeholders}) AND date>=? AND date<? ORDER BY symbol,date`,[...SYMBOLS,new Date(nowMs-45*DAY).toISOString().slice(0,10),date]),
  query(env,`SELECT symbol,MAX(ts) last_ts FROM oi_tick WHERE symbol IN (${placeholders}) AND ts<=? GROUP BY symbol`,[...SYMBOLS,nowMs]),
  liquidationsLoader(env,nowMs).catch(e=>({status:'unavailable',assets:{},note:e.message}))
 ]);
 const assets={};
 for(const symbol of SYMBOLS)assets[symbol]=explainAssetMove({symbol,nowMs,ticks:ticks.filter(r=>r.symbol===symbol),bars:bars.filter(r=>r.symbol===symbol),lastOiAt:last.find(r=>r.symbol===symbol)?.last_ts,
   liquidation:liqResult.assets[String(CMC_TRACKED_IDS[symbol])]});
 return {version:INSIGHT_VERSION,asOf:new Date(nowMs).toISOString(),actionable:false,liquidationProviderStatus:liqResult.status,
   assets,liquidationObservations:Object.values(liqResult.assets)};
}
export async function persistLiquidations(env,rows,query=d1){
 for(const batch of chunk(rows.filter(r=>r.quality==='ok'),10))await query(env,`INSERT OR IGNORE INTO liquidation_observations
   (provider,observed_at,asset_id,symbol,window_hours,long_usd,short_usd,total_usd,ingested_at)
   VALUES ${batch.map(()=>'(?,?,?,?,?,?,?,?,?)').join(',')}`,
   batch.flatMap(r=>[r.provider,r.observedAt,String(r.id),r.symbol,r.windowHours,r.longUsd,r.shortUsd,r.totalUsd,new Date().toISOString()]));
}
