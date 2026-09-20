import { fetchFundingHistory } from './scripts/binance-direct-collect.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { foldFundingToDaily, fundingResumeTime } from './scripts/funding-quality.mjs';
import { upsertFundingDaily } from './scripts/archive.mjs';
import { assessTrackedPanel } from './scripts/tracked-data-quality.mjs';
import { aggregateMetricsCsv } from './scripts/derivatives-archive.mjs';
import { loadHierarchicalPanel, buildHierarchicalReport } from './scripts/hierarchical-research.mjs';
import { featureRow, sanitizeBars } from './scripts/panel-features.mjs';
import { walkForwardPanel } from './scripts/hierarchical-model.mjs';
import { researchRows } from './scripts/tracked-research-data.mjs';
const day=i=>new Date(Date.UTC(2025,0,1+i)).toISOString().slice(0,10);
const ms=i=>Date.parse(day(i)+'T00:00:00Z');
const bars=Array.from({length:280},(_,i)=>({date:day(i),close:100*Math.exp(.002*i+.02*Math.sin(i)),volume:1000+i}));

test('funding sum, variable cadence, duplicates and partial UTC day are distinct',()=>{
  const settlements=[{time:ms(0),rate:.0001},{time:ms(0)+3600000,rate:.0002},{time:ms(0),rate:.0001},{time:ms(1),rate:.1}];
  const rows=foldFundingToDaily(settlements,{nowMs:ms(1)+4000000});
  assert.equal(rows.length,1);assert.equal(rows[0].settlements,2);
  assert.ok(Math.abs(rows[0].funding_sum-.0003)<1e-15);
  assert.ok(Math.abs(rows[0].funding_rate-.00015)<1e-15);
  assert.throws(()=>foldFundingToDaily([...settlements,{time:ms(0),rate:.5}],{nowMs:ms(2)}),/Conflicting/);
  assert.equal(fundingResumeTime(day(3)),ms(2));
  assert.equal(fundingResumeTime(day(200),ms(0),day(1)),ms(1));
  assert.throws(()=>fundingResumeTime(day(2),ms(0),'2025-02-30'),/Invalid/);
});

test('vendor snapshot cannot replace settled funding or retain false source provenance',async()=>{
  const db=new DatabaseSync(':memory:');
  db.exec('CREATE TABLE funding_rate_daily(symbol TEXT,date TEXT,funding_rate REAL,open_interest REAL,basis_pct REAL,source TEXT,PRIMARY KEY(symbol,date))');
  db.exec('CREATE TABLE funding_snapshot_daily(symbol TEXT,date TEXT,funding_rate REAL,open_interest REAL,basis_pct REAL,source TEXT,observed_at TEXT,venue TEXT,contract_id TEXT,rate_unit TEXT,PRIMARY KEY(symbol,date,source))');
  const old=globalThis.fetch;
  globalThis.fetch=async(_url,opts)=>{
    const {sql,params}=JSON.parse(opts.body);db.prepare(sql).run(...params);
    return {ok:true,json:async()=>({success:true,result:[{success:true,results:[]}]})};
  };
  try {
    const write=(source,fundingRate,openInterest)=>upsertFundingDaily({},[{symbol:'BTC',date:day(0),source,fundingRate,openInterest}]);
    await write('coingecko',.01,100);await write('binance-fapi-direct',.0001,null);await write('coingecko',.02,120);
    const row=db.prepare('SELECT * FROM funding_rate_daily').get();
    assert.equal(row.funding_rate,.0001);assert.equal(row.source,'binance-fapi-direct');assert.equal(row.open_interest,120);
    assert.equal(db.prepare('SELECT funding_rate FROM funding_snapshot_daily').get().funding_rate,.02);
  } finally {globalThis.fetch=old;db.close();}
});

test('derivatives reject conflicting duplicates and keep quantity at the same closing timestamp',()=>{
  const h='create_time,symbol,sum_open_interest,sum_open_interest_value';
  const a='2025-01-01 00:00:00,BTCUSDT,1,10',b='2025-01-01 23:55:00,BTCUSDT,,20';
  const config={symbol:'BTC',venue:'BTCUSDT',date:day(0)};
  const r=aggregateMetricsCsv([h,b,a,a].join('\n'),config);
  assert.equal(r.samples,2);assert.equal(r.oi_usd_close,20);assert.equal(r.oi_qty_close,null);
  assert.throws(()=>aggregateMetricsCsv([h,a,a.replace(',1,10',',2,20')].join('\n'),config),/Conflicting/);
});

test('historical cutoff excludes future outcomes and invalid calendar dates',()=>{
  assert.equal(sanitizeBars([{date:'2025-02-30',close:5}]).length,0);
  const config={asOf:day(180),minTrainingSamples:20,refitEvery:7};
  const run=bs=>walkForwardPanel([{symbol:'BTC',assetClass:'crypto',bars:bs}],config);
  assert.deepEqual(run(bars).outcomes,run(bars.slice(0,180)).outcomes);
  assert.ok(run(bars).outcomes.every(r=>r.targetDate<day(180)));
});

test('stale derivatives do not manufacture a measured zero change; equities reject crypto lanes',()=>{
  const d=[{date:day(118),oi_usd_close:100,all_account_ls:1}];
  assert.equal(featureRow(bars,120,{derivatives:d}).available.derivatives,false);
  const current=[...d,{date:day(120),oi_usd_close:110,all_account_ls:1.1}];
  const stock=featureRow(bars,120,{assetClass:'stock',derivatives:current,supply:[{date:day(120),circulating_supply:100,max_supply:200}]});
  assert.equal(stock.available.derivatives,false);assert.equal(stock.available.supply,false);
});

