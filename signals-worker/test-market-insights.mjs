import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {parseGlobalHistory,STABLE_IDS,fetchGlobalHistory} from './scripts/stable-basket-data.mjs';
import {cmcRequest,parseLiquidations,loadCmcLiquidations,collectCmc100,CMC_BACKOFF_MS,CMC_HISTORY_BACKOFF_MS,CMC_HISTORY_PAGE_PACE_MS} from './scripts/cmc-research.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {alignedOiWindow,historicalLevels,explainAssetMove,persistLiquidations,buildMarketExplanations,CMC_TRACKED_IDS} from './scripts/market-explanations.mjs';
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
 assert.equal(r.liquidationProviderStatus,'unavailable');assert.deepEqual(Object.keys(r.assets).sort(),Object.keys(CMC_TRACKED_IDS).sort());assert.ok(r.assets.ARB,'ARB, added 2026-09-23, is explained like every other tracked asset');assert.ok(Object.values(r.assets).every(a=>a.status==='insufficient-live-data'&&a.liquidations===null));
});

test('global volume collection survives shared-IP throttling and respects Retry-After',async()=>{
 let n=0;const waits=[];
 const r=await fetchGlobalHistory('https://api.coingecko.com/example',{wait:async ms=>waits.push(ms),fetcher:async()=>++n<5?new Response('{}',{status:429,headers:{'Retry-After':'45'}}):new Response('{"prices":[]}')});
 assert.equal(n,5);assert.deepEqual(waits,[45000,45000,60000,120000]);assert.equal(r.sha256.length,64);
 let count=0;await assert.rejects(()=>fetchGlobalHistory('https://api.coingecko.com/example',{wait:async()=>{},fetcher:async()=>{count++;return new Response('{}',{status:404});}}),/HTTP 404/);assert.equal(count,1);
 count=0;await assert.rejects(()=>fetchGlobalHistory('https://api.coingecko.com/example',{wait:async()=>{},fetcher:async()=>{count++;return new Response('{}',{status:429});}}),/HTTP 429/);assert.equal(count,6);
});

// Replays the 2026-09-21/28 failures: CMC's keyless endpoint throttles a shared
// runner IP per rolling minute (those runs got 32 and 26 of 37 pages). A fake
// clock advances through `wait` and ~0.2s per request, as observed in the logs.
function throttledCmc({perMinute=26,key=null}={}){
 const clock={t:0},hits=[],seen=[];
 const wait=async ms=>{clock.t+=ms;};
 const fetcher=async(url,o)=>{
  seen.push({url,headers:o.headers});clock.t+=200;
  while(hits.length&&hits[0]<=clock.t-60000)hits.shift();
  if(!key&&hits.length>=perMinute)return new Response('{"status":{"error_code":1008,"error_message":"You\'ve hit an IP rate limit."}}',{status:429});
  hits.push(clock.t);
  const end=Date.parse(new URL(url).searchParams.get('time_end'));
  const data=Array.from({length:10},(_,i)=>({update_time:new Date(end-(9-i)*86400000).toISOString(),value:200+i}));
  return new Response(JSON.stringify({status:{error_code:0},data}),{status:200});
 };
 const collect=(output,opts={})=>collectCmc100({asOf:'2026-09-28',output,wait,...opts,
  request:(p,q,o)=>cmcRequest(p,q,{...o,fetcher,wait})});
 return {collect,clock,seen};
}
test('CMC100 history outlasts a per-minute keyless throttle that the old timing could not',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'cmc100-'));
 try{
  // Pre-fix timing (1.2s pacing, 2/4/8s retries) fails the way production did.
  await assert.rejects(throttledCmc().collect(join(dir,'old'),{paceMs:1200,backoffMs:CMC_BACKOFF_MS}),/CMC HTTP 429/);
  // Current timing completes the whole year with no key, in bounded time.
  const cur=throttledCmc();
  const r=await cur.collect(join(dir,'new'));
  assert.ok(r.series.length>=365,`full year collected (${r.series.length})`);
  assert.ok(cur.seen.every(s=>/public-api/.test(s.url)&&!s.headers['X-CMC_PRO_API_KEY']),'keyless when no key is configured');
  assert.ok(cur.clock.t<10*60000,`bounded wall time (${Math.round(cur.clock.t/1000)}s)`);
  // A much stricter throttle still completes: the backoff, not just pacing.
  const strict=throttledCmc({perMinute:12});
  assert.ok((await strict.collect(join(dir,'strict'))).series.length>=365);
  await assert.rejects(throttledCmc({perMinute:12}).collect(join(dir,'strict-old'),{backoffMs:CMC_BACKOFF_MS}),/CMC HTTP 429/);
  // With a key: authenticated host and header.
  const keyed=throttledCmc({key:'k'});
  await keyed.collect(join(dir,'keyed'),{key:'k'});
  assert.ok(keyed.seen.every(s=>!/public-api/.test(s.url)&&s.headers['X-CMC_PRO_API_KEY']==='k'));
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('CMC history retries honour Retry-After and stay bounded; the default chain is unchanged',async()=>{
 assert.deepEqual([...CMC_BACKOFF_MS],[2000,4000,8000]);assert.ok(CMC_HISTORY_PAGE_PACE_MS>=2000);
 const waits=[];let n=0;
 await cmcRequest('/v3/index/cmc100-historical',{},{backoffMs:CMC_HISTORY_BACKOFF_MS,wait:async ms=>waits.push(ms),
  fetcher:async()=>++n<4?new Response('{}',{status:429,headers:{'Retry-After':n===1?'90':'1'}}):new Response('{"status":{"error_code":0},"data":[]}')});
 assert.deepEqual(waits,[90000,30000,60000]);
 n=0;await assert.rejects(cmcRequest('/x',{},{backoffMs:CMC_HISTORY_BACKOFF_MS,wait:async()=>{},fetcher:async()=>{n++;return new Response('{"status":{"error_code":1008}}',{status:429});}}),/CMC HTTP 429/);
 assert.equal(n,CMC_HISTORY_BACKOFF_MS.length+1);
});
