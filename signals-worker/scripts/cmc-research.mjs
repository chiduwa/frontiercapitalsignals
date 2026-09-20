// Official public CMC100 history; optional authenticated liquidation snapshots.
// No account creation, billing, trading, or inferred zero for unreported coins.
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const BASE='https://pro-api.coinmarketcap.com';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export async function cmcRequest(path,params,{key=null,fetcher=fetch,wait=sleep}={}){
 const url=BASE+(key?'':'/public-api')+path+'?'+new URLSearchParams(params);
 for(let attempt=0;attempt<4;attempt++){
  const r=await fetcher(url,{headers:key?{'X-CMC_PRO_API_KEY':key}:{},signal:AbortSignal.timeout(20000)});
  if(r.status===429&&attempt<3){await wait(2000*2**attempt);continue;}
  const raw=await r.text();let j;try{j=JSON.parse(raw);}catch{throw Error('CMC non-JSON response');}
  if(!r.ok||Number(j.status?.error_code||0)!==0)throw Error(`CMC HTTP ${r.status}: ${j.status?.error_message||'API error'}`);
  return {url,retrievedAt:new Date().toISOString(),sha256:createHash('sha256').update(raw).digest('hex'),data:j};
 }
 throw Error('CMC rate limit retries exhausted');
}
export async function collectCmc100({asOf,output,request=cmcRequest,wait=sleep}){
 await mkdir(output,{recursive:true});const end=Date.parse(asOf+'T00:00:00Z'),start=end-366*86400000;
 let cursor=end-86400000;const points=new Map(),manifest=[];
 for(let page=0;page<40&&cursor>=start;page++){
  const timeEnd=new Date(cursor).toISOString(),cache=resolve(output,'cmc100-'+timeEnd.slice(0,10)+'.json');let record;
  try{record=JSON.parse(await readFile(cache,'utf8'));if(!Array.isArray(record.data?.data))throw Error('bad cache');}
  catch{record=await request('/v3/index/cmc100-historical',{time_end:timeEnd,count:'10',interval:'daily'});await writeFile(cache,JSON.stringify(record));await wait(1200);}
  const rows=record.data.data;if(!rows.length)break;
  let earliest=cursor;
  for(const row of rows){
   const t=Date.parse(row.update_time);if(!Number.isFinite(t)||t%86400000||!(row.value>0))throw Error('Invalid CMC daily index observation');
   if(t<start||t>=end)continue;
   if(points.has(t)&&points.get(t).price!==row.value)throw Error('Conflicting CMC index timestamp');
   points.set(t,{t,date:new Date(t).toISOString().slice(0,10),price:row.value});earliest=Math.min(earliest,t);
  }
  manifest.push({url:record.url,sha256:record.sha256,retrievedAt:record.retrievedAt,rows:rows.length});
  cursor=earliest-86400000;
 }
 const result={provider:'coinmarketcap',asOf,series:[...points.values()].sort((a,b)=>a.t-b.t),manifest};
 await writeFile(resolve(output,'cmc100-series.json'),JSON.stringify(result));return result;
}
export function parseLiquidations(j,nowMs=Date.now()){
 if(!Array.isArray(j?.data?.cryptocurrencies))throw Error('Invalid CMC liquidation response');
 const out={};
 for(const c of j.data.cryptocurrencies){
  const q=c.quotes?.find(q=>q.symbol==='USD'&&q.crypto_id===2781);if(!q)continue;
  const at=Date.parse(q.last_updated),age=nowMs-at;
  const values=['long_liquidations_1h','short_liquidations_1h','total_liquidations_1h'];
  if(!values.every(k=>Number.isFinite(q[k])&&q[k]>=0))continue;
  if(Math.abs(q.total_liquidations_1h-q.long_liquidations_1h-q.short_liquidations_1h)>Math.max(1,q.total_liquidations_1h*.001))continue;
  out[String(c.crypto_id)]={id:c.crypto_id,symbol:c.symbol,provider:'coinmarketcap',observedAt:q.last_updated,
   longUsd:q.long_liquidations_1h,shortUsd:q.short_liquidations_1h,totalUsd:q.total_liquidations_1h,windowHours:1,
   quality:Number.isFinite(at)&&age>=-60000&&age<=600000?'ok':'stale',
   source:'https://coinmarketcap.com/charts/liquidations/'};
 }
 return out;
}
export async function loadCmcLiquidations(env,nowMs=Date.now(),request=cmcRequest){
 const key=env.CMC_API_KEY||env.COINMARKETCAP_API_KEY;
 if(!key)return {status:'not-configured',assets:{},note:'OI changes alone do not confirm liquidations.'};
 const ids='1,1027,5426,512,52,32196,4642';
 const r=await request('/v5/derivatives/liquidations/cryptocurrency/list/latest',{crypto_id:ids,convert:'USD',limit:'20'},{key});
 return {status:'available',retrievedAt:r.retrievedAt,assets:parseLiquidations(r.data,nowMs),sourceHash:r.sha256};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const asOf=process.argv[2]||new Date().toISOString().slice(0,10),output=resolve(process.argv[3]||'reports/stable-basket/'+asOf);
 const r=await collectCmc100({asOf,output});console.log(`CMC100: ${r.series.length} daily observations`);
}