test('loader never spreads current maximum supply into past rows',async()=>{
  const queries=[];
  const query=async(_env,sql)=>{
    queries.push(sql);
    if(sql.includes('SELECT DISTINCT asset_class'))return [{asset_class:'crypto',symbol:'BTC'}];
    if(sql.includes('FROM asset_bar_quarantine'))return [];
    if(sql.includes('FROM asset_daily_bars'))return [{asset_class:'crypto',symbol:'BTC',date:day(0),close:100,volume:100}];
    if(sql.includes('SELECT DISTINCT symbol FROM asset_supply_daily'))return [{symbol:'BTC'}];
    if(sql.includes('FROM asset_supply_snapshot_daily'))return [{symbol:'BTC',date:day(1),circulating_supply:110,max_supply:200}];
    if(sql.includes('FROM asset_supply_daily'))return [{symbol:'BTC',date:day(0),circulating_supply:100},{symbol:'BTC',date:day(1),circulating_supply:110}];
    return [];
  };
  const p=await loadHierarchicalPanel(query,{},day(2),{symbols:['BTC'],log:()=>{}});
  assert.equal(p.supply.BTC[0].max_supply,null);assert.equal(p.supply.BTC[1].max_supply,200);
  assert.ok(!queries.some(q=>/FROM asset_supply_snapshot\s/.test(q)));
});

test('research hash changes when values change at identical row counts',()=>{
  const p={asOf:day(3),assets:[{symbol:'BTC',assetClass:'crypto',bars:bars.slice(0,2)}]};
  const a=buildHierarchicalReport(p,{asOf:day(3),log:()=>{}});
  const b=buildHierarchicalReport({...p,assets:[{...p.assets[0],bars:[bars[0],{...bars[1],volume:42}]}]},{asOf:day(3),log:()=>{}});
  assert.notEqual(a.inputHash,b.inputHash);assert.notEqual(a.runId,b.runId);
});

test('quality audit surfaces mixed funding, stale rates and insufficient history per asset',()=>{
  const q=assessTrackedPanel({asOf:day(200),assets:[{symbol:'BTC',assetClass:'crypto',bars:bars.slice(0,199)}],
    funding:{BTC:[{date:day(190),source:'binance-fapi-direct'},{date:day(199),source:'coingecko'}]}},['BTC']);
  assert.equal(q.needsAttention,1);assert.equal(q.actionable,false);
  assert.ok(q.assets[0].issues.some(x=>x.includes('mixes')));
  assert.ok(q.assets[0].issues.some(x=>x.includes('stale')));
});

test('leader features and optional daily rows are delayed; appending future data changes no earlier features',()=>{
  const p={asOf:day(200),assets:[{symbol:'BTC',assetClass:'crypto',bars:bars.slice(0,200)},
    {symbol:'ETH',assetClass:'crypto',bars:bars.slice(0,200).map(b=>({...b,close:b.close*2}))}]};
  const rows=researchRows(p,{symbols:['BTC','ETH']}).rows;
  const r=rows.find(r=>r.symbol==='BTC'&&r.date===day(120)&&r.horizon===1);
  assert.ok(Math.abs(r.values.leader_ETH_1-Math.log(bars[119].close/bars[118].close))<1e-12);
  const extended=researchRows({...p,asOf:day(280),assets:p.assets.map(a=>({...a,bars:a.symbol==='BTC'?bars:bars.map(b=>({...b,close:b.close*2}))}))},{symbols:['BTC','ETH']}).rows;
  assert.deepEqual(r,extended.find(x=>x.symbol===r.symbol&&x.date===r.date&&x.horizon===r.horizon));
});


test('CoinGecko midnight samples align to the preceding UTC close exactly once',()=>{
  const raw=[{date:'2025-01-03',close:123,source:'coingecko'}];
  const aligned=sanitizeBars(raw);
  assert.equal(aligned[0].date,'2025-01-02');assert.equal(aligned[0].sourceDate,'2025-01-03');
  assert.deepEqual(sanitizeBars(aligned),aligned);
  assert.equal(raw[0].date,'2025-01-03','immutable source date is preserved');
});

test('truncated settlement pagination withholds its last historical day, never a partial daily carry',async()=>{
  const page=Array.from({length:1000},(_,i)=>({symbol:'BTCUSDT',fundingTime:ms(0)+i*3600000,fundingRate:'.0001'}));
  const config={startTime:ms(0),maxPages:1,budgetExpired:()=>false,wait:async()=>{}};
  const partial=await fetchFundingHistory('BTCUSDT',{...config,query:async()=>page});
  assert.equal(partial.length,984);assert.equal(partial.completion.stopReason,'page-cap');
  assert.equal(foldFundingToDaily(partial,{nowMs:ms(100)}).at(-1).settlements,24);
  let calls=0;
  const complete=await fetchFundingHistory('BTCUSDT',{...config,maxPages:2,query:async()=>calls++?[]:page});
  assert.equal(complete.length,1000);assert.equal(complete.completion.reachedEnd,true);
  await assert.rejects(fetchFundingHistory('BTCUSDT',{...config,query:async()=>[{...page[0],fundingRate:''}]}),/Invalid funding/);
});
