// Independent source spot-check. Venue discrepancies are audit findings, not
// automatic quarantine: Yahoo/CoinGecko aggregates need not equal one venue.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSingleFile } from './derivatives-archive.mjs';
import { ALWAYS_TRACKED } from './tracked-data-quality.mjs';
export async function verifyTrackedPrices(panel, { dates = [18,11,2].map(n=>new Date(Date.parse(panel.asOf)-n*86400000).toISOString().slice(0,10)), fetcher=fetch }={}) {
  const checks=[];
  for (const symbol of ALWAYS_TRACKED) {
    const asset=panel.assets.find(a=>a.symbol===symbol&&a.assetClass==='crypto');
    for (const date of dates) {
      const archived=asset?.bars.find(b=>b.date===date);
      if (!archived) {checks.push({symbol,date,status:'missing-archived-bar'});continue;}
      const venue=symbol+'USDT';
      const url=`https://data.binance.vision/data/spot/daily/klines/${venue}/1d/${venue}-1d-${date}.zip`;
      try {
        const res=await fetcher(url,{signal:AbortSignal.timeout(15000)});
        if (!res.ok) {checks.push({symbol,date,status:'source-unavailable',httpStatus:res.status,url});continue;}
        const csv=unzipSingleFile(Buffer.from(await res.arrayBuffer()));
        const values=csv.trim().split('\n').find(l=>/^\d+,/.test(l))?.split(',');
        const close=Number(values?.[4]);
        if (!(close>0)) throw new Error('No valid source close');
        // Binance spot files changed from milliseconds to microseconds in 2025.
        const rawTime=Number(values[0]);
        const sourceDate=new Date(rawTime>1e14?rawTime/1000:rawTime).toISOString().slice(0,10);
        if (sourceDate!==date) throw new Error('Source bar date mismatch');
        const differencePct=(archived.close/close-1)*100;
        checks.push({symbol,date,archivedClose:archived.close,archiveSource:archived.source,
          venueClose:close,differencePct,status:Math.abs(differencePct)>1?'review-difference':'within-1pct',url});
      } catch(error) {checks.push({symbol,date,status:'fetch-error',error:String(error.message),url});}
    }
  }
  return {asOf:panel.asOf,scope:'spot-close cross-source audit',checks};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const panel=JSON.parse(await readFile(process.argv[2],'utf8'));
  const report=await verifyTrackedPrices(panel);
  await writeFile(process.argv[3],JSON.stringify(report,null,2));
  console.log(JSON.stringify(report.checks.map(({symbol,date,status,differencePct})=>({symbol,date,status,differencePct})),null,2));
}
