// Global asset-level rolling 24h volume, explicitly distinct from venue pair turnover.
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {validateCutoff} from './session-data.mjs';
export const STABLE_IDS={USDT:'tether',USDC:'usd-coin',USDE:'ethena-usde',DAI:'dai',USD1:'usd1-wlfi',USDG:'global-dollar',PYUSD:'paypal-usd',RLUSD:'ripple-usd'};
export const CRYPTO_IDS={BTC:'bitcoin',ETH:'ethereum',SOL:'solana',XLM:'stellar',XRP:'ripple',HYPE:'hyperliquid',HBAR:'hedera-hashgraph',BNB:'binancecoin',DOGE:'dogecoin',ADA:'cardano',TRX:'tron'};
export function parseGlobalHistory(raw,{asOf}){
 validateCutoff(asOf);const cutoff=Date.parse(asOf+'T00:00:00Z'),fields={};
 for(const name of ['prices','total_volumes','market_caps']){
  if(!Array.isArray(raw[name]))throw Error('Missing history field '+name);
  const map=new Map();for(const [t,v] of raw[name]){
   if(!Number.isFinite(t)||t%86400000!==0||t>=cutoff)continue; // no current/partial daily snapshot
   if(v!==null&&(!Number.isFinite(v)||v<0))throw Error('Invalid '+name);
   if(map.has(t)&&map.get(t)!==v)throw Error('Conflicting '+name+' timestamp');map.set(t,v);
  }fields[name]=map;
 }
 return [...fields.prices].sort((a,b)=>a[0]-b[0]).filter(([,p])=>p>0).map(([t,price])=>({
  t,date:new Date(t).toISOString().slice(0,10),price,
  volume:fields.total_volumes.get(t)??null,mcap:fields.market_caps.get(t)??null,
  // Documented typical publication lag; not an original first-seen vintage.
  assumedAvailableAt:t+600000
 }));
}
export async function collectStableBasket({asOf,output,fetcher=fetch,wait=ms=>new Promise(r=>setTimeout(r,ms)),log=console.log}){
 validateCutoff(asOf);await mkdir(output,{recursive:true});
 const result={version:'stable-basket-input-v1',asOf,provider:'coingecko',volumeUnit:'USD rolling 24h per asset; trade attribution overlaps',
  stableIds:STABLE_IDS,cryptoIds:CRYPTO_IDS,assets:{},manifest:[],failures:[]};
 for(const [symbol,id] of Object.entries({...STABLE_IDS,...CRYPTO_IDS})){
  const url=`https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=365&interval=daily`;
  const cache=resolve(output,id+'.json');let record;
  try{record=JSON.parse(await readFile(cache,'utf8'));}catch{
   for(let n=0;n<3;n++){
    try{
     const r=await fetcher(url,{signal:AbortSignal.timeout(25000)});
     if(r.status===429&&n<2){await wait(30000);continue;}
     if(!r.ok)throw Error('HTTP '+r.status);
     const raw=await r.text();record={url,retrievedAt:new Date().toISOString(),sha256:createHash('sha256').update(raw).digest('hex'),data:JSON.parse(raw)};
     await writeFile(cache,JSON.stringify(record));break;
    }catch(e){if(n===2)result.failures.push({symbol,error:e.message});else await wait(5000);}
   }
   await wait(2300);
  }
  if(!record)continue;
  const rows=parseGlobalHistory(record.data,{asOf});result.assets[symbol]=rows;
  result.manifest.push({symbol,id,url,sha256:record.sha256,retrievedAt:record.retrievedAt,rows:rows.length,first:rows[0]?.date,last:rows.at(-1)?.date});
  log(`${symbol}: ${rows.length} midnight observations, ${rows.filter(r=>r.volume>0).length} positive volumes`);
 }
 await writeFile(resolve(output,'panel.json'),JSON.stringify(result));
 if(result.failures.length)throw Error(`${result.failures.length} history requests failed; partial inputs saved, no full-basket claim`);
 return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const asOf=process.argv[2]||new Date().toISOString().slice(0,10);
 await collectStableBasket({asOf,output:resolve(process.argv[3]||'reports/stable-basket/'+asOf)});
}
