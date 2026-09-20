import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {parseGlobalHistory,STABLE_IDS} from './scripts/stable-basket-data.mjs';
import {cmcRequest,parseLiquidations,loadCmcLiquidations} from './scripts/cmc-research.mjs';
import {alignedOiWindow,historicalLevels,explainAssetMove,persistLiquidations,buildMarketExplanations} from './scripts/market-explanations.mjs';
import {researchSupplement,persistResearchSupplement,loadSessionHealth} from './scripts/session-health.mjs';
const now=Date.parse('2026-09-19T12:00:00Z'),DAY=86400000;
const ticks=Array.from({length:61},(_,i)=>({ts:now-3600000+i*60000,oi_contracts:1000-i,mark_price:100+i/10}));
const bars=Array.from({length:20},(_,i)=>({date:new Date(now-(20-i)*DAY).toISOString().slice(0,10),close:100+i,high:102+i,low:98+i,source:'binance-spot'}));
const liq=(patch={})=>({data:{cryptocurrencies:[{crypto_id:1,symbol:'BTC',quotes:[{crypto_id:2781,symbol:'USD',last_updated:new Date(now).toISOString(),long_liquidations_1h:20,short_liquidations_1h:80,total_liquidations_1h:100,...patch}]}]}});
test('exact stablecoin identity; completed snapshots; missing volume remains unknown',()=>{
 assert.equal(Object.keys(STABLE_IDS).length,8);assert.equal(STABLE_IDS.USDG,'global-dollar');
 const t=now-12*3600000,raw={prices:[[t-DAY,2],[t,3],[t+1234,4]],total_volumes:[],market_caps:[[t-DAY,50]]};
 const r=parseGlobalHistory(raw,{asOf:'2026-09-19'});assert.equal(r.length,1);assert.equal(r[0].volume,null);assert.equal(r[0].assumedAvailableAt,t-DAY+600000);
 raw.prices.push([t-DAY,8]);assert.throws(()=>parseGlobalHistory(raw,{asOf:'2026-09-19'}),/Conflicting/);
});
test('CMC public requests bound retries and surface API errors',async()=>{
 let calls=0;const r=await cmcRequest('/v3/index/cmc100-historical',{count:'10'},{wait:async()=>{},fetcher:async(url,o)=>{assert.match(url,/public-api/);assert.deepEqual(o.headers,{});return new Response('{"status":{"error_code":0},"data":[]}',{status:++calls<3?429:200});}});
 assert.equal(calls,3);assert.equal(r.sha256.length,64);
 await assert.rejects(()=>cmcRequest('/x',{}, {fetcher:async()=>new Response('{"status":{"error_code":42}}')}),/API error/);
});
test('liquidation totals, freshness and absence are validated',async()=>{
 assert.equal(parseLiquidations(liq(),now)['1'].quality,'ok');assert.equal(parseLiquidations(liq({last_updated:new Date(now-700000).toISOString()}),now)['1'].quality,'stale');
 assert.deepEqual(parseLiquidations(liq({long_liquidations_1h:-1}),now),{});assert.deepEqual(parseLiquidations(liq({total_liquidations_1h:500}),now),{});
 assert.equal(parseLiquidations(liq(),now)['1027'],undefined);
 assert.equal((await loadCmcLiquidations({},now,()=>{throw Error('must not call')})).status,'not-configured');
});
test('OI uses aligned quantities, rejects stale data, future observations and gaps',()=>{
 const w=alignedOiWindow(ticks,now);assert.ok(Math.abs(w.oiContractsChangePct+6)<1e-8);assert.ok(Math.abs(w.priceChangePct-6)<1e-8);
 assert.equal(alignedOiWindow(ticks,now+180001),null);assert.equal(alignedOiWindow(ticks.filter((_,i)=>i<20||i>25),now),null);assert.equal(alignedOiWindow(ticks.slice(1),now),null);
 assert.deepEqual(alignedOiWindow([...ticks,{ts:now+1,oi_contracts:1,mark_price:1}],now),w);
});
test('levels distinguish genuine OHLC from closing samples and stale data',()=>{
 assert.equal(historicalLevels(bars,now).levels[1].value,121);
 const cg=bars.map(r=>({...r,date:new Date(Date.parse(r.date)+DAY).toISOString().slice(0,10),source:'coingecko',high:null,low:null}));
 const r=historicalLevels(cg,now);assert.equal(r.through,'2026-09-18');assert.equal(r.levels[1].label,'20-day closing high');assert.equal(r.levels[1].value,119);
 assert.equal(historicalLevels(bars,now+4*DAY).status,'stale');assert.equal(historicalLevels(bars.slice(1),now).status,'insufficient-history');
});
test('OI declines never become a forced-liquidation or fading-momentum claim',()=>{
 const r=explainAssetMove({symbol:'BTC',ticks,bars,nowMs:now});assert.equal(r.actionable,false);assert.equal(r.causalClaim,false);assert.equal(r.continuationProbability,null);
 assert.match(r.interpretation.join(' '),/possible short covering/);assert.match(r.interpretation.join(' '),/cannot distinguish voluntary/);assert.match(r.interpretation.join(' '),/does not establish that momentum will fade/);
 assert.match(r.facts.at(-1).text,/not zero/);assert.equal(r.watch.length,3);
 const stale=explainAssetMove({symbol:'BTC',ticks,bars,nowMs:now+DAY});assert.equal(stale.status,'insufficient-live-data');
 const reported=explainAssetMove({symbol:'BTC',ticks,bars,nowMs:now,liquidation:parseLiquidations(liq(),now)['1']});assert.match(reported.interpretation.join(' '),/coincided/);assert.equal(reported.causalClaim,false);
});
test('D1 liquidation writes are idempotent; supplemental summaries retain distinct versions',async()=>{
 const db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('./migrations/0045_liquidation_observations.sql',import.meta.url),'utf8'));db.exec('CREATE TABLE session_flow_research(as_of TEXT,version TEXT,input_hash TEXT,code_hash TEXT,created_at TEXT,summary_json TEXT,PRIMARY KEY(as_of,version,input_hash,code_hash))');
 const query=async(_,sql,params)=>db.prepare(sql).all(...params),rows=Object.values(parseLiquidations(liq(),now));await persistLiquidations({},rows,query);await persistLiquidations({},rows,query);assert.equal(db.prepare('SELECT COUNT(*) n FROM liquidation_observations').get().n,1);
 const report={version:'stable-basket-v1',asOf:'2026-09-19',actionable:false,inputHash:'a',codeHash:'b',assets:{BTC:{testN:119,models:{basket8_lag0:{directionEvidence:{low:-1,adjustedP:1}},unused:{}}}}};
 const compact=researchSupplement(report);assert.equal(compact.assets.BTC.models,undefined);assert.deepEqual(compact.assets.BTC.supported,[]);
 await persistResearchSupplement({},report,query);await persistResearchSupplement({}, {...report,version:'calendar-extremes-v1'},query);await persistResearchSupplement({}, {...report,asOf:'2026-09-21'},query);
 const health=await loadSessionHealth({},now,query);assert.equal(health.stableBasket.asOf,'2026-09-19');assert.equal(health.calendar.status,'research-only');assert.equal(health.status,'awaiting-first-run');db.close();
});
test('provider failure and absent OI remain explicit unknowns',async()=>{
 const r=await buildMarketExplanations({}, {nowMs:now,query:async()=>[],liquidationsLoader:async()=>{throw Error('not entitled')}});
 assert.equal(r.liquidationProviderStatus,'unavailable');assert.equal(Object.keys(r.assets).length,7);assert.ok(Object.values(r.assets).every(a=>a.status==='insufficient-live-data'&&a.liquidations===null));
});
