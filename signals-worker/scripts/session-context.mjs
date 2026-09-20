import { readFile,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { d1 } from './d1-client.mjs';
import { fetchStablecoinSupply } from './fundamentals-archive.mjs';
import { persistSessionReport,persistResearchSupplement } from './session-health.mjs';
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv[2]==='publish'){
    const report=JSON.parse(await readFile(process.argv[3],'utf8'));await (report.version==='session-flow-v1'?persistSessionReport:persistResearchSupplement)(process.env,report);
    console.log(`Stored research-only session summary ${report.asOf}`);
  }else{
    const asOf=process.argv[2]||new Date().toISOString().slice(0,10);
    const symbols=['USDT','USDC','DAI','FDUSD','TUSD','USDE','PYUSD','USDD','FRAX','LUSD','USDP','GUSD','RLUSD','USD1','USDG'];
    const observations=await d1(process.env,`SELECT * FROM stable_value_observations WHERE symbol IN (${symbols.map(()=>'?').join(',')}) AND obs_date<? ORDER BY obs_date,symbol`,[...symbols,asOf]);
    const supply=(await fetchStablecoinSupply()).filter(r=>r.date<asOf);
    await writeFile(process.argv[3]||'reports/sessions/stable-context.json',JSON.stringify({asOf,observations,supply}));
    console.log({snapshotDays:new Set(observations.map(r=>r.obs_date)).size,supplyDays:supply.length});
  }
}
