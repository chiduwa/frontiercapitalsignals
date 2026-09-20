import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { parseHourlyKlines,collectSessionData } from './scripts/session-data.mjs';
import { marketFlowSnapshot,evaluateTechniques,buildCryptoMetrics } from './worker.js';
import { loadSessionHealth,persistSessionReport } from './scripts/session-health.mjs';
import { loadFundingHistory,loadMaturedForecastRows,OUTCOME_MODEL_VERSION,logRun } from './scripts/reliability.mjs';
const t=Date.parse('2025-03-09T13:00:00Z');
const line=(scale=1)=>[t*scale,100,102,99,101,10,(t+3599999)*scale,1000,5,5,500,0].join(',');
test('hourly parser recognizes milliseconds and microseconds, incomplete bars, conflicts and blanks',()=>{
 const opts={asOf:'2025-03-10',period:'2025-03'};
 const a=parseHourlyKlines(line(),opts),b=parseHourlyKlines(line(1000),opts);
 assert.deepEqual(a,b);assert.equal(a.rows[0].t,t);
 assert.equal(parseHourlyKlines(line(),{...opts,asOf:'2025-03-09'}).rows.length,0);
 assert.equal(parseHourlyKlines(line().replace(',10,',',,'),opts).rejected,1);
 assert.throws(()=>parseHourlyKlines(line()+'\n'+line().replace(',101,',',100,'),opts),/Conflicting/);
});
test('collector rejects an invalid calendar cutoff before fetching',async()=>{
 await assert.rejects(collectSessionData({asOf:'2026-02-30',cache:'/tmp/fcs-invalid-session',fetcher:()=>{throw Error('should not fetch');}}),/Invalid/);
});
test('matched-clock snapshot uses provider IDs, preserves missing values, and flags stale clocks',()=>{
 const at='2026-09-19T14:00:00Z';
 const raw=[{id:'usd-coin',symbol:'usdc',total_volume:50,last_updated:at},{id:'bitcoin',symbol:'btc',total_volume:null,last_updated:at},
 {id:'tether',symbol:'usdt',total_volume:100,last_updated:'2026-09-19T12:00:00Z'},
 {id:'gold-token',symbol:'usdc',total_volume:1e9,last_updated:at}];
 const rows=marketFlowSnapshot([...raw,raw[0]],at);assert.equal(rows.length,3);
 assert.equal(rows[0].group,'usd-stable');assert.equal(rows[1].volume,null);assert.equal(rows[1].quality,'missing-volume');assert.equal(rows[2].quality,'stale');
 assert.equal(marketFlowSnapshot(null,at).length,0);
});
test('funding vote abstains on provider-native raw units and accepts an own-source percentile',()=>{
 const base={symbol:'BTC',funding:.01,fundingRateUnit:'provider-native',chg7:30};
 const vote=m=>evaluateTechniques(m,'crypto').find(t=>t.id==='positioning');
 assert.equal(vote(base).dir,null);
 assert.equal(vote({...base,fundingPercentile:.99}).dir,-1);
});
test('funding percentile history never mixes snapshot and settlement measurements',async()=>{
 const old=globalThis.fetch;
 const rows=[...Array.from({length:50},()=>({symbol:'BTC',source:'binance-fapi-direct',funding_rate:.0001})),
 ...Array.from({length:40},(_,i)=>({symbol:'ETH',source:'coingecko',funding_rate:i/100})),
 {symbol:'ETH',source:'binance-fapi-direct',funding_rate:999}];
 globalThis.fetch=async()=>Response.json({success:true,result:[{results:rows}]});
 try{const result=await loadFundingHistory({});assert.equal(result.BTC,undefined);assert.equal(result.ETH.fundingRates.length,40);assert.equal(result.ETH.fundingRates.at(-1),.39);}
 finally{globalThis.fetch=old;}
});
test('immutable observations persist, and pending legacy forecasts cannot mature under the new version',async()=>{
 const db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('./scripts/schema.sql',import.meta.url),'utf8'));
 const old=globalThis.fetch;globalThis.fetch=async(_u,o)=>{const {sql,params}=JSON.parse(o.body);db.prepare(sql).run(...params);return Response.json({success:true,result:[{results:[]}]});};
 const at='2026-09-19T00:00:00Z';
 const log={prices:[],votes:[{asset_class:'crypto',symbol:'BTC',technique_id:'positioning',dir:1}],ranges:[],marketFlow:marketFlowSnapshot([{id:'bitcoin',symbol:'btc',total_volume:50,last_updated:at}],at)};
 try{
  await logRun({},at,log);await logRun({},at,{...log,marketFlow:log.marketFlow.map(r=>({...r,volume:99}))});
  assert.equal(db.prepare('SELECT volume_usd_24h FROM market_flow_observations').get().volume_usd_24h,50);
  db.exec("INSERT INTO technique_votes(run_at,asset_class,symbol,technique_id,dir) VALUES('2026-09-18','crypto','BTC','positioning',1)");
  const query=async(_e,sql,params)=>db.prepare(sql).all(...params);
  const {due}=await loadMaturedForecastRows({},'2026-09-20',24,query);assert.equal(due.length,1);assert.equal(due[0].run_at,at);
  assert.equal(db.prepare('SELECT model_version FROM forecast_run_versions').get().model_version,OUTCOME_MODEL_VERSION);
 } finally{globalThis.fetch=old;db.close();}
});
test('session summaries expire and remain non-actionable; duplicate writes preserve history',async()=>{
 const db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('./migrations/0044_session_flow_research.sql',import.meta.url),'utf8'));
 const query=async(_e,sql,params)=>db.prepare(sql).all(...params);
 const r={version:'session-flow-v1',asOf:'2026-09-01',inputHash:'abc',codeHash:'def',actionable:false,assets:{},stablecoin:{snapshotDays:1,assets:{}}};
 await persistSessionReport({},r,query);await persistSessionReport({},r,query);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM session_flow_research').get().n,1);
 const result=await loadSessionHealth({},Date.parse('2026-09-19'),query);assert.equal(result.status,'stale');assert.equal(result.actionable,false);
 db.close();
});
test('stored snapshot percentiles count each completed day once and exclude direct units',async()=>{
 const db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('./scripts/schema.sql',import.meta.url),'utf8'));
 for(let i=1;i<=20;i++){
  const day=new Date(Date.now()-i*86400000).toISOString().slice(0,10);
  db.prepare('INSERT INTO funding_snapshot_daily(symbol,date,funding_rate,open_interest,basis_pct,source,observed_at) VALUES(?,?,?,?,?,?,?)').run('BTC',day,i/100,100,null,'coingecko',day+'T23:00:00Z');
  db.prepare('INSERT INTO funding_rate_daily(symbol,date,funding_rate,source) VALUES(?,?,?,?)').run('BTC',day,999,i%2?'coingecko':'binance-fapi-direct');
 }
 const today=new Date().toISOString().slice(0,10);
 db.prepare('INSERT INTO funding_snapshot_daily(symbol,date,funding_rate,open_interest,basis_pct,source,observed_at) VALUES(?,?,?,?,?,?,?)').run('BTC',today,999,100,null,'coingecko',today+'T00:00:00Z');
 const old=globalThis.fetch;globalThis.fetch=async(_u,o)=>{const {sql,params}=JSON.parse(o.body);return Response.json({success:true,result:[{results:db.prepare(sql).all(...params)}]});};
 try{const x=await loadFundingHistory({});assert.equal(x.BTC.fundingRates.length,20);assert.equal(x.BTC.fundingRates.at(-1),.20);}
 finally{globalThis.fetch=old;db.close();}
});

