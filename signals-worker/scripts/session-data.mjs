// Timestamp-preserving public archive, with bounded concurrency, checksums and
// an explicit instrument/venue contract. No trading API or D1 writes.
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { unzipSingleFile } from './derivatives-archive.mjs';
const HOUR=3600000;
export function validateCutoff(asOf) {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(asOf)||!Number.isFinite(Date.parse(asOf+'T00:00:00Z'))||new Date(asOf+'T00:00:00Z').toISOString().slice(0,10)!==asOf)throw new Error('Invalid session cutoff');
}
export const INSTRUMENTS=[
  ...['BTC','ETH','SOL','XLM','XRP','HBAR'].map(symbol=>({symbol,venueSymbol:symbol+'USDT',market:'spot',start:'2023-01'})),
  {symbol:'HYPE',venueSymbol:'HYPEUSDT',market:'futures/um',start:'2025-05'},
  ...['USDC','TUSD','FDUSD','DAI'].map(symbol=>({symbol,venueSymbol:symbol+'USDT',market:'spot',start:symbol==='FDUSD'?'2023-07':'2023-01'}))
];
export function parseHourlyKlines(csv,{asOf,period}) {
  validateCutoff(asOf);
  const rows=new Map();let rejected=0;
  for(const line of csv.trim().split('\n')){
    const v=line.trim().split(',');if(!/^\d+$/.test(v[0]))continue;
    if([0,1,2,3,4,5,6,7,8,9,10].some(i=>!v[i]?.trim()||!Number.isFinite(Number(v[i])))){rejected++;continue;}
    let t=Number(v[0]),end=Number(v[6]);if(t>1e14){t/=1000;end/=1000;}
    const [open,high,low,close,volume]=v.slice(1,6).map(Number),quoteVolume=Number(v[7]);
    if(![t,end,open,high,low,close,volume,quoteVolume].every(Number.isFinite)
      ||t%HOUR!==0||Math.abs(end-(t+HOUR-1))>1||Math.min(open,high,low,close)<=0
      ||high<Math.max(open,close)||low>Math.min(open,close)||volume<0||quoteVolume<0){rejected++;continue;}
    if(t+HOUR>Date.parse(asOf+'T00:00:00Z'))continue;
    if(!new Date(t).toISOString().startsWith(period)){rejected++;continue;}
    const r={t,open,high,low,close,volume,quoteVolume,trades:Number(v[8]),takerBuyQuote:Number(v[10])};
    if(rows.has(t)&&JSON.stringify(rows.get(t))!==JSON.stringify(r))throw new Error('Conflicting hourly bar');
    rows.set(t,r);
  }
  return {rows:[...rows.values()].sort((a,b)=>a.t-b.t),rejected};
}
export async function collectSessionData({asOf,cache,fetcher=fetch,log=console.log}) {
  validateCutoff(asOf);
  await mkdir(cache,{recursive:true});
  const cutoff=Date.parse(asOf+'T00:00:00Z'),current=asOf.slice(0,7),jobs=[];
  for(const instrument of INSTRUMENTS){
    for(let t=Date.parse(instrument.start+'-01T00:00:00Z');t<cutoff;){
      const d=new Date(t),month=d.toISOString().slice(0,7);
      if(month<current)jobs.push({...instrument,period:month,frequency:'monthly'});
      else for(let k=t;k<cutoff;k+=86400000)jobs.push({...instrument,period:new Date(k).toISOString().slice(0,10),frequency:'daily'});
      d.setUTCMonth(d.getUTCMonth()+1);t=d.getTime();
    }
  }
  const result={asOf,instruments:INSTRUMENTS,assets:{},manifest:[],failures:[]};
  let next=0,done=0;
  async function one(job){
    const filename=`${job.venueSymbol}-1h-${job.period}.zip`;
    const url=`https://data.binance.vision/data/${job.market}/${job.frequency}/klines/${job.venueSymbol}/1h/${filename}`;
    const cacheFile=resolve(cache,job.market.replace('/','-')+'-'+filename+'.json');
    let record;
    try {record=JSON.parse(await readFile(cacheFile,'utf8'));}
    catch {
      const r=await fetcher(url,{signal:AbortSignal.timeout(20000)});
      if(r.status===404)return result.manifest.push({symbol:job.symbol,period:job.period,status:'unavailable',url});
      if(!r.ok)throw new Error(`HTTP ${r.status}`);
      const bytes=Buffer.from(await r.arrayBuffer());const sha256=createHash('sha256').update(bytes).digest('hex');
      const check=await fetcher(url+'.CHECKSUM',{signal:AbortSignal.timeout(15000)});
      if(!check.ok)throw new Error('Missing archive checksum');
      const expected=(await check.text()).trim().split(/\s+/)[0];
      if(expected!==sha256)throw new Error('Archive checksum mismatch');
      record={symbol:job.symbol,market:job.market,venueSymbol:job.venueSymbol,period:job.period,url,sha256,
        ...parseHourlyKlines(unzipSingleFile(bytes),{asOf,period:job.period})};
      await writeFile(cacheFile,JSON.stringify(record));
    }
    (result.assets[job.symbol] ||= []).push(...record.rows.filter(r=>r.t+HOUR<=cutoff));
    result.manifest.push({symbol:job.symbol,period:job.period,market:job.market,url,sha256:record.sha256,rows:record.rows.length,rejected:record.rejected});
  }
  await Promise.all(Array.from({length:4},async()=>{
    while(next<jobs.length){const job=jobs[next++];try{await one(job);}catch(e){result.failures.push({symbol:job.symbol,period:job.period,error:e.message});}
      if(++done%50===0)log(`Session archive ${done}/${jobs.length}; ${result.failures.length} failures`);
    }
  }));
  for(const [s,rows] of Object.entries(result.assets)){
    const unique=new Map();for(const row of rows){if(unique.has(row.t)&&JSON.stringify(unique.get(row.t))!==JSON.stringify(row))throw new Error('Overlapping archive conflict '+s);unique.set(row.t,row);}
    result.assets[s]=[...unique.values()].sort((a,b)=>a.t-b.t);
  }
  result.manifest.sort((a,b)=>a.symbol.localeCompare(b.symbol)||a.period.localeCompare(b.period));
  return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const asOf=process.argv[2]||new Date().toISOString().slice(0,10),output=resolve(process.argv[3]||'reports/sessions');
  await mkdir(output,{recursive:true});
  const result=await collectSessionData({asOf,cache:resolve(output,'cache')});
  await writeFile(resolve(output,'panel.json'),JSON.stringify(result));
  console.log(Object.fromEntries(Object.entries(result.assets).map(([s,rs])=>[s,rs.length])));
  if(result.failures.length)throw new Error(`${result.failures.length} archive fetches failed; retry using saved cache`);
}