test('live funding percentile follows the current venue and refuses unknown venue history',()=>{
 const coin={symbol:'btc',current_price:100,sparkline_in_7d:{price:Array.from({length:100},(_,i)=>100+i)}};
 const history={fundingRates:[0,.01,.02],byInstrument:{'["A","BTCUSDT"]':{fundingRates:[0,.01,.02]},'["B","BTCUSDT"]':{fundingRates:[.10,.11,.12]}}};
 const metric=market=>buildCryptoMetrics(coin,{funding:{fundingRate:.01,fundingRateUnit:'provider-native',market,contractId:'BTCUSDT'},fundingHistory:history});
 assert.equal(metric('unknown').fundingPercentile,null);
 assert.equal(buildCryptoMetrics(coin,{funding:{fundingRate:.01,fundingRateUnit:'provider-native',market:'A',contractId:'BTCUSD'},fundingHistory:history}).fundingPercentile,null);
 assert.ok(metric('A').fundingPercentile>metric('B').fundingPercentile);
});

test('twenty mixed-contract days cannot masquerade as twenty days for the current contract',async()=>{
 const db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('./scripts/schema.sql',import.meta.url),'utf8'));
 for(let i=1;i<=20;i++){
  const day=new Date(Date.now()-i*86400000).toISOString().slice(0,10);
  db.prepare('INSERT INTO funding_snapshot_daily(symbol,date,funding_rate,open_interest,source,observed_at,venue,contract_id) VALUES(?,?,?,?,?,?,?,?)').run('BTC',day,i/100,100,'coingecko',day+'T23:00:00Z','venue-A',i<=10?'BTCUSDT':'BTCUSD');
 }
 const old=globalThis.fetch;globalThis.fetch=async(_u,o)=>{const {sql,params}=JSON.parse(o.body);return Response.json({success:true,result:[{results:db.prepare(sql).all(...params)}]});};
 try{const x=await loadFundingHistory({});assert.equal(x.BTC.byVenue['venue-A'].fundingRates.length,20);assert.equal(x.BTC.byInstrument['["venue-A","BTCUSDT"]'].fundingRates,null);assert.equal(x.BTC.byInstrument['["venue-A","BTCUSD"]'].fundingRates,null);}
 finally{globalThis.fetch=old;db.close();}
});
